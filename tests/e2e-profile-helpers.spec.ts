import { afterAll, describe, expect, it } from 'bun:test';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { readLockfile } from '../src/daemon/lockfile.js';

const BASE = resolve('__TESTDATA__/profile-helper-e2e');
const ENBOX_HOME = resolve(BASE, 'home');
const PASSWORD = 'profile-helper-e2e-password';
const BOOTSTRAP = resolve('tests/helpers/profile-bootstrap.ts');
const GITD_MAIN = resolve('src/cli/main.ts');

type Actor = {
  profile: 'alice' | 'bob' | 'casey';
  did: string;
  port: number;
  proc: ChildProcessWithoutNullStreams;
};

const actors: Actor[] = [];

describe('E2E: profile-backed spawned gitd helpers', () => {
  afterAll(async () => {
    await Promise.all(actors.map((actor) => stopProcess(actor.proc)));
    rmSync(BASE, { recursive: true, force: true });
  });

  it('starts Alice, Bob, and Casey helpers as separate profile-scoped processes', async () => {
    rmSync(BASE, { recursive: true, force: true });

    const alice = bootstrapProfile('alice');
    const bob = bootstrapProfile('bob');
    const casey = bootstrapProfile('casey');

    expect(new Set([alice.did, bob.did, casey.did]).size).toBe(3);

    runGitd('alice', ['init', 'helper-demo', '--no-local']);

    for (const profile of ['alice', 'bob', 'casey'] as const) {
      const actor = await startServeWithRetry(profile);
      actors.push(actor);
    }

    const originalHome = process.env.ENBOX_HOME;
    process.env.ENBOX_HOME = ENBOX_HOME;
    try {
      for (const actor of actors) {
        const lock = readLockfile(actor.profile);
        expect(lock).not.toBeNull();
        expect(lock!.ownerDid).toBe(actor.did);
        expect(lock!.port).toBe(actor.port);
        expect(lock!.dwnHelper).toBe(true);

        const health = await fetch(`http://127.0.0.1:${actor.port}/health`);
        expect(health.status).toBe(200);
      }

      const repoInfo = runGitd('alice', ['repo', 'info', '--repo', 'helper-demo']);
      expect(repoInfo.stdout).toContain('Repository: helper-demo');
      expect(repoInfo.stdout).toContain(`DID:            ${alice.did}`);
      expect(repoInfo.stderr).not.toContain('Database is not open');
    } finally {
      if (originalHome === undefined) {
        delete process.env.ENBOX_HOME;
      } else {
        process.env.ENBOX_HOME = originalHome;
      }
    }
  }, 90_000);
});

function bootstrapProfile(profile: Actor['profile']): { did: string } {
  const result = spawnSync('bun', [BOOTSTRAP, profile, PASSWORD], {
    cwd      : resolve('.'),
    encoding : 'utf-8',
    env      : testEnv(profile),
  });

  if (result.status !== 0) {
    throw new Error(`profile bootstrap failed for ${profile}:\n${result.stderr}\n${result.stdout}`);
  }

  return JSON.parse(result.stdout.trim()) as { did: string };
}

function runGitd(profile: Actor['profile'], args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync('bun', [GITD_MAIN, ...args], {
    cwd      : resolve('.'),
    encoding : 'utf-8',
    timeout  : 30_000,
    env      : testEnv(profile),
  });

  if (result.status !== 0) {
    throw new Error(`gitd ${args.join(' ')} failed for ${profile}:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    stdout : result.stdout,
    stderr : result.stderr,
  };
}

async function startServe(profile: Actor['profile'], port: number): Promise<Actor> {
  const proc = spawn('bun', [
    GITD_MAIN,
    'serve',
    '--foreground',
    '--no-sync',
    '--port',
    String(port),
  ], {
    cwd   : resolve('.'),
    env   : testEnv(profile),
    stdio : ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitFor(() => stdout.includes('gitd server listening on port'), () =>
      `gitd serve did not start for ${profile}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } catch (err) {
    await stopProcess(proc);
    throw err;
  }

  const did = stdout.match(/DID:\s+(did:[^\s]+)/)?.[1];
  if (!did) {
    throw new Error(`Could not parse DID from ${profile} serve output:\n${stdout}`);
  }

  return { profile, did, port, proc };
}

async function startServeWithRetry(profile: Actor['profile']): Promise<Actor> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    try {
      return await startServe(profile, port);
    } catch (err) {
      lastError = err;
      if (!String((err as Error).message).includes('is already in use')) {
        break;
      }
    }
  }
  throw lastError;
}

function testEnv(profile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENBOX_HOME,
    GITD_PROFILE          : profile,
    GITD_PASSWORD         : PASSWORD,
    GITD_DWN_REGISTRATION : 'off',
    GITD_DID_REPUBLISH    : 'off',
    GITD_SYNC             : 'off',
  };
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

async function waitFor(predicate: () => boolean, errorMessage: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) { return; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(errorMessage());
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
