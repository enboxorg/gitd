/**
 * GitHub API shim — `/repos/:did/:repo/pulls` endpoints.
 *
 * Maps DWN patch records to GitHub REST API v3 pull request responses.
 *
 * Endpoints:
 *   GET   /repos/:did/:repo/pulls                    List pull requests
 *   GET   /repos/:did/:repo/pulls/:number            Pull request detail
 *   GET   /repos/:did/:repo/pulls/:number/reviews    Pull request reviews
 *   POST  /repos/:did/:repo/pulls                    Create pull request
 *   PATCH /repos/:did/:repo/pulls/:number            Update pull request
 *   PUT   /repos/:did/:repo/pulls/:number/merge      Merge pull request
 *   POST  /repos/:did/:repo/pulls/:number/reviews    Create review
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
  jsonCreated,
  jsonMethodNotAllowed,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
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

async function buildPullResponse(
  ctx: AgentContext, rec: any, data: any, tags: Record<string, string>,
  targetDid: string, repoName: string, baseUrl: string,
  from?: string,
): Promise<Record<string, unknown>> {
  const owner = buildOwner(targetDid, baseUrl);
  const sourceDid = tags.sourceDid;
  const user = sourceDid ? buildOwner(sourceDid, baseUrl) : owner;
  const number = numericId(rec.id ?? '');
  const dwnStatus = tags.status ?? 'open';
  const merged = dwnStatus === 'merged';
  const draft = dwnStatus === 'draft';
  const state = (dwnStatus === 'open' || draft) ? 'open' : 'closed';
  const baseBranch = tags.baseBranch ?? 'main';
  const headBranch = tags.headBranch ?? '';

  // Fetch latest revision to populate commit + diff stats.
  let headSha = '';
  let baseSha = '';
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  const { records: revisions } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from,
    filter   : { contextId: rec.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (revisions.length > 0) {
    const rev = revisions[0];
    const revTags = (rev.tags as Record<string, string> | undefined) ?? {};
    headSha = revTags.headCommit ?? '';
    baseSha = revTags.baseCommit ?? '';
    commits = parseInt(revTags.commitCount ?? '0', 10);

    try {
      const revData = await rev.data.json();
      if (revData.diffStat) {
        additions = revData.diffStat.additions ?? 0;
        deletions = revData.diffStat.deletions ?? 0;
        changedFiles = revData.diffStat.filesChanged ?? 0;
      }
    } catch { /* revision may not have parseable JSON body */ }
  }

  // Fetch merge result to populate merge_commit_sha.
  let mergeCommitSha: string | null = null;
  if (merged) {
    const { records: mergeResults } = await ctx.patches.records.query('repo/patch/mergeResult' as any, {
      from,
      filter: { contextId: rec.contextId },
    });
    if (mergeResults.length > 0) {
      const mrTags = (mergeResults[0].tags as Record<string, string> | undefined) ?? {};
      mergeCommitSha = mrTags.mergeCommit ?? null;
    }
  }

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
    merge_commit_sha    : mergeCommitSha,
    merged_at           : merged ? toISODate(rec.timestamp) : null,
    merged_by           : merged ? owner : null,
    created_at          : toISODate(rec.dateCreated),
    updated_at          : toISODate(rec.timestamp),
    closed_at           : state === 'closed' ? toISODate(rec.timestamp) : null,
    user,
    author_association  : sourceDid && sourceDid !== targetDid ? 'CONTRIBUTOR' : 'OWNER',
    draft,
    head                : {
      label : `${sourceDid ?? targetDid}:${headBranch}`,
      ref   : headBranch,
      sha   : headSha,
    },
    base: {
      label : `${targetDid}:${baseBranch}`,
      ref   : baseBranch,
      sha   : baseSha,
    },
    labels              : [],
    assignees           : [],
    milestone           : null,
    requested_reviewers : [],
    commits,
    additions,
    deletions,
    changed_files       : changedFiles,
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls
// ---------------------------------------------------------------------------

export async function handleListPulls(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
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
    items.push(await buildPullResponse(ctx, rec, data, tags, targetDid, repoName, baseUrl, from));
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
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  return jsonOk(await buildPullResponse(ctx, rec, data, tags, targetDid, repoName, baseUrl, from));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/reviews
// ---------------------------------------------------------------------------

export async function handleListPullReviews(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);

  // Find the patch first.
  const num = parseInt(number, 10);
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });

  const patchRec = patches.find(r => numericId(r.id ?? '') === num);
  if (!patchRec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

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

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls — create pull request
// ---------------------------------------------------------------------------

export async function handleCreatePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const title = reqBody.title as string | undefined;
  if (!title) {
    return jsonValidationError('Validation Failed: title is required.');
  }

  const body = (reqBody.body as string) ?? '';
  const baseBranch = (reqBody.base as string) ?? 'main';
  const headBranch = (reqBody.head as string) ?? '';
  const baseUrl = buildApiUrl(url);

  const tags: Record<string, string> = {
    baseBranch,
    status: 'open',
  };
  if (headBranch) { tags.headBranch = headBranch; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body },
    tags,
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create pull request: ${status.detail}`);
  }

  const recTags = (record.tags as Record<string, string> | undefined) ?? {};
  const data = await record.data.json();
  const pr = await buildPullResponse(ctx, record, data, recTags, targetDid, repoName, baseUrl);

  return jsonCreated(pr);
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/pulls/:number — update pull request
// ---------------------------------------------------------------------------

export async function handleUpdatePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Apply updates.
  const newTitle = (reqBody.title as string | undefined) ?? data.title;
  const newBody = (reqBody.body as string | undefined) ?? data.body;
  const newBase = (reqBody.base as string | undefined) ?? tags.baseBranch;

  // GitHub API uses "state" (open/closed), DWN uses "status" tag.
  let newStatus = tags.status ?? 'open';
  if (reqBody.state === 'closed') { newStatus = 'closed'; }
  if (reqBody.state === 'open') { newStatus = 'open'; }

  const newTags: Record<string, string> = { ...tags, status: newStatus };
  if (newBase) { newTags.baseBranch = newBase; }

  const { status } = await rec.update({
    data : { title: newTitle, body: newBody },
    tags : newTags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update pull request: ${status.detail}`);
  }

  const updatedData = { title: newTitle, body: newBody };
  const pr = await buildPullResponse(ctx, rec, updatedData, newTags, targetDid, repoName, baseUrl);

  return jsonOk(pr);
}

// ---------------------------------------------------------------------------
// PUT /repos/:did/:repo/pulls/:number/merge — merge pull request
// ---------------------------------------------------------------------------

export async function handleMergePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, _url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  if (tags.status === 'merged') {
    return jsonMethodNotAllowed(`Pull request #${number} is already merged.`);
  }

  if (tags.status === 'closed') {
    return jsonMethodNotAllowed(`Pull request #${number} is closed. Reopen it before merging.`);
  }

  // Update the patch status to merged.
  const mergeStrategy = (reqBody.merge_method as string) ?? 'merge';

  const { status } = await rec.update({
    data : data,
    tags : { ...tags, status: 'merged' },
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to merge pull request: ${status.detail}`);
  }

  // Create a merge result record.
  const commitSha = (reqBody.sha as string) ?? 'pending';
  await ctx.patches.records.create('repo/patch/mergeResult' as any, {
    data            : { mergedBy: ctx.did },
    tags            : { mergeCommit: commitSha, strategy: mergeStrategy },
    parentContextId : rec.contextId,
  } as any);

  // Audit trail.
  await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: `Merged via ${mergeStrategy} strategy` },
    parentContextId : rec.contextId,
  } as any);

  // GitHub returns a merge result object.
  return jsonOk({
    sha     : commitSha,
    merged  : true,
    message : `Pull request #${number} merged successfully.`,
  });
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls/:number/reviews — create review
// ---------------------------------------------------------------------------

export async function handleCreatePullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  // Find the patch.
  const num = parseInt(number, 10);
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });

  const patchRec = patches.find(r => numericId(r.id ?? '') === num);
  if (!patchRec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }
  const reviewBody = (reqBody.body as string) ?? '';

  // GitHub API uses "event" field: APPROVE, REQUEST_CHANGES, COMMENT.
  // Map to DWN verdict tags.
  const event = (reqBody.event as string | undefined)?.toUpperCase() ?? 'COMMENT';
  let verdict = 'comment';
  if (event === 'APPROVE') { verdict = 'approve'; }
  if (event === 'REQUEST_CHANGES') { verdict = 'reject'; }

  const { status, record: reviewRec } = await ctx.patches.records.create('repo/patch/review' as any, {
    data            : { body: reviewBody },
    tags            : { verdict },
    parentContextId : patchRec.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create review: ${status.detail}`);
  }

  const owner = buildOwner(targetDid, baseUrl);

  return jsonCreated({
    id                 : numericId(reviewRec.id ?? ''),
    node_id            : reviewRec.id ?? '',
    user               : owner,
    body               : reviewBody,
    state              : VERDICT_MAP[verdict] ?? 'COMMENTED',
    html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}#pullrequestreview-${numericId(reviewRec.id ?? '')}`,
    pull_request_url   : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
    submitted_at       : toISODate(reviewRec.dateCreated),
    commit_id          : '',
    author_association : 'OWNER',
  });
}
