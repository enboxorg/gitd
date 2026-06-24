import { afterEach, describe, expect, it } from 'bun:test';

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

import {
  gitCloneEnv,
  parseCloneCommandArgs,
  parseCloneTarget,
  recordCloneContext,
  shouldUsePublicReaderProfile,
} from '../src/cli/commands/clone.js';

const BASE = resolve('__TESTDATA__/clone-helpers');

function gitConfig(cwd: string, key: string): string {
  const result = spawnSync('git', ['config', '--local', key], {
    cwd,
    encoding : 'utf-8',
    stdio    : ['pipe', 'pipe', 'pipe'],
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe('clone helpers', () => {
  afterEach(() => {
    rmSync(BASE, { recursive: true, force: true });
  });

  it('parses did/repo clone targets', () => {
    expect(parseCloneTarget('did:dht:abc123/demo')).toEqual({
      did  : 'did:dht:abc123',
      repo : 'demo',
    });
  });

  it('rejects malformed clone targets', () => {
    expect(() => parseCloneTarget('not-a-did/demo')).toThrow('Invalid target');
    expect(() => parseCloneTarget('did:dht:abc123')).toThrow('Invalid target');
    expect(() => parseCloneTarget('did:dht:abc123/')).toThrow('Missing repository name');
  });

  it('strips gitd profile flags before passing args to git clone', () => {
    expect(parseCloneCommandArgs(['--profile', 'work', '--depth', '1', 'local'])).toEqual({
      profileName : 'work',
      gitArgs     : ['--depth', '1', 'local'],
    });
    expect(parseCloneCommandArgs(['--profile=work', '--branch', 'main'])).toEqual({
      profileName : 'work',
      gitArgs     : ['--branch', 'main'],
    });
  });

  it('treats args after the separator as native git clone args', () => {
    expect(parseCloneCommandArgs(['--', '--profile', 'native-value'])).toEqual({
      profileName : undefined,
      gitArgs     : ['--profile', 'native-value'],
    });
  });

  it('stores repo context and active profile in local git config', () => {
    mkdirSync(BASE, { recursive: true });
    const init = spawnSync('git', ['init', BASE], { stdio: 'pipe' });
    expect(init.status).toBe(0);

    const warnings = recordCloneContext(
      BASE,
      { did: 'did:dht:abc123', repo: 'demo' },
      'work',
    );

    expect(warnings).toEqual([]);
    expect(gitConfig(BASE, 'enbox.owner')).toBe('did:dht:abc123');
    expect(gitConfig(BASE, 'enbox.repo')).toBe('demo');
    expect(gitConfig(BASE, 'enbox.profile')).toBe('work');
  });

  it('passes resolved profile selection to the native git clone environment', () => {
    expect(gitCloneEnv({ PATH: '/bin' }, 'work')).toEqual({
      PATH         : '/bin',
      GITD_PROFILE : 'work',
    });
    expect(gitCloneEnv({ PATH: '/bin' }, 'public-reader', 'secret')).toEqual({
      PATH          : '/bin',
      GITD_PROFILE  : 'public-reader',
      GITD_PASSWORD : 'secret',
    });
    expect(gitCloneEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('uses the public reader only when no identity is selected', () => {
    expect(shouldUsePublicReaderProfile(undefined, null)).toBe(true);
    expect(shouldUsePublicReaderProfile(undefined, undefined)).toBe(true);
    expect(shouldUsePublicReaderProfile('work', null)).toBe(false);
    expect(shouldUsePublicReaderProfile(undefined, 'work')).toBe(false);
  });
});
