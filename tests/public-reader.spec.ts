import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { readConfig } from '../src/profiles/config.js';
import {
  getOrCreatePublicReaderPassword,
  PUBLIC_READER_PROFILE,
  publicReaderStatePath,
  readPublicReaderPasswordForActiveProfile,
  readPublicReaderState,
  recordPublicReaderDid,
} from '../src/profiles/public-reader.js';

describe('public reader profile', () => {
  let originalEnboxHome: string | undefined;
  let originalGitdProfile: string | undefined;
  let originalEnboxProfile: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalEnboxHome = process.env.ENBOX_HOME;
    originalGitdProfile = process.env.GITD_PROFILE;
    originalEnboxProfile = process.env.ENBOX_PROFILE;
    tempHome = mkdtempSync(join(tmpdir(), 'gitd-public-reader-'));
    process.env.ENBOX_HOME = tempHome;
    delete process.env.GITD_PROFILE;
    delete process.env.ENBOX_PROFILE;
  });

  afterEach(() => {
    if (originalEnboxHome !== undefined) {
      process.env.ENBOX_HOME = originalEnboxHome;
    } else {
      delete process.env.ENBOX_HOME;
    }
    if (originalGitdProfile !== undefined) {
      process.env.GITD_PROFILE = originalGitdProfile;
    } else {
      delete process.env.GITD_PROFILE;
    }
    if (originalEnboxProfile !== undefined) {
      process.env.ENBOX_PROFILE = originalEnboxProfile;
    } else {
      delete process.env.ENBOX_PROFILE;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates and reuses a hidden password without adding a normal profile', () => {
    const now = new Date('2026-06-23T00:00:00.000Z');
    const created = getOrCreatePublicReaderPassword(now);

    expect(created.created).toBe(true);
    expect(created.password.startsWith('gitd-reader-')).toBe(true);
    expect(existsSync(publicReaderStatePath())).toBe(true);
    expect(readConfig().profiles).toEqual({});

    const reused = getOrCreatePublicReaderPassword(new Date('2026-06-24T00:00:00.000Z'));
    expect(reused).toEqual({ password: created.password, created: false });

    recordPublicReaderDid('did:dht:reader');
    expect(readPublicReaderState()).toMatchObject({
      profileName : PUBLIC_READER_PROFILE,
      password    : created.password,
      createdAt   : now.toISOString(),
      did         : 'did:dht:reader',
    });
  });

  it('only exposes the hidden password for the public reader profile', () => {
    const created = getOrCreatePublicReaderPassword();

    expect(readPublicReaderPasswordForActiveProfile(PUBLIC_READER_PROFILE)).toBe(created.password);
    expect(readPublicReaderPasswordForActiveProfile('work')).toBeUndefined();
    expect(readPublicReaderPasswordForActiveProfile()).toBeUndefined();
  });
});
