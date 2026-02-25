/**
 * OCI Distribution registry shim — translates Docker/Podman pull
 * requests into DWN queries.
 *
 * Implements the read-only subset of the OCI Distribution Spec v2
 * needed by `docker pull` and `podman pull`.
 *
 * Container images are stored in the DWN using the forge-registry
 * protocol with the `oci` ecosystem.  The mapping is:
 *
 *   OCI concept       → DWN record
 *   ──────────────────────────────────────
 *   Repository         → `package` (ecosystem: 'oci')
 *   Tag / version      → `package/version` (semver = tag)
 *   Manifest           → `package/version/tarball` (application/vnd.oci.image.manifest.v1+json)
 *   Blob / layer       → queried by digest from version data
 *
 * Image naming:
 *   `localhost:5555/did:dht:abc123/my-image:v1.0.0`
 *
 * The DID and image name are extracted from the Docker repository name.
 *
 * Endpoints (OCI Distribution Spec v2):
 *   GET /v2/                                      API version check
 *   GET /v2/{name}/manifests/{reference}           Pull manifest (by tag or digest)
 *   HEAD /v2/{name}/manifests/{reference}          Check manifest existence
 *   GET /v2/{name}/blobs/{digest}                  Pull blob
 *   GET /v2/{name}/tags/list                       List tags
 *
 * @module
 */

import type { AgentContext } from '../../cli/agent.js';

import {
  fetchTarball,
  listVersions,
  resolvePackage,
  resolveVersion,
} from '../../resolver/resolve.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OCI registry HTTP response. */
export type OciResponse = {
  status : number;
  headers : Record<string, string>;
  body : string | Uint8Array;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** OCI-required headers for all responses. */
function ociHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Docker-Distribution-Api-Version' : 'registry/2.0',
    'Access-Control-Allow-Origin'     : '*',
    ...extra,
  };
}

/** Build a 404 response with OCI error envelope. */
function notFound(code: string, message: string): OciResponse {
  return {
    status  : 404,
    headers : ociHeaders({ 'Content-Type': 'application/json' }),
    body    : JSON.stringify({
      errors: [{ code, message, detail: null }],
    }),
  };
}

/**
 * Parse an OCI repository name into DID + image name.
 *
 * OCI repositories use the format: `did:<method>:<id>/<image-name>`
 * Docker CLI sends this as the `name` portion of the v2 API path.
 */
export function parseOciName(
  name: string,
): { did: string; imageName: string } | null {
  const match = name.match(
    /^(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._/-]+)$/,
  );

  if (!match) { return null; }

  return { did: match[1], imageName: match[2] };
}

/**
 * Compute a SHA-256 digest of the given data.
 *
 * Returns the digest in OCI format: `sha256:<hex>`.
 */
async function sha256Digest(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes),
  );
  const hex = Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /v2/ — API version check. */
function handleApiVersionCheck(): OciResponse {
  return {
    status  : 200,
    headers : ociHeaders({ 'Content-Type': 'application/json' }),
    body    : JSON.stringify({}),
  };
}

/** GET /v2/{name}/tags/list — list tags for a repository. */
async function handleTagsList(
  ctx: AgentContext,
  did: string,
  imageName: string,
): Promise<OciResponse> {
  const pkg = await resolvePackage(ctx, did, imageName, 'oci');
  if (!pkg) {
    return notFound('NAME_UNKNOWN', `repository not found: ${did}/${imageName}`);
  }

  const versions = await listVersions(ctx, did, pkg.contextId);
  const tags = versions.map((v) => v.semver);

  return {
    status  : 200,
    headers : ociHeaders({ 'Content-Type': 'application/json' }),
    body    : JSON.stringify({
      name: `${did}/${imageName}`,
      tags,
    }),
  };
}

/**
 * GET /v2/{name}/manifests/{reference} — pull manifest.
 *
 * The manifest is stored as the tarball record's data.  The `reference`
 * can be a tag (semver string) or a digest (`sha256:…`).
 */
async function handleGetManifest(
  ctx: AgentContext,
  did: string,
  imageName: string,
  reference: string,
  headOnly: boolean,
): Promise<OciResponse> {
  const pkg = await resolvePackage(ctx, did, imageName, 'oci');
  if (!pkg) {
    return notFound('NAME_UNKNOWN', `repository not found: ${did}/${imageName}`);
  }

  // Resolve by tag or digest.
  let manifestBytes: Uint8Array | null = null;

  if (reference.startsWith('sha256:')) {
    // Digest-based lookup: iterate versions and match by content digest.
    const versions = await listVersions(ctx, did, pkg.contextId);
    for (const ver of versions) {
      const data = await fetchTarball(ctx, did, ver.contextId);
      if (data) {
        const digest = await sha256Digest(data);
        if (digest === reference) {
          manifestBytes = data;
          break;
        }
      }
    }
  } else {
    // Tag-based lookup.
    const ver = await resolveVersion(ctx, did, pkg.contextId, reference);
    if (ver) {
      manifestBytes = await fetchTarball(ctx, did, ver.contextId);
    }
  }

  if (!manifestBytes) {
    return notFound('MANIFEST_UNKNOWN', `manifest unknown: ${reference}`);
  }

  const digest = await sha256Digest(manifestBytes);

  // Determine content type from manifest content.
  let contentType = 'application/vnd.oci.image.manifest.v1+json';
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (parsed.mediaType) {
      contentType = parsed.mediaType as string;
    }
  } catch {
    // Not valid JSON — treat as raw manifest.
  }

  if (headOnly) {
    return {
      status  : 200,
      headers : ociHeaders({
        'Content-Type'          : contentType,
        'Content-Length'        : String(manifestBytes.byteLength),
        'Docker-Content-Digest' : digest,
      }),
      body: '',
    };
  }

  return {
    status  : 200,
    headers : ociHeaders({
      'Content-Type'          : contentType,
      'Content-Length'        : String(manifestBytes.byteLength),
      'Docker-Content-Digest' : digest,
    }),
    body: manifestBytes,
  };
}

/**
 * GET /v2/{name}/blobs/{digest} — pull a blob.
 *
 * In this shim, blobs are also stored as version tarballs.  The digest
 * is matched against all version tarballs for the repository.
 *
 * For a production implementation, blobs would be stored as separate
 * DWN records keyed by content digest.
 */
async function handleGetBlob(
  ctx: AgentContext,
  did: string,
  imageName: string,
  digest: string,
): Promise<OciResponse> {
  const pkg = await resolvePackage(ctx, did, imageName, 'oci');
  if (!pkg) {
    return notFound('NAME_UNKNOWN', `repository not found: ${did}/${imageName}`);
  }

  // Search all versions for a tarball matching the digest.
  const versions = await listVersions(ctx, did, pkg.contextId);
  for (const ver of versions) {
    const data = await fetchTarball(ctx, did, ver.contextId);
    if (data) {
      const d = await sha256Digest(data);
      if (d === digest) {
        return {
          status  : 200,
          headers : ociHeaders({
            'Content-Type'          : 'application/octet-stream',
            'Content-Length'        : String(data.byteLength),
            'Docker-Content-Digest' : digest,
          }),
          body: data,
        };
      }
    }
  }

  return notFound('BLOB_UNKNOWN', `blob unknown: ${digest}`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route an OCI registry request to the appropriate handler.
 *
 * Exported for testing — tests can call this directly without starting
 * an HTTP server.
 */
export async function handleOciRequest(
  ctx: AgentContext,
  url: URL,
  method: string = 'GET',
): Promise<OciResponse> {
  const path = url.pathname;

  // --- /v2/ — API version check ----------------------------------------
  if (path === '/v2/' || path === '/v2') {
    return handleApiVersionCheck();
  }

  // All other endpoints are under /v2/{name}/…
  const v2Match = path.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\/(.+)$/);
  if (!v2Match) {
    // Check for tags/list format: /v2/{name}/tags/list
    const tagsMatch = path.match(/^\/v2\/(.+)\/tags\/list$/);
    if (tagsMatch) {
      const parsed = parseOciName(tagsMatch[1]);
      if (!parsed) {
        return notFound('NAME_INVALID', 'Invalid repository name. Expected did:<method>:<id>/<name>');
      }
      return handleTagsList(ctx, parsed.did, parsed.imageName);
    }

    return notFound('NAME_INVALID', 'Invalid v2 API path');
  }

  const repoName = v2Match[1];
  const endpoint = v2Match[2];
  const reference = v2Match[3];

  const parsed = parseOciName(repoName);
  if (!parsed) {
    return notFound('NAME_INVALID', 'Invalid repository name. Expected did:<method>:<id>/<name>');
  }

  switch (endpoint) {
    case 'manifests':
      return handleGetManifest(ctx, parsed.did, parsed.imageName, reference, method === 'HEAD');

    case 'blobs':
      return handleGetBlob(ctx, parsed.did, parsed.imageName, reference);

    case 'tags':
      if (reference === 'list') {
        return handleTagsList(ctx, parsed.did, parsed.imageName);
      }
      return notFound('NAME_INVALID', `Unknown tags endpoint: ${reference}`);

    default:
      return notFound('NAME_INVALID', `Unknown endpoint: ${endpoint}`);
  }
}
