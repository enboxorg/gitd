/**
 * Daemon lifecycle management — auto-start, stop, and status.
 *
 * `ensureDaemon()` transparently ensures a local gitd server is running
 * before any `did::` remote operation.  It reads the lockfile, validates
 * the running process, and spawns a new background daemon if needed.
 *
 * Follows the Ollama pattern: the CLI auto-starts the daemon on first
 * use, and re-starts it if it has crashed or been upgraded.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { enboxHome } from '../profiles/config.js';
import { getVersion } from '../version.js';
import { lockfilePath, readLockfile, removeLockfile } from './lockfile.js';

import type { DaemonLock } from './lockfile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max time to wait for the daemon to become healthy after spawning (ms). */
const SPAWN_TIMEOUT_MS = 15_000;

/** Initial backoff delay when polling the daemon health endpoint (ms). */
const INITIAL_BACKOFF_MS = 100;

/** Maximum backoff delay between health polls (ms). */
const MAX_BACKOFF_MS = 1_000;

/** Timeout for each individual health probe (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Path to the daemon log file. */
export function daemonLogPath(): string {
  return join(enboxHome(), 'gitd', 'daemon.log');
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/**
 * Probe the daemon health endpoint.
 *
 * @returns `true` if the daemon responded with HTTP 200, `false` otherwise.
 */
async function probeDaemonHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensureDaemon
// ---------------------------------------------------------------------------

/** Result of `ensureDaemon()`. */
export type EnsureDaemonResult = {
  /** The port the daemon is listening on. */
  port: number;

  /** Whether the daemon was freshly spawned (vs already running). */
  spawned: boolean;
};

/**
 * Ensure a local gitd daemon is running and healthy.
 *
 * 1. Reads the lockfile and validates the running process.
 * 2. If a healthy daemon exists with a matching version, returns immediately.
 * 3. If the daemon is stale, crashed, or from an old version, stops it.
 * 4. Spawns a new `gitd serve` process in the background.
 * 5. Polls the health endpoint until the daemon is ready.
 *
 * @returns The port of the running daemon.
 * @throws If the daemon cannot be started within the timeout.
 */
export async function ensureDaemon(): Promise<EnsureDaemonResult> {
  const lock = readLockfile();

  if (lock) {
    // Check for version mismatch (user upgraded gitd).
    const currentVersion = getVersion();
    if (currentVersion && lock.version && currentVersion !== lock.version) {
      console.error(
        `[daemon] Version mismatch: running ${lock.version}, current ${currentVersion}. Restarting...`,
      );
      stopDaemonByLock(lock);
    } else {
      // Version matches (or unknown) — check health.
      const healthy = await probeDaemonHealth(lock.port);
      if (healthy) {
        return { port: lock.port, spawned: false };
      }
      // PID is alive (readLockfile validated it) but not responding — stale.
      console.error('[daemon] Daemon is not responding. Restarting...');
      stopDaemonByLock(lock);
    }
  }

  // Spawn a new daemon in the background.
  return spawnDaemon();
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a new `gitd serve` process in the background, detached from
 * the current process.  Stdout and stderr are redirected to the daemon
 * log file.
 *
 * Polls the health endpoint with exponential backoff until the daemon
 * is ready or the timeout is exceeded.
 */
async function spawnDaemon(): Promise<EnsureDaemonResult> {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });

  const logStream = createWriteStream(logPath, { flags: 'a' });

  // Find the gitd binary.  In development this is the source entry point;
  // when installed globally it's on $PATH.
  const gitdBin = findGitdBin();

  const child = spawn(gitdBin, ['serve'], {
    detached : true,
    stdio    : ['ignore', logStream, logStream],
    env      : {
      ...process.env,
      // Pass through the current password so the daemon can unlock the vault.
      // This is safe because the daemon is a child of the current process.
      GITD_DAEMON_BACKGROUND: '1',
    },
  });

  // Detach the child so it survives after we exit.
  child.unref();

  // Poll the health endpoint until the daemon is ready.
  const port = await waitForDaemon();
  return { port, spawned: true };
}

/**
 * Poll the lockfile + health endpoint with exponential backoff.
 *
 * @returns The port the daemon is listening on.
 * @throws If the daemon does not become healthy within the timeout.
 */
async function waitForDaemon(): Promise<number> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let delay = INITIAL_BACKOFF_MS;

  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);

    const lock = readLockfile();
    if (!lock) { continue; }

    const healthy = await probeDaemonHealth(lock.port);
    if (healthy) { return lock.port; }
  }

  throw new Error(
    'Timed out waiting for the gitd daemon to start. '
    + `Check the log at ${daemonLogPath()} for details, or run \`gitd serve\` manually to debug.`,
  );
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop a running daemon by PID from the lockfile.
 */
function stopDaemonByLock(lock: DaemonLock): void {
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {
    // Process already dead — fine.
  }
  removeLockfile();
}

/**
 * Stop the running daemon (if any).
 *
 * @returns `true` if a daemon was stopped, `false` if none was running.
 */
export function stopDaemon(): boolean {
  const lock = readLockfile();
  if (!lock) { return false; }
  stopDaemonByLock(lock);
  return true;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Daemon status information. */
export type DaemonStatus = {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
  version?: string;
  uptime?: string;
};

/**
 * Get the status of the running daemon.
 */
export function daemonStatus(): DaemonStatus {
  const lock = readLockfile();
  if (!lock) {
    return { running: false };
  }

  const uptimeMs = Date.now() - new Date(lock.startedAt).getTime();
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const secs = uptimeSec % 60;
  const uptime = hours > 0
    ? `${hours}h ${mins}m ${secs}s`
    : mins > 0
      ? `${mins}m ${secs}s`
      : `${secs}s`;

  return {
    running   : true,
    pid       : lock.pid,
    port      : lock.port,
    startedAt : lock.startedAt,
    version   : lock.version,
    uptime,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the gitd binary path. */
function findGitdBin(): string {
  // In development: use the source entry point via bun.
  const devPath = join(dirname(lockfilePath()), '..', 'src', 'cli', 'main.ts');
  if (existsSync(devPath)) {
    return devPath;
  }

  // When installed: `gitd` should be on PATH.
  return 'gitd';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
