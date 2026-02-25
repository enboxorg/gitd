/**
 * Go module proxy shim — translates GOPROXY protocol requests into
 * DWN queries via the resolver module.
 *
 * Implements the GOPROXY protocol (https://go.dev/ref/mod#goproxy-protocol)
 * for DID-scoped Go modules.  Module paths use the format:
 *   `did.enbox.org/did:<method>:<id>/<module>`
 *
 * The `did.enbox.org` prefix is a virtual domain that the shim
 * intercepts.  The DID and module name are extracted from the path.
 *
 * Endpoints:
 *   GET /{module}/@v/list          List available versions
 *   GET /{module}/@v/{ver}.info    Version info (JSON: version + time)
 *   GET /{module}/@v/{ver}.mod     go.mod file
 *   GET /{module}/@v/{ver}.zip     Module zip archive
 *   GET /{module}/@latest          Latest version info
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

/** Go proxy HTTP response. */
export type GoProxyResponse = {
  status : number;
  headers : Record<string, string>;
  body : string | Uint8Array;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard JSON headers. */
function jsonHeaders(): Record<string, string> {
  return {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
  };
}

/** Build a 404 response. */
function notFound(message: string): GoProxyResponse {
  return {
    status  : 404,
    headers : { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    body    : message,
  };
}

/** Build a 410 Gone response (GOPROXY convention for not available). */
function gone(message: string): GoProxyResponse {
  return {
    status  : 410,
    headers : { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    body    : message,
  };
}

/**
 * Parse a Go module path into DID + module name.
 *
 * Go module paths are URL-encoded in the GOPROXY protocol — uppercase
 * letters become `!` + lowercase (Go module proxy encoding).
 *
 * Format: `did.enbox.org/did:<method>:<id>/<module>`
 *
 * The `did.enbox.org/` prefix is stripped by the time it reaches us
 * (it's part of the GOPROXY URL, not the request path).  The path
 * starts with `did:<method>:<id>/<module>`.
 */
export function parseGoModulePath(
  modulePath: string,
): { did: string; name: string } | null {
  // Decode Go module proxy encoding: !x → X
  const decoded = modulePath.replace(/!([a-z])/g, (_, c: string) => c.toUpperCase());

  // Match: did:<method>:<id>/<module-name>
  const match = decoded.match(
    /^(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._/-]+)/,
  );

  if (!match) { return null; }

  return { did: match[1], name: match[2] };
}

/**
 * Go version info JSON: `{ "Version": "v1.0.0", "Time": "2024-01-01T…" }`
 */
function versionInfo(semver: string, dateCreated: string): string {
  // Go expects `v`-prefixed semver.
  const goVer = semver.startsWith('v') ? semver : `v${semver}`;
  return JSON.stringify({
    Version : goVer,
    Time    : new Date(dateCreated).toISOString(),
  });
}

/**
 * Strip `v` prefix from a Go version string for DWN semver queries.
 */
function stripV(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Generate a minimal `go.mod` file for a DID-scoped module.
 */
function generateGoMod(did: string, name: string, deps: Record<string, string>): string {
  const modulePath = `did.enbox.org/${did}/${name}`;
  const lines = [`module ${modulePath}`, '', 'go 1.21', ''];

  const depEntries = Object.entries(deps);
  if (depEntries.length > 0) {
    lines.push('require (');
    for (const [dep, ver] of depEntries) {
      // DID-scoped deps: did:dht:abc/utils → did.enbox.org/did:dht:abc/utils
      const goPath = dep.startsWith('did:') ? `did.enbox.org/${dep}` : dep;
      const goVer = ver.startsWith('v') ? ver : `v${ver}`;
      lines.push(`\t${goPath} ${goVer}`);
    }
    lines.push(')');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /{module}/@v/list — list available versions. */
async function handleVersionList(
  ctx: AgentContext,
  did: string,
  name: string,
): Promise<GoProxyResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'go');
  if (!pkg) {
    return gone(`module not found: did.enbox.org/${did}/${name}`);
  }

  const versions = await listVersions(ctx, did, pkg.contextId);
  const versionLines = versions
    .filter((v) => !v.deprecated)
    .map((v) => v.semver.startsWith('v') ? v.semver : `v${v.semver}`)
    .join('\n');

  return {
    status  : 200,
    headers : { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    body    : versionLines,
  };
}

/** GET /{module}/@v/{ver}.info — version metadata JSON. */
async function handleVersionInfo(
  ctx: AgentContext,
  did: string,
  name: string,
  version: string,
): Promise<GoProxyResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'go');
  if (!pkg) {
    return gone(`module not found: did.enbox.org/${did}/${name}`);
  }

  const ver = await resolveVersion(ctx, did, pkg.contextId, stripV(version));
  if (!ver) {
    return gone(`version not found: ${version}`);
  }

  return {
    status  : 200,
    headers : jsonHeaders(),
    body    : versionInfo(ver.semver, ver.dateCreated),
  };
}

/** GET /{module}/@v/{ver}.mod — go.mod content. */
async function handleGoMod(
  ctx: AgentContext,
  did: string,
  name: string,
  version: string,
): Promise<GoProxyResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'go');
  if (!pkg) {
    return gone(`module not found: did.enbox.org/${did}/${name}`);
  }

  const ver = await resolveVersion(ctx, did, pkg.contextId, stripV(version));
  if (!ver) {
    return gone(`version not found: ${version}`);
  }

  return {
    status  : 200,
    headers : { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    body    : generateGoMod(did, name, ver.dependencies),
  };
}

/** GET /{module}/@v/{ver}.zip — module zip archive (tarball from DWN). */
async function handleModuleZip(
  ctx: AgentContext,
  did: string,
  name: string,
  version: string,
): Promise<GoProxyResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'go');
  if (!pkg) {
    return gone(`module not found: did.enbox.org/${did}/${name}`);
  }

  const ver = await resolveVersion(ctx, did, pkg.contextId, stripV(version));
  if (!ver) {
    return gone(`version not found: ${version}`);
  }

  const tarball = await fetchTarball(ctx, did, ver.contextId);
  if (!tarball) {
    return gone(`archive not found for ${version}`);
  }

  return {
    status  : 200,
    headers : {
      'Content-Type'                : 'application/zip',
      'Content-Length'              : String(tarball.byteLength),
      'Access-Control-Allow-Origin' : '*',
    },
    body: tarball,
  };
}

/** GET /{module}/@latest — latest version info. */
async function handleLatest(
  ctx: AgentContext,
  did: string,
  name: string,
): Promise<GoProxyResponse> {
  const pkg = await resolvePackage(ctx, did, name, 'go');
  if (!pkg) {
    return gone(`module not found: did.enbox.org/${did}/${name}`);
  }

  const versions = await listVersions(ctx, did, pkg.contextId);
  const latest = versions.find((v) => !v.deprecated) ?? versions[0];
  if (!latest) {
    return gone('no versions available');
  }

  return {
    status  : 200,
    headers : jsonHeaders(),
    body    : versionInfo(latest.semver, latest.dateCreated),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route a Go proxy request to the appropriate handler.
 *
 * Exported for testing — tests can call this directly without starting
 * an HTTP server.
 */
export async function handleGoProxyRequest(
  ctx: AgentContext,
  url: URL,
): Promise<GoProxyResponse> {
  const path = url.pathname.replace(/^\/+/, '');

  // Split the path to find /@v/ or /@latest.
  const atVIdx = path.indexOf('/@v/');
  const atLatestIdx = path.indexOf('/@latest');

  // --- /@latest --------------------------------------------------------
  if (atLatestIdx !== -1) {
    const modulePath = path.slice(0, atLatestIdx);
    const parsed = parseGoModulePath(modulePath);
    if (!parsed) { return notFound('Invalid module path'); }
    return handleLatest(ctx, parsed.did, parsed.name);
  }

  // --- /@v/list --------------------------------------------------------
  if (atVIdx !== -1) {
    const modulePath = path.slice(0, atVIdx);
    const rest = path.slice(atVIdx + 4); // after "/@v/"
    const parsed = parseGoModulePath(modulePath);
    if (!parsed) { return notFound('Invalid module path'); }

    if (rest === 'list') {
      return handleVersionList(ctx, parsed.did, parsed.name);
    }

    // --- /@v/{ver}.info ------------------------------------------------
    if (rest.endsWith('.info')) {
      const version = rest.slice(0, -5);
      return handleVersionInfo(ctx, parsed.did, parsed.name, version);
    }

    // --- /@v/{ver}.mod -------------------------------------------------
    if (rest.endsWith('.mod')) {
      const version = rest.slice(0, -4);
      return handleGoMod(ctx, parsed.did, parsed.name, version);
    }

    // --- /@v/{ver}.zip -------------------------------------------------
    if (rest.endsWith('.zip')) {
      const version = rest.slice(0, -4);
      return handleModuleZip(ctx, parsed.did, parsed.name, version);
    }

    return notFound(`Unknown @v endpoint: ${rest}`);
  }

  return notFound('Not a Go module proxy request. Expected /@v/ or /@latest in path.');
}
