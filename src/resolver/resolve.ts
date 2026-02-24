/**
 * Package resolver — resolves DID-scoped packages from remote DWNs.
 *
 * Resolution flow:
 *   1. Resolve DID → DWN endpoints
 *   2. Query package record by name + ecosystem
 *   3. Query version record by semver
 *   4. Fetch tarball binary
 *
 * All queries use the `from:` parameter to route to the remote DWN.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved package metadata. */
export type ResolvedPackage = {
  name : string;
  ecosystem : string;
  description : string;
  contextId : string;
  publisherDid: string;
};

/** Resolved version metadata. */
export type ResolvedVersion = {
  semver : string;
  contextId : string;
  dateCreated : string;
  deprecated : boolean;
  dependencies : Record<string, string>;
  author : string;
};

/** Full resolution result including tarball bytes. */
export type ResolutionResult = {
  package : ResolvedPackage;
  version : ResolvedVersion;
  tarball : Uint8Array | null;
};

// ---------------------------------------------------------------------------
// Resolve package
// ---------------------------------------------------------------------------

/**
 * Find a package record on a target DID's DWN.
 *
 * @param ctx - Agent context for DWN queries
 * @param targetDid - DID of the package publisher
 * @param name - Package name
 * @param ecosystem - Package ecosystem (default: 'npm')
 */
export async function resolvePackage(
  ctx: AgentContext,
  targetDid: string,
  name: string,
  ecosystem: string = 'npm',
): Promise<ResolvedPackage | null> {
  const from = targetDid === ctx.did ? undefined : targetDid;

  const { records } = await ctx.registry.records.query('package', {
    from,
    filter: { tags: { name, ecosystem } },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json();

  return {
    name         : data.name ?? name,
    ecosystem,
    description  : data.description ?? '',
    contextId    : rec.contextId ?? '',
    publisherDid : targetDid,
  };
}

// ---------------------------------------------------------------------------
// Resolve version
// ---------------------------------------------------------------------------

/**
 * Find a specific version of a package.
 *
 * @param ctx - Agent context
 * @param targetDid - Publisher DID
 * @param pkgContextId - Context ID of the package record
 * @param semver - Semver string to resolve
 */
export async function resolveVersion(
  ctx: AgentContext,
  targetDid: string,
  pkgContextId: string,
  semver: string,
): Promise<ResolvedVersion | null> {
  const from = targetDid === ctx.did ? undefined : targetDid;

  const { records } = await ctx.registry.records.query('package/version' as any, {
    from,
    filter: {
      contextId : pkgContextId,
      tags      : { semver },
    },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json() as Record<string, unknown>;
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};

  return {
    semver       : String(tags.semver ?? data.semver ?? semver),
    contextId    : rec.contextId ?? '',
    dateCreated  : rec.dateCreated,
    deprecated   : tags.deprecated === true,
    dependencies : (data.dependencies as Record<string, string>) ?? {},
    author       : rec.author,
  };
}

// ---------------------------------------------------------------------------
// List versions
// ---------------------------------------------------------------------------

/**
 * List all versions of a package.
 */
export async function listVersions(
  ctx: AgentContext,
  targetDid: string,
  pkgContextId: string,
): Promise<ResolvedVersion[]> {
  const from = targetDid === ctx.did ? undefined : targetDid;

  const { records } = await ctx.registry.records.query('package/version' as any, {
    from,
    filter   : { contextId: pkgContextId },
    dateSort : DateSort.CreatedDescending,
  });

  const versions: ResolvedVersion[] = [];
  for (const rec of records) {
    const data = await rec.data.json() as Record<string, unknown>;
    const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};

    versions.push({
      semver       : String(tags.semver ?? data.semver ?? ''),
      contextId    : rec.contextId ?? '',
      dateCreated  : rec.dateCreated,
      deprecated   : tags.deprecated === true,
      dependencies : (data.dependencies as Record<string, string>) ?? {},
      author       : rec.author,
    });
  }

  return versions;
}

// ---------------------------------------------------------------------------
// Fetch tarball
// ---------------------------------------------------------------------------

/**
 * Fetch the tarball for a specific version.
 */
export async function fetchTarball(
  ctx: AgentContext,
  targetDid: string,
  versionContextId: string,
): Promise<Uint8Array | null> {
  const from = targetDid === ctx.did ? undefined : targetDid;

  const { records } = await ctx.registry.records.query('package/version/tarball' as any, {
    from,
    filter: { contextId: versionContextId },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const blob = await rec.data.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Full resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a full package specifier: `did:method:id/name@version`.
 *
 * Returns the package metadata, version metadata, and tarball bytes.
 */
export async function resolveFullPackage(
  ctx: AgentContext,
  targetDid: string,
  name: string,
  semver: string,
  ecosystem: string = 'npm',
): Promise<ResolutionResult | null> {
  const pkg = await resolvePackage(ctx, targetDid, name, ecosystem);
  if (!pkg) { return null; }

  const version = await resolveVersion(ctx, targetDid, pkg.contextId, semver);
  if (!version) { return null; }

  const tarball = await fetchTarball(ctx, targetDid, version.contextId);

  return { package: pkg, version, tarball };
}

// ---------------------------------------------------------------------------
// Parse specifier
// ---------------------------------------------------------------------------

/**
 * Parse a package specifier like `did:dht:abc123/my-pkg@1.0.0`.
 *
 * Returns `{ did, name, version }` or `null` if the format is invalid.
 */
export function parseSpecifier(
  specifier: string,
): { did: string; name: string; version: string } | null {
  // Match: did:method:id/name@version
  const match = specifier.match(/^(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([^@]+)@(.+)$/);
  if (!match) { return null; }

  return {
    did     : match[1],
    name    : match[2],
    version : match[3],
  };
}
