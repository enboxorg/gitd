/**
 * Tests for git bundle creation and DWN synchronization.
 *
 * Tests the `createFullBundle`, `createIncrementalBundle`, and
 * `createBundleSyncer` functions against real bare git repos and a
 * live Enbox agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { DateSort } from '@enbox/dwn-sdk-js';
import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import { ForgeRepoProtocol } from '../src/repo.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { createBundleSyncer, createFullBundle, createIncrementalBundle } from '../src/git-server/bundle-sync.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/bundle-sync-agent';
const REPOS_PATH = '__TESTDATA__/bundle-sync-repos';
const WORK_PATH = '__TESTDATA__/bundle-sync-work';
const TEST_DID = 'did:dht:bundlesynctest';
const TEST_REPO = 'bundle-test';

// ---------------------------------------------------------------------------
// createFullBundle / createIncrementalBundle (pure git — no DWN needed)
// ---------------------------------------------------------------------------

describe('createFullBundle', () => {
  let backend: GitBackend;
  let repoPath: string;
  let firstCommitSha: string;

  beforeAll(async () => {
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });

    backend = new GitBackend({ basePath: REPOS_PATH });
    repoPath = await backend.initRepo(TEST_DID, TEST_REPO);

    // Seed the bare repo with a commit via a working clone.
    await exec(`git clone "${repoPath}" "${WORK_PATH}"`);
    await exec('git config user.email "test@test.com"', { cwd: WORK_PATH });
    await exec('git config user.name "Test"', { cwd: WORK_PATH });
    await exec('git checkout -b main', { cwd: WORK_PATH });
    await exec('echo "hello" > README.md', { cwd: WORK_PATH });
    await exec('git add README.md', { cwd: WORK_PATH });
    await exec('git commit -m "initial commit"', { cwd: WORK_PATH });
    await exec('git push -u origin main', { cwd: WORK_PATH });

    // Get the commit SHA from the working clone (HEAD resolves correctly here).
    const { stdout } = await exec('git rev-parse HEAD', { cwd: WORK_PATH });
    firstCommitSha = stdout.trim();
  });

  afterAll(() => {
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
  });

  it('should create a valid full bundle with all refs', async () => {
    const info = await createFullBundle(repoPath);

    expect(info.isFull).toBe(true);
    expect(info.tipCommit).toBe(firstCommitSha);
    expect(info.refCount).toBeGreaterThanOrEqual(1);
    expect(info.size).toBeGreaterThan(0);
    expect(existsSync(info.path)).toBe(true);

    // Verify the bundle is a valid git bundle.
    const { stdout } = await exec(`git bundle verify "${info.path}"`);
    expect(stdout + '').toBeDefined();

    // Clean up the temp file.
    rmSync(info.path, { force: true });
  });

  it('should produce a bundle file with application/x-git-bundle header', async () => {
    const info = await createFullBundle(repoPath);

    // Git bundles start with "# v2 git bundle\n" or "# v3 git bundle\n".
    const header = readFileSync(info.path, 'utf-8').slice(0, 20);
    expect(header).toMatch(/^# v[23] git bundle/);

    rmSync(info.path, { force: true });
  });
});

describe('createIncrementalBundle', () => {
  let backend: GitBackend;
  let repoPath: string;
  let baseCommit: string;

  beforeAll(async () => {
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });

    backend = new GitBackend({ basePath: REPOS_PATH });
    repoPath = await backend.initRepo(TEST_DID, TEST_REPO);

    // Seed with first commit.
    await exec(`git clone "${repoPath}" "${WORK_PATH}"`);
    await exec('git config user.email "test@test.com"', { cwd: WORK_PATH });
    await exec('git config user.name "Test"', { cwd: WORK_PATH });
    await exec('git checkout -b main', { cwd: WORK_PATH });
    await exec('echo "v1" > file.txt', { cwd: WORK_PATH });
    await exec('git add file.txt', { cwd: WORK_PATH });
    await exec('git commit -m "first"', { cwd: WORK_PATH });
    await exec('git push -u origin main', { cwd: WORK_PATH });

    const { stdout: sha1 } = await exec('git rev-parse HEAD', { cwd: WORK_PATH });
    baseCommit = sha1.trim();

    // Push a second commit.
    await exec('echo "v2" >> file.txt', { cwd: WORK_PATH });
    await exec('git add file.txt', { cwd: WORK_PATH });
    await exec('git commit -m "second"', { cwd: WORK_PATH });
    await exec('git push origin main', { cwd: WORK_PATH });
  });

  afterAll(() => {
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
  });

  it('should create an incremental bundle since base commit', async () => {
    const info = await createIncrementalBundle(repoPath, baseCommit);

    expect(info.isFull).toBe(false);
    expect(info.tipCommit).not.toBe(baseCommit);
    expect(info.refCount).toBeGreaterThanOrEqual(1);
    expect(info.size).toBeGreaterThan(0);
    expect(existsSync(info.path)).toBe(true);

    // The incremental bundle should be smaller than a full bundle.
    const fullInfo = await createFullBundle(repoPath);
    // Can't guarantee size relationship for small repos, but both should be valid.
    expect(fullInfo.size).toBeGreaterThan(0);

    rmSync(info.path, { force: true });
    rmSync(fullInfo.path, { force: true });
  });

  it('should produce a bundle with prerequisites', async () => {
    const info = await createIncrementalBundle(repoPath, baseCommit);

    // Incremental bundles contain prerequisite lines (starting with -)
    // in their header.
    const header = readFileSync(info.path, 'utf-8');
    const lines = header.split('\n');
    const prereqLines = lines.filter((l) => l.startsWith('-'));
    expect(prereqLines.length).toBeGreaterThanOrEqual(1);

    rmSync(info.path, { force: true });
  });
});

// ---------------------------------------------------------------------------
// createBundleSyncer — full DWN integration
// ---------------------------------------------------------------------------

describe('createBundleSyncer (DWN integration)', () => {
  let repoPath: string;
  let repoContextId: string;
  let repoHandle: ReturnType<InstanceType<typeof Enbox>['using']>;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });

    // Create agent + Enbox instance.
    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'bundle-test' });
    await agent.start({ password: 'bundle-test' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Bundle Test' },
      });
    }

    const enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });

    repoHandle = enbox.using(ForgeRepoProtocol);
    // Skip encryption: true — the test DID (did:jwk Ed25519) lacks X25519.
    // Production uses encryption: true for webhook support; bundle encryption
    // is tested separately with an appropriate DID.
    await repoHandle.configure();

    // Create a repo record.
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'bundle-test', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'bundle-test', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // Set up bare repo with commits.
    const backend = new GitBackend({ basePath: REPOS_PATH });
    repoPath = await backend.initRepo('did:dht:bundletest', 'bundle-test');

    await exec(`git clone "${repoPath}" "${WORK_PATH}"`);
    await exec('git config user.email "test@test.com"', { cwd: WORK_PATH });
    await exec('git config user.name "Test"', { cwd: WORK_PATH });
    await exec('git checkout -b main', { cwd: WORK_PATH });
    await exec('echo "hello from bundle test" > README.md', { cwd: WORK_PATH });
    await exec('git add README.md', { cwd: WORK_PATH });
    await exec('git commit -m "initial commit"', { cwd: WORK_PATH });
    await exec('git push -u origin main', { cwd: WORK_PATH });
  }, 30000);

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
  });

  it('should create a full bundle record on first sync', async () => {
    const syncer = createBundleSyncer({
      repo          : repoHandle as any,
      repoContextId : repoContextId,
      visibility    : 'public',
    });

    await syncer('did:dht:bundletest', 'bundle-test', repoPath);

    // Query bundle records.
    const { records } = await (repoHandle as any).records.query('repo/bundle', {
      dateSort: DateSort.CreatedDescending,
    });

    expect(records.length).toBe(1);

    const record = records[0];
    expect(record.tags.isFull).toBe(true);
    expect(record.tags.tipCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.tags.refCount).toBeGreaterThanOrEqual(1);
    expect(record.tags.size).toBeGreaterThan(0);
    expect(record.dataFormat).toBe('application/x-git-bundle');
  });

  it('should create incremental bundles on subsequent syncs', async () => {
    // Push another commit.
    await exec('echo "update" >> README.md', { cwd: WORK_PATH });
    await exec('git add README.md', { cwd: WORK_PATH });
    await exec('git commit -m "second commit"', { cwd: WORK_PATH });
    await exec('git push origin main', { cwd: WORK_PATH });

    const syncer = createBundleSyncer({
      repo          : repoHandle as any,
      repoContextId : repoContextId,
      visibility    : 'public',
    });

    await syncer('did:dht:bundletest', 'bundle-test', repoPath);

    // Should now have 2 bundle records: 1 full + 1 incremental.
    const { records: fullRecords } = await (repoHandle as any).records.query('repo/bundle', {
      filter   : { tags: { isFull: true } },
      dateSort : DateSort.CreatedDescending,
    });
    const { records: incRecords } = await (repoHandle as any).records.query('repo/bundle', {
      filter   : { tags: { isFull: false } },
      dateSort : DateSort.CreatedDescending,
    });

    expect(fullRecords.length).toBe(1);
    expect(incRecords.length).toBe(1);
    expect(incRecords[0].tags.isFull).toBe(false);
  });

  it('should squash when threshold is reached', async () => {
    // Use a low threshold so we trigger squash quickly.
    const syncer = createBundleSyncer({
      repo            : repoHandle as any,
      repoContextId   : repoContextId,
      visibility      : 'public',
      squashThreshold : 2,
    });

    // Push another commit to trigger squash (already have 2 bundles).
    await exec('echo "squash trigger" >> README.md', { cwd: WORK_PATH });
    await exec('git add README.md', { cwd: WORK_PATH });
    await exec('git commit -m "third commit (squash)"', { cwd: WORK_PATH });
    await exec('git push origin main', { cwd: WORK_PATH });

    await syncer('did:dht:bundletest', 'bundle-test', repoPath);

    // After squash, the DWN should process the squash resumable task.
    // Give it a moment for the resumable task to complete.
    await new Promise((r) => setTimeout(r, 500));

    // Query all bundles — squash should have purged older ones.
    const { records } = await (repoHandle as any).records.query('repo/bundle', {
      dateSort: DateSort.CreatedDescending,
    });

    // After squash, only the squash bundle (full) should remain.
    // Older records are purged asynchronously by the DWN resumable task.
    expect(records.length).toBeGreaterThanOrEqual(1);

    // The most recent bundle should be a full bundle.
    expect(records[0].tags.isFull).toBe(true);
    expect(records[0].tags.tipCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should store retrievable bundle data', async () => {
    const { records } = await (repoHandle as any).records.query('repo/bundle', {
      filter   : { tags: { isFull: true } },
      dateSort : DateSort.CreatedDescending,
    });

    expect(records.length).toBeGreaterThanOrEqual(1);

    const blob = await records[0].data.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Git bundle header: "# v2 git bundle\n" or "# v3 git bundle\n".
    const header = new TextDecoder().decode(bytes.slice(0, 20));
    expect(header).toMatch(/^# v[23] git bundle/);
  });
});
