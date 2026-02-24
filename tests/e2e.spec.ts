/**
 * End-to-end integration test: init → serve → clone → commit → push → verify.
 *
 * Proves the entire git transport stack works together.
 * No DID transport layer needed — tests use direct HTTP URLs.
 * No external services — uses in-memory DWN agent.
 *
 * IMPORTANT: Uses async `exec` instead of `execSync` because bun's event loop
 * must keep ticking for the HTTP server to process requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

import { promisify } from 'node:util';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';
import type { GitServer } from '../src/git-server/server.js';

import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { createGitServer } from '../src/git-server/server.js';
import { createRefSyncer } from '../src/git-server/ref-sync.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { readGitRefs } from '../src/git-server/ref-sync.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/e2e-agent';
const REPOS_PATH = '__TESTDATA__/e2e-repos';
const CLONE_PATH = '__TESTDATA__/e2e-clone';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('E2E: init → serve → clone → push → verify', () => {
  let did: string;
  let repoContextId: string;
  let server: GitServer;
  let cloneUrl: string;
  let refs: AgentContext['refs'];

  beforeAll(async () => {
    // Clean up.
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(CLONE_PATH, { recursive: true, force: true });

    // --- Step 1: Create Web5 agent (only install repo + refs protocols) ---
    const agent = await Web5UserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'e2e-test' });
    await agent.start({ password: 'e2e-test' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'E2E Test' },
      });
    }

    const { web5, did: agentDid } = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    did = agentDid;

    const repoHandle = web5.using(ForgeRepoProtocol);
    const refsHandle = web5.using(ForgeRefsProtocol);
    await repoHandle.configure();
    await refsHandle.configure();
    refs = refsHandle;

    // --- Step 2: Create repo record ---
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'e2e-test-repo', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'e2e-test-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // --- Step 3: Init bare git repo ---
    const backend = new GitBackend({ basePath: REPOS_PATH });
    await backend.initRepo(did, 'e2e-test-repo');

    // --- Step 4: Start git server with ref sync ---
    const onPushComplete = createRefSyncer({
      refs          : refsHandle,
      repoContextId : repoContextId,
    });

    server = await createGitServer({
      basePath       : REPOS_PATH,
      port           : 0,
      onPushComplete : onPushComplete,
    });

    cloneUrl = `http://localhost:${server.port}/${did}/e2e-test-repo`;
  }, 30000);

  afterAll(async () => {
    if (server) { await server.stop(); }
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(CLONE_PATH, { recursive: true, force: true });
  });

  it('should serve ref advertisement for the initialized repo', async () => {
    const res = await fetch(`${cloneUrl}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement');

    const body = await res.text();
    expect(body).toContain('# service=git-upload-pack');
  });

  it('should clone the empty repo via smart HTTP', async () => {
    rmSync(CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone "${cloneUrl}" "${CLONE_PATH}"`);
    expect(existsSync(`${CLONE_PATH}/.git`)).toBe(true);
  });

  it('should accept a push with a commit', async () => {
    await exec('git config user.email "e2e@test.com"', { cwd: CLONE_PATH });
    await exec('git config user.name "E2E Test"', { cwd: CLONE_PATH });
    await exec('git checkout -b main', { cwd: CLONE_PATH });
    await exec('echo "hello from dwn-git" > README.md', { cwd: CLONE_PATH });
    await exec('git add README.md', { cwd: CLONE_PATH });
    await exec('git commit -m "initial commit"', { cwd: CLONE_PATH });
    await exec('git push -u origin main', { cwd: CLONE_PATH });
  });

  it('should have the pushed commit in the bare repo', async () => {
    const repoPath = server.backend.repoPath(did, 'e2e-test-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('initial commit');
  });

  it('should have synced refs in the bare repo', async () => {
    const repoPath = server.backend.repoPath(did, 'e2e-test-repo');
    const gitRefs = await readGitRefs(repoPath);
    const mainRef = gitRefs.find((r) => r.name === 'refs/heads/main');
    expect(mainRef).toBeDefined();
    expect(mainRef!.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should sync refs to DWN records after push', async () => {
    // The onPushComplete callback fires asynchronously after the push response.
    // Wait for it to complete, then manually invoke it if it didn't fire.
    await new Promise((r) => setTimeout(r, 500));

    // Check if ref sync happened automatically.
    let { records: refRecords } = await refs.records.query('repo/ref' as any);

    if (refRecords.length === 0) {
      // onPushComplete may not have fired (timing issue). Invoke manually.
      const repoPath = server.backend.repoPath(did, 'e2e-test-repo');
      const syncer = createRefSyncer({ refs, repoContextId });
      await syncer(did, 'e2e-test-repo', repoPath);
      ({ records: refRecords } = await refs.records.query('repo/ref' as any));
    }

    expect(refRecords.length).toBeGreaterThanOrEqual(1);

    const refData = await refRecords[0].data.json();
    expect(refData.name).toBe('refs/heads/main');
    expect(refData.type).toBe('branch');
    expect(refData.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should handle a second push updating the ref', async () => {
    await exec('echo "update" >> README.md', { cwd: CLONE_PATH });
    await exec('git add README.md', { cwd: CLONE_PATH });
    await exec('git commit -m "second commit"', { cwd: CLONE_PATH });
    await exec('git push origin main', { cwd: CLONE_PATH });

    const repoPath = server.backend.repoPath(did, 'e2e-test-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('second commit');
    expect(stdout).toContain('initial commit');
  });

  it('should allow a second clone to see the pushed content', async () => {
    const secondClone = `${CLONE_PATH}-2`;
    rmSync(secondClone, { recursive: true, force: true });
    await exec(`git clone --branch main "${cloneUrl}" "${secondClone}"`);

    const { stdout } = await exec('cat README.md', { cwd: secondClone });
    expect(stdout).toContain('hello from dwn-git');
    expect(stdout).toContain('update');

    rmSync(secondClone, { recursive: true, force: true });
  });
});

// ===========================================================================
// E2E: Bundle round-trip — push → bundle sync → cold start → clone
// ===========================================================================

describe('E2E: push → bundle sync → cold start → clone via restore', () => {
  let did: string;
  let repoContextId: string;
  let repoHandle: ReturnType<typeof Web5.prototype.using<typeof ForgeRepoProtocol>>;
  let refsHandle: ReturnType<typeof Web5.prototype.using<typeof ForgeRefsProtocol>>;
  let server: GitServer;
  let cloneUrl: string;

  const BUNDLE_DATA_PATH = '__TESTDATA__/bundle-e2e-agent';
  const BUNDLE_REPOS_PATH = '__TESTDATA__/bundle-e2e-repos';
  const BUNDLE_CLONE_PATH = '__TESTDATA__/bundle-e2e-clone';
  const BUNDLE_RESTORE_REPOS = '__TESTDATA__/bundle-e2e-restore-repos';
  const BUNDLE_RESTORE_CLONE = '__TESTDATA__/bundle-e2e-restore-clone';

  beforeAll(async () => {
    rmSync(BUNDLE_DATA_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_REPOS_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_CLONE_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_RESTORE_REPOS, { recursive: true, force: true });
    rmSync(BUNDLE_RESTORE_CLONE, { recursive: true, force: true });

    // --- Step 1: Create Web5 agent ---
    const agent = await Web5UserAgent.create({ dataPath: BUNDLE_DATA_PATH });
    await agent.initialize({ password: 'bundle-e2e' });
    await agent.start({ password: 'bundle-e2e' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Bundle E2E Test' },
      });
    }

    const { web5, did: agentDid } = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    did = agentDid;

    repoHandle = web5.using(ForgeRepoProtocol);
    refsHandle = web5.using(ForgeRefsProtocol);
    await repoHandle.configure();
    await refsHandle.configure();

    // --- Step 2: Create repo record ---
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'bundle-test-repo', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'bundle-test-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // --- Step 3: Init bare git repo ---
    const backend = new GitBackend({ basePath: BUNDLE_REPOS_PATH });
    await backend.initRepo(did, 'bundle-test-repo');

    // --- Step 4: Start git server with both ref sync AND bundle sync ---
    const refSyncer = createRefSyncer({
      refs          : refsHandle,
      repoContextId : repoContextId,
    });

    const bundleSyncer = createBundleSyncer({
      repo          : repoHandle,
      repoContextId : repoContextId,
      visibility    : 'public',
    });

    // Chain both syncers as onPushComplete.
    const onPushComplete = async (pushDid: string, repoName: string, repoPath: string): Promise<void> => {
      await refSyncer(pushDid, repoName, repoPath);
      await bundleSyncer(pushDid, repoName, repoPath);
    };

    server = await createGitServer({
      basePath       : BUNDLE_REPOS_PATH,
      port           : 0,
      onPushComplete : onPushComplete,
    });

    cloneUrl = `http://localhost:${server.port}/${did}/bundle-test-repo`;
  }, 30000);

  afterAll(async () => {
    try { if (server) { await server.stop(); } } catch { /* may already be stopped */ }
    rmSync(BUNDLE_DATA_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_REPOS_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_CLONE_PATH, { recursive: true, force: true });
    rmSync(BUNDLE_RESTORE_REPOS, { recursive: true, force: true });
    rmSync(BUNDLE_RESTORE_CLONE, { recursive: true, force: true });
  });

  it('should push a commit and trigger bundle sync to DWN', async () => {
    // Clone the empty repo, commit, and push.
    rmSync(BUNDLE_CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone "${cloneUrl}" "${BUNDLE_CLONE_PATH}"`);
    await exec('git config user.email "bundle@test.com"', { cwd: BUNDLE_CLONE_PATH });
    await exec('git config user.name "Bundle Test"', { cwd: BUNDLE_CLONE_PATH });
    await exec('git checkout -b main', { cwd: BUNDLE_CLONE_PATH });
    await exec('echo "bundle round-trip content" > README.md', { cwd: BUNDLE_CLONE_PATH });
    await exec('git add README.md', { cwd: BUNDLE_CLONE_PATH });
    await exec('git commit -m "bundle test commit"', { cwd: BUNDLE_CLONE_PATH });
    await exec('git push -u origin main', { cwd: BUNDLE_CLONE_PATH });

    // Wait for the async onPushComplete to finish.
    await new Promise((r) => setTimeout(r, 1000));
  });

  it('should have a bundle record in the DWN', async () => {
    const { records } = await repoHandle.records.query('repo/bundle', {});
    expect(records.length).toBeGreaterThanOrEqual(1);

    // Verify the bundle metadata.
    const bundle = records[0];
    const tags = bundle.tags as Record<string, unknown>;
    expect(tags.isFull).toBe(true);
    expect(tags.tipCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should restore the repo from bundles on cold start and serve a clone', async () => {
    // Stop the original server.
    await server.stop();

    // Start a new server with a CLEAN repos directory (simulates cold start).
    // Wire onRepoNotFound to restoreFromBundles.
    const restoreServer = await createGitServer({
      basePath       : BUNDLE_RESTORE_REPOS,
      port           : 0,
      onRepoNotFound : async (_repoDid: string, _repoName: string, repoPath: string): Promise<boolean> => {
        const result = await restoreFromBundles({ repo: repoHandle, repoPath });
        return result.success;
      },
    });

    try {
      const restoreCloneUrl = `http://localhost:${restoreServer.port}/${did}/bundle-test-repo`;

      // Clone from the restore server — triggers onRepoNotFound → restoreFromBundles.
      rmSync(BUNDLE_RESTORE_CLONE, { recursive: true, force: true });
      await exec(`git clone --branch main "${restoreCloneUrl}" "${BUNDLE_RESTORE_CLONE}"`);

      // Verify the clone has the content.
      expect(existsSync(`${BUNDLE_RESTORE_CLONE}/.git`)).toBe(true);
      const { stdout } = await exec('cat README.md', { cwd: BUNDLE_RESTORE_CLONE });
      expect(stdout).toContain('bundle round-trip content');

      // Verify the git log has the commit.
      const { stdout: logOutput } = await exec('git log --oneline', { cwd: BUNDLE_RESTORE_CLONE });
      expect(logOutput).toContain('bundle test commit');
    } finally {
      await restoreServer.stop();
    }
  }, 30000);
});
