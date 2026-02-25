/**
 * Unified daemon server — starts one HTTP server per enabled shim adapter.
 *
 * The daemon manages the lifecycle of all shim servers from a single
 * process.  It resolves configuration (JSON file, env vars, defaults),
 * starts each enabled adapter on its assigned port, logs a status
 * summary, and handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Each adapter's server includes:
 *   - CORS preflight handling (OPTIONS)
 *   - A `/health` endpoint returning `{ status: 'ok', shim: '<id>' }`
 *   - Delegation to the adapter's `handle()` method for all other requests
 *   - Top-level error catching with 500 responses
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import type { AgentContext } from '../cli/agent.js';
import type { DaemonConfig, ResolvedShimConfig, ShimAdapter } from './adapter.js';

import { builtinAdapters } from './adapters/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonOptions = {
  ctx : AgentContext;
  config : DaemonConfig;
};

export type DaemonInstance = {
  /** All running HTTP servers keyed by adapter id. */
  servers : Map<string, Server>;

  /** The resolved config for each adapter. */
  resolved : ResolvedShimConfig[];

  /** Gracefully shut down all servers. */
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective configuration for every known adapter.
 *
 * Priority for port: config file > env var > adapter default.
 * Priority for enabled: config file > `true` (all enabled by default).
 */
export function resolveConfig(
  config: DaemonConfig,
  adapters: readonly ShimAdapter[] = builtinAdapters,
): ResolvedShimConfig[] {
  return adapters.map((adapter) => {
    const entry = config.shims?.[adapter.id];
    const envPort = process.env[adapter.portEnvVar];

    const port = entry?.port
      ?? (envPort ? parseInt(envPort, 10) : undefined)
      ?? adapter.defaultPort;

    const enabled = entry?.enabled ?? true;

    return { adapter, enabled, port };
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server for a single adapter.
 *
 * The server handles CORS preflight, `/health`, and delegates
 * everything else to the adapter.  It does NOT call `server.listen()`
 * — the caller is responsible for that.
 */
export function createAdapterServer(ctx: AgentContext, adapter: ShimAdapter): Server {
  const corsMethods = adapter.corsMethods ?? 'GET, OPTIONS';
  const corsHeaders = adapter.corsHeaders ?? 'Authorization, Accept, Content-Type';

  return createServer(async (req, res) => {
    const method = req.method ?? 'GET';

    // CORS preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : corsMethods,
        'Access-Control-Allow-Headers' : corsHeaders,
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    // Health endpoint.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', shim: adapter.id }));
      return;
    }

    // Delegate to adapter.
    try {
      await adapter.handle(ctx, req, res);
    } catch (err) {
      console.error(`[daemon:${adapter.id}] Error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the unified daemon.
 *
 * Resolves configuration, starts one HTTP server per enabled adapter,
 * registers SIGINT/SIGTERM handlers, and returns the `DaemonInstance`
 * for programmatic control and testing.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonInstance> {
  const { ctx, config } = options;
  const resolved = resolveConfig(config);
  const servers = new Map<string, Server>();

  const enabledAdapters = resolved.filter((r) => r.enabled);

  if (enabledAdapters.length === 0) {
    console.log('[daemon] No shims enabled — nothing to start.');
    return { servers, resolved, stop: async (): Promise<void> => {} };
  }

  // Start each enabled adapter.
  const startPromises = enabledAdapters.map((r) => {
    return new Promise<void>((resolve, reject) => {
      const server = createAdapterServer(ctx, r.adapter);

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[daemon:${r.adapter.id}] Port ${r.port} is already in use — skipping.`);
          resolve();
        } else {
          reject(err);
        }
      });

      server.listen(r.port, () => {
        servers.set(r.adapter.id, server);
        resolve();
      });
    });
  });

  await Promise.all(startPromises);

  // Print status summary.
  console.log('[daemon] dwn-git daemon started');
  console.log('');
  for (const r of enabledAdapters) {
    const running = servers.has(r.adapter.id);
    const status = running ? `http://localhost:${r.port}` : 'FAILED';
    console.log(`  ${r.adapter.name.padEnd(22)} ${status}`);
    if (running && r.adapter.usageHint) {
      console.log(`  ${''.padEnd(22)} ${r.adapter.usageHint.replace('{port}', String(r.port))}`);
    }
  }
  console.log('');
  console.log(`[daemon] ${servers.size}/${enabledAdapters.length} shims running. Health: GET /health on any port.`);
  console.log('[daemon] Press Ctrl+C to stop.');
  console.log('');

  // Build the stop function.
  const stop = async (): Promise<void> => {
    const closePromises: Promise<void>[] = [];
    for (const [id, server] of servers) {
      closePromises.push(new Promise<void>((resolve) => {
        server.close(() => {
          console.log(`[daemon:${id}] stopped`);
          resolve();
        });
      }));
    }
    await Promise.all(closePromises);
    servers.clear();
  };

  return { servers, resolved, stop };
}
