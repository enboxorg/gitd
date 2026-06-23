/**
 * GitHub API shim — repository starring and watching endpoints.
 *
 * Maps forge-social `star` records to GitHub REST API v3 starring
 * responses. Stars live on the actor's DWN, so these handlers expose the
 * authenticated actor's stars plus any readable star records for a user DID.
 *
 * Endpoints:
 *   GET    /repos/:did/:repo/stargazers
 *   GET    /repos/:did/:repo/subscribers
 *   GET    /repos/:did/:repo/subscription
 *   PUT    /repos/:did/:repo/subscription
 *   DELETE /repos/:did/:repo/subscription
 *   GET    /user/starred
 *   GET    /user/starred/:did/:repo
 *   PUT    /user/starred/:did/:repo
 *   DELETE /user/starred/:did/:repo
 *   GET    /user/subscriptions
 *   GET    /users/:did/starred
 *   GET    /users/:did/subscriptions
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { buildRepoResponse } from './repos.js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

type RepoLookup = {
  repo : RepoInfo;
  repoName : string;
  recordId : string;
};

type StarEntry = {
  rec : any;
  data : any;
  tags : Record<string, string>;
  repoDid : string;
  repoRecordId : string;
  repoName : string | undefined;
};

function repoInfoFromRecord(rec: any, data: any, tags: Record<string, unknown>): RepoInfo {
  return {
    name                      : data.name ?? 'unnamed',
    description               : data.description ?? '',
    defaultBranch             : data.defaultBranch ?? 'main',
    homepage                  : data.homepage ?? '',
    contextId                 : rec.contextId ?? '',
    visibility                : typeof tags.visibility === 'string' ? tags.visibility : 'public',
    language                  : typeof tags.language === 'string' ? tags.language : '',
    archived                  : tags.archived === true || tags.archived === 'true',
    hasIssues                 : data.hasIssues !== false,
    hasProjects               : data.hasProjects === true,
    hasWiki                   : data.hasWiki !== false,
    hasDownloads              : data.hasDownloads !== false,
    hasPullRequests           : data.hasPullRequests !== false,
    isTemplate                : data.isTemplate === true,
    allowSquashMerge          : data.allowSquashMerge !== false,
    allowMergeCommit          : data.allowMergeCommit !== false,
    allowRebaseMerge          : data.allowRebaseMerge !== false,
    allowAutoMerge            : data.allowAutoMerge === true,
    allowForking              : data.allowForking !== false,
    deleteBranchOnMerge       : data.deleteBranchOnMerge === true,
    webCommitSignoffRequired  : data.webCommitSignoffRequired === true,
    pullRequestCreationPolicy : data.pullRequestCreationPolicy === 'collaborators_only' ? 'collaborators_only' : 'all',
    dateCreated               : rec.dateCreated,
    timestamp                 : rec.timestamp,
    forkedFromDid             : typeof data.forkedFromDid === 'string' ? data.forkedFromDid : undefined,
    forkedFromRepoName        : typeof data.forkedFromRepoName === 'string' ? data.forkedFromRepoName : undefined,
    forkedFromRecordId        : typeof data.forkedFromRecordId === 'string' ? data.forkedFromRecordId : undefined,
  };
}

async function findRepoByName(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoLookup | JsonResponse> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', {
    from,
    filter: { tags: { name: repoName } },
  });

  const rec = records[0];
  if (!rec) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};
  return {
    repo     : repoInfoFromRecord(rec, data, tags),
    repoName : data.name ?? repoName,
    recordId : rec.id,
  };
}

async function findRepoByRecordId(
  ctx: AgentContext, targetDid: string, recordId: string,
): Promise<RepoLookup | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', { from });
  const rec = records.find(item => item.id === recordId);
  if (!rec) { return null; }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};
  return {
    repo     : repoInfoFromRecord(rec, data, tags),
    repoName : data.name ?? (typeof tags.name === 'string' ? tags.name : 'unnamed'),
    recordId : rec.id,
  };
}

function normalizeStarEntry(rec: any): Promise<StarEntry | null> {
  return rec.data.json().then((data: any) => {
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    const repoDid = tags.repoDid ?? data.repoDid;
    const repoRecordId = tags.repoRecordId ?? data.repoRecordId;
    if (typeof repoDid !== 'string' || typeof repoRecordId !== 'string') {
      return null;
    }

    return {
      rec,
      data,
      tags,
      repoDid,
      repoRecordId,
      repoName: typeof data.repoName === 'string' ? data.repoName : undefined,
    };
  });
}

async function listStarEntries(
  ctx: AgentContext, userDid: string, direction: 'asc' | 'desc' = 'desc',
): Promise<StarEntry[]> {
  const { records } = await ctx.social.records.query('star', {
    from     : fromOpt(ctx, userDid),
    dateSort : direction === 'asc' ? DateSort.CreatedAscending : DateSort.CreatedDescending,
  } as any);

  const entries: StarEntry[] = [];
  for (const rec of records) {
    const entry = await normalizeStarEntry(rec);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function findLocalStar(
  ctx: AgentContext, repoDid: string, repoRecordId: string,
): Promise<any | undefined> {
  const { records } = await ctx.social.records.query('star', {
    filter: { tags: { repoDid, repoRecordId } },
  } as any);
  return records[0];
}

function buildUserResponse(did: string, baseUrl: string): Record<string, unknown> {
  return {
    ...buildOwner(did, baseUrl),
    node_id             : did,
    gravatar_id         : '',
    followers_url       : `${baseUrl}/users/${did}/followers`,
    following_url       : `${baseUrl}/users/${did}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${did}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${did}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${did}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${did}/orgs`,
    repos_url           : `${baseUrl}/users/${did}/repos`,
    events_url          : `${baseUrl}/users/${did}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${did}/received_events`,
    site_admin          : false,
  };
}

async function buildStarredRepoResponse(
  ctx: AgentContext, entry: StarEntry, baseUrl: string,
): Promise<Record<string, unknown> | null> {
  const lookup = await findRepoByRecordId(ctx, entry.repoDid, entry.repoRecordId);
  if (!lookup) { return null; }

  return buildRepoResponse(lookup.repo, entry.repoDid, lookup.repoName, baseUrl);
}

function starAuthorDid(rec: any, fallbackDid: string): string {
  return rec.author ?? fallbackDid;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') { return value; }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') { return true; }
    if (value.toLowerCase() === 'false') { return false; }
  }
  return fallback;
}

function subscriptionState(data: Record<string, unknown>): { ignored: boolean; subscribed: boolean } {
  const ignored = normalizeBool(data.ignored, false);
  const subscribed = normalizeBool(data.subscribed, !ignored);
  return { ignored, subscribed };
}

function buildSubscriptionResponse(
  star: any, data: Record<string, unknown>, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const { ignored, subscribed } = subscriptionState(data);
  return {
    subscribed,
    ignored,
    reason         : null,
    created_at     : toISODate(star?.dateCreated),
    url            : `${baseUrl}/repos/${targetDid}/${repoName}/subscription`,
    repository_url : `${baseUrl}/repos/${targetDid}/${repoName}`,
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/stargazers
// ---------------------------------------------------------------------------

export async function handleListStargazers(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const { records } = await ctx.social.records.query('star', {
    filter   : { tags: { repoDid: targetDid, repoRecordId: lookup.recordId } },
    dateSort : DateSort.CreatedDescending,
  } as any);
  const paged = paginate(records, pagination);
  const items = paged.map(rec => buildUserResponse(starAuthorDid(rec, ctx.did), baseUrl));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/stargazers`,
    pagination.page, pagination.perPage, records.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/subscribers
// ---------------------------------------------------------------------------

export async function handleListSubscribers(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const { records } = await ctx.social.records.query('star', {
    filter   : { tags: { repoDid: targetDid, repoRecordId: lookup.recordId } },
    dateSort : DateSort.CreatedDescending,
  } as any);
  const subscribers = [];
  for (const record of records) {
    const entry = await normalizeStarEntry(record);
    if (!entry) { continue; }
    if (subscriptionState(entry.data).subscribed) { subscribers.push(record); }
  }

  const paged = paginate(subscribers, pagination);
  const items = paged.map(rec => buildUserResponse(starAuthorDid(rec, ctx.did), baseUrl));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/subscribers`,
    pagination.page, pagination.perPage, subscribers.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/starred and GET /users/:did/starred
// ---------------------------------------------------------------------------

export async function handleListStarredRepos(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
  const entries = await listStarEntries(ctx, userDid, direction);

  const repos: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const repo = await buildStarredRepoResponse(ctx, entry, baseUrl);
    if (repo) { repos.push(repo); }
  }

  const pagination = parsePagination(url);
  const paged = paginate(repos, pagination);
  const path = userDid === ctx.did ? '/user/starred' : `/users/${userDid}/starred`;
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, repos.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/subscriptions and GET /users/:did/subscriptions
// ---------------------------------------------------------------------------

export async function handleListSubscriptions(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const entries = await listStarEntries(ctx, userDid);

  const repos: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const { ignored, subscribed } = subscriptionState(entry.data);
    if (!subscribed && !ignored) { continue; }

    const repo = await buildStarredRepoResponse(ctx, entry, baseUrl);
    if (repo) { repos.push(repo); }
  }

  const pagination = parsePagination(url);
  const paged = paginate(repos, pagination);
  const path = userDid === ctx.did ? '/user/subscriptions' : `/users/${userDid}/subscriptions`;
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, repos.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/starred/:did/:repo
// ---------------------------------------------------------------------------

export async function handleCheckStarredRepo(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const star = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (!star) {
    return jsonNotFound(`Repository '${repoName}' is not starred by '${ctx.did}'.`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/subscription
// ---------------------------------------------------------------------------

export async function handleGetRepoSubscription(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const star = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (!star) {
    return jsonNotFound(`Repository '${repoName}' is not watched by '${ctx.did}'.`);
  }

  const entry = await normalizeStarEntry(star);
  if (!entry) {
    return jsonNotFound(`Repository '${repoName}' is not watched by '${ctx.did}'.`);
  }

  return jsonOk(buildSubscriptionResponse(star, entry.data, targetDid, lookup.repoName, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// PUT /user/starred/:did/:repo
// ---------------------------------------------------------------------------

export async function handleStarRepo(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const existing = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (existing) { return jsonNoContent(); }

  const { status } = await ctx.social.records.create('star', {
    data : { repoDid: targetDid, repoRecordId: lookup.recordId, repoName: lookup.repoName },
    tags : { repoDid: targetDid, repoRecordId: lookup.recordId },
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to star repository: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// PUT /repos/:did/:repo/subscription
// ---------------------------------------------------------------------------

export async function handleSetRepoSubscription(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  if (reqBody.subscribed !== undefined && typeof reqBody.subscribed !== 'boolean') {
    return jsonValidationError('Validation Failed: subscribed must be a boolean.');
  }
  if (reqBody.ignored !== undefined && typeof reqBody.ignored !== 'boolean') {
    return jsonValidationError('Validation Failed: ignored must be a boolean.');
  }

  const ignored = reqBody.ignored === true;
  const subscribed = reqBody.subscribed === false ? false : !ignored;
  const existing = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (!subscribed && !ignored) {
    if (existing) {
      const { status } = await existing.delete();
      if (status.code >= 300) {
        return jsonValidationError(`Failed to delete repository subscription: ${status.detail}`);
      }
    }

    return jsonOk(buildSubscriptionResponse(
      { dateCreated: new Date().toISOString() },
      { ignored: false, subscribed: false },
      targetDid,
      lookup.repoName,
      buildApiUrl(url),
    ));
  }

  const data = {
    repoDid      : targetDid,
    repoRecordId : lookup.recordId,
    repoName     : lookup.repoName,
    subscribed,
    ignored,
  };
  const tags = { repoDid: targetDid, repoRecordId: lookup.recordId };

  if (existing) {
    const { status } = await existing.update({ data, tags } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update repository subscription: ${status.detail}`);
    }

    return jsonOk(buildSubscriptionResponse(existing, data, targetDid, lookup.repoName, buildApiUrl(url)));
  }

  const { record, status } = await ctx.social.records.create('star', { data, tags } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to set repository subscription: ${status.detail}`);
  }

  return jsonOk(buildSubscriptionResponse(record, data, targetDid, lookup.repoName, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// DELETE /user/starred/:did/:repo
// ---------------------------------------------------------------------------

export async function handleUnstarRepo(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const star = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (!star) { return jsonNoContent(); }

  const { status } = await star.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unstar repository: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/subscription
// ---------------------------------------------------------------------------

export async function handleDeleteRepoSubscription(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await findRepoByName(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const star = await findLocalStar(ctx, targetDid, lookup.recordId);
  if (!star) { return jsonNoContent(); }

  const { status } = await star.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete repository subscription: ${status.detail}`);
  }

  return jsonNoContent();
}
