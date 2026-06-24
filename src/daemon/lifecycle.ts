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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getVersion } from '../version.js';
import { enboxHome, profilesDir } from '../profiles/config.js';
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
const DEFERRED_START_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Path to the daemon log file. */
export function daemonLogPath(profileName?: string): string {
  const profile = profileName || process.env.GITD_PROFILE || process.env.ENBOX_PROFILE;
  if (profile) {
    return join(profilesDir(), profile, 'gitd', 'daemon.log');
  }
  return join(enboxHome(), 'gitd', 'daemon.log');
}

/** Read the last lines from the daemon log for actionable startup failures. */
export function daemonLogTail(profileName?: string, maxLines = 20): string {
  const path = daemonLogPath(profileName);
  if (!existsSync(path)) {
    return '';
  }

  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .join('\n');
  } catch {
    return '';
  }
}

export function deferredDaemonStartPath(profileName?: string): string {
  return join(dirname(daemonLogPath(profileName)), 'daemon-start.pending');
}

export function markDeferredDaemonStart(profileName?: string): void {
  const path = deferredDaemonStartPath(profileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(Date.now()), 'utf-8');
}

export function hasRecentDeferredDaemonStart(profileName?: string, now = Date.now()): boolean {
  const path = deferredDaemonStartPath(profileName);
  if (!existsSync(path)) { return false; }

  try {
    const startedAt = Number.parseInt(readFileSync(path, 'utf-8'), 10);
    if (Number.isFinite(startedAt) && now - startedAt <= DEFERRED_START_WINDOW_MS) {
      return true;
    }
    unlinkSync(path);
  } catch {
    try { unlinkSync(path); } catch { /* ignore cleanup */ }
  }
  return false;
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

export type DaemonLifecycleOptions = {
  /** Named profile whose helper should be discovered or spawned. */
  profileName?: string;
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
export async function ensureDaemon(
  password?: string,
  options: DaemonLifecycleOptions = {},
): Promise<EnsureDaemonResult> {
  const lock = readLockfile(options.profileName);

  if (lock) {
    // Check for version mismatch (user upgraded gitd).
    const currentVersion = getVersion();
    if (currentVersion && lock.version && currentVersion !== lock.version) {
      console.error(
        `[daemon] Version mismatch: running ${lock.version}, current ${currentVersion}. Restarting...`,
      );
      stopDaemonByLock(lock, options.profileName);
    } else {
      // Version matches (or unknown) — check health.
      const healthy = await probeDaemonHealth(lock.port);
      if (healthy) {
        return { port: lock.port, spawned: false };
      }
      // PID is alive (readLockfile validated it) but not responding — stale.
      console.error('[daemon] Daemon is not responding. Restarting...');
      stopDaemonByLock(lock, options.profileName);
    }
  }

  // Spawn a new daemon in the background. A just-closed foreground agent can
  // leave LevelDB handles unavailable for a brief moment, so retry one early
  // spawn failure before surfacing the startup error.
  try {
    return await spawnDaemon(password, options);
  } catch (err) {
    if (!shouldRetrySpawnFailure(err, options.profileName)) {
      throw err;
    }
    await sleep(500);
    return spawnDaemon(password, options);
  }
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
async function spawnDaemon(
  password?: string,
  options: DaemonLifecycleOptions = {},
): Promise<EnsureDaemonResult> {
  const logPath = daemonLogPath(options.profileName);
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
  if (options.profileName) {
    env.GITD_PROFILE = options.profileName;
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

  const earlyExit = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(new Error(
        `gitd helper exited before becoming healthy (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`
        + daemonTailMessage(options.profileName),
      ));
    });
  });

  // Detach the child so it survives after we exit.
  child.unref();

  // Close the fd in the parent process — the child inherited it.
  closeSync(logFd);

  // Poll the health endpoint until the daemon is ready, but fail fast
  // if the spawn itself errored (e.g. binary not found).
  const port = await Promise.race([waitForDaemon(options), spawnError, earlyExit]);
  return { port, spawned: true };
}

function shouldRetrySpawnFailure(err: unknown, profileName?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Database is not open')) { return true; }
  if (message.includes('LEVEL_LOCKED') || message.includes('LOCK')) { return true; }
  const tail = daemonLogTail(profileName);
  return tail.includes('Database is not open')
    || tail.includes('LEVEL_LOCKED')
    || tail.includes('LOCK');
}

/**
 * Poll the lockfile + health endpoint with exponential backoff.
 *
 * @returns The port the daemon is listening on.
 * @throws If the daemon does not become healthy within the timeout.
 */
async function waitForDaemon(options: DaemonLifecycleOptions = {}): Promise<number> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let delay = INITIAL_BACKOFF_MS;

  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);

    const lock = readLockfile(options.profileName);
    if (!lock) { continue; }

    const healthy = await probeDaemonHealth(lock.port);
    if (healthy) { return lock.port; }
  }

  throw new Error(
    'Timed out waiting for the gitd daemon to start. '
    + `Check the log at ${daemonLogPath(options.profileName)} for details, or run \`gitd helper start\` manually to debug.`
    + daemonTailMessage(options.profileName),
  );
}

function daemonTailMessage(profileName?: string): string {
  const tail = daemonLogTail(profileName);
  if (!tail) { return ''; }
  return `\n\nLast daemon log lines:\n${tail}`;
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop a running daemon by PID from the lockfile.
 */
function stopDaemonByLock(lock: DaemonLock, profileName?: string): void {
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {
    // Process already dead — fine.
  }
  removeLockfile(profileName);
}

/**
 * Stop the running daemon (if any).
 *
 * @returns `true` if a daemon was stopped, `false` if none was running.
 */
export function stopDaemon(options: DaemonLifecycleOptions = {}): boolean {
  const lock = readLockfile(options.profileName);
  if (!lock) { return false; }
  stopDaemonByLock(lock, options.profileName);
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
  ownerDid?: string;
  sessionId?: string;
  profileName?: string;
  reposPath?: string;
  capabilities?: string[];
  expiryPolicy?: DaemonLock['expiryPolicy'];
  repoContexts?: DaemonLock['repoContexts'];
  dwnHelper?: boolean;
};

/**
 * Get the status of the running daemon.
 */
export function daemonStatus(options: DaemonLifecycleOptions = {}): DaemonStatus {
  const lock = readLockfile(options.profileName);
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
    running      : true,
    pid          : lock.pid,
    port         : lock.port,
    startedAt    : lock.startedAt,
    version      : lock.version,
    ownerDid     : lock.ownerDid,
    sessionId    : lock.sessionId,
    profileName  : lock.profileName,
    reposPath    : lock.reposPath,
    capabilities : lock.capabilities,
    expiryPolicy : lock.expiryPolicy,
    repoContexts : lock.repoContexts,
    dwnHelper    : lock.dwnHelper,
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
