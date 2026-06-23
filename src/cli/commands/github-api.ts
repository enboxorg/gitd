/**
 * `gitd github-api` — start the GitHub API compatibility shim.
 *
 * Usage:
 *   gitd github-api [--port <port>] [--repos <path>]
 *
 * Starts a read-only HTTP server that translates GitHub REST API v3
 * requests into DWN queries.  Default port: 8181.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { startShimServer } from '../../github-shim/server.js';
import { flagValue, parsePort, resolveReposPath } from '../flags.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function githubApiCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parsePort(flagValue(args, '--port') ?? process.env.GITD_GITHUB_API_PORT ?? '8181');
  const reposPath = resolveReposPath(args, ctx.profileName ?? null);

  console.log('Starting GitHub API compatibility shim...');
  startShimServer({ ctx, port, reposPath });

  // Keep the process alive — the server runs until Ctrl+C.
  await new Promise(() => {});
}
