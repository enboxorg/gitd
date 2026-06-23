/**
 * GitHub API shim — repository metadata and fork endpoints.
 *
 * Maps a DWN repo record to a GitHub REST API v3 repository response.
 * The `:repo` URL segment is used to look up the repo by name.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';
import type { RepositoryTransferRequestData, SettingsData } from '../repo.js';

import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, renameSync, rmSync } from 'node:fs';

import { DateSort } from '@enbox/dwn-sdk-js';

import { getDwnEndpoints } from '../git-server/did-service.js';
import { GitBackend } from '../git-server/git-backend.js';
import { listTopicNames } from './repo-metadata.js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonAccepted,
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
// Types
// ---------------------------------------------------------------------------

export type RepoCreateOptions = {
  reposPath? : string;
};

export type RepoEntry = {
  record : any;
  repo : RepoInfo;
  name : string;
};

type OwnedRepoEntry = RepoEntry & {
  ownerDid : string;
};

type RepoSettingsLookup = {
  entry : RepoEntry;
  record? : {
    update : (options: { data: SettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : SettingsData;
};

type RepoListMode = 'authenticated' | 'org' | 'user';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function repoInfoFromRecord(rec: any, data: any, tags: Record<string, unknown>): RepoInfo {
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

async function findRepoEntry(ctx: AgentContext, targetDid: string, repoName: string): Promise<RepoEntry | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', {
    from,
    filter: { tags: { name: repoName } },
  });

  const record = records[0];
  if (!record) { return null; }

  const data = await record.data.json();
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const repo = repoInfoFromRecord(record, data, tags);
  return { record, repo, name: repo.name };
}

export async function listRepoEntries(ctx: AgentContext, targetDid: string): Promise<RepoEntry[]> {
  const { records } = await ctx.repo.records.query('repo', {
    from     : fromOpt(ctx, targetDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: RepoEntry[] = [];
  for (const record of records) {
    let data: Record<string, unknown>;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    const repo = repoInfoFromRecord(record, data, tags);
    entries.push({
      record,
      repo,
      name: repo.name,
    });
  }
  return entries;
}

function isPrivate(repo: RepoInfo): boolean {
  return repo.visibility !== 'public';
}

function repoResponseId(entry: RepoEntry, targetDid: string): number {
  return numericId(entry.repo.contextId || `${targetDid}/repo`);
}

function parseSinceRepositoryId(url: URL): number | JsonResponse {
  const value = url.searchParams.get('since');
  if (value === null) { return 0; }
  if (!/^\d+$/.test(value)) {
    return jsonValidationError('Validation Failed: since must be a non-negative repository ID.');
  }
  const since = Number(value);
  if (!Number.isSafeInteger(since) || since < 0) {
    return jsonValidationError('Validation Failed: since must be a non-negative repository ID.');
  }
  return since;
}

function publicRepositoriesLinkHeader(url: URL, nextSince: number): string {
  const params = new URLSearchParams(url.searchParams);
  params.set('since', String(nextSince));
  params.delete('page');
  return `<${buildApiUrl(url)}/repositories?${params.toString()}>; rel="next"`;
}

function filterRepos(entries: RepoEntry[], url: URL, mode: RepoListMode): RepoEntry[] | JsonResponse {
  const visibility = url.searchParams.get('visibility');
  const type = url.searchParams.get('type');
  const affiliation = url.searchParams.get('affiliation');

  if (visibility && !['all', 'public', 'private'].includes(visibility)) {
    return jsonValidationError('Validation Failed: visibility must be all, public, or private.');
  }
  if (mode === 'authenticated' && type && (visibility || affiliation)) {
    return jsonValidationError('Validation Failed: type cannot be combined with visibility or affiliation.');
  }

  let filtered = [...entries];
  const visibilityFilter = visibility && visibility !== 'all' ? visibility : null;
  if (visibilityFilter === 'public') {
    filtered = filtered.filter(entry => !isPrivate(entry.repo));
  } else if (visibilityFilter === 'private') {
    filtered = filtered.filter(entry => isPrivate(entry.repo));
  }

  if (!type || type === 'all') {
    return filtered;
  }
  if (type === 'owner' || type === 'sources') {
    return filtered.filter(entry => !entry.repo.forkedFromDid);
  }
  if (type === 'public') {
    return filtered.filter(entry => !isPrivate(entry.repo));
  }
  if (type === 'private') {
    return filtered.filter(entry => isPrivate(entry.repo));
  }
  if (type === 'forks') {
    return filtered.filter(entry => Boolean(entry.repo.forkedFromDid));
  }
  if (type === 'member') {
    return [];
  }

  const allowed = mode === 'org'
    ? 'all, public, private, forks, sources, or member'
    : 'all, owner, public, private, or member';
  return jsonValidationError(`Validation Failed: type must be ${allowed}.`);
}

function sortRepos(entries: RepoEntry[], url: URL, mode: RepoListMode): RepoEntry[] {
  const defaultSort = mode === 'org' ? 'created' : 'full_name';
  const sort = url.searchParams.get('sort') ?? defaultSort;
  const defaultDirection = sort === 'full_name' ? 'asc' : 'desc';
  const direction = url.searchParams.get('direction') ?? defaultDirection;
  const multiplier = direction === 'asc' ? 1 : -1;

  return [...entries].sort((a, b) => {
    if (sort === 'full_name') {
      return a.name.localeCompare(b.name) * multiplier;
    }
    if (sort === 'updated' || sort === 'pushed') {
      return (new Date(a.repo.timestamp).getTime() - new Date(b.repo.timestamp).getTime()) * multiplier;
    }
    return (new Date(a.repo.dateCreated).getTime() - new Date(b.repo.dateCreated).getTime()) * multiplier;
  });
}

function filterByDateBounds(entries: RepoEntry[], url: URL): RepoEntry[] | JsonResponse {
  const since = url.searchParams.get('since');
  const before = url.searchParams.get('before');
  let filtered = [...entries];

  for (const [label, value] of [['since', since], ['before', before]] as const) {
    if (!value) { continue; }
    const time = Date.parse(value);
    if (Number.isNaN(time)) {
      return jsonValidationError(`Validation Failed: ${label} must be an ISO 8601 timestamp.`);
    }
    filtered = label === 'since'
      ? filtered.filter(entry => new Date(entry.repo.timestamp).getTime() > time)
      : filtered.filter(entry => new Date(entry.repo.timestamp).getTime() < time);
  }

  return filtered;
}

async function buildRepoList(
  ctx: AgentContext, entries: RepoEntry[], targetDid: string, baseUrl: string,
): Promise<Record<string, unknown>[]> {
  const repos: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const topics = await listTopicNames(ctx, targetDid, entry.repo);
    repos.push(buildRepoResponse(entry.repo, targetDid, entry.name, baseUrl, topics));
  }
  return repos;
}

function normalizeRepoName(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const name = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) { return null; }
  return name;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || value.trim().toLowerCase();
}

function parseTeamIds(value: unknown): number[] | JsonResponse {
  if (value === undefined) { return []; }
  if (!Array.isArray(value)) {
    return jsonValidationError('Validation Failed: team_ids must be an array of positive integers.');
  }

  const teamIds: number[] = [];
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item <= 0) {
      return jsonValidationError('Validation Failed: team_ids must be an array of positive integers.');
    }
    teamIds.push(item);
  }
  return teamIds;
}

async function orgRouteExistsForTransfer(ctx: AgentContext, routeOrg: string): Promise<boolean> {
  const route = decodeRouteParam(routeOrg).trim().toLowerCase();
  if (!route) { return false; }

  const { records } = await ctx.org.records.query('org' as any);
  for (const record of records) {
    let data: { name?: unknown };
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    if (typeof data.name !== 'string' || !data.name.trim()) { continue; }

    const name = data.name.trim().toLowerCase();
    if (route === name || route === slugify(data.name)) {
      return true;
    }
  }
  return false;
}

async function getRepoSettingsForEntry(
  ctx: AgentContext, targetDid: string, entry: RepoEntry,
): Promise<RepoSettingsLookup> {
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from   : fromOpt(ctx, targetDid),
    filter : { contextId: entry.repo.contextId },
  });

  if (records.length === 0) {
    return { entry, settings: {} };
  }

  const record = records[0] as RepoSettingsLookup['record'] & { data: { json: () => Promise<SettingsData> } };
  const settings = await record.data.json();
  return { entry, record, settings: settings ?? {} };
}

async function saveRepoSettingsForEntry(
  ctx: AgentContext, lookup: RepoSettingsLookup, settings: SettingsData,
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
    parentContextId : lookup.entry.repo.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create repository settings: ${status.detail}`);
  }
  return undefined;
}

function buildTransferRequestResponse(request: RepositoryTransferRequestData): Record<string, unknown> {
  return {
    id           : request.id,
    new_owner    : request.newOwner,
    new_name     : request.newName ?? null,
    team_ids     : request.teamIds ?? [],
    requested_by : request.requestedBy,
    created_at   : request.createdAt,
  };
}

function visibilityFromBody(body: Record<string, unknown>): 'public' | 'private' | null {
  if (body.visibility !== undefined) {
    if (body.visibility === 'public' || body.visibility === 'private') {
      return body.visibility;
    }
    return null;
  }
  return body.private === true ? 'private' : 'public';
}

function visibilityFromPatchBody(
  body: Record<string, unknown>, currentVisibility: string,
): 'public' | 'private' | JsonResponse {
  let visibility: 'public' | 'private' = currentVisibility === 'private' ? 'private' : 'public';
  if (body.private !== undefined) {
    if (typeof body.private !== 'boolean') {
      return jsonValidationError('Validation Failed: private must be a boolean.');
    }
    visibility = body.private ? 'private' : 'public';
  }
  if (body.visibility !== undefined) {
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      return jsonValidationError('Validation Failed: visibility must be public or private.');
    }
    visibility = body.visibility;
  }
  return visibility;
}

const repoBooleanPatchFields = [
  ['has_issues', 'hasIssues'],
  ['has_projects', 'hasProjects'],
  ['has_wiki', 'hasWiki'],
  ['has_downloads', 'hasDownloads'],
  ['has_pull_requests', 'hasPullRequests'],
  ['is_template', 'isTemplate'],
  ['allow_squash_merge', 'allowSquashMerge'],
  ['allow_merge_commit', 'allowMergeCommit'],
  ['allow_rebase_merge', 'allowRebaseMerge'],
  ['allow_auto_merge', 'allowAutoMerge'],
  ['allow_forking', 'allowForking'],
  ['delete_branch_on_merge', 'deleteBranchOnMerge'],
  ['web_commit_signoff_required', 'webCommitSignoffRequired'],
] as const;

function applyRepoBooleanPatchFields(body: Record<string, unknown>, data: Record<string, unknown>): JsonResponse | null {
  for (const [apiKey, dataKey] of repoBooleanPatchFields) {
    if (body[apiKey] === undefined) { continue; }
    if (typeof body[apiKey] !== 'boolean') {
      return jsonValidationError(`Validation Failed: ${apiKey} must be a boolean.`);
    }
    data[dataKey] = body[apiKey];
  }
  return null;
}

function updateRepoStorageName(
  options: RepoCreateOptions, ownerDid: string, oldName: string, newName: string,
): JsonResponse | null {
  if (!options.reposPath || oldName === newName) { return null; }

  const backend = new GitBackend({ basePath: options.reposPath });
  if (!backend.exists(ownerDid, oldName)) { return null; }
  if (backend.exists(ownerDid, newName)) {
    return jsonValidationError(`Validation Failed: repository storage for '${newName}' already exists.`);
  }

  try {
    const oldPath = backend.repoPath(ownerDid, oldName);
    const newPath = backend.repoPath(ownerDid, newName);
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
    return null;
  } catch (err) {
    return jsonValidationError(`Failed to rename repository storage: ${(err as Error).message}`);
  }
}

function deleteRepoStorage(options: RepoCreateOptions, ownerDid: string, repoName: string): JsonResponse | null {
  if (!options.reposPath) { return null; }

  const backend = new GitBackend({ basePath: options.reposPath });
  if (!backend.exists(ownerDid, repoName)) { return null; }

  try {
    rmSync(backend.repoPath(ownerDid, repoName), { recursive: true, force: true });
    return null;
  } catch (err) {
    return jsonValidationError(`Failed to delete repository storage: ${(err as Error).message}`);
  }
}

function validateForkBody(body: Record<string, unknown>): JsonResponse | null {
  if (body.organization !== undefined) {
    return jsonValidationError('Validation Failed: organization forks are not supported by this local shim.');
  }
  if (body.default_branch_only !== undefined && typeof body.default_branch_only !== 'boolean') {
    return jsonValidationError('Validation Failed: default_branch_only must be a boolean.');
  }
  return null;
}

function forkMatches(entry: RepoEntry, sourceDid: string, sourceName: string, sourceRecordId: string): boolean {
  return entry.repo.forkedFromDid === sourceDid
    && entry.repo.forkedFromRepoName === sourceName
    && entry.repo.forkedFromRecordId === sourceRecordId;
}

function sortForkEntries(entries: OwnedRepoEntry[], url: URL): OwnedRepoEntry[] | JsonResponse {
  const sort = url.searchParams.get('sort') ?? 'newest';
  if (!['newest', 'oldest', 'stargazers', 'watchers'].includes(sort)) {
    return jsonValidationError('Validation Failed: sort must be newest, oldest, stargazers, or watchers.');
  }

  const newestFirst = sort !== 'oldest';
  return [...entries].sort((a, b) => {
    const delta = new Date(a.repo.dateCreated).getTime() - new Date(b.repo.dateCreated).getTime();
    return newestFirst ? -delta : delta;
  });
}

async function createForkStorage(
  options: RepoCreateOptions,
  source: RepoEntry,
  sourceDid: string,
  forkDid: string,
  forkName: string,
  defaultBranchOnly: boolean,
): Promise<JsonResponse | null> {
  if (!options.reposPath) { return null; }

  const backend = new GitBackend({ basePath: options.reposPath });
  if (backend.exists(forkDid, forkName)) {
    return jsonValidationError(`Validation Failed: repository storage for '${forkName}' already exists.`);
  }

  try {
    if (!backend.exists(sourceDid, source.name)) {
      await backend.initRepo(forkDid, forkName);
      return null;
    }

    const sourcePath = backend.repoPath(sourceDid, source.name);
    const forkPath = backend.repoPath(forkDid, forkName);
    mkdirSync(dirname(forkPath), { recursive: true });
    const args = ['clone', '--bare'];
    if (defaultBranchOnly) {
      args.push('--single-branch', '--branch', source.repo.defaultBranch);
    }
    args.push(sourcePath, forkPath);
    await execFileAsync('git', args);
    return null;
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    return jsonValidationError(`Failed to initialize fork storage: ${detail}`);
  }
}

async function createTemplateStorage(
  options: RepoCreateOptions,
  source: RepoEntry,
  sourceDid: string,
  targetDid: string,
  repoName: string,
  includeAllBranches: boolean,
): Promise<JsonResponse | null> {
  if (!options.reposPath) { return null; }

  const backend = new GitBackend({ basePath: options.reposPath });
  if (backend.exists(targetDid, repoName)) {
    return jsonValidationError(`Validation Failed: repository storage for '${repoName}' already exists.`);
  }

  try {
    if (!backend.exists(sourceDid, source.name)) {
      await backend.initRepo(targetDid, repoName);
      return null;
    }

    const sourcePath = backend.repoPath(sourceDid, source.name);
    const targetPath = backend.repoPath(targetDid, repoName);
    mkdirSync(dirname(targetPath), { recursive: true });
    const args = ['clone', '--bare'];
    if (!includeAllBranches) {
      args.push('--single-branch', '--branch', source.repo.defaultBranch);
    }
    args.push(sourcePath, targetPath);
    await execFileAsync('git', args);
    return null;
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    return jsonValidationError(`Failed to initialize template repository storage: ${detail}`);
  }
}

/** Build a GitHub-style repository object from DWN data. */
export function buildRepoResponse(
  repo: RepoInfo, targetDid: string, repoName: string, baseUrl: string, topics: string[] = [],
): Record<string, unknown> {
  const owner = buildOwner(targetDid, baseUrl);
  const fullName = `${targetDid}/${repoName}`;
  const sourceFullName = repo.forkedFromDid && repo.forkedFromRepoName
    ? `${repo.forkedFromDid}/${repo.forkedFromRepoName}`
    : null;

  const response: Record<string, unknown> = {
    id                           : numericId(repo.contextId || `${targetDid}/repo`),
    node_id                      : repo.contextId || '',
    name                         : repoName,
    full_name                    : fullName,
    private                      : repo.visibility !== 'public',
    owner,
    html_url                     : `${baseUrl}/repos/${fullName}`,
    description                  : repo.description || null,
    homepage                     : repo.homepage || null,
    fork                         : Boolean(sourceFullName),
    url                          : `${baseUrl}/repos/${fullName}`,
    archive_url                  : `${baseUrl}/repos/${fullName}/{archive_format}{/ref}`,
    forks_url                    : `${baseUrl}/repos/${fullName}/forks`,
    issues_url                   : `${baseUrl}/repos/${fullName}/issues{/number}`,
    pulls_url                    : `${baseUrl}/repos/${fullName}/pulls{/number}`,
    releases_url                 : `${baseUrl}/repos/${fullName}/releases{/id}`,
    created_at                   : toISODate(repo.dateCreated),
    updated_at                   : toISODate(repo.timestamp),
    pushed_at                    : toISODate(repo.timestamp),
    git_url                      : `did://${targetDid}/${repoName}.git`,
    clone_url                    : `did://${targetDid}/${repoName}.git`,
    default_branch               : repo.defaultBranch,
    visibility                   : repo.visibility,
    // Counts — zero unless enriched by an indexer.
    stargazers_count             : 0,
    watchers_count               : 0,
    forks_count                  : 0,
    open_issues_count            : 0,
    // Standard GitHub fields with sensible defaults.
    language                     : repo.language || null,
    has_issues                   : repo.hasIssues,
    has_projects                 : repo.hasProjects,
    has_wiki                     : repo.hasWiki,
    has_pages                    : false,
    has_downloads                : repo.hasDownloads,
    has_pull_requests            : repo.hasPullRequests,
    is_template                  : repo.isTemplate,
    archived                     : repo.archived,
    disabled                     : false,
    license                      : null,
    topics,
    forks                        : 0,
    watchers                     : 0,
    size                         : 0,
    allow_squash_merge           : repo.allowSquashMerge,
    allow_merge_commit           : repo.allowMergeCommit,
    allow_rebase_merge           : repo.allowRebaseMerge,
    allow_auto_merge             : repo.allowAutoMerge,
    allow_forking                : repo.allowForking,
    delete_branch_on_merge       : repo.deleteBranchOnMerge,
    web_commit_signoff_required  : repo.webCommitSignoffRequired,
    pull_request_creation_policy : repo.pullRequestCreationPolicy,
  };

  if (sourceFullName) {
    const source = {
      id        : numericId(repo.forkedFromRecordId ?? sourceFullName),
      name      : repo.forkedFromRepoName,
      full_name : sourceFullName,
      owner     : buildOwner(repo.forkedFromDid!, baseUrl),
      url       : `${baseUrl}/repos/${sourceFullName}`,
      html_url  : `${baseUrl}/repos/${sourceFullName}`,
    };
    response.parent = source;
    response.source = source;
  }

  return response;
}

export async function handleListRepos(
  ctx: AgentContext, targetDid: string, url: URL, path: string, mode: RepoListMode,
): Promise<JsonResponse> {
  const entries = await listRepoEntries(ctx, targetDid);
  const dateFiltered = filterByDateBounds(entries, url);
  if ('status' in dateFiltered) { return dateFiltered; }

  const filtered = filterRepos(dateFiltered, url, mode);
  if ('status' in filtered) { return filtered; }

  const sorted = sortRepos(filtered, url, mode);
  const pagination = parsePagination(url);
  const paged = paginate(sorted, pagination);
  const baseUrl = buildApiUrl(url);
  const repos = await buildRepoList(ctx, paged, targetDid, baseUrl);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, sorted.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(repos, extraHeaders);
}

export async function handleListAuthenticatedRepos(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  return handleListRepos(ctx, ctx.did, url, '/user/repos', 'authenticated');
}

export async function handleListPublicRepositories(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const since = parseSinceRepositoryId(url);
  if (typeof since !== 'number') { return since; }

  const { perPage } = parsePagination(url);
  const entries = (await listRepoEntries(ctx, ctx.did))
    .filter(entry => !isPrivate(entry.repo))
    .filter(entry => repoResponseId(entry, ctx.did) > since);

  const baseUrl = buildApiUrl(url);
  const repos: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const topics = await listTopicNames(ctx, ctx.did, entry.repo);
    repos.push(buildRepoResponse(entry.repo, ctx.did, entry.name, baseUrl, topics));
  }

  const page = repos.slice(0, perPage);
  const extraHeaders: Record<string, string> = {};
  if (repos.length > perPage) {
    extraHeaders.Link = publicRepositoriesLinkHeader(url, Number(page[page.length - 1]?.id ?? since));
  }

  return jsonOk(page, extraHeaders);
}

export async function handleListUserRepos(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  return handleListRepos(ctx, userDid, url, `/users/${userDid}/repos`, 'user');
}

export async function createRepoForOwner(
  ctx: AgentContext, ownerDid: string, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  if (ownerDid !== ctx.did) {
    return jsonValidationError('Validation Failed: repository creation is only supported for the local DID.');
  }

  const name = normalizeRepoName(body.name);
  if (!name) {
    return jsonValidationError('Validation Failed: name must contain only letters, digits, dots, hyphens, and underscores.');
  }

  const visibility = visibilityFromBody(body);
  if (!visibility) {
    return jsonValidationError('Validation Failed: visibility must be public or private.');
  }

  const existing = await getRepoRecord(ctx, ownerDid, name);
  if (existing) {
    return jsonValidationError(`Validation Failed: repository '${name}' already exists.`);
  }

  if (options.reposPath) {
    try {
      await new GitBackend({ basePath: options.reposPath }).initRepo(ownerDid, name);
    } catch (err) {
      return jsonValidationError(`Failed to initialize repository storage: ${(err as Error).message}`);
    }
  }

  const defaultBranch = typeof body.default_branch === 'string' && body.default_branch.trim()
    ? body.default_branch.trim()
    : 'main';
  const description = typeof body.description === 'string' ? body.description : '';
  const homepage = typeof body.homepage === 'string' ? body.homepage : '';

  const { record, status } = await ctx.repo.records.create('repo', {
    data: {
      name,
      description,
      homepage,
      defaultBranch,
      dwnEndpoints: getDwnEndpoints(ctx.enbox),
    },
    tags: {
      name,
      visibility,
    },
  });

  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create repository: ${status.detail}`);
  }

  const repo = repoInfoFromRecord(record, {
    name, description, homepage, defaultBranch,
  }, { visibility });
  return jsonCreated(buildRepoResponse(repo, ownerDid, name, buildApiUrl(url)));
}

export async function handleListForks(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const source = await findRepoEntry(ctx, targetDid, repoName);
  if (!source) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const candidates: OwnedRepoEntry[] = [];
  const ownerDids = targetDid === ctx.did ? [ctx.did] : [ctx.did, targetDid];
  for (const ownerDid of ownerDids) {
    const entries = await listRepoEntries(ctx, ownerDid);
    for (const entry of entries) {
      if (forkMatches(entry, targetDid, source.name, source.record.id)) {
        candidates.push({ ...entry, ownerDid });
      }
    }
  }

  const sorted = sortForkEntries(candidates, url);
  if ('status' in sorted) { return sorted; }

  const pagination = parsePagination(url);
  const paged = paginate(sorted, pagination);
  const baseUrl = buildApiUrl(url);
  const forks: Record<string, unknown>[] = [];
  for (const entry of paged) {
    const topics = await listTopicNames(ctx, entry.ownerDid, entry.repo);
    forks.push(buildRepoResponse(entry.repo, entry.ownerDid, entry.name, baseUrl, topics));
  }

  const linkHeader = buildLinkHeader(baseUrl, `/repos/${targetDid}/${repoName}/forks`, pagination.page, pagination.perPage, sorted.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(forks, extraHeaders);
}

export async function handleCreateFork(
  ctx: AgentContext, targetDid: string, repoName: string, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  const validationError = validateForkBody(body);
  if (validationError) { return validationError; }

  const source = await findRepoEntry(ctx, targetDid, repoName);
  if (!source) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const forkName = body.name === undefined
    ? source.name
    : normalizeRepoName(body.name);
  if (!forkName) {
    return jsonValidationError('Validation Failed: name must contain only letters, digits, dots, hyphens, and underscores.');
  }

  const existing = await getRepoRecord(ctx, ctx.did, forkName);
  if (existing) {
    return jsonValidationError(`Validation Failed: repository '${forkName}' already exists.`);
  }

  const storageError = await createForkStorage(options, source, targetDid, ctx.did, forkName, body.default_branch_only === true);
  if (storageError) { return storageError; }

  const data = {
    name               : forkName,
    description        : source.repo.description,
    homepage           : source.repo.homepage,
    defaultBranch      : source.repo.defaultBranch,
    dwnEndpoints       : getDwnEndpoints(ctx.enbox),
    forkedFromDid      : targetDid,
    forkedFromRepoName : source.name,
    forkedFromRecordId : source.record.id,
  };
  const tags = {
    name               : forkName,
    visibility         : source.repo.visibility,
    forkedFromDid      : targetDid,
    forkedFromRepoName : source.name,
    forkedFromRecordId : source.record.id,
  };

  const { record, status } = await ctx.repo.records.create('repo', { data, tags });
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create repository fork: ${status.detail}`);
  }

  const repo = repoInfoFromRecord(record, data, tags);
  return jsonAccepted(buildRepoResponse(repo, ctx.did, forkName, buildApiUrl(url)));
}

export async function handleGenerateRepoFromTemplate(
  ctx: AgentContext, templateDid: string, templateName: string, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  const source = await findRepoEntry(ctx, templateDid, templateName);
  if (!source) {
    return jsonNotFound(`Repository '${templateName}' not found for DID '${templateDid}'.`);
  }
  if (!source.repo.isTemplate) {
    return jsonValidationError('Validation Failed: source repository is not marked as a template.');
  }

  const ownerDid = typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim() : ctx.did;
  if (ownerDid !== ctx.did) {
    return jsonValidationError('Validation Failed: template generation is only supported for the local DID.');
  }

  const name = normalizeRepoName(body.name);
  if (!name) {
    return jsonValidationError('Validation Failed: name must contain only letters, digits, dots, hyphens, and underscores.');
  }
  if (body.private !== undefined && typeof body.private !== 'boolean') {
    return jsonValidationError('Validation Failed: private must be a boolean.');
  }
  if (body.include_all_branches !== undefined && typeof body.include_all_branches !== 'boolean') {
    return jsonValidationError('Validation Failed: include_all_branches must be a boolean.');
  }
  if (body.description !== undefined && typeof body.description !== 'string' && body.description !== null) {
    return jsonValidationError('Validation Failed: description must be a string.');
  }

  const existing = await getRepoRecord(ctx, ownerDid, name);
  if (existing) {
    return jsonValidationError(`Validation Failed: repository '${name}' already exists.`);
  }

  const storageError = await createTemplateStorage(
    options,
    source,
    templateDid,
    ownerDid,
    name,
    body.include_all_branches === true,
  );
  if (storageError) { return storageError; }

  const data = {
    name,
    description               : typeof body.description === 'string' ? body.description : source.repo.description,
    homepage                  : source.repo.homepage,
    defaultBranch             : source.repo.defaultBranch,
    dwnEndpoints              : getDwnEndpoints(ctx.enbox),
    hasIssues                 : source.repo.hasIssues,
    hasProjects               : source.repo.hasProjects,
    hasWiki                   : source.repo.hasWiki,
    hasDownloads              : source.repo.hasDownloads,
    hasPullRequests           : source.repo.hasPullRequests,
    isTemplate                : false,
    allowSquashMerge          : source.repo.allowSquashMerge,
    allowMergeCommit          : source.repo.allowMergeCommit,
    allowRebaseMerge          : source.repo.allowRebaseMerge,
    allowAutoMerge            : source.repo.allowAutoMerge,
    allowForking              : source.repo.allowForking,
    deleteBranchOnMerge       : source.repo.deleteBranchOnMerge,
    webCommitSignoffRequired  : source.repo.webCommitSignoffRequired,
    pullRequestCreationPolicy : source.repo.pullRequestCreationPolicy === 'collaborators_only' ? 'collaborators_only' as const : 'all' as const,
  };
  const tags: Record<string, string | number | boolean | string[] | number[]> = {
    name,
    visibility    : body.private === true ? 'private' : 'public',
    defaultBranch : source.repo.defaultBranch,
    ...(source.repo.language ? { language: source.repo.language } : {}),
  };

  const { record, status } = await ctx.repo.records.create('repo', { data, tags });
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to generate repository from template: ${status.detail}`);
  }

  const baseUrl = buildApiUrl(url);
  const repo = repoInfoFromRecord(record, data, tags);
  const response = buildRepoResponse(repo, ownerDid, name, baseUrl);
  response.template_repository = buildRepoResponse(source.repo, templateDid, source.name, baseUrl);
  return jsonCreated(response);
}

export async function handleTransferRepo(
  ctx: AgentContext, targetDid: string, repoName: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  if (targetDid !== ctx.did) {
    return jsonNotFound(`Repository '${repoName}' not found for local account '${ctx.did}'.`);
  }

  const entry = await findRepoEntry(ctx, targetDid, repoName);
  if (!entry) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  if (typeof body.new_owner !== 'string' || !body.new_owner.trim()) {
    return jsonValidationError('Validation Failed: new_owner is required.');
  }
  const newOwner = body.new_owner.trim();
  const newName = body.new_name === undefined ? undefined : normalizeRepoName(body.new_name);
  if (body.new_name !== undefined && !newName) {
    return jsonValidationError('Validation Failed: new_name must contain only letters, digits, dots, hyphens, and underscores.');
  }

  const teamIds = parseTeamIds(body.team_ids);
  if ('status' in teamIds) { return teamIds; }

  const targetName = newName ?? entry.name;
  const targetIsLocalDid = newOwner.toLowerCase() === ctx.did.toLowerCase();
  const targetIsOrg = await orgRouteExistsForTransfer(ctx, newOwner);
  if (teamIds.length > 0 && !targetIsOrg) {
    return jsonValidationError('Validation Failed: team_ids can only be supplied when transferring to an organization.');
  }

  if (targetIsLocalDid && targetName === entry.name) {
    return jsonValidationError('Validation Failed: repository is already owned by the requested owner.');
  }

  if ((targetIsLocalDid || targetIsOrg) && targetName !== entry.name) {
    const existing = await getRepoRecord(ctx, ctx.did, targetName);
    if (existing) {
      return jsonValidationError(`Validation Failed: repository '${targetName}' already exists.`);
    }
  }

  const createdAt = new Date().toISOString();
  const transferRequest: RepositoryTransferRequestData = {
    id          : numericId(`${entry.record.id}:transfer:${newOwner}:${targetName}`) || 1,
    newOwner,
    ...(newName ? { newName } : {}),
    ...(teamIds.length > 0 ? { teamIds } : {}),
    requestedBy : ctx.did,
    createdAt,
  };

  const lookup = await getRepoSettingsForEntry(ctx, targetDid, entry);
  const saveError = await saveRepoSettingsForEntry(ctx, lookup, {
    ...lookup.settings,
    transferRequest,
  });
  if (saveError) { return saveError; }

  const response = buildRepoResponse(entry.repo, targetDid, entry.name, buildApiUrl(url));
  response.transfer_request = buildTransferRequestResponse(transferRequest);
  return jsonAccepted(response);
}

export async function handleCreateUserRepo(
  ctx: AgentContext, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  return createRepoForOwner(ctx, ctx.did, body, url, options);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo
// ---------------------------------------------------------------------------

/**
 * Handle `GET /repos/:did/:repo`.
 *
 * Returns a GitHub-style repository JSON response.
 */
export async function handleGetRepo(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const topics = await listTopicNames(ctx, targetDid, repo);
  return jsonOk(buildRepoResponse(repo, targetDid, repo.name, baseUrl, topics));
}

export async function handleUpdateRepo(
  ctx: AgentContext, targetDid: string, repoName: string, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  if (targetDid !== ctx.did) {
    return jsonNotFound(`Repository '${repoName}' not found for local account '${ctx.did}'.`);
  }

  const entry = await findRepoEntry(ctx, targetDid, repoName);
  if (!entry) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const name = body.name === undefined ? entry.name : normalizeRepoName(body.name);
  if (!name) {
    return jsonValidationError('Validation Failed: name must contain only letters, digits, dots, hyphens, and underscores.');
  }

  if (name !== entry.name) {
    const existing = await getRepoRecord(ctx, targetDid, name);
    if (existing) {
      return jsonValidationError(`Validation Failed: repository '${name}' already exists.`);
    }
  }

  const visibility = visibilityFromPatchBody(body, entry.repo.visibility);
  if (typeof visibility !== 'string') { return visibility; }

  const data = await entry.record.data.json() as Record<string, unknown>;
  data.name = name;

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' && body.description !== null) {
      return jsonValidationError('Validation Failed: description must be a string.');
    }
    data.description = body.description ?? '';
  }

  if (body.homepage !== undefined) {
    if (typeof body.homepage !== 'string' && body.homepage !== null) {
      return jsonValidationError('Validation Failed: homepage must be a string.');
    }
    data.homepage = body.homepage ?? '';
  }

  if (body.default_branch !== undefined) {
    if (typeof body.default_branch !== 'string' || !body.default_branch.trim()) {
      return jsonValidationError('Validation Failed: default_branch must be a non-empty string.');
    }
    data.defaultBranch = body.default_branch.trim();
  }

  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') {
      return jsonValidationError('Validation Failed: archived must be a boolean.');
    }
  }

  if (body.pull_request_creation_policy !== undefined) {
    if (body.pull_request_creation_policy !== 'all' && body.pull_request_creation_policy !== 'collaborators_only') {
      return jsonValidationError('Validation Failed: pull_request_creation_policy must be all or collaborators_only.');
    }
    data.pullRequestCreationPolicy = body.pull_request_creation_policy;
  }

  const booleanError = applyRepoBooleanPatchFields(body, data);
  if (booleanError) { return booleanError; }

  const storageError = updateRepoStorageName(options, targetDid, entry.name, name);
  if (storageError) { return storageError; }

  const tags: Record<string, unknown> = {
    ...((entry.record.tags as Record<string, unknown> | undefined) ?? {}),
    name,
    visibility,
    defaultBranch: data.defaultBranch,
  };
  if (body.archived !== undefined) { tags.archived = body.archived; }

  const { status } = await entry.record.update({ data, tags } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update repository: ${status.detail}`);
  }

  const repo = repoInfoFromRecord(entry.record, data, tags);
  const topics = await listTopicNames(ctx, targetDid, repo);
  return jsonOk(buildRepoResponse(repo, targetDid, name, buildApiUrl(url), topics));
}

export async function handleDeleteRepo(
  ctx: AgentContext, targetDid: string, repoName: string, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  if (targetDid !== ctx.did) {
    return jsonNotFound(`Repository '${repoName}' not found for local account '${ctx.did}'.`);
  }

  const entry = await findRepoEntry(ctx, targetDid, repoName);
  if (!entry) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const storageError = deleteRepoStorage(options, targetDid, entry.name);
  if (storageError) { return storageError; }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete repository: ${status.detail}`);
  }

  return jsonNoContent();
}
