/**
 * Daemon lockfile — discovery mechanism for the local gitd server.
 *
 * When `gitd serve` starts, it writes a JSON lockfile to
 * `~/.enbox/daemon.lock` containing `{ pid, port, startedAt }`.
 * `git-remote-did` reads this file to discover a running local daemon
 * and resolve `did::` remotes to `http://localhost:<port>/...` instead
 * of performing DID document resolution.
 *
 * The lockfile is removed on graceful shutdown and validated (PID check)
 * on read to handle stale files from crashed processes.
 *
 * @module
 */

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { enboxHome } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Path to the daemon lockfile. */
export function lockfilePath(): string {
  return join(enboxHome(), 'daemon.lock');
}

// ---------------------------------------------------------------------------
// Write / remove
// ---------------------------------------------------------------------------

/** Write the daemon lockfile. Overwrites any existing file. */
export function writeLockfile(port: number, version?: string): void {
  const lock: DaemonLock = {
    pid       : process.pid,
    port,
    startedAt : new Date().toISOString(),
    ...(version ? { version } : {}),
  };
  const path = lockfilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + '\n', { mode: 0o644 });
}

/** Remove the daemon lockfile if it exists and belongs to this process. */
export function removeLockfile(): void {
  const path = lockfilePath();
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
export function readLockfile(): DaemonLock | null {
  const path = lockfilePath();
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
