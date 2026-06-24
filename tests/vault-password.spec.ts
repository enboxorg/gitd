/**
 * Vault-password resolution + durable caching tests.
 *
 * Pins the encrypted-file secret backend and an isolated `ENBOX_HOME`.
 * Prompting is disabled (`allowPrompt: false`) so resolution is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { getVaultSecret, setVaultSecret } from '../src/auth/secret-store.js';
import { forgetVaultSecret, rememberVaultSecret, resolveVaultPassword } from '../src/auth/vault-password.js';

let tempDir: string;
let originalEnboxHome: string | undefined;
let originalBackend: string | undefined;
let originalPassword: string | undefined;

describe('vault password resolution', () => {
  beforeEach(() => {
    originalEnboxHome = process.env.ENBOX_HOME;
    originalBackend = process.env.GITD_SECRET_BACKEND;
    originalPassword = process.env.GITD_PASSWORD;
    tempDir = mkdtempSync(join(tmpdir(), 'gitd-vault-password-'));
    process.env.ENBOX_HOME = join(tempDir, 'enbox');
    process.env.GITD_SECRET_BACKEND = 'file';
    delete process.env.GITD_PASSWORD;
  });

  afterEach(() => {
    if (originalEnboxHome) { process.env.ENBOX_HOME = originalEnboxHome; } else { delete process.env.ENBOX_HOME; }
    if (originalBackend) { process.env.GITD_SECRET_BACKEND = originalBackend; } else { delete process.env.GITD_SECRET_BACKEND; }
    if (originalPassword) { process.env.GITD_PASSWORD = originalPassword; } else { delete process.env.GITD_PASSWORD; }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers an explicit password', async () => {
    const resolved = await resolveVaultPassword({ profileName: 'default', explicit: 'explicit-pw', env: {} });
    expect(resolved).toEqual({ password: 'explicit-pw', source: 'explicit' });
  });

  it('falls back to GITD_PASSWORD from the environment', async () => {
    const resolved = await resolveVaultPassword({ profileName: 'default', env: { GITD_PASSWORD: 'env-pw' } });
    expect(resolved).toEqual({ password: 'env-pw', source: 'env' });
  });

  it('explicit beats the environment', async () => {
    const resolved = await resolveVaultPassword({
      profileName : 'default',
      explicit    : 'explicit-pw',
      env         : { GITD_PASSWORD: 'env-pw' },
    });
    expect(resolved.source).toBe('explicit');
  });

  it('reads a cached secret from the durable store', async () => {
    await setVaultSecret('default', 'cached-pw');
    const resolved = await resolveVaultPassword({ profileName: 'default', env: {}, allowPrompt: false });
    expect(resolved).toEqual({ password: 'cached-pw', source: 'keychain' });
  });

  it('throws when nothing is available and prompting is disabled', async () => {
    await expect(
      resolveVaultPassword({ profileName: 'default', env: {}, allowPrompt: false }),
    ).rejects.toThrow();
  });
});

describe('vault secret caching', () => {
  beforeEach(() => {
    originalEnboxHome = process.env.ENBOX_HOME;
    originalBackend = process.env.GITD_SECRET_BACKEND;
    tempDir = mkdtempSync(join(tmpdir(), 'gitd-vault-cache-'));
    process.env.ENBOX_HOME = join(tempDir, 'enbox');
    process.env.GITD_SECRET_BACKEND = 'file';
  });

  afterEach(() => {
    if (originalEnboxHome) { process.env.ENBOX_HOME = originalEnboxHome; } else { delete process.env.ENBOX_HOME; }
    if (originalBackend) { process.env.GITD_SECRET_BACKEND = originalBackend; } else { delete process.env.GITD_SECRET_BACKEND; }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('caches a freshly entered (tty) secret', async () => {
    await rememberVaultSecret('default', { password: 'typed-pw', source: 'tty' });
    expect(await getVaultSecret('default')).toBe('typed-pw');
  });

  it('caches a first-run (explicit) secret', async () => {
    await rememberVaultSecret('default', { password: 'wizard-pw', source: 'explicit' });
    expect(await getVaultSecret('default')).toBe('wizard-pw');
  });

  it('does not cache an environment secret', async () => {
    await rememberVaultSecret('default', { password: 'env-pw', source: 'env' });
    expect(await getVaultSecret('default')).toBeUndefined();
  });

  it('does not re-cache an already-durable secret', async () => {
    await rememberVaultSecret('default', { password: 'kc-pw', source: 'keychain' });
    expect(await getVaultSecret('default')).toBeUndefined();
  });

  it('forgets a cached secret', async () => {
    await rememberVaultSecret('default', { password: 'typed-pw', source: 'tty' });
    await forgetVaultSecret('default');
    expect(await getVaultSecret('default')).toBeUndefined();
  });
});
