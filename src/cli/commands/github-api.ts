/**
 * `dwn-git github-api` — start the GitHub API compatibility shim.
 *
 * Usage:
 *   dwn-git github-api [--port <port>]
 *
 * Starts a read-only HTTP server that translates GitHub REST API v3
 * requests into DWN queries.  Default port: 8181.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { startShimServer } from '../../github-shim/server.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function githubApiCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parseInt(flagValue(args, '--port') ?? process.env.DWN_GIT_GITHUB_API_PORT ?? '8181', 10);

  console.log('Starting GitHub API compatibility shim...');
  startShimServer({ ctx, port });

  // Keep the process alive — the server runs until Ctrl+C.
  await new Promise(() => {});
}
