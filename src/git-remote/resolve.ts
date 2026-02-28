/**
 * DID resolution and git transport endpoint discovery.
 *
 * Resolves a DID document and extracts the git transport endpoint URL.
 * The resolution order is:
 *   1. Service of type `GitTransport` (preferred)
 *   2. Service of type `DecentralizedWebNode` with `/git` suffix appended
 *   3. Failure — no git endpoint found
 *
 * @module
 */

import type { DidService } from '@enbox/dids';

import { DidDht, DidJwk, DidKey, DidWeb, UniversalResolver } from '@enbox/dids';

import { readLockfile } from '../daemon/lockfile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of resolving a DID to a git transport endpoint. */
export type GitEndpoint = {
  /** The resolved HTTP(S) URL for git smart HTTP transport. */
  url: string;

  /** The DID that was resolved. */
  did: string;

  /** How the endpoint was discovered. */
  source: 'LocalDaemon' | 'GitTransport' | 'DecentralizedWebNode';
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Shared resolver instance (lazy-initialized). */
let resolver: UniversalResolver | undefined;

/** Get or create the DID resolver. */
function getResolver(): UniversalResolver {
  if (!resolver) {
    resolver = new UniversalResolver({
      didResolvers: [DidDht, DidJwk, DidWeb, DidKey],
    });
  }
  return resolver;
}

/** DID resolution timeout in milliseconds. */
const DID_RESOLUTION_TIMEOUT_MS = 30_000;

/**
 * Resolve a DID to a git transport HTTPS endpoint.
 *
 * @param did - Full DID URI (e.g. `did:dht:abc123xyz`)
 * @param repo - Optional repo name to append to the endpoint path
 * @returns The resolved git transport endpoint
 * @throws If resolution fails, times out, or no git-compatible service is found
 */
export async function resolveGitEndpoint(did: string, repo?: string): Promise<GitEndpoint> {
  // Priority 0: Check for a running local daemon.
  const local = await resolveLocalDaemon(did, repo);
  if (local) { return local; }

  const { didDocument, didResolutionMetadata } = await Promise.race([
    getResolver().resolve(did),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DID resolution timed out after ${DID_RESOLUTION_TIMEOUT_MS}ms for ${did}`)), DID_RESOLUTION_TIMEOUT_MS),
    ),
  ]);

  if (didResolutionMetadata.error) {
    throw new Error(`DID resolution failed for ${did}: ${didResolutionMetadata.error}`);
  }

  if (!didDocument) {
    throw new Error(`DID resolution returned no document for ${did}`);
  }

  const services: DidService[] = didDocument.service ?? [];

  // Priority 1: Look for a GitTransport service.
  const gitService = services.find((s) => s.type === 'GitTransport');
  if (gitService) {
    const baseUrl = extractEndpointUrl(gitService);
    return {
      url    : buildUrl(baseUrl, did, repo),
      did,
      source : 'GitTransport',
    };
  }

  // Priority 2: Fall back to DWN endpoint + /git suffix.
  const dwnService = services.find((s) => s.type === 'DecentralizedWebNode');
  if (dwnService) {
    const baseUrl = extractEndpointUrl(dwnService);
    const gitUrl = baseUrl.replace(/\/$/, '') + '/git';
    return {
      url    : buildUrl(gitUrl, did, repo),
      did,
      source : 'DecentralizedWebNode',
    };
  }

  throw new Error(
    `No GitTransport or DecentralizedWebNode service found in DID document for ${did}. ` +
    `Services: ${services.map((s) => s.type).join(', ') || '(none)'}`,
  );
}

// ---------------------------------------------------------------------------
// Local daemon discovery
// ---------------------------------------------------------------------------

/** Timeout for the local daemon health probe (ms). */
const LOCAL_PROBE_TIMEOUT_MS = 2_000;

/**
 * Check whether a local gitd daemon is running and reachable.
 *
 * Reads `~/.enbox/daemon.lock`, verifies the PID is alive, and probes
 * the health endpoint to confirm the server is responsive.
 *
 * @returns A `GitEndpoint` pointing to `http://localhost:<port>/...`, or `null`.
 */
async function resolveLocalDaemon(did: string, repo?: string): Promise<GitEndpoint | null> {
  const lock = readLockfile();
  if (!lock) { return null; }

  // Probe the health endpoint to confirm the server is actually responding.
  const healthUrl = `http://localhost:${lock.port}/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { return null; }
  } catch {
    return null;
  }

  const baseUrl = `http://localhost:${lock.port}`;
  return {
    url    : buildUrl(baseUrl, did, repo),
    did,
    source : 'LocalDaemon',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a URL string from a service endpoint (handles string and array forms). */
function extractEndpointUrl(service: DidService): string {
  const ep = service.serviceEndpoint;

  let url: string | undefined;
  if (typeof ep === 'string') {
    url = ep;
  } else if (Array.isArray(ep) && ep.length > 0) {
    const first = ep[0];
    if (typeof first === 'string') {
      url = first;
    }
  }

  if (!url) {
    throw new Error(`Cannot extract URL from service endpoint: ${JSON.stringify(ep)}`);
  }

  assertNotPrivateUrl(url);
  return url;
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * Private / loopback IP ranges that must never be contacted via
 * DID-resolved URLs (prevents SSRF attacks).
 */
const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./, // 127.0.0.0/8 loopback
  /^10\./, // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./, // 192.168.0.0/16 private
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^0\./, // 0.0.0.0/8
];

const PRIVATE_IPV6_PATTERNS: RegExp[] = [
  /^::1$/, // IPv6 loopback
  /^fc/i, // fc00::/7 unique local
  /^fd/i, // fc00::/7 unique local
  /^fe80:/i, // fe80::/10 link-local
];

/** Track whether the dev-mode warning has been emitted. */
let allowPrivateWarned = false;

/**
 * Assert that a URL does not resolve to a private/loopback address.
 *
 * When `GITD_ALLOW_PRIVATE=1` is set, the check is skipped and a
 * warning is printed to stderr on first use.  This is intended solely
 * for local development and testing with `did:web:localhost` or other
 * local DID methods.
 *
 * @throws If the URL hostname is a private or loopback IP (unless bypassed)
 */
export function assertNotPrivateUrl(urlString: string): void {
  if (process.env.GITD_ALLOW_PRIVATE === '1') {
    if (!allowPrivateWarned) {
      console.error(
        '[git-remote-did] WARNING: SSRF protection disabled '
        + '(GITD_ALLOW_PRIVATE=1) — do not use in production',
      );
      allowPrivateWarned = true;
    }
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL from DID service endpoint: ${urlString}`);
  }

  const hostname = parsed.hostname;

  // Strip IPv6 brackets if present.
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Reject localhost by name.
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    throw new Error(`SSRF blocked: resolved endpoint points to localhost: ${urlString}`);
  }

  // Check IPv4 private ranges.
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(bare)) {
      throw new Error(`SSRF blocked: resolved endpoint points to private IP: ${urlString}`);
    }
  }

  // Check IPv6 private ranges.
  for (const pattern of PRIVATE_IPV6_PATTERNS) {
    if (pattern.test(bare)) {
      throw new Error(`SSRF blocked: resolved endpoint points to private IPv6: ${urlString}`);
    }
  }
}

/**
 * Build the full git transport URL: `<base>/<did>[/<repo>]`.
 *
 * The DID is always included in the path since the git HTTP handler uses
 * it for routing and authorization.
 */
function buildUrl(base: string, did: string, repo?: string): string {
  const normalized = base.replace(/\/$/, '');
  if (!repo) { return `${normalized}/${did}`; }
  return `${normalized}/${did}/${repo}`;
}
