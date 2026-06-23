/**
 * Tests for git ref → DWN synchronization.
 *
 * Tests the `readGitRefs()` function against real bare git repos,
 * and verifies the ref parsing logic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { GitBackend } from '../src/git-server/git-backend.js';
import { createRefSyncer, readGitRefs } from '../src/git-server/ref-sync.js';

const TEST_BASE_PATH = '__TESTDATA__/ref-sync';
const TEST_DID = 'did:dht:refsynctest';
const TEST_REPO = 'sync-repo';

// ---------------------------------------------------------------------------
// readGitRefs
// ---------------------------------------------------------------------------

describe('readGitRefs', () => {
  let backend: GitBackend;
  let repoPath: string;

  beforeAll(async () => {
    rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    backend = new GitBackend({ basePath: TEST_BASE_PATH });
    repoPath = await backend.initRepo(TEST_DID, TEST_REPO);
  });

  afterAll(() => {
    rmSync(TEST_BASE_PATH, { recursive: true, force: true });
  });

  it('should return empty array for a repo with no refs', async () => {
    const refs = await readGitRefs(repoPath);
    expect(refs).toEqual([]);
  });

  it('should read branch refs after a commit', async () => {
    // Create a commit in the bare repo using a temporary worktree.
    const workdir = `${TEST_BASE_PATH}/tmp-work`;
    execSync(`git clone "${repoPath}" "${workdir}"`, { stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: workdir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: workdir, stdio: 'pipe' });
    // Use -b main to ensure the branch name is predictable.
    execSync('git checkout -b main', { cwd: workdir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial commit"', { cwd: workdir, stdio: 'pipe' });
    execSync('git push -u origin main', { cwd: workdir, stdio: 'pipe' });

    const refs = await readGitRefs(repoPath);
    expect(refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = refs.find((r) => r.name === 'refs/heads/main');
    expect(mainRef).toBeDefined();
    expect(mainRef!.type).toBe('branch');
    expect(mainRef!.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should read tag refs', async () => {
    const workdir = `${TEST_BASE_PATH}/tmp-work`;
    execSync('git tag v1.0.0', { cwd: workdir, stdio: 'pipe' });
    execSync('git push origin v1.0.0', { cwd: workdir, stdio: 'pipe' });

    const refs = await readGitRefs(repoPath);
    const tagRef = refs.find((r) => r.name === 'refs/tags/v1.0.0');
    expect(tagRef).toBeDefined();
    expect(tagRef!.type).toBe('tag');
    expect(tagRef!.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should read multiple branches', async () => {
    const workdir = `${TEST_BASE_PATH}/tmp-work`;
    execSync('git checkout -b feature-branch', { cwd: workdir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "feature commit"', { cwd: workdir, stdio: 'pipe' });
    execSync('git push origin feature-branch', { cwd: workdir, stdio: 'pipe' });

    const refs = await readGitRefs(repoPath);
    const branches = refs.filter((r) => r.type === 'branch');
    expect(branches.length).toBeGreaterThanOrEqual(2);

    const featureRef = refs.find((r) => r.name === 'refs/heads/feature-branch');
    expect(featureRef).toBeDefined();
    expect(featureRef!.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should differentiate branch and tag types correctly', async () => {
    const refs = await readGitRefs(repoPath);
    for (const ref of refs) {
      if (ref.name.startsWith('refs/heads/')) {
        expect(ref.type).toBe('branch');
      } else if (ref.name.startsWith('refs/tags/')) {
        expect(ref.type).toBe('tag');
      }
    }
  });

  it('should sync branch records and squashed branch checkpoints', async () => {
    const mock = createMockRefsHandle();
    const repoContextId = 'repo-context-1';
    const syncer = createRefSyncer({ refs: mock.handle as any, repoContextId });

    await syncer(TEST_DID, TEST_REPO, repoPath);

    const mirrorRefs = mock.recordsFor('repo/ref', repoContextId).map((record) => record._data);
    expect(mirrorRefs.some((ref) => ref.name === 'refs/heads/main')).toBe(true);
    expect(mirrorRefs.some((ref) => ref.name === 'refs/tags/v1.0.0')).toBe(true);

    const branches = mock.recordsFor('repo/branch', repoContextId);
    const branchData = branches.map((record) => record._data);
    expect(branchData.map((branch) => branch.refName).sort()).toEqual([
      'refs/heads/feature-branch',
      'refs/heads/main',
    ]);
    expect(branchData.find((branch) => branch.refName === 'refs/heads/main')!.kind).toBe('protected');
    expect(branchData.find((branch) => branch.refName === 'refs/heads/feature-branch')!.kind).toBe('shared');

    const mainBranch = branches.find((record) => record._data.refName === 'refs/heads/main')!;
    const mainStates = mock.recordsFor('repo/branch/state', mainBranch.contextId);
    expect(mainStates).toHaveLength(1);
    expect(mainStates[0]._data.kind).toBe('checkpoint');
    expect(mainStates[0]._data.refName).toBe('refs/heads/main');
    expect(mainStates[0]._data.target).toMatch(/^[0-9a-f]{40}$/);

    const mainStateId = mainStates[0].id;
    await syncer(TEST_DID, TEST_REPO, repoPath);
    expect(mock.recordsFor('repo/branch/state', mainBranch.contextId).map((record) => record.id)).toEqual([mainStateId]);

    const workdir = `${TEST_BASE_PATH}/tmp-work`;
    execSync('git checkout main', { cwd: workdir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "main branch checkpoint"', { cwd: workdir, stdio: 'pipe' });
    execSync('git push origin main', { cwd: workdir, stdio: 'pipe' });

    await syncer(TEST_DID, TEST_REPO, repoPath);
    const updatedMainStates = mock.recordsFor('repo/branch/state', mainBranch.contextId);
    expect(updatedMainStates).toHaveLength(1);
    expect(updatedMainStates[0].id).not.toBe(mainStateId);
    expect(updatedMainStates[0]._data.target).not.toBe(mainStates[0]._data.target);
  });

  it('should reject when git fails (e.g., invalid repo path)', async () => {
    await expect(readGitRefs('/nonexistent/path')).rejects.toThrow();
  });
});

type MockRecord = {
  id: string;
  path: string;
  contextId: string;
  parentContextId: string;
  tags: Record<string, unknown>;
  _data: any;
  dateCreated: string;
  data: { json: () => Promise<any> };
  update: (options: { data: any; tags: Record<string, unknown> }) => Promise<void>;
  delete: () => Promise<void>;
};

function createMockRefsHandle(): { handle: any; recordsFor: (path: string, parentContextId: string) => MockRecord[] } {
  let nextId = 0;
  const records: MockRecord[] = [];

  const recordsFor = (path: string, parentContextId: string): MockRecord[] =>
    records.filter((record) => record.path === path && record.parentContextId === parentContextId);

  const removeRecord = (record: MockRecord): void => {
    const index = records.indexOf(record);
    if (index >= 0) {
      records.splice(index, 1);
    }
  };

  const handle = {
    records: {
      query: async (path: string, options?: any) => ({
        records: recordsFor(path, options?.filter?.contextId),
      }),
      create: async (path: string, options: any) => {
        const parentContextId = options.parentContextId;
        if (options.squash) {
          for (const record of [...recordsFor(path, parentContextId)]) {
            removeRecord(record);
          }
        }

        const id = `record-${++nextId}`;
        const record: MockRecord = {
          id,
          path,
          parentContextId,
          contextId   : `context-${id}`,
          tags        : options.tags ?? {},
          _data       : options.data,
          dateCreated : '2026-06-22T00:00:00.000Z',
          data        : { json: async () => record._data },
          update      : async (updateOptions) => {
            record._data = updateOptions.data;
            record.tags = updateOptions.tags;
          },
          delete: async () => removeRecord(record),
        };
        records.push(record);
        return { status: { code: 202 }, record };
      },
    },
  };

  return { handle, recordsFor };
}
