import { afterEach, describe, expect, it } from 'bun:test';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DidDocument } from '@enbox/dids';

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { RecordsQuery } from '@enbox/dwn-sdk-js';

import { branchOwnerHash } from '../src/branch-state.js';
import { ForgeRepoDefinition } from '../src/repo.js';
import { startPassiveDwnServer } from './helpers/passive-dwn-server.js';

const BASE = resolve('__TESTDATA__/passive-dwn-sync-e2e');
const ENBOX_HOME = resolve(BASE, 'home');
const PASSWORD = 'passive-dwn-sync-e2e-password';
const BOOTSTRAP = resolve('tests/helpers/profile-bootstrap.ts');
const CACHE_DID_DOCS = resolve('tests/helpers/cache-did-docs.ts');
const GITD_MAIN = resolve('src/cli/main.ts');

type BootstrapResult = {
  profile: string;
  did: string;
  didDocument: DidDocument;
  didDocumentMetadata?: Record<string, unknown>;
};

const processes: ChildProcessWithoutNullStreams[] = [];

describe('E2E: spawned helper syncs to a passive DWN endpoint', () => {
  afterEach(async () => {
    await Promise.all(processes.splice(0).map((proc) => stopProcess(proc)));
    rmSync(BASE, { recursive: true, force: true });
  });

  it('pushes Alice public repo metadata from gitd serve into the passive DWN', async () => {
    rmSync(BASE, { recursive: true, force: true });

    const passiveDwn = await startPassiveDwnServer({ dataPath: resolve(BASE, 'passive-dwn') });
    try {
      const alice = bootstrapProfile('alice', passiveDwn.url);
      expect(alice.didDocument.id).toBe(alice.did);
      passiveDwn.addDidDocument({
        didDocument         : alice.didDocument,
        didDocumentMetadata : alice.didDocumentMetadata,
      });

      const init = spawnSync('bun', [
        GITD_MAIN,
        'init',
        'passive-demo',
        '--no-local',
      ], {
        cwd      : resolve('.'),
        encoding : 'utf-8',
        env      : testEnv('alice', passiveDwn.url),
      });
      if (init.status !== 0) {
        throw new Error(`gitd init failed:\nstdout:\n${init.stdout}\nstderr:\n${init.stderr}`);
      }

      const port = await freePort();
      const serve = await startServe('alice', passiveDwn.url, port);
      processes.push(serve.proc);

      await waitFor(async () => {
        const entries = await queryRemoteRepos(passiveDwn.url, alice.did, 'passive-demo');
        return entries.length === 1;
      }, async () => {
        const entries = await queryRemoteRepos(passiveDwn.url, alice.did, 'passive-demo');
        return `passive DWN never received Alice repo record; entries=${entries.length}\nstdout:\n${serve.stdout()}\nstderr:\n${serve.stderr()}`;
      }, 20_000);
    } finally {
      await passiveDwn.stop();
    }
  }, 90_000);

  it('clones Alice public repo on a fresh reader machine without identity setup', async () => {
    rmSync(BASE, { recursive: true, force: true });

    const passiveDwn = await startPassiveDwnServer({ dataPath: resolve(BASE, 'passive-dwn') });
    try {
      const alice = bootstrapProfile('alice', passiveDwn.url);
      passiveDwn.addDidDocument({
        didDocument         : alice.didDocument,
        didDocumentMetadata : alice.didDocumentMetadata,
      });

      run('bun', [
        GITD_MAIN,
        'init',
        'passive-demo',
        '--no-local',
      ], { env: testEnv('alice', passiveDwn.url) });

      const alicePort = await freePort();
      const aliceServe = await startServe('alice', passiveDwn.url, alicePort);
      processes.push(aliceServe.proc);

      const remoteUrl = await authenticatedRemoteUrl(
        alicePort,
        alice.did,
        'passive-demo',
        () => `stdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`,
      );
      createAndPushMain(resolve(BASE, 'alice-public-reader-work'), remoteUrl);

      await waitFor(async () => {
        return aliceServe.stderr().includes('[push-sync] dwn pushed');
      }, async () => {
        return `Alice helper did not sync pushed repo to passive DWN\nstdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`;
      }, 40_000);

      const binDir = resolve(BASE, 'reader-bin');
      writeRemoteHelperWrapper(binDir);
      const readerPort = await freePort();
      const readerEnv = freshReaderEnv(passiveDwn.url, binDir, readerPort);
      const readerClone = resolve(BASE, 'fresh-reader-clone');
      let clone = { stdout: '', stderr: '' };

      await waitFor(async () => {
        rmSync(readerClone, { recursive: true, force: true });
        const result = await runAsyncRaw('bun', [
          GITD_MAIN,
          'clone',
          `${alice.did}/passive-demo`,
          readerClone,
        ], {
          cwd       : resolve('.'),
          timeoutMs : 90_000,
          env       : readerEnv,
        });
        clone = {
          stdout : result.stdout,
          stderr : result.stderr,
        };
        return result.status === 0;
      }, async () => {
        return [
          'Fresh reader could not clone Alice repo through passive DWN',
          `stdout:\n${clone.stdout}`,
          `stderr:\n${clone.stderr}`,
        ].join('\n');
      }, 120_000);

      expect(clone.stdout).toContain('local public-read cache');
      expect(clone.stdout).not.toContain('Recovery phrase');
      expect(clone.stdout).not.toContain('Identity password');
      expect(clone.stderr).toContain('(via LocalDwnHelper)');
      expect(readFileSync(resolve(readerClone, 'README.md'), 'utf-8')).toContain('Passive DWN demo');
      expect(run('git', ['config', '--local', 'enbox.profile'], { cwd: readerClone }).stdout.trim()).toBe('public-reader');

      const readerConfigPath = resolve(BASE, 'fresh-reader-home', 'config.json');
      if (existsSync(readerConfigPath)) {
        const readerConfig = JSON.parse(readFileSync(readerConfigPath, 'utf-8')) as { profiles?: Record<string, unknown> };
        expect(readerConfig.profiles ?? {}).toEqual({});
      }

      await runAsyncRaw('bun', [
        GITD_MAIN,
        'helper',
        'stop',
        '--profile',
        'public-reader',
      ], {
        cwd       : resolve('.'),
        timeoutMs : 10_000,
        env       : readerEnv,
      });
    } finally {
      await passiveDwn.stop();
    }
  }, 180_000);

  it('creates a contributor PR with --push without a manual branch refspec', async () => {
    rmSync(BASE, { recursive: true, force: true });

    const passiveDwn = await startPassiveDwnServer({ dataPath: resolve(BASE, 'passive-dwn') });
    try {
      const alice = bootstrapProfile('alice', passiveDwn.url);
      const bob = bootstrapProfile('bob', passiveDwn.url);
      const actors = [alice, bob];

      for (const actor of actors) {
        passiveDwn.addDidDocument({
          didDocument         : actor.didDocument,
          didDocumentMetadata : actor.didDocumentMetadata,
        });
      }
      cacheDidDocuments(actors, passiveDwn.url);

      run('bun', [
        GITD_MAIN,
        'init',
        'passive-demo',
        '--no-local',
      ], { env: testEnv('alice', passiveDwn.url) });

      const addContributor = await runEventually('bun', [
        GITD_MAIN,
        'repo',
        'add-contributor',
        bob.did,
        '--repo',
        'passive-demo',
      ], { env: testEnv('alice', passiveDwn.url) });
      expect(addContributor.stdout).toContain('Added contributor');

      const alicePort = await freePort();
      const aliceServe = await startServe('alice', passiveDwn.url, alicePort);
      processes.push(aliceServe.proc);

      const remoteUrl = await authenticatedRemoteUrl(
        alicePort,
        alice.did,
        'passive-demo',
        () => `stdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`,
      );
      createAndPushMain(resolve(BASE, 'alice-contributor-pr-work'), remoteUrl);

      await waitFor(async () => {
        return aliceServe.stderr().includes('[push-sync] dwn pushed');
      }, async () => {
        return `Alice helper did not sync pushed repo to passive DWN\nstdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`;
      }, 40_000);

      await stopProcess(aliceServe.proc);

      const bobPort = await freePort();
      const bobServe = await startServe('bob', passiveDwn.url, bobPort);
      processes.push(bobServe.proc);

      const binDir = resolve(BASE, 'contributor-bin');
      writeRemoteHelperWrapper(binDir);
      const bobEnv = {
        ...testEnv('bob', passiveDwn.url),
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      };
      const bobClone = resolve(BASE, 'bob-contributor-pr-clone');

      const clone = await runAsync('bun', [
        GITD_MAIN,
        'clone',
        `${alice.did}/passive-demo`,
        bobClone,
      ], {
        cwd       : resolve('.'),
        timeoutMs : 90_000,
        env       : bobEnv,
      });
      expect(clone.stdout).toContain('Checked out');

      run('git', ['config', 'user.email', 'bob@example.com'], { cwd: bobClone });
      run('git', ['config', 'user.name', 'Bob'], { cwd: bobClone });
      run('git', ['checkout', '-b', 'contributor-pr'], { cwd: bobClone });
      writeFileSync(resolve(bobClone, 'contributor-pr.txt'), 'Contributor PR through gitd pr create --push.\n', 'utf-8');
      run('git', ['add', 'contributor-pr.txt'], { cwd: bobClone });
      run('git', ['commit', '-m', 'feat: contributor pr create push'], { cwd: bobClone });

      const pr = await runAsync('bun', [
        GITD_MAIN,
        'pr',
        'create',
        'Contributor PR create push',
        '--body',
        'Created without manually pushing a contributor refspec.',
        '--repo',
        'passive-demo',
        '--owner',
        alice.did,
        '--push',
      ], {
        cwd       : bobClone,
        timeoutMs : 120_000,
        env       : bobEnv,
      });

      expect(pr.stdout).toContain('Created PR');
      expect(pr.stdout).toContain('Contributor branch: refs/heads/users/');
      expect(pr.stdout).toContain('Publishing branch: git push origin HEAD:refs/heads/users/');
      expect(pr.stderr).toContain('[dwn-apply] PR: Applied');

      await waitFor(async () => {
        return bobServe.stderr().includes('[push-sync] remote branch writeback complete')
          && bobServe.stderr().includes('[dwn-apply] remote branch writeback')
          && bobServe.stderr().includes(': Applied');
      }, async () => {
        return [
          'Bob contributor PR --push did not write the branch to Alice passive DWN',
          `pr stdout:\n${pr.stdout}`,
          `pr stderr:\n${pr.stderr}`,
          `helper stdout:\n${bobServe.stdout()}`,
          `helper stderr:\n${bobServe.stderr()}`,
        ].join('\n');
      }, 60_000);
    } finally {
      await passiveDwn.stop();
    }
  }, 180_000);

  it('runs contributor push, canonical work items, moderation, maintainer merge, and clone through passive DWN', async () => {
    rmSync(BASE, { recursive: true, force: true });

    const passiveDwn = await startPassiveDwnServer({ dataPath: resolve(BASE, 'passive-dwn') });
    try {
      const alice = bootstrapProfile('alice', passiveDwn.url);
      const bob = bootstrapProfile('bob', passiveDwn.url);
      const casey = bootstrapProfile('casey', passiveDwn.url);
      const actors = [alice, bob, casey];

      for (const actor of actors) {
        expect(actor.didDocument.id).toBe(actor.did);
        passiveDwn.addDidDocument({
          didDocument         : actor.didDocument,
          didDocumentMetadata : actor.didDocumentMetadata,
        });
      }
      cacheDidDocuments(actors, passiveDwn.url);

      run('bun', [
        GITD_MAIN,
        'init',
        'passive-demo',
        '--no-local',
      ], { env: testEnv('alice', passiveDwn.url) });

      const addContributor = await runEventually('bun', [
        GITD_MAIN,
        'repo',
        'add-contributor',
        bob.did,
        '--repo',
        'passive-demo',
      ], { env: testEnv('alice', passiveDwn.url) });
      expect(addContributor.stdout).toContain('Added contributor');
      expect(addContributor.stderr).not.toContain('Database is not open');
      const addModerator = await runEventually('bun', [
        GITD_MAIN,
        'repo',
        'add-moderator',
        casey.did,
        '--repo',
        'passive-demo',
      ], { env: testEnv('alice', passiveDwn.url) });
      expect(addModerator.stdout).toContain('Added moderator');
      expect(addModerator.stderr).not.toContain('Database is not open');

      const alicePort = await freePort();
      const aliceServe = await startServe('alice', passiveDwn.url, alicePort);
      processes.push(aliceServe.proc);

      const remoteUrl = await authenticatedRemoteUrl(
        alicePort,
        alice.did,
        'passive-demo',
        () => `stdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`,
      );
      const aliceWork = resolve(BASE, 'alice-work');
      createAndPushMain(aliceWork, remoteUrl);

      await waitFor(async () => {
        return aliceServe.stderr().includes('[push-sync] dwn pushed');
      }, async () => {
        return `Alice helper did not finish post-push DWN sync\nstdout:\n${aliceServe.stdout()}\nstderr:\n${aliceServe.stderr()}`;
      }, 40_000);

      await stopProcess(aliceServe.proc);

      const bobPort = await freePort();
      const bobServe = await startServe('bob', passiveDwn.url, bobPort);
      processes.push(bobServe.proc);

      const binDir = resolve(BASE, 'bin');
      writeRemoteHelperWrapper(binDir);

      const bobClone = resolve(BASE, 'bob-clone');
      let clone = { stdout: '', stderr: '' };
      await waitFor(async () => {
        rmSync(bobClone, { recursive: true, force: true });
        const result = await runAsyncRaw('git', [
          '-c',
          'protocol.version=0',
          'clone',
          '--branch',
          'main',
          `did::${alice.did}/passive-demo`,
          bobClone,
        ], {
          cwd       : resolve('.'),
          timeoutMs : 60_000,
          env       : {
            ...testEnv('bob', passiveDwn.url),
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
        });
        clone = {
          stdout : result.stdout,
          stderr : result.stderr,
        };
        return result.status === 0;
      }, async () => {
        return [
          'Bob could not clone Alice repo through passive DWN',
          `stdout:\n${clone.stdout}`,
          `stderr:\n${clone.stderr}`,
          `helper stdout:\n${bobServe.stdout()}`,
          `helper stderr:\n${bobServe.stderr()}`,
        ].join('\n');
      }, 60_000);

      expect(clone.stderr).toContain('(via LocalDwnHelper)');
      expect(readFileSync(resolve(bobClone, 'README.md'), 'utf-8')).toContain('Passive DWN demo');
      const tip = run('git', ['rev-parse', 'HEAD'], { cwd: bobClone });
      expect(tip.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

      const contributorRef = `refs/heads/users/${branchOwnerHash(bob.did)}/passive-feature`;
      run('git', ['config', 'user.email', 'bob@example.com'], { cwd: bobClone });
      run('git', ['config', 'user.name', 'Bob'], { cwd: bobClone });
      run('git', ['checkout', '-b', 'passive-feature'], { cwd: bobClone });
      writeFileSync(resolve(bobClone, 'feature.txt'), 'Bob feature via passive DWN.\n', 'utf-8');
      run('git', ['add', 'feature.txt'], { cwd: bobClone });
      run('git', ['commit', '-m', 'feat: passive contributor branch'], { cwd: bobClone });

      const pushResult = await runAsyncRaw('git', [
        'push',
        'origin',
        `HEAD:${contributorRef}`,
      ], {
        cwd       : bobClone,
        timeoutMs : 120_000,
        env       : {
          ...testEnv('bob', passiveDwn.url),
          PATH                : `${binDir}:${process.env.PATH ?? ''}`,
          GIT_TERMINAL_PROMPT : '0',
        },
      });
      if (pushResult.status !== 0) {
        throw new Error([
          `Bob contributor push failed with status ${pushResult.status}`,
          `stdout:\n${pushResult.stdout}`,
          `stderr:\n${pushResult.stderr}`,
          `helper stdout:\n${bobServe.stdout()}`,
          `helper stderr:\n${bobServe.stderr()}`,
        ].join('\n'));
      }
      expect(pushResult.stderr).toContain('(via LocalDwnHelper)');
      await waitFor(async () => {
        return bobServe.stderr().includes('[push-sync] remote branch writeback complete')
          && bobServe.stderr().includes('[dwn-apply] remote branch writeback')
          && bobServe.stderr().includes(': Applied');
      }, async () => {
        return [
          'Bob contributor branch writeback did not apply to Alice passive DWN',
          `helper stdout:\n${bobServe.stdout()}`,
          `helper stderr:\n${bobServe.stderr()}`,
        ].join('\n');
      }, 60_000);

      const issue = await runAsync('bun', [
        GITD_MAIN,
        'issue',
        'create',
        'Passive canonical issue',
        '--body',
        'Created by Bob through his local helper and Alice passive DWN.',
        '--repo',
        'passive-demo',
        '--owner',
        alice.did,
      ], {
        cwd : bobClone,
        env : testEnv('bob', passiveDwn.url),
      });
      expect(issue.stdout).toContain('Created issue');
      expect(issue.stderr).toContain('[dwn-process] issue: 202');
      expect(issue.stderr).not.toContain('Database is not open');

      const pr = await runAsync('bun', [
        GITD_MAIN,
        'pr',
        'create',
        'Passive canonical PR',
        '--body',
        'Created by Bob through his local helper and Alice passive DWN.',
        '--base',
        'main',
        '--repo',
        'passive-demo',
        '--owner',
        alice.did,
      ], {
        cwd : bobClone,
        env : testEnv('bob', passiveDwn.url),
      });
      expect(pr.stdout).toContain('Created PR');
      expect(pr.stdout).toContain('Bundle:');
      expect(pr.stderr).toContain('[dwn-apply] PR: Applied');
      const prRecordId = recordIdFromOutput(pr.stdout, 'PR');

      const prComment = await runAsync('bun', [
        GITD_MAIN,
        'pr',
        'comment',
        prRecordId,
        'Bob review note before moderator lock.',
        '--repo',
        'passive-demo',
        '--owner',
        alice.did,
      ], {
        cwd : bobClone,
        env : testEnv('bob', passiveDwn.url),
      });
      expect(prComment.stdout).toContain('Added comment to PR');

      const caseyPort = await freePort();
      const caseyServe = await startServe('casey', passiveDwn.url, caseyPort);
      processes.push(caseyServe.proc);

      const lock = await runAsync('bun', [
        GITD_MAIN,
        'mod',
        'lock',
        'pr',
        prRecordId,
        '--reason',
        'heated',
        '--repo',
        'passive-demo',
        '--owner',
        alice.did,
      ], {
        env: testEnv('casey', passiveDwn.url),
      });
      expect(lock.stdout).toContain('Locked pr');
      expect(lock.stderr).toContain('[dwn-apply] moderation event: Applied');
      expect(lock.stderr).not.toContain('Database is not open');

      const aliceMergePort = await freePort();
      const aliceMergeServe = await startServe('alice', passiveDwn.url, aliceMergePort);
      processes.push(aliceMergeServe.proc);

      let checkout = { stdout: '', stderr: '' };
      await waitFor(async () => {
        const result = await runAsyncRaw('bun', [
          GITD_MAIN,
          'pr',
          'checkout',
          prRecordId,
          '--repo',
          'passive-demo',
        ], {
          cwd       : aliceWork,
          timeoutMs : 30_000,
          env       : testEnv('alice', passiveDwn.url),
        });
        checkout = {
          stdout : result.stdout,
          stderr : result.stderr,
        };
        return result.status === 0;
      }, async () => {
        return [
          'Alice could not checkout Bob PR after sync from passive DWN',
          `stdout:\n${checkout.stdout}`,
          `stderr:\n${checkout.stderr}`,
          `helper stdout:\n${aliceMergeServe.stdout()}`,
          `helper stderr:\n${aliceMergeServe.stderr()}`,
        ].join('\n');
      }, 90_000);

      const merge = await runAsync('bun', [
        GITD_MAIN,
        'pr',
        'merge',
        prRecordId,
        '--no-delete-branch',
        '--repo',
        'passive-demo',
      ], {
        cwd : aliceWork,
        env : testEnv('alice', passiveDwn.url),
      });
      expect(merge.stdout).toContain('Merged PR');

      const freshRemoteUrl = await authenticatedRemoteUrl(
        aliceMergePort,
        alice.did,
        'passive-demo',
        () => `stdout:\n${aliceMergeServe.stdout()}\nstderr:\n${aliceMergeServe.stderr()}`,
      );
      run('git', ['remote', 'set-url', 'origin', freshRemoteUrl], { cwd: aliceWork });
      run('git', ['push', 'origin', 'main'], {
        cwd : aliceWork,
        env : {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      await waitFor(async () => {
        return aliceMergeServe.stderr().includes('[push-sync] dwn pushed');
      }, async () => {
        return `Alice merge push did not sync to passive DWN\nstdout:\n${aliceMergeServe.stdout()}\nstderr:\n${aliceMergeServe.stderr()}`;
      }, 60_000);

      await stopProcess(bobServe.proc);
      rmSync(bobClone, { recursive: true, force: true });

      const bobFinalPort = await freePort();
      const bobFinalServe = await startServe('bob', passiveDwn.url, bobFinalPort);
      processes.push(bobFinalServe.proc);

      const finalClone = resolve(BASE, 'bob-final-clone');
      let finalResult = { stdout: '', stderr: '' };
      await waitFor(async () => {
        rmSync(finalClone, { recursive: true, force: true });
        const result = await runAsyncRaw('git', [
          '-c',
          'protocol.version=0',
          'clone',
          '--branch',
          'main',
          `did::${alice.did}/passive-demo`,
          finalClone,
        ], {
          cwd       : resolve('.'),
          timeoutMs : 60_000,
          env       : {
            ...testEnv('bob', passiveDwn.url),
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
        });
        finalResult = {
          stdout : result.stdout,
          stderr : result.stderr,
        };
        return result.status === 0;
      }, async () => {
        return [
          'Bob could not clone Alice merged repo through passive DWN',
          `stdout:\n${finalResult.stdout}`,
          `stderr:\n${finalResult.stderr}`,
          `helper stdout:\n${bobFinalServe.stdout()}`,
          `helper stderr:\n${bobFinalServe.stderr()}`,
        ].join('\n');
      }, 90_000);

      expect(finalResult.stderr).toContain('(via LocalDwnHelper)');
      expect(readFileSync(resolve(finalClone, 'feature.txt'), 'utf-8')).toContain('Bob feature via passive DWN.');
    } finally {
      await passiveDwn.stop();
    }
  }, 360_000);
});

function bootstrapProfile(profile: string, dwnEndpoint: string): BootstrapResult {
  const result = spawnSync('bun', [BOOTSTRAP, profile, PASSWORD], {
    cwd      : resolve('.'),
    encoding : 'utf-8',
    env      : testEnv(profile, dwnEndpoint),
  });

  if (result.status !== 0) {
    throw new Error(`profile bootstrap failed for ${profile}:\n${result.stderr}\n${result.stdout}`);
  }

  return JSON.parse(result.stdout.trim()) as BootstrapResult;
}

function cacheDidDocuments(actors: BootstrapResult[], dwnEndpoint: string): void {
  const docsPath = resolve(BASE, 'did-docs.json');
  writeFileSync(docsPath, JSON.stringify(actors.map((actor) => ({
    didDocument         : actor.didDocument,
    didDocumentMetadata : actor.didDocumentMetadata,
  }))), 'utf-8');

  for (const actor of actors) {
    run('bun', [
      CACHE_DID_DOCS,
      actor.profile,
      PASSWORD,
      docsPath,
    ], { env: testEnv(actor.profile, dwnEndpoint) });
  }
}

async function startServe(
  profile: string,
  dwnEndpoint: string,
  port: number,
): Promise<{
  proc: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
}> {
  const proc = spawn('bun', [
    GITD_MAIN,
    'serve',
    '--foreground',
    '--sync',
    '1s',
    '--port',
    String(port),
  ], {
    cwd   : resolve('.'),
    env   : testEnv(profile, dwnEndpoint),
    stdio : ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitFor(
      async () => stdout.includes('gitd server listening on port'),
      async () => `gitd serve did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      30_000,
    );
  } catch (err) {
    await stopProcess(proc);
    throw err;
  }

  return {
    proc,
    stdout : () => stdout,
    stderr : () => stderr,
  };
}

async function authenticatedRemoteUrl(
  port: number,
  ownerDid: string,
  repoName: string,
  diagnostics: () => string = () => '',
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/auth/token`, {
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    body    : JSON.stringify({ owner: ownerDid, repo: repoName }),
  });

  if (!response.ok) {
    throw new Error(`auth token request failed: ${response.status} ${await response.text()}\n${diagnostics()}`);
  }

  const creds = await response.json() as { username?: string; password?: string };
  if (!creds.username || !creds.password) {
    throw new Error('auth token response was missing username or password');
  }

  const username = encodeURIComponent(creds.username);
  const password = encodeURIComponent(creds.password);
  const owner = encodeURIComponent(ownerDid);

  return `http://${username}:${password}@127.0.0.1:${port}/${owner}/${repoName}`;
}

function createAndPushMain(workdir: string, remoteUrl: string): void {
  mkdirSync(workdir, { recursive: true });
  run('git', ['init'], { cwd: workdir });
  run('git', ['config', 'user.email', 'alice@example.com'], { cwd: workdir });
  run('git', ['config', 'user.name', 'Alice'], { cwd: workdir });
  run('git', ['checkout', '-b', 'main'], { cwd: workdir });
  writeFileSync(resolve(workdir, 'README.md'), '# Passive DWN demo\n\nPublished from Alice edge helper.\n', 'utf-8');
  run('git', ['add', 'README.md'], { cwd: workdir });
  run('git', ['commit', '-m', 'Initial commit'], { cwd: workdir });
  run('git', ['remote', 'add', 'origin', remoteUrl], { cwd: workdir });
  run('git', ['push', '-u', 'origin', 'main'], {
    cwd : workdir,
    env : {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function writeRemoteHelperWrapper(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const helperBinPath = resolve(binDir, 'git-remote-did');
  writeFileSync(
    helperBinPath,
    `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve('src/git-remote/main.ts'))} "$@"\n`,
    'utf-8',
  );
  chmodSync(helperBinPath, 0o755);
}

async function queryRemoteRepos(
  dwnUrl: string,
  ownerDid: string,
  repoName: string,
): Promise<NonNullable<Awaited<ReturnType<HttpDwnRpcClient['sendDwnRequest']>>['entries']>> {
  return queryRemoteRecords(dwnUrl, ownerDid, ForgeRepoDefinition.protocol, 'repo', { name: repoName });
}

async function queryRemoteRecords(
  dwnUrl: string,
  ownerDid: string,
  protocol: string,
  protocolPath: string,
  tags?: Record<string, unknown>,
  filter?: Record<string, unknown>,
): Promise<NonNullable<Awaited<ReturnType<HttpDwnRpcClient['sendDwnRequest']>>['entries']>> {
  const query = await RecordsQuery.create({
    filter: {
      protocol,
      protocolPath,
      ...(filter ?? {}),
      ...(tags ? { tags } : {}),
    },
  });

  const reply = await new HttpDwnRpcClient().sendDwnRequest({
    dwnUrl,
    targetDid : ownerDid,
    message   : query.message,
  });

  if (reply.status.code !== 200) {
    return [];
  }

  return reply.entries ?? [];
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd      : options.cwd ?? resolve('.'),
    env      : options.env ?? process.env,
    encoding : 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    stdout : result.stdout,
    stderr : result.stderr,
  };
}

async function runAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await runAsyncRaw(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    stdout : result.stdout,
    stderr : result.stderr,
  };
}

async function runEventually(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  let last = { status: 1 as number | null, stdout: '', stderr: '' };
  await waitFor(async () => {
    last = await runAsyncRaw(command, args, options);
    return last.status === 0;
  }, async () => {
    return `${command} ${args.join(' ')} did not succeed\nstdout:\n${last.stdout}\nstderr:\n${last.stderr}`;
  }, timeoutMs);

  return {
    stdout : last.stdout,
    stderr : last.stderr,
  };
}

async function runAsyncRaw(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd   : options.cwd ?? resolve('.'),
    env   : options.env ?? process.env,
    stdio : ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs)
    : undefined;

  const status = await new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
    child.once('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolveExit(1);
    });
  });

  if (timer) { clearTimeout(timer); }
  if (timedOut) {
    stderr += `\ntimeout after ${options.timeoutMs}ms`;
  }

  return { status, stdout, stderr };
}

function recordIdFromOutput(stdout: string, label: string): string {
  const match = stdout.match(/Record ID:\s+(\S+)/);
  if (!match) {
    throw new Error(`Could not parse ${label} record ID from output:\n${stdout}`);
  }
  return match[1];
}

function testEnv(profile: string, dwnEndpoint: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENBOX_HOME,
    GITD_PROFILE                   : profile,
    GITD_PASSWORD                  : PASSWORD,
    GITD_DWN_ENDPOINT              : dwnEndpoint,
    GITD_DWN_REGISTRATION          : 'off',
    GITD_DID_REPUBLISH             : 'off',
    GITD_DEBUG                     : '1',
    GITD_DID_RESOLUTION_TIMEOUT_MS : '1000',
  };
}

function freshReaderEnv(dwnEndpoint: string, binDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME                           : resolve(BASE, 'fresh-reader-home'),
    ENBOX_HOME                     : resolve(BASE, 'fresh-reader-home'),
    PATH                           : `${binDir}:${process.env.PATH ?? ''}`,
    GITD_PORT                      : String(port),
    GITD_DWN_ENDPOINT              : dwnEndpoint,
    GITD_DWN_REGISTRATION          : 'off',
    GITD_DID_REPUBLISH             : 'off',
    GITD_DEBUG                     : '1',
    GITD_DID_RESOLUTION_TIMEOUT_MS : '1000',
    GIT_TERMINAL_PROMPT            : '0',
  };
  delete env.GITD_PROFILE;
  delete env.ENBOX_PROFILE;
  delete env.GITD_PASSWORD;
  return env;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string | Promise<string>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) { return; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(await errorMessage());
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.killed || proc.exitCode !== null) { return; }
  proc.kill('SIGINT');
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
      resolveStop();
    }, 2_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}
