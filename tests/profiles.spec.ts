/**
 * Profile management tests — exercises config I/O, profile resolution,
 * and the auth command against a real Enbox agent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import type { EnboxConfig, ProfileEntry } from '../src/profiles/config.js';

import {
  configPath,
  enboxHome,
  listProfiles,
  profileDataPath,
  profilesDir,
  readConfig,
  removeProfile,
  resolveProfile,
  upsertProfile,
  writeConfig,
} from '../src/profiles/config.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ENBOX_HOME = '__TESTDATA__/enbox-home';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('profile config', () => {
  const origHome = process.env.ENBOX_HOME;

  beforeAll(() => {
    rmSync(TEST_ENBOX_HOME, { recursive: true, force: true });
    process.env.ENBOX_HOME = TEST_ENBOX_HOME;
  });

  afterAll(() => {
    rmSync(TEST_ENBOX_HOME, { recursive: true, force: true });
    if (origHome !== undefined) {
      process.env.ENBOX_HOME = origHome;
    } else {
      delete process.env.ENBOX_HOME;
    }
  });

  beforeEach(() => {
    // Clean config between tests.
    rmSync(TEST_ENBOX_HOME, { recursive: true, force: true });
  });

  // =========================================================================
  // enboxHome / configPath / profilesDir
  // =========================================================================

  it('should respect ENBOX_HOME env var', () => {
    expect(enboxHome()).toBe(TEST_ENBOX_HOME);
    expect(configPath()).toBe(join(TEST_ENBOX_HOME, 'config.json'));
    expect(profilesDir()).toBe(join(TEST_ENBOX_HOME, 'profiles'));
  });

  it('should compute profile data path', () => {
    const path = profileDataPath('test-profile');
    expect(path).toBe(join(TEST_ENBOX_HOME, 'profiles', 'test-profile', 'DATA', 'AGENT'));
  });

  // =========================================================================
  // readConfig / writeConfig
  // =========================================================================

  it('should return default config when file does not exist', () => {
    const config = readConfig();
    expect(config.version).toBe(1);
    expect(config.defaultProfile).toBe('');
    expect(Object.keys(config.profiles)).toHaveLength(0);
  });

  it('should write and read config', () => {
    const config: EnboxConfig = {
      version        : 1,
      defaultProfile : 'test',
      profiles       : {
        test: { name: 'test', did: 'did:dht:abc', createdAt: '2025-01-01T00:00:00Z' },
      },
    };
    writeConfig(config);
    expect(existsSync(configPath())).toBe(true);

    const read = readConfig();
    expect(read.defaultProfile).toBe('test');
    expect(read.profiles.test.did).toBe('did:dht:abc');
  });

  // =========================================================================
  // upsertProfile / removeProfile / listProfiles
  // =========================================================================

  it('should add first profile as default', () => {
    const entry: ProfileEntry = {
      name      : 'personal',
      did       : 'did:dht:first',
      createdAt : '2025-01-01T00:00:00Z',
    };
    upsertProfile('personal', entry);

    const config = readConfig();
    expect(config.defaultProfile).toBe('personal');
    expect(config.profiles.personal.did).toBe('did:dht:first');
  });

  it('should not change default when adding second profile', () => {
    upsertProfile('personal', { name: 'personal', did: 'did:dht:first', createdAt: '2025-01-01T00:00:00Z' });
    upsertProfile('work', { name: 'work', did: 'did:dht:second', createdAt: '2025-02-01T00:00:00Z' });

    const config = readConfig();
    expect(config.defaultProfile).toBe('personal');
    expect(listProfiles()).toEqual(['personal', 'work']);
  });

  it('should remove profile and update default', () => {
    upsertProfile('a', { name: 'a', did: 'did:a', createdAt: '2025-01-01T00:00:00Z' });
    upsertProfile('b', { name: 'b', did: 'did:b', createdAt: '2025-01-01T00:00:00Z' });

    // Default is 'a'. Remove it.
    removeProfile('a');
    const config = readConfig();
    expect(config.defaultProfile).toBe('b');
    expect(listProfiles()).toEqual(['b']);
  });

  it('should clear default when removing last profile', () => {
    upsertProfile('only', { name: 'only', did: 'did:only', createdAt: '2025-01-01T00:00:00Z' });
    removeProfile('only');
    const config = readConfig();
    expect(config.defaultProfile).toBe('');
    expect(listProfiles()).toEqual([]);
  });

  it('should update existing profile', () => {
    upsertProfile('p', { name: 'p', did: 'did:old', createdAt: '2025-01-01T00:00:00Z' });
    upsertProfile('p', { name: 'p', did: 'did:new', createdAt: '2025-02-01T00:00:00Z' });
    expect(readConfig().profiles.p.did).toBe('did:new');
  });

  // =========================================================================
  // resolveProfile
  // =========================================================================

  it('should resolve from explicit flag', () => {
    upsertProfile('a', { name: 'a', did: 'did:a', createdAt: '2025-01-01T00:00:00Z' });
    expect(resolveProfile('a')).toBe('a');
  });

  it('should resolve from ENBOX_PROFILE env', () => {
    const orig = process.env.ENBOX_PROFILE;
    process.env.ENBOX_PROFILE = 'env-profile';
    try {
      expect(resolveProfile()).toBe('env-profile');
    } finally {
      if (orig !== undefined) {
        process.env.ENBOX_PROFILE = orig;
      } else {
        delete process.env.ENBOX_PROFILE;
      }
    }
  });

  it('should resolve from default profile', () => {
    upsertProfile('default-one', { name: 'default-one', did: 'did:d', createdAt: '2025-01-01T00:00:00Z' });
    expect(resolveProfile()).toBe('default-one');
  });

  it('should resolve single profile as fallback', () => {
    // Write a config with no default but one profile.
    const config: EnboxConfig = {
      version        : 1,
      defaultProfile : '',
      profiles       : {
        lonely: { name: 'lonely', did: 'did:lonely', createdAt: '2025-01-01T00:00:00Z' },
      },
    };
    writeConfig(config);
    expect(resolveProfile()).toBe('lonely');
  });

  it('should return null when no profiles exist', () => {
    expect(resolveProfile()).toBeNull();
  });

  it('should return null when multiple profiles exist and no default', () => {
    const config: EnboxConfig = {
      version        : 1,
      defaultProfile : '',
      profiles       : {
        a : { name: 'a', did: 'did:a', createdAt: '2025-01-01T00:00:00Z' },
        b : { name: 'b', did: 'did:b', createdAt: '2025-01-01T00:00:00Z' },
      },
    };
    writeConfig(config);
    expect(resolveProfile()).toBeNull();
  });
});

describe('connectAgent with profile dataPath', () => {
  const TEST_DATA = '__TESTDATA__/profile-agent';

  afterAll(() => {
    rmSync(TEST_DATA, { recursive: true, force: true });
  });

  // SQLite migration + Dwn.create() takes longer than the default 5 s timeout.
  it('should create agent at specified dataPath', async () => {
    rmSync(TEST_DATA, { recursive: true, force: true });

    const { connectAgent } = await import('../src/cli/agent.js');
    const result = await connectAgent({
      password : 'test-pw',
      dataPath : TEST_DATA,
    });

    expect(result.did).toMatch(/^did:/);
    expect(result.recoveryPhrase).toBeDefined();
    expect(typeof result.recoveryPhrase).toBe('string');
    // Verify data was created on disk.
    expect(existsSync(TEST_DATA)).toBe(true);
    // Verify the DWN uses SQLite instead of LevelDB.
    expect(existsSync(`${TEST_DATA}/dwn.sqlite`)).toBe(true);
  }, 15_000);

  it('should not create RESOLVERCACHE in CWD', () => {
    // The DWN resolver cache should live inside the profile data path,
    // not as a CWD-relative RESOLVERCACHE/ directory.
    expect(existsSync('RESOLVERCACHE')).toBe(false);
  });

  it('should create DWN_RESOLVERCACHE inside dataPath', () => {
    expect(existsSync(join(TEST_DATA, 'DWN_RESOLVERCACHE'))).toBe(true);
  });

  it('should not create DATA/AGENT in CWD', () => {
    expect(existsSync('DATA/AGENT')).toBe(false);
  });

  // Note: reconnect test cannot run in the same process because LevelDB
  // holds exclusive file locks.  Reconnect is exercised by the CLI itself
  // across separate process invocations.
});

describe('resolveReposPath', () => {
  it('should fall back to ~/.enbox/profiles/default/repos/ without a profile', async () => {
    const { resolveReposPath } = await import('../src/cli/flags.js');
    const result = resolveReposPath([], null);
    expect(result).toContain('profiles');
    expect(result).toContain('default');
    expect(result).toContain('repos');
    expect(result).not.toBe('./repos');
  });

  it('should use named profile repos path', async () => {
    const { resolveReposPath } = await import('../src/cli/flags.js');
    const result = resolveReposPath([], 'myprofile');
    expect(result).toContain('myprofile');
    expect(result).toContain('repos');
  });

  it('should prefer --repos flag over profile', async () => {
    const { resolveReposPath } = await import('../src/cli/flags.js');
    const result = resolveReposPath(['--repos', '/custom/path'], 'myprofile');
    expect(result).toBe('/custom/path');
  });

  it('should prefer GITD_REPOS env over profile', async () => {
    const orig = process.env.GITD_REPOS;
    process.env.GITD_REPOS = '/env/repos';
    try {
      const { resolveReposPath } = await import('../src/cli/flags.js');
      const result = resolveReposPath([], 'myprofile');
      expect(result).toBe('/env/repos');
    } finally {
      if (orig !== undefined) {
        process.env.GITD_REPOS = orig;
      } else {
        delete process.env.GITD_REPOS;
      }
    }
  });
});
