/**
 * Shared helper to locate the repo record's contextId.
 *
 * All composing protocols (issues, patches) need the repo's `contextId`
 * as the `parentContextId` for their top-level writes (via `$ref`).
 *
 * @module
 */

import type { AgentContext } from './agent.js';

/**
 * Query the local DWN for the singleton repo record and return its contextId.
 * Exits with an error if no repo has been initialized.
 */
export async function getRepoContextId(ctx: AgentContext): Promise<string> {
  const { records } = await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.error('No repository found. Run `dwn-git init <name>` first.');
    process.exit(1);
  }

  const contextId = records[0].contextId;
  if (!contextId) {
    console.error('Repository record has no contextId — this should not happen.');
    process.exit(1);
  }

  return contextId;
}
