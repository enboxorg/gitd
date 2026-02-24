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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of resolving a DID to a git transport endpoint. */
export type GitEndpoint = {
  /** The resolved HTTPS URL for git smart HTTP transport. */
  url: string;

  /** The DID that was resolved. */
  did: string;

  /** How the endpoint was discovered. */
  source: 'GitTransport' | 'DecentralizedWebNode';
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

/**
 * Resolve a DID to a git transport HTTPS endpoint.
 *
 * @param did - Full DID URI (e.g. `did:dht:abc123xyz`)
 * @param repo - Optional repo name to append to the endpoint path
 * @returns The resolved git transport endpoint
 * @throws If resolution fails or no git-compatible service is found
 */
export async function resolveGitEndpoint(did: string, repo?: string): Promise<GitEndpoint> {
  const { didDocument, didResolutionMetadata } = await getResolver().resolve(did);

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
      url    : buildUrl(baseUrl, repo),
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
      url    : buildUrl(gitUrl, repo),
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
// Helpers
// ---------------------------------------------------------------------------

/** Extract a URL string from a service endpoint (handles string and array forms). */
function extractEndpointUrl(service: DidService): string {
  const ep = service.serviceEndpoint;

  if (typeof ep === 'string') {
    return ep;
  }
  if (Array.isArray(ep) && ep.length > 0) {
    const first = ep[0];
    if (typeof first === 'string') {
      return first;
    }
  }

  throw new Error(`Cannot extract URL from service endpoint: ${JSON.stringify(ep)}`);
}

/** Append a repo path to a base URL. */
function buildUrl(base: string, repo?: string): string {
  if (!repo) { return base; }
  return `${base.replace(/\/$/, '')}/${repo}`;
}
