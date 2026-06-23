/**
 * GitHub API shim - user follower endpoints.
 *
 * Maps forge-social `follow` records to GitHub REST API v3 follower
 * responses. Follows live on the follower's DWN, so follower lists expose
 * records readable to the local actor.
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
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
} from './helpers.js';

type FollowEntry = {
  record : any;
  followerDid : string;
  targetDid : string;
  alias? : string;
};

type BlockEntry = {
  record : any;
  blockerDid : string;
  targetDid : string;
};

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

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeDid(value: string): string {
  return decodeRouteParam(value).trim();
}

function normalizeFollowEntry(record: any, fallbackFollowerDid: string): Promise<FollowEntry | null> {
  return record.data.json().then((data: any) => {
    const tags = (record.tags as Record<string, string> | undefined) ?? {};
    const targetDid = tags.targetDid ?? data.targetDid;
    if (typeof targetDid !== 'string' || targetDid === '') { return null; }

    return {
      record,
      followerDid : typeof record.author === 'string' ? record.author : fallbackFollowerDid,
      targetDid,
      alias       : typeof data.alias === 'string' ? data.alias : undefined,
    };
  });
}

function normalizeBlockEntry(record: any, fallbackBlockerDid: string): Promise<BlockEntry | null> {
  return record.data.json().then((data: any) => {
    const tags = (record.tags as Record<string, string> | undefined) ?? {};
    const targetDid = tags.targetDid ?? data.targetDid;
    if (typeof targetDid !== 'string' || targetDid === '') { return null; }

    return {
      record,
      blockerDid: typeof record.author === 'string' ? record.author : fallbackBlockerDid,
      targetDid,
    };
  });
}

async function listFollowingEntries(ctx: AgentContext, userDid: string): Promise<FollowEntry[]> {
  const { records } = await ctx.social.records.query('follow', {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedDescending,
  } as any);

  const entries: FollowEntry[] = [];
  for (const record of records) {
    const entry = await normalizeFollowEntry(record, userDid);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function listBlockedEntries(ctx: AgentContext, blockerDid: string): Promise<BlockEntry[]> {
  const { records } = await ctx.social.records.query('block', {
    from     : fromOpt(ctx, blockerDid),
    dateSort : DateSort.CreatedDescending,
  } as any);

  const entries: BlockEntry[] = [];
  for (const record of records) {
    const entry = await normalizeBlockEntry(record, blockerDid);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function listVisibleFollowerEntries(ctx: AgentContext, targetDid: string): Promise<FollowEntry[]> {
  const { records } = await ctx.social.records.query('follow', {
    filter   : { tags: { targetDid } },
    dateSort : DateSort.CreatedDescending,
  } as any);

  const entries: FollowEntry[] = [];
  for (const record of records) {
    const entry = await normalizeFollowEntry(record, ctx.did);
    if (entry?.targetDid === targetDid) { entries.push(entry); }
  }
  return entries;
}

async function findFollow(ctx: AgentContext, followerDid: string, targetDid: string): Promise<FollowEntry | null> {
  const { records } = await ctx.social.records.query('follow', {
    from   : fromOpt(ctx, followerDid),
    filter : { tags: { targetDid } },
  } as any);
  const record = records[0];
  if (!record) { return null; }
  return normalizeFollowEntry(record, followerDid);
}

async function findBlock(ctx: AgentContext, blockerDid: string, targetDid: string): Promise<BlockEntry | null> {
  const { records } = await ctx.social.records.query('block', {
    from   : fromOpt(ctx, blockerDid),
    filter : { tags: { targetDid } },
  } as any);
  const record = records[0];
  if (!record) { return null; }
  return normalizeBlockEntry(record, blockerDid);
}

function uniqueDids(values: string[]): string[] {
  return [...new Set(values)];
}

function pagedUsers(dids: string[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(dids, pagination);
  const items = paged.map(did => buildUserResponse(did, baseUrl));
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, dids.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/followers and GET /users/:did/followers
// ---------------------------------------------------------------------------

export async function handleListFollowers(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listVisibleFollowerEntries(ctx, userDid);
  const followers = uniqueDids(entries.map(entry => entry.followerDid));
  const path = userDid === ctx.did ? '/user/followers' : `/users/${userDid}/followers`;
  return pagedUsers(followers, url, path);
}

// ---------------------------------------------------------------------------
// GET /user/following and GET /users/:did/following
// ---------------------------------------------------------------------------

export async function handleListFollowing(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listFollowingEntries(ctx, userDid);
  const following = uniqueDids(entries.map(entry => entry.targetDid));
  const path = userDid === ctx.did ? '/user/following' : `/users/${userDid}/following`;
  return pagedUsers(following, url, path);
}

// ---------------------------------------------------------------------------
// GET /user/blocks
// ---------------------------------------------------------------------------

export async function handleListBlockedUsers(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  const entries = await listBlockedEntries(ctx, ctx.did);
  const blocked = uniqueDids(entries.map(entry => entry.targetDid));
  return pagedUsers(blocked, url, '/user/blocks');
}

// ---------------------------------------------------------------------------
// GET /user/following/:did and GET /users/:did/following/:target_did
// ---------------------------------------------------------------------------

export async function handleCheckFollowing(
  ctx: AgentContext, followerDid: string, targetDid: string,
): Promise<JsonResponse> {
  const follow = await findFollow(ctx, followerDid, targetDid);
  if (!follow) {
    return jsonNotFound(`User '${followerDid}' does not follow '${targetDid}'.`);
  }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /user/blocks/:did
// ---------------------------------------------------------------------------

export async function handleCheckBlockedUser(
  ctx: AgentContext, targetDid: string,
): Promise<JsonResponse> {
  const did = routeDid(targetDid);
  if (!did) { return jsonNotFound('User not found.'); }

  const block = await findBlock(ctx, ctx.did, did);
  if (!block) {
    return jsonNotFound(`User '${ctx.did}' has not blocked '${did}'.`);
  }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// PUT /user/following/:did
// ---------------------------------------------------------------------------

export async function handleFollowUser(ctx: AgentContext, targetDid: string): Promise<JsonResponse> {
  if (targetDid === ctx.did) {
    return jsonValidationError('Validation Failed: users cannot follow themselves.');
  }

  const existing = await findFollow(ctx, ctx.did, targetDid);
  if (existing) { return jsonNoContent(); }

  const { status } = await ctx.social.records.create('follow', {
    data : { targetDid },
    tags : { targetDid },
  });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to follow user: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// PUT /user/blocks/:did
// ---------------------------------------------------------------------------

export async function handleBlockUser(ctx: AgentContext, targetDid: string): Promise<JsonResponse> {
  const did = routeDid(targetDid);
  if (!did) { return jsonValidationError('Validation Failed: username is required.'); }
  if (did === ctx.did) {
    return jsonValidationError('Validation Failed: users cannot block themselves.');
  }

  const existing = await findBlock(ctx, ctx.did, did);
  if (existing) { return jsonNoContent(); }

  const { status } = await ctx.social.records.create('block', {
    data : { targetDid: did, blockedAt: new Date().toISOString() },
    tags : { targetDid: did },
  });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to block user: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// DELETE /user/following/:did
// ---------------------------------------------------------------------------

export async function handleUnfollowUser(ctx: AgentContext, targetDid: string): Promise<JsonResponse> {
  const existing = await findFollow(ctx, ctx.did, targetDid);
  if (!existing) { return jsonNoContent(); }

  const { status } = await existing.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unfollow user: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// DELETE /user/blocks/:did
// ---------------------------------------------------------------------------

export async function handleUnblockUser(ctx: AgentContext, targetDid: string): Promise<JsonResponse> {
  const did = routeDid(targetDid);
  if (!did) { return jsonNoContent(); }

  const existing = await findBlock(ctx, ctx.did, did);
  if (!existing) { return jsonNoContent(); }

  const { status } = await existing.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unblock user: ${status.detail}`);
  }

  return jsonNoContent();
}
