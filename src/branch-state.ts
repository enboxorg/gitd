/**
 * Branch state helpers for DWN-backed git refs.
 *
 * These helpers are intentionally pure. The local gitd helper can use them to
 * validate branch ownership before writing DWN records and to reduce sibling
 * `repo/branch/state` records into the current branch target.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { BranchData, BranchStateData } from './refs.js';

/** Default refs that only maintainers should control. */
export const DEFAULT_PROTECTED_BRANCH_REFS = ['refs/heads/main', 'refs/heads/master'] as const;

/** Hash a DID into the short branch namespace used for contributor refs. */
export function branchOwnerHash(did: string): string {
  return createHash('sha256').update(did).digest('hex').slice(0, 16);
}

/** Return the required ref prefix for a contributor-owned branch. */
export function contributorBranchPrefix(did: string): string {
  return `refs/heads/users/${branchOwnerHash(did)}/`;
}

/** Return true when `refName` is inside the DID-owned contributor namespace. */
export function isContributorBranchRef(refName: string, ownerDid: string): boolean {
  const suffix = refName.slice(contributorBranchPrefix(ownerDid).length);
  return refName.startsWith(contributorBranchPrefix(ownerDid)) && suffix.length > 0 && !suffix.includes('..');
}

/** Return true when a ref is protected by exact name or a trailing `*` prefix pattern. */
export function isProtectedBranchRef(
  refName: string,
  protectedRefs: readonly string[] = DEFAULT_PROTECTED_BRANCH_REFS,
): boolean {
  return protectedRefs.some((pattern) => {
    if (pattern.endsWith('*')) {
      return refName.startsWith(pattern.slice(0, -1));
    }
    return refName === pattern;
  });
}

export type BranchRecordValidation =
  | { ok: true }
  | { ok: false; reason: string };

export type BranchRecordValidationOptions = {
  /** Repo owner DID, used to ensure protected branches belong to the canonical repo owner. */
  repoOwnerDid?: string;
  /** Exact refs or trailing-* prefix patterns that only maintainers can control. */
  protectedRefs?: readonly string[];
};

/** Repo-level role relevant to branch checkpoint compaction. */
export type BranchSquashRole = 'owner' | 'maintainer' | 'contributor' | 'moderator' | 'none';

/** Validate branch metadata against repo-level ownership rules. */
export function validateBranchRecord(
  branch: BranchData,
  options: BranchRecordValidationOptions = {},
): BranchRecordValidation {
  if (!branch.refName.startsWith('refs/heads/')) {
    return { ok: false, reason: 'branch refName must start with refs/heads/' };
  }
  if (!branch.ownerDid) {
    return { ok: false, reason: 'branch ownerDid is required' };
  }

  const protectedRefs = options.protectedRefs ?? DEFAULT_PROTECTED_BRANCH_REFS;
  const protectedBranch = isProtectedBranchRef(branch.refName, protectedRefs);

  if (branch.kind === 'protected') {
    if (!protectedBranch) {
      return { ok: false, reason: 'protected branch kind requires a protected refName' };
    }
    if (options.repoOwnerDid && branch.ownerDid !== options.repoOwnerDid) {
      return { ok: false, reason: 'protected branch ownerDid must match the repo owner DID' };
    }
    return { ok: true };
  }

  if (protectedBranch) {
    return { ok: false, reason: 'only protected branch records may use protected refNames' };
  }

  if (branch.kind === 'contributor') {
    if (!isContributorBranchRef(branch.refName, branch.ownerDid)) {
      return { ok: false, reason: 'contributor branch refName must be under the owner DID namespace' };
    }
    return { ok: true };
  }

  if (branch.kind === 'shared') {
    if (branch.refName.startsWith('refs/heads/users/')) {
      return { ok: false, reason: 'shared branch refName must not be under a contributor namespace' };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown branch kind: ${(branch as { kind?: string }).kind ?? '<missing>'}` };
}

/** Build branch metadata for a ref using the repo owner as protected/shared owner. */
export function branchDataForRef(refName: string, ownerDid: string, createdAt = new Date().toISOString()): BranchData {
  let kind: BranchData['kind'] = 'shared';
  if (isProtectedBranchRef(refName)) {
    kind = 'protected';
  } else if (isContributorBranchRef(refName, ownerDid)) {
    kind = 'contributor';
  }

  return {
    refName,
    ownerDid,
    kind,
    createdAt,
  };
}

/** Return true when an actor may compact branch state/bundles with DWN `$squash`. */
export function canSquashBranch(
  actorDid: string,
  role: BranchSquashRole,
  branch: BranchData,
): boolean {
  if (role === 'owner' || role === 'maintainer') {
    return branch.kind === 'protected' || branch.kind === 'shared' || branch.ownerDid === actorDid;
  }

  if (role !== 'contributor') {
    return false;
  }

  return branch.kind === 'contributor'
    && branch.ownerDid === actorDid
    && isContributorBranchRef(branch.refName, actorDid);
}

/** A DWN branch state record reduced by the local helper. */
export type BranchStateRecord = {
  recordId: string;
  data: BranchStateData;
  authorDid?: string;
  dateCreated?: string;
};

export type AcceptedBranchStateRecord = {
  record: BranchStateRecord;
  target: string | null;
};

export type RejectedBranchStateRecord = {
  record: BranchStateRecord;
  reason: string;
};

export type BranchStateReduction = {
  refName: string;
  target: string | null;
  accepted: AcceptedBranchStateRecord[];
  rejected: RejectedBranchStateRecord[];
  compactedRecordIds: string[];
};

export type ReduceBranchStateOptions = {
  /** Initial target when there is no checkpoint. Defaults to null. */
  initialTarget?: string | null;
};

/** Reduce branch state records into the current target, honoring the latest checkpoint. */
export function reduceBranchState(
  refName: string,
  records: readonly BranchStateRecord[],
  options: ReduceBranchStateOptions = {},
): BranchStateReduction {
  const ordered = [...records]
    .filter((record) => record.data.refName === refName)
    .sort(compareBranchStateRecords);

  let checkpointIndex = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].data.kind === 'checkpoint') {
      checkpointIndex = i;
      break;
    }
  }

  const compactedRecordIds = checkpointIndex > 0
    ? ordered.slice(0, checkpointIndex).map((record) => record.recordId)
    : [];

  const accepted: AcceptedBranchStateRecord[] = [];
  const rejected: RejectedBranchStateRecord[] = [];

  let target = options.initialTarget ?? null;
  let startIndex = 0;

  if (checkpointIndex >= 0) {
    const checkpoint = ordered[checkpointIndex];
    if (checkpoint.data.kind === 'checkpoint') {
      target = checkpoint.data.target;
      accepted.push({ record: checkpoint, target });
    }
    startIndex = checkpointIndex + 1;
  }

  for (const record of ordered.slice(startIndex)) {
    const data = record.data;
    if (data.kind === 'checkpoint') {
      target = data.target;
      accepted.push({ record, target });
      continue;
    }

    const expectedOldTarget = data.oldTarget ?? null;
    if (expectedOldTarget !== target) {
      rejected.push({
        record,
        reason: `stale ref update: expected oldTarget ${formatTarget(target)}, got ${formatTarget(expectedOldTarget)}`,
      });
      continue;
    }

    target = data.newTarget;
    accepted.push({ record, target });
  }

  return { refName, target, accepted, rejected, compactedRecordIds };
}

function compareBranchStateRecords(a: BranchStateRecord, b: BranchStateRecord): number {
  const byTime = branchStateTimestamp(a).localeCompare(branchStateTimestamp(b));
  if (byTime !== 0) {
    return byTime;
  }
  return a.recordId.localeCompare(b.recordId);
}

function branchStateTimestamp(record: BranchStateRecord): string {
  return record.data.createdAt || record.dateCreated || '';
}

function formatTarget(target: string | null): string {
  return target ?? '<null>';
}
