import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  firstAuthPositionalArg,
  formatAuthSessionsStatus,
  normalizeIdentityNameInput,
  resetIdentityLocally,
  setDefaultIdentity,
  suggestIdentityName,
  validateIdentityNameInput,
} from '../src/cli/commands/auth.js';
import { profileDataPath, readConfig, upsertProfile } from '../src/profiles/config.js';

let originalEnboxHome: string | undefined;
let tempDir: string;

describe('auth login helpers', () => {
  beforeEach(() => {
    originalEnboxHome = process.env.ENBOX_HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'gitd-auth-helpers-'));
    process.env.ENBOX_HOME = join(tempDir, 'enbox');
  });

  afterEach(() => {
    if (originalEnboxHome) {
      process.env.ENBOX_HOME = originalEnboxHome;
    } else {
      delete process.env.ENBOX_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suggests default for the first identity', () => {
    expect(suggestIdentityName([])).toBe('default');
  });

  it('suggests the next generated identity when default exists', () => {
    expect(suggestIdentityName(['default'])).toBe('identity-2');
    expect(suggestIdentityName(['default', 'identity-2'])).toBe('identity-3');
  });

  it('normalizes blank input to the default identity name', () => {
    expect(normalizeIdentityNameInput('', 'default')).toBe('default');
    expect(normalizeIdentityNameInput('   ', 'identity-2')).toBe('identity-2');
    expect(normalizeIdentityNameInput(' work ', 'default')).toBe('work');
  });

  it('validates generated names against existing identities', () => {
    expect(validateIdentityNameInput('', [], 'default')).toBeUndefined();
    expect(validateIdentityNameInput('default', ['default'])).toContain('already exists');
    expect(validateIdentityNameInput('bad name', [])).toContain('Only letters');
  });

  it('sets the default identity', () => {
    upsertProfile('default', { name: 'default', did: 'did:dht:default', createdAt: '2026-06-23T00:00:00.000Z' });
    upsertProfile('work', { name: 'work', did: 'did:dht:work', createdAt: '2026-06-23T00:00:00.000Z' });

    expect(setDefaultIdentity('work')).toBe('Default identity set to "work".');
    expect(readConfig().defaultProfile).toBe('work');
  });

  it('rejects switching to an unknown identity', () => {
    expect(() => setDefaultIdentity('missing')).toThrow('Identity "missing" not found');
  });

  it('archives and removes an identity during reset', () => {
    upsertProfile('default', { name: 'default', did: 'did:dht:default', createdAt: '2026-06-23T00:00:00.000Z' });
    upsertProfile('work', { name: 'work', did: 'did:dht:work', createdAt: '2026-06-23T00:00:00.000Z' });

    const dataPath = profileDataPath('default');
    mkdirSync(dataPath, { recursive: true });
    writeFileSync(join(dataPath, 'marker.txt'), 'profile data\n', 'utf-8');

    const result = resetIdentityLocally('default', new Date('2026-06-23T12:00:00.000Z'));
    const config = readConfig();

    expect(result.name).toBe('default');
    expect(result.defaultProfile).toBe('work');
    expect(result.backupPath).toContain('default-2026-06-23T12-00-00-000Z');
    expect(config.profiles.default).toBeUndefined();
    expect(config.defaultProfile).toBe('work');
    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(join(result.backupPath!, 'DATA', 'AGENT', 'marker.txt'))).toBe(true);
  });

  it('rejects resetting an unknown identity', () => {
    expect(() => resetIdentityLocally('missing')).toThrow('Identity "missing" not found');
  });

  it('formats the empty helper session state', () => {
    expect(formatAuthSessionsStatus({ running: false })).toEqual([
      'No active helper session.',
      'Run `gitd helper start` to start one.',
    ]);
  });

  it('formats an active helper session with capabilities', () => {
    expect(formatAuthSessionsStatus({
      running      : true,
      pid          : 123,
      port         : 9418,
      ownerDid     : 'did:dht:alice',
      sessionId    : 'helper:default:123',
      profileName  : 'default',
      reposPath    : '/tmp/gitd/repos',
      capabilities : ['git-transport', 'dwn-restore'],
      expiryPolicy : 'helper-lifetime',
      repoContexts : [{
        ownerDid      : 'did:dht:alice',
        repo          : 'demo',
        path          : '/tmp/demo',
        defaultBranch : 'main',
        lastSeenAt    : '2026-06-23T00:00:00.000Z',
      }],
    })).toEqual([
      'Active helper session',
      '  ID:      helper:default:123',
      '  Profile: default',
      '  DID:     did:dht:alice',
      '  Port:    9418',
      '  Repos:   /tmp/gitd/repos',
      '  Capabilities:',
      '    - git-transport',
      '    - dwn-restore',
      '  Expires: when helper stops',
      '  Seen repos:',
      '    - did:dht:alice/demo (main) at /tmp/demo',
      '  Revoke:  gitd auth revoke helper',
    ]);
  });

  it('parses auth positional args without treating --profile values as targets', () => {
    expect(firstAuthPositionalArg(['helper', '--profile', 'default'])).toBe('helper');
    expect(firstAuthPositionalArg(['--profile', 'default', 'helper'])).toBe('helper');
    expect(firstAuthPositionalArg(['--profile=default', 'helper'])).toBe('helper');
  });
});
