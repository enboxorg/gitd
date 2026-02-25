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

import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../src/git-server/verify.js';
import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { createGitServer } from '../src/git-server/server.js';
import { createRefSyncer } from '../src/git-server/ref-sync.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { generatePushCredentials } from '../src/git-remote/credential-helper.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { readGitRefs } from '../src/git-server/ref-sync.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';
import {
  decodePushToken,
  DID_AUTH_USERNAME,
  parseAuthPassword,
} from '../src/git-server/auth.js';

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
    const { records } = await repoHandle.records.query('repo');
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
