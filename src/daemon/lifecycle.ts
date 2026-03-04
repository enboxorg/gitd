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

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { enboxHome } from '../profiles/config.js';
import { getVersion } from '../version.js';
import { readLockfile, removeLockfile } from './lockfile.js';

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
 * @param password - Optional vault password to pass to the spawned daemon.
 *                   When omitted, the daemon relies on `GITD_PASSWORD` env var.
 * @returns The port of the running daemon.
 * @throws If the daemon cannot be started within the timeout.
 */
export async function ensureDaemon(password?: string): Promise<EnsureDaemonResult> {
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
  return spawnDaemon(password);
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
async function spawnDaemon(password?: string): Promise<EnsureDaemonResult> {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });

  // Open a raw file descriptor for the log file.  Bun's `spawn()` does not
  // support `stream.Writable` objects as stdio (throws "TODO: stream.Readable
  // stdio @ 1").  A raw fd works on both Node.js and Bun.
  const logFd = openSync(logPath, 'a');

  // Find the gitd binary.  In development this is the source entry point;
  // when installed globally it's on $PATH.
  const gitdBin = findGitdBin();

  const env: Record<string, string | undefined> = {
    ...process.env,
    GITD_DAEMON_BACKGROUND: '1',
  };

  // Pass the vault password so the background daemon can unlock without
  // a TTY prompt.  Prefer the explicit env var; fall back to the password
  // injected by the caller (e.g. main.ts sets it after prompting).
  if (!env.GITD_PASSWORD && password) {
    env.GITD_PASSWORD = password;
  }

  const child = spawn(gitdBin.command, [...gitdBin.prefix, 'serve'], {
    detached : true,
    stdio    : ['ignore', logFd, logFd],
    env,
  });

  // Capture spawn errors (e.g. ENOENT when gitd binary is missing) so
  // we can fail fast instead of polling for 15 seconds.
  const spawnError = new Promise<never>((_, reject) => {
    child.on('error', (err) => {
      reject(new Error(
        `Failed to spawn daemon: ${err.message}\n`
        + 'Hint: ensure gitd is installed and on your PATH, or run from the project directory.',
      ));
    });
  });

  // Detach the child so it survives after we exit.
  child.unref();

  // Close the fd in the parent process — the child inherited it.
  closeSync(logFd);

  // Poll the health endpoint until the daemon is ready, but fail fast
  // if the spawn itself errored (e.g. binary not found).
  const port = await Promise.race([waitForDaemon(), spawnError]);
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

/** Resolved gitd binary and how to invoke it. */
export type GitdBin = {
  /** The binary or runtime to spawn. */
  command: string;
  /** Arguments to pass before `['serve']` etc. */
  prefix: string[];
};

/** Find the gitd binary path and determine how to invoke it. */
export function findGitdBin(): GitdBin {
  // In development: use bun to run the source entry point.
  // This file lives at src/daemon/lifecycle.ts (or dist/esm/daemon/lifecycle.js),
  // so we check for the sibling src/cli/main.ts.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const devPath = join(thisDir, '..', '..', 'src', 'cli', 'main.ts');
  if (existsSync(devPath)) {
    return { command: 'bun', prefix: [devPath] };
  }

  // When installed: `gitd` should be on PATH.
  return { command: 'gitd', prefix: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
