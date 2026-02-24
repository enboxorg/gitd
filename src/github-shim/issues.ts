/**
 * GitHub API shim — `/repos/:did/:repo/issues` endpoints.
 *
 * Maps DWN issue records to GitHub REST API v3 issue responses.
 *
 * Endpoints:
 *   GET /repos/:did/:repo/issues              List issues
 *   GET /repos/:did/:repo/issues/:number      Issue detail
 *   GET /repos/:did/:repo/issues/:number/comments  Issue comments
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonNotFound,
  jsonOk,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Issue object builder
// ---------------------------------------------------------------------------

function buildIssueResponse(
  rec: any, data: any, tags: Record<string, string>,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const owner = buildOwner(targetDid, baseUrl);
  const number = parseInt(tags.number ?? data.number ?? '0', 10);
  const state = tags.status === 'closed' ? 'closed' : 'open';

  return {
    id                 : numericId(rec.id ?? ''),
    node_id            : rec.id ?? '',
    url                : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    repository_url     : `${baseUrl}/repos/${targetDid}/${repoName}`,
    comments_url       : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/comments`,
    number,
    title              : data.title ?? '',
    body               : data.body ?? null,
    state,
    locked             : false,
    comments           : 0,
    created_at         : toISODate(rec.dateCreated),
    updated_at         : toISODate(rec.timestamp),
    closed_at          : state === 'closed' ? toISODate(rec.timestamp) : null,
    user               : owner,
    author_association : 'OWNER',
    labels             : [],
    assignees          : [],
    milestone          : null,
    reactions          : { url: '', total_count: 0 },
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues
// ---------------------------------------------------------------------------

export async function handleListIssues(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  // Query params.
  const stateFilter = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  const pagination = parsePagination(url);

  const dateSort = direction === 'asc'
    ? DateSort.CreatedAscending
    : DateSort.CreatedDescending;

  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId },
    dateSort,
  });

  // Filter by state.
  let filtered = records;
  if (stateFilter !== 'all') {
    filtered = records.filter((r) => {
      const t = r.tags as Record<string, string> | undefined;
      const s = t?.status ?? 'open';
      return stateFilter === 'closed' ? s === 'closed' : s === 'open';
    });
  }

  // Paginate.
  const page = paginate(filtered, pagination);

  // Build response.
  const items: Record<string, unknown>[] = [];
  for (const rec of page) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    items.push(buildIssueResponse(rec, data, tags, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number
// ---------------------------------------------------------------------------

export async function handleGetIssue(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Fetch comment count.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    from,
    filter: { contextId: rec.contextId },
  });

  const issue = buildIssueResponse(rec, data, tags, targetDid, repoName, baseUrl);
  issue.comments = comments.length;

  return jsonOk(issue);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number/comments
// ---------------------------------------------------------------------------

export async function handleListIssueComments(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);

  // Find the issue first.
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (issues.length === 0) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const issueRec = issues[0];
  const owner = buildOwner(targetDid, baseUrl);

  // Fetch comments.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const paged = paginate(comments, pagination);

  const items: Record<string, unknown>[] = [];
  for (const comment of paged) {
    const cData = await comment.data.json();
    items.push({
      id                 : numericId(comment.id ?? ''),
      node_id            : comment.id ?? '',
      url                : `${baseUrl}/repos/${targetDid}/${repoName}/issues/comments/${numericId(comment.id ?? '')}`,
      html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}#issuecomment-${numericId(comment.id ?? '')}`,
      issue_url          : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
      body               : cData.body ?? '',
      created_at         : toISODate(comment.dateCreated),
      updated_at         : toISODate(comment.timestamp),
      user               : owner,
      author_association : 'OWNER',
      reactions          : { url: '', total_count: 0 },
    });
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}
