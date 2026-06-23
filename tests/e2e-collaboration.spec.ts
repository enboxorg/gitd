/**
 * End-to-end collaboration test: maintainer, contributor, and moderator workflow.
 *
 * Models the Linux kernel / b4 contribution flow mapped to DWN:
 *
 *   1. Alice (maintainer) creates a repo, pushes initial commits
 *   2. Bob   (contributor) clones, makes changes on a branch
 *   3. Bob   submits a PR (patch bundle) to Alice's DWN
 *   4. Alice checks out Bob's PR, reviews it, merges it
 *   5. Casey (moderator) can review but cannot push
 *   6. Bob   pulls from Alice's repo and sees the merged changes
 *
 * Both agents share a single DWN instance (multi-tenant) so that
 * cross-DWN writes (`store: false` → `processRequest({ target })`)
 * and cross-DWN queries work without an HTTP DWN server.
 *
 * Agent creation bypasses `EnboxUserAgent.initialize()` / `.start()` to avoid
 * DHT network dependency.  Instead, we assign `agent.agentDid` directly using
 * `DidDht.create({ options: { publish: false } })`, which keeps all key
 * material in-memory and requires zero network access.
 *
 * @see https://b4.docs.kernel.org — the Linux kernel patch workflow
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { cachePortableDid } from './helpers/identity.js';
import { createTestIdentity } from './helpers/identity.js';
import { DataStream } from '@enbox/dwn-sdk-js';
import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';
import { DidDht, DidJwk } from '@enbox/dids';

import type { AgentContext } from '../src/cli/agent.js';
import type { GitServer } from '../src/git-server/server.js';
import type { PushRefUpdate } from '../src/git-server/push-updates.js';

import { branchOwnerHash } from '../src/branch-state.js';
import { createBundleSyncer } from '../src/git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../src/git-server/verify.js';
import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { createGitServer } from '../src/git-server/server.js';
import { createRefSyncer } from '../src/git-server/ref-sync.js';
import { ForgeIssuesProtocol } from '../src/issues.js';
import { ForgePatchesProtocol } from '../src/patches.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { generatePushCredentials } from '../src/git-remote/credential-helper.js';
import { GitBackend } from '../src/git-server/git-backend.js';
import { issueCommand } from '../src/cli/commands/issue.js';
import { modCommand } from '../src/cli/commands/mod.js';
import { prCommand } from '../src/cli/commands/pr.js';
import { restoreFromBundles } from '../src/git-server/bundle-restore.js';
import { shortId } from '../src/github-shim/helpers.js';
import { syncRemoteBranchPush } from '../src/git-server/remote-branch-sync.js';
import { writeLockfile } from '../src/daemon/lockfile.js';
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
const CASEY_DATA = `${BASE}/casey-agent`;
const REPOS_PATH = `${BASE}/repos`;
const BOB_HELPER_REPOS_PATH = `${BASE}/bob-helper-repos`;
const BOB_RESTORE_REPOS_PATH = `${BASE}/bob-restore-repos`;
const BOB_RESTORE_CLONE_PATH = `${BASE}/bob-restore-clone`;
const BOB_DID_REMOTE_HOME = `${BASE}/bob-did-remote-home`;
const BOB_DID_REMOTE_BIN = `${BASE}/bob-did-remote-bin`;
const BOB_DID_REMOTE_REPOS_PATH = `${BASE}/bob-did-remote-repos`;
const BOB_DID_REMOTE_CLONE_PATH = `${BASE}/bob-did-remote-clone`;
const ALICE_CLONE_PATH = `${BASE}/alice-clone`;
const BOB_CLONE_PATH = `${BASE}/bob-clone`;

// ---------------------------------------------------------------------------
// Helper: create a Web5UserAgent without DHT network access.
//
// Bypasses `initialize()` / `start()` which internally call
// `DidDht.create({ publish: true })`.  Instead, we:
//   1. Create the agent (optionally injecting a shared DWN)
//   2. Assign `agent.agentDid` directly with `publish: false`
//   3. Create an identity DID with offline DID:DHT keys
//   4. Construct `Enbox` directly with the selected identity
//
// ---------------------------------------------------------------------------

async function createOfflineAgent(dataPath: string): Promise<{
  agent: EnboxUserAgent;
  enbox: InstanceType<typeof Enbox>;
  did: string;
  didDocument: any;
  portableDid: any;
  privateKey: Record<string, unknown>;
}> {
  const agent = await EnboxUserAgent.create({ dataPath });

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

  const identity = await createTestIdentity(agent, `Test (${dataPath})`);

  const enbox = new Enbox({ agent, connectedDid: identity.did.uri });
  const did = identity.did.uri;

  // Extract the private key for push credential signing.
  const portableDid = await identity.did.export();
  const privateKey = portableDid.privateKeys![0] as Record<string, unknown>;

  return {
    agent,
    enbox,
    did,
    didDocument : identity.did.document,
    portableDid : {
      uri      : portableDid.uri,
      document : portableDid.document,
      metadata : portableDid.metadata,
    },
    privateKey,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('E2E: repo collaboration (maintainer + contributor + moderator)', () => {
  // Alice's state
  let aliceDid: string;
  let aliceDidDocument: any;
  let alicePrivateKey: Record<string, unknown>;
  let aliceAgent: EnboxUserAgent;
  let aliceRepo: AgentContext['repo'];
  let aliceRefs: AgentContext['refs'];
  let aliceIssues: AgentContext['issues'];
  let alicePatches: AgentContext['patches'];
  let repoContextId: string;

  // Bob's state
  let bobDid: string;
  let bobDidDocument: any;
  let bobPrivateKey: Record<string, unknown>;
  let bobRepo: AgentContext['repo'];
  let bobRefs: AgentContext['refs'];
  let bobIssues: AgentContext['issues'];
  let bobPatches: AgentContext['patches'];
  let bobContributorBranchRef: string;

  // Casey's state
  let caseyDid: string;
  let caseyDidDocument: any;
  let caseyPrivateKey: Record<string, unknown>;
  let caseyRepo: AgentContext['repo'];
  let caseyPatches: AgentContext['patches'];

  // Shared infrastructure
  let server: GitServer;
  let bobHelperServer: GitServer | undefined;
  let cloneUrl: string;
  let helperBranchRef: string;

  // =========================================================================
  // Setup — create two independent Enbox agents (no DHT required)
  // =========================================================================

  beforeAll(async () => {
    rmSync(BASE, { recursive: true, force: true });

    // ----- Alice (maintainer) -----
    const alice = await createOfflineAgent(ALICE_DATA);
    aliceDid = alice.did;
    aliceDidDocument = alice.didDocument;
    alicePrivateKey = alice.privateKey;
    aliceAgent = alice.agent;

    aliceRepo = alice.enbox.using(ForgeRepoProtocol);
    aliceRefs = alice.enbox.using(ForgeRefsProtocol);
    aliceIssues = alice.enbox.using(ForgeIssuesProtocol);
    alicePatches = alice.enbox.using(ForgePatchesProtocol);
    await aliceRepo.configure();
    await aliceRefs.configure();
    await aliceIssues.configure();
    await alicePatches.configure();

    // ----- Bob (contributor) -----
    const bob = await createOfflineAgent(BOB_DATA);
    bobDid = bob.did;
    bobDidDocument = bob.didDocument;
    bobPrivateKey = bob.privateKey;
    bobContributorBranchRef = `refs/heads/users/${branchOwnerHash(bobDid)}/feat/add-multiply`;

    await cachePortableDid(alice.agent, bob.portableDid);
    await cachePortableDid(bob.agent, alice.portableDid);

    // Bob must install ForgeRepoProtocol before ForgePatchesProtocol
    // because the patches definition `uses` the repo protocol ($ref).
    bobRepo = bob.enbox.using(ForgeRepoProtocol);
    await bobRepo.configure();
    bobRefs = bob.enbox.using(ForgeRefsProtocol);
    await bobRefs.configure();
    bobIssues = bob.enbox.using(ForgeIssuesProtocol);
    await bobIssues.configure();

    // Now Bob can install the patches protocol on his own DWN so he
    // can create properly signed records with `store: false`.
    bobPatches = bob.enbox.using(ForgePatchesProtocol);
    await bobPatches.configure();

    // ----- Casey (moderator) -----
    const casey = await createOfflineAgent(CASEY_DATA);
    caseyDid = casey.did;
    caseyDidDocument = casey.didDocument;
    caseyPrivateKey = casey.privateKey;

    await cachePortableDid(alice.agent, casey.portableDid);
    await cachePortableDid(casey.agent, alice.portableDid);

    caseyRepo = casey.enbox.using(ForgeRepoProtocol);
    await caseyRepo.configure();
    caseyPatches = casey.enbox.using(ForgePatchesProtocol);
    await caseyPatches.configure();

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

    // ----- Grant Casey the moderator role -----
    const { status: moderatorStatus } = await aliceRepo.records.create(
      'repo/moderator' as any,
      {
        data            : { did: caseyDid, alias: 'Casey' },
        tags            : { did: caseyDid },
        parentContextId : repoContextId,
        recipient       : caseyDid,
      } as any,
    );
    if (moderatorStatus.code >= 300) {
      throw new Error(`Failed to grant moderator role: ${moderatorStatus.code} ${moderatorStatus.detail}`);
    }

    // ----- Init bare git repo + start server -----
    const backend = new GitBackend({ basePath: REPOS_PATH });
    await backend.initRepo(aliceDid, 'collab-repo');

    const verifySignature = createDidSignatureVerifier({
      didDocuments: [aliceDidDocument, bobDidDocument, caseyDidDocument],
    });
    const authorizePush = createDwnPushAuthorizer({
      repo     : aliceRepo,
      ownerDid : aliceDid,
    });

    // Custom authenticatePush — no nonce replay (see e2e.spec.ts for rationale).
    const authenticatePush = async (
      request: Request,
      did: string,
      repo: string,
      updates?: readonly PushRefUpdate[],
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

      return authorizePush(payload.did, did, repo, updates);
    };

    const refSyncer = createRefSyncer({
      refs: aliceRefs,
      repoContextId,
    });

    const bundleSyncer = createBundleSyncer({
      repo       : aliceRepo,
      refs       : aliceRefs,
      repoContextId,
      visibility : 'public',
    });

    const onPushComplete = async (
      pushDid: string, repoName: string, repoPath: string,
    ): Promise<void> => {
      await refSyncer(pushDid, repoName, repoPath);
      await bundleSyncer(pushDid, repoName, repoPath);
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
    try { if (bobHelperServer) { await bobHelperServer.stop(); } } catch { /* ok */ }
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

  async function sendToAlice(record: any): Promise<void> {
    const blob = await record.data.blob();
    const reply = await aliceAgent.dwn.node.processMessage(
      aliceDid,
      record.rawMessage,
      { dataStream: DataStream.fromBytes(new Uint8Array(await blob.arrayBuffer())) },
    );
    if (reply.status.code >= 300) {
      throw new Error(`sendToAlice failed: ${reply.status.code} ${reply.status.detail}`);
    }
  }

  async function captureLog(fn: () => Promise<void>): Promise<string[]> {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(' ')); };
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return logs;
  }

  async function captureError(fn: () => Promise<void>): Promise<{ errors: string[]; exitCode?: number }> {
    const errors: string[] = [];
    const origError = console.error;
    const origExit = process.exit;
    let exitCode: number | undefined;
    console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { exitCode = code ?? 1; throw new Error(`process.exit(${code})`); }) as never;
    try {
      await fn();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.startsWith('process.exit'))) {
        throw err;
      }
    } finally {
      console.error = origError;
      process.exit = origExit;
    }
    return { errors, exitCode };
  }

  function bobCliContext(): AgentContext {
    return {
      did        : bobDid,
      repo       : withAliceReads(bobRepo, aliceRepo),
      refs       : bobRefs,
      issues     : withAliceReads(bobIssues, aliceIssues),
      patches    : withAliceReads(bobPatches, alicePatches),
      sendRecord : async (record: any, targetDid: string): Promise<void> => {
        expect(targetDid).toBe(aliceDid);
        await sendToAlice(record);
      },
    } as unknown as AgentContext;
  }

  function caseyCliContext(): AgentContext {
    return {
      did        : caseyDid,
      repo       : withAliceReads(caseyRepo, aliceRepo),
      patches    : withAliceReads(caseyPatches, alicePatches),
      sendRecord : async (record: any, targetDid: string): Promise<void> => {
        expect(targetDid).toBe(aliceDid);
        await sendToAlice(record);
      },
    } as unknown as AgentContext;
  }

  function withAliceReads<T extends { records: any }>(localProtocol: T, aliceProtocol: T): T {
    return {
      ...localProtocol,
      records: {
        ...localProtocol.records,
        query: async (path: string, options?: any): Promise<any> => {
          if (options?.from === aliceDid) {
            const { from: _from, ...rest } = options;
            return aliceProtocol.records.query(path, rest);
          }
          return localProtocol.records.query(path, options);
        },
      },
    };
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
  }, 15_000);

  it('Phase 1c: Alice\'s commits are in the bare repo', async () => {
    const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
    const { stdout } = await exec('git log --oneline main', { cwd: repoPath });
    expect(stdout).toContain('Initial commit');
    expect(stdout).toContain('add utils module');
  });

  it('Phase 1d: refs are synced to Alice\'s DWN', async () => {
    // Wait for async onPushComplete
    await new Promise((r) => setTimeout(r, 500));

    const { records: refRecords } = await aliceRefs.records.query('repo/ref' as any, {
      filter: { contextId: repoContextId },
    });

    // Manually sync if timing is tight
    if (refRecords.length === 0) {
      const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
      const syncer = createRefSyncer({ refs: aliceRefs, repoContextId });
      await syncer(aliceDid, 'collab-repo', repoPath);
    }

    const { records: finalRefs } = await aliceRefs.records.query('repo/ref' as any, {
      filter: { contextId: repoContextId },
    });
    expect(finalRefs.length).toBeGreaterThanOrEqual(1);

    const refEntries = await Promise.all(finalRefs.map(async (r: any) => r.data.json()));
    const mainRef = refEntries.find((d: any) => d.name === 'refs/heads/main');
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
  // Bob creates records with `store: false` (signed by Bob, not persisted
  // locally) and then sends them to Alice's DWN via the shared multi-tenant
  // DWN node.  In production this would use `record.send(aliceDid)` over
  // HTTP. Bob invokes the contributor role Alice granted earlier.
  // =========================================================================

  let patchRecordId: string;
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
    // Bob creates records with store:false (signed but not persisted
    // locally), then "sends" them to Alice's DWN via processRequest
    // targeting Alice's DID on the shared multi-tenant DWN node.
    //
    // In production, this would use record.send(aliceDid) over HTTP.
    // Bob must invoke Alice's contributor grant for direct writes.

    const { bundlePath, baseCommit, headCommit } = (globalThis as any).__collab_bundle;

    // Create the patch record (PR) — signed by Bob, not stored locally
    const { record: patchRecord } = await bobPatches.records.create(
      'repo/patch',
      {
        data: {
          title : 'feat: add multiply function',
          body  : 'Adds a multiply function to utils and a test for it.',
        },
        tags: {
          status     : 'open',
          baseBranch : 'main',
          headBranch : bobContributorBranchRef,
          sourceDid  : bobDid,
        },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
        store           : false,
      } as any,
    );
    await sendToAlice(patchRecord);
    patchRecordId = patchRecord.id;
    patchContextId = patchRecord.contextId!;

    // Create the revision record — signed by Bob, sent to Alice
    const { record: revisionRecord } = await bobPatches.records.create(
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
        parentContextId : patchContextId,
        store           : false,
      } as any,
    );
    await sendToAlice(revisionRecord);

    // Attach the git bundle — signed by Bob, sent to Alice
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));

    const { record: bundleRecord } = await bobPatches.records.create(
      'repo/patch/revision/revisionBundle' as any,
      {
        data       : bundleBytes,
        dataFormat : 'application/x-git-bundle',
        tags       : {
          headCommit,
          baseCommit,
          refCount : 1,
          size     : bundleBytes.length,
        },
        parentContextId : revisionRecord.contextId,
        store           : false,
      } as any,
    );
    await sendToAlice(bundleRecord);

    // Clean up temp bundle file
    try { rmSync(bundlePath); } catch { /* ok */ }
  }, 15_000);

  it('Phase 3c: Bob\'s PR is visible in Alice\'s DWN', async () => {
    const { records } = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });

    // Find the patch created by Bob
    const patch = records.find((r: any) => r.id === patchRecordId);
    expect(patch).toBeDefined();

    const data = await patch!.data.json();
    expect(data.title).toBe('feat: add multiply function');

    const tags = patch!.tags as Record<string, string>;
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

  it('Phase 4a2: Casey can moderate Bob\'s PR with a review comment', async () => {
    const patchResults = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });
    const patch = patchResults.records.find((r: any) => r.id === patchRecordId)!;

    const { record: reviewRecord } = await caseyPatches.records.create(
      'repo/patch/review' as any,
      {
        data: {
          body: 'Moderator note: keep discussion focused on the implementation.',
        },
        tags            : { verdict: 'comment' },
        parentContextId : patch.contextId,
        protocolRole    : 'repo:repo/moderator',
        store           : false,
      } as any,
    );
    await sendToAlice(reviewRecord);

    const { records: reviews } = await alicePatches.records.query('repo/patch/review' as any, {
      filter: { contextId: patch.contextId, tags: { verdict: 'comment' } },
    });
    const caseyReview = reviews.find((record: any) => record.id === reviewRecord.id);
    expect(caseyReview).toBeDefined();

    const data = await caseyReview!.data.json();
    expect(data.body).toContain('Moderator note');
  });

  it('Phase 4b: Alice checks out Bob\'s PR (fetches bundle into local tree)', async () => {
    // Fetch the revision and bundle from Alice's DWN
    const patchResults = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });
    const patch = patchResults.records.find((r: any) => r.id === patchRecordId)!;

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
      const prId = shortId(patchRecordId);
      await exec(`git checkout -b pr/${prId} ${tipCommit}`, { cwd: ALICE_CLONE_PATH });

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
    const patchResults = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });
    const patch = patchResults.records.find((r: any) => r.id === patchRecordId)!;

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
    const prId = shortId(patchRecordId);
    await exec(`git merge --no-ff -m "Merge PR ${prId}: feat: add multiply function" pr/${prId}`, {
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
  }, 15_000);

  it('Phase 4f: Alice records the merge result in DWN', async () => {
    // Update the patch status to merged
    const { records } = await alicePatches.records.query('repo/patch', {
      filter: { contextId: repoContextId },
    });
    const patch = records.find((r: any) => r.id === patchRecordId)!;
    expect(patch).toBeDefined();
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
      filter: { contextId: repoContextId },
    });
    const updatedPatch = updated.find((r: any) => r.id === patchRecordId);
    const updatedTags = updatedPatch!.tags as Record<string, string>;
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

  it('Phase 5b: Bob queries Alice\'s DWN to verify the PR is merged', async () => {
    // In production, Bob would query Alice's DWN over HTTP:
    //   bobPatches.records.query('repo/patch', { from: aliceDid, ... })
    // Here we query Alice's DWN directly since both agents are in-process
    // and there is no HTTP DWN server. The cross-DWN *write* path is
    // already exercised in Phase 3b via processMessage().

    const { records: patches } = await alicePatches.records.query('repo/patch', {
      filter: {
        contextId : repoContextId,
        tags      : { status: 'merged' },
      },
    });

    const mergedPatch = patches.find((r: any) => r.id === patchRecordId);
    expect(mergedPatch).toBeDefined();

    const data = await mergedPatch!.data.json();
    expect(data.title).toBe('feat: add multiply function');

    // Query for the mergeResult child record
    const { records: mergeResults } = await alicePatches.records.query(
      'repo/patch/mergeResult' as any,
      {
        filter: { contextId: mergedPatch!.contextId },
      },
    );

    expect(mergeResults.length).toBe(1);
    const mrData = await mergeResults[0].data.json();
    expect(mrData.mergeCommit).toBeDefined();
    expect(mrData.strategy).toBe('merge');
  });

  // =========================================================================
  // Phase 6: Verify push authorization (contributor can push, stranger can't)
  // =========================================================================

  it('Phase 6a: Bob (contributor) can push to his canonical contributor branch', async () => {
    // Bob pushes his feature branch to the server
    await exec('git checkout feat/add-multiply', { cwd: BOB_CLONE_PATH });

    const helper = await credentialHelper(bobDid, bobPrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: BOB_CLONE_PATH });
    await exec(
      `GIT_TERMINAL_PROMPT=0 git push origin HEAD:${bobContributorBranchRef}`,
      { cwd: BOB_CLONE_PATH },
    );

    // Verify the branch exists in the bare repo
    const repoPath = server.backend.repoPath(aliceDid, 'collab-repo');
    const { stdout } = await exec(`git show-ref --verify ${bobContributorBranchRef}`, { cwd: repoPath });
    expect(stdout).toContain(bobContributorBranchRef);
  }, 15_000);

  it('Phase 6b: Bob (contributor) cannot push main', async () => {
    await exec('git checkout feat/add-multiply', { cwd: BOB_CLONE_PATH });

    const helper = await credentialHelper(bobDid, bobPrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: BOB_CLONE_PATH });

    await expect(
      exec('GIT_TERMINAL_PROMPT=0 git push origin HEAD:refs/heads/main', { cwd: BOB_CLONE_PATH }),
    ).rejects.toThrow();
  }, 15_000);

  it('Phase 6c: Casey (moderator) cannot push', async () => {
    const creds = await generatePushCredentials(
      { path: `/${aliceDid}/collab-repo` },
      caseyDid,
      caseyPrivateKey,
    );
    expect(creds).toBeDefined();

    const authHeader = `Basic ${Buffer.from(`${creds!.username}:${creds!.password}`).toString('base64')}`;
    const res = await fetch(`${cloneUrl}/info/refs?service=git-receive-pack`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(401);
  });

  it('Phase 6d: Unauthorized DID cannot push', async () => {
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

	  it('Phase 7: Bob local helper writes contributor branch records to Alice DWN', async () => {
    helperBranchRef = `refs/heads/users/${branchOwnerHash(bobDid)}/local-helper-writeback`;
    const bobHelperBackend = new GitBackend({ basePath: BOB_HELPER_REPOS_PATH });
    const bobHelperRepoPath = bobHelperBackend.repoPath(aliceDid, 'collab-repo');
    rmSync(BOB_HELPER_REPOS_PATH, { recursive: true, force: true });
    mkdirSync(dirname(bobHelperRepoPath), { recursive: true });
    await exec(`git clone --bare "${cloneUrl}" "${bobHelperRepoPath}"`);

    const verifySignature = createDidSignatureVerifier({
      didDocuments: [bobDidDocument],
    });
    const authorizePush = createDwnPushAuthorizer({
      repo     : aliceRepo,
      ownerDid : aliceDid,
    });

    const authenticatePush = async (
      request: Request,
      did: string,
      repo: string,
      updates?: readonly PushRefUpdate[],
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

      return authorizePush(payload.did, did, repo, updates);
    };

    bobHelperServer = await createGitServer({
      basePath       : BOB_HELPER_REPOS_PATH,
      port           : 0,
      authenticatePush,
      onPushComplete : async (did, _repo, repoPath, pushContext) => {
        await syncRemoteBranchPush({
          refs           : bobRefs,
          repoContextId,
          targetDid      : did,
          actorDid       : bobDid,
          repoPath,
          updates        : pushContext?.updates ?? [],
          sendRecord     : sendToAlice,
          lookupBranches : async (refName) => {
            const { records } = await aliceRefs.records.query('repo/branch' as any, {
              filter: { contextId: repoContextId, tags: { refName } },
            });
            return records;
          },
        });
      },
    });

    await exec('git checkout -B local-helper-writeback main', { cwd: BOB_CLONE_PATH });
    writeFileSync(
      join(BOB_CLONE_PATH, 'local-helper.ts'),
      'export const localHelperWriteback = true;\n',
    );
    await exec('git add local-helper.ts', { cwd: BOB_CLONE_PATH });
    await exec('git commit -m "feat: local helper branch writeback"', { cwd: BOB_CLONE_PATH });

    const helper = await credentialHelper(bobDid, bobPrivateKey);
    await exec(`git config --replace-all credential.helper '${helper}'`, { cwd: BOB_CLONE_PATH });
    const bobHelperUrl = `http://localhost:${bobHelperServer.port}/${aliceDid}/collab-repo`;
    await exec(`GIT_TERMINAL_PROMPT=0 git push "${bobHelperUrl}" HEAD:${helperBranchRef}`, { cwd: BOB_CLONE_PATH });

    let branches: any[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      ({ records: branches } = await aliceRefs.records.query('repo/branch' as any, {
        filter: { contextId: repoContextId, tags: { refName: helperBranchRef } },
      }));
      if (branches.length > 0) { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(branches).toHaveLength(1);
    const branchData = await branches[0].data.json();
    expect(branchData.ownerDid).toBe(bobDid);
    expect(branchData.kind).toBe('contributor');

    const { records: states } = await aliceRefs.records.query('repo/branch/state' as any, {
      filter: { contextId: branches[0].contextId },
    });
    expect(states.length).toBeGreaterThanOrEqual(1);
    const stateEntries = await Promise.all(states.map(async (record: any) => ({
      record,
      data: await record.data.json(),
    })));
    const checkpoint = stateEntries.find((entry) => entry.data.kind === 'checkpoint');
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.data.actorDid).toBe(bobDid);
    expect(checkpoint!.data.refName).toBe(helperBranchRef);
    expect(checkpoint!.data.target).toMatch(/^[0-9a-f]{40}$/);

    const { records: bundles } = await aliceRefs.records.query('repo/branch/bundle' as any, {
      filter: { contextId: branches[0].contextId, tags: { refName: helperBranchRef } },
    });
    expect(bundles.length).toBeGreaterThanOrEqual(1);
	    expect(bundles[0].tags.tipCommit).toBe(checkpoint!.data.target);
	  }, 30_000);

	  it('Phase 8: Bob CLI creates canonical issue and PR records in Alice DWN', async () => {
	    const ctx = bobCliContext();

	    const issueLogs = await captureLog(() =>
	      issueCommand(ctx, [
	        'create',
	        'CLI canonical issue',
	        '--body',
	        'Created by Bob through the local helper path.',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(issueLogs.some((line) => line.includes('Created issue'))).toBe(true);

	    const { records: issues } = await aliceIssues.records.query('repo/issue', {
	      filter: { contextId: repoContextId },
	    });
	    const issueEntries = await Promise.all(issues.map(async (record: any) => ({
	      record,
	      data: await record.data.json(),
	    })));
	    const cliIssue = issueEntries.find((entry) => entry.data.title === 'CLI canonical issue')?.record;
	    expect(cliIssue).toBeDefined();

	    const issueId = shortId(cliIssue!.id);
	    const commentLogs = await captureLog(() =>
	      issueCommand(ctx, [
	        'comment',
	        issueId,
	        'Commented by Bob through the local helper path.',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(commentLogs.some((line) => line.includes(`Added comment to issue ${issueId}`))).toBe(true);

	    const { records: issueComments } = await aliceIssues.records.query('repo/issue/comment' as any, {
	      filter: { contextId: cliIssue!.contextId },
	    });
	    expect(issueComments.length).toBeGreaterThanOrEqual(1);
	    const issueCommentData = await issueComments[issueComments.length - 1].data.json();
	    expect(issueCommentData.body).toContain('Commented by Bob');

	    const origCwd = process.cwd();
	    try {
	      process.chdir(BOB_CLONE_PATH);
	      const prLogs = await captureLog(() =>
	        prCommand(ctx, [
	          'create',
	          'CLI canonical PR',
	          '--body',
	          'Created by Bob through gitd pr create.',
	          '--base',
	          'main',
	          '--repo',
	          'collab-repo',
	          '--owner',
	          aliceDid,
	        ]),
	      );
	      expect(prLogs.some((line) => line.includes('Created PR'))).toBe(true);
	      expect(prLogs.some((line) => line.includes('Bundle:'))).toBe(true);
	    } finally {
	      process.chdir(origCwd);
	    }

	    const { records: patches } = await alicePatches.records.query('repo/patch', {
	      filter: { contextId: repoContextId },
	    });
	    const patchEntries = await Promise.all(patches.map(async (record: any) => ({
	      record,
	      data: await record.data.json(),
	    })));
	    const cliPatch = patchEntries.find((entry) => entry.data.title === 'CLI canonical PR')?.record;
	    expect(cliPatch).toBeDefined();

	    const { records: revisions } = await alicePatches.records.query('repo/patch/revision' as any, {
	      filter: { contextId: cliPatch!.contextId },
	    });
	    expect(revisions.length).toBeGreaterThanOrEqual(1);
	    const { records: revisionBundles } = await alicePatches.records.query('repo/patch/revision/revisionBundle' as any, {
	      filter: { contextId: revisions[0].contextId },
	    });
	    expect(revisionBundles.length).toBe(1);

	    const patchId = shortId(cliPatch!.id);
	    const prCommentLogs = await captureLog(() =>
	      prCommand(ctx, [
	        'comment',
	        patchId,
	        'Review note from Bob through the local helper path.',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(prCommentLogs.some((line) => line.includes(`Added comment to PR ${patchId}`))).toBe(true);

	    const { records: reviews } = await alicePatches.records.query('repo/patch/review' as any, {
	      filter: { contextId: cliPatch!.contextId, tags: { verdict: 'comment' } },
	    });
	    const reviewEntries = await Promise.all(reviews.map(async (record: any) => ({
	      record,
	      data: await record.data.json(),
	    })));
	    expect(reviewEntries.some((entry) => entry.data.body.includes('Review note from Bob'))).toBe(true);
	  }, 30_000);

	  it('Phase 9: Casey CLI moderation locks PR discussion and hides Bob review note', async () => {
	    const bobCtx = bobCliContext();
	    const caseyCtx = caseyCliContext();

	    const { records: patches } = await alicePatches.records.query('repo/patch', {
	      filter: { contextId: repoContextId },
	    });
	    const patchEntries = await Promise.all(patches.map(async (record: any) => ({
	      record,
	      data: await record.data.json(),
	    })));
	    const cliPatch = patchEntries.find((entry) => entry.data.title === 'CLI canonical PR')?.record;
	    expect(cliPatch).toBeDefined();
	    const patchId = shortId(cliPatch!.id);

	    const { records: reviews } = await alicePatches.records.query('repo/patch/review' as any, {
	      filter: { contextId: cliPatch!.contextId, tags: { verdict: 'comment' } },
	    });
	    const reviewEntries = await Promise.all(reviews.map(async (record: any) => ({
	      record,
	      data: await record.data.json(),
	    })));
	    const bobReview = reviewEntries.find((entry) => entry.data.body.includes('Review note from Bob'))?.record;
	    expect(bobReview).toBeDefined();
	    const reviewId = shortId(bobReview!.id);

	    const lockLogs = await captureLog(() =>
	      modCommand(caseyCtx, [
	        'lock',
	        'pr',
	        patchId,
	        '--reason',
	        'heated',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(lockLogs.some((line) => line.includes(`Locked pr ${patchId}`))).toBe(true);

	    const hideLogs = await captureLog(() =>
	      modCommand(caseyCtx, [
	        'hide-comment',
	        reviewId,
	        '--kind',
	        'pr',
	        '--reason',
	        'off topic',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(hideLogs.some((line) => line.includes(`Hid comment ${reviewId}`))).toBe(true);

	    const { records: moderationEvents } = await aliceRepo.records.query('repo/moderationEvent' as any, {
	      filter: { contextId: repoContextId },
	    });
	    expect(moderationEvents.some((record: any) =>
	      record.tags?.action === 'lock'
	      && record.tags?.targetKind === 'pr'
	      && record.tags?.targetId === patchId,
	    )).toBe(true);
	    expect(moderationEvents.some((record: any) =>
	      record.tags?.action === 'hideComment'
	      && record.tags?.targetKind === 'prComment'
	      && record.tags?.targetId === reviewId,
	    )).toBe(true);

	    const showLogs = await captureLog(() =>
	      prCommand(bobCtx, ['show', patchId, '--repo', 'collab-repo', '--owner', aliceDid]),
	    );
	    expect(showLogs.some((line) => line.includes('Review note from Bob'))).toBe(false);

	    const { errors, exitCode } = await captureError(() =>
	      prCommand(bobCtx, [
	        'comment',
	        patchId,
	        'This should be blocked by Casey lock.',
	        '--repo',
	        'collab-repo',
	        '--owner',
	        aliceDid,
	      ]),
	    );
	    expect(exitCode).toBe(1);
	    expect(errors.some((line) => line.includes(`PR ${patchId} is locked.`))).toBe(true);
	  }, 30_000);

	  it('Phase 10: Bob empty helper cache restores Alice repo from DWN records', async () => {
	    rmSync(BOB_RESTORE_REPOS_PATH, { recursive: true, force: true });
	    rmSync(BOB_RESTORE_CLONE_PATH, { recursive: true, force: true });

	    const { stdout: mergedTipOutput } = await exec('git rev-parse main', { cwd: ALICE_CLONE_PATH });
	    const mergedTip = mergedTipOutput.trim();
	    let mergeBundleSynced = false;
	    for (let attempt = 0; attempt < 20; attempt++) {
	      const { records } = await aliceRepo.records.query('repo/bundle', {
	        filter: { contextId: repoContextId },
	      });
	      mergeBundleSynced = records.some((record: any) => record.tags?.tipCommit === mergedTip);
	      if (mergeBundleSynced) { break; }
	      await new Promise((resolve) => setTimeout(resolve, 100));
	    }
	    expect(mergeBundleSynced).toBe(true);

	    const restoreRepo = withAliceReads(bobRepo, aliceRepo);
	    const restoreRefs = withAliceReads(bobRefs, aliceRefs);
	    const restoreServer = await createGitServer({
	      basePath       : BOB_RESTORE_REPOS_PATH,
	      port           : 0,
	      onRepoNotFound : async (did, repoName, repoPath): Promise<boolean> => {
	        expect(did).toBe(aliceDid);
	        expect(repoName).toBe('collab-repo');
	        const result = await restoreFromBundles({
	          repo : restoreRepo,
	          refs : restoreRefs,
	          from : aliceDid,
	          repoPath,
	          repoContextId,
	        });
	        return result.success;
	      },
	    });

	    try {
	      const restoreUrl = `http://localhost:${restoreServer.port}/${aliceDid}/collab-repo`;
	      await exec(`git clone --branch main "${restoreUrl}" "${BOB_RESTORE_CLONE_PATH}"`);

	      const { stdout: log } = await exec('git log --oneline -5', { cwd: BOB_RESTORE_CLONE_PATH });
	      expect(log).toContain('Merge PR');
	      expect(log).toContain('add multiply function');

	      const utils = readFileSync(join(BOB_RESTORE_CLONE_PATH, 'utils.ts'), 'utf-8');
	      expect(utils).toContain('multiply');

	      const restoredRepoPath = restoreServer.backend.repoPath(aliceDid, 'collab-repo');
	      const { stdout: branchRef } = await exec(`git show-ref --verify ${helperBranchRef}`, { cwd: restoredRepoPath });
	      expect(branchRef).toContain(helperBranchRef);
	    } finally {
	      await restoreServer.stop();
	      rmSync(BOB_RESTORE_REPOS_PATH, { recursive: true, force: true });
	      rmSync(BOB_RESTORE_CLONE_PATH, { recursive: true, force: true });
	    }
	  }, 30_000);

	  it('Phase 11: git-remote-did routes did:: clone to Bob local DWN helper', async () => {
	    rmSync(BOB_DID_REMOTE_HOME, { recursive: true, force: true });
	    rmSync(BOB_DID_REMOTE_BIN, { recursive: true, force: true });
	    rmSync(BOB_DID_REMOTE_REPOS_PATH, { recursive: true, force: true });
	    rmSync(BOB_DID_REMOTE_CLONE_PATH, { recursive: true, force: true });

	    const fakeAliceDid = 'did:gitd-test:alice';
	    const helperBinPath = join(BOB_DID_REMOTE_BIN, 'git-remote-did');
	    mkdirSync(BOB_DID_REMOTE_BIN, { recursive: true });
	    writeFileSync(
	      helperBinPath,
	      `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve('src/git-remote/main.ts'))} "$@"\n`,
	      'utf-8',
	    );
	    chmodSync(helperBinPath, 0o755);

	    const restoreRepo = withAliceReads(bobRepo, aliceRepo);
	    const restoreRefs = withAliceReads(bobRefs, aliceRefs);
	    const restoreServer = await createGitServer({
	      basePath       : BOB_DID_REMOTE_REPOS_PATH,
	      port           : 0,
	      onRepoNotFound : async (did, repoName, repoPath): Promise<boolean> => {
	        expect(did).toBe(fakeAliceDid);
	        expect(repoName).toBe('collab-repo');
	        const result = await restoreFromBundles({
	          repo : restoreRepo,
	          refs : restoreRefs,
	          from : aliceDid,
	          repoPath,
	          repoContextId,
	        });
	        return result.success;
	      },
	    });

	    const originalHome = process.env.ENBOX_HOME;
	    process.env.ENBOX_HOME = BOB_DID_REMOTE_HOME;
	    try {
	      writeLockfile(restoreServer.port, 'test', bobDid, { dwnHelper: true });
	    } finally {
	      if (originalHome === undefined) {
	        delete process.env.ENBOX_HOME;
	      } else {
	        process.env.ENBOX_HOME = originalHome;
	      }
	    }

	    try {
	      const env = {
	        ...process.env,
	        ENBOX_HOME : BOB_DID_REMOTE_HOME,
	        PATH       : `${resolve(BOB_DID_REMOTE_BIN)}:${process.env.PATH ?? ''}`,
	      };
	      const { stderr } = await exec(
	        `git clone --branch main "did::gitd-test:alice/collab-repo" "${BOB_DID_REMOTE_CLONE_PATH}"`,
	        { env },
	      );
	      expect(stderr).toContain('(via LocalDwnHelper)');

	      const { stdout: log } = await exec('git log --oneline -5', { cwd: BOB_DID_REMOTE_CLONE_PATH });
	      expect(log).toContain('Merge PR');
	      expect(log).toContain('add multiply function');

	      const utils = readFileSync(join(BOB_DID_REMOTE_CLONE_PATH, 'utils.ts'), 'utf-8');
	      expect(utils).toContain('multiply');

	      const restoredRepoPath = restoreServer.backend.repoPath(fakeAliceDid, 'collab-repo');
	      const { stdout: branchRef } = await exec(`git show-ref --verify ${helperBranchRef}`, { cwd: restoredRepoPath });
	      expect(branchRef).toContain(helperBranchRef);
	    } finally {
	      await restoreServer.stop();
	      rmSync(BOB_DID_REMOTE_HOME, { recursive: true, force: true });
	      rmSync(BOB_DID_REMOTE_BIN, { recursive: true, force: true });
	      rmSync(BOB_DID_REMOTE_REPOS_PATH, { recursive: true, force: true });
	      rmSync(BOB_DID_REMOTE_CLONE_PATH, { recursive: true, force: true });
	    }
	  }, 30_000);

});
