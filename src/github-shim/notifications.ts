/**
 * GitHub API shim - notification endpoints.
 *
 * Maps private forge-notifications inbox records to GitHub REST API v3
 * notification thread responses.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { buildRepoResponse } from './repos.js';

import {
  baseHeaders,
  buildApiUrl,
  buildLinkHeader,
  fromOpt,
  getRepoRecord,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

type NotificationData = {
  title : string;
  body? : string;
  url? : string;
};

type NotificationTags = Record<string, unknown> & {
  type? : string;
  read? : boolean | string;
  repoDid? : string;
  repoRecordId? : string;
  repoName? : string;
  sourceRecordId? : string;
  reason? : string;
  subjectType? : string;
  lastReadAt? : string;
  ignored? : boolean | string;
  subscribed? : boolean | string;
  participating? : boolean | string;
};

type NotificationEntry = {
  record : any;
  data : NotificationData;
  tags : NotificationTags;
};

type RepoLookup = {
  repo : RepoInfo;
  repoName : string;
  repoDid : string;
};

function jsonResetContent(): JsonResponse {
  return {
    status  : 205,
    headers : baseHeaders(),
    body    : '',
  };
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') { return value; }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') { return true; }
    if (value.toLowerCase() === 'false') { return false; }
  }
  return fallback;
}

function parseBoolQuery(url: URL, name: string, fallback: boolean): boolean {
  const value = url.searchParams.get(name);
  if (value === null) { return fallback; }
  return value === 'true' || value === '1';
}

function parseDate(value: string | null, fieldName: string): Date | JsonResponse | null {
  if (!value) { return null; }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be an ISO 8601 timestamp.`);
  }
  return date;
}

function notificationThreadId(record: any): string {
  return String(numericId(record.id ?? ''));
}

function notificationType(entry: NotificationEntry): string {
  return typeof entry.tags.type === 'string' ? entry.tags.type : 'mention';
}

function notificationIsRead(entry: NotificationEntry): boolean {
  return normalizeBool(entry.tags.read, false);
}

function notificationUpdatedAt(entry: NotificationEntry): string {
  return toISODate(entry.record.timestamp ?? entry.record.dateCreated);
}

function notificationReason(entry: NotificationEntry): string {
  if (typeof entry.tags.reason === 'string' && entry.tags.reason) {
    return entry.tags.reason;
  }

  switch (notificationType(entry)) {
    case 'assignment': return 'assign';
    case 'ci_failure': return 'ci_activity';
    case 'issue_comment': return 'comment';
    case 'mention': return 'mention';
    case 'patch_merged': return 'state_change';
    case 'review': return 'comment';
    case 'review_request': return 'review_requested';
    default: return 'subscribed';
  }
}

function notificationSubjectType(entry: NotificationEntry): string {
  if (typeof entry.tags.subjectType === 'string' && entry.tags.subjectType) {
    return entry.tags.subjectType;
  }

  switch (notificationType(entry)) {
    case 'assignment':
    case 'issue_comment':
      return 'Issue';
    case 'ci_failure':
      return 'CheckSuite';
    case 'patch_merged':
    case 'review':
    case 'review_request':
      return 'PullRequest';
    default:
      return 'Repository';
  }
}

function normalizeNotificationData(value: Record<string, unknown>): NotificationData {
  return {
    title : typeof value.title === 'string' ? value.title : '',
    body  : typeof value.body === 'string' ? value.body : undefined,
    url   : typeof value.url === 'string' ? value.url : undefined,
  };
}

async function listNotificationEntries(ctx: AgentContext): Promise<NotificationEntry[]> {
  const { records } = await ctx.notifications.records.query('notification', {
    dateSort: DateSort.CreatedDescending,
  });

  const entries: NotificationEntry[] = [];
  for (const record of records) {
    const data = normalizeNotificationData(await record.data.json());
    const tags = (record.tags as NotificationTags | undefined) ?? {};
    entries.push({ record, data, tags });
  }

  entries.sort((a, b) => notificationUpdatedAt(b).localeCompare(notificationUpdatedAt(a)));
  return entries;
}

async function findNotificationEntry(ctx: AgentContext, threadId: string): Promise<NotificationEntry | null> {
  const entries = await listNotificationEntries(ctx);
  return entries.find(entry => notificationThreadId(entry.record) === threadId) ?? null;
}

function repoInfoFromRecord(record: any, data: Record<string, unknown>, tags: Record<string, unknown>): RepoInfo {
  return {
    name                      : typeof data.name === 'string' ? data.name : 'unnamed',
    description               : typeof data.description === 'string' ? data.description : '',
    defaultBranch             : typeof data.defaultBranch === 'string' ? data.defaultBranch : 'main',
    homepage                  : typeof data.homepage === 'string' ? data.homepage : '',
    contextId                 : record.contextId ?? '',
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
    dateCreated               : record.dateCreated,
    timestamp                 : record.timestamp,
    forkedFromDid             : typeof data.forkedFromDid === 'string' ? data.forkedFromDid : undefined,
    forkedFromRepoName        : typeof data.forkedFromRepoName === 'string' ? data.forkedFromRepoName : undefined,
    forkedFromRecordId        : typeof data.forkedFromRecordId === 'string' ? data.forkedFromRecordId : undefined,
  };
}

async function findRepoByRecordId(
  ctx: AgentContext, repoDid: string, repoRecordId: string,
): Promise<RepoLookup | null> {
  const { records } = await ctx.repo.records.query('repo', { from: fromOpt(ctx, repoDid) });
  const record = records.find(item => item.id === repoRecordId);
  if (!record) { return null; }

  const data = await record.data.json();
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const repo = repoInfoFromRecord(record, data, tags);
  return { repo, repoName: repo.name, repoDid };
}

function fallbackRepoLookup(entry: NotificationEntry, ctx: AgentContext): RepoLookup {
  const repoDid = typeof entry.tags.repoDid === 'string' ? entry.tags.repoDid : ctx.did;
  const repoName = typeof entry.tags.repoName === 'string' ? entry.tags.repoName : 'unknown';
  const timestamp = notificationUpdatedAt(entry);
  return {
    repoDid,
    repoName,
    repo: {
      name                      : repoName,
      description               : '',
      defaultBranch             : 'main',
      homepage                  : '',
      contextId                 : `${repoDid}/${repoName}`,
      visibility                : 'public',
      language                  : '',
      archived                  : false,
      hasIssues                 : true,
      hasProjects               : false,
      hasWiki                   : true,
      hasDownloads              : true,
      hasPullRequests           : true,
      isTemplate                : false,
      allowSquashMerge          : true,
      allowMergeCommit          : true,
      allowRebaseMerge          : true,
      allowAutoMerge            : false,
      allowForking              : true,
      deleteBranchOnMerge       : false,
      webCommitSignoffRequired  : false,
      pullRequestCreationPolicy : 'all',
      dateCreated               : entry.record.dateCreated ?? timestamp,
      timestamp,
    },
  };
}

async function repoLookupForNotification(ctx: AgentContext, entry: NotificationEntry): Promise<RepoLookup> {
  if (typeof entry.tags.repoDid === 'string' && typeof entry.tags.repoRecordId === 'string') {
    const lookup = await findRepoByRecordId(ctx, entry.tags.repoDid, entry.tags.repoRecordId);
    if (lookup) { return lookup; }
  }
  return fallbackRepoLookup(entry, ctx);
}

async function notificationMatchesRepo(
  ctx: AgentContext, entry: NotificationEntry, targetDid: string, repoName: string,
): Promise<boolean> {
  if (entry.tags.repoDid !== targetDid) { return false; }

  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return false; }
  if (typeof entry.tags.repoRecordId !== 'string') {
    return typeof entry.tags.repoName === 'string' && entry.tags.repoName === repo.name;
  }

  const lookup = await findRepoByRecordId(ctx, targetDid, entry.tags.repoRecordId);
  return lookup?.repoName === repo.name;
}

function filterNotificationEntries(entries: NotificationEntry[], url: URL): NotificationEntry[] | JsonResponse {
  const all = parseBoolQuery(url, 'all', false);
  const participating = parseBoolQuery(url, 'participating', false);
  const since = parseDate(url.searchParams.get('since'), 'since');
  if (since && 'status' in since) { return since; }
  const before = parseDate(url.searchParams.get('before'), 'before');
  if (before && 'status' in before) { return before; }

  return entries.filter((entry) => {
    const updated = new Date(notificationUpdatedAt(entry));
    if (!all && notificationIsRead(entry)) { return false; }
    if (participating && !normalizeBool(entry.tags.participating, true)) { return false; }
    if (since && updated <= since) { return false; }
    if (before && updated >= before) { return false; }
    return true;
  });
}

async function buildNotificationResponse(
  ctx: AgentContext, entry: NotificationEntry, baseUrl: string,
): Promise<Record<string, unknown>> {
  const threadId = notificationThreadId(entry.record);
  const repo = await repoLookupForNotification(ctx, entry);
  const read = notificationIsRead(entry);
  const updatedAt = notificationUpdatedAt(entry);
  const lastReadAt = typeof entry.tags.lastReadAt === 'string'
    ? toISODate(entry.tags.lastReadAt)
    : read ? updatedAt : null;

  return {
    id         : threadId,
    repository : buildRepoResponse(repo.repo, repo.repoDid, repo.repoName, baseUrl),
    subject    : {
      title              : entry.data.title,
      url                : entry.data.url ?? null,
      latest_comment_url : entry.data.url ?? null,
      type               : notificationSubjectType(entry),
    },
    reason           : notificationReason(entry),
    unread           : !read,
    updated_at       : updatedAt,
    last_read_at     : lastReadAt,
    url              : `${baseUrl}/notifications/threads/${threadId}`,
    subscription_url : `${baseUrl}/notifications/threads/${threadId}/subscription`,
  };
}

async function markNotification(
  entry: NotificationEntry, read: boolean, extraTags: NotificationTags = {},
): Promise<JsonResponse | null> {
  const now = new Date().toISOString();
  const tags: NotificationTags = {
    ...entry.tags,
    ...extraTags,
    read,
    ...(read ? { lastReadAt: now } : {}),
  };
  const { status } = await entry.record.update({ data: entry.data, tags } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update notification: ${status.detail}`);
  }
  entry.tags = tags;
  return null;
}

async function markEntriesRead(entries: NotificationEntry[], reqBody: Record<string, unknown>): Promise<JsonResponse> {
  if (reqBody.read !== undefined && typeof reqBody.read !== 'boolean') {
    return jsonValidationError('Validation Failed: read must be a boolean.');
  }

  const read = reqBody.read === false ? false : true;
  const lastReadAt = parseDate(typeof reqBody.last_read_at === 'string' ? reqBody.last_read_at : null, 'last_read_at');
  if (lastReadAt && 'status' in lastReadAt) { return lastReadAt; }

  for (const entry of entries) {
    const updated = new Date(notificationUpdatedAt(entry));
    if (lastReadAt && updated > lastReadAt) { continue; }
    const error = await markNotification(entry, read);
    if (error) { return error; }
  }

  return jsonResetContent();
}

function buildThreadSubscription(entry: NotificationEntry, baseUrl: string): Record<string, unknown> {
  const threadId = notificationThreadId(entry.record);
  const ignored = normalizeBool(entry.tags.ignored, false);
  const subscribed = normalizeBool(entry.tags.subscribed, !ignored);
  return {
    subscribed,
    ignored,
    reason     : null,
    created_at : toISODate(entry.record.dateCreated),
    url        : `${baseUrl}/notifications/threads/${threadId}/subscription`,
    thread_url : `${baseUrl}/notifications/threads/${threadId}`,
  };
}

// ---------------------------------------------------------------------------
// /notifications
// ---------------------------------------------------------------------------

export async function handleListNotifications(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = filterNotificationEntries(await listNotificationEntries(ctx), url);
  if ('status' in entries) { return entries; }

  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const baseUrl = buildApiUrl(url);
  const items = [];
  for (const entry of paged) {
    items.push(await buildNotificationResponse(ctx, entry, baseUrl));
  }

  const linkHeader = buildLinkHeader(baseUrl, '/notifications', pagination.page, pagination.perPage, entries.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleMarkNotificationsRead(
  ctx: AgentContext, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  return markEntriesRead(await listNotificationEntries(ctx), reqBody);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/notifications
// ---------------------------------------------------------------------------

export async function handleListRepoNotifications(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const allEntries = await listNotificationEntries(ctx);
  const repoEntries: NotificationEntry[] = [];
  for (const entry of allEntries) {
    if (await notificationMatchesRepo(ctx, entry, targetDid, repo.name)) {
      repoEntries.push(entry);
    }
  }

  const filtered = filterNotificationEntries(repoEntries, url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const items = [];
  for (const entry of paged) {
    items.push(await buildNotificationResponse(ctx, entry, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repo.name}/notifications`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleMarkRepoNotificationsRead(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const allEntries = await listNotificationEntries(ctx);
  const repoEntries: NotificationEntry[] = [];
  for (const entry of allEntries) {
    if (await notificationMatchesRepo(ctx, entry, targetDid, repo.name)) {
      repoEntries.push(entry);
    }
  }

  return markEntriesRead(repoEntries, reqBody);
}

// ---------------------------------------------------------------------------
// /notifications/threads/:thread_id
// ---------------------------------------------------------------------------

export async function handleGetNotificationThread(
  ctx: AgentContext, threadId: string, url: URL,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }

  return jsonOk(await buildNotificationResponse(ctx, entry, buildApiUrl(url)));
}

export async function handleMarkNotificationThreadRead(
  ctx: AgentContext, threadId: string,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }

  const error = await markNotification(entry, true);
  if (error) { return error; }
  return jsonResetContent();
}

export async function handleDeleteNotificationThread(
  ctx: AgentContext, threadId: string,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete notification thread: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /notifications/threads/:thread_id/subscription
// ---------------------------------------------------------------------------

export async function handleGetNotificationThreadSubscription(
  ctx: AgentContext, threadId: string, url: URL,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }

  return jsonOk(buildThreadSubscription(entry, buildApiUrl(url)));
}

export async function handleSetNotificationThreadSubscription(
  ctx: AgentContext, threadId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }
  if (reqBody.ignored !== undefined && typeof reqBody.ignored !== 'boolean') {
    return jsonValidationError('Validation Failed: ignored must be a boolean.');
  }

  const ignored = reqBody.ignored === true;
  const tags: NotificationTags = {
    ...entry.tags,
    ignored,
    subscribed: !ignored,
  };
  const { status } = await entry.record.update({ data: entry.data, tags } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update notification subscription: ${status.detail}`);
  }
  entry.tags = tags;

  return jsonOk(buildThreadSubscription(entry, buildApiUrl(url)));
}

export async function handleDeleteNotificationThreadSubscription(
  ctx: AgentContext, threadId: string,
): Promise<JsonResponse> {
  const entry = await findNotificationEntry(ctx, threadId);
  if (!entry) {
    return jsonNotFound(`Notification thread '${threadId}' not found.`);
  }

  const tags: NotificationTags = {
    ...entry.tags,
    ignored    : false,
    subscribed : false,
  };
  const { status } = await entry.record.update({ data: entry.data, tags } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete notification subscription: ${status.detail}`);
  }

  return jsonNoContent();
}
