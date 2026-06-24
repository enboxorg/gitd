import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { resolveLifecycleProfileName } from '../src/cli/commands/serve-lifecycle.js';
import {
  getOrCreatePublicReaderPassword,
  PUBLIC_READER_PROFILE,
  readPublicReaderState,
} from '../src/profiles/public-reader.js';
import {
  implicitRecoveryPhraseMessage,
  recordConnectedProfile,
  resolveCommandProfile,
} from '../src/cli/profile-session.js';
import { readConfig, upsertProfile, writeConfig } from '../src/profiles/config.js';

let originalCwd: string;
let originalEnboxHome: string | undefined;
let originalGitdProfile: string | undefined;
let originalEnboxProfile: string | undefined;
let tempDir: string;

describe('profile session helpers', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnboxHome = process.env.ENBOX_HOME;
    originalGitdProfile = process.env.GITD_PROFILE;
    originalEnboxProfile = process.env.ENBOX_PROFILE;
    tempDir = mkdtempSync(join(tmpdir(), 'gitd-profile-session-'));
    process.chdir(tempDir);
    process.env.ENBOX_HOME = join(tempDir, 'enbox');
    delete process.env.GITD_PROFILE;
    delete process.env.ENBOX_PROFILE;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnboxHome) {
      process.env.ENBOX_HOME = originalEnboxHome;
    } else {
      delete process.env.ENBOX_HOME;
    }
    if (originalGitdProfile) {
      process.env.GITD_PROFILE = originalGitdProfile;
    } else {
      delete process.env.GITD_PROFILE;
    }
    if (originalEnboxProfile) {
      process.env.ENBOX_PROFILE = originalEnboxProfile;
    } else {
      delete process.env.ENBOX_PROFILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses default for the first implicit identity', () => {
    const profile = resolveCommandProfile();
    expect(profile.name).toBe('default');
    expect(profile.dataPath).toContain(join('profiles', 'default', 'DATA', 'AGENT'));
  });

  it('uses default for first-run helper lifecycle commands', () => {
    expect(resolveLifecycleProfileName(['start'])).toBe('default');
    expect(resolveLifecycleProfileName(['status'])).toBe('default');
  });

  it('respects explicit profile names', () => {
    const profile = resolveCommandProfile('work');
    expect(profile.name).toBe('work');
    expect(profile.dataPath).toContain(join('profiles', 'work', 'DATA', 'AGENT'));
    expect(resolveLifecycleProfileName(['start', '--profile', 'work'])).toBe('work');
  });

  it('rejects ambiguous multiple identities without a default', () => {
    upsertProfile('work', { name: 'work', did: 'did:dht:work', createdAt: '2026-06-23T00:00:00.000Z' });
    upsertProfile('personal', { name: 'personal', did: 'did:dht:personal', createdAt: '2026-06-23T00:00:00.000Z' });
    const config = readConfig();
    config.defaultProfile = '';
    writeConfig(config);

    expect(() => resolveCommandProfile()).toThrow('Multiple identities');
    expect(() => resolveLifecycleProfileName(['start'])).toThrow('Multiple identities');
  });

  it('records connected profile metadata', () => {
    const result = recordConnectedProfile('default', 'did:dht:abc123');
    const config = readConfig();

    expect(result.created).toBe(true);
    expect(config.defaultProfile).toBe('default');
    expect(config.profiles.default.did).toBe('did:dht:abc123');
  });

  it('records hidden public reader metadata outside the normal identity list', () => {
    getOrCreatePublicReaderPassword();
    const result = recordConnectedProfile(PUBLIC_READER_PROFILE, 'did:dht:reader');
    const config = readConfig();

    expect(result.created).toBe(false);
    expect(config.profiles).toEqual({});
    expect(readPublicReaderState()?.did).toBe('did:dht:reader');
  });

  it('formats recovery phrase message for implicit identities', () => {
    expect(implicitRecoveryPhraseMessage('default', 'one two three')).toContain('Created identity "default".');
    expect(implicitRecoveryPhraseMessage('default', 'one two three')).toContain('  one two three');
  });
});
