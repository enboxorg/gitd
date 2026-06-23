/**
 * Tests for restoring a bare git repo from DWN bundle records.
 *
 * Tests the `restoreFromBundles` function end-to-end: creates an Enbox
 * agent, pushes commits, syncs bundles to DWN, then restores to a new
 * directory and verifies the repository content matches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { createTestIdentity } from './helpers/identity.js';
import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import { branchDataForRef, branchOwnerHash } from '../src/branch-state.js';
import { createBranchBundle, createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';

import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/bundle-restore-agent';
const REPOS_PATH = '__TESTDATA__/bundle-restore-repos';
const WORK_PATH = '__TESTDATA__/bundle-restore-work';
const RESTORE_PATH = '__TESTDATA__/bundle-restore-output';
const CONTRIBUTOR_DID = 'did:dht:restore-contributor';
const CONTRIBUTOR_REF = `refs/heads/users/${branchOwnerHash(CONTRIBUTOR_DID)}/feature`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('restoreFromBundles', () => {
  let repoPath: string;
  let repoContextId: string;
  let repoHandle: ReturnType<InstanceType<typeof Enbox>['using']>;
  let refsHandle: ReturnType<InstanceType<typeof Enbox>['using']>;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
    rmSync(RESTORE_PATH, { recursive: true, force: true });

    // Create agent + Enbox instance.
    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'restore-test' });
    await agent.start({ password: 'restore-test' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await createTestIdentity(agent, 'Restore Test');
    }

    const enbox = new Enbox({ agent, connectedDid: identity.did.uri });

    repoHandle = enbox.using(ForgeRepoProtocol);
    refsHandle = enbox.using(ForgeRefsProtocol);
    // Skip encryption: true — the test DID (did:jwk Ed25519) lacks X25519.
    await repoHandle.configure();
    await refsHandle.configure();

    // Create a repo record.
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'restore-test', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'restore-test', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // Set up bare repo with multiple commits.
    const backend = new GitBackend({ basePath: REPOS_PATH });
    repoPath = await backend.initRepo('did:dht:restoretest', 'restore-test');

    await exec(`git clone "${repoPath}" "${WORK_PATH}"`);
    await exec('git config user.email "test@test.com"', { cwd: WORK_PATH });
    await exec('git config user.name "Test"', { cwd: WORK_PATH });
    await exec('git checkout -b main', { cwd: WORK_PATH });
    await exec('echo "line 1" > file.txt', { cwd: WORK_PATH });
    await exec('git add file.txt', { cwd: WORK_PATH });
    await exec('git commit -m "first commit"', { cwd: WORK_PATH });
    await exec('git push -u origin main', { cwd: WORK_PATH });

    // Sync full bundle to DWN.
    const syncer = createBundleSyncer({
      repo          : repoHandle as any,
      repoContextId : repoContextId,
      visibility    : 'public',
    });
    await syncer('did:dht:restoretest', 'restore-test', repoPath);

    // Push a second commit and sync an incremental bundle.
    await exec('echo "line 2" >> file.txt', { cwd: WORK_PATH });
    await exec('git add file.txt', { cwd: WORK_PATH });
    await exec('git commit -m "second commit"', { cwd: WORK_PATH });
    await exec('git push origin main', { cwd: WORK_PATH });

    await syncer('did:dht:restoretest', 'restore-test', repoPath);

    // Create a contributor branch after repo-wide bundles have been synced.
    // Only a branch-scoped refs bundle is written for this branch, so restore
    // must replay repo/branch/bundle records to recover it from an empty cache.
    await exec('git checkout -b restore-contributor-feature main', { cwd: WORK_PATH });
    await exec('echo "contributor branch" > contributor.txt', { cwd: WORK_PATH });
    await exec('git add contributor.txt', { cwd: WORK_PATH });
    await exec('git commit -m "contributor branch commit"', { cwd: WORK_PATH });
    await exec(`git push origin HEAD:"${CONTRIBUTOR_REF}"`, { cwd: WORK_PATH });

    const branchData = branchDataForRef(CONTRIBUTOR_REF, CONTRIBUTOR_DID);
    const { record: branchRecord } = await (refsHandle as any).records.create('repo/branch', {
      data : branchData,
      tags : {
        refName  : branchData.refName,
        ownerDid : branchData.ownerDid,
        kind     : branchData.kind,
      },
      parentContextId: repoContextId,
    });

    const bundleInfo = await createBranchBundle(repoPath, CONTRIBUTOR_REF);
    try {
      const bundleBytes = new Uint8Array(readFileSync(bundleInfo.path));
      await (refsHandle as any).records.create('repo/branch/bundle', {
        data       : bundleBytes,
        dataFormat : 'application/x-git-bundle',
        tags       : {
          kind      : 'checkpoint',
          refName   : CONTRIBUTOR_REF,
          tipCommit : bundleInfo.tipCommit,
          size      : bundleInfo.size,
        },
        parentContextId : branchRecord.contextId,
        squash          : true,
      });
    } finally {
      rmSync(bundleInfo.path, { force: true });
    }
  }, 30000);

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
    rmSync(RESTORE_PATH, { recursive: true, force: true });
  });

  it('should restore a bare repo from DWN bundles', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored.git`;

    const result = await restoreFromBundles({
      repo          : repoHandle as any,
      repoPath      : restoredRepoPath,
      repoContextId : repoContextId,
    });

    expect(result.success).toBe(true);
    expect(result.bundlesApplied).toBeGreaterThanOrEqual(1);
    expect(result.tipCommit).toMatch(/^[0-9a-f]{40}$/);

    // Verify the restored repo is a valid bare git repo.
    expect(existsSync(`${restoredRepoPath}/HEAD`)).toBe(true);
  });

  it('should restore all commits including incrementals', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored-full.git`;

    const result = await restoreFromBundles({
      repo          : repoHandle as any,
      repoPath      : restoredRepoPath,
      repoContextId : repoContextId,
    });

    expect(result.success).toBe(true);
    // Should have applied full + incremental bundle = 2 bundles.
    expect(result.bundlesApplied).toBe(2);

    // Verify both commits are present.
    const { stdout } = await exec('git log --oneline main', { cwd: restoredRepoPath });
    expect(stdout).toContain('first commit');
    expect(stdout).toContain('second commit');
  });

  it('should restore file content matching the original repo', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored-content.git`;
    const clonePath = `${RESTORE_PATH}/restored-clone`;

    await restoreFromBundles({
      repo          : repoHandle as any,
      repoPath      : restoredRepoPath,
      repoContextId : repoContextId,
    });

    // Clone from the restored bare repo to verify content.
    // Explicit --branch is needed because restored bare repos may have
    // HEAD pointing to a non-existent default branch (master vs main).
    await exec(`git clone --branch main "${restoredRepoPath}" "${clonePath}"`);
    const { stdout } = await exec('cat file.txt', { cwd: clonePath });
    expect(stdout.trim()).toBe('line 1\nline 2');

    rmSync(clonePath, { recursive: true, force: true });
  });

  it('should restore contributor branches from branch-scoped bundles', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored-branches.git`;

    const result = await restoreFromBundles({
      repo          : repoHandle as any,
      refs          : refsHandle as any,
      repoPath      : restoredRepoPath,
      repoContextId : repoContextId,
    });

    expect(result.success).toBe(true);
    expect(result.bundlesApplied).toBeGreaterThanOrEqual(3);

    const { stdout: showRef } = await exec(`git show-ref --verify "${CONTRIBUTOR_REF}"`, {
      cwd: restoredRepoPath,
    });
    expect(showRef).toContain(CONTRIBUTOR_REF);

    const { stdout: log } = await exec(`git log --oneline "${CONTRIBUTOR_REF}"`, {
      cwd: restoredRepoPath,
    });
    expect(log).toContain('contributor branch commit');
  });

  it('should return failure when no bundles exist', async () => {
    // Create a fresh Enbox agent with no bundle records.
    const freshDataPath = `${DATA_PATH}-fresh`;
    rmSync(freshDataPath, { recursive: true, force: true });

    const freshAgent = await EnboxUserAgent.create({ dataPath: freshDataPath });
    await freshAgent.initialize({ password: 'fresh-test' });
    await freshAgent.start({ password: 'fresh-test' });

    const identities = await freshAgent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await createTestIdentity(freshAgent, 'Fresh Test');
    }

    const freshEnbox = new Enbox({ agent: freshAgent, connectedDid: identity.did.uri });

    const freshRepo = freshEnbox.using(ForgeRepoProtocol);
    await freshRepo.configure();

    // Create a repo record (but no bundles).
    await freshRepo.records.create('repo', {
      data : { name: 'empty-repo', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'empty-repo', visibility: 'public' },
    });

    const result = await restoreFromBundles({
      repo     : freshRepo as any,
      repoPath : `${RESTORE_PATH}/should-not-exist.git`,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No full bundle found');
    expect(existsSync(`${RESTORE_PATH}/should-not-exist.git`)).toBe(false);

    rmSync(freshDataPath, { recursive: true, force: true });
  }, 30_000);

  it('should query a remote DWN when a from DID is provided', async () => {
    const remoteDid = 'did:dht:remoteowner';
    const queries: Array<{ path: string; options: any }> = [];

    const result = await restoreFromBundles({
      repo: {
        records: {
          query: async (path: string, options: any) => {
            queries.push({ path, options });
            return { records: [] };
          },
        },
      } as any,
      from          : remoteDid,
      repoPath      : `${RESTORE_PATH}/remote-should-not-exist.git`,
      repoContextId : 'remote-context',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No full bundle found');
    expect(queries).toHaveLength(1);
    expect(queries[0].path).toBe('repo/bundle');
    expect(queries[0].options.from).toBe(remoteDid);
    expect(queries[0].options.filter.contextId).toBe('remote-context');
  });

  it('should restore the tip commit matching the original', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored-tip.git`;

    // Get the original tip commit.
    const { stdout: originalTip } = await exec('git rev-parse main', { cwd: repoPath });

    const result = await restoreFromBundles({
      repo          : repoHandle as any,
      repoPath      : restoredRepoPath,
      repoContextId : repoContextId,
    });

    expect(result.success).toBe(true);
    expect(result.tipCommit).toBe(originalTip.trim());
  });
});
