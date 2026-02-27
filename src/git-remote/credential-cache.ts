/**
 * File-based credential cache for DID push tokens.
 *
 * Stores signed push tokens keyed by `host/path` so that repeated git
 * operations within the token's TTL skip the expensive agent-connect +
 * sign round-trip.
 *
 * Cache location: `~/.enbox/credential-cache.json`
 * (override with `ENBOX_HOME`).
 *
 * Security note: cached tokens are short-lived Ed25519 signatures bound
 * to a specific DID, repo, and 5-minute window. The file is readable
 * only by the current user (mode 0o600).
 *
 * @module
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { enboxHome } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single cached credential entry. */
export type CacheEntry = {
  username: string;
  password: string;
  /** Unix timestamp (seconds) when this entry expires. */
  expiresAt: number;
};

/** The on-disk cache shape: key → entry. */
type CacheFile = Record<string, CacheEntry>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Safety margin (seconds) subtracted from the token's expiration when
 * deciding whether a cached entry is still usable. This avoids serving
 * a token that will expire mid-request.
 */
const EXPIRY_MARGIN_SEC = 30;

/** Cache filename within the enbox home directory. */
const CACHE_FILENAME = 'credential-cache.json';

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Build a cache key from a credential request's host and path.
 *
 * Strips trailing `/info/refs` and query strings from the path to
 * normalise keys across git's discovery and upload-pack requests.
 */
export function cacheKey(host: string | undefined, path: string | undefined): string {
  const h = host ?? '';
  let p = path ?? '';

  // Normalise: strip trailing /info/refs and query strings.
  p = p.replace(/\/info\/refs.*$/, '');
  p = p.replace(/\/git-upload-pack$/, '');
  p = p.replace(/\/git-receive-pack$/, '');
  p = p.replace(/\?.*$/, '');
  p = p.replace(/\/+$/, '');

  return `${h}/${p}`;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function cachePath(): string {
  return join(enboxHome(), CACHE_FILENAME);
}

function readCache(): CacheFile {
  const path = cachePath();
  if (!existsSync(path)) { return {}; }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheFile): void {
  const path = cachePath();
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a cached credential.
 *
 * Returns the entry only if it has not expired (with safety margin).
 * Expired entries are pruned as a side-effect.
 */
export function getCachedCredential(
  host: string | undefined,
  path: string | undefined,
): CacheEntry | undefined {
  const cache = readCache();
  const key = cacheKey(host, path);
  const entry = cache[key];

  if (!entry) { return undefined; }

  const now = Math.floor(Date.now() / 1000);
  if (entry.expiresAt - EXPIRY_MARGIN_SEC <= now) {
    // Expired or about to expire — prune and return nothing.
    delete cache[key];
    writeCache(cache);
    return undefined;
  }

  return entry;
}

/**
 * Store a credential in the cache.
 *
 * @param host - The request host
 * @param path - The request path
 * @param username - The credential username (typically `did-auth`)
 * @param password - The credential password (`<signature>.<token>`)
 * @param expiresAt - Unix timestamp (seconds) when the token expires
 */
export function storeCachedCredential(
  host: string | undefined,
  path: string | undefined,
  username: string,
  password: string,
  expiresAt: number,
): void {
  const cache = pruneExpired(readCache());
  const key = cacheKey(host, path);
  cache[key] = { username, password, expiresAt };
  writeCache(cache);
}

/**
 * Remove a credential from the cache.
 *
 * Called by `erase` when git reports that a credential was rejected.
 */
export function eraseCachedCredential(
  host: string | undefined,
  path: string | undefined,
): void {
  const cache = readCache();
  const key = cacheKey(host, path);
  if (key in cache) {
    delete cache[key];
    writeCache(cache);
  }
}

/**
 * Remove all expired entries from a cache object.
 */
function pruneExpired(cache: CacheFile): CacheFile {
  const now = Math.floor(Date.now() / 1000);
  for (const key of Object.keys(cache)) {
    if (cache[key].expiresAt <= now) {
      delete cache[key];
    }
  }
  return cache;
}
