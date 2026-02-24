/**
 * Package resolver module — DID-scoped package resolution, verification,
 * and dependency trust chain validation.
 *
 * @module
 */

export {
  fetchTarball,
  listVersions,
  parseSpecifier,
  resolveFullPackage,
  resolvePackage,
  resolveVersion,
} from './resolve.js';

export type {
  ResolvedPackage,
  ResolvedVersion,
  ResolutionResult,
} from './resolve.js';

export {
  fetchAttestations,
  verifyPackageVersion,
} from './verify.js';

export type {
  AttestationRecord,
  VerificationCheck,
  VerificationResult,
} from './verify.js';

export {
  buildTrustChain,
  formatTrustChain,
} from './trust-chain.js';

export type {
  TrustChainNode,
  TrustChainResult,
} from './trust-chain.js';
