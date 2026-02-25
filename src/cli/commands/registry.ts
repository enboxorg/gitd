/**
 * `gitd registry` — DID-scoped package publishing and management.
 *
 * Packages are scoped to the publisher's DID. Versions and tarballs are
 * immutable — once published, content cannot be silently replaced.
 *
 * Usage:
 *   gitd registry publish <name> <version> <tarball-path>
 *       [--ecosystem <npm|cargo|pip|go>] [--description <text>]
 *   gitd registry info <name>
 *   gitd registry versions <name>
 *   gitd registry list [--ecosystem <npm|cargo|pip|go>]
 *   gitd registry yank <name> <version>
 *   gitd registry attest <name> <version> --claim <claim>
 *       [--source-commit <sha>] [--source-repo <did/id>]
 *   gitd registry attestations <name> <version>
 *   gitd registry verify <name> <version> [--trusted <did>,...]
 *   gitd registry resolve <did>/<name>@<version>
 *   gitd registry verify-deps <did>/<name>@<version> [--trusted <did>,...]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { readFile, stat } from 'node:fs/promises';

import { DateSort } from '@enbox/dwn-sdk-js';
import { flagValue } from '../flags.js';

import { buildTrustChain, formatTrustChain, parseSpecifier, resolveFullPackage } from '../../resolver/index.js';
import { fetchAttestations, verifyPackageVersion } from '../../resolver/verify.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function registryCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'publish': return registryPublish(ctx, rest);
    case 'info': return registryInfo(ctx, rest);
    case 'versions': return registryVersions(ctx, rest);
    case 'list':
    case 'ls': return registryList(ctx, rest);
    case 'yank': return registryYank(ctx, rest);
    case 'attest': return registryAttest(ctx, rest);
    case 'attestations': return registryAttestations(ctx, rest);
    case 'verify': return registryVerify(ctx, rest);
    case 'resolve': return registryResolve(ctx, rest);
    case 'verify-deps': return registryVerifyDeps(ctx, rest);
    default:
      console.error('Usage: gitd registry <publish|info|versions|list|yank|attest|attestations|verify|resolve|verify-deps>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// registry publish
// ---------------------------------------------------------------------------

async function registryPublish(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const version = args[1];
  const tarballPath = args[2];
  const ecosystem = flagValue(args, '--ecosystem') ?? 'npm';
  const description = flagValue(args, '--description');

  if (!name || !version || !tarballPath) {
    console.error('Usage: gitd registry publish <name> <version> <tarball-path> [--ecosystem <npm|cargo|pip|go>]');
    process.exit(1);
  }

  if (!['npm', 'cargo', 'pip', 'go'].includes(ecosystem)) {
    console.error(`Invalid ecosystem: ${ecosystem}. Must be npm, cargo, pip, or go.`);
    process.exit(1);
  }

  // Step 1: Find or create the package record.
  let pkgRecord = await findPackageByName(ctx, name, ecosystem);

  if (!pkgRecord) {
    // Create the package.
    const pkgTags: Record<string, string> = { name, ecosystem };
    if (description) { pkgTags.description = description; }

    const { status: pkgStatus, record: newPkg } = await ctx.registry.records.create('package', {
      data : { name, description },
      tags : pkgTags,
    });

    if (pkgStatus.code >= 300) {
      console.error(`Failed to create package: ${pkgStatus.code} ${pkgStatus.detail}`);
      process.exit(1);
    }

    pkgRecord = newPkg;
    console.log(`Created package: ${name} (${ecosystem})`);
  }

  // Step 2: Check if version already exists.
  const existingVersion = await findVersion(ctx, pkgRecord.contextId, version);
  if (existingVersion) {
    console.error(`Version ${version} already exists for ${name}. Versions are immutable.`);
    process.exit(1);
  }

  // Step 3: Create version record.
  const { status: verStatus, record: verRecord } = await ctx.registry.records.create('package/version' as any, {
    data            : { semver: version },
    tags            : { semver: version },
    parentContextId : pkgRecord.contextId,
  } as any);

  if (verStatus.code >= 300) {
    console.error(`Failed to create version: ${verStatus.code} ${verStatus.detail}`);
    process.exit(1);
  }

  // Step 4: Read and upload the tarball.
  try {
    const tarballData = new Uint8Array(await readFile(tarballPath));
    const fileInfo = await stat(tarballPath);

    const { status: tarStatus } = await ctx.registry.records.create('package/version/tarball' as any, {
      data            : tarballData,
      dataFormat      : 'application/gzip',
      tags            : { filename: tarballPath.split('/').pop() ?? 'package.tgz', contentType: 'application/gzip', size: fileInfo.size },
      parentContextId : verRecord.contextId,
    } as any);

    if (tarStatus.code >= 300) {
      console.error(`Failed to upload tarball: ${tarStatus.code} ${tarStatus.detail}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to read tarball: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Published ${name}@${version} (${ecosystem})`);
  console.log(`  Version ID: ${verRecord.id}`);
  console.log(`  Tarball:    ${tarballPath}`);
}

// ---------------------------------------------------------------------------
// registry info
// ---------------------------------------------------------------------------

async function registryInfo(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: gitd registry info <name>');
    process.exit(1);
  }

  const pkg = await findPackageByName(ctx, name);
  if (!pkg) {
    console.error(`Package "${name}" not found.`);
    process.exit(1);
  }

  const data = await pkg.data.json();
  const tags = pkg.tags as Record<string, string> | undefined;
  const date = pkg.dateCreated?.slice(0, 10) ?? '';

  console.log(`Package: ${data.name}`);
  console.log(`  Ecosystem:   ${tags?.ecosystem ?? 'unknown'}`);
  if (data.description) { console.log(`  Description: ${data.description}`); }
  console.log(`  Created:     ${date}`);
  console.log(`  Publisher:   ${ctx.did}`);
  console.log(`  ID:          ${pkg.id}`);

  // Count versions.
  const { records: versions } = await ctx.registry.records.query('package/version' as any, {
    filter   : { contextId: pkg.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (versions.length > 0) {
    console.log(`  Versions:    ${versions.length}`);
    const latest = versions[0].tags as Record<string, string> | undefined;
    console.log(`  Latest:      ${latest?.semver ?? '?'}`);
  }
}

// ---------------------------------------------------------------------------
// registry versions
// ---------------------------------------------------------------------------

async function registryVersions(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: gitd registry versions <name>');
    process.exit(1);
  }

  const pkg = await findPackageByName(ctx, name);
  if (!pkg) {
    console.error(`Package "${name}" not found.`);
    process.exit(1);
  }

  const { records: versions } = await ctx.registry.records.query('package/version' as any, {
    filter   : { contextId: pkg.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (versions.length === 0) {
    console.log(`No versions published for ${name}.`);
    return;
  }

  console.log(`${name} — ${versions.length} version${versions.length !== 1 ? 's' : ''}:\n`);
  for (const ver of versions) {
    const verTags = ver.tags as Record<string, unknown> | undefined;
    const semver = verTags?.semver ?? '?';
    const deprecated = verTags?.deprecated === true ? ' [deprecated]' : '';
    const date = ver.dateCreated?.slice(0, 10) ?? '';
    console.log(`  ${String(semver).padEnd(20)}${deprecated}  ${date}`);
    console.log(`${''.padEnd(22)}id: ${ver.id}`);
  }
}

// ---------------------------------------------------------------------------
// registry list
// ---------------------------------------------------------------------------

async function registryList(ctx: AgentContext, args: string[]): Promise<void> {
  const ecosystem = flagValue(args, '--ecosystem');

  const filter: Record<string, unknown> = {};
  if (ecosystem) {
    filter.tags = { ecosystem };
  }

  const { records } = await ctx.registry.records.query('package', {
    filter   : filter,
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    console.log('No packages found.');
    return;
  }

  console.log(`Packages (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const eco = tags?.ecosystem ?? '?';
    const desc = data.description ? ` — ${data.description}` : '';
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    console.log(`  ${data.name} [${eco}]${desc}  ${date}`);
    console.log(`${''.padEnd(4)}id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// registry yank
// ---------------------------------------------------------------------------

async function registryYank(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const version = args[1];

  if (!name || !version) {
    console.error('Usage: gitd registry yank <name> <version>');
    process.exit(1);
  }

  const pkg = await findPackageByName(ctx, name);
  if (!pkg) {
    console.error(`Package "${name}" not found.`);
    process.exit(1);
  }

  const verRecord = await findVersion(ctx, pkg.contextId, version);
  if (!verRecord) {
    console.error(`Version ${version} not found for ${name}.`);
    process.exit(1);
  }

  const verTags = verRecord.tags as Record<string, unknown> | undefined;
  if (verTags?.deprecated === true) {
    console.log(`Version ${version} is already yanked.`);
    return;
  }

  // Versions are $immutable, so we can't update the tag. Instead, yank is
  // advisory — in a real system, the indexer/resolver respects this. For now,
  // we note that $immutable versions cannot be mutated and print a message.
  console.log(`Note: Version records are immutable. ${name}@${version} cannot be modified.`);
  console.log('To deprecate, publish a new version or update the package description.');
}

// ---------------------------------------------------------------------------
// registry attest
// ---------------------------------------------------------------------------

async function registryAttest(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const version = args[1];
  const claim = flagValue(args, '--claim');
  const sourceCommit = flagValue(args, '--source-commit');
  const sourceRepo = flagValue(args, '--source-repo');

  if (!name || !version || !claim) {
    console.error('Usage: gitd registry attest <name> <version> --claim <claim> [--source-commit <sha>] [--source-repo <did/id>]');
    process.exit(1);
  }

  // Find the package and version.
  const pkg = await findPackageByName(ctx, name);
  if (!pkg) {
    console.error(`Package "${name}" not found.`);
    process.exit(1);
  }

  const verRecord = await findVersion(ctx, pkg.contextId, version);
  if (!verRecord) {
    console.error(`Version ${version} not found for ${name}.`);
    process.exit(1);
  }

  // Create the attestation record.
  const attestationData: Record<string, string> = {
    attestorDid: ctx.did,
    claim,
  };
  if (sourceCommit) { attestationData.sourceCommit = sourceCommit; }
  if (sourceRepo) { attestationData.sourceRepo = sourceRepo; }

  const { status } = await ctx.registry.records.create('package/version/attestation' as any, {
    data            : attestationData,
    parentContextId : verRecord.contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create attestation: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Attestation created for ${name}@${version}`);
  console.log(`  Attestor: ${ctx.did}`);
  console.log(`  Claim:    ${claim}`);
  if (sourceCommit) { console.log(`  Commit:   ${sourceCommit}`); }
  if (sourceRepo) { console.log(`  Repo:     ${sourceRepo}`); }
}

// ---------------------------------------------------------------------------
// registry attestations
// ---------------------------------------------------------------------------

async function registryAttestations(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const version = args[1];

  if (!name || !version) {
    console.error('Usage: gitd registry attestations <name> <version>');
    process.exit(1);
  }

  const pkg = await findPackageByName(ctx, name);
  if (!pkg) {
    console.error(`Package "${name}" not found.`);
    process.exit(1);
  }

  const verRecord = await findVersion(ctx, pkg.contextId, version);
  if (!verRecord) {
    console.error(`Version ${version} not found for ${name}.`);
    process.exit(1);
  }

  const attestations = await fetchAttestations(ctx, ctx.did, verRecord.contextId ?? '');

  if (attestations.length === 0) {
    console.log(`No attestations for ${name}@${version}.`);
    return;
  }

  console.log(`Attestations for ${name}@${version} (${attestations.length}):\n`);
  for (const att of attestations) {
    console.log(`  Attestor:  ${att.attestorDid}`);
    console.log(`  Claim:     ${att.claim}`);
    if (att.sourceCommit) { console.log(`  Commit:    ${att.sourceCommit}`); }
    if (att.sourceRepo) { console.log(`  Repo:      ${att.sourceRepo}`); }
    console.log(`  Created:   ${att.dateCreated?.slice(0, 10) ?? ''}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// registry verify
// ---------------------------------------------------------------------------

async function registryVerify(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const version = args[1];
  const trustedArg = flagValue(args, '--trusted');
  const trustedAttestors = trustedArg ? trustedArg.split(',') : [];

  if (!name || !version) {
    console.error('Usage: gitd registry verify <name> <version> [--trusted <did>,...]');
    process.exit(1);
  }

  const result = await verifyPackageVersion(ctx, ctx.did, name, version, 'npm', trustedAttestors);

  console.log(`Verification for ${name}@${version}:`);
  console.log(`  Publisher: ${result.publisherDid}`);
  console.log(`  Overall:  ${result.passed ? 'PASS' : 'FAIL'}`);
  console.log('');

  for (const check of result.checks) {
    const mark = check.passed ? '+' : 'x';
    console.log(`  [${mark}] ${check.check}: ${check.detail}`);
  }

  if (result.attestations.length > 0) {
    console.log(`\n  Attestations (${result.attestations.length}):`);
    for (const att of result.attestations) {
      console.log(`    ${att.claim} by ${att.attestorDid}`);
    }
  }
}

// ---------------------------------------------------------------------------
// registry resolve
// ---------------------------------------------------------------------------

async function registryResolve(ctx: AgentContext, args: string[]): Promise<void> {
  const specifier = args[0];
  const ecosystem = flagValue(args, '--ecosystem') ?? 'npm';

  if (!specifier) {
    console.error('Usage: gitd registry resolve <did>/<name>@<version> [--ecosystem <eco>]');
    process.exit(1);
  }

  const parsed = parseSpecifier(specifier);
  if (!parsed) {
    console.error(`Invalid specifier: ${specifier}`);
    console.error('Expected format: did:method:id/name@version');
    process.exit(1);
  }

  console.log(`Resolving ${parsed.did}/${parsed.name}@${parsed.version} (${ecosystem})...`);

  const result = await resolveFullPackage(ctx, parsed.did, parsed.name, parsed.version, ecosystem);

  if (!result) {
    console.error(`Package not found: ${specifier}`);
    process.exit(1);
  }

  console.log(`\nPackage: ${result.package.name}`);
  console.log(`  Publisher:    ${result.package.publisherDid}`);
  console.log(`  Ecosystem:    ${result.package.ecosystem}`);
  if (result.package.description) { console.log(`  Description:  ${result.package.description}`); }
  console.log(`\nVersion: ${result.version.semver}`);
  console.log(`  Author:       ${result.version.author}`);
  console.log(`  Created:      ${result.version.dateCreated?.slice(0, 10) ?? ''}`);
  console.log(`  Deprecated:   ${result.version.deprecated}`);

  const depCount = Object.keys(result.version.dependencies).length;
  if (depCount > 0) {
    console.log(`  Dependencies: ${depCount}`);
    for (const [dep, ver] of Object.entries(result.version.dependencies)) {
      console.log(`    ${dep}: ${ver}`);
    }
  }

  console.log(`\nTarball: ${result.tarball ? `${result.tarball.length} bytes` : 'not found'}`);
}

// ---------------------------------------------------------------------------
// registry verify-deps
// ---------------------------------------------------------------------------

async function registryVerifyDeps(ctx: AgentContext, args: string[]): Promise<void> {
  const specifier = args[0];
  const trustedArg = flagValue(args, '--trusted');
  const trustedAttestors = trustedArg ? trustedArg.split(',') : [];
  const ecosystem = flagValue(args, '--ecosystem') ?? 'npm';

  if (!specifier) {
    console.error('Usage: gitd registry verify-deps <did>/<name>@<version> [--trusted <did>,...] [--ecosystem <eco>]');
    process.exit(1);
  }

  const parsed = parseSpecifier(specifier);
  if (!parsed) {
    console.error(`Invalid specifier: ${specifier}`);
    console.error('Expected format: did:method:id/name@version');
    process.exit(1);
  }

  console.log(`Building trust chain for ${specifier}...`);

  const result = await buildTrustChain(
    ctx, parsed.did, parsed.name, parsed.version, ecosystem, trustedAttestors,
  );

  console.log('');
  console.log(formatTrustChain(result));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findPackageByName(
  ctx: AgentContext,
  name: string,
  ecosystem?: string,
): Promise<any | undefined> {
  const filter: Record<string, unknown> = {};
  const tagFilter: Record<string, string> = { name };
  if (ecosystem) { tagFilter.ecosystem = ecosystem; }
  filter.tags = tagFilter;

  const { records } = await ctx.registry.records.query('package', { filter });
  return records[0];
}

async function findVersion(
  ctx: AgentContext,
  pkgContextId: string,
  semver: string,
): Promise<any | undefined> {
  const { records } = await ctx.registry.records.query('package/version' as any, {
    filter: {
      contextId : pkgContextId,
      tags      : { semver },
    },
  });
  return records[0];
}
