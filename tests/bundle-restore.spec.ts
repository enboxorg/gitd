/**
 * Tests for restoring a bare git repo from DWN bundle records.
 *
 * Tests the `restoreFromBundles` function end-to-end: creates a Web5
 * agent, pushes commits, syncs bundles to DWN, then restores to a new
 * directory and verifies the repository content matches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';

import { ForgeRepoProtocol } from '../src/repo.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/bundle-restore-agent';
const REPOS_PATH = '__TESTDATA__/bundle-restore-repos';
const WORK_PATH = '__TESTDATA__/bundle-restore-work';
const RESTORE_PATH = '__TESTDATA__/bundle-restore-output';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('restoreFromBundles', () => {
  let repoPath: string;
  let repoContextId: string;
  let repoHandle: ReturnType<InstanceType<typeof Web5>['using']>;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
    rmSync(RESTORE_PATH, { recursive: true, force: true });

    // Create agent + Web5 instance.
    const agent = await Web5UserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'restore-test' });
    await agent.start({ password: 'restore-test' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Restore Test' },
      });
    }

    const { web5 } = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });

    repoHandle = web5.using(ForgeRepoProtocol);
    // Skip encryption: true — the test DID (did:jwk Ed25519) lacks X25519.
    await repoHandle.configure();

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
      repo     : repoHandle as any,
      repoPath : restoredRepoPath,
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
      repo     : repoHandle as any,
      repoPath : restoredRepoPath,
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
      repo     : repoHandle as any,
      repoPath : restoredRepoPath,
    });

    // Clone from the restored bare repo to verify content.
    // Explicit --branch is needed because restored bare repos may have
    // HEAD pointing to a non-existent default branch (master vs main).
    await exec(`git clone --branch main "${restoredRepoPath}" "${clonePath}"`);
    const { stdout } = await exec('cat file.txt', { cwd: clonePath });
    expect(stdout.trim()).toBe('line 1\nline 2');

    rmSync(clonePath, { recursive: true, force: true });
  });

  it('should return failure when no bundles exist', async () => {
    // Create a fresh Web5 agent with no bundle records.
    const freshDataPath = `${DATA_PATH}-fresh`;
    rmSync(freshDataPath, { recursive: true, force: true });

    const freshAgent = await Web5UserAgent.create({ dataPath: freshDataPath });
    await freshAgent.initialize({ password: 'fresh-test' });
    await freshAgent.start({ password: 'fresh-test' });

    const identities = await freshAgent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await freshAgent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Fresh Test' },
      });
    }

    const { web5: freshWeb5 } = await Web5.connect({
      agent        : freshAgent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });

    const freshRepo = freshWeb5.using(ForgeRepoProtocol);
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
  });

  it('should restore the tip commit matching the original', async () => {
    const restoredRepoPath = `${RESTORE_PATH}/restored-tip.git`;

    // Get the original tip commit.
    const { stdout: originalTip } = await exec('git rev-parse main', { cwd: repoPath });

    const result = await restoreFromBundles({
      repo     : repoHandle as any,
      repoPath : restoredRepoPath,
    });

    expect(result.success).toBe(true);
    expect(result.tipCommit).toBe(originalTip.trim());
  });
});
