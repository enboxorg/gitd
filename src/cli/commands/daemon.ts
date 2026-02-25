/**
 * `dwn-git daemon` — start the unified shim daemon.
 *
 * Starts all enabled ecosystem shims in a single process.  Each shim
 * runs on its own port and speaks the native protocol of its ecosystem
 * (GitHub REST API, npm registry, GOPROXY, OCI Distribution, etc.).
 *
 * Usage:
 *   dwn-git daemon                                Start all shims with defaults
 *   dwn-git daemon --config ./daemon.json         Use a config file
 *   dwn-git daemon --only github,npm              Only start specific shims
 *   dwn-git daemon --disable go,oci               Start all except specific shims
 *   dwn-git daemon --list                         List available shims and exit
 *
 * Config file format (dwn-git.daemon.json):
 *   {
 *     "shims": {
 *       "github": { "enabled": true, "port": 8181 },
 *       "npm":    { "enabled": true, "port": 4873 },
 *       "go":     { "enabled": true, "port": 4874 },
 *       "oci":    { "enabled": true, "port": 5555 }
 *     }
 *   }
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';

import type { AgentContext } from '../agent.js';
import type { DaemonConfig } from '../../daemon/adapter.js';

import { builtinAdapters } from '../../daemon/adapters/index.js';
import { flagValue } from '../flags.js';
import { startDaemon } from '../../daemon/server.js';

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** Default config file name searched in CWD. */
const DEFAULT_CONFIG_FILES = [
  'dwn-git.daemon.json',
  '.dwn-git-daemon.json',
];

/**
 * Load and merge config from file + CLI flags.
 */
function loadConfig(args: string[]): DaemonConfig {
  // Start with empty config (all defaults).
  let config: DaemonConfig = {};

  // Load config file if specified or found in CWD.
  const configPath = flagValue(args, '--config');
  if (configPath) {
    if (!existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } else {
    // Auto-discover config in CWD.
    for (const name of DEFAULT_CONFIG_FILES) {
      if (existsSync(name)) {
        config = JSON.parse(readFileSync(name, 'utf-8'));
        console.log(`[daemon] Using config from ${name}`);
        break;
      }
    }
  }

  // Apply --only filter (disables everything not listed).
  const only = flagValue(args, '--only');
  if (only) {
    const ids = new Set(only.split(',').map((s) => s.trim()));
    if (!config.shims) { config.shims = {}; }
    for (const adapter of builtinAdapters) {
      if (!config.shims[adapter.id]) { config.shims[adapter.id] = {}; }
      config.shims[adapter.id].enabled = ids.has(adapter.id);
    }
  }

  // Apply --disable filter.
  const disable = flagValue(args, '--disable');
  if (disable) {
    const ids = new Set(disable.split(',').map((s) => s.trim()));
    if (!config.shims) { config.shims = {}; }
    for (const id of ids) {
      if (!config.shims[id]) { config.shims[id] = {}; }
      config.shims[id].enabled = false;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function daemonCommand(ctx: AgentContext, args: string[]): Promise<void> {
  // --list: show available shims and exit.
  if (args.includes('--list')) {
    console.log('Available shims:\n');
    for (const adapter of builtinAdapters) {
      console.log(`  ${adapter.id.padEnd(12)} ${adapter.name.padEnd(24)} default port: ${adapter.defaultPort}  env: ${adapter.portEnvVar}`);
    }
    console.log(`\nTotal: ${builtinAdapters.length} adapters`);
    return;
  }

  const config = loadConfig(args);
  const instance = await startDaemon({ ctx, config });

  // Register signal handlers for graceful shutdown.
  const shutdown = async (): Promise<void> => {
    console.log('\n[daemon] Shutting down...');
    await instance.stop();
    console.log('[daemon] All shims stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive.
  await new Promise(() => {});
}
