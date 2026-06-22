/**
 * DID resolution and git transport endpoint discovery.
 *
 * Resolves a DID document and extracts the git transport endpoint URL.
 * The resolution order is:
 *   0. Local daemon (auto-started if needed)
 *   1. Service of type `GitTransport` in the DID document
 *   2. Failure — no git endpoint found
 *
 * @module
 */

import type { DidService } from '@enbox/dids';

import { promises as dns } from 'node:dns';

import { DidDht, DidJwk, DidKey, DidWeb, UniversalResolver } from '@enbox/dids';

import { ensureDaemon } from '../daemon/lifecycle.js';
import { getVaultPassword } from './tty-prompt.js';
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
  source: 'LocalDaemon' | 'GitTransport';
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
    const baseUrl = await extractEndpointUrl(gitService);
    return {
      url    : buildUrl(baseUrl, did, repo),
      did,
      source : 'GitTransport',
    };
  }

  // No git-capable endpoint found.  Build a helpful error message.
  const dwnService = services.find((s) => s.type === 'DecentralizedWebNode');
  if (dwnService) {
    throw new Error(
      `No GitTransport service found for ${did}. `
      + 'The DID has a DecentralizedWebNode service but no git server is registered.\n'
      + 'Hint: start a local server with `gitd serve`, or register a public '
      + 'GitTransport endpoint with `gitd serve --public-url <url>`.',
    );
  }

  throw new Error(
    `No GitTransport service found in DID document for ${did}. `
    + `Services: ${services.map((s) => s.type).join(', ') || '(none)'}`,
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
 * the health endpoint to confirm the server is responsive.  If no daemon
 * is running, attempts to auto-start one via `ensureDaemon()`.
 *
 * @returns A `GitEndpoint` pointing to `http://localhost:<port>/...`, or `null`.
 */
async function resolveLocalDaemon(did: string, repo?: string): Promise<GitEndpoint | null> {
  // Fast path: check for an already-running daemon.
  const lock = readLockfile();
  if (lock) {
    // Only use the local daemon when the requested DID matches the
    // daemon's owner.  Cloning someone else's repo must fall through
    // to DID document resolution so the request reaches the correct
    // remote server.  Lockfiles without `ownerDid` (written by older
    // versions) are treated as matching for backwards compatibility.
    if (lock.ownerDid && lock.ownerDid !== did) {
      return null;
    }

    const healthUrl = `http://localhost:${lock.port}/health`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return {
          url    : buildUrl(`http://localhost:${lock.port}`, did, repo),
          did,
          source : 'LocalDaemon',
        };
      }
    } catch {
      // Not responding — fall through to auto-start.
    }
  }

  // Slow path: try to auto-start a daemon.  Prompt for the vault
  // password lazily — only when we actually need to spawn.  This avoids
  // prompting when the daemon is already running (the common case).
  // Skip auto-start entirely when no password is available — spawning
  // a daemon without a password will always fail (vault can't unlock).
  const password = getVaultPassword() ?? undefined;
  if (!password) { return null; }

  try {
    const result = await ensureDaemon(password);
    return {
      url    : buildUrl(`http://localhost:${result.port}`, did, repo),
      did,
      source : 'LocalDaemon',
    };
  } catch (err) {
    // Could not start daemon — warn clearly so the user knows why
    // push/clone will fail if no remote GitTransport service exists.
    console.error(
      `git-remote-did: could not start local daemon: ${(err as Error).message}\n`
      + 'Hint: ensure gitd is installed and on your PATH, or run from the project directory.\n'
      + 'Hint: run `gitd serve` in another terminal, or set GITD_PASSWORD and retry.',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a URL string from a service endpoint (handles string and array forms). */
async function extractEndpointUrl(service: DidService): Promise<string> {
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

  await assertNotPrivateUrl(url);
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
  /^::$/, // Unspecified address
  /^::ffff:/i, // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1)
  /^fc/i, // fc00::/7 unique local
  /^fd/i, // fc00::/7 unique local
  /^fe80:/i, // fe80::/10 link-local
];

/** Track whether the dev-mode warning has been emitted. */
let allowPrivateWarned = false;

/**
 * Assert that a URL does not resolve to a private/loopback address.
 *
 * Checks both the hostname string and (for non-IP hostnames) the
 * resolved IP addresses via DNS lookup. This prevents DNS rebinding
 * attacks where `evil.example.com` resolves to `127.0.0.1`.
 *
 * Also rejects IPv6-mapped IPv4 addresses (`::ffff:127.0.0.1`) and
 * the unspecified address (`::`).
 *
 * When `GITD_ALLOW_PRIVATE=1` is set, the check is skipped and a
 * warning is printed to stderr on first use.  This is intended solely
 * for local development and testing with `did:web:localhost` or other
 * local DID methods.
 *
 * @throws If the URL hostname resolves to a private/loopback address (unless bypassed)
 */
export async function assertNotPrivateUrl(urlString: string): Promise<void> {
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

  // Check the hostname itself against IP patterns.
  assertNotPrivateIp(bare, urlString);

  // If hostname is not an IP literal, resolve via DNS and check the results.
  const isIpLiteral = PRIVATE_IP_PATTERNS.some((p) => p.test(bare))
    || PRIVATE_IPV6_PATTERNS.some((p) => p.test(bare))
    || /^\d+\.\d+\.\d+\.\d+$/.test(bare)
    || bare.includes(':');

  if (!isIpLiteral) {
    // Resolve A and AAAA records concurrently.
    const [ipv4Addrs, ipv6Addrs] = await Promise.all([
      dns.resolve4(bare).catch(() => [] as string[]),
      dns.resolve6(bare).catch(() => [] as string[]),
    ]);

    for (const ip of [...ipv4Addrs, ...ipv6Addrs]) {
      assertNotPrivateIp(ip, urlString);
    }
  }
}

/**
 * Throw if an IP address falls within private, loopback, or link-local ranges.
 *
 * Handles IPv4, IPv6, IPv6-mapped IPv4, and the unspecified address.
 */
function assertNotPrivateIp(ip: string, urlString: string): void {
  // Check IPv4 private ranges.
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(ip)) {
      throw new Error(`SSRF blocked: resolved endpoint points to private IP: ${urlString}`);
    }
  }

  // Check IPv6 private ranges.
  for (const pattern of PRIVATE_IPV6_PATTERNS) {
    if (pattern.test(ip)) {
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
