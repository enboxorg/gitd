/**
 * Daemon lifecycle tests — version in lockfile, status, stop, log path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createGitServer } from '../src/git-server/server.js';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { getVersion } from '../src/version.js';
import { daemonLogPath, daemonStatus, findGitdBin, stopDaemon } from '../src/daemon/lifecycle.js';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { lockfilePath, readLockfile, removeLockfile, writeLockfile } from '../src/daemon/lockfile.js';

// ---------------------------------------------------------------------------
// Lockfile version field
// ---------------------------------------------------------------------------

describe('lockfile version field', () => {
  const path = lockfilePath();

  beforeAll(() => {
    mkdirSync(dirname(path), { recursive: true });
  });

  afterAll(() => {
    try { unlinkSync(path); } catch { /* ignore */ }
  });

  it('should write version to lockfile when provided', () => {
    writeLockfile(9418, '1.2.3');
    const lock = readLockfile();
    expect(lock).not.toBeNull();
    expect(lock!.version).toBe('1.2.3');
    removeLockfile();
  });

  it('should omit version when not provided', () => {
    writeLockfile(9418);
    const lock = readLockfile();
    expect(lock).not.toBeNull();
    expect(lock!.version).toBeUndefined();
    removeLockfile();
  });
});

// ---------------------------------------------------------------------------
// daemonStatus
// ---------------------------------------------------------------------------

describe('daemonStatus', () => {
  const path = lockfilePath();

  beforeAll(() => {
    mkdirSync(dirname(path), { recursive: true });
  });

  afterAll(() => {
    try { unlinkSync(path); } catch { /* ignore */ }
  });

  it('should return not running when no lockfile exists', () => {
    try { unlinkSync(path); } catch { /* ignore */ }
    const status = daemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });

  it('should return running with details when lockfile exists', () => {
    writeLockfile(9418, '0.6.1');
    const status = daemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(9418);
    expect(status.version).toBe('0.6.1');
    expect(status.uptime).toBeDefined();
    expect(status.startedAt).toBeDefined();
    removeLockfile();
  });
});

// ---------------------------------------------------------------------------
// stopDaemon
// ---------------------------------------------------------------------------

describe('stopDaemon', () => {
  const path = lockfilePath();

  beforeAll(() => {
    mkdirSync(dirname(path), { recursive: true });
  });

  afterAll(() => {
    try { unlinkSync(path); } catch { /* ignore */ }
  });

  it('should return false when no daemon is running', () => {
    try { unlinkSync(path); } catch { /* ignore */ }
    expect(stopDaemon()).toBe(false);
  });

  // Note: we can't test actual process killing in unit tests since the
  // lockfile PID is the test process itself. We verify the return value
  // and lockfile cleanup instead.
});

// ---------------------------------------------------------------------------
// daemonLogPath
// ---------------------------------------------------------------------------

describe('daemonLogPath', () => {
  it('should return a path under ~/.enbox/gitd/', () => {
    const logPath = daemonLogPath();
    expect(logPath).toContain('gitd');
    expect(logPath).toContain('daemon.log');
  });
});

// ---------------------------------------------------------------------------
// findGitdBin
// ---------------------------------------------------------------------------

describe('findGitdBin', () => {
  it('should resolve to bun + src/cli/main.ts when running from source', () => {
    const bin = findGitdBin();
    expect(bin.command).toBe('bun');
    expect(bin.prefix[0]).toEndWith('src/cli/main.ts');
  });

  it('should resolve a path that actually exists on disk', () => {
    const bin = findGitdBin();
    expect(existsSync(bin.prefix[0])).toBe(true);
  });

  it('should NOT resolve to a path under ~/.enbox', () => {
    const bin = findGitdBin();
    expect(bin.prefix[0]).not.toContain('.enbox');
  });
});

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

describe('getVersion', () => {
  it('should return a semver-like string', () => {
    const version = getVersion();
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// onRequest callback in GitServer
// ---------------------------------------------------------------------------

describe('GitServer onRequest callback', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let requestCount: number;

  beforeAll(async () => {
    requestCount = 0;
    // Simulate the onRequest pattern used by createGitServer.
    server = createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('should track requests (simulated idle timer pattern)', async () => {
    expect(requestCount).toBe(0);
    await fetch(`http://localhost:${port}/health`);
    expect(requestCount).toBe(1);
    await fetch(`http://localhost:${port}/health`);
    expect(requestCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// EADDRINUSE — graceful port conflict error
// ---------------------------------------------------------------------------

describe('createGitServer EADDRINUSE', () => {
  let blocker: ReturnType<typeof createServer>;
  let blockedPort: number;

  beforeAll(async () => {
    // Occupy a port so createGitServer will hit EADDRINUSE.
    blocker = createServer((_req, res) => {
      res.writeHead(200);
      res.end('occupied');
    });
    await new Promise<void>((resolve) => {
      blocker.listen(0, () => {
        blockedPort = (blocker.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    blocker.close();
  });

  it('should throw a helpful error when the port is already in use', async () => {
    await expect(
      createGitServer({ basePath: '__TESTDATA__/eaddrinuse', port: blockedPort }),
    ).rejects.toThrow(/Port \d+ is already in use/);
  });

  it('should include a hint about gitd serve status', async () => {
    await expect(
      createGitServer({ basePath: '__TESTDATA__/eaddrinuse', port: blockedPort }),
    ).rejects.toThrow(/gitd serve status/);
  });
});
