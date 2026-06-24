import { afterAll, describe, expect, it } from 'bun:test';

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = resolve('__TESTDATA__/ux-mvp-e2e');
const HOME = join(BASE, 'home');
const BIN = join(BASE, 'bin');
const WORK = join(BASE, 'author-work');
const CLONE = join(BASE, 'author-clone');
const GITD_MAIN = resolve('src/cli/main.ts');
const PASSWORD = 'ux-mvp-e2e-password';

describe('E2E: UX MVP fresh author machine', () => {
  afterAll(() => {
    runOptional('bun', [GITD_MAIN, 'helper', 'stop', '--profile', 'default'], { cwd: BASE, env: testEnv(false) });
    rmSync(BASE, { recursive: true, force: true });
  });

  it('sets up DID git, creates an implicit identity, pushes, and clones without manual helper commands', async () => {
    const port = await freePort();
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    const setup = run('bun', [GITD_MAIN, 'setup', '--bin-dir', BIN, '--quiet'], {
      cwd : BASE,
      env : testEnv(true, port),
    });
    expect(setup.stderr).not.toContain('source binary not found');

    const helperConfig = run('git', ['config', '--global', '--get', 'credential.helper'], {
      cwd : BASE,
      env : testEnv(false, port),
    }).stdout.trim();
    expect(helperConfig).toBe(join(BIN, 'git-remote-did-credential'));

    const init = run('bun', [GITD_MAIN, 'init', 'demo'], {
      cwd     : WORK,
      env     : testEnv(true, port),
      timeout : 45_000,
    });
    expect(init.stdout).toContain('Created identity "default".');
    expect(init.stdout).toContain('Next:');
    expect(init.stderr).not.toContain('Could not start local helper');

    writeFileSync(join(WORK, 'README.md'), 'hello from ux mvp\n');
    run('git', ['config', 'user.email', 'ux-mvp@example.com'], { cwd: WORK, env: testEnv(false, port) });
    run('git', ['config', 'user.name', 'UX MVP'], { cwd: WORK, env: testEnv(false, port) });
    run('git', ['add', 'README.md'], { cwd: WORK, env: testEnv(false, port) });
    run('git', ['commit', '-m', 'initial commit'], { cwd: WORK, env: testEnv(false, port) });

    const push = run('git', ['push', '-u', 'origin', 'main'], {
      cwd     : WORK,
      env     : testEnv(false, port),
      timeout : 45_000,
    });
    expect(`${push.stdout}\n${push.stderr}`).toContain('main -> main');

    const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: WORK, env: testEnv(false, port) }).stdout.trim();
    expect(origin).toMatch(/^did::did:dht:[^/]+\/demo$/);

    run('git', ['clone', origin, CLONE], {
      cwd     : BASE,
      env     : testEnv(false, port),
      timeout : 45_000,
    });
    expect(existsSync(join(CLONE, 'README.md'))).toBe(true);
    expect(readFileSync(join(CLONE, 'README.md'), 'utf-8')).toBe('hello from ux mvp\n');
  }, 120_000);
});

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
};

function testEnv(includePassword: boolean, port?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME,
    ENBOX_HOME            : HOME,
    PATH                  : `${BIN}:${process.env.PATH ?? ''}`,
    GITD_DWN_REGISTRATION : 'off',
    GITD_DID_REPUBLISH    : 'off',
    GITD_PORT             : port === undefined ? undefined : String(port),
    GITD_SYNC             : 'off',
    GIT_TERMINAL_PROMPT   : '0',
  };
  delete env.GITD_PROFILE;
  delete env.ENBOX_PROFILE;
  if (includePassword) {
    env.GITD_PASSWORD = PASSWORD;
  } else {
    delete env.GITD_PASSWORD;
  }
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

function run(command: string, args: string[], options: RunOptions): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd      : options.cwd,
    env      : options.env,
    encoding : 'utf-8',
    timeout  : options.timeout ?? 30_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\n`
      + `stdout:\n${result.stdout}\n`
      + `stderr:\n${result.stderr}`,
    );
  }

  return {
    stdout : result.stdout ?? '',
    stderr : result.stderr ?? '',
  };
}

function runOptional(command: string, args: string[], options: RunOptions): void {
  spawnSync(command, args, {
    cwd      : options.cwd,
    env      : options.env,
    encoding : 'utf-8',
    timeout  : options.timeout ?? 10_000,
  });
}
