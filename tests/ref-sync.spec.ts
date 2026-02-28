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
import { readGitRefs } from '../src/git-server/ref-sync.js';

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

  it('should reject when git fails (e.g., invalid repo path)', async () => {
    await expect(readGitRefs('/nonexistent/path')).rejects.toThrow();
  });
});
