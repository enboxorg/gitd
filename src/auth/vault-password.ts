/**
 * Vault-password resolution and durable caching.
 *
 * One place that answers "what unlocks this profile's vault?", consulting, in
 * order: an explicit value, `GITD_PASSWORD`, the hidden public-reader secret,
 * the durable secret store (OS keychain / encrypted file), and finally an
 * interactive prompt. The resolved source is tracked so a freshly entered
 * secret can be cached for next time — turning the previously per-command
 * password prompt into a one-time event.
 *
 * @module
 */

import { readPublicReaderPasswordForActiveProfile } from '../profiles/public-reader.js';

import { deleteVaultSecret, getVaultSecret, setVaultSecret } from './secret-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a resolved password came from. */
export type PasswordSource = 'explicit' | 'env' | 'public-reader' | 'keychain' | 'tty';

/** A resolved vault password together with its origin. */
export type ResolvedPassword = {
  password : string;
  source : PasswordSource;
};

/** Options for {@link resolveVaultPassword}. */
export type ResolveVaultPasswordOptions = {
  /** Active profile name (used for public-reader + durable secret lookup). */
  profileName? : string;
  /** Caller-supplied password (e.g. from a first-run wizard); wins outright. */
  explicit? : string;
  /** Environment to read `GITD_PASSWORD` from. Defaults to `process.env`. */
  env? : NodeJS.ProcessEnv;
  /** Whether to fall back to an interactive prompt. Defaults to `true`. */
  allowPrompt? : boolean;
  /** Prompt label shown when reading interactively. */
  promptMessage? : string;
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the vault password for a profile.
 *
 * Precedence: explicit → `GITD_PASSWORD` → public-reader secret → durable
 * secret store → interactive prompt.
 *
 * @throws If no password is available and prompting is disabled.
 */
export async function resolveVaultPassword(options: ResolveVaultPasswordOptions): Promise<ResolvedPassword> {
  const { profileName, explicit, env = process.env, allowPrompt = true, promptMessage } = options;

  if (explicit) { return { password: explicit, source: 'explicit' }; }

  const envPassword = env.GITD_PASSWORD;
  if (envPassword) { return { password: envPassword, source: 'env' }; }

  const publicReaderPassword = readPublicReaderPasswordForActiveProfile(profileName);
  if (publicReaderPassword) { return { password: publicReaderPassword, source: 'public-reader' }; }

  if (profileName) {
    const cached = await getVaultSecret(profileName);
    if (cached) { return { password: cached, source: 'keychain' }; }
  }

  if (!allowPrompt) {
    throw new Error('No vault password available. Set GITD_PASSWORD or run `gitd auth login`.');
  }

  const password = await promptVaultPassword(promptMessage);
  return { password, source: 'tty' };
}

/**
 * Persist a freshly entered secret so later commands restore without a prompt.
 *
 * Only `tty` and `explicit` (first-run) secrets are cached. `env` secrets are
 * left ephemeral by design, and `keychain` / `public-reader` secrets are
 * already durable.
 */
export async function rememberVaultSecret(profileName: string | undefined, resolved: ResolvedPassword): Promise<void> {
  if (!profileName) { return; }
  if (resolved.source !== 'tty' && resolved.source !== 'explicit') { return; }
  try {
    await setVaultSecret(profileName, resolved.password);
  } catch (err) {
    // Caching is an optimization — never fail the command over it.
    console.error(`[auth] Could not cache unlock secret: ${(err as Error).message}`);
  }
}

/** Drop a profile's durable secret (logout, reset, or rejected-secret repair). */
export async function forgetVaultSecret(profileName: string): Promise<void> {
  await deleteVaultSecret(profileName);
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

/**
 * Prompt for a vault password.
 *
 * On a TTY the input is read in raw mode with no echo; otherwise the password
 * is read from piped stdin. Ctrl-C aborts with exit code 130.
 */
export async function promptVaultPassword(message = 'Identity password: '): Promise<string> {
  process.stdout.write(message);

  if (process.stdin.isTTY) {
    return new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.resume();

      const onData = (ch: string): void => {
        const code = ch.charCodeAt(0);

        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
        } else if (code === 3) {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (code === 127 || code === 8) {
          if (buf.length > 0) { buf = buf.slice(0, -1); }
        } else if (code >= 32) {
          buf += ch;
        }
      };

      process.stdin.on('data', onData);
    });
  }

  // Non-TTY fallback (piped input).
  return new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk: string) => {
      buf += chunk;
      resolve(buf.trim());
    });
    process.stdin.resume();
  });
}
