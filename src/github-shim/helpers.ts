/**
 * Shared helpers for the GitHub API compatibility shim.
 *
 * Provides DID-to-numeric-ID hashing, `from` option building, repo
 * record lookup, GitHub-style owner objects, pagination, and standard
 * response headers.
 *
 * @module
 */

import { createHash } from 'node:crypto';

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

/**
 * Derive a 7-character hex short ID from a DWN record identifier.
 *
 * Uses SHA-256 of the record ID, truncated to the first 7 hex characters.
 * This gives 28 bits of entropy — collision probability reaches 50% at
 * ~16 384 records, which is sufficient for per-repo PR/issue identification.
 *
 * Short IDs replace sequential numbers for PRs and issues, avoiding race
 * conditions from concurrent creation.
 */
export function shortId(recordId: string): string {
  return createHash('sha256').update(recordId).digest('hex').slice(0, 7);
}

/**
 * Find a record by short ID prefix within a list of records.
 *
 * Computes `shortId(record.id)` for each record and returns the first
 * match where the short ID starts with the given prefix. This supports
 * both full 7-char IDs and abbreviated prefixes (like git's short SHA).
 */
export function findByShortId<T extends { id: string }>(
  records: T[],
  prefix: string,
): T | undefined {
  const lower = prefix.toLowerCase();
  return records.find(r => shortId(r.id).startsWith(lower));
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
 * Look up a repo record for a target DID by name.  Returns `null`
 * if no matching repo record exists.
 */
export async function getRepoRecord(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoInfo | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', {
    from,
    filter: { tags: { name: repoName } },
  });
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

// Sequential number helpers (`getNextIssueNumber`, `getNextPatchNumber`)
// have been removed.  PRs and issues are now identified by short hash
// IDs derived from the DWN record ID via `shortId()`.  The GitHub shim
// uses `numericId()` (FNV-1a) to generate stable integers for the API
// `number` field.

/** Convert an ISO date string to GitHub's ISO 8601 format. */
export function toISODate(dateStr: string | undefined): string {
  if (!dateStr) { return new Date(0).toISOString(); }
  // DWN dates may already be ISO 8601; normalize to ensure consistency.
  return new Date(dateStr).toISOString();
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Build a 401 Unauthorized JSON response. */
export function jsonUnauthorized(message: string): JsonResponse {
  return {
    status  : 401,
    headers : baseHeaders(),
    body    : JSON.stringify({ message }),
  };
}

/**
 * Validate a Bearer token from the Authorization header.
 * Returns `true` if the token matches `GITD_API_TOKEN`, or if
 * no token is configured (open access).
 */
export function validateBearerToken(authHeader: string | null): boolean {
  const expected = process.env.GITD_API_TOKEN;
  if (!expected) { return true; } // No token configured — open access.
  if (!authHeader?.startsWith('Bearer ')) { return false; }
  const token = authHeader.slice(7);
  // Constant-time comparison to prevent timing attacks.
  if (token.length !== expected.length) { return false; }
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
