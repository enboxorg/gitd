/**
 * Durable secret-store tests.
 *
 * Pins the encrypted-file backend (`GITD_SECRET_BACKEND=file`) and an isolated
 * `ENBOX_HOME` so the real OS keychain is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { enboxHome } from '../src/profiles/config.js';
import { deleteVaultSecret, getVaultSecret, setVaultSecret } from '../src/auth/secret-store.js';

let tempDir: string;
let originalEnboxHome: string | undefined;
let originalBackend: string | undefined;

function secretFile(profile: string): string {
  return join(enboxHome(), 'secrets', `${profile}.enc`);
}

describe('secret store (encrypted file backend)', () => {
  beforeEach(() => {
    originalEnboxHome = process.env.ENBOX_HOME;
    originalBackend = process.env.GITD_SECRET_BACKEND;
    tempDir = mkdtempSync(join(tmpdir(), 'gitd-secret-store-'));
    process.env.ENBOX_HOME = join(tempDir, 'enbox');
    process.env.GITD_SECRET_BACKEND = 'file';
  });

  afterEach(() => {
    if (originalEnboxHome) { process.env.ENBOX_HOME = originalEnboxHome; } else { delete process.env.ENBOX_HOME; }
    if (originalBackend) { process.env.GITD_SECRET_BACKEND = originalBackend; } else { delete process.env.GITD_SECRET_BACKEND; }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when nothing is stored', async () => {
    expect(await getVaultSecret('default')).toBeUndefined();
  });

  it('round-trips a stored secret', async () => {
    await setVaultSecret('default', 'hunter2');
    expect(await getVaultSecret('default')).toBe('hunter2');
  });

  it('stores the secret encrypted at rest (not plaintext)', async () => {
    await setVaultSecret('default', 'super-secret-phrase');
    const path = secretFile('default');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('super-secret-phrase');
    const envelope = JSON.parse(raw) as { v: number; iv: string; tag: string; ct: string };
    expect(envelope.v).toBe(1);
    expect(envelope.iv.length).toBeGreaterThan(0);
    expect(envelope.tag.length).toBeGreaterThan(0);
    expect(envelope.ct.length).toBeGreaterThan(0);
  });

  it('overwrites an existing secret', async () => {
    await setVaultSecret('default', 'first');
    await setVaultSecret('default', 'second');
    expect(await getVaultSecret('default')).toBe('second');
  });

  it('isolates secrets per profile', async () => {
    await setVaultSecret('work', 'work-pw');
    await setVaultSecret('personal', 'personal-pw');
    expect(await getVaultSecret('work')).toBe('work-pw');
    expect(await getVaultSecret('personal')).toBe('personal-pw');
  });

  it('deletes a stored secret', async () => {
    await setVaultSecret('default', 'hunter2');
    await deleteVaultSecret('default');
    expect(await getVaultSecret('default')).toBeUndefined();
    expect(existsSync(secretFile('default'))).toBe(false);
  });

  it('is a no-op when the backend is disabled', async () => {
    process.env.GITD_SECRET_BACKEND = 'none';
    await setVaultSecret('default', 'hunter2');
    expect(await getVaultSecret('default')).toBeUndefined();
  });
});
