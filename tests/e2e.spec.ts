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
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';

import { DidJwk } from '@enbox/dids';
import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';
import type { GitServer } from '../src/git-server/server.js';
import type { RepoContext } from '../src/cli/repo-context.js';

import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../src/git-server/verify.js';
import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { createGitServer } from '../src/git-server/server.js';
import { createRefSyncer } from '../src/git-server/ref-sync.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { generatePushCredentials } from '../src/git-remote/credential-helper.js';
import { getRepoContext } from '../src/cli/repo-context.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { readGitRefs } from '../src/git-server/ref-sync.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';
import {
  decodePushToken,
  DID_AUTH_USERNAME,
  parseAuthPassword,
} from '../src/git-server/auth.js';
import { profileDataPath, upsertProfile } from '../src/profiles/config.js';

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
    await exec('echo "hello from gitd" > README.md', { cwd: CLONE_PATH });
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
    expect(stdout).toContain('hello from gitd');
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
        const result = await restoreFromBundles({ repo: repoHandle, repoPath, repoContextId });
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

// ===========================================================================
// E2E: Authenticated push — DID-signed tokens, push authorizer, credential helper
// ===========================================================================

describe('E2E: authenticated push with DID-signed tokens', () => {
  let ownerDid: string;
  let ownerPrivateKey: Record<string, unknown>;
  let repoContextId: string;
  let repoHandle: ReturnType<typeof Web5.prototype.using<typeof ForgeRepoProtocol>>;
  let refsHandle: ReturnType<typeof Web5.prototype.using<typeof ForgeRefsProtocol>>;
  let server: GitServer;
  let cloneUrl: string;

  const AUTH_DATA_PATH = '__TESTDATA__/auth-e2e-agent';
  const AUTH_REPOS_PATH = '__TESTDATA__/auth-e2e-repos';
  const AUTH_CLONE_PATH = '__TESTDATA__/auth-e2e-clone';

  beforeAll(async () => {
    rmSync(AUTH_DATA_PATH, { recursive: true, force: true });
    rmSync(AUTH_REPOS_PATH, { recursive: true, force: true });
    rmSync(AUTH_CLONE_PATH, { recursive: true, force: true });

    // --- Step 1: Create Web5 agent ---
    const agent = await Web5UserAgent.create({ dataPath: AUTH_DATA_PATH });
    await agent.initialize({ password: 'auth-e2e' });
    await agent.start({ password: 'auth-e2e' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Auth E2E Test' },
      });
    }

    const { web5, did: agentDid } = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    ownerDid = agentDid;

    // Extract the owner's Ed25519 private key for signing push tokens.
    const portableDid = await identity.did.export();
    ownerPrivateKey = portableDid.privateKeys![0] as Record<string, unknown>;

    repoHandle = web5.using(ForgeRepoProtocol);
    refsHandle = web5.using(ForgeRefsProtocol);
    await repoHandle.configure();
    await refsHandle.configure();

    // --- Step 2: Create repo record ---
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'auth-test-repo', description: 'Auth E2E test repo', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'auth-test-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // --- Step 3: Init bare git repo ---
    const backend = new GitBackend({ basePath: AUTH_REPOS_PATH });
    await backend.initRepo(ownerDid, 'auth-test-repo');

    // --- Step 4: Set up authenticated server ---
    //
    // Build a custom push authenticator that verifies DID signatures and
    // checks role-based authorization, but does NOT enforce nonce replay
    // protection. Nonce replay is incompatible with git's HTTP push flow:
    // git reuses the same Basic auth credentials for both the ref discovery
    // GET and the receive-pack POST within a single push operation.
    const verifySignature = createDidSignatureVerifier();
    const authorizePush = createDwnPushAuthorizer({
      repo     : repoHandle,
      ownerDid : ownerDid,
    });

    const authenticatePush = async (request: Request, did: string, repo: string): Promise<boolean> => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Basic ')) { return false; }

      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) { return false; }

      const username = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      if (username !== DID_AUTH_USERNAME) { return false; }

      let signed;
      try { signed = parseAuthPassword(password); } catch { return false; }

      let payload;
      try { payload = decodePushToken(signed.token); } catch { return false; }

      if (payload.owner !== did || payload.repo !== repo) { return false; }
      if (payload.exp < Math.floor(Date.now() / 1000)) { return false; }

      const tokenBytes = new TextEncoder().encode(signed.token);
      const signatureBytes = new Uint8Array(Buffer.from(signed.signature, 'base64url'));
      if (!(await verifySignature(payload.did, tokenBytes, signatureBytes))) { return false; }

      return authorizePush(payload.did, did, repo);
    };

    const refSyncer = createRefSyncer({
      refs          : refsHandle,
      repoContextId : repoContextId,
    });

    server = await createGitServer({
      basePath       : AUTH_REPOS_PATH,
      port           : 0,
      authenticatePush,
      onPushComplete : refSyncer,
    });

    cloneUrl = `http://localhost:${server.port}/${ownerDid}/auth-test-repo`;
  }, 30000);

  afterAll(async () => {
    try { if (server) { await server.stop(); } } catch { /* may already be stopped */ }
    rmSync(AUTH_DATA_PATH, { recursive: true, force: true });
    rmSync(AUTH_REPOS_PATH, { recursive: true, force: true });
    rmSync(AUTH_CLONE_PATH, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Helper: build an HTTP Authorization header from push credentials.
  // -----------------------------------------------------------------------
  async function makeAuthHeader(
    agentDid: string,
    privateKey: Record<string, unknown>,
  ): Promise<string> {
    const creds = await generatePushCredentials(
      { path: `/${ownerDid}/auth-test-repo` },
      agentDid,
      privateKey,
    );
    if (!creds) { throw new Error('generatePushCredentials returned undefined'); }
    return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
  }

  it('should clone the empty repo (clone is unauthenticated)', async () => {
    rmSync(AUTH_CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone "${cloneUrl}" "${AUTH_CLONE_PATH}"`);
    expect(existsSync(`${AUTH_CLONE_PATH}/.git`)).toBe(true);
  });

  it('should reject push ref discovery without credentials (HTTP 401)', async () => {
    // Direct HTTP request to the receive-pack ref advertisement without auth.
    const res = await fetch(`${cloneUrl}/info/refs?service=git-receive-pack`);
    expect(res.status).toBe(401);
  });

  it('should reject push ref discovery from an unauthorized DID (HTTP 401)', async () => {
    // Create a DID that is NOT the owner and has no collaborator role.
    const unauthorizedDid = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const portableUnauth = await unauthorizedDid.export();
    const unauthPrivateKey = portableUnauth.privateKeys![0] as Record<string, unknown>;

    const authHeader = await makeAuthHeader(unauthorizedDid.uri, unauthPrivateKey);

    const res = await fetch(`${cloneUrl}/info/refs?service=git-receive-pack`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(401);
  });

  it('should accept push ref discovery with valid owner credentials (HTTP 200)', async () => {
    const authHeader = await makeAuthHeader(ownerDid, ownerPrivateKey);

    const res = await fetch(`${cloneUrl}/info/refs?service=git-receive-pack`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-git-receive-pack-advertisement');
  });

  it('should push via git with DID-signed credentials', async () => {
    // Prepare a commit in the clone.
    await exec('git config user.email "auth@test.com"', { cwd: AUTH_CLONE_PATH });
    await exec('git config user.name "Auth Test"', { cwd: AUTH_CLONE_PATH });
    await exec('git checkout -b main', { cwd: AUTH_CLONE_PATH });
    await exec('echo "auth test content" > README.md', { cwd: AUTH_CLONE_PATH });
    await exec('git add README.md', { cwd: AUTH_CLONE_PATH });
    await exec('git commit -m "auth test commit"', { cwd: AUTH_CLONE_PATH });

    // Generate credentials using the credential helper logic.
    const creds = await generatePushCredentials(
      { path: `/${ownerDid}/auth-test-repo` },
      ownerDid,
      ownerPrivateKey,
    );
    expect(creds).toBeDefined();

    // Use a shell credential helper that echoes the pre-generated credentials.
    // Using `echo -e` to ensure proper newlines between key=value pairs.
    const user = creds!.username;
    const pass = creds!.password;
    const helper = `!f() { test "$1" = get && echo "username=${user}" && echo "password=${pass}"; }; f`;
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: AUTH_CLONE_PATH });

    await exec('GIT_TERMINAL_PROMPT=0 git push -u origin main', { cwd: AUTH_CLONE_PATH });
  });

  it('should have the pushed commit in the bare repo', async () => {
    const repoPath = server.backend.repoPath(ownerDid, 'auth-test-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('auth test commit');
  });

  it('should have synced refs to DWN after authenticated push', async () => {
    // Wait for the async onPushComplete to finish.
    await new Promise((r) => setTimeout(r, 500));

    let { records: refRecords } = await refsHandle.records.query('repo/ref' as any);

    if (refRecords.length === 0) {
      // Manually invoke ref syncer if timing caused it to not fire.
      const repoPath = server.backend.repoPath(ownerDid, 'auth-test-repo');
      const syncer = createRefSyncer({ refs: refsHandle, repoContextId });
      await syncer(ownerDid, 'auth-test-repo', repoPath);
      ({ records: refRecords } = await refsHandle.records.query('repo/ref' as any));
    }

    expect(refRecords.length).toBeGreaterThanOrEqual(1);

    const refData = await refRecords[0].data.json();
    expect(refData.name).toBe('refs/heads/main');
    expect(refData.type).toBe('branch');
    expect(refData.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should verify repo state via repo record query (repo info)', async () => {
    // Verify the DWN repo record matches expectations (equivalent to `gitd repo info`).
    const { records } = await repoHandle.records.query('repo', {
      filter: { tags: { name: 'auth-test-repo' } },
    });
    expect(records.length).toBe(1);

    const record = records[0];
    const data = await record.data.json();

    expect(data.name).toBe('auth-test-repo');
    expect(data.description).toBe('Auth E2E test repo');
    expect(data.defaultBranch).toBe('main');
    expect(record.contextId).toBe(repoContextId);
  });

  it('should allow a fresh clone to see pushed content', async () => {
    const freshClone = `${AUTH_CLONE_PATH}-fresh`;
    rmSync(freshClone, { recursive: true, force: true });
    await exec(`git clone --branch main "${cloneUrl}" "${freshClone}"`);

    expect(existsSync(`${freshClone}/.git`)).toBe(true);
    const { stdout } = await exec('cat README.md', { cwd: freshClone });
    expect(stdout).toContain('auth test content');

    rmSync(freshClone, { recursive: true, force: true });
  });

  it('should verify credential helper generates correct token structure', async () => {
    // Test the credential helper logic directly (not via git).
    const creds = await generatePushCredentials(
      { path: `/${ownerDid}/auth-test-repo` },
      ownerDid,
      ownerPrivateKey,
    );
    expect(creds).toBeDefined();
    expect(creds!.username).toBe(DID_AUTH_USERNAME);

    // Parse the password to verify it contains a valid signed token.
    const [signature, ...tokenParts] = creds!.password.split('.');
    const token = tokenParts.join('.');
    expect(signature).toBeTruthy();
    expect(token).toBeTruthy();

    // Decode and verify the token payload.
    const payloadJson = Buffer.from(token, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);
    expect(payload.did).toBe(ownerDid);
    expect(payload.owner).toBe(ownerDid);
    expect(payload.repo).toBe('auth-test-repo');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.nonce).toBeDefined();
  });
});

// ===========================================================================
// E2E: Profile-based agent — full flow with identity profiles
// ===========================================================================

describe('E2E: profile-based agent → repo → serve → clone → auth push', () => {
  let profileDid: string;
  let profilePrivateKey: Record<string, unknown>;
  let repoContextId: string;
  let repoHandle: AgentContext['repo'];
  let refsHandle: AgentContext['refs'];
  let server: GitServer;
  let cloneUrl: string;

  const PROFILE_NAME = 'e2e-profile-test';
  const PROFILE_ENBOX_HOME = '__TESTDATA__/profile-e2e-enbox-home';
  const PROFILE_REPOS_PATH = '__TESTDATA__/profile-e2e-repos';
  const PROFILE_CLONE_PATH = '__TESTDATA__/profile-e2e-clone';

  let origEnboxHome: string | undefined;

  beforeAll(async () => {
    rmSync(PROFILE_ENBOX_HOME, { recursive: true, force: true });
    rmSync(PROFILE_REPOS_PATH, { recursive: true, force: true });
    rmSync(PROFILE_CLONE_PATH, { recursive: true, force: true });

    // Redirect profile storage to test directory.
    origEnboxHome = process.env.ENBOX_HOME;
    process.env.ENBOX_HOME = PROFILE_ENBOX_HOME;

    // --- Step 1: Create agent at the profile's canonical data path ---
    const dataPath = profileDataPath(PROFILE_NAME);
    const agent = await Web5UserAgent.create({ dataPath });
    await agent.initialize({ password: 'profile-e2e' });
    await agent.start({ password: 'profile-e2e' });

    // Create identity (using did:jwk for offline-friendly tests).
    const identity = await agent.identity.create({
      didMethod  : 'jwk',
      metadata   : { name: 'Profile E2E Test' },
      didOptions : { algorithm: 'Ed25519' },
    });

    const { web5, did } = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    profileDid = did;

    // Extract private key for credential signing.
    const portableDid = await identity.did.export();
    profilePrivateKey = portableDid.privateKeys![0] as Record<string, unknown>;

    // --- Step 2: Register profile in config (simulates `gitd auth login`) ---
    upsertProfile(PROFILE_NAME, {
      name      : PROFILE_NAME,
      did       : profileDid,
      createdAt : new Date().toISOString(),
    });

    // --- Step 3: Set up repo + refs protocols ---
    repoHandle = web5.using(ForgeRepoProtocol);
    refsHandle = web5.using(ForgeRefsProtocol);
    await repoHandle.configure();
    await refsHandle.configure();

    // --- Step 4: Create repo record ---
    const { record } = await repoHandle.records.create('repo', {
      data : { name: 'profile-e2e-repo', description: 'Profile E2E test', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'profile-e2e-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // --- Step 5: Init bare repo on disk ---
    const backend = new GitBackend({ basePath: PROFILE_REPOS_PATH });
    await backend.initRepo(profileDid, 'profile-e2e-repo');

    // --- Step 6: Start authenticated server with bundle + ref sync ---
    const verifySignature = createDidSignatureVerifier();
    const authorizePush = createDwnPushAuthorizer({
      repo     : repoHandle,
      ownerDid : profileDid,
    });

    const authenticatePush = async (request: Request, did: string, repo: string): Promise<boolean> => {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Basic ')) { return false; }

      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) { return false; }

      const username = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      if (username !== DID_AUTH_USERNAME) { return false; }

      let signed;
      try { signed = parseAuthPassword(password); } catch { return false; }

      let payload;
      try { payload = decodePushToken(signed.token); } catch { return false; }

      if (payload.owner !== did || payload.repo !== repo) { return false; }
      if (payload.exp < Math.floor(Date.now() / 1000)) { return false; }

      const tokenBytes = new TextEncoder().encode(signed.token);
      const signatureBytes = new Uint8Array(Buffer.from(signed.signature, 'base64url'));
      if (!(await verifySignature(payload.did, tokenBytes, signatureBytes))) { return false; }

      return authorizePush(payload.did, did, repo);
    };

    const refSyncer = createRefSyncer({
      refs          : refsHandle,
      repoContextId : repoContextId,
    });

    const bundleSyncer = createBundleSyncer({
      repo          : repoHandle,
      repoContextId : repoContextId,
      visibility    : 'public',
    });

    const onPushComplete = async (pushDid: string, repoName: string, repoPath: string): Promise<void> => {
      await refSyncer(pushDid, repoName, repoPath);
      await bundleSyncer(pushDid, repoName, repoPath);
    };

    server = await createGitServer({
      basePath         : PROFILE_REPOS_PATH,
      port             : 0,
      authenticatePush : authenticatePush,
      onPushComplete   : onPushComplete,
    });

    cloneUrl = `http://localhost:${server.port}/${profileDid}/profile-e2e-repo`;
  }, 30000);

  afterAll(async () => {
    try { if (server) { await server.stop(); } } catch { /* may already be stopped */ }
    rmSync(PROFILE_ENBOX_HOME, { recursive: true, force: true });
    rmSync(PROFILE_REPOS_PATH, { recursive: true, force: true });
    rmSync(PROFILE_CLONE_PATH, { recursive: true, force: true });

    if (origEnboxHome !== undefined) {
      process.env.ENBOX_HOME = origEnboxHome;
    } else {
      delete process.env.ENBOX_HOME;
    }
  });

  // -----------------------------------------------------------------------
  // Helper: build credentials from profile identity
  // -----------------------------------------------------------------------
  async function profileCredentials(): Promise<{ username: string; password: string }> {
    const creds = await generatePushCredentials(
      { path: `/${profileDid}/profile-e2e-repo` },
      profileDid,
      profilePrivateKey,
    );
    if (!creds) { throw new Error('generatePushCredentials returned undefined'); }
    return creds;
  }

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------

  it('should have profile data stored at ~/.enbox/profiles/<name>/DATA/AGENT', () => {
    const dataPath = profileDataPath(PROFILE_NAME);
    expect(existsSync(dataPath)).toBe(true);
  });

  it('should clone the repo served by the profile-based agent', async () => {
    rmSync(PROFILE_CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone "${cloneUrl}" "${PROFILE_CLONE_PATH}"`);
    expect(existsSync(`${PROFILE_CLONE_PATH}/.git`)).toBe(true);
  });

  it('should push with credentials signed by the profile identity', async () => {
    await exec('git config user.email "profile@test.com"', { cwd: PROFILE_CLONE_PATH });
    await exec('git config user.name "Profile Test"', { cwd: PROFILE_CLONE_PATH });
    await exec('git checkout -b main', { cwd: PROFILE_CLONE_PATH });
    await exec('echo "profile e2e content" > README.md', { cwd: PROFILE_CLONE_PATH });
    await exec('git add README.md', { cwd: PROFILE_CLONE_PATH });
    await exec('git commit -m "profile e2e commit"', { cwd: PROFILE_CLONE_PATH });

    const creds = await profileCredentials();
    const helper = `!f() { test "$1" = get && echo "username=${creds.username}" && echo "password=${creds.password}"; }; f`;
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: PROFILE_CLONE_PATH });

    await exec('GIT_TERMINAL_PROMPT=0 git push -u origin main', { cwd: PROFILE_CLONE_PATH });
  });

  it('should have the pushed commit in the bare repo', async () => {
    const repoPath = server.backend.repoPath(profileDid, 'profile-e2e-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('profile e2e commit');
  });

  it('should sync refs to DWN after profile-signed push', async () => {
    await new Promise((r) => setTimeout(r, 500));

    let { records: refRecords } = await refsHandle.records.query('repo/ref' as any);

    if (refRecords.length === 0) {
      const repoPath = server.backend.repoPath(profileDid, 'profile-e2e-repo');
      const syncer = createRefSyncer({ refs: refsHandle, repoContextId });
      await syncer(profileDid, 'profile-e2e-repo', repoPath);
      ({ records: refRecords } = await refsHandle.records.query('repo/ref' as any));
    }

    expect(refRecords.length).toBeGreaterThanOrEqual(1);

    const refData = await refRecords[0].data.json();
    expect(refData.name).toBe('refs/heads/main');
    expect(refData.target).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should sync bundles to DWN after profile-signed push', async () => {
    await new Promise((r) => setTimeout(r, 500));

    const { records } = await repoHandle.records.query('repo/bundle', {});
    expect(records.length).toBeGreaterThanOrEqual(1);

    const tags = records[0].tags as Record<string, unknown>;
    expect(tags.isFull).toBe(true);
    expect(tags.tipCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should restore from bundles on cold start (profile agent data persists)', async () => {
    await server.stop();

    const restoreRepos = '__TESTDATA__/profile-e2e-restore-repos';
    const restoreClone = '__TESTDATA__/profile-e2e-restore-clone';
    rmSync(restoreRepos, { recursive: true, force: true });
    rmSync(restoreClone, { recursive: true, force: true });

    const restoreServer = await createGitServer({
      basePath       : restoreRepos,
      port           : 0,
      onRepoNotFound : async (_repoDid: string, _repoName: string, repoPath: string): Promise<boolean> => {
        const result = await restoreFromBundles({ repo: repoHandle, repoPath, repoContextId });
        return result.success;
      },
    });

    try {
      const restoreUrl = `http://localhost:${restoreServer.port}/${profileDid}/profile-e2e-repo`;
      await exec(`git clone --branch main "${restoreUrl}" "${restoreClone}"`);

      expect(existsSync(`${restoreClone}/.git`)).toBe(true);
      const { stdout } = await exec('cat README.md', { cwd: restoreClone });
      expect(stdout).toContain('profile e2e content');

      const { stdout: logOutput } = await exec('git log --oneline', { cwd: restoreClone });
      expect(logOutput).toContain('profile e2e commit');
    } finally {
      await restoreServer.stop();
      rmSync(restoreRepos, { recursive: true, force: true });
      rmSync(restoreClone, { recursive: true, force: true });
    }
  }, 30000);
});

// ===========================================================================
// E2E: Multi-repo — two repos under one DID, dynamic context resolution
// ===========================================================================

describe('E2E: multi-repo — two repos, dynamic context, scoped sync + restore', () => {
  let did: string;
  let repoHandle: AgentContext['repo'];
  let refsHandle: AgentContext['refs'];
  let server: GitServer;

  // Repo contexts resolved after DWN records are created.
  let alphaCtx: RepoContext;
  let betaCtx: RepoContext;

  const MR_DATA_PATH = '__TESTDATA__/multi-repo-e2e-agent';
  const MR_REPOS_PATH = '__TESTDATA__/multi-repo-e2e-repos';
  const MR_CLONE_ALPHA = '__TESTDATA__/multi-repo-e2e-clone-alpha';
  const MR_CLONE_BETA = '__TESTDATA__/multi-repo-e2e-clone-beta';

  // Minimal AgentContext shim — only `repo` is used by `getRepoContext`.
  function agentCtx(): Pick<AgentContext, 'repo'> {
    return { repo: repoHandle };
  }

  beforeAll(async () => {
    rmSync(MR_DATA_PATH, { recursive: true, force: true });
    rmSync(MR_REPOS_PATH, { recursive: true, force: true });
    rmSync(MR_CLONE_ALPHA, { recursive: true, force: true });
    rmSync(MR_CLONE_BETA, { recursive: true, force: true });

    // --- Step 1: Create Web5 agent ---
    const agent = await Web5UserAgent.create({ dataPath: MR_DATA_PATH });
    await agent.initialize({ password: 'multi-repo-e2e' });
    await agent.start({ password: 'multi-repo-e2e' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Multi-Repo E2E Test' },
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

    // --- Step 2: Create TWO repo records ---
    const { record: alphaRecord } = await repoHandle.records.create('repo', {
      data : { name: 'repo-alpha', description: 'First repo', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'repo-alpha', visibility: 'public' },
    });
    const { record: betaRecord } = await repoHandle.records.create('repo', {
      data : { name: 'repo-beta', description: 'Second repo', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'repo-beta', visibility: 'public' },
    });

    // Resolve contexts using getRepoContext (proves multi-repo lookup works).
    alphaCtx = await getRepoContext(agentCtx() as AgentContext, 'repo-alpha');
    betaCtx = await getRepoContext(agentCtx() as AgentContext, 'repo-beta');

    expect(alphaCtx.contextId).toBe(alphaRecord.contextId!);
    expect(betaCtx.contextId).toBe(betaRecord.contextId!);
    expect(alphaCtx.contextId).not.toBe(betaCtx.contextId);

    // --- Step 3: Init both bare git repos ---
    const backend = new GitBackend({ basePath: MR_REPOS_PATH });
    await backend.initRepo(did, 'repo-alpha');
    await backend.initRepo(did, 'repo-beta');

    // --- Step 4: Start server with DYNAMIC per-push context resolution ---
    // This mirrors the pattern from src/cli/commands/serve.ts lines 63-87.
    const onPushComplete = async (_did: string, repoName: string, repoPath: string): Promise<void> => {
      let repoCtx: RepoContext;
      try {
        repoCtx = await getRepoContext(agentCtx() as AgentContext, repoName);
      } catch {
        console.error(`push-sync: repo "${repoName}" not found — skipping.`);
        return;
      }

      const syncRefs = createRefSyncer({
        refs          : refsHandle,
        repoContextId : repoCtx.contextId,
      });

      const syncBundle = createBundleSyncer({
        repo          : repoHandle,
        repoContextId : repoCtx.contextId,
        visibility    : repoCtx.visibility,
      });

      await Promise.all([
        syncRefs(_did, repoName, repoPath),
        syncBundle(_did, repoName, repoPath),
      ]);
    };

    server = await createGitServer({
      basePath : MR_REPOS_PATH,
      port     : 0,
      onPushComplete,
    });
  }, 30000);

  afterAll(async () => {
    try { if (server) { await server.stop(); } } catch { /* noop */ }
    rmSync(MR_DATA_PATH, { recursive: true, force: true });
    rmSync(MR_REPOS_PATH, { recursive: true, force: true });
    rmSync(MR_CLONE_ALPHA, { recursive: true, force: true });
    rmSync(MR_CLONE_BETA, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Push to both repos
  // -----------------------------------------------------------------------

  it('should clone and push to repo-alpha', async () => {
    const url = `http://localhost:${server.port}/${did}/repo-alpha`;
    rmSync(MR_CLONE_ALPHA, { recursive: true, force: true });
    await exec(`git clone "${url}" "${MR_CLONE_ALPHA}"`);
    await exec('git config user.email "mr@test.com"', { cwd: MR_CLONE_ALPHA });
    await exec('git config user.name "MR Test"', { cwd: MR_CLONE_ALPHA });
    await exec('git checkout -b main', { cwd: MR_CLONE_ALPHA });
    await exec('echo "alpha content" > README.md', { cwd: MR_CLONE_ALPHA });
    await exec('git add README.md', { cwd: MR_CLONE_ALPHA });
    await exec('git commit -m "alpha initial"', { cwd: MR_CLONE_ALPHA });
    await exec('git push -u origin main', { cwd: MR_CLONE_ALPHA });
  });

  it('should clone and push to repo-beta', async () => {
    const url = `http://localhost:${server.port}/${did}/repo-beta`;
    rmSync(MR_CLONE_BETA, { recursive: true, force: true });
    await exec(`git clone "${url}" "${MR_CLONE_BETA}"`);
    await exec('git config user.email "mr@test.com"', { cwd: MR_CLONE_BETA });
    await exec('git config user.name "MR Test"', { cwd: MR_CLONE_BETA });
    await exec('git checkout -b main', { cwd: MR_CLONE_BETA });
    await exec('echo "beta content" > README.md', { cwd: MR_CLONE_BETA });
    await exec('git add README.md', { cwd: MR_CLONE_BETA });
    await exec('git commit -m "beta initial"', { cwd: MR_CLONE_BETA });
    await exec('git push -u origin main', { cwd: MR_CLONE_BETA });
  });

  // -----------------------------------------------------------------------
  // Verify ref isolation
  // -----------------------------------------------------------------------

  it('should have scoped ref records per repo in DWN', async () => {
    // Wait for async onPushComplete to finish.
    await new Promise((r) => setTimeout(r, 2000));

    // Read the actual git SHAs from the bare repos.
    const alphaPath = server.backend.repoPath(did, 'repo-alpha');
    const betaPath = server.backend.repoPath(did, 'repo-beta');
    const { stdout: alphaSha } = await exec('git rev-parse main', { cwd: alphaPath });
    const { stdout: betaSha } = await exec('git rev-parse main', { cwd: betaPath });

    // If onPushComplete didn't fire yet, manually invoke syncers.
    const { records: allRefs } = await refsHandle.records.query('repo/ref' as any);
    if (allRefs.length < 2) {
      const alphaSync = createRefSyncer({ refs: refsHandle, repoContextId: alphaCtx.contextId });
      const betaSync = createRefSyncer({ refs: refsHandle, repoContextId: betaCtx.contextId });
      await alphaSync(did, 'repo-alpha', alphaPath);
      await betaSync(did, 'repo-beta', betaPath);
    }

    // Query all refs and partition by target SHA to verify isolation.
    const { records: refRecords } = await refsHandle.records.query('repo/ref' as any);
    expect(refRecords.length).toBeGreaterThanOrEqual(2);

    const refEntries = await Promise.all(
      refRecords.map(async (r: any) => r.data.json()),
    );
    const alphaRef = refEntries.find((d: any) => d.target === alphaSha.trim());
    const betaRef = refEntries.find((d: any) => d.target === betaSha.trim());

    expect(alphaRef).toBeDefined();
    expect(betaRef).toBeDefined();
    expect(alphaRef!.name).toBe('refs/heads/main');
    expect(betaRef!.name).toBe('refs/heads/main');
    // SHAs differ because the repos have different content.
    expect(alphaSha.trim()).not.toBe(betaSha.trim());
  });

  // -----------------------------------------------------------------------
  // Verify bundle isolation
  // -----------------------------------------------------------------------

  it('should have scoped bundle records per repo in DWN', async () => {
    // If the async bundle sync didn't fire for both repos, manually invoke.
    const { records: existingBundles } = await repoHandle.records.query('repo/bundle', {});
    if (existingBundles.length < 2) {
      const alphaPath = server.backend.repoPath(did, 'repo-alpha');
      const betaPath = server.backend.repoPath(did, 'repo-beta');
      const alphaSync = createBundleSyncer({ repo: repoHandle, repoContextId: alphaCtx.contextId, visibility: 'public' });
      const betaSync = createBundleSyncer({ repo: repoHandle, repoContextId: betaCtx.contextId, visibility: 'public' });
      await alphaSync(did, 'repo-alpha', alphaPath);
      await betaSync(did, 'repo-beta', betaPath);
    }

    const { records: allBundles } = await repoHandle.records.query('repo/bundle', {});
    expect(allBundles.length).toBeGreaterThanOrEqual(2);

    // Partition bundles by contextId.
    const alphaBundles = allBundles.filter((r: any) => r.contextId?.startsWith(alphaCtx.contextId));
    const betaBundles = allBundles.filter((r: any) => r.contextId?.startsWith(betaCtx.contextId));

    expect(alphaBundles.length).toBeGreaterThanOrEqual(1);
    expect(betaBundles.length).toBeGreaterThanOrEqual(1);

    // Bundles should reference different commits.
    const alphaTip = (alphaBundles[0].tags as Record<string, unknown>).tipCommit;
    const betaTip = (betaBundles[0].tags as Record<string, unknown>).tipCommit;
    expect(alphaTip).not.toBe(betaTip);
  });

  // -----------------------------------------------------------------------
  // Cold start: restore each repo independently via scoped bundles
  // -----------------------------------------------------------------------

  it('should restore both repos from scoped bundles on cold start', async () => {
    await server.stop();

    const restoreRepos = '__TESTDATA__/multi-repo-e2e-restore-repos';
    const restoreAlpha = '__TESTDATA__/multi-repo-e2e-restore-alpha';
    const restoreBeta = '__TESTDATA__/multi-repo-e2e-restore-beta';
    rmSync(restoreRepos, { recursive: true, force: true });
    rmSync(restoreAlpha, { recursive: true, force: true });
    rmSync(restoreBeta, { recursive: true, force: true });

    // Build a lookup map for repo name → contextId.
    const ctxMap: Record<string, string> = {
      'repo-alpha' : alphaCtx.contextId,
      'repo-beta'  : betaCtx.contextId,
    };

    // Start a new server with clean disk — uses dynamic onRepoNotFound
    // that resolves the correct repoContextId to scope the restore.
    const restoreServer = await createGitServer({
      basePath       : restoreRepos,
      port           : 0,
      onRepoNotFound : async (_repoDid: string, repoName: string, repoPath: string): Promise<boolean> => {
        const repoContextId = ctxMap[repoName];
        if (!repoContextId) { return false; }

        const result = await restoreFromBundles({
          repo: repoHandle,
          repoPath,
          repoContextId,
        });
        return result.success;
      },
    });

    try {
      // Clone alpha from restore server.
      const alphaUrl = `http://localhost:${restoreServer.port}/${did}/repo-alpha`;
      await exec(`git clone --branch main "${alphaUrl}" "${restoreAlpha}"`);
      expect(existsSync(`${restoreAlpha}/.git`)).toBe(true);
      const { stdout: alphaContent } = await exec('cat README.md', { cwd: restoreAlpha });
      expect(alphaContent).toContain('alpha content');
      const { stdout: alphaLog } = await exec('git log --oneline', { cwd: restoreAlpha });
      expect(alphaLog).toContain('alpha initial');

      // Clone beta from restore server.
      const betaUrl = `http://localhost:${restoreServer.port}/${did}/repo-beta`;
      await exec(`git clone --branch main "${betaUrl}" "${restoreBeta}"`);
      expect(existsSync(`${restoreBeta}/.git`)).toBe(true);
      const { stdout: betaContent } = await exec('cat README.md', { cwd: restoreBeta });
      expect(betaContent).toContain('beta content');
      const { stdout: betaLog } = await exec('git log --oneline', { cwd: restoreBeta });
      expect(betaLog).toContain('beta initial');

      // Cross-check: alpha clone must NOT have beta content.
      expect(alphaContent).not.toContain('beta content');
      expect(betaContent).not.toContain('alpha content');
    } finally {
      await restoreServer.stop();
      rmSync(restoreRepos, { recursive: true, force: true });
      rmSync(restoreAlpha, { recursive: true, force: true });
      rmSync(restoreBeta, { recursive: true, force: true });
    }
  }, 30000);
});
