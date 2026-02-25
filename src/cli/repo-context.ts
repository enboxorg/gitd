/**
 * Shared helper to locate a repo record's contextId and visibility.
 *
 * All composing protocols (issues, patches) need the repo's `contextId`
 * as the `parentContextId` for their top-level writes (via `$ref`).
 * The `visibility` tag determines whether bundle records are encrypted.
 *
 * Multi-repo: a DID can own multiple repos.  The `repoName` parameter
 * selects the target.  When omitted and only one repo exists, it is
 * used automatically.  When multiple repos exist the caller must supply
 * a name (resolved from `--repo`, env, or git config).
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
  /** The repo name. */
  name: string;
};

/**
 * Query the local DWN for a repo record and return its context.
 *
 * @param ctx - Agent context with typed protocol handles.
 * @param repoName - Repo name to look up.  When `undefined`, falls back
 *   to the only repo if exactly one exists, or exits with an error.
 */
export async function getRepoContext(
  ctx: AgentContext,
  repoName?: string,
): Promise<RepoContext> {
  if (repoName) {
    // Look up by name tag.
    const { records } = await ctx.repo.records.query('repo', {
      filter: { tags: { name: repoName } },
    });

    if (records.length === 0) {
      console.error(`Repository "${repoName}" not found. Run \`gitd init ${repoName}\` first.`);
      process.exit(1);
    }

    return extractContext(records[0], repoName);
  }

  // No name provided — fall back to single-repo or error.
  const { records } = await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.error('No repository found. Run `gitd init <name>` first.');
    process.exit(1);
  }

  if (records.length > 1) {
    console.error('Multiple repositories exist. Specify one with --repo <name>, GITD_REPO env, or `git config enbox.repo <name>`.');
    process.exit(1);
  }

  const data = await records[0].data.json();
  return extractContext(records[0], data.name ?? 'unnamed');
}

/**
 * Convenience wrapper — returns only the contextId.
 */
export async function getRepoContextId(
  ctx: AgentContext,
  repoName?: string,
): Promise<string> {
  const { contextId } = await getRepoContext(ctx, repoName);
  return contextId;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function extractContext(record: any, name: string): RepoContext {
  const contextId = record.contextId;
  if (!contextId) {
    console.error('Repository record has no contextId — this should not happen.');
    process.exit(1);
  }

  const visibility = (record.tags?.visibility as 'public' | 'private') ?? 'public';
  return { contextId, visibility, name };
}
