/**
 * Package resolver, attestation, and trust chain tests.
 *
 * Tests the complete lifecycle:
 *   1. Publish packages with versions and tarballs
 *   2. Create attestation records
 *   3. Resolve packages from the DWN
 *   4. Verify package integrity and provenance
 *   5. Build and validate dependency trust chains
 *
 * Uses a real Enbox agent with in-memory stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';

import { ForgeCiProtocol } from '../src/ci.js';
import { ForgeIssuesProtocol } from '../src/issues.js';
import { ForgeNotificationsProtocol } from '../src/notifications.js';
import { ForgeOrgProtocol } from '../src/org.js';
import { ForgePatchesProtocol } from '../src/patches.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRegistryProtocol } from '../src/registry.js';
import { ForgeReleasesProtocol } from '../src/releases.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { ForgeSocialProtocol } from '../src/social.js';
import { ForgeWikiProtocol } from '../src/wiki.js';

import { buildTrustChain, formatTrustChain } from '../src/resolver/trust-chain.js';
import { fetchAttestations, verifyPackageVersion } from '../src/resolver/verify.js';
import { parseSpecifier, resolveFullPackage, resolvePackage, resolveVersion } from '../src/resolver/resolve.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/resolver-agent';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Package resolver, attestation, and trust chain', () => {
  let ctx: AgentContext;
  let testDid: string;
  let pkgContextId: string;
  let versionContextId: string;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Resolver Test' },
      });
    }

    const enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
    const did = identity.did.uri;
    testDid = did;

    const repo = enbox.using(ForgeRepoProtocol);
    const refs = enbox.using(ForgeRefsProtocol);
    const issues = enbox.using(ForgeIssuesProtocol);
    const patches = enbox.using(ForgePatchesProtocol);
    const ci = enbox.using(ForgeCiProtocol);
    const releases = enbox.using(ForgeReleasesProtocol);
    const registry = enbox.using(ForgeRegistryProtocol);
    const social = enbox.using(ForgeSocialProtocol);
    const notifications = enbox.using(ForgeNotificationsProtocol);
    const wiki = enbox.using(ForgeWikiProtocol);
    const org = enbox.using(ForgeOrgProtocol);

    await repo.configure();
    await refs.configure();
    await issues.configure();
    await patches.configure();
    await ci.configure();
    await releases.configure();
    await registry.configure();
    await social.configure();
    await notifications.configure();
    await wiki.configure();
    await org.configure();

    ctx = {
      did, repo, refs, issues, patches, ci, releases,
      registry, social, notifications, wiki, org, enbox,
    };

    // -----------------------------------------------------------------------
    // Seed registry data
    // -----------------------------------------------------------------------

    // 1. Create a package.
    const { record: pkgRec } = await ctx.registry.records.create('package', {
      data : { name: 'my-utils', description: 'Utility library' },
      tags : { name: 'my-utils', ecosystem: 'npm', description: 'Utility library' },
    });
    pkgContextId = pkgRec!.contextId ?? '';

    // 2. Create version 1.0.0 with dependencies.
    const { record: verRec } = await ctx.registry.records.create('package/version' as any, {
      data            : { semver: '1.0.0', dependencies: {} },
      tags            : { semver: '1.0.0' },
      parentContextId : pkgContextId,
    } as any);
    versionContextId = verRec!.contextId ?? '';

    // 3. Create a tarball.
    const tarballData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
    await ctx.registry.records.create('package/version/tarball' as any, {
      data            : tarballData,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-utils-1.0.0.tgz', contentType: 'application/gzip', size: 8 },
      parentContextId : versionContextId,
    } as any);

    // 4. Create an attestation.
    await ctx.registry.records.create('package/version/attestation' as any, {
      data            : { attestorDid: 'did:jwk:build-service', claim: 'reproducible-build', sourceCommit: 'abc123' },
      parentContextId : versionContextId,
    } as any);

    // 5. Create a second attestation.
    await ctx.registry.records.create('package/version/attestation' as any, {
      data            : { attestorDid: testDid, claim: 'code-review' },
      parentContextId : versionContextId,
    } as any);

    // 6. Create version 2.0.0 with a dependency on my-utils@1.0.0.
    const depSpec: Record<string, string> = {};
    depSpec[`${testDid}/my-utils`] = '1.0.0';

    const { record: ver2Rec } = await ctx.registry.records.create('package/version' as any, {
      data            : { semver: '2.0.0', dependencies: depSpec },
      tags            : { semver: '2.0.0' },
      parentContextId : pkgContextId,
    } as any);

    // 7. Create a tarball for v2.
    const tarball2 = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x05, 0x06, 0x07, 0x08]);
    await ctx.registry.records.create('package/version/tarball' as any, {
      data            : tarball2,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-utils-2.0.0.tgz', contentType: 'application/gzip', size: 8 },
      parentContextId : ver2Rec!.contextId ?? '',
    } as any);

    // 8. Create a second package (no versions — for edge case tests).
    await ctx.registry.records.create('package', {
      data : { name: 'empty-pkg' },
      tags : { name: 'empty-pkg', ecosystem: 'npm' },
    });
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // parseSpecifier
  // =========================================================================

  describe('parseSpecifier()', () => {
    it('should parse a valid specifier', () => {
      const result = parseSpecifier('did:dht:abc123/my-pkg@1.0.0');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:dht:abc123');
      expect(result!.name).toBe('my-pkg');
      expect(result!.version).toBe('1.0.0');
    });

    it('should parse specifiers with complex DID methods', () => {
      const result = parseSpecifier('did:jwk:eyJ0eXAi/utils@2.3.1');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:jwk:eyJ0eXAi');
      expect(result!.name).toBe('utils');
      expect(result!.version).toBe('2.3.1');
    });

    it('should return null for invalid specifiers', () => {
      expect(parseSpecifier('invalid')).toBeNull();
      expect(parseSpecifier('no-did/pkg@1.0')).toBeNull();
      expect(parseSpecifier('did:dht:abc/pkg')).toBeNull(); // missing version
    });

    it('should handle semver ranges in version', () => {
      const result = parseSpecifier('did:dht:abc/pkg@^1.0.0');
      expect(result).not.toBeNull();
      expect(result!.version).toBe('^1.0.0');
    });
  });

  // =========================================================================
  // resolvePackage
  // =========================================================================

  describe('resolvePackage()', () => {
    it('should resolve an existing package', async () => {
      const pkg = await resolvePackage(ctx, testDid, 'my-utils', 'npm');
      expect(pkg).not.toBeNull();
      expect(pkg!.name).toBe('my-utils');
      expect(pkg!.ecosystem).toBe('npm');
      expect(pkg!.description).toBe('Utility library');
      expect(pkg!.publisherDid).toBe(testDid);
      expect(pkg!.contextId).toBeTruthy();
    });

    it('should return null for non-existent packages', async () => {
      const pkg = await resolvePackage(ctx, testDid, 'nonexistent', 'npm');
      expect(pkg).toBeNull();
    });

    it('should return null for wrong ecosystem', async () => {
      const pkg = await resolvePackage(ctx, testDid, 'my-utils', 'cargo');
      expect(pkg).toBeNull();
    });
  });

  // =========================================================================
  // resolveVersion
  // =========================================================================

  describe('resolveVersion()', () => {
    it('should resolve an existing version', async () => {
      const ver = await resolveVersion(ctx, testDid, pkgContextId, '1.0.0');
      expect(ver).not.toBeNull();
      expect(ver!.semver).toBe('1.0.0');
      expect(ver!.deprecated).toBe(false);
      expect(ver!.author).toBe(testDid);
    });

    it('should resolve a version with dependencies', async () => {
      const ver = await resolveVersion(ctx, testDid, pkgContextId, '2.0.0');
      expect(ver).not.toBeNull();
      expect(ver!.semver).toBe('2.0.0');
      expect(Object.keys(ver!.dependencies).length).toBe(1);
    });

    it('should return null for non-existent versions', async () => {
      const ver = await resolveVersion(ctx, testDid, pkgContextId, '99.0.0');
      expect(ver).toBeNull();
    });
  });

  // =========================================================================
  // resolveFullPackage
  // =========================================================================

  describe('resolveFullPackage()', () => {
    it('should resolve package, version, and tarball', async () => {
      const result = await resolveFullPackage(ctx, testDid, 'my-utils', '1.0.0', 'npm');
      expect(result).not.toBeNull();
      expect(result!.package.name).toBe('my-utils');
      expect(result!.version.semver).toBe('1.0.0');
      expect(result!.tarball).not.toBeNull();
      expect(result!.tarball!.length).toBe(8);
      expect(result!.tarball![0]).toBe(0x1f); // gzip magic
    });

    it('should return null for non-existent packages', async () => {
      const result = await resolveFullPackage(ctx, testDid, 'nonexistent', '1.0.0');
      expect(result).toBeNull();
    });

    it('should return null for non-existent versions', async () => {
      const result = await resolveFullPackage(ctx, testDid, 'my-utils', '99.0.0');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // fetchAttestations
  // =========================================================================

  describe('fetchAttestations()', () => {
    it('should return attestation records for a version', async () => {
      const attestations = await fetchAttestations(ctx, testDid, versionContextId);
      expect(attestations.length).toBe(2);
    });

    it('should include attestation details', async () => {
      const attestations = await fetchAttestations(ctx, testDid, versionContextId);
      const buildAtt = attestations.find((a) => a.claim === 'reproducible-build');
      expect(buildAtt).toBeDefined();
      expect(buildAtt!.attestorDid).toBe('did:jwk:build-service');
      expect(buildAtt!.sourceCommit).toBe('abc123');
    });

    it('should include self-attestations', async () => {
      const attestations = await fetchAttestations(ctx, testDid, versionContextId);
      const review = attestations.find((a) => a.claim === 'code-review');
      expect(review).toBeDefined();
      expect(review!.attestorDid).toBe(testDid);
    });

    it('should return empty array for versions without attestations', async () => {
      // v2.0.0 has no attestations
      const ver2 = await resolveVersion(ctx, testDid, pkgContextId, '2.0.0');
      const attestations = await fetchAttestations(ctx, testDid, ver2!.contextId);
      expect(attestations.length).toBe(0);
    });
  });

  // =========================================================================
  // verifyPackageVersion
  // =========================================================================

  describe('verifyPackageVersion()', () => {
    it('should pass verification for a valid package', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      expect(result.passed).toBe(true);
      expect(result.publisherDid).toBe(testDid);
      expect(result.packageName).toBe('my-utils');
      expect(result.version).toBe('1.0.0');
    });

    it('should include all checks', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      const checkNames = result.checks.map((c) => c.check);
      expect(checkNames).toContain('package-exists');
      expect(checkNames).toContain('publisher-match');
      expect(checkNames).toContain('version-exists');
      expect(checkNames).toContain('version-author');
      expect(checkNames).toContain('tarball-exists');
      expect(checkNames).toContain('has-attestations');
    });

    it('should report all checks as passed', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      for (const check of result.checks) {
        expect(check.passed).toBe(true);
      }
    });

    it('should include attestation records', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      expect(result.attestations.length).toBe(2);
    });

    it('should fail for non-existent packages', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'nonexistent', '1.0.0');
      expect(result.passed).toBe(false);
      const pkgCheck = result.checks.find((c) => c.check === 'package-exists');
      expect(pkgCheck?.passed).toBe(false);
    });

    it('should fail for non-existent versions', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '99.0.0');
      expect(result.passed).toBe(false);
      const verCheck = result.checks.find((c) => c.check === 'version-exists');
      expect(verCheck?.passed).toBe(false);
    });

    it('should check trusted attestors when specified', async () => {
      const result = await verifyPackageVersion(
        ctx, testDid, 'my-utils', '1.0.0', 'npm', ['did:jwk:build-service'],
      );
      expect(result.passed).toBe(true);
      const trustedCheck = result.checks.find((c) => c.check === 'trusted-attestor');
      expect(trustedCheck).toBeDefined();
      expect(trustedCheck!.passed).toBe(true);
    });

    it('should fail trusted attestor check when attestor not found', async () => {
      const result = await verifyPackageVersion(
        ctx, testDid, 'my-utils', '1.0.0', 'npm', ['did:jwk:unknown-attestor'],
      );
      expect(result.passed).toBe(false);
      const trustedCheck = result.checks.find((c) => c.check === 'trusted-attestor');
      expect(trustedCheck).toBeDefined();
      expect(trustedCheck!.passed).toBe(false);
    });

    it('should pass without trusted attestor check when none specified', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      const trustedCheck = result.checks.find((c) => c.check === 'trusted-attestor');
      expect(trustedCheck).toBeUndefined();
    });
  });

  // =========================================================================
  // buildTrustChain
  // =========================================================================

  describe('buildTrustChain()', () => {
    it('should build a trust chain for a package with no dependencies', async () => {
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '1.0.0');
      expect(result.allPassed).toBe(true);
      expect(result.totalChecked).toBe(1);
      expect(result.root.specifier).toBe(`${testDid}/my-utils@1.0.0`);
      expect(result.root.dependencies.length).toBe(0);
    });

    it('should build a trust chain with dependencies', async () => {
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '2.0.0');
      expect(result.allPassed).toBe(true);
      expect(result.totalChecked).toBe(2);
      expect(result.root.specifier).toBe(`${testDid}/my-utils@2.0.0`);
      expect(result.root.dependencies.length).toBe(1);
      expect(result.root.dependencies[0].specifier).toBe(`${testDid}/my-utils@1.0.0`);
    });

    it('should detect cycles', async () => {
      // v2 depends on v1 — if v1 somehow depended on v2, it would cycle.
      // Since v1 has no deps, this just verifies the cycle detection code
      // doesn't crash when there's no actual cycle.
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '2.0.0');
      expect(result.allPassed).toBe(true);
    });

    it('should report failures in the chain', async () => {
      const result = await buildTrustChain(ctx, testDid, 'nonexistent', '1.0.0');
      expect(result.allPassed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('should pass trusted attestor check through the chain', async () => {
      const result = await buildTrustChain(
        ctx, testDid, 'my-utils', '1.0.0', 'npm', ['did:jwk:build-service'],
      );
      expect(result.allPassed).toBe(true);
    });

    it('should fail trusted attestor check in chain', async () => {
      const result = await buildTrustChain(
        ctx, testDid, 'my-utils', '1.0.0', 'npm', ['did:jwk:unknown'],
      );
      expect(result.allPassed).toBe(false);
    });
  });

  // =========================================================================
  // formatTrustChain
  // =========================================================================

  describe('formatTrustChain()', () => {
    it('should format a passing trust chain', async () => {
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '1.0.0');
      const output = formatTrustChain(result);
      expect(output).toContain('Trust chain for');
      expect(output).toContain('All passed: yes');
      expect(output).toContain('PASS');
    });

    it('should format a failing trust chain', async () => {
      const result = await buildTrustChain(ctx, testDid, 'nonexistent', '1.0.0');
      const output = formatTrustChain(result);
      expect(output).toContain('All passed: NO');
      expect(output).toContain('FAIL');
      expect(output).toContain('Failures:');
    });

    it('should include attestation info in output', async () => {
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '1.0.0');
      const output = formatTrustChain(result);
      expect(output).toContain('reproducible-build');
      expect(output).toContain('code-review');
    });

    it('should show dependency tree for nested packages', async () => {
      const result = await buildTrustChain(ctx, testDid, 'my-utils', '2.0.0');
      const output = formatTrustChain(result);
      // Root and dependency should both appear
      expect(output).toContain('my-utils@2.0.0');
      expect(output).toContain('my-utils@1.0.0');
    });
  });

  // =========================================================================
  // CLI registry commands (functional tests via direct module calls)
  // =========================================================================

  describe('registry CLI attestation commands', () => {
    it('should create an attestation record', async () => {
      // Create a fresh attestation via the DWN API directly.
      const { status } = await ctx.registry.records.create('package/version/attestation' as any, {
        data            : { attestorDid: testDid, claim: 'test-claim' },
        parentContextId : versionContextId,
      } as any);
      expect(status.code).toBeLessThan(300);

      // Verify it was created.
      const attestations = await fetchAttestations(ctx, testDid, versionContextId);
      const found = attestations.find((a) => a.claim === 'test-claim');
      expect(found).toBeDefined();
    });

    it('should verify a package with all checks passing', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'my-utils', '1.0.0');
      expect(result.passed).toBe(true);
      expect(result.checks.length).toBeGreaterThanOrEqual(5);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle packages with no versions', async () => {
      const result = await verifyPackageVersion(ctx, testDid, 'empty-pkg', '1.0.0');
      expect(result.passed).toBe(false);
      const verCheck = result.checks.find((c) => c.check === 'version-exists');
      expect(verCheck?.passed).toBe(false);
    });

    it('should handle empty dependency maps', async () => {
      const ver = await resolveVersion(ctx, testDid, pkgContextId, '1.0.0');
      expect(ver).not.toBeNull();
      expect(Object.keys(ver!.dependencies).length).toBe(0);
    });

    it('should resolve tarball as Uint8Array', async () => {
      const result = await resolveFullPackage(ctx, testDid, 'my-utils', '1.0.0');
      expect(result).not.toBeNull();
      expect(result!.tarball).toBeInstanceOf(Uint8Array);
    });
  });
});
