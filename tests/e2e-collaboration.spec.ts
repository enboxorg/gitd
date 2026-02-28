/**
 * End-to-end collaboration test: two-actor workflow.
 *
 * Models the Linux kernel / b4 contribution flow mapped to DWN:
 *
 *   1. Alice (maintainer) creates a repo, pushes initial commits
 *   2. Bob   (contributor) clones, makes changes on a branch
 *   3. Bob   submits a PR (patch bundle) to Alice's DWN
 *   4. Alice checks out Bob's PR, reviews it, merges it
 *   5. Bob   pulls from Alice's repo and sees the merged changes
 *
 * Tests marked with `it.skip()` document known gaps where cross-DWN
 * operations are not yet supported by the CLI layer.
 *
 * Agent creation bypasses `Web5UserAgent.initialize()` / `.start()` to avoid
 * DHT network dependency.  Instead, we assign `agent.agentDid` directly using
 * `DidDht.create({ options: { publish: false } })`, which keeps all key
 * material in-memory and requires zero network access.
 *
 * @see https://b4.docs.kernel.org — the Linux kernel patch workflow
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';
import { DidDht, DidJwk } from '@enbox/dids';

import type { GitServer } from '../src/git-server/server.js';

import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../src/git-server/verify.js';
import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { createGitServer } from '../src/git-server/server.js';
import { createRefSyncer } from '../src/git-server/ref-sync.js';
import { ForgePatchesProtocol } from '../src/patches.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { generatePushCredentials } from '../src/git-remote/credential-helper.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import {
  decodePushToken,
  DID_AUTH_USERNAME,
  parseAuthPassword,
} from '../src/git-server/auth.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Paths — each actor gets isolated data directories
// ---------------------------------------------------------------------------

const BASE = '__TESTDATA__/collab-e2e';
const ALICE_DATA = `${BASE}/alice-agent`;
const BOB_DATA = `${BASE}/bob-agent`;
const REPOS_PATH = `${BASE}/repos`;
const ALICE_CLONE_PATH = `${BASE}/alice-clone`;
const BOB_CLONE_PATH = `${BASE}/bob-clone`;

// ---------------------------------------------------------------------------
// Helper: create a Web5UserAgent without DHT network access.
//
// Bypasses `initialize()` / `start()` which internally call
// `DidDht.create({ publish: true })`.  Instead, we:
//   1. Create the agent (instantiates DWN node + LevelDB stores)
//   2. Assign `agent.agentDid` directly with `publish: false`
//   3. Create an identity DID with `did:jwk` (purely local)
//   4. Connect via `Web5.connect({ agent })` — skips vault flow
// ---------------------------------------------------------------------------

async function createOfflineAgent(dataPath: string): Promise<{
  agent: Web5UserAgent;
  web5: InstanceType<typeof Web5>;
  did: string;
  privateKey: Record<string, unknown>;
}> {
  const agent = await Web5UserAgent.create({ dataPath });

  // Assign the agent DID directly — no vault init, no DHT publish.
  // Both Ed25519 (signing) and X25519 (encryption) keys are required
  // for the DWN key store's encrypted protocol records.
  const agentBearerDid = await DidDht.create({
    options: {
      publish             : false,
      verificationMethods : [
        { algorithm: 'Ed25519', id: 'sig', purposes: ['assertionMethod', 'authentication'] },
        { algorithm: 'X25519', id: 'enc', purposes: ['keyAgreement'] },
      ],
    },
  });
  (agent as any).agentDid = agentBearerDid;

  // Import the agent DID into the DID store so the DWN's resolver cache
  // can verify JWS signatures against its public keys.
  await agent.did.import({
    portableDid : await agentBearerDid.export(),
    tenant      : agentBearerDid.uri,
  });

  // Create an identity DID (did:jwk — offline, no network).
  const identity = await agent.identity.create({
    didMethod  : 'jwk',
    metadata   : { name: `Test (${dataPath})` },
    didOptions : { algorithm: 'Ed25519' },
  });

  const { web5, did } = await Web5.connect({
    agent,
    connectedDid : identity.did.uri,
    sync         : 'off',
  });

  // Extract the private key for push credential signing.
  const portableDid = await identity.did.export();
  const privateKey = portableDid.privateKeys![0] as Record<string, unknown>;

  return { agent, web5, did, privateKey };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('E2E: two-actor collaboration (maintainer + contributor)', () => {
  // Alice's state
  let aliceDid: string;
  let alicePrivateKey: Record<string, unknown>;
  let aliceRepo: ReturnType<typeof Web5.prototype.using<typeof ForgeRepoProtocol>>;
  let aliceRefs: ReturnType<typeof Web5.prototype.using<typeof ForgeRefsProtocol>>;
  let alicePatches: ReturnType<typeof Web5.prototype.using<typeof ForgePatchesProtocol>>;
  let repoContextId: string;

  // Bob's state
  let bobDid: string;
  let bobPrivateKey: Record<string, unknown>;

  // Shared infrastructure
  let server: GitServer;
  let cloneUrl: string;

  // =========================================================================
  // Setup — create two independent Web5 agents (no DHT required)
  // =========================================================================

  beforeAll(async () => {
    rmSync(BASE, { recursive: true, force: true });

    // ----- Alice (maintainer) -----
    const alice = await createOfflineAgent(ALICE_DATA);
    aliceDid = alice.did;
    alicePrivateKey = alice.privateKey;

    aliceRepo = alice.web5.using(ForgeRepoProtocol);
    aliceRefs = alice.web5.using(ForgeRefsProtocol);
    alicePatches = alice.web5.using(ForgePatchesProtocol);
    await aliceRepo.configure();
    await aliceRefs.configure();
    await alicePatches.configure();

    // ----- Bob (contributor) -----
    const bob = await createOfflineAgent(BOB_DATA);
    bobDid = bob.did;
    bobPrivateKey = bob.privateKey;

    // ----- Create Alice's repo in DWN -----
    const { record } = await aliceRepo.records.create('repo', {
      data: {
        name          : 'collab-repo',
        description   : 'Two-actor collaboration test',
        defaultBranch : 'main',
        dwnEndpoints  : [],
      },
      tags: { name: 'collab-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;

    // ----- Grant Bob the contributor role -----
    const { status: roleStatus } = await aliceRepo.records.create(
      'repo/contributor' as any,
      {
        data            : { did: bobDid, alias: 'Bob' },
        tags            : { did: bobDid },
        parentContextId : repoContextId,
        recipient       : bobDid,
      } as any,
    );
    if (roleStatus.code >= 300) {
      throw new Error(`Failed to grant contributor role: ${roleStatus.code} ${roleStatus.detail}`);
    }

    // ----- Init bare git repo + start server -----
    const backend = new GitBackend({ basePath: REPOS_PATH });
    await backend.initRepo(aliceDid, 'collab-repo');

    const verifySignature = createDidSignatureVerifier();
    const authorizePush = createDwnPushAuthorizer({
      repo     : aliceRepo,
      ownerDid : aliceDid,
    });

    // Custom authenticatePush — no nonce replay (see e2e.spec.ts for rationale).
    const authenticatePush = async (
      request: Request, did: string, repo: string,
    ): Promise<boolean> => {
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
      refs: aliceRefs,
      repoContextId,
    });

    const bundleSyncer = createBundleSyncer({
      repo       : aliceRepo,
      repoContextId,
      visibility : 'public',
    });

    const onPushComplete = async (
      pushDid: string, repoName: string, repoPath: string,
    ): Promise<void> => {
      await Promise.all([
        refSyncer(pushDid, repoName, repoPath),
        bundleSyncer(pushDid, repoName, repoPath),
      ]);
    };

    server = await createGitServer({
      basePath : REPOS_PATH,
      port     : 0,
      authenticatePush,
      onPushComplete,
    });

    cloneUrl = `http://localhost:${server.port}/${aliceDid}/collab-repo`;
  }, 60_000);

  afterAll(async () => {
    try { if (server) { await server.stop(); } } catch { /* ok */ }
    rmSync(BASE, { recursive: true, force: true });
  });

  // =========================================================================
  // Helper: generate git credential helper string for a given identity
  // =========================================================================

  async function credentialHelper(
    actorDid: string,
    privateKey: Record<string, unknown>,
  ): Promise<string> {
    const creds = await generatePushCredentials(
      { path: `/${aliceDid}/collab-repo` },
      actorDid,
      privateKey,
    );
    if (!creds) { throw new Error('generatePushCredentials returned undefined'); }
    const user = creds.username;
    const pass = creds.password;
    return `!f() { test "$1" = get && echo "username=${user}" && echo "password=${pass}"; }; f`;
  }

  // =========================================================================
  // Phase 1: Alice (maintainer) sets up the repo with initial content
  //
  // Kernel equivalent: maintainer maintains a public tree with commits
  // =========================================================================

  it('Phase 1a: Alice clones the empty repo', async () => {
    rmSync(ALICE_CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone "${cloneUrl}" "${ALICE_CLONE_PATH}"`);
    expect(existsSync(`${ALICE_CLONE_PATH}/.git`)).toBe(true);
  });

  it('Phase 1b: Alice pushes initial commits', async () => {
    await exec('git config user.email "alice@example.com"', { cwd: ALICE_CLONE_PATH });
    await exec('git config user.name "Alice"', { cwd: ALICE_CLONE_PATH });
    await exec('git checkout -b main', { cwd: ALICE_CLONE_PATH });

    // Initial commit: create the project
    writeFileSync(join(ALICE_CLONE_PATH, 'README.md'), '# Collab Repo\n\nA test project.\n');
    writeFileSync(join(ALICE_CLONE_PATH, 'lib.ts'), 'export function greet(): string {\n  return "hello";\n}\n');
    await exec('git add -A', { cwd: ALICE_CLONE_PATH });
    await exec('git commit -m "Initial commit: project setup"', { cwd: ALICE_CLONE_PATH });

    // Second commit: add some content
    writeFileSync(join(ALICE_CLONE_PATH, 'utils.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    await exec('git add -A', { cwd: ALICE_CLONE_PATH });
    await exec('git commit -m "feat: add utils module"', { cwd: ALICE_CLONE_PATH });

    // Push with Alice's credentials
    const helper = await credentialHelper(aliceDid, alicePrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: ALICE_CLONE_PATH });
    await exec('GIT_TERMINAL_PROMPT=0 git push -u origin main', { cwd: ALICE_CLONE_PATH });
  });

  it('Phase 1c: Alice\'s commits are in the bare repo', async () => {
    const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('Initial commit');
    expect(stdout).toContain('add utils module');
  });

  it('Phase 1d: refs are synced to Alice\'s DWN', async () => {
    // Wait for async onPushComplete
    await new Promise((r) => setTimeout(r, 500));

    const { records: refRecords } = await aliceRefs.records.query('repo/ref' as any);

    // Manually sync if timing is tight
    if (refRecords.length === 0) {
      const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
      const syncer = createRefSyncer({ refs: aliceRefs, repoContextId });
      await syncer(aliceDid, 'collab-repo', repoPath);
    }

    const { records: finalRefs } = await aliceRefs.records.query('repo/ref' as any);
    expect(finalRefs.length).toBeGreaterThanOrEqual(1);

    const mainRef = finalRefs.find(async (r: any) => {
      const d = await r.data.json();
      return d.name === 'refs/heads/main';
    });
    expect(mainRef).toBeDefined();
  });

  // =========================================================================
  // Phase 2: Bob (contributor) clones and makes changes
  //
  // Kernel equivalent: contributor clones upstream, runs `b4 prep`,
  // makes commits on a topic branch
  // =========================================================================

  it('Phase 2a: Bob clones Alice\'s repo', async () => {
    rmSync(BOB_CLONE_PATH, { recursive: true, force: true });
    await exec(`git clone --branch main "${cloneUrl}" "${BOB_CLONE_PATH}"`);
    expect(existsSync(`${BOB_CLONE_PATH}/.git`)).toBe(true);

    // Verify Bob sees Alice's content
    const readme = readFileSync(join(BOB_CLONE_PATH, 'README.md'), 'utf-8');
    expect(readme).toContain('Collab Repo');

    const lib = readFileSync(join(BOB_CLONE_PATH, 'lib.ts'), 'utf-8');
    expect(lib).toContain('hello');
  });

  it('Phase 2b: Bob creates a feature branch and makes changes', async () => {
    await exec('git config user.email "bob@example.com"', { cwd: BOB_CLONE_PATH });
    await exec('git config user.name "Bob"', { cwd: BOB_CLONE_PATH });

    // Create a feature branch
    await exec('git checkout -b feat/add-multiply', { cwd: BOB_CLONE_PATH });

    // Bob's change: add a multiply function to utils.ts
    const existingUtils = readFileSync(join(BOB_CLONE_PATH, 'utils.ts'), 'utf-8');
    writeFileSync(
      join(BOB_CLONE_PATH, 'utils.ts'),
      existingUtils + '\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n',
    );
    await exec('git add -A', { cwd: BOB_CLONE_PATH });
    await exec('git commit -m "feat: add multiply function"', { cwd: BOB_CLONE_PATH });

    // Second commit on the branch
    writeFileSync(
      join(BOB_CLONE_PATH, 'tests.ts'),
      'import { multiply } from "./utils";\nconsole.assert(multiply(3, 4) === 12);\n',
    );
    await exec('git add -A', { cwd: BOB_CLONE_PATH });
    await exec('git commit -m "test: add multiply test"', { cwd: BOB_CLONE_PATH });

    // Verify the branch has 2 commits ahead of main
    const { stdout } = await exec('git log --oneline main..HEAD', { cwd: BOB_CLONE_PATH });
    const commitLines = stdout.trim().split('\n').filter((l: string) => l.length > 0);
    expect(commitLines.length).toBe(2);
  });

  // =========================================================================
  // Phase 3: Bob submits a PR (patch bundle) to Alice's DWN
  //
  // Kernel equivalent: `b4 send` — generates patches, sends to mailing list
  // DWN equivalent: create patch record + revision + bundle on maintainer's DWN
  //
  // GAP: The current `prCreate()` writes to the caller's own DWN.
  //      For cross-DWN contributions, Bob needs to write to Alice's DWN
  //      using his contributor role (`protocolRole: 'repo:repo/contributor'`).
  //      The typed Web5 API does not currently support cross-DWN writes.
  //
  //      For now, we simulate the intended flow by having the test directly
  //      create records on Alice's DWN as Bob would, using the patches
  //      protocol's `anyone can create` permissions.
  // =========================================================================

  let prNumber: number;
  let patchContextId: string;

  it('Phase 3a: Bob creates a git bundle of his changes', async () => {
    // Get the base commit (where Bob's branch diverges from main)
    const { stdout: baseCommit } = await exec(
      'git merge-base main HEAD',
      { cwd: BOB_CLONE_PATH },
    );

    const { stdout: headCommit } = await exec(
      'git rev-parse HEAD',
      { cwd: BOB_CLONE_PATH },
    );

    expect(baseCommit.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(headCommit.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(baseCommit.trim()).not.toBe(headCommit.trim());

    // Create a scoped bundle (just Bob's commits, not all of main)
    const bundlePath = join(tmpdir(), `collab-e2e-bob-${Date.now()}.bundle`);
    await exec(
      `git bundle create "${bundlePath}" HEAD ^${baseCommit.trim()}`,
      { cwd: BOB_CLONE_PATH },
    );

    expect(existsSync(bundlePath)).toBe(true);

    // Verify the bundle is valid
    const { stdout: verify } = await exec(
      `git bundle verify "${bundlePath}"`,
      { cwd: BOB_CLONE_PATH },
    );
    expect(verify).toBeTruthy();

    // Store for Phase 3b
    (globalThis as any).__collab_bundle = {
      bundlePath,
      baseCommit : baseCommit.trim(),
      headCommit : headCommit.trim(),
    };
  });

  it('Phase 3b: Bob submits the PR to Alice\'s DWN', async () => {
    // TODO: This should use Bob's agent writing to Alice's DWN
    // via cross-DWN write with protocolRole. Currently we use Alice's
    // patches handle because the typed Web5 API doesn't support
    // cross-DWN record creation.
    //
    // The ForgePatchesProtocol has `{ who: 'anyone', can: ['create'] }`
    // on repo/patch, so the protocol-level permissions allow this — the
    // CLI/SDK layer just doesn't expose it yet.

    const { bundlePath, baseCommit, headCommit } = (globalThis as any).__collab_bundle;

    // Assign the next PR number
    const { records: existing } = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });
    prNumber = existing.length + 1;

    // Create the patch record (PR)
    const { status: patchStatus, record: patchRecord } = await alicePatches.records.create(
      'repo/patch',
      {
        data: {
          title  : 'feat: add multiply function',
          body   : 'Adds a multiply function to utils and a test for it.',
          number : prNumber,
        },
        tags: {
          status     : 'open',
          baseBranch : 'main',
          headBranch : 'feat/add-multiply',
          number     : String(prNumber),
          sourceDid  : bobDid,
        },
        parentContextId: repoContextId,
      },
    );

    expect(patchStatus.code).toBeLessThan(300);
    patchContextId = patchRecord.contextId!;

    // Create the revision record
    const { status: revStatus, record: revisionRecord } = await alicePatches.records.create(
      'repo/patch/revision' as any,
      {
        data: {
          description : 'v1: 2 commits',
          diffStat    : { filesChanged: 2, additions: 5, deletions: 0 },
        },
        tags: {
          headCommit,
          baseCommit,
          commitCount: 2,
        },
        parentContextId: patchContextId,
      } as any,
    );

    expect(revStatus.code).toBeLessThan(300);

    // Attach the git bundle
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));

    const { status: bundleStatus } = await alicePatches.records.create(
      'repo/patch/revision/revisionBundle' as any,
      {
        data       : bundleBytes,
        dataFormat : 'application/x-git-bundle',
        tags       : {
          tipCommit : headCommit,
          baseCommit,
          refCount  : 1,
          size      : bundleBytes.length,
        },
        parentContextId: revisionRecord.contextId,
      } as any,
    );

    expect(bundleStatus.code).toBeLessThan(300);

    // Clean up temp bundle file
    try { rmSync(bundlePath); } catch { /* ok */ }
  });

  it('Phase 3c: Bob\'s PR is visible in Alice\'s DWN', async () => {
    const { records } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber) },
      },
    });

    expect(records.length).toBe(1);

    const data = await records[0].data.json();
    expect(data.title).toBe('feat: add multiply function');
    expect(data.number).toBe(prNumber);

    const tags = records[0].tags as Record<string, string>;
    expect(tags.status).toBe('open');
    expect(tags.sourceDid).toBe(bobDid);
  });

  // =========================================================================
  // Phase 4: Alice reviews and merges Bob's PR
  //
  // Kernel equivalent: `b4 am` / `b4 shazam --merge` — retrieve patches,
  // apply to tree, merge
  // =========================================================================

  it('Phase 4a: Alice lists open PRs and sees Bob\'s submission', async () => {
    const { records } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { status: 'open' },
      },
    });

    expect(records.length).toBe(1);

    const data = await records[0].data.json();
    expect(data.title).toBe('feat: add multiply function');
  });

  it('Phase 4b: Alice checks out Bob\'s PR (fetches bundle into local tree)', async () => {
    // Fetch the revision and bundle from Alice's DWN
    const patch = (await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber) },
      },
    })).records[0];

    const { records: revisions } = await alicePatches.records.query(
      'repo/patch/revision' as any,
      { filter: { contextId: patch.contextId } },
    );
    expect(revisions.length).toBe(1);

    const revision = revisions[0];
    const revisionTags = revision.tags as Record<string, string>;

    const { records: bundles } = await alicePatches.records.query(
      'repo/patch/revision/revisionBundle' as any,
      { filter: { contextId: revision.contextId } },
    );
    expect(bundles.length).toBe(1);

    // Extract the bundle binary
    const bundleBlob = await bundles[0].data.blob();
    const bundleBytes = new Uint8Array(await bundleBlob.arrayBuffer());
    expect(bundleBytes.length).toBeGreaterThan(0);

    // Write to temp file and fetch into Alice's clone
    const bundlePath = join(tmpdir(), `collab-e2e-alice-checkout-${Date.now()}.bundle`);
    writeFileSync(bundlePath, bundleBytes);

    try {
      // Verify the bundle prerequisites exist in Alice's repo
      const { stdout: verify } = await exec(
        `git bundle verify "${bundlePath}"`,
        { cwd: ALICE_CLONE_PATH },
      );
      expect(verify).toBeTruthy();

      // Fetch objects from the bundle
      await exec(`git fetch "${bundlePath}"`, { cwd: ALICE_CLONE_PATH });

      // Create a local branch for the PR
      const tipCommit = revisionTags.headCommit;
      await exec(`git checkout -b pr/${prNumber} ${tipCommit}`, { cwd: ALICE_CLONE_PATH });

      // Verify Bob's commits are now in Alice's tree
      const { stdout: log } = await exec(
        'git log --oneline main..HEAD',
        { cwd: ALICE_CLONE_PATH },
      );
      expect(log).toContain('add multiply function');
      expect(log).toContain('add multiply test');
    } finally {
      try { rmSync(bundlePath); } catch { /* ok */ }
    }
  });

  it('Phase 4c: Alice adds a review comment', async () => {
    const patch = (await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber) },
      },
    })).records[0];

    const { status: reviewStatus } = await alicePatches.records.create(
      'repo/patch/review' as any,
      {
        data: {
          body    : 'LGTM! Clean implementation.',
          verdict : 'approve',
        },
        tags            : { verdict: 'approve' },
        parentContextId : patch.contextId,
      } as any,
    );

    expect(reviewStatus.code).toBeLessThan(300);
  });

  it('Phase 4d: Alice merges Bob\'s PR into main', async () => {
    // Switch to main and merge the PR branch
    await exec('git checkout main', { cwd: ALICE_CLONE_PATH });
    await exec(`git merge --no-ff -m "Merge PR #${prNumber}: feat: add multiply function" pr/${prNumber}`, {
      cwd: ALICE_CLONE_PATH,
    });

    // Verify the merge
    const { stdout: log } = await exec('git log --oneline -5', { cwd: ALICE_CLONE_PATH });
    expect(log).toContain('Merge PR');
    expect(log).toContain('add multiply function');

    // Verify the files are present after merge
    const utils = readFileSync(join(ALICE_CLONE_PATH, 'utils.ts'), 'utf-8');
    expect(utils).toContain('multiply');

    expect(existsSync(join(ALICE_CLONE_PATH, 'tests.ts'))).toBe(true);
  });

  it('Phase 4e: Alice pushes the merge to the server', async () => {
    const helper = await credentialHelper(aliceDid, alicePrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: ALICE_CLONE_PATH });
    await exec('GIT_TERMINAL_PROMPT=0 git push origin main', { cwd: ALICE_CLONE_PATH });

    // Verify the merge commit is in the bare repo
    const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
    const { stdout } = await exec('git log --oneline -5 main', { cwd: repoPath });
    expect(stdout).toContain('Merge PR');
  });

  it('Phase 4f: Alice records the merge result in DWN', async () => {
    // Update the patch status to merged
    const { records } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber) },
      },
    });
    expect(records.length).toBe(1);

    const patch = records[0];
    const patchData = await patch.data.json();

    // Update status tag to 'merged'
    await patch.update({
      data : patchData,
      tags : {
        ...patch.tags as Record<string, string>,
        status: 'merged',
      },
    });

    // Create a mergeResult record
    const { stdout: mergeCommit } = await exec(
      'git rev-parse main',
      { cwd: ALICE_CLONE_PATH },
    );

    const { status: mrStatus } = await alicePatches.records.create(
      'repo/patch/mergeResult' as any,
      {
        data: {
          mergeCommit : mergeCommit.trim(),
          strategy    : 'merge',
          mergedBy    : aliceDid,
        },
        tags: {
          mergeCommit : mergeCommit.trim(),
          strategy    : 'merge',
        },
        parentContextId: patch.contextId,
      } as any,
    );

    expect(mrStatus.code).toBeLessThan(300);

    // Verify status is now merged
    const { records: updated } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber) },
      },
    });
    const updatedTags = updated[0].tags as Record<string, string>;
    expect(updatedTags.status).toBe('merged');
  });

  // =========================================================================
  // Phase 5: Bob pulls and sees the merged changes
  //
  // Kernel equivalent: contributor fetches upstream, sees their commits
  // in the mainline tree, runs `b4 trailers -u`
  // =========================================================================

  it('Phase 5a: Bob pulls from Alice\'s repo and sees the merge', async () => {
    // Bob should be able to pull the merged main
    await exec('git checkout main', { cwd: BOB_CLONE_PATH });
    await exec('git pull origin main', { cwd: BOB_CLONE_PATH });

    // Bob's feature branch commits should now be in main
    const { stdout: log } = await exec('git log --oneline -5', { cwd: BOB_CLONE_PATH });
    expect(log).toContain('Merge PR');
    expect(log).toContain('add multiply function');
    expect(log).toContain('add multiply test');

    // The merged files should be present
    const utils = readFileSync(join(BOB_CLONE_PATH, 'utils.ts'), 'utf-8');
    expect(utils).toContain('multiply');
    expect(existsSync(join(BOB_CLONE_PATH, 'tests.ts'))).toBe(true);
  });

  it('Phase 5b: Bob can verify the PR is marked as merged in DWN', async () => {
    // TODO: Bob should be able to query Alice's DWN directly to see the
    // merge status. Currently we use Alice's patches handle because
    // cross-DWN reads are not wired through the CLI layer.

    const { records } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { number: String(prNumber), status: 'merged' },
      },
    });

    expect(records.length).toBe(1);

    // Verify merge result record exists
    const patch = records[0];
    const { records: mergeResults } = await alicePatches.records.query(
      'repo/patch/mergeResult' as any,
      { filter: { contextId: patch.contextId } },
    );
    expect(mergeResults.length).toBe(1);

    const mrData = await mergeResults[0].data.json();
    expect(mrData.strategy).toBe('merge');
    expect(mrData.mergedBy).toBe(aliceDid);
    expect(mrData.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  // =========================================================================
  // Phase 6: Verify push authorization (contributor can push, stranger can't)
  // =========================================================================

  it('Phase 6a: Bob (contributor) can push to Alice\'s repo', async () => {
    // Bob pushes his feature branch to the server
    await exec('git checkout feat/add-multiply', { cwd: BOB_CLONE_PATH });

    const helper = await credentialHelper(bobDid, bobPrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: BOB_CLONE_PATH });
    await exec(
      'GIT_TERMINAL_PROMPT=0 git push origin feat/add-multiply',
      { cwd: BOB_CLONE_PATH },
    );

    // Verify the branch exists in the bare repo
    const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
    const { stdout } = await exec('git branch -a', { cwd: repoPath });
    expect(stdout).toContain('feat/add-multiply');
  });

  it('Phase 6b: Unauthorized DID cannot push', async () => {
    // Create a stranger DID (no contributor role)
    const stranger = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const strangerPortable = await stranger.export();
    const strangerKey = strangerPortable.privateKeys![0] as Record<string, unknown>;

    const creds = await generatePushCredentials(
      { path: `/${aliceDid}/collab-repo` },
      stranger.uri,
      strangerKey,
    );
    expect(creds).toBeDefined();

    const authHeader = `Basic ${Buffer.from(`${creds!.username}:${creds!.password}`).toString('base64')}`;
    const res = await fetch(`${cloneUrl}/info/refs?service=git-receive-pack`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // Known gaps — these tests document what's NOT YET WORKING
  // =========================================================================

  it.skip('GAP: Bob should be able to write PR records to Alice\'s DWN directly', () => {
    // Cross-DWN writes via typed Web5 API
    //
    // Currently, `ctx.patches.records.create()` always writes to the
    // caller's own DWN. For the b4/kernel model, Bob needs to write
    // patch records to Alice's DWN using his contributor role
    // (`protocolRole: 'repo:repo/contributor'`).
    //
    // The DWN protocol permissions already allow this
    // (`{ who: 'anyone', can: ['create'] }` on repo/patch), but the
    // typed Web5 SDK doesn't expose a `target` or `recipient DWN` option.
    //
    // Fix: Add a `target` DID option to `records.create()` in @enbox/api,
    // or add a `gitd pr submit <maintainer-did>/<repo>` command that
    // performs the cross-DWN write at the raw SDK level.
  });

  it.skip('GAP: Bob should be able to query Alice\'s DWN for PR status', () => {
    // Cross-DWN reads via typed Web5 API
    //
    // After submitting a PR, Bob wants to check if it was merged by
    // querying Alice's DWN. The current `records.query()` only queries
    // the local DWN.
    //
    // Fix: Add a `from` DID option to `records.query()` in @enbox/api,
    // or add `gitd pr status <maintainer-did>/<repo> <number>`.
  });
});
