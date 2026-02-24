/**
 * GitTransport DID service type utilities.
 *
 * Provides helpers for creating and identifying `GitTransport` service entries
 * in DID documents.  The `GitTransport` service type advertises a smart HTTP
 * git endpoint that can be used by `git-remote-did` to locate repositories.
 *
 * When a DID document contains a GitTransport service, the git remote helper
 * uses it directly (highest priority).  Otherwise it falls back to
 * `DecentralizedWebNode` + `/git` suffix.
 *
 * @example
 * ```ts
 * import { createGitTransportService } from '@enbox/dwn-git/git-remote/service';
 *
 * const service = createGitTransportService({
 *   id              : '#git',
 *   serviceEndpoint : 'https://git.example.com',
 * });
 * // → { id: '#git', type: 'GitTransport', serviceEndpoint: 'https://git.example.com' }
 * ```
 *
 * @module
 */

import type { DidDocument, DidService } from '@enbox/dids';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The DID service type string for git smart HTTP transport endpoints. */
export const GIT_TRANSPORT_SERVICE_TYPE = 'GitTransport' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A DID service entry with `type` fixed to `GitTransport`.
 *
 * The `serviceEndpoint` should be an HTTPS URL (or array of URLs) pointing to
 * a smart HTTP git server.  Repositories are addressed by appending the repo
 * name as a path segment: `<serviceEndpoint>/<repo-name>`.
 */
export interface GitTransportService extends DidService {
  type: typeof GIT_TRANSPORT_SERVICE_TYPE;
}

/** Options for creating a GitTransport service entry. */
export type CreateGitTransportServiceOptions = {
  /**
   * The service entry `id`, typically a fragment like `#git`.
   * If no `#` prefix is provided, it will be added automatically.
   */
  id: string;

  /**
   * The HTTPS URL (or URLs) of the git smart HTTP endpoint.
   *
   * @example 'https://git.example.com'
   * @example ['https://git1.example.com', 'https://git2.example.com']
   */
  serviceEndpoint: string | string[];
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `GitTransport` DID service entry.
 *
 * @param options - Service configuration
 * @returns A well-formed GitTransport service entry ready for inclusion in a
 *          DID document's `service` array.
 */
export function createGitTransportService(
  options: CreateGitTransportServiceOptions,
): GitTransportService {
  const { serviceEndpoint } = options;
  let { id } = options;

  // Normalize the id to include a # prefix if missing.
  if (!id.startsWith('#')) {
    id = `#${id}`;
  }

  // Validate endpoint(s).
  const endpoints = Array.isArray(serviceEndpoint) ? serviceEndpoint : [serviceEndpoint];
  for (const ep of endpoints) {
    if (typeof ep !== 'string' || ep.length === 0) {
      throw new Error(`GitTransport serviceEndpoint must be a non-empty string, got: ${JSON.stringify(ep)}`);
    }
  }

  return {
    id,
    type            : GIT_TRANSPORT_SERVICE_TYPE,
    serviceEndpoint : Array.isArray(serviceEndpoint) ? serviceEndpoint : serviceEndpoint,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Check whether a DID service entry is a GitTransport service.
 *
 * @param service - A service entry from a DID document
 * @returns `true` if the service type is `GitTransport`
 */
export function isGitTransportService(service: DidService): service is GitTransportService {
  return service.type === GIT_TRANSPORT_SERVICE_TYPE;
}

/**
 * Extract all GitTransport service entries from a DID document.
 *
 * @param didDocument - A resolved DID document
 * @returns An array of GitTransport services (may be empty)
 */
export function getGitTransportServices(didDocument: DidDocument): GitTransportService[] {
  return (didDocument.service ?? []).filter(isGitTransportService);
}
