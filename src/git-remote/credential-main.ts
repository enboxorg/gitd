#!/usr/bin/env bun
/**
 * Git credential helper entry point for DID-based push authentication.
 *
 * Git invokes this binary with a single argument: `get`, `store`, or `erase`.
 *
 * - **get**   — returns cached credentials if still valid, otherwise connects
 *               to the local Web5 agent and generates a fresh DID-signed
 *               push token.
 * - **store** — caches the credential so repeated operations within the
 *               token's TTL skip the expensive agent-connect + sign step.
 * - **erase** — removes the cached credential when git reports it was
 *               rejected (e.g. expired or revoked token).
 *
 * Credentials are cached at `~/.enbox/credential-cache.json` (mode 0o600).
 *
 * This helper creates a DID-signed push token using the local Web5 agent's
 * identity, formatted as HTTP Basic auth credentials:
 *   username: did-auth
 *   password: <base64url-signature>.<base64url-token>
 *
 * Install in .gitconfig:
 *   [credential]
 *     helper = /path/to/git-remote-did-credential
 *
 * Environment:
 *   GITD_PASSWORD    — vault password for the local agent
 *   ENBOX_PROFILE    — (optional) profile name override
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';

import { Web5UserAgent } from '@enbox/agent';

import {
  createPushTokenPayload,
  decodePushToken,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
  parseAuthPassword,
} from '../git-server/auth.js';
import {
  eraseCachedCredential,
  getCachedCredential,
  storeCachedCredential,
} from './credential-cache.js';
import {
  formatCredentialResponse,
  parseCredentialRequest,
} from './credential-helper.js';
import { profileDataPath, resolveProfile } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const action = process.argv[2];

  // Read the credential request from stdin (all actions receive it).
  const input = await readStdin();
  const request = parseCredentialRequest(input);

  // We only handle HTTP/HTTPS requests.
  if (request.protocol && request.protocol !== 'https' && request.protocol !== 'http') {
    return;
  }

  switch (action) {
    case 'get':
      await handleGet(request);
      break;

    case 'store':
      handleStore(request);
      break;

    case 'erase':
      handleErase(request);
      break;

    default:
      // Unknown action — silently ignore.
      break;
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Handle `get` — return cached credentials or generate fresh ones.
 */
async function handleGet(request: { protocol?: string; host?: string; path?: string }): Promise<void> {
  // Check the cache first — avoids expensive agent connection.
  const cached = getCachedCredential(request.host, request.path);
  if (cached) {
    process.stdout.write(formatCredentialResponse({
      username : cached.username,
      password : cached.password,
    }));
    return;
  }

  // Connect to the local agent to get the DID and signing key.
  const password = process.env.GITD_PASSWORD;
  if (!password) {
    // Credential helpers must be non-interactive. If no password is set,
    // silently exit and let git fall back to another credential helper.
    return;
  }

  const { did, bearerDid } = await connectForCredentials(password);

  // Extract the owner DID and repo from the URL path.
  const path = request.path ?? '';
  const segments = path.split('/').filter(Boolean);
  const didIdx = segments.findIndex((s) => s.startsWith('did:'));
  if (didIdx === -1) { return; }

  const ownerDid = segments[didIdx];
  const repo = segments[didIdx + 1];
  if (!repo) { return; }

  // Create the push token.
  const payload = createPushTokenPayload(did, ownerDid, repo);
  const token = encodePushToken(payload);

  // Sign the token using the identity's DID signer (not the agent DID).
  const signer = await bearerDid.getSigner();
  const tokenBytes = new TextEncoder().encode(token);
  const signature = await signer.sign({ data: tokenBytes });
  const signatureBase64url = Buffer.from(signature).toString('base64url');

  const creds = {
    username : DID_AUTH_USERNAME,
    password : formatAuthPassword({ signature: signatureBase64url, token }),
  };

  // Cache for subsequent requests within the TTL.
  storeCachedCredential(
    request.host,
    request.path,
    creds.username,
    creds.password,
    payload.exp,
  );

  process.stdout.write(formatCredentialResponse(creds));
}

/**
 * Handle `store` — cache a credential that git confirmed as valid.
 *
 * Git sends `store` after a successful authentication. The stdin
 * includes `username` and `password` fields alongside the usual
 * `protocol`, `host`, and `path`.
 */
function handleStore(request: { protocol?: string; host?: string; path?: string; username?: string; password?: string }): void {
  const { username, password } = request;
  if (!username || !password) { return; }

  // Only cache our own DID-auth credentials.
  if (username !== DID_AUTH_USERNAME) { return; }

  // Extract the token expiry from the password payload.
  try {
    const signed = parseAuthPassword(password);
    const payload = decodePushToken(signed.token);
    storeCachedCredential(request.host, request.path, username, password, payload.exp);
  } catch {
    // Malformed token — don't cache.
  }
}

/**
 * Handle `erase` — remove a cached credential that was rejected.
 *
 * Git sends `erase` when the server rejected the credential (e.g.
 * HTTP 401). Removing the entry forces a fresh token on next attempt.
 */
function handleErase(request: { protocol?: string; host?: string; path?: string }): void {
  eraseCachedCredential(request.host, request.path);
}

// ---------------------------------------------------------------------------
// Agent connection
// ---------------------------------------------------------------------------

/**
 * Connect to the Web5 agent and return the identity DID and its BearerDid.
 *
 * Resolves the active profile (env, git config, global default, or single
 * fallback) and connects using the profile's agent data path.  Falls back
 * to the legacy CWD-relative `DATA/AGENT` path when no profile exists.
 */
async function connectForCredentials(
  password: string,
): Promise<{ did: string; bearerDid: BearerDid }> {
  // Resolve profile (env, git config, global default, single fallback).
  // When a profile exists, the agent lives at ~/.enbox/profiles/<name>/DATA/AGENT.
  // Otherwise, fall back to the CWD-relative default path (legacy).
  const profileName = resolveProfile();
  const dataPath = profileName ? profileDataPath(profileName) : undefined;

  const agent = await Web5UserAgent.create(dataPath ? { dataPath } : undefined);
  await agent.start({ password });

  const identities = await agent.identity.list();
  const identity = identities[0];
  if (!identity) {
    throw new Error('No identity found in agent');
  }

  return { did: identity.did.uri, bearerDid: identity.did };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all of stdin until EOF. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.resume();
  });
}

main().catch(() => {
  // Credential helpers must never crash loudly — silent exit on error
  // lets git fall back to the next configured credential helper.
  process.exit(0);
});
