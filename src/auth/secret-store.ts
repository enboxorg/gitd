/**
 * Durable per-profile secret store for gitd vault-unlock secrets.
 *
 * gitd unlocks a profile's Enbox vault with a secret. Persisting that secret
 * durably lets the CLI and the credential helper restore a session without
 * re-prompting on every command — the root cause of "asked for the vault
 * password repeatedly".
 *
 * Backends, in preference order:
 *   1. OS keychain — macOS `security`, Linux `secret-tool` (libsecret).
 *   2. Encrypted file — AES-256-GCM under `~/.enbox/secrets/<profile>.enc`,
 *      keyed by a machine + user derived key, file mode 0600.
 *
 * The active backend can be pinned with `GITD_SECRET_BACKEND`:
 *   - `keychain` — OS keychain only (no file fallback).
 *   - `file`     — encrypted file only (skip the keychain).
 *   - `none`     — disable durable storage entirely (CI / ephemeral use).
 * When unset, gitd prefers the keychain and falls back to the encrypted file.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';

import { enboxHome } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keychain service name used for all gitd secrets. */
const SERVICE = 'gitd';

/** Timeout for keychain CLI invocations. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** Selectable backends. `undefined` means auto (keychain, then file). */
type Backend = 'keychain' | 'file' | 'none';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Retrieve the stored vault secret for a profile, or `undefined` if none. */
export async function getVaultSecret(profileName: string): Promise<string | undefined> {
  const backend = configuredBackend();
  if (backend === 'none') { return undefined; }

  if (shouldUseKeychain(backend)) {
    const value = keychainGet(profileName);
    if (value !== undefined) { return value; }
    if (backend === 'keychain') { return undefined; }
  }

  return fileGet(profileName);
}

/** Persist the vault secret for a profile durably. */
export async function setVaultSecret(profileName: string, secret: string): Promise<void> {
  const backend = configuredBackend();
  if (backend === 'none') { return; }

  if (shouldUseKeychain(backend)) {
    if (keychainSet(profileName, secret)) {
      // Clear any stale file copy so reads stay consistent with the keychain.
      fileDelete(profileName);
      return;
    }
    if (backend === 'keychain') {
      throw new Error('GITD_SECRET_BACKEND=keychain but the OS keychain is unavailable.');
    }
  }

  fileSet(profileName, secret);
}

/** Remove the stored vault secret for a profile from all backends. */
export async function deleteVaultSecret(profileName: string): Promise<void> {
  const backend = configuredBackend();
  if (backend === 'none') { return; }

  if (shouldUseKeychain(backend)) {
    keychainDelete(profileName);
  }
  fileDelete(profileName);
}

/** Describe the active backend for diagnostics (`gitd doctor`, status). */
export function describeSecretBackend(): string {
  const backend = configuredBackend();
  if (backend === 'none') { return 'disabled (GITD_SECRET_BACKEND=none)'; }
  if (backend === 'file') { return 'encrypted file'; }
  if (backend === 'keychain') { return 'OS keychain'; }
  return shouldUseKeychain(undefined) ? 'OS keychain (encrypted file fallback)' : 'encrypted file';
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

function configuredBackend(): Backend | undefined {
  const value = process.env.GITD_SECRET_BACKEND?.toLowerCase();
  if (value === 'keychain' || value === 'file' || value === 'none') { return value; }
  return undefined;
}

function keychainPlatformSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

/**
 * Decide whether to use the OS keychain for the current call.
 *
 * The OS keychain is a single machine-global store keyed by `gitd` /
 * `vault:<profile>` — it is NOT scoped to `ENBOX_HOME`. So when `ENBOX_HOME`
 * is overridden (tests, sandboxes, throwaway installs) we use the encrypted
 * file backend instead, which lives under that home and stays isolated. The
 * default home (production) uses the keychain; `GITD_SECRET_BACKEND` overrides
 * everything.
 */
function shouldUseKeychain(backend: Backend | undefined): boolean {
  if (backend === 'keychain') { return keychainPlatformSupported(); }
  if (backend === 'file' || backend === 'none') { return false; }
  if (process.env.ENBOX_HOME) { return false; }
  return keychainPlatformSupported();
}

/** Keychain account label for a profile. */
function account(profileName: string): string {
  return `vault:${profileName}`;
}

// ---------------------------------------------------------------------------
// OS keychain backend
// ---------------------------------------------------------------------------

function keychainGet(profileName: string): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', account(profileName), '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
      );
      const value = out.replace(/\n$/, '');
      return value.length > 0 ? value : undefined;
    }
    if (process.platform === 'linux') {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'service', SERVICE, 'account', account(profileName)],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
      );
      return out.length > 0 ? out : undefined;
    }
  } catch {
    // Not found, no keyring, or tool missing — fall back to the file backend.
  }
  return undefined;
}

function keychainSet(profileName: string, secret: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', SERVICE, '-a', account(profileName), '-w', secret],
        { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS },
      );
      return true;
    }
    if (process.platform === 'linux') {
      execFileSync(
        'secret-tool',
        ['store', '--label', `gitd ${profileName}`, 'service', SERVICE, 'account', account(profileName)],
        { input: secret, stdio: ['pipe', 'ignore', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
      );
      return true;
    }
  } catch {
    // Keyring locked / tool missing — caller falls back to the file backend.
  }
  return false;
}

function keychainDelete(profileName: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', SERVICE, '-a', account(profileName)],
        { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS },
      );
    } else if (process.platform === 'linux') {
      execFileSync(
        'secret-tool',
        ['clear', 'service', SERVICE, 'account', account(profileName)],
        { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS },
      );
    }
  } catch {
    // Nothing to delete, or no keyring — safe to ignore.
  }
}

// ---------------------------------------------------------------------------
// Encrypted file backend
// ---------------------------------------------------------------------------

/** Stored ciphertext envelope. */
type SecretFile = {
  v : 1;
  iv : string;
  tag : string;
  ct : string;
};

function secretsDir(): string {
  return join(enboxHome(), 'secrets');
}

function secretFilePath(profileName: string): string {
  const safe = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(secretsDir(), `${safe}.enc`);
}

function fileGet(profileName: string): string | undefined {
  const path = secretFilePath(profileName);
  if (!existsSync(path)) { return undefined; }
  try {
    const envelope = JSON.parse(readFileSync(path, 'utf-8')) as SecretFile;
    const decipher = createDecipheriv('aes-256-gcm', fileKey(), Buffer.from(envelope.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'hex')), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    // Corrupt, tampered, or written by another machine/user — treat as absent.
    return undefined;
  }
}

function fileSet(profileName: string, secret: string): void {
  mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fileKey(), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secret, 'utf-8')), cipher.final()]);
  const envelope: SecretFile = {
    v   : 1,
    iv  : iv.toString('hex'),
    tag : cipher.getAuthTag().toString('hex'),
    ct  : ct.toString('hex'),
  };
  writeFileSync(secretFilePath(profileName), JSON.stringify(envelope), { mode: 0o600 });
}

function fileDelete(profileName: string): void {
  const path = secretFilePath(profileName);
  if (existsSync(path)) { rmSync(path, { force: true }); }
}

/**
 * Derive the 32-byte AES key for the encrypted-file backend.
 *
 * The key is bound to this machine and user: a stable machine id plus the
 * username, mixed with a per-install random key persisted under the secrets
 * directory. Copying the `.enc` file to another machine or user will not
 * decrypt it.
 */
function fileKey(): Buffer {
  mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  const keyPath = join(secretsDir(), '.machine-key');
  let base: Buffer;
  if (existsSync(keyPath)) {
    base = readFileSync(keyPath);
  } else {
    base = randomBytes(32);
    writeFileSync(keyPath, base, { mode: 0o600 });
  }
  return createHash('sha256')
    .update(base)
    .update(machineId())
    .update(userInfo().username)
    .digest();
}

/** Best-effort stable machine identifier, falling back to the hostname. */
function machineId(): string {
  try {
    if (process.platform === 'linux') {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(path)) { return readFileSync(path, 'utf-8').trim(); }
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding : 'utf-8',
        stdio    : ['ignore', 'pipe', 'ignore'],
        timeout  : 2_000,
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) { return match[1]; }
    } else if (process.platform === 'win32') {
      return process.env.COMPUTERNAME ?? hostname();
    }
  } catch {
    // Fall through to the hostname.
  }
  return hostname();
}
