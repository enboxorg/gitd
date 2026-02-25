/**
 * Shared helpers for the GitHub API compatibility shim.
 *
 * Provides DID-to-numeric-ID hashing, `from` option building, repo
 * record lookup, GitHub-style owner objects, pagination, and standard
 * response headers.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** GitHub-style owner sub-object synthesized from a DID. */
export type GitHubOwner = {
  login : string;
  id : number;
  type : string;
  avatar_url : string;
  html_url : string;
  url : string;
};

/** Repo metadata extracted from a DWN repo record. */
export type RepoInfo = {
  name : string;
  description : string;
  defaultBranch : string;
  contextId : string;
  visibility : string;
  dateCreated : string;
  timestamp : string;
};

/** Pagination parameters parsed from query string. */
export type PaginationParams = {
  page : number;
  perPage : number;
};

/** Standard JSON API response shape. */
export type JsonResponse = {
  status : number;
  headers : Record<string, string>;
  body : string;
};

// ---------------------------------------------------------------------------
// Numeric ID from DWN identifiers
// ---------------------------------------------------------------------------

/**
 * Deterministic numeric ID from a DWN string identifier.
 *
 * Uses a simple FNV-1a-inspired hash to produce a positive 32-bit
 * integer — sufficient for GitHub API compatibility where consumers
 * expect numeric IDs.
 */
export function numericId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0); // ensure unsigned 32-bit
}

// ---------------------------------------------------------------------------
// DWN query helpers
// ---------------------------------------------------------------------------

/**
 * Build the `from` option for a DWN query.  When the target is the
 * local agent's own DID we omit `from`; otherwise set it so the SDK
 * routes the message to the remote DWN.
 */
export function fromOpt(ctx: AgentContext, targetDid: string): string | undefined {
  return targetDid === ctx.did ? undefined : targetDid;
}

/**
 * Look up the singleton repo record for a target DID.  Returns `null`
 * if no repo record exists.
 */
export async function getRepoRecord(ctx: AgentContext, targetDid: string): Promise<RepoInfo | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', { from });
  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, string> | undefined;

  return {
    name          : data.name ?? 'unnamed',
    description   : data.description ?? '',
    defaultBranch : data.defaultBranch ?? 'main',
    contextId     : rec.contextId ?? '',
    visibility    : tags?.visibility ?? 'public',
    dateCreated   : rec.dateCreated,
    timestamp     : rec.timestamp,
  };
}

// ---------------------------------------------------------------------------
// GitHub-style owner object
// ---------------------------------------------------------------------------

/**
 * Build a GitHub-style owner sub-object from a DID.  The DID itself is
 * used as the `login` field since DIDs are globally unique identifiers
 * (just like GitHub usernames).
 */
export function buildOwner(did: string, baseUrl: string): GitHubOwner {
  return {
    login      : did,
    id         : numericId(did),
    type       : 'User',
    avatar_url : '',
    html_url   : `${baseUrl}/users/${did}`,
    url        : `${baseUrl}/users/${did}`,
  };
}

/**
 * Build the base API URL from request context.  Defaults to
 * `http://localhost:<port>` for local development.
 */
export function buildApiUrl(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Parse `page` and `per_page` from the URL query string. */
export function parsePagination(url: URL): PaginationParams {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10)));
  return { page, perPage };
}

/** Apply pagination to an array and return the slice. */
export function paginate<T>(items: T[], params: PaginationParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

/** Build Link header value for pagination. */
export function buildLinkHeader(baseUrl: string, path: string, page: number, perPage: number, totalItems: number): string | null {
  const lastPage = Math.max(1, Math.ceil(totalItems / perPage));
  if (lastPage <= 1) { return null; }

  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${baseUrl}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    links.push(`<${baseUrl}${path}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${baseUrl}${path}?page=1&per_page=${perPage}>; rel="first"`);
    links.push(`<${baseUrl}${path}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  }

  return links.length > 0 ? links.join(', ') : null;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/** Standard headers for all GitHub API shim responses. */
export function baseHeaders(): Record<string, string> {
  return {
    'Content-Type'                 : 'application/json; charset=utf-8',
    'X-GitHub-Media-Type'          : 'github.v3',
    'Access-Control-Allow-Origin'  : '*',
    'Access-Control-Allow-Headers' : 'Authorization, Accept, Content-Type',
    'X-RateLimit-Limit'            : '5000',
    'X-RateLimit-Remaining'        : '4999',
    'X-RateLimit-Reset'            : String(Math.floor(Date.now() / 1000) + 3600),
  };
}

/** Build a successful JSON response. */
export function jsonOk(data: unknown, extraHeaders?: Record<string, string>): JsonResponse {
  return {
    status  : 200,
    headers : { ...baseHeaders(), ...extraHeaders },
    body    : JSON.stringify(data),
  };
}

/** Build a 404 JSON response. */
export function jsonNotFound(message: string): JsonResponse {
  return {
    status  : 404,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest' }),
  };
}

/** Build a 201 Created JSON response. */
export function jsonCreated(data: unknown, extraHeaders?: Record<string, string>): JsonResponse {
  return {
    status  : 201,
    headers : { ...baseHeaders(), ...extraHeaders },
    body    : JSON.stringify(data),
  };
}

/** Build a 422 JSON response (validation error). */
export function jsonValidationError(message: string): JsonResponse {
  return {
    status  : 422,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest' }),
  };
}

/** Build a 405 Method Not Allowed JSON response. */
export function jsonMethodNotAllowed(message: string): JsonResponse {
  return {
    status  : 405,
    headers : baseHeaders(),
    body    : JSON.stringify({ message }),
  };
}

// ---------------------------------------------------------------------------
// Sequential numbering
// ---------------------------------------------------------------------------

/**
 * Get the next sequential issue number.
 * Returns `max(existing numbers) + 1`, or 1 if no issues exist.
 */
export async function getNextIssueNumber(ctx: AgentContext, repoContextId: string): Promise<number> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repoContextId },
  });

  let maxNumber = 0;
  for (const rec of records) {
    const recTags = rec.tags as Record<string, string> | undefined;
    const num = parseInt(recTags?.number ?? '0', 10);
    if (num > maxNumber) { maxNumber = num; }
  }

  return maxNumber + 1;
}

/**
 * Get the next sequential patch number.
 */
export async function getNextPatchNumber(ctx: AgentContext, repoContextId: string): Promise<number> {
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repoContextId },
  });

  let maxNumber = 0;
  for (const rec of records) {
    const recTags = rec.tags as Record<string, string> | undefined;
    const num = parseInt(recTags?.number ?? '0', 10);
    if (num > maxNumber) { maxNumber = num; }
  }

  return maxNumber + 1;
}

/** Convert an ISO date string to GitHub's ISO 8601 format. */
export function toISODate(dateStr: string | undefined): string {
  if (!dateStr) { return new Date(0).toISOString(); }
  // DWN dates may already be ISO 8601; normalize to ensure consistency.
  return new Date(dateStr).toISOString();
}
