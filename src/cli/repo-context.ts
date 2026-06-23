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

import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { RecordsQuery } from '@enbox/dwn-sdk-js';

import { ForgeRepoDefinition } from '../repo.js';
import { getDwnEndpoints } from '../git-server/did-service.js';

/** Repo context returned by {@link getRepoContext}. */
export type RepoContext = {
  /** The repo record ID (stable identifier used by indexers and cross-DWN submissions). */
  recordId: string;
  /** The repo record's contextId (used as parentContextId for child records). */
  contextId: string;
  /** Repo visibility — controls encryption of bundle records. */
  visibility: 'public' | 'private';
  /** The repo name. */
  name: string;
};

/** Repo role names that can be used as cross-protocol role grants. */
export type RepoRoleName = 'maintainer' | 'moderator' | 'triager' | 'contributor' | 'viewer';

const repoContextCache = new Map<string, RepoContext>();

export function rememberRepoContext(targetDid: string, repo: RepoContext): void {
  repoContextCache.set(repoContextCacheKey(targetDid, repo.name), repo);
}

/** Build a DWN `from` option for local-vs-remote repo queries. */
export function fromOpt(ctx: AgentContext, targetDid: string): string | undefined {
  return targetDid === ctx.did ? undefined : targetDid;
}

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
  return getRepoContextForDid(ctx, ctx.did, repoName);
}

/**
 * Query a local or remote DWN for a repo record and return its context.
 *
 * @param ctx - Agent context with typed protocol handles.
 * @param targetDid - DID whose DWN should be queried.
 * @param repoName - Repo name to look up.  When `undefined`, falls back
 *   to the only repo if exactly one exists, or exits with an error.
 */
export async function getRepoContextForDid(
  ctx: AgentContext,
  targetDid: string,
  repoName?: string,
): Promise<RepoContext> {
  const from = fromOpt(ctx, targetDid);

  if (repoName) {
    const cached = repoContextCache.get(repoContextCacheKey(targetDid, repoName));
    if (cached) {
      return cached;
    }

    // Look up by name tag.
    const records = await queryRepoRecordsByName(ctx, targetDid, repoName, from);

    if (records.length === 0) {
      const owner = targetDid === ctx.did ? 'local DWN' : targetDid;
      throw new Error(`Repository "${repoName}" not found in ${owner}.`);
    }

    const repo = extractContext(records[0], repoName);
    rememberRepoContext(targetDid, repo);
    return repo;
  }

  // No name provided — fall back to single-repo or error.
  const { records } = await ctx.repo.records.query('repo', {
    ...(from ? { from } : {}),
  });

  if (records.length === 0) {
    const owner = targetDid === ctx.did ? 'local DWN' : targetDid;
    throw new Error(`No repository found in ${owner}.`);
  }

  if (records.length > 1) {
    throw new Error('Multiple repositories exist. Specify one with --repo <name>, GITD_REPO env, or `git config enbox.repo <name>`.');
  }

  const data = await records[0].data.json();
  return extractContext(records[0], data.name ?? 'unnamed');
}

async function queryRepoRecordsByName(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  from?: string,
): Promise<any[]> {
  try {
    const { records } = await ctx.repo.records.query('repo', {
      ...(from ? { from } : {}),
      filter: { tags: { name: repoName } },
    });
    if (records.length > 0 || !from) {
      return records;
    }
  } catch {
    if (!from) {
      throw new Error(`Repository "${repoName}" not found in local DWN.`);
    }
  }

  return queryRepoRecordsByNameViaEndpoints(ctx, targetDid, repoName);
}

async function queryRepoRecordsByNameViaEndpoints(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
): Promise<any[]> {
  const endpoints = [...new Set([...getDwnEndpoints(ctx.enbox), ...envDwnEndpoints()])];
  if (process.env.GITD_DEBUG === '1') {
    console.error(`[repo-context] direct lookup ${targetDid}/${repoName} endpoints=${endpoints.join(',') || '<none>'}`);
  }
  if (endpoints.length === 0) {
    return [];
  }

  const query = await RecordsQuery.create({
    filter: {
      protocol     : ForgeRepoDefinition.protocol,
      protocolPath : 'repo',
      tags         : { name: repoName },
    },
  });
  const client = new HttpDwnRpcClient();
  for (const endpoint of endpoints) {
    let errorMessage: string | undefined;
    const reply = await client.sendDwnRequest({
      dwnUrl    : endpoint,
      targetDid,
      message   : query.message,
    }).catch((err) => {
      errorMessage = (err as Error).message;
      return undefined;
    });
    if (process.env.GITD_DEBUG === '1') {
      console.error(`[repo-context] ${endpoint} status=${reply?.status.code ?? '<error>'} entries=${reply?.entries?.length ?? 0}${errorMessage ? ` error=${errorMessage}` : ''}`);
    }
    if (reply?.status.code === 200 && (reply.entries?.length ?? 0) > 0) {
      return reply.entries as any[];
    }
  }

  return [];
}

function envDwnEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.GITD_DWN_ENDPOINTS ?? env.GITD_DWN_ENDPOINT;
  if (!raw) { return []; }
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
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

/** Resolve the caller's repo role on a remote repo. */
export async function resolveRepoRoleName(
  ctx: AgentContext,
  targetDid: string,
  repoContextId: string,
  candidates: readonly RepoRoleName[],
  fallback?: RepoRoleName,
): Promise<RepoRoleName | undefined> {
  if (targetDid === ctx.did) {
    return undefined;
  }

  for (const role of candidates) {
    const { records } = await ctx.repo.records.query(`repo/${role}` as any, {
      from   : targetDid,
      filter : { contextId: repoContextId, tags: { did: ctx.did } },
    });
    if (records.length > 0) {
      return role;
    }
  }

  return fallback;
}

/** Resolve the cross-protocol protocolRole string for a caller's role on a remote repo. */
export async function resolveRepoProtocolRole(
  ctx: AgentContext,
  targetDid: string,
  repoContextId: string,
  candidates: readonly RepoRoleName[],
  fallback?: RepoRoleName,
): Promise<string | undefined> {
  const role = await resolveRepoRoleName(ctx, targetDid, repoContextId, candidates, fallback);
  return role ? `repo:repo/${role}` : undefined;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function extractContext(record: any, name: string): RepoContext {
  const contextId = record.contextId;
  if (!contextId) {
    throw new Error('Repository record has no contextId — this should not happen.');
  }

  const visibility = (record.tags?.visibility as 'public' | 'private') ?? 'public';
  return { recordId: record.id ?? record.recordId, contextId, visibility, name };
}

function repoContextCacheKey(targetDid: string, repoName: string): string {
  return `${targetDid}\0${repoName}`;
}
