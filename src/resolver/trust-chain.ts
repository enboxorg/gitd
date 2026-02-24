/**
 * Dependency trust chain — recursive verification of a package's
 * dependency tree.
 *
 * Given a root package specifier like `did:dht:abc/utils@1.0.0`, the
 * trust chain validator:
 *
 *   1. Resolves the package from the publisher's DWN
 *   2. Verifies the package version (author, tarball, attestations)
 *   3. Reads the version's `dependencies` field
 *   4. Recursively resolves and verifies each dependency
 *   5. Returns a tree of verification results
 *
 * The entire chain is verifiable without any central authority — each
 * DID resolution, signature verification, and attestation check uses
 * decentralized infrastructure.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { VerificationResult } from './verify.js';

import { verifyPackageVersion } from './verify.js';

import { parseSpecifier, resolvePackage, resolveVersion } from './resolve.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single node in the dependency trust chain tree. */
export type TrustChainNode = {
  specifier : string;
  did : string;
  name : string;
  version : string;
  verification : VerificationResult;
  dependencies : TrustChainNode[];
};

/** Summary of the trust chain validation. */
export type TrustChainResult = {
  root : TrustChainNode;
  totalChecked : number;
  allPassed : boolean;
  failures : string[];
};

// ---------------------------------------------------------------------------
// Trust chain builder
// ---------------------------------------------------------------------------

/**
 * Build and verify a full dependency trust chain.
 *
 * @param ctx - Agent context
 * @param targetDid - Root package publisher DID
 * @param name - Root package name
 * @param semver - Root package version
 * @param ecosystem - Package ecosystem (default: 'npm')
 * @param trustedAttestors - DIDs of trusted build services
 * @param maxDepth - Maximum recursion depth (default: 10)
 */
export async function buildTrustChain(
  ctx: AgentContext,
  targetDid: string,
  name: string,
  semver: string,
  ecosystem: string = 'npm',
  trustedAttestors: string[] = [],
  maxDepth: number = 10,
): Promise<TrustChainResult> {
  const visited = new Set<string>();
  const failures: string[] = [];
  let totalChecked = 0;

  const root = await buildNode(
    ctx, targetDid, name, semver, ecosystem, trustedAttestors,
    maxDepth, 0, visited, failures,
  );

  totalChecked = visited.size;
  const allPassed = failures.length === 0;

  return { root, totalChecked, allPassed, failures };
}

/**
 * Recursively build a trust chain node.
 */
async function buildNode(
  ctx: AgentContext,
  targetDid: string,
  name: string,
  semver: string,
  ecosystem: string,
  trustedAttestors: string[],
  maxDepth: number,
  depth: number,
  visited: Set<string>,
  failures: string[],
): Promise<TrustChainNode> {
  const specifier = `${targetDid}/${name}@${semver}`;
  const node: TrustChainNode = {
    specifier,
    did          : targetDid,
    name,
    version      : semver,
    verification : {
      passed       : false,
      publisherDid : targetDid,
      packageName  : name,
      version      : semver,
      checks       : [],
      attestations : [],
    },
    dependencies: [],
  };

  // Cycle detection.
  if (visited.has(specifier)) {
    node.verification.passed = true;
    node.verification.checks = [{ check: 'cycle-skip', passed: true, detail: 'Already verified (cycle)' }];
    return node;
  }
  visited.add(specifier);

  // Depth guard.
  if (depth > maxDepth) {
    node.verification.checks = [{ check: 'max-depth', passed: true, detail: `Max depth ${maxDepth} reached` }];
    node.verification.passed = true;
    return node;
  }

  // Verify this package version.
  node.verification = await verifyPackageVersion(
    ctx, targetDid, name, semver, ecosystem, trustedAttestors,
  );

  if (!node.verification.passed) {
    failures.push(`${specifier}: ${node.verification.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`);
  }

  // Resolve dependencies.
  const pkg = await resolvePackage(ctx, targetDid, name, ecosystem);
  if (!pkg) { return node; }

  const version = await resolveVersion(ctx, targetDid, pkg.contextId, semver);
  if (!version || !version.dependencies) { return node; }

  const deps = version.dependencies;
  for (const [depSpec, depVersion] of Object.entries(deps)) {
    const parsed = parseSpecifier(`${depSpec}@${depVersion}`);
    if (!parsed) {
      // Dependency specifier is not a DID-scoped package — skip.
      continue;
    }

    const childNode = await buildNode(
      ctx, parsed.did, parsed.name, parsed.version, ecosystem,
      trustedAttestors, maxDepth, depth + 1, visited, failures,
    );

    node.dependencies.push(childNode);
  }

  return node;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a trust chain tree as an indented string for CLI output.
 */
export function formatTrustChain(result: TrustChainResult): string {
  const lines: string[] = [];

  lines.push(`Trust chain for ${result.root.specifier}`);
  lines.push(`  Total packages checked: ${result.totalChecked}`);
  lines.push(`  All passed: ${result.allPassed ? 'yes' : 'NO'}`);

  if (result.failures.length > 0) {
    lines.push('  Failures:');
    for (const f of result.failures) {
      lines.push(`    - ${f}`);
    }
  }

  lines.push('');
  formatNode(result.root, lines, 0);

  return lines.join('\n');
}

function formatNode(node: TrustChainNode, lines: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const status = node.verification.passed ? 'PASS' : 'FAIL';
  lines.push(`${indent}${status} ${node.specifier}`);

  for (const check of node.verification.checks) {
    const mark = check.passed ? '+' : 'x';
    lines.push(`${indent}  [${mark}] ${check.check}: ${check.detail}`);
  }

  if (node.verification.attestations.length > 0) {
    for (const att of node.verification.attestations) {
      lines.push(`${indent}  [a] ${att.claim} by ${att.attestorDid}`);
    }
  }

  for (const child of node.dependencies) {
    formatNode(child, lines, depth + 1);
  }
}
