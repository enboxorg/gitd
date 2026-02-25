/**
 * npm registry shim — translates npm registry HTTP API requests into
 * DWN queries via the resolver module.
 *
 * Serves the subset of the npm registry API needed by `npm install`,
 * `bun install`, `yarn add`, and `pnpm add`.  Packages are addressed
 * using DID-scoped npm scopes: `@did:dht:abc123/my-pkg`.
 *
 * URL mapping:
 *   GET /@did:*{@/:name}/:name               Package metadata (all versions)
 *   GET /@did:*{@/:name}/:name/:version      Specific version metadata
 *   GET /@did:*{@/:name}/:name/-/:file.tgz   Tarball download
 *
 * The DID is extracted from the npm scope.  For example:
 *   `@did:dht:abc123/my-pkg` → DID `did:dht:abc123`, package `my-pkg`
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

/** npm registry HTTP response. */
export type NpmResponse = {
  status : number;
  headers : Record<string, string>;
  body : string | Uint8Array;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard JSON headers for npm registry responses. */
function jsonHeaders(): Record<string, string> {
  return {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
  };
}

/** Build a 404 response. */
function notFound(message: string): NpmResponse {
  return {
    status  : 404,
    headers : jsonHeaders(),
    body    : JSON.stringify({ error: message }),
  };
}

/**
 * Parse an npm-scoped package name into DID + package name.
 *
 * Supports two scope formats for DID methods with colons:
 *   - URL-encoded: `@did%3Adht%3Aabc123/pkg`   (npm's default encoding)
 *   - Slash-separated: `@did:dht:abc123/pkg`    (direct browser access)
 *
 * Returns `null` if the scope doesn't contain a valid DID.
 */
export function parseNpmScope(
  path: string,
): { did: string; name: string } | null {
  // Decode percent-encoding first (%3A → :, %2F → /)
  const decoded = decodeURIComponent(path);

  // Match: /@did:<method>:<id>/<package-name>
  const match = decoded.match(
    /^\/@(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)/,
  );

  if (!match) { return null; }

  return { did: match[1], name: match[2] };
}

/**
 * Build a Packument (npm package document) for a DID-scoped package.
 *
 * This is the standard npm registry response for `GET /:package`.
 * Contains metadata for all published versions.
 */
async function buildPackument(
  ctx: AgentContext,
  did: string,
  name: string,
): Promise<NpmResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'npm');
  if (!pkg) {
    return notFound(`Package not found: @${did}/${name}`);
  }

  const versions = await listVersions(ctx, did, pkg.contextId);
  if (versions.length === 0) {
    return notFound(`No versions found for @${did}/${name}`);
  }

  // Build versions map.
  const versionsMap: Record<string, unknown> = {};
  const distTags: Record<string, string> = {};
  const times: Record<string, string> = { created: versions[versions.length - 1].dateCreated };

  for (const v of versions) {
    const scopedName = `@${did}/${name}`;
    const tarballUrl = `/-/${scopedName}/-/${name}-${v.semver}.tgz`;

    versionsMap[v.semver] = {
      name    : scopedName,
      version : v.semver,
      dist    : {
        tarball: tarballUrl,
      },
      dependencies : v.dependencies,
      deprecated   : v.deprecated ? `Version ${v.semver} is deprecated` : undefined,
      _dwn         : {
        publisherDid : did,
        contextId    : v.contextId,
        author       : v.author,
      },
    };

    times[v.semver] = v.dateCreated;
  }

  // Latest = first non-deprecated, or just first.
  const latest = versions.find((v) => !v.deprecated) ?? versions[0];
  distTags.latest = latest.semver;

  const packument = {
    _id         : `@${did}/${name}`,
    name        : `@${did}/${name}`,
    description : pkg.description,
    'dist-tags' : distTags,
    versions    : versionsMap,
    time        : times,
    _dwn        : {
      publisherDid : did,
      ecosystem    : pkg.ecosystem,
      contextId    : pkg.contextId,
    },
  };

  return {
    status  : 200,
    headers : jsonHeaders(),
    body    : JSON.stringify(packument),
  };
}

/**
 * Build a version-specific metadata response.
 *
 * This is the npm registry response for `GET /:package/:version`.
 */
async function buildVersionMeta(
  ctx: AgentContext,
  did: string,
  name: string,
  semver: string,
): Promise<NpmResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'npm');
  if (!pkg) {
    return notFound(`Package not found: @${did}/${name}`);
  }

  const ver = await resolveVersion(ctx, did, pkg.contextId, semver);
  if (!ver) {
    return notFound(`Version not found: @${did}/${name}@${semver}`);
  }

  const scopedName = `@${did}/${name}`;
  const tarballUrl = `/-/${scopedName}/-/${name}-${ver.semver}.tgz`;

  const body = {
    name         : scopedName,
    version      : ver.semver,
    dist         : { tarball: tarballUrl },
    dependencies : ver.dependencies,
    deprecated   : ver.deprecated ? `Version ${ver.semver} is deprecated` : undefined,
    _dwn         : {
      publisherDid : did,
      contextId    : ver.contextId,
      author       : ver.author,
    },
  };

  return {
    status  : 200,
    headers : jsonHeaders(),
    body    : JSON.stringify(body),
  };
}

/**
 * Serve a tarball download.
 *
 * npm fetches tarballs from the `dist.tarball` URL returned in the
 * packument.  We resolve the version and fetch the tarball from the DWN.
 */
async function serveTarball(
  ctx: AgentContext,
  did: string,
  name: string,
  filename: string,
): Promise<NpmResponse> {
  // Parse version from filename: "name-1.0.0.tgz" → "1.0.0"
  const prefix = `${name}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.tgz')) {
    return notFound(`Invalid tarball filename: ${filename}`);
  }
  const semver = filename.slice(prefix.length, -4);

  const pkg = await resolvePackage(ctx, did, name, 'npm');
  if (!pkg) {
    return notFound(`Package not found: @${did}/${name}`);
  }

  const ver = await resolveVersion(ctx, did, pkg.contextId, semver);
  if (!ver) {
    return notFound(`Version not found: @${did}/${name}@${semver}`);
  }

  const tarball = await fetchTarball(ctx, did, ver.contextId);
  if (!tarball) {
    return notFound(`Tarball not found for @${did}/${name}@${semver}`);
  }

  return {
    status  : 200,
    headers : {
      'Content-Type'                : 'application/octet-stream',
      'Content-Length'              : String(tarball.byteLength),
      'Access-Control-Allow-Origin' : '*',
    },
    body: tarball,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route an npm registry request to the appropriate handler.
 *
 * Exported for testing — tests can call this directly without starting
 * an HTTP server.
 */
export async function handleNpmRequest(
  ctx: AgentContext,
  url: URL,
): Promise<NpmResponse> {
  const path = url.pathname;

  // --- Tarball download: /-/@did:…/name/-/name-ver.tgz -----------------
  const tarballMatch = path.match(
    /^\/-\/@(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/-\/(.+\.tgz)$/,
  );
  if (tarballMatch) {
    return serveTarball(ctx, tarballMatch[1], tarballMatch[2], tarballMatch[3]);
  }

  // --- Scoped package with version: /@did:…/name/version ---------------
  const scope = parseNpmScope(path);
  if (!scope) {
    return notFound('Not a DID-scoped package. Use @did:<method>:<id>/<name>');
  }

  // Check for trailing version segment: /@did:…/name/1.0.0
  const afterScope = path.slice(path.indexOf(scope.name) + scope.name.length);
  const versionMatch = afterScope.match(/^\/([^/]+)$/);

  if (versionMatch) {
    return buildVersionMeta(ctx, scope.did, scope.name, versionMatch[1]);
  }

  // --- Scoped package metadata (all versions): /@did:…/name ------------
  return buildPackument(ctx, scope.did, scope.name);
}
