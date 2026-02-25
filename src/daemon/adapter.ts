/**
 * ShimAdapter — the interface every ecosystem shim implements to plug
 * into the unified daemon.
 *
 * Each adapter wraps a specific protocol translation (GitHub REST API,
 * npm registry, Go module proxy, OCI Distribution, etc.) behind a
 * uniform contract.  The daemon starts one HTTP server per enabled
 * adapter and delegates all request handling to the adapter.
 *
 * To add a new ecosystem (e.g. Maven Central, Rust crates.io):
 *   1. Implement `ShimAdapter`
 *   2. Register it in `adapters/index.ts`
 *   3. The daemon picks it up automatically
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentContext } from '../cli/agent.js';

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/** A shim adapter bridges between an ecosystem's native HTTP protocol and DWN. */
export interface ShimAdapter {
  /** Unique identifier — used in config and CLI flags (e.g. `'github'`, `'npm'`). */
  readonly id: string;

  /** Human-readable name for log output (e.g. `'GitHub API'`, `'npm registry'`). */
  readonly name: string;

  /** Default port when none is configured. */
  readonly defaultPort: number;

  /** Environment variable that overrides the default port (e.g. `'DWN_GIT_GITHUB_API_PORT'`). */
  readonly portEnvVar: string;

  /**
   * Handle an incoming HTTP request.
   *
   * The daemon calls this for every non-OPTIONS request on the
   * adapter's server.  The adapter is responsible for writing the
   * full response (status, headers, body) to `res`.
   *
   * CORS preflight (OPTIONS) is handled by the daemon — adapters
   * never see OPTIONS requests.
   */
  handle(ctx: AgentContext, req: IncomingMessage, res: ServerResponse): Promise<void>;

  /**
   * Additional CORS methods to advertise in the preflight response.
   * Defaults to `'GET, OPTIONS'` if not provided.
   */
  readonly corsMethods?: string;

  /**
   * Additional CORS headers to advertise in the preflight response.
   * Defaults to `'Authorization, Accept, Content-Type'` if not provided.
   */
  readonly corsHeaders?: string;

  /**
   * One-line usage hint printed when the adapter starts.
   * Can reference `{port}` which will be replaced with the actual port.
   */
  readonly usageHint?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-shim configuration entry. */
export type ShimConfig = {
  /** Whether this shim is enabled. Defaults to `true`. */
  enabled? : boolean;

  /** Port override. Falls back to env var, then `defaultPort`. */
  port? : number;
};

/** Full daemon configuration. */
export type DaemonConfig = {
  /** Per-shim overrides keyed by adapter `id`. */
  shims? : Record<string, ShimConfig>;
};

/** Resolved runtime config for a single shim — all values concrete. */
export type ResolvedShimConfig = {
  adapter : ShimAdapter;
  enabled : boolean;
  port : number;
};
