#!/usr/bin/env bun
/**
 * Git credential helper entry point for DID-based push authentication.
 *
 * Git invokes this binary with a single argument: `get`, `store`, or `erase`.
 *
 * - **get**   — returns cached credentials if still valid, otherwise asks
 *               the running daemon to generate a fresh DID-signed push token
 *               via its `POST /auth/token` endpoint.  Falls back to direct
 *               agent connection when no daemon is running.
 * - **store** — caches the credential so repeated operations within the
 *               token's TTL skip the token request.
 * - **erase** — removes the cached credential when git reports it was
 *               rejected (e.g. expired or revoked token).
 *
 * Credentials are cached at `~/.enbox/credential-cache.json` (mode 0o600).
 *
 * The preferred path (daemon running) requires NO password — the daemon
 * already holds the agent lock and signs on our behalf.  The fallback path
 * (no daemon) still requires a vault password via `GITD_PASSWORD` or an
 * interactive `/dev/tty` prompt.
 *
 * Install in .gitconfig:
 *   [credential]
 *     helper = /path/to/git-remote-did-credential
 *
 * Environment:
 *   GITD_PASSWORD    — vault password (only needed when no daemon is running)
 *   ENBOX_PROFILE    — (optional) profile name override
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';

import { EnboxUserAgent } from '@enbox/agent';

import { getVaultPassword } from './tty-prompt.js';
import { readLockfile } from '../daemon/lockfile.js';
import {
  decodePushToken,
  DID_AUTH_USERNAME,
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
 * Extract the owner DID and repo name from a credential request path.
 *
 * Expected path format: `/<did>/<repo>` or `/<prefix>/<did>/<repo>`.
 */
function extractOwnerAndRepo(path: string | undefined): { owner: string; repo: string } | null {
  const segments = (path ?? '').split('/').filter(Boolean);
  const didIdx = segments.findIndex((s) => s.startsWith('did:'));
  if (didIdx === -1) { return null; }

  const owner = segments[didIdx];
  const repo = segments[didIdx + 1];
  if (!repo) { return null; }

  return { owner, repo };
}

/**
 * Handle `get` — return cached credentials or generate fresh ones.
 *
 * Strategy:
 *   1. Check the credential cache.
 *   2. If a local daemon is running, call `POST /auth/token` — no password
 *      needed, no LevelDB contention.
 *   3. Fall back to direct agent connection (requires vault password).
 */
async function handleGet(request: { protocol?: string; host?: string; path?: string }): Promise<void> {
  // Check the cache first — avoids any network or agent work.
  const cached = getCachedCredential(request.host, request.path);
  if (cached) {
    process.stdout.write(formatCredentialResponse({
      username : cached.username,
      password : cached.password,
    }));
    return;
  }

  const parsed = extractOwnerAndRepo(request.path);
  if (!parsed) { return; }

  // --- Primary path: ask the running daemon ---
  const creds = await requestTokenFromDaemon(parsed.owner, parsed.repo);
  if (creds) {
    cacheAndRespond(request, creds);
    return;
  }

  // --- Fallback: direct agent connection (no daemon running) ---
  const password = getVaultPassword();
  if (!password) {
    // No password available and no daemon — can't generate credentials.
    return;
  }

  const fallbackCreds = await generateTokenDirectly(password, parsed.owner, parsed.repo);
  if (fallbackCreds) {
    cacheAndRespond(request, fallbackCreds);
  }
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
// Token generation: daemon path (preferred)
// ---------------------------------------------------------------------------

/**
 * Request a push token from the running daemon's `/auth/token` endpoint.
 *
 * This avoids opening the agent's LevelDB stores, which would deadlock
 * because the daemon already holds the exclusive lock.
 *
 * @returns Credentials, or `null` if no daemon is running or the request fails.
 */
async function requestTokenFromDaemon(
  owner: string,
  repo: string,
): Promise<{ username: string; password: string } | null> {
  const lock = readLockfile();
  if (!lock) { return null; }

  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/auth/token`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ owner, repo }),
      signal  : AbortSignal.timeout(5_000),
    });

    if (!res.ok) { return null; }

    const body = await res.json() as { username?: string; password?: string };
    if (!body.username || !body.password) { return null; }

    return { username: body.username, password: body.password };
  } catch {
    // Daemon unreachable or request failed — fall through to direct path.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token generation: direct agent path (fallback)
// ---------------------------------------------------------------------------

/**
 * Generate a push token by connecting directly to the Enbox agent.
 *
 * This is the fallback path for when no daemon is running (e.g. the user
 * is pushing to a remote server directly).  It opens the agent's LevelDB
 * stores, which requires the vault password.
 */
async function generateTokenDirectly(
  password: string,
  owner: string,
  repo: string,
): Promise<{ username: string; password: string } | null> {
  // Import auth functions lazily to keep the daemon-path fast.
  const { createPushTokenPayload, encodePushToken, formatAuthPassword } = await import('../git-server/auth.js');

  const { did, bearerDid } = await connectForCredentials(password);

  const payload = createPushTokenPayload(did, owner, repo);
  const token = encodePushToken(payload);

  const signer = await bearerDid.getSigner();
  const tokenBytes = new TextEncoder().encode(token);
  const signature = await signer.sign({ data: tokenBytes });
  const signatureBase64url = Buffer.from(signature).toString('base64url');

  return {
    username : DID_AUTH_USERNAME,
    password : formatAuthPassword({ signature: signatureBase64url, token }),
  };
}

// ---------------------------------------------------------------------------
// Agent connection (fallback only)
// ---------------------------------------------------------------------------

/**
 * Connect to the Enbox agent and return the identity DID and its BearerDid.
 *
 * Resolves the active profile (env, git config, global default, or single
 * fallback) and connects using the profile's agent data path.  Falls back
 * to `~/.enbox/profiles/default/DATA/AGENT` when no profile exists.
 */
async function connectForCredentials(
  password: string,
): Promise<{ did: string; bearerDid: BearerDid }> {
  const profileName = resolveProfile();
  const dataPath = profileDataPath(profileName ?? 'default');

  const agent = await EnboxUserAgent.create({ dataPath });
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

/**
 * Cache credentials and write the git credential response to stdout.
 */
function cacheAndRespond(
  request: { host?: string; path?: string },
  creds: { username: string; password: string },
): void {
  // Extract expiry from token for cache TTL.
  try {
    const signed = parseAuthPassword(creds.password);
    const payload = decodePushToken(signed.token);
    storeCachedCredential(request.host, request.path, creds.username, creds.password, payload.exp);
  } catch {
    // If we can't parse the token, still respond but don't cache.
  }

  process.stdout.write(formatCredentialResponse(creds));
}

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

main().catch((err: unknown) => {
  // Credential helpers must not crash loudly to stdout — but logging
  // to stderr helps debugging.  Git ignores stderr from credential helpers.
  if (process.env.GITD_DEBUG === '1') {
    console.error(`git-remote-did-credential: ${(err as Error).message ?? err}`);
  }
  process.exit(0);
});
