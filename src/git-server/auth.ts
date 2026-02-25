/**
 * Push authentication for the git transport sidecar.
 *
 * Implements a DID-based authentication scheme for git push operations.
 * The scheme uses signed tokens that prove DID ownership:
 *
 * 1. The client generates a token: `base64url(JSON({ did, repo, exp, nonce }))`
 * 2. The client signs the token with their DID's Ed25519 key
 * 3. The client sends the token + signature as HTTP Basic auth credentials:
 *    - username: `did-auth` (fixed; DIDs contain colons so can't be usernames)
 *    - password: `<base64url-signature>.<base64url-token>`
 * 4. The server verifies the signature using the DID document's
 *    authentication verification method
 *
 * This approach works with git's native credential helper system — no custom
 * transport modifications required.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed username for HTTP Basic auth.
 * DIDs contain colons which conflict with HTTP Basic auth's username:password
 * separator, so we use a fixed username and embed the DID in the token payload.
 */
export const DID_AUTH_USERNAME = 'did-auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The payload inside a signed push token. */
export type PushTokenPayload = {
  /** The DID of the pusher. */
  did: string;

  /** The repository owner's DID. */
  owner: string;

  /** The repository name. */
  repo: string;

  /** Token expiration timestamp (seconds since epoch). */
  exp: number;

  /** Random nonce to prevent replay. */
  nonce: string;
};

/** A signed push token (token + signature). */
export type SignedPushToken = {
  /** The base64url-encoded token payload. */
  token: string;

  /** The base64url-encoded Ed25519 signature over the token. */
  signature: string;
};

/**
 * Verification callback that resolves a DID, extracts the Ed25519 public key,
 * and verifies the signature.
 *
 * @param did - The DID that claims to have signed the token
 * @param payload - The raw token bytes that were signed
 * @param signature - The signature bytes to verify
 * @returns `true` if the signature is valid for the DID's authentication key
 */
export type SignatureVerifier = (
  did: string,
  payload: Uint8Array,
  signature: Uint8Array,
) => Promise<boolean>;

/**
 * Authorization callback that checks whether a DID has push access to a repo.
 * This typically queries the DWN for a `repo/maintainer` role record.
 *
 * @param did - The authenticated pusher's DID
 * @param owner - The repository owner's DID
 * @param repo - The repository name
 * @returns `true` if the DID is authorized to push
 */
export type PushAuthorizer = (
  did: string,
  owner: string,
  repo: string,
) => Promise<boolean>;

/** Options for creating a push authenticator. */
export type PushAuthenticatorOptions = {
  /** Callback to verify Ed25519 signatures against a DID document. */
  verifySignature: SignatureVerifier;

  /**
   * Optional callback to check push authorization (role-based access).
   * If not provided, any authenticated DID is allowed to push.
   */
  authorizePush?: PushAuthorizer;

  /** Maximum token age in seconds. @default 300 (5 minutes) */
  maxTokenAge?: number;
};

// ---------------------------------------------------------------------------
// Token creation (client-side)
// ---------------------------------------------------------------------------

/**
 * Create a push token payload.
 *
 * @param did - The pusher's DID
 * @param owner - The repository owner's DID
 * @param repo - The repository name
 * @param ttlSeconds - Token lifetime in seconds (default: 300)
 * @returns The token payload
 */
export function createPushTokenPayload(
  did: string,
  owner: string,
  repo: string,
  ttlSeconds: number = 300,
): PushTokenPayload {
  return {
    did,
    owner,
    repo,
    exp   : Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce : randomBytes(16).toString('hex'),
  };
}

/**
 * Encode a push token payload as a base64url string.
 *
 * @param payload - The token payload
 * @returns base64url-encoded JSON
 */
export function encodePushToken(payload: PushTokenPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64url');
}

/**
 * Decode a base64url push token string back to a payload.
 *
 * @param token - The base64url-encoded token
 * @returns The decoded payload
 * @throws If the token is malformed
 */
export function decodePushToken(token: string): PushTokenPayload {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf-8');
    const payload = JSON.parse(json) as PushTokenPayload;

    if (!payload.did || !payload.owner || !payload.repo || !payload.exp || !payload.nonce) {
      throw new Error('missing required fields');
    }

    return payload;
  } catch (err) {
    throw new Error(`Invalid push token: ${(err as Error).message}`);
  }
}

/**
 * Format a signed push token for use as an HTTP Basic auth password.
 * The format is `<base64url-signature>.<base64url-token>`.
 *
 * @param signed - The signed token
 * @returns The formatted password string
 */
export function formatAuthPassword(signed: SignedPushToken): string {
  return `${signed.signature}.${signed.token}`;
}

/**
 * Parse an HTTP Basic auth password back into a signed push token.
 *
 * @param password - The password from HTTP Basic auth
 * @returns The parsed signed token
 * @throws If the format is invalid
 */
export function parseAuthPassword(password: string): SignedPushToken {
  const dotIndex = password.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid auth password format: expected <signature>.<token>');
  }
  return {
    signature : password.slice(0, dotIndex),
    token     : password.slice(dotIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Push authenticator factory (server-side)
// ---------------------------------------------------------------------------

/**
 * Create an `authenticatePush` callback for use with `createGitHttpHandler`.
 *
 * Extracts HTTP Basic credentials from the request, verifies the signed token,
 * and optionally checks role-based authorization.
 *
 * @param options - Authenticator configuration
 * @returns An authenticatePush callback
 */
export function createPushAuthenticator(
  options: PushAuthenticatorOptions,
): (request: Request, did: string, repo: string) => Promise<boolean> {
  const { verifySignature, authorizePush, maxTokenAge = 300 } = options;

  // Nonce replay protection: track used nonces with timestamps for TTL eviction.
  const usedNonces = new Map<string, number>();
  const nonceMaxAge = (maxTokenAge + 60) * 1000; // ms — token TTL + clock skew

  /** Evict expired nonces to prevent unbounded growth. */
  function evictExpiredNonces(): void {
    const cutoff = Date.now() - nonceMaxAge;
    for (const [nonce, ts] of usedNonces) {
      if (ts < cutoff) { usedNonces.delete(nonce); }
    }
  }

  return async (request: Request, ownerDid: string, repo: string): Promise<boolean> => {
    // Extract HTTP Basic auth credentials.
    // Username is fixed to "did-auth" (DIDs contain colons, which conflict
    // with HTTP Basic auth's colon separator). The DID is inside the token.
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
      return false;
    }

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      return false;
    }

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);

    // Verify the username is the expected fixed value.
    if (username !== DID_AUTH_USERNAME) {
      return false;
    }

    // Parse the signed token from the password field.
    let signed: SignedPushToken;
    try {
      signed = parseAuthPassword(password);
    } catch {
      return false;
    }

    // Decode and validate the token payload.
    let payload: PushTokenPayload;
    try {
      payload = decodePushToken(signed.token);
    } catch {
      return false;
    }

    // Verify the token targets the correct owner and repo.
    if (payload.owner !== ownerDid || payload.repo !== repo) {
      return false;
    }

    // Verify the token hasn't expired.
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return false;
    }

    // Verify the token isn't too far in the future (clock skew protection).
    if (payload.exp > now + maxTokenAge + 60) {
      return false;
    }

    // Verify the Ed25519 signature.
    const tokenBytes = new TextEncoder().encode(signed.token);
    const signatureBytes = new Uint8Array(Buffer.from(signed.signature, 'base64url'));

    const signatureValid = await verifySignature(payload.did, tokenBytes, signatureBytes);
    if (!signatureValid) {
      return false;
    }

    // Nonce replay protection — reject already-used nonces.
    evictExpiredNonces();
    if (usedNonces.has(payload.nonce)) {
      return false;
    }
    usedNonces.set(payload.nonce, Date.now());

    // Optional: Check role-based push authorization.
    if (authorizePush) {
      return authorizePush(payload.did, ownerDid, repo);
    }

    return true;
  };
}
