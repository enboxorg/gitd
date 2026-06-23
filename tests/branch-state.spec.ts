import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import type { BranchData } from '../src/refs.js';
import type { BranchStateRecord } from '../src/branch-state.js';

import {
  branchDataForRef,
  branchOwnerHash,
  canSquashBranch,
  contributorBranchPrefix,
  isContributorBranchRef,
  reduceBranchState,
  validateBranchRecord,
} from '../src/branch-state.js';

describe('branch state helpers', () => {
  const aliceDid = 'did:dht:alice';
  const bobDid = 'did:dht:bob';

  it('derives contributor branch namespaces from the owner DID', () => {
    const expectedHash = createHash('sha256').update(aliceDid).digest('hex').slice(0, 16);
    expect(branchOwnerHash(aliceDid)).toBe(expectedHash);
    expect(contributorBranchPrefix(aliceDid)).toBe(`refs/heads/users/${expectedHash}/`);
    expect(isContributorBranchRef(`${contributorBranchPrefix(aliceDid)}feature`, aliceDid)).toBe(true);
    expect(isContributorBranchRef('refs/heads/main', aliceDid)).toBe(false);
    expect(isContributorBranchRef(`${contributorBranchPrefix(aliceDid)}feature`, bobDid)).toBe(false);
  });

  it('validates contributor branches against the owner namespace', () => {
    const valid: BranchData = {
      refName  : `${contributorBranchPrefix(aliceDid)}feature`,
      ownerDid : aliceDid,
      kind     : 'contributor',
    };
    const invalid: BranchData = {
      refName  : 'refs/heads/feature',
      ownerDid : aliceDid,
      kind     : 'contributor',
    };

    expect(validateBranchRecord(valid).ok).toBe(true);
    expect(validateBranchRecord(invalid)).toEqual({
      ok     : false,
      reason : 'contributor branch refName must be under the owner DID namespace',
    });
  });

  it('classifies branch records from refs', () => {
    expect(branchDataForRef('refs/heads/main', aliceDid, '2026-01-01T00:00:00.000Z')).toEqual({
      refName   : 'refs/heads/main',
      ownerDid  : aliceDid,
      kind      : 'protected',
      createdAt : '2026-01-01T00:00:00.000Z',
    });
    expect(branchDataForRef(`${contributorBranchPrefix(aliceDid)}topic`, aliceDid).kind).toBe('contributor');
    expect(branchDataForRef('refs/heads/feature', aliceDid).kind).toBe('shared');
  });

  it('keeps protected branches under repo-owner control', () => {
    expect(validateBranchRecord({
      refName  : 'refs/heads/main',
      ownerDid : aliceDid,
      kind     : 'protected',
    }, { repoOwnerDid: aliceDid }).ok).toBe(true);

    expect(validateBranchRecord({
      refName  : 'refs/heads/main',
      ownerDid : bobDid,
      kind     : 'protected',
    }, { repoOwnerDid: aliceDid })).toEqual({
      ok     : false,
      reason : 'protected branch ownerDid must match the repo owner DID',
    });

    expect(validateBranchRecord({
      refName  : 'refs/heads/main',
      ownerDid : aliceDid,
      kind     : 'contributor',
    }).ok).toBe(false);
  });

  it('allows contributors to squash only their own branch namespace', () => {
    const bobBranch: BranchData = {
      refName  : `${contributorBranchPrefix(bobDid)}feature`,
      ownerDid : bobDid,
      kind     : 'contributor',
    };
    const aliceBranch: BranchData = {
      refName  : `${contributorBranchPrefix(aliceDid)}feature`,
      ownerDid : aliceDid,
      kind     : 'contributor',
    };

    expect(canSquashBranch(bobDid, 'contributor', bobBranch)).toBe(true);
    expect(canSquashBranch(aliceDid, 'contributor', bobBranch)).toBe(false);
    expect(canSquashBranch(bobDid, 'contributor', aliceBranch)).toBe(false);
    expect(canSquashBranch(bobDid, 'moderator', bobBranch)).toBe(false);
  });

  it('reserves protected/shared branch squash for maintainers and owners', () => {
    const protectedBranch: BranchData = {
      refName  : 'refs/heads/main',
      ownerDid : aliceDid,
      kind     : 'protected',
    };
    const sharedBranch: BranchData = {
      refName  : 'refs/heads/release',
      ownerDid : aliceDid,
      kind     : 'shared',
    };

    expect(canSquashBranch(aliceDid, 'owner', protectedBranch)).toBe(true);
    expect(canSquashBranch(bobDid, 'maintainer', protectedBranch)).toBe(true);
    expect(canSquashBranch(bobDid, 'contributor', protectedBranch)).toBe(false);
    expect(canSquashBranch(bobDid, 'moderator', protectedBranch)).toBe(false);
    expect(canSquashBranch(bobDid, 'maintainer', sharedBranch)).toBe(true);
    expect(canSquashBranch(bobDid, 'contributor', sharedBranch)).toBe(false);
  });

  it('reduces sequential branch updates into the final target', () => {
    const refName = `${contributorBranchPrefix(aliceDid)}feature`;
    const records: BranchStateRecord[] = [
      update('r1', refName, null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'),
      update('r2', refName, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-01-01T00:01:00.000Z'),
    ];

    const result = reduceBranchState(refName, records);
    expect(result.target).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(result.accepted.map((entry) => entry.record.recordId)).toEqual(['r1', 'r2']);
    expect(result.rejected).toEqual([]);
  });

  it('rejects stale racing updates with the same old target', () => {
    const refName = `${contributorBranchPrefix(aliceDid)}feature`;
    const records: BranchStateRecord[] = [
      update('r1', refName, null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'),
      update('r2', refName, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-01-01T00:01:00.000Z'),
      update('r3', refName, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cccccccccccccccccccccccccccccccccccccccc', '2026-01-01T00:02:00.000Z'),
    ];

    const result = reduceBranchState(refName, records);
    expect(result.target).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(result.accepted.map((entry) => entry.record.recordId)).toEqual(['r1', 'r2']);
    expect(result.rejected.map((entry) => entry.record.recordId)).toEqual(['r3']);
    expect(result.rejected[0].reason).toContain('stale ref update');
  });

  it('uses the latest checkpoint as the authoritative base', () => {
    const refName = 'refs/heads/main';
    const records: BranchStateRecord[] = [
      update('old', refName, null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'),
      checkpoint('cp', refName, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-01-01T00:01:00.000Z'),
      update('next', refName, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccccccccccc', '2026-01-01T00:02:00.000Z'),
    ];

    const result = reduceBranchState(refName, records);
    expect(result.target).toBe('cccccccccccccccccccccccccccccccccccccccc');
    expect(result.accepted.map((entry) => entry.record.recordId)).toEqual(['cp', 'next']);
    expect(result.compactedRecordIds).toEqual(['old']);
  });
});

function update(
  recordId: string,
  refName: string,
  oldTarget: string | null,
  newTarget: string | null,
  createdAt: string,
): BranchStateRecord {
  return {
    recordId,
    data: {
      kind     : 'refUpdate',
      refName,
      oldTarget,
      newTarget,
      actorDid : 'did:dht:alice',
      createdAt,
    },
  };
}

function checkpoint(recordId: string, refName: string, target: string | null, createdAt: string): BranchStateRecord {
  return {
    recordId,
    data: {
      kind       : 'checkpoint',
      refName,
      target,
      actorDid   : 'did:dht:alice',
      acceptedAt : createdAt,
      createdAt,
    },
  };
}
