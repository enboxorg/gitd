/**
 * GitHub API shim — `/users/:did` endpoint.
 *
 * Synthesizes a GitHub-style user object from a DID and optional
 * forge-social `profile` metadata.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { ProfileData } from '../social.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  fromOpt,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ProfileEntry = {
  record : any;
  data : ProfileData;
};

type ProfilePatch = Partial<Omit<ProfileData, 'did' | 'createdAt' | 'updatedAt'>>;

type HovercardContext = {
  message : string;
  octicon : string;
};

type HovercardSubject = {
  subjectType?: string;
  subjectId?: string;
};

const HOVERCARD_SUBJECT_TYPES = new Set(['organization', 'repository', 'issue', 'pull_request']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedNullableString(value: unknown): string | null | undefined {
  if (value === null) { return null; }
  return typeof value === 'string' ? value : undefined;
}

function normalizeProfileData(data: unknown, tags?: Record<string, unknown>): ProfileData | null {
  if (!isObject(data)) { return null; }

  const did = typeof tags?.did === 'string' ? tags.did : data.did;
  if (typeof did !== 'string' || did.trim() === '') { return null; }

  return {
    did             : did.trim(),
    name            : storedNullableString(data.name),
    email           : storedNullableString(data.email),
    blog            : typeof data.blog === 'string' ? data.blog : undefined,
    twitterUsername : storedNullableString(data.twitterUsername),
    company         : storedNullableString(data.company),
    location        : storedNullableString(data.location),
    hireable        : typeof data.hireable === 'boolean' || data.hireable === null ? data.hireable : undefined,
    bio             : storedNullableString(data.bio),
    createdAt       : typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedAt       : typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}

async function normalizeProfileEntry(record: any): Promise<ProfileEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeProfileData(await record.data.json(), tags);
  if (!data) { return null; }
  return { record, data };
}

async function getUserProfileEntry(ctx: AgentContext, targetDid: string): Promise<ProfileEntry | null> {
  let records: any[];
  try {
    const result = await ctx.social.records.query('profile' as any, {
      from     : fromOpt(ctx, targetDid),
      filter   : { tags: { did: targetDid } },
      dateSort : DateSort.CreatedDescending,
    } as any);
    records = result.records;
  } catch {
    return null;
  }

  for (const record of records) {
    const entry = await normalizeProfileEntry(record);
    if (entry?.data.did === targetDid) { return entry; }
  }
  return null;
}

function parseNullableString(value: unknown, field: string): string | null | undefined | JsonResponse {
  if (value === undefined) { return undefined; }
  if (value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError(`Validation Failed: ${field} must be a string or null.`);
  }
  return value.trim();
}

function parseEmail(value: unknown): string | null | undefined | JsonResponse {
  const parsed = parseNullableString(value, 'email');
  if (typeof parsed !== 'string' || parsed === '') { return parsed; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed)) {
    return jsonValidationError('Validation Failed: email must be a valid email address.');
  }
  return parsed.toLowerCase();
}

function parseTwitterUsername(value: unknown): string | null | undefined | JsonResponse {
  const parsed = parseNullableString(value, 'twitter_username');
  if (typeof parsed !== 'string' || parsed === '') { return parsed; }
  return parsed.replace(/^@/, '');
}

function parseProfilePatch(body: unknown): ProfilePatch | JsonResponse {
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const next: ProfilePatch = {};
  const name = parseNullableString(body.name, 'name');
  if (typeof name === 'object' && name !== null && 'status' in name) { return name; }
  if (name !== undefined) { next.name = name; }

  const email = parseEmail(body.email);
  if (typeof email === 'object' && email !== null && 'status' in email) { return email; }
  if (email !== undefined) { next.email = email; }

  const blog = parseNullableString(body.blog, 'blog');
  if (typeof blog === 'object' && blog !== null && 'status' in blog) { return blog; }
  if (blog !== undefined) { next.blog = blog ?? ''; }

  const twitterUsername = parseTwitterUsername(body.twitter_username);
  if (typeof twitterUsername === 'object' && twitterUsername !== null && 'status' in twitterUsername) { return twitterUsername; }
  if (twitterUsername !== undefined) { next.twitterUsername = twitterUsername; }

  const company = parseNullableString(body.company, 'company');
  if (typeof company === 'object' && company !== null && 'status' in company) { return company; }
  if (company !== undefined) { next.company = company; }

  const location = parseNullableString(body.location, 'location');
  if (typeof location === 'object' && location !== null && 'status' in location) { return location; }
  if (location !== undefined) { next.location = location; }

  if (body.hireable !== undefined) {
    if (body.hireable !== null && typeof body.hireable !== 'boolean') {
      return jsonValidationError('Validation Failed: hireable must be a boolean or null.');
    }
    next.hireable = body.hireable;
  }

  const bio = parseNullableString(body.bio, 'bio');
  if (typeof bio === 'object' && bio !== null && 'status' in bio) { return bio; }
  if (bio !== undefined) { next.bio = bio; }

  return next;
}

export function buildUserProfile(
  targetDid: string,
  baseUrl: string,
  privateFields: Record<string, unknown> = {},
  profile?: ProfileData | null,
): Record<string, unknown> {
  const id = numericId(targetDid);

  return {
    login            : targetDid,
    id,
    node_id          : targetDid,
    avatar_url       : '',
    gravatar_id      : '',
    url              : `${baseUrl}/users/${targetDid}`,
    html_url         : `${baseUrl}/users/${targetDid}`,
    repos_url        : `${baseUrl}/users/${targetDid}/repos`,
    type             : 'User',
    site_admin       : false,
    name             : profile?.name ?? null,
    company          : profile?.company ?? null,
    blog             : profile?.blog ?? '',
    location         : profile?.location ?? null,
    email            : profile?.email ?? null,
    hireable         : profile?.hireable ?? null,
    bio              : profile?.bio ?? null,
    twitter_username : profile?.twitterUsername ?? null,
    public_repos     : 0,
    public_gists     : 0,
    followers        : 0,
    following        : 0,
    created_at       : toISODate(profile?.createdAt),
    updated_at       : toISODate(profile?.updatedAt ?? profile?.createdAt),
    ...privateFields,
  };
}

async function countLocalRepos(ctx: AgentContext): Promise<{ publicRepos: number; privateRepos: number }> {
  const { records } = await ctx.repo.records.query('repo');
  let publicRepos = 0;
  let privateRepos = 0;
  for (const record of records) {
    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    if (tags.visibility === 'private') {
      privateRepos++;
    } else {
      publicRepos++;
    }
  }
  return { publicRepos, privateRepos };
}

async function didFromRecord(record: any, dataField: string, tagField: string = dataField): Promise<string | undefined> {
  const tags = (record.tags as Record<string, string> | undefined) ?? {};
  try {
    const data = await record.data.json();
    const did = typeof data[dataField] === 'string' ? data[dataField] : tags[tagField];
    return did || undefined;
  } catch {
    return tags[tagField] || undefined;
  }
}

export async function collectVisibleUserDids(ctx: AgentContext): Promise<string[]> {
  const dids = new Set<string>([ctx.did]);

  const { records: repos } = await ctx.repo.records.query('repo', {
    dateSort: DateSort.CreatedAscending,
  } as any);
  for (const repo of repos) {
    for (const type of ['repo/maintainer', 'repo/contributor', 'repo/triager', 'repo/viewer']) {
      const { records } = await ctx.repo.records.query(type as any, {
        filter: { contextId: repo.contextId ?? '' },
      } as any);
      for (const record of records) {
        const did = await didFromRecord(record, 'did');
        if (did) { dids.add(did); }
      }
    }
  }

  const { records: orgs } = await ctx.org.records.query('org', {
    dateSort: DateSort.CreatedAscending,
  } as any);
  for (const org of orgs) {
    for (const type of ['org/owner', 'org/member']) {
      const { records } = await ctx.org.records.query(type as any, {
        filter: { contextId: org.contextId ?? '' },
      } as any);
      for (const record of records) {
        const did = await didFromRecord(record, 'did');
        if (did) { dids.add(did); }
      }
    }

    const { records: teams } = await ctx.org.records.query('org/team' as any, {
      filter: { contextId: org.contextId ?? '' },
    } as any);
    for (const team of teams) {
      const { records } = await ctx.org.records.query('org/team/teamMember' as any, {
        filter: { contextId: team.contextId ?? '' },
      } as any);
      for (const record of records) {
        const did = await didFromRecord(record, 'did');
        if (did) { dids.add(did); }
      }
    }
  }

  const { records: follows } = await ctx.social.records.query('follow', {
    dateSort: DateSort.CreatedAscending,
  } as any);
  for (const record of follows) {
    const did = await didFromRecord(record, 'targetDid');
    if (did) { dids.add(did); }
  }

  return [...dids].sort((a, b) => a.localeCompare(b));
}

async function buildAuthenticatedUserProfile(ctx: AgentContext, url: URL, profile?: ProfileData | null): Promise<Record<string, unknown>> {
  const baseUrl = buildApiUrl(url);
  const { publicRepos, privateRepos } = await countLocalRepos(ctx);
  return buildUserProfile(ctx.did, baseUrl, {
    public_repos              : publicRepos,
    private_gists             : 0,
    total_private_repos       : privateRepos,
    owned_private_repos       : privateRepos,
    disk_usage                : 0,
    collaborators             : 0,
    two_factor_authentication : false,
    plan                      : {
      name          : 'DWN',
      space         : 0,
      private_repos : privateRepos,
      collaborators : 0,
    },
  }, profile);
}

function parseSince(url: URL): number {
  const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
  return Number.isFinite(since) && since > 0 ? since : 0;
}

function parsePerPage(url: URL): number {
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  return Math.min(100, Math.max(1, Number.isFinite(perPage) ? perPage : 30));
}

function buildSinceLinkHeader(baseUrl: string, since: number, perPage: number): string {
  const nextUrl = new URL(`${baseUrl}/users`);
  nextUrl.searchParams.set('since', String(since));
  nextUrl.searchParams.set('per_page', String(perPage));
  return `<${nextUrl.toString()}>; rel="next"`;
}

async function getVisibleUserByNumericId(ctx: AgentContext, accountId: string): Promise<string | null> {
  const id = Number.parseInt(accountId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) { return null; }
  const dids = await collectVisibleUserDids(ctx);
  return dids.find(did => numericId(did) === id) ?? null;
}

async function isVisibleUser(ctx: AgentContext, targetDid: string): Promise<boolean> {
  if (targetDid === ctx.did) { return true; }
  return (await collectVisibleUserDids(ctx)).includes(targetDid);
}

function parseHovercardSubject(url: URL): JsonResponse | HovercardSubject {
  const subjectType = url.searchParams.get('subject_type') ?? undefined;
  const subjectId = url.searchParams.get('subject_id') ?? undefined;

  if (subjectType && !HOVERCARD_SUBJECT_TYPES.has(subjectType)) {
    return jsonValidationError('Validation Failed: subject_type must be one of organization, repository, issue, pull_request.');
  }
  if (subjectType && !subjectId) {
    return jsonValidationError('Validation Failed: subject_id is required when subject_type is provided.');
  }
  if (subjectId && !subjectType) {
    return jsonValidationError('Validation Failed: subject_type is required when subject_id is provided.');
  }

  return { subjectType, subjectId };
}

function uniqueHovercardContexts(contexts: HovercardContext[]): HovercardContext[] {
  const seen = new Set<string>();
  return contexts.filter(context => {
    const key = `${context.octicon}:${context.message}`;
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

async function buildHovercardContexts(
  ctx: AgentContext, targetDid: string, subject: HovercardSubject,
): Promise<HovercardContext[]> {
  const contexts: HovercardContext[] = [{
    message : targetDid === ctx.did ? 'Authenticated user' : 'Visible decentralized identity',
    octicon : 'person',
  }];

  if (targetDid === ctx.did) {
    const { publicRepos, privateRepos } = await countLocalRepos(ctx);
    if (publicRepos + privateRepos > 0) {
      contexts.push({
        message : 'Owns repositories visible to this forge',
        octicon : 'repo',
      });
    }
  }

  if (subject.subjectType === 'repository') {
    contexts.push({
      message : targetDid === ctx.did ? 'Owns this repository' : 'Visible through this repository',
      octicon : 'repo',
    });
  } else if (subject.subjectType === 'organization') {
    contexts.push({ message: 'Visible through this organization', octicon: 'organization' });
  } else if (subject.subjectType === 'issue') {
    contexts.push({ message: 'Visible through this issue', octicon: 'issue-opened' });
  } else if (subject.subjectType === 'pull_request') {
    contexts.push({ message: 'Visible through this pull request', octicon: 'git-pull-request' });
  }

  return uniqueHovercardContexts(contexts);
}

// ---------------------------------------------------------------------------
// GET /user, PATCH /user, GET /user/:account_id, GET /users, GET /users/:did,
// and GET /users/:did/hovercard
// ---------------------------------------------------------------------------

export async function handleGetAuthenticatedUser(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  const profile = await getUserProfileEntry(ctx, ctx.did);
  return jsonOk(await buildAuthenticatedUserProfile(ctx, url, profile?.data));
}

export async function handleUpdateAuthenticatedUser(
  ctx: AgentContext, url: URL, body: unknown,
): Promise<JsonResponse> {
  const parsed = parseProfilePatch(body);
  if ('status' in parsed) { return parsed; }

  const existing = await getUserProfileEntry(ctx, ctx.did);
  const now = new Date().toISOString();
  const nextData: ProfileData = {
    ...(existing?.data ?? { did: ctx.did, createdAt: now }),
    ...parsed,
    did       : ctx.did,
    createdAt : existing?.data.createdAt ?? now,
    updatedAt : now,
  };

  if (existing) {
    const { status } = await existing.record.update({
      data : nextData,
      tags : { did: ctx.did },
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update user profile: ${status.detail}`);
    }
  } else {
    const { status } = await ctx.social.records.create('profile' as any, {
      data : nextData,
      tags : { did: ctx.did },
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update user profile: ${status.detail}`);
    }
  }

  return jsonOk(await buildAuthenticatedUserProfile(ctx, url, nextData));
}

export async function handleListUsers(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const since = parseSince(url);
  const perPage = parsePerPage(url);
  const entries = (await collectVisibleUserDids(ctx))
    .map(did => ({ did, id: numericId(did) }))
    .sort((left, right) => left.id - right.id)
    .filter(entry => entry.id > since);
  const page = entries.slice(0, perPage);

  const users: Record<string, unknown>[] = [];
  for (const entry of page) {
    const profile = await getUserProfileEntry(ctx, entry.did);
    users.push(buildUserProfile(entry.did, baseUrl, {}, profile?.data));
  }

  const headers: Record<string, string> = {};
  if (entries.length > perPage && page.length > 0) {
    headers.Link = buildSinceLinkHeader(baseUrl, page[page.length - 1].id, perPage);
  }

  return jsonOk(users, headers);
}

export async function handleGetUserById(
  ctx: AgentContext, accountId: string, url: URL,
): Promise<JsonResponse> {
  const did = await getVisibleUserByNumericId(ctx, accountId);
  if (!did) { return jsonNotFound('User not found'); }
  const profile = await getUserProfileEntry(ctx, did);
  return jsonOk(buildUserProfile(did, buildApiUrl(url), {}, profile?.data));
}

/**
 * Handle `GET /users/:did`.
 *
 * Returns a GitHub-style user profile JSON response.
 */
export async function handleGetUser(
  ctx: AgentContext, targetDid: string, url: URL,
): Promise<JsonResponse> {
  const profile = await getUserProfileEntry(ctx, targetDid);
  return jsonOk(buildUserProfile(targetDid, buildApiUrl(url), {}, profile?.data));
}

export async function handleGetUserHovercard(
  ctx: AgentContext, targetDid: string, url: URL,
): Promise<JsonResponse> {
  const subject = parseHovercardSubject(url);
  if ('status' in subject) { return subject; }

  if (!(await isVisibleUser(ctx, targetDid))) {
    return jsonNotFound('User not found');
  }

  return jsonOk({ contexts: await buildHovercardContexts(ctx, targetDid, subject) });
}
