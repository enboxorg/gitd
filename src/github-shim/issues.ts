/**
 * GitHub API shim — `/repos/:did/:repo/issues` endpoints.
 *
 * Maps DWN issue records to GitHub REST API v3 issue responses.
 *
 * Endpoints:
 *   GET  /issues                                      Assigned issues across visible repositories
 *   GET  /user/issues                                 Authenticated user's issues
 *   GET  /orgs/:org/issues                            Organization issues
 *   GET  /repos/:did/:repo/labels                    Repository labels
 *   GET  /repos/:did/:repo/labels/:name              Repository label detail
 *   POST /repos/:did/:repo/labels                    Create repository label
 *   PATCH /repos/:did/:repo/labels/:name             Update repository label
 *   DELETE /repos/:did/:repo/labels/:name            Delete repository label
 *   GET  /repos/:did/:repo/milestones                Repository milestones
 *   POST /repos/:did/:repo/milestones                Create milestone
 *   GET  /repos/:did/:repo/milestones/:number        Milestone detail
 *   PATCH /repos/:did/:repo/milestones/:number       Update milestone
 *   DELETE /repos/:did/:repo/milestones/:number      Delete milestone
 *   GET  /repos/:did/:repo/milestones/:number/labels Labels for issues in milestone
 *   GET  /repos/:did/:repo/issues                    List issues
 *   GET  /repos/:did/:repo/issues/:number            Issue detail
 *   PUT  /repos/:did/:repo/issues/:number/lock       Lock issue conversation
 *   DELETE /repos/:did/:repo/issues/:number/lock     Unlock issue conversation
 *   GET  /repos/:did/:repo/issues/events             List repo issue events
 *   GET  /repos/:did/:repo/issues/events/:id         Issue event detail
 *   GET  /repos/:did/:repo/issues/comments           List repo issue comments
 *   GET  /repos/:did/:repo/issues/comments/:id       Issue comment detail
 *   GET  /repos/:did/:repo/issues/comments/:id/reactions Issue comment reactions
 *   GET  /repos/:did/:repo/issues/:number/comments   Issue comments
 *   PUT  /repos/:did/:repo/issues/comments/:id/pin   Pin issue comment
 *   DELETE /repos/:did/:repo/issues/comments/:id/pin Unpin issue comment
 *   GET  /repos/:did/:repo/issues/:number/events     Issue events
 *   GET  /repos/:did/:repo/issues/:number/timeline   Issue timeline
 *   GET  /repos/:did/:repo/issues/:number/reactions  Issue reactions
 *   GET  /repos/:did/:repo/issues/:number/labels     Issue labels
 *   POST /repos/:did/:repo/issues                    Create issue
 *   PATCH /repos/:did/:repo/issues/:number           Update issue
 *   PATCH /repos/:did/:repo/issues/comments/:id      Update issue comment
 *   DELETE /repos/:did/:repo/issues/comments/:id     Delete issue comment
 *   POST /repos/:did/:repo/issues/comments/:id/reactions Create issue comment reaction
 *   DELETE /repos/:did/:repo/issues/comments/:id/reactions/:reaction_id Delete issue comment reaction
 *   POST /repos/:did/:repo/issues/:number/reactions  Create issue reaction
 *   DELETE /repos/:did/:repo/issues/:number/reactions/:reaction_id Delete issue reaction
 *   POST /repos/:did/:repo/issues/:number/comments   Create comment
 *   POST /repos/:did/:repo/issues/:number/labels     Add labels
 *   PUT  /repos/:did/:repo/issues/:number/labels     Replace labels
 *   DELETE /repos/:did/:repo/issues/:number/labels   Remove all labels
 *   DELETE /repos/:did/:repo/issues/:number/labels/:name Remove label
 *   GET  /repos/:did/:repo/issues/:number/assignees/:did Check assignable user for issue
 *   POST /repos/:did/:repo/issues/:number/assignees  Add assignees
 *   DELETE /repos/:did/:repo/issues/:number/assignees Remove assignees
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { BodyMediaKind } from './body-media.js';
import type { JsonResponse } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { applyBodyMedia } from './body-media.js';
import { handleCheckAssignee } from './repo-metadata.js';
import { orgRouteExists } from './orgs.js';
import { buildRepoResponse, repoInfoFromRecord } from './repos.js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonCreated,
  jsonNoContent,
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
  labels: Record<string, unknown>[] = [],
  assignees: Record<string, unknown>[] = [],
  reactions: any[] = [],
  milestone: Record<string, unknown> | null = null,
  bodyMediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const authorDid = rec.author ?? targetDid;
  const user = buildOwner(authorDid, baseUrl);
  const number = numericId(rec.id ?? '');
  const state = tags.status === 'closed' ? 'closed' : 'open';
  const locked = tags.locked === 'true';
  const body = typeof data.body === 'string' ? data.body : null;

  return applyBodyMedia({
    id                 : numericId(rec.id ?? ''),
    node_id            : rec.id ?? '',
    url                : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    repository_url     : `${baseUrl}/repos/${targetDid}/${repoName}`,
    comments_url       : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/comments`,
    events_url         : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/events`,
    timeline_url       : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/timeline`,
    labels_url         : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/labels{/name}`,
    number,
    title              : data.title ?? '',
    state,
    locked,
    active_lock_reason : locked ? tags.lockReason ?? null : null,
    comments           : 0,
    created_at         : toISODate(rec.dateCreated),
    updated_at         : toISODate(rec.timestamp),
    closed_at          : state === 'closed' ? toISODate(rec.timestamp) : null,
    user,
    author_association : authorDid === targetDid ? 'OWNER' : 'CONTRIBUTOR',
    labels,
    assignee           : assignees[0] ?? null,
    assignees,
    milestone,
    reactions          : buildIssueReactionsSummary(targetDid, repoName, number, baseUrl, reactions),
  }, body, bodyMediaKind);
}

function buildLabelResponse(
  rec: any, data: any, tags: Record<string, string>,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const name = tags.name ?? data.name ?? '';
  const color = normalizeLabelColor(tags.color ?? data.color) ?? 'ededed';
  return {
    id          : numericId(rec.id ?? ''),
    node_id     : rec.id ?? '',
    url         : `${baseUrl}/repos/${targetDid}/${repoName}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default     : false,
    description : data.description ?? null,
  };
}

function buildAssigneeResponse(
  rec: any, data: any, tags: Record<string, string>, baseUrl: string,
): Record<string, unknown> {
  const did = tags.assigneeDid ?? data.assigneeDid ?? '';
  return {
    ...buildOwner(did, baseUrl),
    node_id             : rec.id ?? did,
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
    ...(typeof data.alias === 'string' && data.alias ? { name: data.alias } : {}),
  };
}

function buildIssueFieldValueResponse(entry: IssueFieldValueEntry): Record<string, unknown> {
  const response: Record<string, unknown> = {
    issue_field_id : entry.fieldId,
    node_id        : entry.rec.id ?? `issue-field-${entry.fieldId}`,
    data_type      : entry.dataType,
  };

  if (entry.dataType === 'multi_select' && Array.isArray(entry.value)) {
    response.value = entry.value.join(',');
    response.multi_select_options = entry.value.map((name, index) => ({
      id    : numericId(`issue-field:${entry.fieldId}:${name}`) || index + 1,
      name,
      color : 'gray',
    }));
    return response;
  }

  response.value = entry.value;
  if (entry.dataType === 'single_select' && typeof entry.value === 'string') {
    response.single_select_option = {
      id    : numericId(`issue-field:${entry.fieldId}:${entry.value}`) || 1,
      name  : entry.value,
      color : 'gray',
    };
  }
  return response;
}

type IssueLookup = {
  repo : NonNullable<Awaited<ReturnType<typeof getRepoRecord>>>;
  from : string | undefined;
  issue : any;
};

type IssueCommentEntry = {
  issue : any;
  issueNumber : number;
  comment : any;
};

type IssueCommentLookup = {
  from : string | undefined;
  entry : IssueCommentEntry;
};

type IssueEventEntry = {
  issue : any;
  issueNumber : number;
  event : any;
};

type IssueTimelineEntry =
  | {
    kind : 'comment';
    issueNumber : number;
    comment : any;
    createdAt : string;
    recordId : string;
  }
  | {
    kind : 'event';
    issue : any;
    issueNumber : number;
    event : any;
    createdAt : string;
    recordId : string;
  };

type IssueInboxEntry = {
  ownerDid : string;
  repoName : string;
  repo : ReturnType<typeof repoInfoFromRecord>;
  issue : any;
  data : any;
  tags : Record<string, string>;
  commentCount : number;
  response : Record<string, unknown>;
};

type RepoLabelEntry = {
  rec : any;
  data : any;
  tags : Record<string, string>;
  name : string;
  updatedAt : string;
};

type RepoLabelRecordEntry = RepoLabelEntry & {
  issue : any;
};

type RepoLabelCatalogEntry = {
  name : string;
  color : string;
  description? : string | null;
  createdAt? : string;
  updatedAt? : string;
};

type RepoMilestoneCatalogEntry = {
  title : string;
  number : number;
  state? : 'open' | 'closed';
  description? : string | null;
  dueOn? : string | null;
  createdAt? : string;
  updatedAt? : string;
  closedAt? : string | null;
};

type RepoSettingsData = {
  branchProtection? : Record<string, unknown>;
  labels? : Record<string, RepoLabelCatalogEntry>;
  milestones? : Record<string, RepoMilestoneCatalogEntry>;
  mergeStrategies? : ('merge' | 'squash' | 'rebase')[];
  autoDeleteBranch? : boolean;
};

type RepoSettingsLookup = {
  repo : NonNullable<Awaited<ReturnType<typeof getRepoRecord>>>;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

type MilestoneEntry = {
  title : string;
  number : number;
  state? : 'open' | 'closed';
  description : string | null;
  dueOn : string | null;
  openIssues : number;
  closedIssues : number;
  createdAt : string;
  updatedAt : string;
  closedAt? : string | null;
};

type MilestoneLookup = {
  repo : NonNullable<Awaited<ReturnType<typeof getRepoRecord>>>;
  from : string | undefined;
  milestone : MilestoneEntry;
};

async function findIssueRecord(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<IssueLookup | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const num = parseInt(number, 10);
  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId },
  });

  const issue = records.find(r => numericId(r.id ?? '') === num);
  if (!issue) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  return { repo, from, issue };
}

async function listLabelRecords(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue/label' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });
  return records;
}

function normalizeMilestoneTitle(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const title = value.trim();
  return title.length > 0 ? title : null;
}

function milestoneKey(title: string): string {
  return title.toLocaleLowerCase();
}

function milestoneNumber(title: string): number {
  return numericId(`milestone:${milestoneKey(title)}`) || 1;
}

function milestoneState(entry: MilestoneEntry): 'open' | 'closed' {
  if (entry.state === 'open' || entry.state === 'closed') { return entry.state; }
  return entry.openIssues > 0 ? 'open' : 'closed';
}

function catalogMilestoneEntry(key: string, milestone: RepoMilestoneCatalogEntry): MilestoneEntry | null {
  const title = normalizeMilestoneTitle(milestone.title);
  if (!title) { return null; }

  const number = Number.isInteger(milestone.number) && milestone.number > 0
    ? milestone.number
    : milestoneNumber(title);
  const state = milestone.state === 'closed' ? 'closed' : 'open';
  const createdAt = String(milestone.createdAt ?? milestone.updatedAt ?? '');
  const updatedAt = String(milestone.updatedAt ?? milestone.createdAt ?? '');

  return {
    title,
    number,
    state,
    description  : typeof milestone.description === 'string' ? milestone.description : null,
    dueOn        : typeof milestone.dueOn === 'string' ? milestone.dueOn : null,
    openIssues   : 0,
    closedIssues : 0,
    createdAt,
    updatedAt,
    closedAt     : state === 'closed' ? milestone.closedAt ?? updatedAt : null,
  };
}

function nextMilestoneNumber(entries: MilestoneEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.number), 0) + 1;
}

async function listIssueRecordsForRepo(
  ctx: AgentContext, repoContextId: string, from?: string,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repoContextId },
  });
  return records;
}

async function listMilestoneEntriesForRepo(
  ctx: AgentContext, repoContextId: string, from?: string, settings: RepoSettingsData = {},
): Promise<MilestoneEntry[]> {
  const issues = await listIssueRecordsForRepo(ctx, repoContextId, from);
  const issueEntriesByTitle = new Map<string, MilestoneEntry>();

  for (const issue of issues) {
    const tags = (issue.tags as Record<string, string> | undefined) ?? {};
    const title = normalizeMilestoneTitle(tags.milestone);
    if (!title) { continue; }

    const key = milestoneKey(title);
    const createdAt = String(issue.dateCreated ?? issue.timestamp ?? '');
    const updatedAt = String(issue.timestamp ?? issue.dateCreated ?? '');
    let entry = issueEntriesByTitle.get(key);
    if (!entry) {
      entry = {
        title,
        number       : milestoneNumber(title),
        description  : null,
        dueOn        : null,
        openIssues   : 0,
        closedIssues : 0,
        createdAt,
        updatedAt,
      };
      issueEntriesByTitle.set(key, entry);
    }

    if (tags.status === 'closed') {
      entry.closedIssues++;
    } else {
      entry.openIssues++;
    }

    if (createdAt && (!entry.createdAt || createdAt.localeCompare(entry.createdAt) < 0)) {
      entry.createdAt = createdAt;
    }
    if (updatedAt && (!entry.updatedAt || updatedAt.localeCompare(entry.updatedAt) > 0)) {
      entry.updatedAt = updatedAt;
    }
  }

  const entriesByTitle = new Map<string, MilestoneEntry>();
  for (const [key, milestone] of Object.entries(settings.milestones ?? {})) {
    const entry = catalogMilestoneEntry(key, milestone);
    if (!entry) { continue; }

    const issueEntry = issueEntriesByTitle.get(milestoneKey(entry.title));
    if (issueEntry) {
      entry.openIssues = issueEntry.openIssues;
      entry.closedIssues = issueEntry.closedIssues;
      if (!entry.createdAt || issueEntry.createdAt.localeCompare(entry.createdAt) < 0) {
        entry.createdAt = issueEntry.createdAt;
      }
      if (issueEntry.updatedAt && issueEntry.updatedAt.localeCompare(entry.updatedAt) > 0) {
        entry.updatedAt = issueEntry.updatedAt;
      }
    }

    entriesByTitle.set(milestoneKey(entry.title), entry);
  }

  for (const [key, entry] of issueEntriesByTitle.entries()) {
    if (!entriesByTitle.has(key)) {
      entriesByTitle.set(key, entry);
    }
  }

  return [...entriesByTitle.values()];
}

async function listMilestoneEntries(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<MilestoneEntry[] | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return listMilestoneEntriesForRepo(ctx, lookup.repo.contextId, fromOpt(ctx, targetDid), lookup.settings);
}

function buildMilestoneResponse(
  entry: MilestoneEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const state = milestoneState(entry);
  const updatedAt = toISODate(entry.updatedAt || entry.createdAt);

  return {
    url           : `${baseUrl}/repos/${targetDid}/${repoName}/milestones/${entry.number}`,
    html_url      : `${baseUrl}/repos/${targetDid}/${repoName}/milestones/${encodeURIComponent(entry.title)}`,
    labels_url    : `${baseUrl}/repos/${targetDid}/${repoName}/milestones/${entry.number}/labels`,
    id            : entry.number,
    node_id       : `milestone:${entry.number}`,
    number        : entry.number,
    state,
    title         : entry.title,
    description   : entry.description,
    creator       : buildOwner(targetDid, baseUrl),
    open_issues   : entry.openIssues,
    closed_issues : entry.closedIssues,
    created_at    : toISODate(entry.createdAt),
    updated_at    : updatedAt,
    closed_at     : state === 'closed' ? toISODate(entry.closedAt ?? entry.updatedAt) : null,
    due_on        : entry.dueOn ? toISODate(entry.dueOn) : null,
  };
}

async function buildIssueMilestone(
  ctx: AgentContext, targetDid: string, repoName: string, baseUrl: string, titleValue: unknown,
): Promise<Record<string, unknown> | null> {
  const title = normalizeMilestoneTitle(titleValue);
  if (!title) { return null; }

  const entries = await listMilestoneEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return null; }

  const entry = entries.find(item => milestoneKey(item.title) === milestoneKey(title)) ?? {
    title,
    number       : milestoneNumber(title),
    description  : null,
    dueOn        : null,
    openIssues   : 0,
    closedIssues : 0,
    createdAt    : new Date(0).toISOString(),
    updatedAt    : new Date(0).toISOString(),
  };

  return buildMilestoneResponse(entry, targetDid, repoName, baseUrl);
}

function sortMilestoneEntries(entries: MilestoneEntry[], url: URL): MilestoneEntry[] {
  const stateFilter = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') === 'completeness' ? 'completeness' : 'due_on';
  const direction = url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc';

  const filtered = stateFilter === 'all'
    ? entries
    : entries.filter(entry => milestoneState(entry) === stateFilter);

  return [...filtered].sort((a, b) => {
    let result = 0;
    if (sort === 'completeness') {
      const leftTotal = a.openIssues + a.closedIssues;
      const rightTotal = b.openIssues + b.closedIssues;
      const left = leftTotal === 0 ? 0 : a.closedIssues / leftTotal;
      const right = rightTotal === 0 ? 0 : b.closedIssues / rightTotal;
      result = left - right;
    } else {
      const leftDue = a.dueOn ? Date.parse(a.dueOn) : Number.POSITIVE_INFINITY;
      const rightDue = b.dueOn ? Date.parse(b.dueOn) : Number.POSITIVE_INFINITY;
      result = leftDue - rightDue;
    }

    if (result === 0) {
      result = a.title.localeCompare(b.title) || a.number - b.number;
    }

    return direction === 'desc' ? -result : result;
  });
}

async function findMilestoneEntry(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<MilestoneLookup | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const from = fromOpt(ctx, targetDid);
  const num = parseInt(number, 10);
  const entries = await listMilestoneEntriesForRepo(ctx, lookup.repo.contextId, from, lookup.settings);
  const milestone = entries.find(entry => entry.number === num);
  if (!milestone) {
    return jsonNotFound(`Milestone #${number} not found.`);
  }

  return { repo: lookup.repo, from, milestone };
}

async function parseMilestoneInput(
  ctx: AgentContext, targetDid: string, repoName: string, value: unknown,
): Promise<string | null | JsonResponse> {
  if (value === null) { return null; }

  const title = normalizeMilestoneTitle(value);
  if (title) { return title; }

  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    const entries = await listMilestoneEntries(ctx, targetDid, repoName);
    if (!Array.isArray(entries)) { return entries; }

    const entry = entries.find(item => item.number === value);
    if (!entry) {
      return jsonValidationError(`Validation Failed: milestone ${value} does not exist.`);
    }
    return entry.title;
  }

  return jsonValidationError('Validation Failed: milestone must be a milestone number, string title, or null.');
}

async function buildIssueLabels(
  ctx: AgentContext, from: string | undefined, issueRec: any,
  targetDid: string, repoName: string, baseUrl: string,
): Promise<Record<string, unknown>[]> {
  const records = await listLabelRecords(ctx, from, issueRec);
  const labels = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    labels.push(buildLabelResponse(rec, data, tags, targetDid, repoName, baseUrl));
  }
  return labels;
}

async function listIssueStatusChangeRecords(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue/statusChange' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });
  return records;
}

async function listIssueEventEntries(
  ctx: AgentContext, repoContextId: string, from?: string,
): Promise<IssueEventEntry[]> {
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repoContextId },
  });

  const entries: IssueEventEntry[] = [];
  for (const issue of issues) {
    const issueNumber = numericId(issue.id ?? '');
    const events = await listIssueStatusChangeRecords(ctx, from, issue);
    for (const event of events) {
      entries.push({ issue, issueNumber, event });
    }
  }

  entries.sort((a, b) => String(a.event.dateCreated).localeCompare(String(b.event.dateCreated)));
  return entries;
}

function decodeLabelName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function labelKey(name: string): string {
  return name.toLocaleLowerCase();
}

async function getRepoSettings(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoSettingsLookup | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from,
    filter: { contextId: repo.contextId },
  });
  if (records.length === 0) {
    return { repo, settings: {} };
  }

  const record = records[0] as RepoSettingsLookup['record'] & { data: { json: () => Promise<RepoSettingsData> } };
  const settings = await record.data.json();
  return { repo, record, settings: settings ?? {} };
}

async function saveRepoSettings(
  ctx: AgentContext, lookup: RepoSettingsLookup, settings: RepoSettingsData,
): Promise<JsonResponse | undefined> {
  if (lookup.record) {
    const { status } = await lookup.record.update({ data: settings });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update repository settings: ${status.detail}`);
    }
    return undefined;
  }

  const { status } = await ctx.repo.records.create('repo/settings' as any, {
    data            : settings,
    parentContextId : lookup.repo.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create repository settings: ${status.detail}`);
  }
  return undefined;
}

function catalogLabelEntry(key: string, label: RepoLabelCatalogEntry): RepoLabelEntry | null {
  const name = normalizeLabelName(label.name);
  const color = normalizeLabelColor(label.color);
  if (!name || !color) { return null; }

  const updatedAt = String(label.updatedAt ?? label.createdAt ?? '');
  return {
    rec: {
      id          : `repo-label:${key}`,
      timestamp   : label.updatedAt ?? label.createdAt,
      dateCreated : label.createdAt ?? label.updatedAt,
    },
    data: {
      name,
      color,
      description: label.description ?? null,
    },
    tags: { name, color },
    name,
    updatedAt,
  };
}

async function listRepoLabelRecords(
  ctx: AgentContext, from: string | undefined, repoContextId: string,
): Promise<RepoLabelRecordEntry[]> {
  const issues = await listIssueRecordsForRepo(ctx, repoContextId, from);
  const labels: RepoLabelRecordEntry[] = [];
  for (const issue of issues) {
    const labelRecords = await listLabelRecords(ctx, from, issue);
    for (const rec of labelRecords) {
      const data = await rec.data.json();
      const tags = (rec.tags as Record<string, string> | undefined) ?? {};
      const name = normalizeLabelName(tags.name ?? data.name);
      if (!name) { continue; }

      labels.push({
        issue,
        rec,
        data,
        tags      : { ...tags, name },
        name,
        updatedAt : String(rec.timestamp ?? rec.dateCreated ?? ''),
      });
    }
  }
  return labels;
}

async function listRepoLabelEntries(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoLabelEntry[] | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const from = fromOpt(ctx, targetDid);
  const labelsByName = new Map<string, RepoLabelEntry>();

  for (const [key, label] of Object.entries(lookup.settings.labels ?? {})) {
    const entry = catalogLabelEntry(key, label);
    if (entry) {
      labelsByName.set(labelKey(entry.name), entry);
    }
  }

  const labelRecords = await listRepoLabelRecords(ctx, from, lookup.repo.contextId);
  for (const entry of labelRecords) {
    const key = labelKey(entry.name);
    const existing = labelsByName.get(key);
    const hasCatalogEntry = Object.prototype.hasOwnProperty.call(lookup.settings.labels ?? {}, key);
    if (!existing || (!hasCatalogEntry && entry.updatedAt.localeCompare(existing.updatedAt) >= 0)) {
      labelsByName.set(key, entry);
    }
  }

  return [...labelsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listAssignmentRecords(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue/assignment' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });
  return records;
}

type IssueDependencyEntry = {
  rec : any;
  issueId : number;
};

type IssueSubIssueEntry = {
  rec : any;
  issueId : number;
  priority : number;
};

type IssueParentLookup = {
  parent : any;
  entry : IssueSubIssueEntry;
};

type IssueFieldValueDataType = 'text' | 'single_select' | 'number' | 'date' | 'multi_select';

type IssueFieldValueInput = {
  fieldId : number;
  dataType : IssueFieldValueDataType;
  value : string | number | string[];
};

type IssueFieldValueEntry = IssueFieldValueInput & {
  rec : any;
};

function getIssueDependencyIssueId(rec: any, data?: any): number {
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};
  const value = tags.issueId ?? data?.issueId;
  const issueId = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isInteger(issueId) && issueId > 0 ? issueId : 0;
}

function getIssueSubIssueIssueId(rec: any, data?: any): number {
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};
  const value = tags.issueId ?? data?.issueId;
  const issueId = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isInteger(issueId) && issueId > 0 ? issueId : 0;
}

function getIssueSubIssuePriority(rec: any, data?: any): number {
  const value = data?.priority;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return numericId(rec.id ?? '') || 1;
}

async function listIssueDependencyEntries(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<IssueDependencyEntry[]> {
  const { records } = await ctx.issues.records.query('repo/issue/issueDependency' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: IssueDependencyEntry[] = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const issueId = getIssueDependencyIssueId(rec, data);
    if (issueId > 0) {
      entries.push({ rec, issueId });
    }
  }
  return entries;
}

async function listIssueSubIssueEntries(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<IssueSubIssueEntry[]> {
  const { records } = await ctx.issues.records.query('repo/issue/subIssue' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: IssueSubIssueEntry[] = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const issueId = getIssueSubIssueIssueId(rec, data);
    if (issueId > 0) {
      entries.push({ rec, issueId, priority: getIssueSubIssuePriority(rec, data) });
    }
  }
  entries.sort((a, b) => a.priority - b.priority || String(a.rec.dateCreated).localeCompare(String(b.rec.dateCreated)));
  return entries;
}

function inferIssueFieldValueDataType(value: string | number | string[]): IssueFieldValueDataType {
  if (Array.isArray(value)) { return 'multi_select'; }
  if (typeof value === 'number') { return 'number'; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return 'date';
  }
  return 'text';
}

function getIssueFieldValueFieldId(rec: any, data?: any): number {
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};
  const value = tags.fieldId ?? data?.fieldId;
  const fieldId = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isInteger(fieldId) && fieldId > 0 ? fieldId : 0;
}

async function listIssueFieldValueEntries(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<IssueFieldValueEntry[]> {
  const { records } = await ctx.issues.records.query('repo/issue/issueFieldValue' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: IssueFieldValueEntry[] = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const fieldId = getIssueFieldValueFieldId(rec, data);
    if (fieldId <= 0) { continue; }

    const value = data.value;
    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && !Array.isArray(value)
    ) {
      continue;
    }

    const normalizedValue = Array.isArray(value) ? value.map(item => String(item)) : value;
    const dataType = typeof data.dataType === 'string'
      ? data.dataType as IssueFieldValueDataType
      : inferIssueFieldValueDataType(normalizedValue);
    entries.push({ rec, fieldId, dataType, value: normalizedValue });
  }

  entries.sort((a, b) => a.fieldId - b.fieldId);
  return entries;
}

function findIssueByNumericId(issues: any[], issueId: number): any | undefined {
  return issues.find(issue => numericId(issue.id ?? '') === issueId);
}

async function findParentIssueForSubIssue(
  ctx: AgentContext, from: string | undefined, repoContextId: string, subIssueId: number,
): Promise<IssueParentLookup | undefined> {
  const repoIssues = await listIssueRecordsForRepo(ctx, repoContextId, from);
  for (const issue of repoIssues) {
    const entries = await listIssueSubIssueEntries(ctx, from, issue);
    const entry = entries.find(item => item.issueId === subIssueId);
    if (entry) {
      return { parent: issue, entry };
    }
  }
  return undefined;
}

async function rewriteSubIssuePriorities(entries: IssueSubIssueEntry[]): Promise<JsonResponse | undefined> {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const priority = index + 1;
    if (entry.priority === priority) { continue; }

    const { status } = await entry.rec.update({
      data : { issueId: entry.issueId, priority },
      tags : { issueId: String(entry.issueId) },
    });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to reprioritize sub-issue ${entry.issueId}: ${status.detail}`);
    }
    entry.priority = priority;
  }

  return undefined;
}

async function deleteIssueFieldValueEntries(entries: IssueFieldValueEntry[]): Promise<JsonResponse | undefined> {
  for (const entry of entries) {
    const { status } = await entry.rec.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete issue field value ${entry.fieldId}: ${status.detail}`);
    }
  }
  return undefined;
}

async function upsertIssueFieldValueEntries(
  ctx: AgentContext, issueRec: any, existing: IssueFieldValueEntry[], inputs: IssueFieldValueInput[],
): Promise<JsonResponse | undefined> {
  const entriesByField = new Map(existing.map(entry => [entry.fieldId, entry]));

  for (const input of inputs) {
    const data = { fieldId: input.fieldId, dataType: input.dataType, value: input.value };
    const tags = { fieldId: String(input.fieldId) };
    const existingEntry = entriesByField.get(input.fieldId);
    if (existingEntry) {
      const { status } = await existingEntry.rec.update({ data, tags });
      if (status.code >= 300) {
        return jsonValidationError(`Failed to update issue field value ${input.fieldId}: ${status.detail}`);
      }
      continue;
    }

    const { status } = await ctx.issues.records.create('repo/issue/issueFieldValue' as any, {
      data,
      tags,
      parentContextId: issueRec.contextId,
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to add issue field value ${input.fieldId}: ${status.detail}`);
    }
  }

  return undefined;
}

async function buildIssueAssignees(
  ctx: AgentContext, from: string | undefined, issueRec: any, baseUrl: string,
): Promise<Record<string, unknown>[]> {
  const records = await listAssignmentRecords(ctx, from, issueRec);
  const assignees = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    assignees.push(buildAssigneeResponse(rec, data, tags, baseUrl));
  }
  return assignees;
}

type LabelInput = {
  name : string;
  color : string;
  description? : string | null;
};

type MilestoneInput = {
  title : string;
  state : 'open' | 'closed';
  description : string | null;
  dueOn : string | null;
};

type AssigneeInput = {
  did : string;
  alias : string;
};

const REACTION_CONTENTS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const;
type ReactionContent = typeof REACTION_CONTENTS[number];
const REACTION_CONTENT_SET = new Set<string>(REACTION_CONTENTS);
const ISSUE_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const;
type IssueLockReason = typeof ISSUE_LOCK_REASONS[number];
const ISSUE_LOCK_REASON_SET = new Set<string>(ISSUE_LOCK_REASONS);
const MAX_ISSUE_ASSIGNEES = 10;

function normalizeLabelName(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const name = value.trim();
  return name.length > 0 ? name : null;
}

function normalizeLabelColor(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const color = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

function normalizeLabelDescription(value: unknown): string | null | JsonResponse {
  if (value === undefined || value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: description must be a string or null.');
  }
  return value;
}

function normalizeMilestoneDescriptionInput(value: unknown): string | null | JsonResponse {
  if (value === undefined || value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: description must be a string or null.');
  }
  return value;
}

function normalizeMilestoneDueOn(value: unknown): string | null | JsonResponse {
  if (value === undefined || value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: due_on must be an ISO 8601 timestamp or null.');
  }

  const dueOn = value.trim();
  if (!dueOn) { return null; }
  const timestamp = Date.parse(dueOn);
  if (Number.isNaN(timestamp)) {
    return jsonValidationError('Validation Failed: due_on must be an ISO 8601 timestamp or null.');
  }
  return new Date(timestamp).toISOString();
}

function normalizeMilestoneState(value: unknown, fallback: 'open' | 'closed'): 'open' | 'closed' | JsonResponse {
  if (value === undefined) { return fallback; }
  if (value === 'open' || value === 'closed') { return value; }
  return jsonValidationError('Validation Failed: state must be open or closed.');
}

function parseMilestoneCreateInput(reqBody: Record<string, unknown>): MilestoneInput | JsonResponse {
  const title = normalizeMilestoneTitle(reqBody.title);
  if (!title) {
    return jsonValidationError('Validation Failed: title is required.');
  }

  const state = normalizeMilestoneState(reqBody.state, 'open');
  if (typeof state !== 'string') { return state; }

  const description = normalizeMilestoneDescriptionInput(reqBody.description);
  if (typeof description !== 'string' && description !== null) {
    return description;
  }

  const dueOn = normalizeMilestoneDueOn(reqBody.due_on);
  if (typeof dueOn !== 'string' && dueOn !== null) {
    return dueOn;
  }

  return { title, state, description, dueOn };
}

function parseMilestoneUpdateInput(
  reqBody: Record<string, unknown>, existing: MilestoneEntry,
): MilestoneInput | JsonResponse {
  const title = reqBody.title === undefined ? existing.title : normalizeMilestoneTitle(reqBody.title);
  if (!title) {
    return jsonValidationError('Validation Failed: title must be a non-empty string.');
  }

  const state = normalizeMilestoneState(reqBody.state, milestoneState(existing));
  if (typeof state !== 'string') { return state; }

  const description = reqBody.description === undefined
    ? existing.description
    : normalizeMilestoneDescriptionInput(reqBody.description);
  if (typeof description !== 'string' && description !== null) {
    return description;
  }

  const dueOn = reqBody.due_on === undefined ? existing.dueOn : normalizeMilestoneDueOn(reqBody.due_on);
  if (typeof dueOn !== 'string' && dueOn !== null) {
    return dueOn;
  }

  return { title, state, description, dueOn };
}

function parseRepoLabelCreateInput(reqBody: Record<string, unknown>): LabelInput | JsonResponse {
  const name = normalizeLabelName(reqBody.name);
  if (!name) {
    return jsonValidationError('Validation Failed: name is required.');
  }

  const color = reqBody.color === undefined ? 'ededed' : normalizeLabelColor(reqBody.color);
  if (!color) {
    return jsonValidationError('Validation Failed: color must be a 6-character hex color.');
  }

  const description = normalizeLabelDescription(reqBody.description);
  if (typeof description !== 'string' && description !== null) {
    return description;
  }

  return { name, color, description };
}

function parseRepoLabelUpdateInput(
  reqBody: Record<string, unknown>, existing: RepoLabelEntry,
): LabelInput | JsonResponse {
  const name = reqBody.new_name === undefined
    ? existing.name
    : normalizeLabelName(reqBody.new_name);
  if (!name) {
    return jsonValidationError('Validation Failed: new_name must be a non-empty string.');
  }

  const existingColor = normalizeLabelColor(existing.tags.color ?? existing.data.color) ?? 'ededed';
  const color = reqBody.color === undefined ? existingColor : normalizeLabelColor(reqBody.color);
  if (!color) {
    return jsonValidationError('Validation Failed: color must be a 6-character hex color.');
  }

  const existingDescription = typeof existing.data.description === 'string' ? existing.data.description : null;
  const description = reqBody.description === undefined
    ? existingDescription
    : normalizeLabelDescription(reqBody.description);
  if (typeof description !== 'string' && description !== null) {
    return description;
  }

  return { name, color, description };
}

function parseLabelInputs(reqBody: unknown): LabelInput[] | JsonResponse {
  const raw = Array.isArray(reqBody)
    ? reqBody
    : (reqBody as Record<string, unknown>).labels;

  if (!Array.isArray(raw)) {
    return jsonValidationError('Validation Failed: labels must be an array.');
  }

  const labels: LabelInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = normalizeLabelName(
      typeof item === 'string' ? item : (item as Record<string, unknown> | undefined)?.name,
    );
    if (!name) {
      return jsonValidationError('Validation Failed: each label must have a non-empty name.');
    }

    const key = name.toLocaleLowerCase();
    if (seen.has(key)) { continue; }
    seen.add(key);

    const color = typeof item === 'object' && item !== null
      ? normalizeLabelColor((item as Record<string, unknown>).color) ?? 'ededed'
      : 'ededed';
    const description = typeof item === 'object' && item !== null
      ? normalizeLabelDescription((item as Record<string, unknown>).description)
      : null;
    if (typeof description !== 'string' && description !== null) {
      return description;
    }
    labels.push({ name, color, description });
  }

  return labels;
}

function hasAssigneeInput(reqBody: Record<string, unknown>): boolean {
  return 'assignees' in reqBody || 'assignee' in reqBody;
}

function normalizeAssigneeDid(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const did = value.trim();
  return did.length > 0 ? did : null;
}

function parseAssigneeInputs(reqBody: unknown): AssigneeInput[] | JsonResponse {
  const body = reqBody as Record<string, unknown>;
  const raw = Array.isArray(reqBody)
    ? reqBody
    : Array.isArray(body.assignees)
      ? body.assignees
      : 'assignee' in body
        ? body.assignee === null ? [] : [body.assignee]
        : undefined;

  if (!Array.isArray(raw)) {
    return jsonValidationError('Validation Failed: assignees must be an array.');
  }

  const assignees: AssigneeInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const itemObj = typeof item === 'object' && item !== null
      ? item as Record<string, unknown>
      : undefined;
    const did = normalizeAssigneeDid(
      typeof item === 'string'
        ? item
        : itemObj?.assigneeDid ?? itemObj?.did ?? itemObj?.login,
    );
    if (!did) {
      return jsonValidationError('Validation Failed: each assignee must be a non-empty DID login.');
    }

    if (seen.has(did)) { continue; }
    seen.add(did);
    assignees.push({
      did,
      alias: typeof itemObj?.alias === 'string' ? itemObj.alias : '',
    });
  }

  return assignees;
}

function issueAssigneeLimitError(): JsonResponse {
  return jsonValidationError(`Validation Failed: issues can have up to ${MAX_ISSUE_ASSIGNEES} assignees.`);
}

function validateAssigneeLimit(assignees: AssigneeInput[]): JsonResponse | undefined {
  return assignees.length > MAX_ISSUE_ASSIGNEES ? issueAssigneeLimitError() : undefined;
}

function validateMergedAssigneeLimit(existing: any[], assignees: AssigneeInput[]): JsonResponse | undefined {
  const dids = new Set<string>();
  for (const rec of existing) {
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    const did = tags.assigneeDid;
    if (did) { dids.add(did); }
  }
  for (const assignee of assignees) {
    dids.add(assignee.did);
  }
  return dids.size > MAX_ISSUE_ASSIGNEES ? issueAssigneeLimitError() : undefined;
}

export async function canMutateIssueMetadata(
  ctx: AgentContext,
  targetDid: string,
  repo: NonNullable<Awaited<ReturnType<typeof getRepoRecord>>>,
): Promise<boolean> {
  if (ctx.did === targetDid) {
    return true;
  }

  const from = fromOpt(ctx, targetDid);
  for (const role of ['repo/maintainer', 'repo/contributor'] as const) {
    const { records } = await ctx.repo.records.query(role as any, {
      from,
      filter: { contextId: repo.contextId, tags: { did: ctx.did } },
    });
    if (records.length > 0) {
      return true;
    }
  }

  return false;
}

function parseIssueLockReason(reqBody: Record<string, unknown>): IssueLockReason | null | JsonResponse {
  if (reqBody.lock_reason === undefined || reqBody.lock_reason === null) { return null; }
  if (typeof reqBody.lock_reason !== 'string' || !ISSUE_LOCK_REASON_SET.has(reqBody.lock_reason)) {
    return jsonValidationError('Validation Failed: lock_reason must be one of off-topic, too heated, resolved, or spam.');
  }
  return reqBody.lock_reason as IssueLockReason;
}

async function updateIssueLock(
  issueRec: any, locked: boolean, reason: IssueLockReason | null,
): Promise<JsonResponse | undefined> {
  const data = await issueRec.data.json();
  const tags = (issueRec.tags as Record<string, string> | undefined) ?? {};
  const updatedTags: Record<string, string> = { ...tags, locked: locked ? 'true' : 'false' };
  if (locked && reason) {
    updatedTags.lockReason = reason;
  } else {
    delete updatedTags.lockReason;
  }

  const { status } = await issueRec.update({ data, tags: updatedTags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to ${locked ? 'lock' : 'unlock'} issue: ${status.detail}`);
  }
  return undefined;
}

async function deleteLabels(labels: any[]): Promise<JsonResponse | undefined> {
  for (const label of labels) {
    const { status } = await label.delete();
    if (status.code >= 300) {
      const tags = (label.tags as Record<string, string> | undefined) ?? {};
      return jsonValidationError(`Failed to delete label '${tags.name ?? label.id}': ${status.detail}`);
    }
  }
  return undefined;
}

async function createMissingLabels(
  ctx: AgentContext, issueRec: any, existing: any[], labels: LabelInput[],
): Promise<JsonResponse | undefined> {
  const existingNames = new Set(existing.map((rec) => {
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    return (tags.name ?? '').toLocaleLowerCase();
  }));

  for (const label of labels) {
    if (existingNames.has(label.name.toLocaleLowerCase())) { continue; }
    const data = label.description === undefined
      ? { name: label.name, color: label.color }
      : { name: label.name, color: label.color, description: label.description };
    const { status } = await ctx.issues.records.create('repo/issue/label' as any, {
      data,
      tags            : { name: label.name, color: label.color },
      parentContextId : issueRec.contextId,
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to create label '${label.name}': ${status.detail}`);
    }
  }

  return undefined;
}

function labelData(label: LabelInput): Record<string, unknown> {
  return label.description === undefined
    ? { name: label.name, color: label.color }
    : { name: label.name, color: label.color, description: label.description };
}

async function createIssueLabelRecord(ctx: AgentContext, issueRec: any, label: LabelInput): Promise<JsonResponse | undefined> {
  const { status } = await ctx.issues.records.create('repo/issue/label' as any, {
    data            : labelData(label),
    tags            : { name: label.name, color: label.color },
    parentContextId : issueRec.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create label '${label.name}': ${status.detail}`);
  }
  return undefined;
}

async function replaceIssueLabelRecords(
  ctx: AgentContext, labelRecords: RepoLabelRecordEntry[], label: LabelInput,
): Promise<JsonResponse | undefined> {
  for (const entry of labelRecords) {
    const { status } = await entry.rec.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update label '${entry.name}': ${status.detail}`);
    }
    const createError = await createIssueLabelRecord(ctx, entry.issue, label);
    if (createError) { return createError; }
  }
  return undefined;
}

function labelsSettingWithChange(
  settings: RepoSettingsData, key: string, label: RepoLabelCatalogEntry | null,
): RepoSettingsData {
  const labels = { ...(settings.labels ?? {}) };
  if (label) {
    labels[key] = label;
  } else {
    delete labels[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(labels).length > 0) {
    next.labels = labels;
  } else {
    delete next.labels;
  }
  return next;
}

function milestonesSettingWithChange(
  settings: RepoSettingsData, key: string, milestone: RepoMilestoneCatalogEntry | null,
): RepoSettingsData {
  const milestones = { ...(settings.milestones ?? {}) };
  if (milestone) {
    milestones[key] = milestone;
  } else {
    delete milestones[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(milestones).length > 0) {
    next.milestones = milestones;
  } else {
    delete next.milestones;
  }
  return next;
}

async function replaceIssueMilestoneTags(
  ctx: AgentContext, from: string | undefined, repoContextId: string, oldTitle: string, newTitle: string | null,
): Promise<JsonResponse | undefined> {
  const oldKey = milestoneKey(oldTitle);
  const issues = await listIssueRecordsForRepo(ctx, repoContextId, from);

  for (const issue of issues) {
    const tags = (issue.tags as Record<string, string> | undefined) ?? {};
    if (milestoneKey(tags.milestone ?? '') !== oldKey) { continue; }

    const data = await issue.data.json();
    const updatedTags = { ...tags };
    if (newTitle) {
      updatedTags.milestone = newTitle;
    } else {
      delete updatedTags.milestone;
    }

    const { status } = await issue.update({ data, tags: updatedTags });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update issue milestone '${oldTitle}': ${status.detail}`);
    }
  }

  return undefined;
}

async function createIssueStatusChange(
  ctx: AgentContext, issueRec: any, fromStatus: string, toStatus: string, reason?: string,
): Promise<JsonResponse | undefined> {
  const data = reason ? { reason } : {};
  const { status } = await ctx.issues.records.create('repo/issue/statusChange' as any, {
    data,
    tags            : { from: fromStatus, to: toStatus },
    parentContextId : issueRec.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to record issue status change: ${status.detail}`);
  }

  return undefined;
}

async function deleteAssignments(assignments: any[]): Promise<JsonResponse | undefined> {
  for (const assignment of assignments) {
    const { status } = await assignment.delete();
    if (status.code >= 300) {
      const tags = (assignment.tags as Record<string, string> | undefined) ?? {};
      return jsonValidationError(`Failed to delete assignee '${tags.assigneeDid ?? assignment.id}': ${status.detail}`);
    }
  }
  return undefined;
}

async function createMissingAssignments(
  ctx: AgentContext, issueRec: any, existing: any[], assignees: AssigneeInput[],
): Promise<JsonResponse | undefined> {
  const existingDids = new Set(existing.map((rec) => {
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    return tags.assigneeDid ?? '';
  }));

  for (const assignee of assignees) {
    if (existingDids.has(assignee.did)) { continue; }
    const data = assignee.alias
      ? { assigneeDid: assignee.did, alias: assignee.alias }
      : { assigneeDid: assignee.did };
    const { status } = await ctx.issues.records.create('repo/issue/assignment' as any, {
      data,
      tags            : { assigneeDid: assignee.did },
      parentContextId : issueRec.contextId,
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to assign '${assignee.did}': ${status.detail}`);
    }
  }

  return undefined;
}

function parseReactionContent(value: unknown): ReactionContent | JsonResponse {
  if (typeof value !== 'string' || !REACTION_CONTENT_SET.has(value)) {
    return jsonValidationError(
      `Validation Failed: content must be one of ${REACTION_CONTENTS.map(content => `'${content}'`).join(', ')}.`,
    );
  }
  return value as ReactionContent;
}

function parseIssueDependencyId(value: unknown): number | JsonResponse {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return jsonValidationError('Validation Failed: issue_id must be a positive integer.');
  }
  return value;
}

function parseSubIssueId(value: unknown): number | JsonResponse {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return jsonValidationError('Validation Failed: sub_issue_id must be a positive integer.');
  }
  return value;
}

function parseIssueFieldValueInput(value: unknown): IssueFieldValueInput | JsonResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return jsonValidationError('Validation Failed: each issue_field_values entry must be an object.');
  }

  const item = value as Record<string, unknown>;
  const fieldId = item.field_id;
  if (typeof fieldId !== 'number' || !Number.isInteger(fieldId) || fieldId <= 0) {
    return jsonValidationError('Validation Failed: field_id must be a positive integer.');
  }

  const rawValue = item.value;
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) {
      return jsonValidationError('Validation Failed: value must be a finite number.');
    }
    return { fieldId, dataType: 'number', value: rawValue };
  }
  if (typeof rawValue === 'string') {
    return { fieldId, dataType: inferIssueFieldValueDataType(rawValue), value: rawValue };
  }
  if (Array.isArray(rawValue) && rawValue.every(entry => typeof entry === 'string')) {
    return { fieldId, dataType: 'multi_select', value: rawValue };
  }

  return jsonValidationError('Validation Failed: value must be a string, number, or string array.');
}

function parseIssueFieldValueInputs(reqBody: Record<string, unknown>): IssueFieldValueInput[] | JsonResponse {
  const values = reqBody.issue_field_values;
  if (!Array.isArray(values)) {
    return jsonValidationError('Validation Failed: issue_field_values must be an array.');
  }

  const parsed: IssueFieldValueInput[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const input = parseIssueFieldValueInput(value);
    if (!('fieldId' in input)) { return input; }
    if (seen.has(input.fieldId)) {
      return jsonValidationError('Validation Failed: duplicate field_id values are not allowed.');
    }
    seen.add(input.fieldId);
    parsed.push(input);
  }
  return parsed;
}

function parseIssueFieldId(value: string): number | JsonResponse {
  const fieldId = parseInt(value, 10);
  if (!Number.isInteger(fieldId) || fieldId <= 0) {
    return jsonValidationError('Validation Failed: issue_field_id must be a positive integer.');
  }
  return fieldId;
}

function parseOptionalSubIssuePositionId(value: unknown, name: 'after_id' | 'before_id'): number | JsonResponse | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return jsonValidationError(`Validation Failed: ${name} must be a positive integer.`);
  }
  return value;
}

function getReactionContent(rec: any, data?: any): string {
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};
  return tags.emoji ?? data?.emoji ?? '';
}

function countReactions(reactions: any[]): Record<ReactionContent, number> {
  const counts = Object.fromEntries(REACTION_CONTENTS.map(content => [content, 0])) as Record<ReactionContent, number>;
  for (const rec of reactions) {
    const content = getReactionContent(rec);
    if (REACTION_CONTENT_SET.has(content)) {
      counts[content as ReactionContent]++;
    }
  }
  return counts;
}

async function listIssueReactionRecords(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue/reaction' as any, {
    from,
    filter   : { contextId: issueRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });
  return records;
}

async function listIssueCommentReactionRecords(
  ctx: AgentContext, from: string | undefined, commentRec: any,
): Promise<any[]> {
  const { records } = await ctx.issues.records.query('repo/issue/comment/reaction' as any, {
    from,
    filter   : { contextId: commentRec.contextId },
    dateSort : DateSort.CreatedAscending,
  });
  return records;
}

function buildIssueReactionsSummary(
  targetDid: string, repoName: string, issueNumber: number, baseUrl: string, reactions: any[] = [],
): Record<string, unknown> {
  return {
    url         : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${issueNumber}/reactions`,
    total_count : reactions.length,
    ...countReactions(reactions),
  };
}

function buildIssueCommentReactionsSummary(
  targetDid: string, repoName: string, commentId: number, baseUrl: string, reactions: any[] = [],
): Record<string, unknown> {
  return {
    url         : `${baseUrl}/repos/${targetDid}/${repoName}/issues/comments/${commentId}/reactions`,
    total_count : reactions.length,
    ...countReactions(reactions),
  };
}

function buildReactionResponse(
  rec: any, data: any, baseUrl: string, fallbackAuthor: string,
): Record<string, unknown> {
  const authorDid = rec.author ?? fallbackAuthor;
  return {
    id         : numericId(rec.id ?? ''),
    node_id    : rec.id ?? '',
    user       : buildOwner(authorDid, baseUrl),
    content    : getReactionContent(rec, data),
    created_at : toISODate(rec.dateCreated),
  };
}

async function buildIssueWithChildren(
  ctx: AgentContext, from: string | undefined, issueRec: any,
  data: any, tags: Record<string, string>, targetDid: string, repoName: string, baseUrl: string,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<Record<string, unknown>> {
  const labels = await buildIssueLabels(ctx, from, issueRec, targetDid, repoName, baseUrl);
  const assignees = await buildIssueAssignees(ctx, from, issueRec, baseUrl);
  const reactions = await listIssueReactionRecords(ctx, from, issueRec);
  const milestone = await buildIssueMilestone(ctx, targetDid, repoName, baseUrl, tags.milestone);
  return buildIssueResponse(
    issueRec, data, tags, targetDid, repoName, baseUrl, labels, assignees, reactions, milestone, bodyMediaKind,
  );
}

async function buildIssueRecordWithChildren(
  ctx: AgentContext, from: string | undefined, issueRec: any,
  targetDid: string, repoName: string, baseUrl: string,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<Record<string, unknown>> {
  const data = await issueRec.data.json();
  const tags = (issueRec.tags as Record<string, string> | undefined) ?? {};
  return buildIssueWithChildren(ctx, from, issueRec, data, tags, targetDid, repoName, baseUrl, bodyMediaKind);
}

async function listIssueInboxEntries(
  ctx: AgentContext, ownerDid: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<IssueInboxEntry[]> {
  const from = fromOpt(ctx, ownerDid);
  const baseUrl = buildApiUrl(url);
  const { records: repoRecords } = await ctx.repo.records.query('repo', {
    from,
    dateSort: DateSort.CreatedAscending,
  } as any);

  const entries: IssueInboxEntry[] = [];
  for (const repoRecord of repoRecords) {
    let repoData: Record<string, unknown>;
    try {
      repoData = await repoRecord.data.json();
    } catch {
      continue;
    }

    const repoTags = (repoRecord.tags as Record<string, unknown> | undefined) ?? {};
    const repo = repoInfoFromRecord(repoRecord, repoData, repoTags);
    const repoName = repo.name;
    const { records: issueRecords } = await ctx.issues.records.query('repo/issue', {
      from,
      filter: { contextId: repo.contextId },
    });

    for (const issue of issueRecords) {
      const data = await issue.data.json();
      const tags = (issue.tags as Record<string, string> | undefined) ?? {};
      const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
        from,
        filter: { contextId: issue.contextId },
      });
      const response = await buildIssueWithChildren(
        ctx, from, issue, data, tags, ownerDid, repoName, baseUrl, bodyMediaKind,
      );
      response.comments = comments.length;
      response.repository = buildRepoResponse(repo, ownerDid, repoName, baseUrl);
      entries.push({
        ownerDid,
        repoName,
        repo,
        issue,
        data,
        tags,
        commentCount: comments.length,
        response,
      });
    }
  }

  return entries;
}

function issueInboxQuery(url: URL): {
  filter : string;
  state : string;
  labels : string[];
  sort : string;
  direction : 'asc' | 'desc';
  sinceTime : number | null;
} | JsonResponse {
  const filter = url.searchParams.get('filter') ?? 'assigned';
  if (!['assigned', 'created', 'mentioned', 'subscribed', 'repos', 'all'].includes(filter)) {
    return jsonValidationError('Validation Failed: filter must be assigned, created, mentioned, subscribed, repos, or all.');
  }

  const state = url.searchParams.get('state') ?? 'open';
  if (!['open', 'closed', 'all'].includes(state)) {
    return jsonValidationError('Validation Failed: state must be open, closed, or all.');
  }

  const sort = url.searchParams.get('sort') ?? 'created';
  if (!['created', 'updated', 'comments'].includes(sort)) {
    return jsonValidationError('Validation Failed: sort must be created, updated, or comments.');
  }

  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const since = url.searchParams.get('since');
  const sinceTime = since ? Date.parse(since) : null;
  if (since && !Number.isFinite(sinceTime)) {
    return jsonValidationError('Validation Failed: since must be an ISO 8601 timestamp.');
  }

  const labels = (url.searchParams.get('labels') ?? '')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean);

  return { filter, state, labels, sort, direction, sinceTime };
}

function userParticipatesInIssue(entry: IssueInboxEntry, userDid: string, filter: string): boolean {
  if (filter === 'all' || filter === 'repos') { return true; }

  const responseUser = entry.response.user as { login?: string } | undefined;
  const createdByUser = responseUser?.login === userDid || entry.issue.author === userDid;
  const assignees = Array.isArray(entry.response.assignees)
    ? entry.response.assignees as { login?: string }[]
    : [];
  const assignedToUser = assignees.some(assignee => assignee.login === userDid);

  if (filter === 'assigned') { return assignedToUser; }
  if (filter === 'created') { return createdByUser; }
  if (filter === 'subscribed') { return assignedToUser || createdByUser; }

  const haystack = `${entry.data.title ?? ''}\n${entry.data.body ?? ''}`.toLowerCase();
  return haystack.includes(userDid.toLowerCase());
}

function issueHasLabels(entry: IssueInboxEntry, labels: string[]): boolean {
  if (labels.length === 0) { return true; }

  const issueLabels = Array.isArray(entry.response.labels)
    ? entry.response.labels as { name?: string }[]
    : [];
  const names = new Set(issueLabels.map(label => String(label.name ?? '').toLowerCase()));
  return labels.every(label => names.has(label.toLowerCase()));
}

function filterIssueInboxEntries(
  entries: IssueInboxEntry[], userDid: string, url: URL,
): IssueInboxEntry[] | JsonResponse {
  const query = issueInboxQuery(url);
  if ('status' in query) { return query; }

  return entries.filter((entry) => {
    const state = entry.response.state;
    if (query.state !== 'all' && state !== query.state) { return false; }
    if (!userParticipatesInIssue(entry, userDid, query.filter)) { return false; }
    if (!issueHasLabels(entry, query.labels)) { return false; }
    if (query.sinceTime !== null) {
      const updated = Date.parse(String(entry.response.updated_at ?? ''));
      if (!Number.isFinite(updated) || updated <= query.sinceTime) { return false; }
    }
    return true;
  }).sort((a, b) => {
    let result: number;
    if (query.sort === 'comments') {
      result = a.commentCount - b.commentCount;
    } else {
      const key = query.sort === 'updated' ? 'updated_at' : 'created_at';
      result = String(a.response[key] ?? '').localeCompare(String(b.response[key] ?? ''));
    }
    if (result === 0) {
      result = a.repoName.localeCompare(b.repoName) || numericId(String(a.issue.id ?? '')) - numericId(String(b.issue.id ?? ''));
    }
    return query.direction === 'asc' ? result : -result;
  });
}

async function handleListIssueInbox(
  ctx: AgentContext, ownerDid: string, url: URL, path: string, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const entries = await listIssueInboxEntries(ctx, ownerDid, url, bodyMediaKind);
  const filtered = filterIssueInboxEntries(entries, ctx.did, url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const linkHeader = buildLinkHeader(buildApiUrl(url), path, pagination.page, pagination.perPage, filtered.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(entry => entry.response), extraHeaders);
}

function issueEventName(tags: Record<string, string>): string {
  if (tags.to === 'closed') { return 'closed'; }
  if (tags.from === 'closed' && tags.to === 'open') { return 'reopened'; }
  return 'updated';
}

async function buildIssueEventResponse(
  ctx: AgentContext, from: string | undefined, entry: IssueEventEntry,
  targetDid: string, repoName: string, baseUrl: string,
): Promise<Record<string, unknown>> {
  const data = await entry.event.data.json();
  const eventTags = (entry.event.tags as Record<string, string> | undefined) ?? {};
  const issueData = await entry.issue.data.json();
  const issueTags = (entry.issue.tags as Record<string, string> | undefined) ?? {};
  const id = numericId(entry.event.id ?? '');

  return {
    id,
    node_id                  : entry.event.id ?? '',
    url                      : `${baseUrl}/repos/${targetDid}/${repoName}/issues/events/${id}`,
    actor                    : buildOwner(entry.event.author ?? targetDid, baseUrl),
    event                    : issueEventName(eventTags),
    commit_id                : null,
    commit_url               : null,
    created_at               : toISODate(entry.event.dateCreated),
    performed_via_github_app : null,
    issue                    : await buildIssueWithChildren(
      ctx, from, entry.issue, issueData, issueTags, targetDid, repoName, baseUrl,
    ),
    ...(typeof data.reason === 'string' && data.reason ? { reason: data.reason } : {}),
  };
}

function buildIssueCommentResponse(
  comment: any, data: any, issueNumber: number,
  targetDid: string, repoName: string, baseUrl: string,
  reactions: any[] = [],
  bodyMediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const commentAuthor = comment.author ?? targetDid;
  const id = numericId(comment.id ?? '');
  const pinnedAt = typeof data.pinnedAt === 'string' ? data.pinnedAt : null;
  const pinnedBy = typeof data.pinnedBy === 'string' ? data.pinnedBy : commentAuthor;
  const body = typeof data.body === 'string' ? data.body : '';
  return applyBodyMedia({
    id,
    node_id            : comment.id ?? '',
    url                : `${baseUrl}/repos/${targetDid}/${repoName}/issues/comments/${id}`,
    html_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${issueNumber}#issuecomment-${id}`,
    issue_url          : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${issueNumber}`,
    created_at         : toISODate(comment.dateCreated),
    updated_at         : toISODate(comment.timestamp),
    user               : buildOwner(commentAuthor, baseUrl),
    author_association : commentAuthor === targetDid ? 'OWNER' : 'CONTRIBUTOR',
    reactions          : buildIssueCommentReactionsSummary(targetDid, repoName, id, baseUrl, reactions),
    pin                : pinnedAt
      ? {
        pinned_at : toISODate(pinnedAt),
        pinned_by : buildOwner(pinnedBy, baseUrl),
      }
      : null,
  }, body, bodyMediaKind);
}

async function buildIssueTimelineCommentResponse(
  ctx: AgentContext, from: string | undefined, entry: Extract<IssueTimelineEntry, { kind: 'comment' }>,
  targetDid: string, repoName: string, baseUrl: string,
): Promise<Record<string, unknown>> {
  const data = await entry.comment.data.json();
  const reactions = await listIssueCommentReactionRecords(ctx, from, entry.comment);
  const commentAuthor = entry.comment.author ?? targetDid;
  return {
    ...buildIssueCommentResponse(entry.comment, data, entry.issueNumber, targetDid, repoName, baseUrl, reactions),
    performed_via_github_app : null,
    event                    : 'commented',
    actor                    : buildOwner(commentAuthor, baseUrl),
  };
}

async function buildIssueTimelineEventResponse(
  ctx: AgentContext, from: string | undefined, entry: Extract<IssueTimelineEntry, { kind: 'event' }>,
  targetDid: string, repoName: string, baseUrl: string,
): Promise<Record<string, unknown>> {
  const response = await buildIssueEventResponse(ctx, from, entry, targetDid, repoName, baseUrl);
  delete response.issue;
  return response;
}

async function listIssueCommentEntries(
  ctx: AgentContext, repoContextId: string, from?: string,
): Promise<IssueCommentEntry[]> {
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repoContextId },
  });

  const entries: IssueCommentEntry[] = [];
  for (const issue of issues) {
    const issueNumber = numericId(issue.id ?? '');
    const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
      from,
      filter   : { contextId: issue.contextId },
      dateSort : DateSort.CreatedAscending,
    });
    for (const comment of comments) {
      entries.push({ issue, issueNumber, comment });
    }
  }
  return entries;
}

async function listIssueTimelineEntries(
  ctx: AgentContext, from: string | undefined, issueRec: any,
): Promise<IssueTimelineEntry[]> {
  const issueNumber = numericId(issueRec.id ?? '');
  const [{ records: comments }, events] = await Promise.all([
    ctx.issues.records.query('repo/issue/comment' as any, {
      from,
      filter   : { contextId: issueRec.contextId },
      dateSort : DateSort.CreatedAscending,
    }),
    listIssueStatusChangeRecords(ctx, from, issueRec),
  ]);

  const entries: IssueTimelineEntry[] = [];
  for (const comment of comments) {
    entries.push({
      kind      : 'comment',
      issueNumber,
      comment,
      createdAt : String(comment.dateCreated ?? ''),
      recordId  : String(comment.id ?? ''),
    });
  }
  for (const event of events) {
    entries.push({
      kind      : 'event',
      issue     : issueRec,
      issueNumber,
      event,
      createdAt : String(event.dateCreated ?? ''),
      recordId  : String(event.id ?? ''),
    });
  }

  entries.sort((a, b) => {
    const dateOrder = a.createdAt.localeCompare(b.createdAt);
    if (dateOrder !== 0) { return dateOrder; }
    const idOrder = a.recordId.localeCompare(b.recordId);
    if (idOrder !== 0) { return idOrder; }
    return a.kind.localeCompare(b.kind);
  });
  return entries;
}

async function findIssueCommentRecord(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string,
): Promise<IssueCommentLookup | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const id = parseInt(commentId, 10);
  const entries = await listIssueCommentEntries(ctx, repo.contextId, from);
  const entry = entries.find(item => numericId(item.comment.id ?? '') === id);
  if (!entry) {
    return jsonNotFound(`Issue comment #${commentId} not found.`);
  }

  return { from, entry };
}

// ---------------------------------------------------------------------------
// GET /issues, /user/issues, and /orgs/:org/issues
// ---------------------------------------------------------------------------

export async function handleListAssignedIssues(
  ctx: AgentContext, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  return handleListIssueInbox(ctx, ctx.did, url, '/issues', bodyMediaKind);
}

export async function handleListAuthenticatedUserIssues(
  ctx: AgentContext, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  return handleListIssueInbox(ctx, ctx.did, url, '/user/issues', bodyMediaKind);
}

export async function handleListOrgIssues(
  ctx: AgentContext, routeOrg: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  if (!(await orgRouteExists(ctx, routeOrg))) {
    return jsonNotFound(`Organization '${routeOrg}' not found.`);
  }

  return handleListIssueInbox(ctx, ctx.did, url, `/orgs/${routeOrg}/issues`, bodyMediaKind);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues
// ---------------------------------------------------------------------------

export async function handleListIssues(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
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
    items.push(await buildIssueWithChildren(ctx, from, rec, data, tags, targetDid, repoName, baseUrl, bodyMediaKind));
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
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Fetch comment count.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    from,
    filter: { contextId: rec.contextId },
  });

  const issue = await buildIssueWithChildren(ctx, from, rec, data, tags, targetDid, repoName, baseUrl, bodyMediaKind);
  issue.comments = comments.length;

  return jsonOk(issue);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number/comments
// ---------------------------------------------------------------------------

export async function handleListIssueComments(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);

  // Find the issue first.
  const num = parseInt(number, 10);
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId },
  });

  const issueRec = issues.find(r => numericId(r.id ?? '') === num);
  if (!issueRec) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

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
    items.push(buildIssueCommentResponse(comment, cData, num, targetDid, repoName, baseUrl, [], bodyMediaKind));
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
// GET /repos/:did/:repo/issues/comments
// ---------------------------------------------------------------------------

export async function handleListRepoIssueComments(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const direction = url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc';
  const sort = url.searchParams.get('sort') === 'updated' ? 'updated' : 'created';
  const since = url.searchParams.get('since');
  const sinceTime = since ? Date.parse(since) : NaN;

  let entries = await listIssueCommentEntries(ctx, repo.contextId, from);
  if (Number.isFinite(sinceTime)) {
    entries = entries.filter((entry) => {
      const updated = Date.parse(entry.comment.timestamp ?? entry.comment.dateCreated ?? '');
      return Number.isFinite(updated) && updated > sinceTime;
    });
  }

  entries.sort((a, b) => {
    const leftDate = sort === 'updated'
      ? a.comment.timestamp ?? a.comment.dateCreated
      : a.comment.dateCreated;
    const rightDate = sort === 'updated'
      ? b.comment.timestamp ?? b.comment.dateCreated
      : b.comment.dateCreated;
    const result = String(leftDate).localeCompare(String(rightDate));
    return direction === 'desc' ? -result : result;
  });

  const paged = paginate(entries, pagination);
  const items: Record<string, unknown>[] = [];
  for (const entry of paged) {
    const data = await entry.comment.data.json();
    items.push(buildIssueCommentResponse(
      entry.comment, data, entry.issueNumber, targetDid, repoName, baseUrl, [], bodyMediaKind,
    ));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/comments`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/events
// ---------------------------------------------------------------------------

export async function handleListRepoIssueEvents(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const entries = await listIssueEventEntries(ctx, repo.contextId, from);
  const paged = paginate(entries, pagination);

  const items: Record<string, unknown>[] = [];
  for (const entry of paged) {
    items.push(await buildIssueEventResponse(ctx, from, entry, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/events`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/events/:id
// ---------------------------------------------------------------------------

export async function handleGetIssueEvent(
  ctx: AgentContext, targetDid: string, repoName: string, eventId: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const id = parseInt(eventId, 10);
  const entries = await listIssueEventEntries(ctx, repo.contextId, from);
  const entry = entries.find(item => numericId(item.event.id ?? '') === id);
  if (!entry) {
    return jsonNotFound(`Issue event #${eventId} not found.`);
  }

  return jsonOk(await buildIssueEventResponse(ctx, from, entry, targetDid, repoName, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number/events
// ---------------------------------------------------------------------------

export async function handleListIssueEvents(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const records = await listIssueStatusChangeRecords(ctx, lookup.from, lookup.issue);
  const entries = records.map(event => ({
    event,
    issue       : lookup.issue,
    issueNumber : numericId(lookup.issue.id ?? ''),
  }));
  const paged = paginate(entries, pagination);

  const items: Record<string, unknown>[] = [];
  for (const entry of paged) {
    items.push(await buildIssueEventResponse(ctx, lookup.from, entry, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/events`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number/timeline
// ---------------------------------------------------------------------------

export async function handleListIssueTimeline(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const entries = await listIssueTimelineEntries(ctx, lookup.from, lookup.issue);
  const paged = paginate(entries, pagination);

  const items: Record<string, unknown>[] = [];
  for (const entry of paged) {
    if (entry.kind === 'comment') {
      items.push(await buildIssueTimelineCommentResponse(ctx, lookup.from, entry, targetDid, repoName, baseUrl));
    } else {
      items.push(await buildIssueTimelineEventResponse(ctx, lookup.from, entry, targetDid, repoName, baseUrl));
    }
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/timeline`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /repos/:did/:repo/issues/:number/dependencies/blocked_by
// GET /repos/:did/:repo/issues/:number/dependencies/blocking
// ---------------------------------------------------------------------------

export async function handleListIssueDependenciesBlockedBy(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const dependencies = await listIssueDependencyEntries(ctx, lookup.from, lookup.issue);
  const repoIssues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const issuesById = new Map(repoIssues.map(issue => [numericId(issue.id ?? ''), issue]));

  const blockedByIssues: any[] = [];
  for (const dependency of dependencies) {
    const issue = issuesById.get(dependency.issueId);
    if (issue) {
      blockedByIssues.push(issue);
    }
  }

  const paged = paginate(blockedByIssues, pagination);
  const items: Record<string, unknown>[] = [];
  for (const issue of paged) {
    const data = await issue.data.json();
    const tags = (issue.tags as Record<string, string> | undefined) ?? {};
    items.push(await buildIssueWithChildren(ctx, lookup.from, issue, data, tags, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/dependencies/blocked_by`,
    pagination.page, pagination.perPage, blockedByIssues.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleAddIssueDependencyBlockedBy(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const issueId = parseIssueDependencyId(reqBody.issue_id);
  if (typeof issueId !== 'number') { return issueId; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const currentIssueId = numericId(lookup.issue.id ?? '');
  if (issueId === currentIssueId) {
    return jsonValidationError('Validation Failed: an issue cannot depend on itself.');
  }

  const repoIssues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const blockingIssue = repoIssues.find(issue => numericId(issue.id ?? '') === issueId);
  if (!blockingIssue) {
    return jsonNotFound(`Issue id ${issueId} not found.`);
  }

  const existing = await listIssueDependencyEntries(ctx, undefined, lookup.issue);
  if (existing.some(entry => entry.issueId === issueId)) {
    return jsonValidationError('Validation Failed: issue dependency already exists.');
  }

  const { status } = await ctx.issues.records.create('repo/issue/issueDependency' as any, {
    data            : { issueId },
    tags            : { issueId: String(issueId) },
    parentContextId : lookup.issue.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to add issue dependency: ${status.detail}`);
  }

  const data = await lookup.issue.data.json();
  const tags = (lookup.issue.tags as Record<string, string> | undefined) ?? {};
  const issue = await buildIssueWithChildren(
    ctx, undefined, lookup.issue, data, tags, targetDid, repoName, buildApiUrl(url),
  );
  return jsonCreated(issue);
}

export async function handleRemoveIssueDependencyBlockedBy(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, issueIdValue: string, url: URL,
): Promise<JsonResponse> {
  const issueId = parseIssueDependencyId(parseInt(issueIdValue, 10));
  if (typeof issueId !== 'number') { return issueId; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const existing = await listIssueDependencyEntries(ctx, undefined, lookup.issue);
  const dependency = existing.find(entry => entry.issueId === issueId);
  if (!dependency) {
    return jsonNotFound(`Issue dependency ${issueId} not found.`);
  }

  const { status } = await dependency.rec.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to remove issue dependency: ${status.detail}`);
  }

  const data = await lookup.issue.data.json();
  const tags = (lookup.issue.tags as Record<string, string> | undefined) ?? {};
  const issue = await buildIssueWithChildren(
    ctx, undefined, lookup.issue, data, tags, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(issue);
}

export async function handleListIssueDependenciesBlocking(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const targetIssueId = numericId(lookup.issue.id ?? '');
  const repoIssues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const blockingIssues: any[] = [];

  for (const issue of repoIssues) {
    const dependencies = await listIssueDependencyEntries(ctx, lookup.from, issue);
    if (dependencies.some(entry => entry.issueId === targetIssueId)) {
      blockingIssues.push(issue);
    }
  }
  blockingIssues.sort((a, b) => numericId(a.id ?? '') - numericId(b.id ?? ''));

  const pagination = parsePagination(url);
  const paged = paginate(blockingIssues, pagination);
  const items: Record<string, unknown>[] = [];
  for (const issue of paged) {
    const data = await issue.data.json();
    const tags = (issue.tags as Record<string, string> | undefined) ?? {};
    items.push(await buildIssueWithChildren(ctx, lookup.from, issue, data, tags, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/dependencies/blocking`,
    pagination.page, pagination.perPage, blockingIssues.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issues/:number/parent
// GET/POST /repos/:did/:repo/issues/:number/sub_issues
// DELETE /repos/:did/:repo/issues/:number/sub_issue
// PATCH /repos/:did/:repo/issues/:number/sub_issues/priority
// ---------------------------------------------------------------------------

export async function handleGetIssueParent(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const issueId = numericId(lookup.issue.id ?? '');
  const parent = await findParentIssueForSubIssue(ctx, lookup.from, lookup.repo.contextId, issueId);
  if (!parent) {
    return jsonNotFound(`Parent issue for issue #${number} not found.`);
  }

  return jsonOk(await buildIssueRecordWithChildren(
    ctx, lookup.from, parent.parent, targetDid, repoName, buildApiUrl(url),
  ));
}

export async function handleListIssueSubIssues(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const entries = await listIssueSubIssueEntries(ctx, lookup.from, lookup.issue);
  const repoIssues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const issuesById = new Map(repoIssues.map(issue => [numericId(issue.id ?? ''), issue]));
  const subIssues = entries
    .map(entry => issuesById.get(entry.issueId))
    .filter((issue): issue is any => Boolean(issue));

  const paged = paginate(subIssues, pagination);
  const items: Record<string, unknown>[] = [];
  for (const issue of paged) {
    items.push(await buildIssueRecordWithChildren(ctx, lookup.from, issue, targetDid, repoName, baseUrl));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/sub_issues`,
    pagination.page, pagination.perPage, subIssues.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleAddIssueSubIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const subIssueId = parseSubIssueId(reqBody.sub_issue_id);
  if (typeof subIssueId !== 'number') { return subIssueId; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const parentIssueId = numericId(lookup.issue.id ?? '');
  if (subIssueId === parentIssueId) {
    return jsonValidationError('Validation Failed: an issue cannot be its own sub-issue.');
  }

  const repoIssues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const subIssue = findIssueByNumericId(repoIssues, subIssueId);
  if (!subIssue) {
    return jsonNotFound(`Sub-issue id ${subIssueId} not found.`);
  }

  const existing = await listIssueSubIssueEntries(ctx, undefined, lookup.issue);
  if (existing.some(entry => entry.issueId === subIssueId)) {
    return jsonValidationError('Validation Failed: sub-issue already exists under this parent.');
  }

  const previousParent = await findParentIssueForSubIssue(ctx, undefined, lookup.repo.contextId, subIssueId);
  if (previousParent) {
    if (reqBody.replace_parent !== true) {
      return jsonValidationError('Validation Failed: sub-issue already has a parent.');
    }
    const { status } = await previousParent.entry.rec.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to replace sub-issue parent: ${status.detail}`);
    }
  }

  const priority = existing.reduce((max, entry) => Math.max(max, entry.priority), 0) + 1;
  const { status } = await ctx.issues.records.create('repo/issue/subIssue' as any, {
    data            : { issueId: subIssueId, priority },
    tags            : { issueId: String(subIssueId) },
    parentContextId : lookup.issue.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to add sub-issue: ${status.detail}`);
  }

  return jsonCreated(await buildIssueRecordWithChildren(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  ));
}

export async function handleRemoveIssueSubIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const subIssueId = parseSubIssueId(reqBody.sub_issue_id);
  if (typeof subIssueId !== 'number') { return subIssueId; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const entries = await listIssueSubIssueEntries(ctx, undefined, lookup.issue);
  const entry = entries.find(item => item.issueId === subIssueId);
  if (!entry) {
    return jsonNotFound(`Sub-issue id ${subIssueId} not found under issue #${number}.`);
  }

  const { status } = await entry.rec.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to remove sub-issue: ${status.detail}`);
  }

  const priorityError = await rewriteSubIssuePriorities(entries.filter(item => item !== entry));
  if (priorityError) { return priorityError; }

  return jsonOk(await buildIssueRecordWithChildren(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  ));
}

export async function handleReprioritizeIssueSubIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const subIssueId = parseSubIssueId(reqBody.sub_issue_id);
  if (typeof subIssueId !== 'number') { return subIssueId; }

  const afterId = parseOptionalSubIssuePositionId(reqBody.after_id, 'after_id');
  if (afterId && typeof afterId !== 'number') { return afterId; }
  const beforeId = parseOptionalSubIssuePositionId(reqBody.before_id, 'before_id');
  if (beforeId && typeof beforeId !== 'number') { return beforeId; }

  if ((afterId === undefined && beforeId === undefined) || (afterId !== undefined && beforeId !== undefined)) {
    return jsonValidationError('Validation Failed: specify exactly one of after_id or before_id.');
  }
  if (afterId === subIssueId || beforeId === subIssueId) {
    return jsonValidationError('Validation Failed: sub_issue_id cannot match after_id or before_id.');
  }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const entries = await listIssueSubIssueEntries(ctx, undefined, lookup.issue);
  const movingIndex = entries.findIndex(entry => entry.issueId === subIssueId);
  if (movingIndex === -1) {
    return jsonNotFound(`Sub-issue id ${subIssueId} not found under issue #${number}.`);
  }

  const positionId = afterId ?? beforeId;
  const positionIndex = entries.findIndex(entry => entry.issueId === positionId);
  if (positionIndex === -1) {
    return jsonNotFound(`Sub-issue id ${positionId} not found under issue #${number}.`);
  }

  const [moving] = entries.splice(movingIndex, 1);
  const targetIndex = entries.findIndex(entry => entry.issueId === positionId);
  entries.splice(afterId !== undefined ? targetIndex + 1 : targetIndex, 0, moving);

  const priorityError = await rewriteSubIssuePriorities(entries);
  if (priorityError) { return priorityError; }

  return jsonOk(await buildIssueRecordWithChildren(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  ));
}

// ---------------------------------------------------------------------------
// GET/POST/PUT/DELETE /repos/:did/:repo/issues/:number/issue-field-values
// ---------------------------------------------------------------------------

export async function handleListIssueFieldValues(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const pagination = parsePagination(url);
  const entries = await listIssueFieldValueEntries(ctx, lookup.from, lookup.issue);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(
    buildApiUrl(url), `/repos/${targetDid}/${repoName}/issues/${number}/issue-field-values`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(paged.map(buildIssueFieldValueResponse), extraHeaders);
}

export async function handleAddIssueFieldValues(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const parsed = parseIssueFieldValueInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const existing = await listIssueFieldValueEntries(ctx, undefined, lookup.issue);
  if (parsed.length === 0) {
    const deleteError = await deleteIssueFieldValueEntries(existing);
    if (deleteError) { return deleteError; }
  } else {
    const upsertError = await upsertIssueFieldValueEntries(ctx, lookup.issue, existing, parsed);
    if (upsertError) { return upsertError; }
  }

  const entries = await listIssueFieldValueEntries(ctx, undefined, lookup.issue);
  return jsonOk(entries.map(buildIssueFieldValueResponse));
}

export async function handleSetIssueFieldValues(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const parsed = parseIssueFieldValueInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const existing = await listIssueFieldValueEntries(ctx, undefined, lookup.issue);
  const deleteError = await deleteIssueFieldValueEntries(existing);
  if (deleteError) { return deleteError; }

  const upsertError = await upsertIssueFieldValueEntries(ctx, lookup.issue, [], parsed);
  if (upsertError) { return upsertError; }

  const entries = await listIssueFieldValueEntries(ctx, undefined, lookup.issue);
  return jsonOk(entries.map(buildIssueFieldValueResponse));
}

export async function handleDeleteIssueFieldValue(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, fieldIdValue: string,
): Promise<JsonResponse> {
  const fieldId = parseIssueFieldId(fieldIdValue);
  if (typeof fieldId !== 'number') { return fieldId; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const entries = await listIssueFieldValueEntries(ctx, undefined, lookup.issue);
  const entry = entries.find(item => item.fieldId === fieldId);
  if (!entry) {
    return jsonNotFound(`Issue field value ${fieldId} not found.`);
  }

  const deleteError = await deleteIssueFieldValueEntries([entry]);
  if (deleteError) { return deleteError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST /repos/:did/:repo/labels
// ---------------------------------------------------------------------------

export async function handleListRepoLabels(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listRepoLabelEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const items = paged.map(entry => buildLabelResponse(
    entry.rec, entry.data, entry.tags, targetDid, repoName, baseUrl,
  ));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/labels`,
    pagination.page, pagination.perPage, entries.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCreateRepoLabel(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = parseRepoLabelCreateInput(reqBody);
  if ('status' in parsed) { return parsed; }

  const entries = await listRepoLabelEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const key = labelKey(parsed.name);
  if (entries.some(entry => labelKey(entry.name) === key)) {
    return jsonValidationError(`Validation Failed: label '${parsed.name}' already exists.`);
  }

  const now = new Date().toISOString();
  const label: RepoLabelCatalogEntry = {
    name        : parsed.name,
    color       : parsed.color,
    description : parsed.description ?? null,
    createdAt   : now,
    updatedAt   : now,
  };

  const saveError = await saveRepoSettings(ctx, lookup, labelsSettingWithChange(lookup.settings, key, label));
  if (saveError) { return saveError; }

  const entry = catalogLabelEntry(key, label);
  if (!entry) {
    return jsonValidationError('Failed to create repository label.');
  }
  return jsonCreated(buildLabelResponse(entry.rec, entry.data, entry.tags, targetDid, repoName, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /repos/:did/:repo/labels/:name
// ---------------------------------------------------------------------------

export async function handleGetRepoLabel(
  ctx: AgentContext, targetDid: string, repoName: string, labelName: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listRepoLabelEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const decodedLabelName = decodeLabelName(labelName);
  const label = entries.find(entry => entry.name.toLocaleLowerCase() === decodedLabelName.toLocaleLowerCase());
  if (!label) {
    return jsonNotFound(`Label '${decodedLabelName}' not found.`);
  }

  return jsonOk(buildLabelResponse(label.rec, label.data, label.tags, targetDid, repoName, buildApiUrl(url)));
}

export async function handleUpdateRepoLabel(
  ctx: AgentContext, targetDid: string, repoName: string,
  labelName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const entries = await listRepoLabelEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const decodedLabelName = decodeLabelName(labelName);
  const oldKey = labelKey(decodedLabelName);
  const existing = entries.find(entry => labelKey(entry.name) === oldKey);
  if (!existing) {
    return jsonNotFound(`Label '${decodedLabelName}' not found.`);
  }

  const parsed = parseRepoLabelUpdateInput(reqBody, existing);
  if ('status' in parsed) { return parsed; }

  const newKey = labelKey(parsed.name);
  if (newKey !== oldKey && entries.some(entry => labelKey(entry.name) === newKey)) {
    return jsonValidationError(`Validation Failed: label '${parsed.name}' already exists.`);
  }

  const now = new Date().toISOString();
  const previous = lookup.settings.labels?.[oldKey];
  const label: RepoLabelCatalogEntry = {
    name        : parsed.name,
    color       : parsed.color,
    description : parsed.description ?? null,
    createdAt   : previous?.createdAt ?? String(existing.rec.dateCreated ?? existing.updatedAt ?? now),
    updatedAt   : now,
  };

  let settings = labelsSettingWithChange(lookup.settings, oldKey, null);
  settings = labelsSettingWithChange(settings, newKey, label);
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  const records = await listRepoLabelRecords(ctx, fromOpt(ctx, targetDid), lookup.repo.contextId);
  const matchingRecords = records.filter(entry => labelKey(entry.name) === oldKey);
  const replaceError = await replaceIssueLabelRecords(ctx, matchingRecords, parsed);
  if (replaceError) { return replaceError; }

  const entry = catalogLabelEntry(newKey, label);
  if (!entry) {
    return jsonValidationError('Failed to update repository label.');
  }
  return jsonOk(buildLabelResponse(entry.rec, entry.data, entry.tags, targetDid, repoName, buildApiUrl(url)));
}

export async function handleDeleteRepoLabel(
  ctx: AgentContext, targetDid: string, repoName: string, labelName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const entries = await listRepoLabelEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const decodedLabelName = decodeLabelName(labelName);
  const key = labelKey(decodedLabelName);
  const existing = entries.find(entry => labelKey(entry.name) === key);
  if (!existing) {
    return jsonNotFound(`Label '${decodedLabelName}' not found.`);
  }

  if (lookup.settings.labels?.[key]) {
    const saveError = await saveRepoSettings(ctx, lookup, labelsSettingWithChange(lookup.settings, key, null));
    if (saveError) { return saveError; }
  }

  const records = await listRepoLabelRecords(ctx, fromOpt(ctx, targetDid), lookup.repo.contextId);
  const deleteError = await deleteLabels(records.filter(entry => labelKey(entry.name) === key).map(entry => entry.rec));
  if (deleteError) { return deleteError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/milestones
// ---------------------------------------------------------------------------

export async function handleListMilestones(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listMilestoneEntries(ctx, targetDid, repoName);
  if (!Array.isArray(entries)) { return entries; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const filtered = sortMilestoneEntries(entries, url);
  const paged = paginate(filtered, pagination);
  const items = paged.map(entry => buildMilestoneResponse(entry, targetDid, repoName, baseUrl));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/milestones`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCreateMilestone(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = parseMilestoneCreateInput(reqBody);
  if ('status' in parsed) { return parsed; }

  const from = fromOpt(ctx, targetDid);
  const entries = await listMilestoneEntriesForRepo(ctx, lookup.repo.contextId, from, lookup.settings);
  const key = milestoneKey(parsed.title);
  if (entries.some(entry => milestoneKey(entry.title) === key)) {
    return jsonValidationError(`Validation Failed: milestone '${parsed.title}' already exists.`);
  }

  const now = new Date().toISOString();
  const milestone: RepoMilestoneCatalogEntry = {
    title       : parsed.title,
    number      : nextMilestoneNumber(entries),
    state       : parsed.state,
    description : parsed.description,
    dueOn       : parsed.dueOn,
    createdAt   : now,
    updatedAt   : now,
    closedAt    : parsed.state === 'closed' ? now : null,
  };

  const saveError = await saveRepoSettings(ctx, lookup, milestonesSettingWithChange(lookup.settings, key, milestone));
  if (saveError) { return saveError; }

  const entry = catalogMilestoneEntry(key, milestone);
  if (!entry) {
    return jsonValidationError('Failed to create milestone.');
  }

  return jsonCreated(buildMilestoneResponse(entry, targetDid, repoName, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /repos/:did/:repo/milestones/:number
// ---------------------------------------------------------------------------

export async function handleGetMilestone(
  ctx: AgentContext, targetDid: string, repoName: string, milestoneNumberValue: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findMilestoneEntry(ctx, targetDid, repoName, milestoneNumberValue);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildMilestoneResponse(lookup.milestone, targetDid, repoName, buildApiUrl(url)));
}

export async function handleUpdateMilestone(
  ctx: AgentContext, targetDid: string, repoName: string,
  milestoneNumberValue: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const from = fromOpt(ctx, targetDid);
  const entries = await listMilestoneEntriesForRepo(ctx, lookup.repo.contextId, from, lookup.settings);
  const number = parseInt(milestoneNumberValue, 10);
  const existing = entries.find(entry => entry.number === number);
  if (!existing) {
    return jsonNotFound(`Milestone #${milestoneNumberValue} not found.`);
  }

  const parsed = parseMilestoneUpdateInput(reqBody, existing);
  if ('status' in parsed) { return parsed; }

  const oldKey = milestoneKey(existing.title);
  const newKey = milestoneKey(parsed.title);
  if (newKey !== oldKey && entries.some(entry => milestoneKey(entry.title) === newKey)) {
    return jsonValidationError(`Validation Failed: milestone '${parsed.title}' already exists.`);
  }

  const previous = lookup.settings.milestones?.[oldKey];
  const now = new Date().toISOString();
  const previousState = milestoneState(existing);
  const milestone: RepoMilestoneCatalogEntry = {
    title       : parsed.title,
    number      : existing.number,
    state       : parsed.state,
    description : parsed.description,
    dueOn       : parsed.dueOn,
    createdAt   : previous?.createdAt ?? existing.createdAt,
    updatedAt   : now,
    closedAt    : parsed.state === 'closed'
      ? previousState === 'closed' ? existing.closedAt ?? previous?.closedAt ?? now : now
      : null,
  };

  let settings = milestonesSettingWithChange(lookup.settings, oldKey, null);
  settings = milestonesSettingWithChange(settings, newKey, milestone);
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  if (newKey !== oldKey) {
    const replaceError = await replaceIssueMilestoneTags(ctx, from, lookup.repo.contextId, existing.title, parsed.title);
    if (replaceError) { return replaceError; }
  }

  const entry = catalogMilestoneEntry(newKey, milestone);
  if (!entry) {
    return jsonValidationError('Failed to update milestone.');
  }
  entry.openIssues = existing.openIssues;
  entry.closedIssues = existing.closedIssues;

  return jsonOk(buildMilestoneResponse(entry, targetDid, repoName, buildApiUrl(url)));
}

export async function handleDeleteMilestone(
  ctx: AgentContext, targetDid: string, repoName: string, milestoneNumberValue: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const from = fromOpt(ctx, targetDid);
  const entries = await listMilestoneEntriesForRepo(ctx, lookup.repo.contextId, from, lookup.settings);
  const number = parseInt(milestoneNumberValue, 10);
  const existing = entries.find(entry => entry.number === number);
  if (!existing) {
    return jsonNotFound(`Milestone #${milestoneNumberValue} not found.`);
  }

  const key = milestoneKey(existing.title);
  if (lookup.settings.milestones?.[key]) {
    const saveError = await saveRepoSettings(ctx, lookup, milestonesSettingWithChange(lookup.settings, key, null));
    if (saveError) { return saveError; }
  }

  const replaceError = await replaceIssueMilestoneTags(ctx, from, lookup.repo.contextId, existing.title, null);
  if (replaceError) { return replaceError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/milestones/:number/labels
// ---------------------------------------------------------------------------

export async function handleListMilestoneLabels(
  ctx: AgentContext, targetDid: string, repoName: string, milestoneNumberValue: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findMilestoneEntry(ctx, targetDid, repoName, milestoneNumberValue);
  if ('status' in lookup) { return lookup; }

  const issues = await listIssueRecordsForRepo(ctx, lookup.repo.contextId, lookup.from);
  const labelsByName = new Map<string, RepoLabelEntry>();
  for (const issue of issues) {
    const issueTags = (issue.tags as Record<string, string> | undefined) ?? {};
    if (milestoneKey(issueTags.milestone ?? '') !== milestoneKey(lookup.milestone.title)) { continue; }

    const labelRecords = await listLabelRecords(ctx, lookup.from, issue);
    for (const rec of labelRecords) {
      const data = await rec.data.json();
      const tags = (rec.tags as Record<string, string> | undefined) ?? {};
      const name = normalizeLabelName(tags.name ?? data.name);
      if (!name) { continue; }

      const entry = {
        rec,
        data,
        tags      : { ...tags, name },
        name,
        updatedAt : String(rec.timestamp ?? rec.dateCreated ?? ''),
      };
      const key = name.toLocaleLowerCase();
      const existing = labelsByName.get(key);
      if (!existing || entry.updatedAt.localeCompare(existing.updatedAt) >= 0) {
        labelsByName.set(key, entry);
      }
    }
  }

  const baseUrl = buildApiUrl(url);
  const entries = [...labelsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const items = paged.map(entry => buildLabelResponse(
    entry.rec, entry.data, entry.tags, targetDid, repoName, baseUrl,
  ));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/milestones/${milestoneNumberValue}/labels`,
    pagination.page, pagination.perPage, entries.length,
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
  bodyMediaKind?: BodyMediaKind | null,
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
  const baseUrl = buildApiUrl(url);
  const hasMutableMetadata = 'labels' in reqBody || hasAssigneeInput(reqBody) || 'milestone' in reqBody;
  const canWriteMetadata = hasMutableMetadata
    ? await canMutateIssueMetadata(ctx, targetDid, repo)
    : false;
  const parsedLabels = 'labels' in reqBody && canWriteMetadata ? parseLabelInputs(reqBody) : undefined;
  if (parsedLabels && !Array.isArray(parsedLabels)) { return parsedLabels; }
  const parsedAssignees = hasAssigneeInput(reqBody) && canWriteMetadata ? parseAssigneeInputs(reqBody) : undefined;
  if (parsedAssignees && !Array.isArray(parsedAssignees)) { return parsedAssignees; }
  if (parsedAssignees) {
    const assigneeLimitError = validateAssigneeLimit(parsedAssignees);
    if (assigneeLimitError) { return assigneeLimitError; }
  }
  const parsedMilestone = 'milestone' in reqBody && canWriteMetadata
    ? await parseMilestoneInput(ctx, targetDid, repoName, reqBody.milestone)
    : undefined;
  if (typeof parsedMilestone === 'object' && parsedMilestone !== null) { return parsedMilestone; }

  const issueTags: Record<string, string> = { status: 'open' };
  if (typeof parsedMilestone === 'string') {
    issueTags.milestone = parsedMilestone;
  }

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body },
    tags            : issueTags,
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create issue: ${status.detail}`);
  }
  if (!record) {throw new Error('Failed to create issue record');}

  const data = await record.data.json();
  if (parsedLabels) {
    const labelError = await createMissingLabels(ctx, record, [], parsedLabels);
    if (labelError) { return labelError; }
  }
  if (parsedAssignees) {
    const assignmentError = await createMissingAssignments(ctx, record, [], parsedAssignees);
    if (assignmentError) { return assignmentError; }
  }
  const issue = await buildIssueWithChildren(
    ctx, undefined, record, data, issueTags, targetDid, repoName, baseUrl, bodyMediaKind,
  );

  return jsonCreated(issue);
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/issues/:number — update issue
// ---------------------------------------------------------------------------

export async function handleUpdateIssue(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Apply updates.
  const newTitle = (reqBody.title as string | undefined) ?? data.title;
  const newBody = (reqBody.body as string | undefined) ?? data.body;
  const hasMutableMetadata = 'labels' in reqBody || hasAssigneeInput(reqBody) || 'milestone' in reqBody;
  const canWriteMetadata = hasMutableMetadata
    ? await canMutateIssueMetadata(ctx, targetDid, repo)
    : false;
  const parsedLabels = 'labels' in reqBody && canWriteMetadata ? parseLabelInputs(reqBody) : undefined;
  if (parsedLabels && !Array.isArray(parsedLabels)) { return parsedLabels; }
  const parsedAssignees = hasAssigneeInput(reqBody) && canWriteMetadata ? parseAssigneeInputs(reqBody) : undefined;
  if (parsedAssignees && !Array.isArray(parsedAssignees)) { return parsedAssignees; }
  if (parsedAssignees) {
    const assigneeLimitError = validateAssigneeLimit(parsedAssignees);
    if (assigneeLimitError) { return assigneeLimitError; }
  }
  const parsedMilestone = 'milestone' in reqBody && canWriteMetadata
    ? await parseMilestoneInput(ctx, targetDid, repoName, reqBody.milestone)
    : undefined;
  if (typeof parsedMilestone === 'object' && parsedMilestone !== null) { return parsedMilestone; }

  // GitHub API uses "state" (open/closed), DWN uses "status" tag.
  const previousStatus = tags.status === 'closed' ? 'closed' : 'open';
  let newStatus = previousStatus;
  if (reqBody.state === 'closed') { newStatus = 'closed'; }
  if (reqBody.state === 'open') { newStatus = 'open'; }

  const updatedTags: Record<string, string> = { ...tags, status: newStatus };
  if ('milestone' in reqBody && canWriteMetadata) {
    if (typeof parsedMilestone === 'string') {
      updatedTags.milestone = parsedMilestone;
    } else {
      delete updatedTags.milestone;
    }
  }

  const { status } = await rec.update({
    data : { title: newTitle, body: newBody },
    tags : updatedTags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update issue: ${status.detail}`);
  }

  const updatedData = { title: newTitle, body: newBody };
  if (newStatus !== previousStatus) {
    const reason = typeof reqBody.state_reason === 'string'
      ? reqBody.state_reason
      : typeof reqBody.reason === 'string'
        ? reqBody.reason
        : undefined;
    const eventError = await createIssueStatusChange(ctx, rec, previousStatus, newStatus, reason);
    if (eventError) { return eventError; }
  }
  if (parsedLabels) {
    const existing = await listLabelRecords(ctx, undefined, rec);
    const deleteError = await deleteLabels(existing);
    if (deleteError) { return deleteError; }
    const createError = await createMissingLabels(ctx, rec, [], parsedLabels);
    if (createError) { return createError; }
  }
  if (parsedAssignees) {
    const existing = await listAssignmentRecords(ctx, undefined, rec);
    const deleteError = await deleteAssignments(existing);
    if (deleteError) { return deleteError; }
    const createError = await createMissingAssignments(ctx, rec, [], parsedAssignees);
    if (createError) { return createError; }
  }

  const issue = await buildIssueWithChildren(
    ctx, undefined, rec, updatedData, updatedTags, targetDid, repoName, baseUrl, bodyMediaKind,
  );

  return jsonOk(issue);
}

// ---------------------------------------------------------------------------
// PUT/DELETE /repos/:did/:repo/issues/:number/lock — lock/unlock issue
// ---------------------------------------------------------------------------

export async function handleLockIssue(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const reason = parseIssueLockReason(reqBody);
  if (reason && typeof reason !== 'string') { return reason; }

  const updateError = await updateIssueLock(lookup.issue, true, reason);
  if (updateError) { return updateError; }

  return jsonNoContent();
}

export async function handleUnlockIssue(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const updateError = await updateIssueLock(lookup.issue, false, null);
  if (updateError) { return updateError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/issues/:number/comments — create comment
// ---------------------------------------------------------------------------

export async function handleCreateIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const baseUrl = buildApiUrl(url);

  // Find the issue.
  const num = parseInt(number, 10);
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId },
  });

  const issueRec = issues.find(r => numericId(r.id ?? '') === num);
  if (!issueRec) {
    return jsonNotFound(`Issue #${number} not found.`);
  }

  const { status, record: commentRec } = await ctx.issues.records.create('repo/issue/comment' as any, {
    data            : { body },
    parentContextId : issueRec.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create comment: ${status.detail}`);
  }
  if (!commentRec) {throw new Error('Failed to create comment record');}

  const data = await commentRec.data.json();
  return jsonCreated(buildIssueCommentResponse(commentRec, data, num, targetDid, repoName, baseUrl, [], bodyMediaKind));
}

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /repos/:did/:repo/issues/comments/:id
// ---------------------------------------------------------------------------

export async function handleGetIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const data = await lookup.entry.comment.data.json();
  const reactions = await listIssueCommentReactionRecords(ctx, lookup.from, lookup.entry.comment);
  return jsonOk(buildIssueCommentResponse(
    lookup.entry.comment, data, lookup.entry.issueNumber, targetDid, repoName, buildApiUrl(url), reactions, bodyMediaKind,
  ));
}

export async function handleUpdateIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string,
  commentId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const currentData = await lookup.entry.comment.data.json();
  const nextData = { ...currentData, body };
  const { status } = await lookup.entry.comment.update({ data: nextData });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update issue comment: ${status.detail}`);
  }

  return jsonOk(buildIssueCommentResponse(
    lookup.entry.comment,
    nextData,
    lookup.entry.issueNumber,
    targetDid,
    repoName,
    buildApiUrl(url),
    await listIssueCommentReactionRecords(ctx, lookup.from, lookup.entry.comment),
    bodyMediaKind,
  ));
}

export async function handleDeleteIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const { status } = await lookup.entry.comment.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete issue comment: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handlePinIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const currentData = await lookup.entry.comment.data.json();
  const pinnedAt = new Date().toISOString();
  const nextData = { ...currentData, pinnedAt, pinnedBy: ctx.did };
  const { status } = await lookup.entry.comment.update({ data: nextData });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to pin issue comment: ${status.detail}`);
  }

  return jsonOk(buildIssueCommentResponse(
    lookup.entry.comment,
    nextData,
    lookup.entry.issueNumber,
    targetDid,
    repoName,
    buildApiUrl(url),
    await listIssueCommentReactionRecords(ctx, lookup.from, lookup.entry.comment),
    bodyMediaKind,
  ));
}

export async function handleUnpinIssueComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const currentData = await lookup.entry.comment.data.json();
  const nextData = { ...currentData };
  delete nextData.pinnedAt;
  delete nextData.pinnedBy;
  const { status } = await lookup.entry.comment.update({ data: nextData });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unpin issue comment: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /repos/:did/:repo/issues/:number/reactions
// ---------------------------------------------------------------------------

export async function handleListIssueReactions(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const contentFilter = url.searchParams.get('content');
  if (contentFilter !== null) {
    const parsed = parseReactionContent(contentFilter);
    if (typeof parsed !== 'string') { return parsed; }
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const records = await listIssueReactionRecords(ctx, lookup.from, lookup.issue);
  const filtered = contentFilter === null
    ? records
    : records.filter(rec => getReactionContent(rec) === contentFilter);
  const paged = paginate(filtered, pagination);

  const items: Record<string, unknown>[] = [];
  for (const rec of paged) {
    const data = await rec.data.json();
    items.push(buildReactionResponse(rec, data, baseUrl, targetDid));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/${number}/reactions`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCreateIssueReaction(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const content = parseReactionContent(reqBody.content);
  if (typeof content !== 'string') { return content; }

  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const existing = await listIssueReactionRecords(ctx, undefined, lookup.issue);
  const duplicate = existing.find((rec) => {
    const authorDid = rec.author ?? ctx.did;
    return authorDid === ctx.did && getReactionContent(rec) === content;
  });
  if (duplicate) {
    const data = await duplicate.data.json();
    return jsonOk(buildReactionResponse(duplicate, data, baseUrl, targetDid));
  }

  const { status, record } = await ctx.issues.records.create('repo/issue/reaction' as any, {
    data            : { emoji: content },
    tags            : { emoji: content },
    parentContextId : lookup.issue.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create issue reaction: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create issue reaction record'); }

  const data = await record.data.json();
  return jsonCreated(buildReactionResponse(record, data, baseUrl, targetDid));
}

export async function handleDeleteIssueReaction(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reactionId: string,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const id = parseInt(reactionId, 10);
  const records = await listIssueReactionRecords(ctx, undefined, lookup.issue);
  const reaction = records.find(rec => numericId(rec.id ?? '') === id);
  if (!reaction) {
    return jsonNotFound(`Reaction #${reactionId} not found on issue #${number}.`);
  }

  const { status } = await reaction.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete issue reaction: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /repos/:did/:repo/issues/comments/:id/reactions
// ---------------------------------------------------------------------------

export async function handleListIssueCommentReactions(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const contentFilter = url.searchParams.get('content');
  if (contentFilter !== null) {
    const parsed = parseReactionContent(contentFilter);
    if (typeof parsed !== 'string') { return parsed; }
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const records = await listIssueCommentReactionRecords(ctx, lookup.from, lookup.entry.comment);
  const filtered = contentFilter === null
    ? records
    : records.filter(rec => getReactionContent(rec) === contentFilter);
  const paged = paginate(filtered, pagination);

  const items: Record<string, unknown>[] = [];
  for (const rec of paged) {
    const data = await rec.data.json();
    items.push(buildReactionResponse(rec, data, baseUrl, targetDid));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/issues/comments/${commentId}/reactions`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCreateIssueCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string,
  commentId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const content = parseReactionContent(reqBody.content);
  if (typeof content !== 'string') { return content; }

  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const existing = await listIssueCommentReactionRecords(ctx, undefined, lookup.entry.comment);
  const duplicate = existing.find((rec) => {
    const authorDid = rec.author ?? ctx.did;
    return authorDid === ctx.did && getReactionContent(rec) === content;
  });
  if (duplicate) {
    const data = await duplicate.data.json();
    return jsonOk(buildReactionResponse(duplicate, data, baseUrl, targetDid));
  }

  const { status, record } = await ctx.issues.records.create('repo/issue/comment/reaction' as any, {
    data            : { emoji: content },
    tags            : { emoji: content },
    parentContextId : lookup.entry.comment.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create issue comment reaction: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create issue comment reaction record'); }

  const data = await record.data.json();
  return jsonCreated(buildReactionResponse(record, data, baseUrl, targetDid));
}

export async function handleDeleteIssueCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string,
  commentId: string, reactionId: string,
): Promise<JsonResponse> {
  const lookup = await findIssueCommentRecord(ctx, targetDid, repoName, commentId);
  if ('status' in lookup) { return lookup; }

  const id = parseInt(reactionId, 10);
  const records = await listIssueCommentReactionRecords(ctx, undefined, lookup.entry.comment);
  const reaction = records.find(rec => numericId(rec.id ?? '') === id);
  if (!reaction) {
    return jsonNotFound(`Reaction #${reactionId} not found on issue comment #${commentId}.`);
  }

  const { status } = await reaction.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete issue comment reaction: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST/PUT/DELETE /repos/:did/:repo/issues/:number/labels
// ---------------------------------------------------------------------------

export async function handleListIssueLabels(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const labels = await buildIssueLabels(
    ctx, lookup.from, lookup.issue, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(labels);
}

export async function handleAddIssueLabels(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const parsed = parseLabelInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  const existing = await listLabelRecords(ctx, undefined, lookup.issue);
  const createError = await createMissingLabels(ctx, lookup.issue, existing, parsed);
  if (createError) { return createError; }

  const labels = await buildIssueLabels(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(labels);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/issues/:number/assignees
// ---------------------------------------------------------------------------

export async function handleCheckIssueAssignee(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, encodedDid: string,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  return handleCheckAssignee(ctx, targetDid, repoName, encodedDid);
}

export async function handleAddIssueAssignees(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const parsed = parseAssigneeInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  if (await canMutateIssueMetadata(ctx, targetDid, lookup.repo)) {
    const existing = await listAssignmentRecords(ctx, undefined, lookup.issue);
    const assigneeLimitError = validateMergedAssigneeLimit(existing, parsed);
    if (assigneeLimitError) { return assigneeLimitError; }
    const createError = await createMissingAssignments(ctx, lookup.issue, existing, parsed);
    if (createError) { return createError; }
  }

  const data = await lookup.issue.data.json();
  const tags = (lookup.issue.tags as Record<string, string> | undefined) ?? {};
  const issue = await buildIssueWithChildren(
    ctx, undefined, lookup.issue, data, tags, targetDid, repoName, buildApiUrl(url),
  );
  return jsonCreated(issue);
}

export async function handleRemoveIssueAssignees(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const parsed = parseAssigneeInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  if (await canMutateIssueMetadata(ctx, targetDid, lookup.repo)) {
    const toRemove = new Set(parsed.map(assignee => assignee.did));
    const existing = await listAssignmentRecords(ctx, undefined, lookup.issue);
    const deleteError = await deleteAssignments(existing.filter((rec) => {
      const tags = (rec.tags as Record<string, string> | undefined) ?? {};
      return toRemove.has(tags.assigneeDid ?? '');
    }));
    if (deleteError) { return deleteError; }
  }

  const data = await lookup.issue.data.json();
  const tags = (lookup.issue.tags as Record<string, string> | undefined) ?? {};
  const issue = await buildIssueWithChildren(
    ctx, undefined, lookup.issue, data, tags, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(issue);
}

export async function handleReplaceIssueLabels(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const parsed = parseLabelInputs(reqBody);
  if (!Array.isArray(parsed)) { return parsed; }

  const existing = await listLabelRecords(ctx, undefined, lookup.issue);
  const deleteError = await deleteLabels(existing);
  if (deleteError) { return deleteError; }

  const createError = await createMissingLabels(ctx, lookup.issue, [], parsed);
  if (createError) { return createError; }

  const labels = await buildIssueLabels(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(labels);
}

export async function handleRemoveAllIssueLabels(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const existing = await listLabelRecords(ctx, undefined, lookup.issue);
  const deleteError = await deleteLabels(existing);
  if (deleteError) { return deleteError; }

  return jsonNoContent();
}

export async function handleRemoveIssueLabel(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, labelName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findIssueRecord(ctx, targetDid, repoName, number);
  if ('status' in lookup) { return lookup; }

  const existing = await listLabelRecords(ctx, undefined, lookup.issue);
  const target = decodeURIComponent(labelName).toLocaleLowerCase();
  const toDelete = existing.filter((rec) => {
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    return (tags.name ?? '').toLocaleLowerCase() === target;
  });

  if (toDelete.length === 0) {
    return jsonNotFound(`Label '${decodeURIComponent(labelName)}' not found on issue #${number}.`);
  }

  const deleteError = await deleteLabels(toDelete);
  if (deleteError) { return deleteError; }

  const labels = await buildIssueLabels(
    ctx, undefined, lookup.issue, targetDid, repoName, buildApiUrl(url),
  );
  return jsonOk(labels);
}
