/**
 * GitHub API shim — `/repos/:did/:repo/pulls` endpoints.
 *
 * Maps DWN patch records to GitHub REST API v3 pull request responses.
 *
 * Endpoints:
 *   GET /repos/:did/:repo/pulls               List pull requests
 *   GET /repos/:did/:repo/pulls/:number       Pull request detail
 *   GET /repos/:did/:repo/pulls/:number/reviews  Pull request reviews
 *
 * Status mapping:
 *   - `open`   -> state: "open"
 *   - `closed` -> state: "closed", merged: false
 *   - `merged` -> state: "closed", merged: true
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
// Verdict -> GitHub review state mapping
// ---------------------------------------------------------------------------

const VERDICT_MAP: Record<string, string> = {
  approve : 'APPROVED',
  reject  : 'CHANGES_REQUESTED',
  comment : 'COMMENTED',
};

// ---------------------------------------------------------------------------
// Pull request object builder
// ---------------------------------------------------------------------------

function buildPullResponse(
  rec: any, data: any, tags: Record<string, string>,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const owner = buildOwner(targetDid, baseUrl);
  const number = parseInt(tags.number ?? data.number ?? '0', 10);
  const dwnStatus = tags.status ?? 'open';
  const merged = dwnStatus === 'merged';
  const state = dwnStatus === 'open' ? 'open' : 'closed';
  const baseBranch = tags.baseBranch ?? 'main';
  const headBranch = tags.headBranch ?? '';

  return {
    id                  : numericId(rec.id ?? ''),
    node_id             : rec.id ?? '',
    url                 : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
    html_url            : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
    diff_url            : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}.diff`,
    patch_url           : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}.patch`,
    issue_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    commits_url         : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}/commits`,
    review_comments_url : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}/comments`,
    comments_url        : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/comments`,
    number,
    title               : data.title ?? '',
    body                : data.body ?? null,
    state,
    locked              : false,
    merged,
    mergeable           : state === 'open' ? true : null,
    merge_commit_sha    : merged ? '0000000000000000000000000000000000000000' : null,
    merged_at           : merged ? toISODate(rec.timestamp) : null,
    merged_by           : merged ? owner : null,
    created_at          : toISODate(rec.dateCreated),
    updated_at          : toISODate(rec.timestamp),
    closed_at           : state === 'closed' ? toISODate(rec.timestamp) : null,
    user                : owner,
    author_association  : 'OWNER',
    draft               : false,
    head                : {
      label : `${targetDid}:${headBranch}`,
      ref   : headBranch,
      sha   : '',
    },
    base: {
      label : `${targetDid}:${baseBranch}`,
      ref   : baseBranch,
      sha   : '',
    },
    labels              : [],
    assignees           : [],
    milestone           : null,
    requested_reviewers : [],
    commits             : 0,
    additions           : 0,
    deletions           : 0,
    changed_files       : 0,
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls
// ---------------------------------------------------------------------------

export async function handleListPulls(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const stateFilter = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  const pagination = parsePagination(url);

  const dateSort = direction === 'asc'
    ? DateSort.CreatedAscending
    : DateSort.CreatedDescending;

  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
    dateSort,
  });

  // Filter by state — GitHub treats `closed` as "closed or merged".
  let filtered = records;
  if (stateFilter !== 'all') {
    filtered = records.filter((r) => {
      const t = r.tags as Record<string, string> | undefined;
      const s = t?.status ?? 'open';
      if (stateFilter === 'open') { return s === 'open'; }
      // 'closed' includes both closed and merged.
      return s === 'closed' || s === 'merged';
    });
  }

  const page = paginate(filtered, pagination);

  const items: Record<string, unknown>[] = [];
  for (const rec of page) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    items.push(buildPullResponse(rec, data, tags, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number
// ---------------------------------------------------------------------------

export async function handleGetPull(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  return jsonOk(buildPullResponse(rec, data, tags, targetDid, repoName, baseUrl));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/reviews
// ---------------------------------------------------------------------------

export async function handleListPullReviews(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);

  // Find the patch first.
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (patches.length === 0) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const patchRec = patches[0];
  const owner = buildOwner(targetDid, baseUrl);

  // Fetch reviews.
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    from,
    filter   : { contextId: patchRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const paged = paginate(reviews, pagination);

  const items: Record<string, unknown>[] = [];
  for (const review of paged) {
    const rData = await review.data.json();
    const rTags = (review.tags as Record<string, string> | undefined) ?? {};
    const verdict = rTags.verdict ?? 'comment';

    items.push({
      id                 : numericId(review.id ?? ''),
      node_id            : review.id ?? '',
      user               : owner,
      body               : rData.body ?? '',
      state              : VERDICT_MAP[verdict] ?? 'COMMENTED',
      html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}#pullrequestreview-${numericId(review.id ?? '')}`,
      pull_request_url   : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
      submitted_at       : toISODate(review.dateCreated),
      commit_id          : '',
      author_association : 'OWNER',
    });
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/${number}/reviews`,
    pagination.page, pagination.perPage, reviews.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}
