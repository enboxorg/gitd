/**
 * Shared helper to locate the repo record's contextId and visibility.
 *
 * All composing protocols (issues, patches) need the repo's `contextId`
 * as the `parentContextId` for their top-level writes (via `$ref`).
 * The `visibility` tag determines whether bundle records are encrypted.
 *
 * @module
 */

import type { AgentContext } from './agent.js';

/** Repo context returned by {@link getRepoContext}. */
export type RepoContext = {
  /** The repo record's contextId (used as parentContextId for child records). */
  contextId: string;
  /** Repo visibility — controls encryption of bundle records. */
  visibility: 'public' | 'private';
};

/**
 * Query the local DWN for the singleton repo record and return its context.
 * Exits with an error if no repo has been initialized.
 */
export async function getRepoContext(ctx: AgentContext): Promise<RepoContext> {
  const { records } = await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.error('No repository found. Run `dwn-git init <name>` first.');
    process.exit(1);
  }

  const record = records[0];

  const contextId = record.contextId;
  if (!contextId) {
    console.error('Repository record has no contextId — this should not happen.');
    process.exit(1);
  }

  const visibility = (record.tags?.visibility as 'public' | 'private') ?? 'public';

  return { contextId, visibility };
}

/**
 * Query the local DWN for the singleton repo record and return its contextId.
 * Exits with an error if no repo has been initialized.
 *
 * @deprecated Use {@link getRepoContext} instead to also get visibility.
 */
export async function getRepoContextId(ctx: AgentContext): Promise<string> {
  const { contextId } = await getRepoContext(ctx);
  return contextId;
}
