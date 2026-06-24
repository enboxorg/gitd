/**
 * Daemon lockfile — discovery mechanism for the local gitd server.
 *
 * When `gitd serve` starts, it writes a JSON lockfile to
 * `~/.enbox/daemon.lock` containing `{ pid, port, startedAt, ownerDid }`.
 * `git-remote-did` reads this file to discover a running local daemon
 * and resolve `did::` remotes to `http://127.0.0.1:<port>/...` instead
 * of performing DID document resolution.
 *
 * The lockfile is removed on graceful shutdown and validated (PID check)
 * on read to handle stale files from crashed processes.
 *
 * @module
 */

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { enboxHome, profilesDir } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DEFAULT_HELPER_CAPABILITIES = [
  'git-transport',
  'dwn-restore',
  'push-tokens',
  'contributor-branch-writeback',
  'public-read-cache',
] as const;

export type HelperCapability = typeof DEFAULT_HELPER_CAPABILITIES[number];
export type HelperSessionExpiryPolicy = 'helper-lifetime';

export type HelperRepoContext = {
  /** Canonical repo owner DID. */
  ownerDid: string;
  /** Repository name under the owner DID. */
  repo: string;
  /** Local working tree path, when the helper saw one. */
  path?: string;
  /** Git remote URL used for this repo, when known. */
  remoteUrl?: string;
  /** Repo default branch, when known. */
  defaultBranch?: string;
  /** Last time this repo context was observed by gitd. */
  lastSeenAt: string;
};

export type HelperRepoContextInput = Omit<HelperRepoContext, 'lastSeenAt'> & {
  lastSeenAt?: string;
};

const MAX_HELPER_REPO_CONTEXTS = 20;

/** Data stored in the daemon lockfile. */
export type DaemonLock = {
  /** The PID of the daemon process. */
  pid: number;

  /** The HTTP port the git server is listening on. */
  port: number;

  /** ISO 8601 timestamp of when the daemon started. */
  startedAt: string;

  /** The gitd version that started this daemon (for upgrade detection). */
  version?: string;

  /** The DID of the identity that owns this daemon. */
  ownerDid?: string;

  /** Stable enough local session id for display/revocation UX. */
  sessionId?: string;

  /** Named profile this daemon serves. */
  profileName?: string;

  /** Bare repository cache path served by this daemon. */
  reposPath?: string;

  /** Session-like capabilities currently exposed by the local helper. */
  capabilities?: string[];

  /** Helper session expiry policy. MVP sessions last until the helper stops. */
  expiryPolicy?: HelperSessionExpiryPolicy;

  /** Repositories this helper session has seen through local CLI use. */
  repoContexts?: HelperRepoContext[];

  /**
   * True when this daemon can serve as a local DWN-backed helper for repos
   * owned by DIDs other than `ownerDid`.
   */
  dwnHelper?: boolean;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the profile whose daemon lockfile should be used, if any. */
function lockfileProfile(profileName?: string): string | undefined {
  return profileName || process.env.GITD_PROFILE || process.env.ENBOX_PROFILE || undefined;
}

/** Path to the daemon lockfile. */
export function lockfilePath(profileName?: string): string {
  const profile = lockfileProfile(profileName);
  if (profile) {
    return join(profilesDir(), profile, 'daemon.lock');
  }
  return join(enboxHome(), 'daemon.lock');
}

// ---------------------------------------------------------------------------
// Write / remove
// ---------------------------------------------------------------------------

/** Additional advertised daemon capabilities. */
export type WriteLockfileOptions = {
  /** Advertise that this daemon can restore/fetch remote-owner repos from DWN records. */
  dwnHelper?: boolean;
  /** Named profile this daemon serves. Defaults to the active GITD/ENBOX profile env. */
  profileName?: string;
  /** Bare repository cache path served by this daemon. */
  reposPath?: string;
  /** Session-like helper capabilities to advertise. */
  capabilities?: readonly string[];
  /** Helper session expiry policy. Defaults to helper lifetime. */
  expiryPolicy?: HelperSessionExpiryPolicy;
  /** Initial repositories this helper session has seen through local CLI use. */
  repoContexts?: readonly HelperRepoContextInput[];
  /** Override the generated local session id. Mostly useful for tests. */
  sessionId?: string;
};

export function helperSessionId(profileName: string | undefined, pid = process.pid): string {
  return `helper:${profileName ?? 'global'}:${pid}`;
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const capability of capabilities ?? []) {
    const trimmed = capability.trim();
    if (!trimmed || seen.has(trimmed)) { continue; }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function repoContextKey(context: Pick<HelperRepoContext, 'ownerDid' | 'repo' | 'path'>): string {
  return `${context.ownerDid}\0${context.repo}\0${context.path ?? ''}`;
}

function normalizeRepoContext(context: HelperRepoContextInput): HelperRepoContext | null {
  const ownerDid = context.ownerDid.trim();
  const repo = context.repo.trim();

  if (!ownerDid || !repo) { return null; }

  return {
    ownerDid,
    repo,
    ...(context.path ? { path: context.path } : {}),
    ...(context.remoteUrl ? { remoteUrl: context.remoteUrl } : {}),
    ...(context.defaultBranch ? { defaultBranch: context.defaultBranch } : {}),
    lastSeenAt: context.lastSeenAt ?? new Date().toISOString(),
  };
}

function normalizeRepoContexts(contexts: readonly HelperRepoContextInput[] | undefined): HelperRepoContext[] {
  const seen = new Set<string>();
  const normalized: HelperRepoContext[] = [];

  for (const context of contexts ?? []) {
    const next = normalizeRepoContext(context);
    if (!next) { continue; }
    const key = repoContextKey(next);
    if (seen.has(key)) { continue; }
    seen.add(key);
    normalized.push(next);
  }

  return normalized.slice(0, MAX_HELPER_REPO_CONTEXTS);
}

/** Write the daemon lockfile. Overwrites any existing file. */
export function writeLockfile(
  port: number,
  version?: string,
  ownerDid?: string,
  options: WriteLockfileOptions = {},
): void {
  const profileName = lockfileProfile(options.profileName);
  const capabilities = normalizeCapabilities(options.capabilities);
  const repoContexts = normalizeRepoContexts(options.repoContexts);
  const lock: DaemonLock = {
    pid          : process.pid,
    port,
    startedAt    : new Date().toISOString(),
    ...(version ? { version } : {}),
    ...(ownerDid ? { ownerDid } : {}),
    sessionId    : options.sessionId ?? helperSessionId(profileName),
    ...(profileName ? { profileName } : {}),
    ...(options.reposPath ? { reposPath: options.reposPath } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    expiryPolicy : options.expiryPolicy ?? 'helper-lifetime',
    ...(repoContexts.length > 0 ? { repoContexts } : {}),
    ...(options.dwnHelper ? { dwnHelper: true } : {}),
  };
  const path = lockfilePath(options.profileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + '\n', { mode: 0o644 });
}

/** Record a repo context on an already-running helper lockfile. */
export function recordLockfileRepoContext(
  repoContext: HelperRepoContextInput,
  profileName?: string,
): boolean {
  const lock = readLockfile(profileName);
  if (!lock) { return false; }

  const next = normalizeRepoContext(repoContext);
  if (!next) { return false; }

  const key = repoContextKey(next);
  const repoContexts = [
    next,
    ...(lock.repoContexts ?? []).filter((context) => repoContextKey(context) !== key),
  ].slice(0, MAX_HELPER_REPO_CONTEXTS);

  const path = lockfilePath(profileName);
  writeFileSync(path, JSON.stringify({
    ...lock,
    repoContexts,
  }, null, 2) + '\n', { mode: 0o644 });

  return true;
}

/** Remove the daemon lockfile if it exists and belongs to this process. */
export function removeLockfile(profileName?: string): void {
  const path = lockfilePath(profileName);
  if (!existsSync(path)) { return; }

  try {
    const raw = readFileSync(path, 'utf-8');
    const lock = JSON.parse(raw) as DaemonLock;
    // Only remove if this process wrote the file.
    if (lock.pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // If the file is corrupt or unreadable, remove it anyway.
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Read / discover
// ---------------------------------------------------------------------------

/**
 * Read the daemon lockfile and return the lock data if the daemon
 * process is still alive.
 *
 * Returns `null` if the lockfile doesn't exist, is corrupt, or the
 * recorded PID is no longer running (stale lockfile).
 */
export function readLockfile(profileName?: string): DaemonLock | null {
  const path = lockfilePath(profileName);
  if (!existsSync(path)) { return null; }

  try {
    const raw = readFileSync(path, 'utf-8');
    const lock = JSON.parse(raw) as DaemonLock;

    if (!lock.pid || !lock.port) { return null; }

    // Check if the process is still alive.
    try {
      process.kill(lock.pid, 0); // Signal 0 = existence check, no signal sent.
    } catch {
      // Process not found — stale lockfile. Clean it up.
      try { unlinkSync(path); } catch { /* ignore */ }
      return null;
    }

    return lock;
  } catch {
    return null;
  }
}
