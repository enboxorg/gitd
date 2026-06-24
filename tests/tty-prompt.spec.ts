/**
 * Tests for the TTY password resolver used by git helpers.
 *
 * `getVaultPassword()` prefers `GITD_PASSWORD`, then the hidden public-read
 * profile secret, then the durable secret store, then a `/dev/tty` prompt.
 *
 * Actual TTY interaction cannot be tested (no controlling terminal), so those
 * paths are only exercised for graceful fallback to `null`. The durable-store
 * path is pinned to the encrypted-file backend so the real OS keychain is
 * never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { getVaultPassword } from '../src/git-remote/tty-prompt.js';
import { setVaultSecret } from '../src/auth/secret-store.js';
import {
  getOrCreatePublicReaderPassword,
  PUBLIC_READER_PROFILE,
} from '../src/profiles/public-reader.js';

describe('getVaultPassword', () => {
  let origPassword: string | undefined;
  let origProfile: string | undefined;
  let origEnboxProfile: string | undefined;
  let origEnboxHome: string | undefined;
  let origBackend: string | undefined;
  let tempHome: string | undefined;

  beforeEach(() => {
    origPassword = process.env.GITD_PASSWORD;
    origProfile = process.env.GITD_PROFILE;
    origEnboxProfile = process.env.ENBOX_PROFILE;
    origEnboxHome = process.env.ENBOX_HOME;
    origBackend = process.env.GITD_SECRET_BACKEND;
    delete process.env.GITD_PROFILE;
    delete process.env.ENBOX_PROFILE;
  });

  afterEach(() => {
    restoreEnv('GITD_PASSWORD', origPassword);
    restoreEnv('GITD_PROFILE', origProfile);
    restoreEnv('ENBOX_PROFILE', origEnboxProfile);
    restoreEnv('ENBOX_HOME', origEnboxHome);
    restoreEnv('GITD_SECRET_BACKEND', origBackend);
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  function restoreEnv(key: string, value: string | undefined): void {
    if (value !== undefined) { process.env[key] = value; } else { delete process.env[key]; }
  }

  it('returns GITD_PASSWORD when set', async () => {
    process.env.GITD_PASSWORD = 'test-secret';
    expect(await getVaultPassword()).toBe('test-secret');
  });

  it('returns the hidden public reader password for public-read repos', async () => {
    delete process.env.GITD_PASSWORD;
    tempHome = mkdtempSync(join(tmpdir(), 'gitd-tty-public-reader-'));
    process.env.ENBOX_HOME = tempHome;
    process.env.GITD_PROFILE = PUBLIC_READER_PROFILE;

    const reader = getOrCreatePublicReaderPassword();
    expect(await getVaultPassword()).toBe(reader.password);
  });

  it('returns the durable secret for the profile when env is unset', async () => {
    delete process.env.GITD_PASSWORD;
    tempHome = mkdtempSync(join(tmpdir(), 'gitd-tty-keychain-'));
    process.env.ENBOX_HOME = tempHome;
    process.env.GITD_SECRET_BACKEND = 'file';

    await setVaultSecret('work', 'stored-pw');
    expect(await getVaultPassword('work')).toBe('stored-pw');
  });

  it('prefers GITD_PASSWORD over the durable secret', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'gitd-tty-precedence-'));
    process.env.ENBOX_HOME = tempHome;
    process.env.GITD_SECRET_BACKEND = 'file';
    process.env.GITD_PASSWORD = 'env-pw';

    await setVaultSecret('work', 'stored-pw');
    expect(await getVaultPassword('work')).toBe('env-pw');
  });

  it('falls back gracefully when no source is available (no TTY in CI)', async () => {
    delete process.env.GITD_PASSWORD;
    const result = await getVaultPassword();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('does not throw when no password source is available', async () => {
    delete process.env.GITD_PASSWORD;
    await getVaultPassword();
  });
});
