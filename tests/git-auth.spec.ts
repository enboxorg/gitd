/**
 * Tests for git push authentication.
 *
 * Tests the DID-signed token creation, encoding/decoding, and the
 * push authenticator callback that integrates with the git HTTP handler.
 */
import { describe, expect, it } from 'bun:test';

import {
  createPushAuthenticator,
  createPushTokenPayload,
  decodePushToken,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
  parseAuthPassword,
} from '../src/git-server/auth.js';

const TEST_DID = 'did:dht:pusher123';
const OWNER_DID = 'did:dht:owner456';
const REPO = 'my-repo';

// ---------------------------------------------------------------------------
// Token payload creation
// ---------------------------------------------------------------------------

describe('createPushTokenPayload', () => {
  it('should create a payload with correct fields', () => {
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    expect(payload.did).toBe(TEST_DID);
    expect(payload.owner).toBe(OWNER_DID);
    expect(payload.repo).toBe(REPO);
    expect(payload.nonce).toBeDefined();
    expect(payload.nonce.length).toBe(32); // 16 bytes as hex
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('should set expiration based on TTL', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO, 60);
    expect(payload.exp).toBeGreaterThan(now + 50);
    expect(payload.exp).toBeLessThanOrEqual(now + 65); // allow 5s clock drift
  });

  it('should generate unique nonces', () => {
    const p1 = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const p2 = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    expect(p1.nonce).not.toBe(p2.nonce);
  });
});

// ---------------------------------------------------------------------------
// Token encoding/decoding
// ---------------------------------------------------------------------------

describe('encodePushToken / decodePushToken', () => {
  it('should round-trip a payload through encode/decode', () => {
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const encoded = encodePushToken(payload);
    const decoded = decodePushToken(encoded);
    expect(decoded).toEqual(payload);
  });

  it('should produce a base64url string (no padding or special chars)', () => {
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const encoded = encodePushToken(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should reject invalid base64url', () => {
    expect(() => decodePushToken('not-valid-json!!!')).toThrow('Invalid push token');
  });

  it('should reject token missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ did: TEST_DID })).toString('base64url');
    expect(() => decodePushToken(partial)).toThrow('Invalid push token');
  });
});

// ---------------------------------------------------------------------------
// Auth password format
// ---------------------------------------------------------------------------

describe('formatAuthPassword / parseAuthPassword', () => {
  it('should round-trip signature and token', () => {
    const signed = { signature: 'abc123', token: 'def456' };
    const password = formatAuthPassword(signed);
    const parsed = parseAuthPassword(password);
    expect(parsed.signature).toBe('abc123');
    expect(parsed.token).toBe('def456');
  });

  it('should format as signature.token', () => {
    const password = formatAuthPassword({ signature: 'sig', token: 'tok' });
    expect(password).toBe('sig.tok');
  });

  it('should reject password without dot separator', () => {
    expect(() => parseAuthPassword('no-separator')).toThrow('Invalid auth password format');
  });

  it('should handle tokens containing dots', () => {
    const signed = { signature: 'sig', token: 'tok.with.dots' };
    const password = formatAuthPassword(signed);
    const parsed = parseAuthPassword(password);
    expect(parsed.signature).toBe('sig');
    expect(parsed.token).toBe('tok.with.dots');
  });
});

// ---------------------------------------------------------------------------
// Push authenticator
// ---------------------------------------------------------------------------

describe('createPushAuthenticator', () => {
  /** Create a valid HTTP Basic auth header using the fixed did-auth username. */
  function makeAuthHeader(password: string): string {
    return `Basic ${Buffer.from(`${DID_AUTH_USERNAME}:${password}`).toString('base64')}`;
  }

  /** Create a valid request with auth credentials. */
  function makeAuthRequest(signed: { signature: string; token: string }): Request {
    const password = formatAuthPassword(signed);
    return new Request('http://localhost/test', {
      method  : 'POST',
      headers : { Authorization: makeAuthHeader(password) },
    });
  }

  /** Always-valid signature verifier for testing. */
  const alwaysValid: (did: string, payload: Uint8Array, sig: Uint8Array) => Promise<boolean> =
    async () => true;

  /** Always-invalid signature verifier for testing. */
  const alwaysInvalid: (did: string, payload: Uint8Array, sig: Uint8Array) => Promise<boolean> =
    async () => false;

  it('should accept a valid signed token', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(true);
  });

  it('should reject when no Authorization header is present', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const request = new Request('http://localhost/test', { method: 'POST' });

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject non-Basic auth schemes', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const request = new Request('http://localhost/test', {
      method  : 'POST',
      headers : { Authorization: 'Bearer some-token' },
    });

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject when username is not the expected fixed value', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const password = formatAuthPassword(signed);
    // Use an incorrect username instead of "did-auth".
    const request = new Request('http://localhost/test', {
      method  : 'POST',
      headers : { Authorization: `Basic ${Buffer.from(`wrong-user:${password}`).toString('base64')}` },
    });

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject when token targets a different owner', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const payload = createPushTokenPayload(TEST_DID, 'did:dht:wrong-owner', REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject when token targets a different repo', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, 'wrong-repo');
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject expired tokens', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO, -10); // expired 10s ago
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject tokens with future expiration beyond max age', async () => {
    const authenticator = createPushAuthenticator({
      verifySignature : alwaysValid,
      maxTokenAge     : 60,
    });
    // Token expires in 1000 seconds, way beyond max age of 60 + 60 clock skew.
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO, 1000);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should reject when signature verification fails', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysInvalid });
    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should call authorizePush when provided and signature is valid', async () => {
    let authorizeCalled = false;
    const authenticator = createPushAuthenticator({
      verifySignature : alwaysValid,
      authorizePush   : async (did, owner, repo) => {
        authorizeCalled = true;
        expect(did).toBe(TEST_DID);
        expect(owner).toBe(OWNER_DID);
        expect(repo).toBe(REPO);
        return true;
      },
    });

    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(true);
    expect(authorizeCalled).toBe(true);
  });

  it('should reject when authorizePush returns false', async () => {
    const authenticator = createPushAuthenticator({
      verifySignature : alwaysValid,
      authorizePush   : async () => false,
    });

    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });

  it('should not call authorizePush when signature is invalid', async () => {
    let authorizeCalled = false;
    const authenticator = createPushAuthenticator({
      verifySignature : alwaysInvalid,
      authorizePush   : async () => {
        authorizeCalled = true;
        return true;
      },
    });

    const payload = createPushTokenPayload(TEST_DID, OWNER_DID, REPO);
    const token = encodePushToken(payload);
    const signed = { signature: 'fake-sig', token };
    const request = makeAuthRequest(signed);

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
    expect(authorizeCalled).toBe(false);
  });

  it('should reject malformed password (no dot separator)', async () => {
    const authenticator = createPushAuthenticator({ verifySignature: alwaysValid });
    const password = 'no-dot-separator';
    const request = new Request('http://localhost/test', {
      method  : 'POST',
      headers : { Authorization: `Basic ${Buffer.from(`${TEST_DID}:${password}`).toString('base64')}` },
    });

    const result = await authenticator(request, OWNER_DID, REPO);
    expect(result).toBe(false);
  });
});
