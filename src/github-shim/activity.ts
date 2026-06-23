/**
 * GitHub API shim — activity event endpoints.
 *
 * Maps forge-social activity records to GitHub REST API event objects.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  buildLinkHeader,
  fromOpt,
  getRepoRecord,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

type ActivityEntry = {
  record : any;
  data : Record<string, unknown>;
  tags : Record<string, unknown>;
  actorDid : string;
};

const REPO_ACTIVITY_TYPES = new Set(['push', 'force_push', 'branch_creation', 'branch_deletion', 'pr_merge', 'merge_queue_merge']);
const REPO_ACTIVITY_TIME_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(entry: ActivityEntry, key: string): string | undefined {
  if (typeof entry.data[key] === 'string') { return entry.data[key]; }
  if (typeof entry.tags[key] === 'string') { return entry.tags[key]; }
  return undefined;
}

function actorResponse(did: string, baseUrl: string): Record<string, unknown> {
  return {
    id            : numericId(did),
    login         : did,
    display_login : did,
    gravatar_id   : '',
    url           : `${baseUrl}/users/${did}`,
    avatar_url    : '',
  };
}

function repoResponse(entry: ActivityEntry, baseUrl: string): Record<string, unknown> {
  const repoDid = stringField(entry, 'repoDid') ?? stringField(entry, 'targetDid') ?? entry.actorDid;
  const repoName = stringField(entry, 'repoName') ?? 'unknown';
  const repoRecordId = stringField(entry, 'repoRecordId') ?? stringField(entry, 'targetRecordId') ?? `${repoDid}/${repoName}`;
  const fullName = `${repoDid}/${repoName}`;
  return {
    id   : numericId(repoRecordId),
    name : fullName,
    url  : `${baseUrl}/repos/${fullName}`,
  };
}

function githubEventType(type: string): string {
  switch (type) {
    case 'push': return 'PushEvent';
    case 'issue_open':
    case 'issue_close': return 'IssuesEvent';
    case 'patch_open':
    case 'patch_merge': return 'PullRequestEvent';
    case 'release': return 'ReleaseEvent';
    case 'star': return 'WatchEvent';
    case 'fork': return 'ForkEvent';
    default: return 'CreateEvent';
  }
}

function issuePayload(entry: ActivityEntry, action: 'opened' | 'closed'): Record<string, unknown> {
  const recordId = stringField(entry, 'recordId') ?? entry.record.id;
  return {
    action,
    issue: {
      id     : numericId(recordId),
      number : numericId(recordId),
      title  : typeof entry.data.summary === 'string' ? entry.data.summary : '',
    },
  };
}

function pullPayload(entry: ActivityEntry, action: 'opened' | 'closed', merged: boolean): Record<string, unknown> {
  const recordId = stringField(entry, 'recordId') ?? entry.record.id;
  return {
    action,
    pull_request: {
      id     : numericId(recordId),
      number : numericId(recordId),
      title  : typeof entry.data.summary === 'string' ? entry.data.summary : '',
      merged,
    },
  };
}

function eventPayload(entry: ActivityEntry): Record<string, unknown> {
  const explicit = asRecord(entry.data.payload);
  if (Object.keys(explicit).length > 0) { return explicit; }

  const type = typeof entry.data.type === 'string' ? entry.data.type : '';
  const repo = repoResponse(entry, '');
  switch (type) {
    case 'push':
      return {
        repository_id : repo.id,
        push_id       : numericId(entry.record.id),
        ref           : stringField(entry, 'ref') ?? 'refs/heads/main',
        head          : stringField(entry, 'head') ?? stringField(entry, 'recordId') ?? entry.record.id,
        before        : stringField(entry, 'before') ?? null,
        commits       : [],
      };
    case 'issue_open': return issuePayload(entry, 'opened');
    case 'issue_close': return issuePayload(entry, 'closed');
    case 'patch_open': return pullPayload(entry, 'opened', false);
    case 'patch_merge': return pullPayload(entry, 'closed', true);
    case 'release':
      return {
        action  : 'published',
        release : {
          id       : numericId(stringField(entry, 'recordId') ?? entry.record.id),
          name     : typeof entry.data.summary === 'string' ? entry.data.summary : '',
          tag_name : stringField(entry, 'tagName') ?? '',
        },
      };
    case 'star':
      return { action: 'started' };
    case 'fork':
      return {
        forkee: {
          full_name: stringField(entry, 'forkeeFullName') ?? `${entry.actorDid}/${stringField(entry, 'repoName') ?? 'fork'}`,
        },
      };
    default:
      return {
        ref           : stringField(entry, 'ref') ?? null,
        ref_type      : 'repository',
        master_branch : stringField(entry, 'defaultBranch') ?? 'main',
        description   : typeof entry.data.summary === 'string' ? entry.data.summary : null,
      };
  }
}

function buildEvent(entry: ActivityEntry, baseUrl: string): Record<string, unknown> {
  const type = typeof entry.data.type === 'string' ? entry.data.type : 'activity';
  return {
    id         : entry.record.id,
    type       : githubEventType(type),
    actor      : actorResponse(entry.actorDid, baseUrl),
    repo       : repoResponse(entry, baseUrl),
    payload    : eventPayload(entry),
    public     : entry.data.public !== false,
    created_at : toISODate(entry.record.dateCreated),
  };
}

function repoActivityType(entry: ActivityEntry): string | null {
  const type = typeof entry.data.type === 'string' ? entry.data.type : '';
  switch (type) {
    case 'patch_merge': return 'pr_merge';
    case 'force_push':
    case 'branch_creation':
    case 'branch_deletion':
    case 'merge_queue_merge':
    case 'push':
      return type;
    default:
      return null;
  }
}

function repoActivityRef(entry: ActivityEntry, repo: RepoInfo): string {
  return stringField(entry, 'ref') ?? `refs/heads/${repo.defaultBranch}`;
}

function repoActivityResponse(entry: ActivityEntry, repo: RepoInfo, baseUrl: string): Record<string, unknown> {
  const payload = eventPayload(entry);
  const after = typeof payload.head === 'string'
    ? payload.head
    : typeof payload.after === 'string'
      ? payload.after
      : stringField(entry, 'recordId') ?? entry.record.id;
  return {
    id            : numericId(entry.record.id),
    node_id       : entry.record.id,
    before        : typeof payload.before === 'string' ? payload.before : null,
    after,
    ref           : repoActivityRef(entry, repo),
    timestamp     : toISODate(entry.record.dateCreated),
    activity_type : repoActivityType(entry) ?? 'push',
    actor         : actorResponse(entry.actorDid, baseUrl),
  };
}

function parseRepoActivityCursor(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function filterRepoActivity(entries: ActivityEntry[], repo: RepoInfo, url: URL): ActivityEntry[] | JsonResponse {
  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const activityType = url.searchParams.get('activity_type');
  if (activityType && !REPO_ACTIVITY_TYPES.has(activityType)) {
    return jsonValidationError('Validation Failed: activity_type is not supported.');
  }

  const timePeriod = url.searchParams.get('time_period');
  if (timePeriod && !REPO_ACTIVITY_TIME_PERIODS.has(timePeriod)) {
    return jsonValidationError('Validation Failed: time_period must be day, week, month, quarter, or year.');
  }

  const ref = url.searchParams.get('ref');
  const actor = url.searchParams.get('actor');
  const before = parseRepoActivityCursor(url.searchParams.get('before'));
  const after = parseRepoActivityCursor(url.searchParams.get('after'));

  const filtered = entries.filter((entry) => {
    const type = repoActivityType(entry);
    if (!type) {
      return false;
    }
    if (activityType && type !== activityType) {
      return false;
    }
    if (ref) {
      const activityRef = repoActivityRef(entry, repo);
      if (activityRef !== ref && activityRef !== `refs/heads/${ref}`) {
        return false;
      }
    }
    if (actor && entry.actorDid !== actor) {
      return false;
    }

    const timestamp = Date.parse(String(entry.record.dateCreated ?? ''));
    if (before !== null && Number.isFinite(timestamp) && timestamp >= before) {
      return false;
    }
    if (after !== null && Number.isFinite(timestamp) && timestamp <= after) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const comparison = String(a.record.dateCreated ?? '').localeCompare(String(b.record.dateCreated ?? ''));
    return direction === 'asc' ? comparison : -comparison;
  });
  return filtered;
}

async function listActorActivity(ctx: AgentContext, actorDid: string): Promise<ActivityEntry[]> {
  const { records } = await ctx.social.records.query('activity' as any, {
    from     : fromOpt(ctx, actorDid),
    dateSort : DateSort.CreatedDescending,
  } as any);

  const entries: ActivityEntry[] = [];
  for (const record of records) {
    let data: Record<string, unknown>;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    entries.push({
      record,
      data,
      tags: (record.tags as Record<string, unknown> | undefined) ?? {},
      actorDid,
    });
  }
  return entries;
}

async function listVisibleActivity(ctx: AgentContext, actorDids: string[]): Promise<ActivityEntry[]> {
  const seen = new Set<string>();
  const entries: ActivityEntry[] = [];
  for (const actorDid of [...new Set(actorDids)]) {
    for (const entry of await listActorActivity(ctx, actorDid)) {
      if (seen.has(entry.record.id)) { continue; }
      seen.add(entry.record.id);
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => String(b.record.dateCreated ?? '').localeCompare(String(a.record.dateCreated ?? '')));
}

function activityMatchesRepo(entry: ActivityEntry, targetDid: string, repoName: string, repo: RepoInfo): boolean {
  const entryRepoDid = stringField(entry, 'repoDid') ?? stringField(entry, 'targetDid');
  if (entryRepoDid !== targetDid) { return false; }

  const entryRepoName = stringField(entry, 'repoName');
  if (entryRepoName) { return entryRepoName === repoName || entryRepoName === repo.name; }

  const entryRepoRecord = stringField(entry, 'repoRecordId') ?? stringField(entry, 'targetRecordId');
  return entryRepoRecord === repo.contextId;
}

function eventsResponse(entries: ActivityEntry[], url: URL, path: string): JsonResponse {
  const pagination = parsePagination(url);
  const limited = entries.slice(0, 300);
  const paged = paginate(limited, pagination);
  const baseUrl = buildApiUrl(url);
  const events = paged.map(entry => buildEvent(entry, baseUrl));
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, limited.length);
  const headers: Record<string, string> = { 'X-Poll-Interval': '60' };
  if (linkHeader) { headers.Link = linkHeader; }
  return jsonOk(events, headers);
}

export async function handleListPublicEvents(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = (await listVisibleActivity(ctx, [ctx.did])).filter(entry => entry.data.public !== false);
  return eventsResponse(entries, url, '/events');
}

export async function handleListUserEvents(ctx: AgentContext, userDid: string, url: URL, publicOnly = false): Promise<JsonResponse> {
  const path = publicOnly ? `/users/${userDid}/events/public` : `/users/${userDid}/events`;
  const entries = await listVisibleActivity(ctx, [userDid]);
  return eventsResponse(publicOnly ? entries.filter(entry => entry.data.public !== false) : entries, url, path);
}

export async function handleListReceivedEvents(ctx: AgentContext, userDid: string, url: URL, publicOnly = false): Promise<JsonResponse> {
  const path = publicOnly ? `/users/${userDid}/received_events/public` : `/users/${userDid}/received_events`;
  const entries = await listVisibleActivity(ctx, [userDid]);
  return eventsResponse(publicOnly ? entries.filter(entry => entry.data.public !== false) : entries, url, path);
}

export async function handleListRepoEvents(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, pathPrefix = 'repos',
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const activity = await listVisibleActivity(ctx, targetDid === ctx.did ? [ctx.did] : [targetDid, ctx.did]);
  const entries = activity.filter(entry => activityMatchesRepo(entry, targetDid, repoName, repo));
  return eventsResponse(entries, url, `/${pathPrefix}/${targetDid}/${repoName}/events`);
}

export async function handleListRepoActivity(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const activity = await listVisibleActivity(ctx, targetDid === ctx.did ? [ctx.did] : [targetDid, ctx.did]);
  const entries = activity.filter(entry => activityMatchesRepo(entry, targetDid, repoName, repo));
  const filtered = filterRepoActivity(entries, repo, url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repo.name}/activity`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }

  return jsonOk(paged.map(entry => repoActivityResponse(entry, repo, baseUrl)), headers);
}
