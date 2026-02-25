/**
 * GitHub API shim — `/repos/:did/:repo/issues` endpoints.
 *
 * Maps DWN issue records to GitHub REST API v3 issue responses.
 *
 * Endpoints:
 *   GET  /repos/:did/:repo/issues                    List issues
 *   GET  /repos/:did/:repo/issues/:number            Issue detail
 *   GET  /repos/:did/:repo/issues/:number/comments   Issue comments
 *   POST /repos/:did/:repo/issues                    Create issue
 *   PATCH /repos/:did/:repo/issues/:number           Update issue
 *   POST /repos/:did/:repo/issues/:number/comments   Create comment
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
  getNextIssueNumber,
  getRepoRecord,
  jsonCreated,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
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

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/issues — create issue
// ---------------------------------------------------------------------------

export async function handleCreateIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const title = reqBody.title as string | undefined;
  if (!title) {
    return jsonValidationError('Validation Failed: title is required.');
  }

  const body = (reqBody.body as string) ?? '';
  const baseUrl = buildApiUrl(url);
  const number = await getNextIssueNumber(ctx, repo.contextId);

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body, number },
    tags            : { status: 'open', number: String(number) },
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create issue: ${status.detail}`);
  }

  const tags = (record.tags as Record<string, string> | undefined) ?? {};
  const data = await record.data.json();
  const issue = buildIssueResponse(record, data, tags, targetDid, repoName, baseUrl);

  return jsonCreated(issue);
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/issues/:number — update issue
// ---------------------------------------------------------------------------

export async function handleUpdateIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Apply updates.
  const newTitle = (reqBody.title as string | undefined) ?? data.title;
  const newBody = (reqBody.body as string | undefined) ?? data.body;

  // GitHub API uses "state" (open/closed), DWN uses "status" tag.
  let newStatus = tags.status ?? 'open';
  if (reqBody.state === 'closed') { newStatus = 'closed'; }
  if (reqBody.state === 'open') { newStatus = 'open'; }

  const { status } = await rec.update({
    data : { title: newTitle, body: newBody, number: data.number },
    tags : { ...tags, status: newStatus },
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update issue: ${status.detail}`);
  }

  const updatedTags = { ...tags, status: newStatus };
  const updatedData = { title: newTitle, body: newBody, number: data.number };
  const issue = buildIssueResponse(rec, updatedData, updatedTags, targetDid, repoName, baseUrl);

  return jsonOk(issue);
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/issues/:number/comments — create comment
// ---------------------------------------------------------------------------

export async function handleCreateIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const baseUrl = buildApiUrl(url);

  // Find the issue.
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (issues.length === 0) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const issueRec = issues[0];

  const { status, record: commentRec } = await ctx.issues.records.create('repo/issue/comment' as any, {
    data            : { body },
    parentContextId : issueRec.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create comment: ${status.detail}`);
  }

  const owner = buildOwner(targetDid, baseUrl);

  return jsonCreated({
    id                 : numericId(commentRec.id ?? ''),
    node_id            : commentRec.id ?? '',
    url                : `${baseUrl}/repos/${targetDid}/${repoName}/issues/comments/${numericId(commentRec.id ?? '')}`,
    html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}#issuecomment-${numericId(commentRec.id ?? '')}`,
    issue_url          : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    body,
    created_at         : toISODate(commentRec.dateCreated),
    updated_at         : toISODate(commentRec.dateCreated),
    user               : owner,
    author_association : 'OWNER',
    reactions          : { url: '', total_count: 0 },
  });
}
