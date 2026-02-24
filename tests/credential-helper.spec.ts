/**
 * Tests for the git credential helper.
 *
 * Tests the credential request parsing, response formatting, and push
 * credential generation logic.
 */
import { describe, expect, it } from 'bun:test';

import { Ed25519 } from '@enbox/crypto';

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
