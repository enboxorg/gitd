/**
 * Package verification — cryptographic verification of DWN package records.
 *
 * Verification checks:
 *   1. **Author verification**: the record's `author` DID matches the publisher
 *   2. **Attestation verification**: third-party attestation records are present
 *      and signed by trusted attestors
 *   3. **Integrity check**: tarball exists and is non-empty
 *
 * Since every DWN record is cryptographically signed via JWS in the
 * `authorization` field, verification relies on the DWN SDK having
 * already validated signatures during record ingestion.  Our verification
 * layer adds semantic checks on top of that foundation.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Individual verification check result. */
export type VerificationCheck = {
  check : string;
  passed : boolean;
  detail : string;
};

/** Attestation record as returned by the DWN. */
export type AttestationRecord = {
  attestorDid : string;
  claim : string;
  sourceCommit : string | undefined;
  sourceRepo : string | undefined;
  dateCreated : string;
};

/** Full verification result for a package version. */
export type VerificationResult = {
  passed : boolean;
  publisherDid : string;
  packageName : string;
  version : string;
  checks : VerificationCheck[];
  attestations : AttestationRecord[];
};

// ---------------------------------------------------------------------------
// Attestation queries
// ---------------------------------------------------------------------------

/**
 * Fetch attestation records for a specific package version.
 */
export async function fetchAttestations(
  ctx: AgentContext,
  targetDid: string,
  versionContextId: string,
): Promise<AttestationRecord[]> {
  const from = targetDid === ctx.did ? undefined : targetDid;

  const { records } = await ctx.registry.records.query('package/version/attestation' as any, {
    from,
    filter   : { contextId: versionContextId },
    dateSort : DateSort.CreatedAscending,
  });

  const attestations: AttestationRecord[] = [];
  for (const rec of records) {
    const data = await rec.data.json() as Record<string, unknown>;
    attestations.push({
      attestorDid  : String(data.attestorDid ?? ''),
      claim        : String(data.claim ?? ''),
      sourceCommit : data.sourceCommit as string | undefined,
      sourceRepo   : data.sourceRepo as string | undefined,
      dateCreated  : rec.dateCreated,
    });
  }

  return attestations;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a package version's integrity and provenance.
 *
 * Performs the following checks:
 *   1. Package record exists and is owned by the expected DID
 *   2. Version record exists and is authored by the publisher
 *   3. Tarball exists and is non-empty
 *   4. Attestations are present (informational — not required to pass)
 *
 * @param ctx - Agent context
 * @param targetDid - Expected publisher DID
 * @param name - Package name
 * @param semver - Version string
 * @param ecosystem - Ecosystem (default: 'npm')
 * @param trustedAttestors - DIDs of trusted attestors (optional)
 */
export async function verifyPackageVersion(
  ctx: AgentContext,
  targetDid: string,
  name: string,
  semver: string,
  ecosystem: string = 'npm',
  trustedAttestors: string[] = [],
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  const from = targetDid === ctx.did ? undefined : targetDid;

  // -------------------------------------------------------------------------
  // 1. Package record exists
  // -------------------------------------------------------------------------
  const { records: pkgRecords } = await ctx.registry.records.query('package', {
    from,
    filter: { tags: { name, ecosystem } },
  });

  if (pkgRecords.length === 0) {
    checks.push({ check: 'package-exists', passed: false, detail: `Package '${name}' not found on ${targetDid}` });
    return { passed: false, publisherDid: targetDid, packageName: name, version: semver, checks, attestations: [] };
  }

  const pkgRec = pkgRecords[0];
  checks.push({ check: 'package-exists', passed: true, detail: `Package '${name}' found` });

  // -------------------------------------------------------------------------
  // 2. Publisher matches — the record author is the expected DID
  // -------------------------------------------------------------------------
  const authorMatchesPkg = pkgRec.author === targetDid || pkgRec.creator === targetDid;
  checks.push({
    check  : 'publisher-match',
    passed : authorMatchesPkg,
    detail : authorMatchesPkg
      ? `Package authored by ${targetDid}`
      : `Package author ${pkgRec.author} does not match expected ${targetDid}`,
  });

  // -------------------------------------------------------------------------
  // 3. Version record exists and is authored by the publisher
  // -------------------------------------------------------------------------
  const { records: verRecords } = await ctx.registry.records.query('package/version' as any, {
    from,
    filter: {
      contextId : pkgRec.contextId,
      tags      : { semver },
    },
  });

  if (verRecords.length === 0) {
    checks.push({ check: 'version-exists', passed: false, detail: `Version ${semver} not found` });
    return { passed: false, publisherDid: targetDid, packageName: name, version: semver, checks, attestations: [] };
  }

  const verRec = verRecords[0];
  checks.push({ check: 'version-exists', passed: true, detail: `Version ${semver} found` });

  const authorMatchesVer = verRec.author === targetDid || verRec.creator === targetDid;
  checks.push({
    check  : 'version-author',
    passed : authorMatchesVer,
    detail : authorMatchesVer
      ? `Version authored by ${targetDid}`
      : `Version author ${verRec.author} does not match expected ${targetDid}`,
  });

  // -------------------------------------------------------------------------
  // 4. Tarball exists and is non-empty
  // -------------------------------------------------------------------------
  const { records: tarRecords } = await ctx.registry.records.query('package/version/tarball' as any, {
    from,
    filter: { contextId: verRec.contextId },
  });

  if (tarRecords.length === 0) {
    checks.push({ check: 'tarball-exists', passed: false, detail: 'No tarball found' });
  } else {
    const tarRec = tarRecords[0];
    const size = tarRec.dataSize ?? 0;
    const hasData = size > 0;
    checks.push({
      check  : 'tarball-exists',
      passed : hasData,
      detail : hasData ? `Tarball present (${size} bytes)` : 'Tarball is empty',
    });
  }

  // -------------------------------------------------------------------------
  // 5. Attestations
  // -------------------------------------------------------------------------
  const attestations = await fetchAttestations(ctx, targetDid, verRec.contextId ?? '');

  if (attestations.length > 0) {
    checks.push({
      check  : 'has-attestations',
      passed : true,
      detail : `${attestations.length} attestation(s) found`,
    });
  } else {
    checks.push({
      check  : 'has-attestations',
      passed : true, // Informational — not required
      detail : 'No attestations (none required)',
    });
  }

  // -------------------------------------------------------------------------
  // 6. Trusted attestor check (only if trustedAttestors provided)
  // -------------------------------------------------------------------------
  if (trustedAttestors.length > 0) {
    const trustedFound = attestations.filter(
      (a) => trustedAttestors.includes(a.attestorDid),
    );

    checks.push({
      check  : 'trusted-attestor',
      passed : trustedFound.length > 0,
      detail : trustedFound.length > 0
        ? `${trustedFound.length} trusted attestation(s): ${trustedFound.map((a) => a.claim).join(', ')}`
        : `No attestations from trusted attestors: ${trustedAttestors.join(', ')}`,
    });
  }

  // -------------------------------------------------------------------------
  // Overall result
  // -------------------------------------------------------------------------
  const passed = checks.every((c) => c.passed);

  return { passed, publisherDid: targetDid, packageName: name, version: semver, checks, attestations };
}
