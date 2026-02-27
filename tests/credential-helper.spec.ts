/**
 * Tests for the git credential helper.
 *
 * Tests the credential request parsing, response formatting, push
 * credential generation logic, and the file-based credential cache.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { Ed25519 } from '@enbox/crypto';

import {
  cacheKey,
  eraseCachedCredential,
  getCachedCredential,
  storeCachedCredential,
} from '../src/git-remote/credential-cache.js';
import {
  decodePushToken,
  DID_AUTH_USERNAME,
  parseAuthPassword,
} from '../src/git-server/auth.js';
import {
  formatCredentialResponse,
  generatePushCredentials,
  parseCredentialRequest,
} from '../src/git-remote/credential-helper.js';

// ---------------------------------------------------------------------------
// parseCredentialRequest
// ---------------------------------------------------------------------------

describe('parseCredentialRequest', () => {
  it('should parse protocol, host, and path', () => {
    const input = 'protocol=https\nhost=git.example.com\npath=did:dht:abc123/my-repo\n';
    const result = parseCredentialRequest(input);
    expect(result.protocol).toBe('https');
    expect(result.host).toBe('git.example.com');
    expect(result.path).toBe('did:dht:abc123/my-repo');
  });

  it('should handle missing fields gracefully', () => {
    const input = 'protocol=https\n';
    const result = parseCredentialRequest(input);
    expect(result.protocol).toBe('https');
    expect(result.host).toBeUndefined();
    expect(result.path).toBeUndefined();
  });

  it('should handle empty input', () => {
    const result = parseCredentialRequest('');
    expect(result.protocol).toBeUndefined();
    expect(result.host).toBeUndefined();
    expect(result.path).toBeUndefined();
  });

  it('should handle lines without equals sign', () => {
    const input = 'protocol=https\nbadline\nhost=example.com\n';
    const result = parseCredentialRequest(input);
    expect(result.protocol).toBe('https');
    expect(result.host).toBe('example.com');
  });

  it('should handle values with equals signs', () => {
    const input = 'path=did:dht:abc123/my-repo?q=1\n';
    const result = parseCredentialRequest(input);
    expect(result.path).toBe('did:dht:abc123/my-repo?q=1');
  });

  it('should parse username and password fields (for store/erase)', () => {
    const input = 'protocol=https\nhost=git.example.com\npath=did:dht:abc/repo\nusername=did-auth\npassword=sig.token\n';
    const result = parseCredentialRequest(input);
    expect(result.username).toBe('did-auth');
    expect(result.password).toBe('sig.token');
  });
});

// ---------------------------------------------------------------------------
// formatCredentialResponse
// ---------------------------------------------------------------------------

describe('formatCredentialResponse', () => {
  it('should format username and password as key=value lines', () => {
    const result = formatCredentialResponse({ username: 'did-auth', password: 'sig.token' });
    expect(result).toBe('username=did-auth\npassword=sig.token\n');
  });
});

// ---------------------------------------------------------------------------
// generatePushCredentials
// ---------------------------------------------------------------------------

describe('generatePushCredentials', () => {
  it('should return undefined when path has no DID segment', async () => {
    const privateKey = await Ed25519.generateKey();
    const result = await generatePushCredentials(
      { protocol: 'https', host: 'git.example.com', path: 'some/repo' },
      'did:jwk:pusher1',
      privateKey as any,
    );
    expect(result).toBeUndefined();
  });

  it('should return undefined when DID segment has no repo after it', async () => {
    const privateKey = await Ed25519.generateKey();
    const result = await generatePushCredentials(
      { protocol: 'https', host: 'git.example.com', path: 'did:dht:abc123' },
      'did:jwk:pusher1',
      privateKey as any,
    );
    expect(result).toBeUndefined();
  });

  it('should generate valid credentials for a valid request', async () => {
    const privateKey = await Ed25519.generateKey();
    const publicKey = await Ed25519.getPublicKey({ key: privateKey });
    const pusherDid = 'did:jwk:pusher1';
    const ownerDid = 'did:dht:owner456';
    const repo = 'my-repo';

    const result = await generatePushCredentials(
      { protocol: 'https', host: 'git.example.com', path: `${ownerDid}/${repo}` },
      pusherDid,
      privateKey as any,
    );

    expect(result).toBeDefined();
    expect(result!.username).toBe(DID_AUTH_USERNAME);

    // Verify the password contains a valid signed token.
    const signed = parseAuthPassword(result!.password);
    expect(signed.signature).toBeTruthy();
    expect(signed.token).toBeTruthy();

    // Decode the token and verify its contents.
    const payload = decodePushToken(signed.token);
    expect(payload.did).toBe(pusherDid);
    expect(payload.owner).toBe(ownerDid);
    expect(payload.repo).toBe(repo);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Verify the Ed25519 signature.
    const tokenBytes = new TextEncoder().encode(signed.token);
    const signatureBytes = new Uint8Array(Buffer.from(signed.signature, 'base64url'));
    const valid = await Ed25519.verify({
      key       : publicKey,
      data      : tokenBytes,
      signature : signatureBytes,
    });
    expect(valid).toBe(true);
  });

  it('should extract DID and repo from a prefixed path', async () => {
    const privateKey = await Ed25519.generateKey();
    const result = await generatePushCredentials(
      { protocol: 'https', host: 'git.example.com', path: '/git/did:dht:owner789/project' },
      'did:jwk:pusher2',
      privateKey as any,
    );

    expect(result).toBeDefined();
    const payload = decodePushToken(parseAuthPassword(result!.password).token);
    expect(payload.owner).toBe('did:dht:owner789');
    expect(payload.repo).toBe('project');
  });

  it('should handle path with info/refs after repo name', async () => {
    const privateKey = await Ed25519.generateKey();
    const result = await generatePushCredentials(
      { protocol: 'https', host: 'example.com', path: 'did:dht:owner/my-repo/info/refs' },
      'did:jwk:pusher3',
      privateKey as any,
    );

    expect(result).toBeDefined();
    const payload = decodePushToken(parseAuthPassword(result!.password).token);
    // The repo should be the segment right after the DID, not "info".
    expect(payload.owner).toBe('did:dht:owner');
    expect(payload.repo).toBe('my-repo');
  });
});

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------

describe('cacheKey', () => {
  it('should combine host and path', () => {
    expect(cacheKey('git.example.com', 'did:dht:abc/repo')).toBe('git.example.com/did:dht:abc/repo');
  });

  it('should strip trailing /info/refs', () => {
    expect(cacheKey('h', 'did:dht:abc/repo/info/refs')).toBe('h/did:dht:abc/repo');
  });

  it('should strip trailing /git-upload-pack', () => {
    expect(cacheKey('h', 'did:dht:abc/repo/git-upload-pack')).toBe('h/did:dht:abc/repo');
  });

  it('should strip trailing /git-receive-pack', () => {
    expect(cacheKey('h', 'did:dht:abc/repo/git-receive-pack')).toBe('h/did:dht:abc/repo');
  });

  it('should strip query strings', () => {
    expect(cacheKey('h', 'did:dht:abc/repo/info/refs?service=git-upload-pack')).toBe('h/did:dht:abc/repo');
  });

  it('should handle undefined host and path', () => {
    expect(cacheKey(undefined, undefined)).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// Credential cache (file-based)
// ---------------------------------------------------------------------------

describe('credential cache', () => {
  const testHome = join('__TESTDATA__', 'cred-cache-test');

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    delete process.env.ENBOX_HOME;
  });

  function setupCacheDir(): void {
    process.env.ENBOX_HOME = testHome;
    mkdirSync(testHome, { recursive: true });
  }

  it('should return undefined for empty cache', () => {
    setupCacheDir();
    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo');
    expect(result).toBeUndefined();
  });

  it('should store and retrieve a credential', () => {
    setupCacheDir();
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('git.example.com', 'did:dht:abc/repo', 'did-auth', 'sig.token', futureExp);

    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo');
    expect(result).toBeDefined();
    expect(result!.username).toBe('did-auth');
    expect(result!.password).toBe('sig.token');
    expect(result!.expiresAt).toBe(futureExp);
  });

  it('should return undefined for expired entries', () => {
    setupCacheDir();
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    storeCachedCredential('git.example.com', 'did:dht:abc/repo', 'did-auth', 'sig.token', pastExp);

    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo');
    expect(result).toBeUndefined();
  });

  it('should return undefined for entries about to expire (within safety margin)', () => {
    setupCacheDir();
    // Set expiry 20s in the future — within the 30s safety margin.
    const nearExp = Math.floor(Date.now() / 1000) + 20;
    storeCachedCredential('git.example.com', 'did:dht:abc/repo', 'did-auth', 'sig.token', nearExp);

    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo');
    expect(result).toBeUndefined();
  });

  it('should erase a cached credential', () => {
    setupCacheDir();
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('git.example.com', 'did:dht:abc/repo', 'did-auth', 'sig.token', futureExp);

    eraseCachedCredential('git.example.com', 'did:dht:abc/repo');

    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo');
    expect(result).toBeUndefined();
  });

  it('should not error when erasing a non-existent entry', () => {
    setupCacheDir();
    // Should not throw.
    eraseCachedCredential('git.example.com', 'did:dht:abc/nope');
  });

  it('should normalise keys so /info/refs matches the base path', () => {
    setupCacheDir();
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('git.example.com', 'did:dht:abc/repo', 'did-auth', 'sig.token', futureExp);

    // Retrieve with /info/refs suffix — should still match.
    const result = getCachedCredential('git.example.com', 'did:dht:abc/repo/info/refs');
    expect(result).toBeDefined();
    expect(result!.username).toBe('did-auth');
  });

  it('should store multiple entries independently', () => {
    setupCacheDir();
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('h', 'did:dht:abc/repo-a', 'did-auth', 'pw-a', futureExp);
    storeCachedCredential('h', 'did:dht:abc/repo-b', 'did-auth', 'pw-b', futureExp);

    const a = getCachedCredential('h', 'did:dht:abc/repo-a');
    const b = getCachedCredential('h', 'did:dht:abc/repo-b');
    expect(a!.password).toBe('pw-a');
    expect(b!.password).toBe('pw-b');
  });

  it('should prune expired entries when storing new ones', () => {
    setupCacheDir();
    const pastExp = Math.floor(Date.now() / 1000) - 100;
    const futureExp = Math.floor(Date.now() / 1000) + 300;

    // Store an already-expired entry.
    storeCachedCredential('h', 'did:dht:old/stale', 'did-auth', 'old-pw', pastExp);
    // Store a fresh entry — should prune the expired one.
    storeCachedCredential('h', 'did:dht:new/fresh', 'did-auth', 'new-pw', futureExp);

    // The stale entry should be gone.
    const stale = getCachedCredential('h', 'did:dht:old/stale');
    expect(stale).toBeUndefined();

    // The fresh entry should remain.
    const fresh = getCachedCredential('h', 'did:dht:new/fresh');
    expect(fresh).toBeDefined();
  });

  it('should set cache file permissions to 0o600', () => {
    setupCacheDir();
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('h', 'did:dht:abc/repo', 'did-auth', 'pw', futureExp);

    const { statSync } = require('node:fs');
    const stat = statSync(join(testHome, 'credential-cache.json'));
    // Check owner-only read/write (0o600). On some systems the mode
    // includes the file type bits, so mask with 0o777.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('should handle corrupted cache file gracefully', () => {
    setupCacheDir();
    writeFileSync(join(testHome, 'credential-cache.json'), 'not json!!!', 'utf-8');

    // Should not throw, just return undefined.
    const result = getCachedCredential('h', 'did:dht:abc/repo');
    expect(result).toBeUndefined();

    // Storing should overwrite the corrupted file.
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    storeCachedCredential('h', 'did:dht:abc/repo', 'did-auth', 'pw', futureExp);
    const fresh = getCachedCredential('h', 'did:dht:abc/repo');
    expect(fresh).toBeDefined();
  });
});
