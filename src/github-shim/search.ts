/**
 * GitHub API shim - search endpoints.
 *
 * Provides local DWN-backed search envelopes compatible with GitHub REST
 * search responses. This is intentionally scoped to records visible to the
 * local actor; broader network discovery belongs to indexer services.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { GitObjectOptions } from './git-objects.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { basename } from 'node:path';
import { DateSort } from '@enbox/dwn-sdk-js';

import { buildRepoResponse } from './repos.js';
import { handleListPulls } from './pulls.js';
import { listTopicNames } from './repo-metadata.js';
import { buildUserProfile, collectVisibleUserDids } from './users.js';

import {
  buildApiUrl,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
} from './helpers.js';
import { handleGetGitBlob, handleGetGitTree, handleListRepoCommits } from './git-objects.js';
import { handleListIssues, handleListRepoLabels } from './issues.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParsedSearchQuery = {
  terms : string[];
  qualifiers : Map<string, string[]>;
};

type SearchRepoEntry = {
  record : any;
  repo : RepoInfo;
  ownerDid : string;
  name : string;
  topics : string[];
  response : Record<string, unknown>;
};

type SearchItem = Record<string, unknown> & {
  score : number;
};

type SearchKind = 'code' | 'commits' | 'issues' | 'labels' | 'repositories' | 'topics' | 'users';

type TopicSearchEntry = {
  name : string;
  createdAt : string | null;
  updatedAt : string | null;
};

const MAX_CODE_SEARCH_BLOB_BYTES = 256 * 1024;

const SEARCH_QUALIFIERS = new Set([
  'author',
  'author-date',
  'author-email',
  'author-name',
  'committer',
  'committer-date',
  'committer-email',
  'committer-name',
  'extension',
  'filename',
  'hash',
  'in',
  'is',
  'language',
  'merge',
  'org',
  'path',
  'ref',
  'repo',
  'state',
  'topic',
  'type',
  'user',
]);

// ---------------------------------------------------------------------------
// Query parsing and shared helpers
// ---------------------------------------------------------------------------

function parseSearchQuery(value: string | null): ParsedSearchQuery | JsonResponse {
  if (!value || value.trim() === '') {
    return jsonValidationError('Validation Failed: q is required.');
  }

  const terms: string[] = [];
  const qualifiers = new Map<string, string[]>();
  for (const token of value.trim().split(/\s+/)) {
    const match = token.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):(.+)$/);
    if (!match) {
      terms.push(normalizeTerm(token));
      continue;
    }

    const key = match[1].toLowerCase();
    if (!SEARCH_QUALIFIERS.has(key)) {
      terms.push(normalizeTerm(token));
      continue;
    }

    const values = qualifiers.get(key) ?? [];
    values.push(match[2].replace(/^"|"$/g, ''));
    qualifiers.set(key, values);
  }

  return { terms: terms.filter(Boolean), qualifiers };
}

function parseSearchTerms(value: string | null): string[] | JsonResponse {
  if (!value || value.trim() === '') {
    return jsonValidationError('Validation Failed: q is required.');
  }
  return value.trim().split(/\s+/).map(normalizeTerm).filter(Boolean);
}

function normalizeTerm(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
}

function qualifierValues(query: ParsedSearchQuery, key: string): string[] {
  return query.qualifiers.get(key) ?? [];
}

function hasQualifier(query: ParsedSearchQuery, key: string, value: string): boolean {
  return qualifierValues(query, key).some(item => item.toLowerCase() === value);
}

function qualifierList(query: ParsedSearchQuery, key: string): string[] {
  return qualifierValues(query, key)
    .flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function recordToRepoInfo(record: any, data: Record<string, unknown>, tags: Record<string, unknown>): RepoInfo {
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
  };
}

function searchEnvelope(items: SearchItem[], total: number, url: URL, path: string): JsonResponse {
  const pagination = parsePagination(url);
  const page = paginate(items, pagination);
  const linkHeader = buildSearchLinkHeader(url, path, pagination.page, pagination.perPage, total);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk({
    total_count        : total,
    incomplete_results : false,
    items              : page,
  }, extraHeaders);
}

function buildSearchLinkHeader(url: URL, path: string, page: number, perPage: number, totalItems: number): string | null {
  const lastPage = Math.max(1, Math.ceil(totalItems / perPage));
  if (lastPage <= 1) { return null; }

  const baseUrl = buildApiUrl(url);
  const makeUrl = (targetPage: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `${baseUrl}${path}?${params.toString()}`;
  };

  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${makeUrl(page + 1)}>; rel="next"`);
    links.push(`<${makeUrl(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${makeUrl(1)}>; rel="first"`);
    links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

function scoreTerms(terms: string[], values: Array<unknown>): number {
  if (terms.length === 0) { return 1; }

  const haystack = values
    .filter(value => value !== null && value !== undefined)
    .map(value => String(value).toLowerCase())
    .join(' ');
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) { score++; }
  }
  return score;
}

function itemDate(item: SearchItem, field: string): number {
  const commit = asRecord(item.commit);
  if (field === 'author-date') {
    return Date.parse(String(asRecord(commit.author).date ?? 0));
  }
  if (field === 'committer-date') {
    return Date.parse(String(asRecord(commit.committer).date ?? 0));
  }
  return 0;
}

function sortSearchItems(items: SearchItem[], url: URL, kind: SearchKind): SearchItem[] {
  const sort = url.searchParams.get('sort');
  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  const multiplier = order === 'asc' ? 1 : -1;

  return [...items].sort((left, right) => {
    if (kind === 'repositories' && sort === 'updated') {
      return (Date.parse(String(left.updated_at ?? 0)) - Date.parse(String(right.updated_at ?? 0))) * multiplier;
    }
    if (kind === 'users' && sort === 'joined') {
      return (Date.parse(String(left.created_at ?? 0)) - Date.parse(String(right.created_at ?? 0))) * multiplier;
    }
    if (kind === 'issues' && sort === 'updated') {
      return (Date.parse(String(left.updated_at ?? 0)) - Date.parse(String(right.updated_at ?? 0))) * multiplier;
    }
    if (kind === 'issues' && sort === 'created') {
      return (Date.parse(String(left.created_at ?? 0)) - Date.parse(String(right.created_at ?? 0))) * multiplier;
    }
    if (kind === 'commits' && (sort === 'author-date' || sort === 'committer-date')) {
      return (itemDate(left, sort) - itemDate(right, sort)) * multiplier;
    }
    if (kind === 'labels' && (sort === 'created' || sort === 'updated')) {
      const field = sort === 'created' ? 'created_at' : 'updated_at';
      return (Date.parse(String(left[field] ?? 0)) - Date.parse(String(right[field] ?? 0))) * multiplier;
    }
    const leftName = String(left.full_name ?? left.login ?? left.title ?? left.name);
    const rightName = String(right.full_name ?? right.login ?? right.title ?? right.name);
    return (right.score - left.score) || leftName.localeCompare(rightName);
  });
}

// ---------------------------------------------------------------------------
// Repository search
// ---------------------------------------------------------------------------

async function listLocalRepoSearchEntries(ctx: AgentContext, url: URL): Promise<SearchRepoEntry[]> {
  const { records } = await ctx.repo.records.query('repo', {
    dateSort: DateSort.CreatedAscending,
  } as any);

  const entries: SearchRepoEntry[] = [];
  const baseUrl = buildApiUrl(url);
  for (const record of records) {
    let data: Record<string, unknown>;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }

    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    const repo = recordToRepoInfo(record, data, tags);
    const topics = await listTopicNames(ctx, ctx.did, repo);
    entries.push({
      record,
      repo,
      topics,
      ownerDid : ctx.did,
      name     : repo.name,
      response : buildRepoResponse(repo, ctx.did, repo.name, baseUrl, topics),
    });
  }
  return entries;
}

async function listLocalOrgNames(ctx: AgentContext): Promise<string[]> {
  const { records } = await ctx.org.records.query('org', {
    dateSort: DateSort.CreatedAscending,
  } as any);

  const names: string[] = [];
  for (const record of records) {
    try {
      const data = await record.data.json();
      if (typeof data.name === 'string' && data.name.trim()) {
        names.push(data.name.trim().toLowerCase());
      }
    } catch { /* Ignore unreadable org records. */ }
  }
  return names;
}

async function filterRepoEntries(ctx: AgentContext, entries: SearchRepoEntry[], query: ParsedSearchQuery): Promise<SearchRepoEntry[]> {
  let filtered = [...entries];

  const userFilters = qualifierValues(query, 'user').map(value => value.toLowerCase());
  if (userFilters.length > 0) {
    filtered = filtered.filter(entry => userFilters.includes(entry.ownerDid.toLowerCase()));
  }

  const orgFilters = qualifierValues(query, 'org').map(value => value.toLowerCase());
  if (orgFilters.length > 0) {
    const localOrgs = await listLocalOrgNames(ctx);
    if (!orgFilters.some(org => localOrgs.includes(org))) {
      filtered = [];
    }
  }

  const repoFilters = qualifierValues(query, 'repo').map(value => value.toLowerCase());
  if (repoFilters.length > 0) {
    filtered = filtered.filter((entry) => {
      const fullName = `${entry.ownerDid}/${entry.name}`.toLowerCase();
      return repoFilters.includes(fullName) || repoFilters.includes(entry.name.toLowerCase());
    });
  }

  const languageFilters = qualifierValues(query, 'language').map(value => value.toLowerCase());
  if (languageFilters.length > 0) {
    filtered = filtered.filter(entry => languageFilters.includes(entry.repo.language.toLowerCase()));
  }

  const topicFilters = qualifierValues(query, 'topic').map(value => value.toLowerCase());
  if (topicFilters.length > 0) {
    filtered = filtered.filter(entry => topicFilters.every(topic => entry.topics.includes(topic)));
  }

  if (hasQualifier(query, 'is', 'public')) {
    filtered = filtered.filter(entry => entry.repo.visibility === 'public');
  }
  if (hasQualifier(query, 'is', 'private')) {
    filtered = filtered.filter(entry => entry.repo.visibility !== 'public');
  }

  return filtered;
}

export async function handleSearchRepositories(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  const entries = await filterRepoEntries(ctx, await listLocalRepoSearchEntries(ctx, url), parsed);
  const items = entries
    .map((entry) => {
      const score = scoreTerms(parsed.terms, [
        entry.name,
        entry.repo.description,
        entry.repo.language,
        ...entry.topics,
      ]);
      return { ...entry.response, score };
    })
    .filter(item => item.score > 0);
  const sorted = sortSearchItems(items, url, 'repositories');
  return searchEnvelope(sorted, sorted.length, url, '/search/repositories');
}

// ---------------------------------------------------------------------------
// Issue and pull request search
// ---------------------------------------------------------------------------

function searchStateFilter(query: ParsedSearchQuery): 'open' | 'closed' | null {
  const states = [...qualifierValues(query, 'state'), ...qualifierValues(query, 'is')].map(value => value.toLowerCase());
  if (states.includes('open')) { return 'open'; }
  if (states.includes('closed') || states.includes('merged')) { return 'closed'; }
  return null;
}

function shouldIncludeIssues(query: ParsedSearchQuery): boolean {
  const typeValues = [...qualifierValues(query, 'type'), ...qualifierValues(query, 'is')].map(value => value.toLowerCase());
  const hasIssueOrPullFilter = typeValues.some(value => value === 'issue' || value === 'pr' || value === 'pull-request');
  return !hasIssueOrPullFilter || typeValues.includes('issue');
}

function shouldIncludePulls(query: ParsedSearchQuery): boolean {
  const typeValues = [...qualifierValues(query, 'type'), ...qualifierValues(query, 'is')].map(value => value.toLowerCase());
  const hasIssueOrPullFilter = typeValues.some(value => value === 'issue' || value === 'pr' || value === 'pull-request');
  return !hasIssueOrPullFilter || typeValues.includes('pr') || typeValues.includes('pull-request');
}

function issueSearchValues(item: Record<string, unknown>): unknown[] {
  return [
    item.title,
    item.body,
    item.state,
    item.number,
    item.repository_url,
  ];
}

function pullToIssueSearchItem(pull: Record<string, unknown>, score: number): SearchItem {
  return {
    id                 : pull.id,
    node_id            : pull.node_id,
    url                : pull.issue_url,
    repository_url     : String(pull.issue_url ?? '').replace(/\/issues\/\d+$/, ''),
    labels_url         : `${pull.issue_url}/labels{/name}`,
    comments_url       : pull.comments_url,
    events_url         : `${pull.issue_url}/events`,
    html_url           : pull.html_url,
    number             : pull.number,
    title              : pull.title,
    body               : pull.body ?? null,
    state              : pull.state,
    locked             : false,
    comments           : 0,
    created_at         : pull.created_at,
    updated_at         : pull.updated_at,
    closed_at          : pull.closed_at ?? null,
    user               : pull.user,
    author_association : 'CONTRIBUTOR',
    labels             : [],
    assignee           : null,
    assignees          : [],
    milestone          : null,
    pull_request       : {
      url       : pull.url,
      html_url  : pull.html_url,
      diff_url  : pull.diff_url,
      patch_url : pull.patch_url,
    },
    score,
  };
}

async function collectSearchIssues(ctx: AgentContext, repos: SearchRepoEntry[], query: ParsedSearchQuery, url: URL): Promise<SearchItem[]> {
  const state = searchStateFilter(query);
  const items: SearchItem[] = [];
  const includeIssues = shouldIncludeIssues(query);
  const includePulls = shouldIncludePulls(query);

  for (const repo of repos) {
    if (includeIssues) {
      const issueUrl = new URL(url);
      issueUrl.search = '';
      issueUrl.searchParams.set('state', state ?? 'all');
      issueUrl.searchParams.set('per_page', '100');
      const response = await handleListIssues(ctx, repo.ownerDid, repo.name, issueUrl);
      if (response.status === 200) {
        const issueItems = JSON.parse(response.body as string) as Record<string, unknown>[];
        for (const issue of issueItems) {
          const score = scoreTerms(query.terms, issueSearchValues(issue));
          if (score > 0) { items.push({ ...issue, score }); }
        }
      }
    }

    if (includePulls) {
      const pullUrl = new URL(url);
      pullUrl.search = '';
      pullUrl.searchParams.set('state', state ?? 'all');
      pullUrl.searchParams.set('per_page', '100');
      const response = await handleListPulls(ctx, repo.ownerDid, repo.name, pullUrl);
      if (response.status === 200) {
        const pullItems = JSON.parse(response.body as string) as Record<string, unknown>[];
        for (const pull of pullItems) {
          const score = scoreTerms(query.terms, issueSearchValues(pull));
          if (score > 0) { items.push(pullToIssueSearchItem(pull, score)); }
        }
      }
    }
  }

  return sortSearchItems(items, url, 'issues');
}

export async function handleSearchIssues(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  const repos = await filterRepoEntries(ctx, await listLocalRepoSearchEntries(ctx, url), parsed);
  const items = await collectSearchIssues(ctx, repos, parsed, url);
  return searchEnvelope(items, items.length, url, '/search/issues');
}

// ---------------------------------------------------------------------------
// Code search
// ---------------------------------------------------------------------------

function codeSearchRef(entry: SearchRepoEntry, query: ParsedSearchQuery): string {
  return qualifierValues(query, 'ref')[0] ?? entry.repo.defaultBranch ?? 'HEAD';
}

function codeEntryMatchesQualifiers(path: string, query: ParsedSearchQuery): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = basename(path).toLowerCase();

  const pathFilters = qualifierList(query, 'path').map(value => value.replace(/^\/+|\/+$/g, ''));
  if (pathFilters.length > 0 && !pathFilters.some(filter => lowerPath.includes(filter))) {
    return false;
  }

  const filenameFilters = qualifierList(query, 'filename');
  if (filenameFilters.length > 0 && !filenameFilters.some(filter => fileName === filter || fileName.includes(filter))) {
    return false;
  }

  const extensionFilters = qualifierList(query, 'extension').map(value => value.replace(/^\./, ''));
  if (extensionFilters.length > 0 && !extensionFilters.some(filter => lowerPath.endsWith(`.${filter}`))) {
    return false;
  }

  return true;
}

function codeSearchValues(path: string, content: string, query: ParsedSearchQuery): unknown[] {
  const scopes = qualifierList(query, 'in');
  const searchPath = scopes.length === 0 || scopes.includes('path');
  const searchFile = scopes.length === 0 || scopes.includes('file') || scopes.includes('text');
  const values: unknown[] = [];
  if (searchPath) {
    values.push(path, basename(path));
  }
  if (searchFile) {
    values.push(content);
  }
  return values;
}

function codeSearchNeedsContent(query: ParsedSearchQuery): boolean {
  if (query.terms.length === 0) {
    return false;
  }
  const scopes = qualifierList(query, 'in');
  return scopes.length === 0 || scopes.includes('file') || scopes.includes('text');
}

function decodeBlobContent(item: Record<string, unknown>): string {
  if (typeof item.content !== 'string' || item.encoding !== 'base64') {
    return '';
  }
  try {
    const content = Buffer.from(item.content, 'base64').toString('utf-8');
    return content.includes('\0') ? '' : content;
  } catch {
    return '';
  }
}

function buildCodeSearchItem(
  entry: SearchRepoEntry,
  file: Record<string, unknown>,
  ref: string,
  baseUrl: string,
  score: number,
): SearchItem {
  const path = String(file.path ?? '');
  const sha = String(file.sha ?? '');
  const repoBase = `${baseUrl}/repos/${entry.ownerDid}/${entry.name}`;
  const encodedPath = encodePath(path);
  const encodedRef = encodeURIComponent(ref);
  return {
    name       : basename(path),
    path,
    sha,
    url        : `${repoBase}/contents/${encodedPath}?ref=${encodedRef}`,
    git_url    : `${repoBase}/git/blobs/${sha}`,
    html_url   : `${repoBase}/blob/${encodedRef}/${encodedPath}`,
    repository : entry.response,
    score,
  };
}

async function collectSearchCode(
  ctx: AgentContext, repos: SearchRepoEntry[], query: ParsedSearchQuery, url: URL, options: GitObjectOptions,
): Promise<SearchItem[]> {
  const items: SearchItem[] = [];
  const baseUrl = buildApiUrl(url);

  for (const repo of repos) {
    const ref = codeSearchRef(repo, query);
    const treeUrl = new URL(url);
    treeUrl.search = '';
    treeUrl.searchParams.set('recursive', '1');
    const treeResponse = await handleGetGitTree(ctx, repo.ownerDid, repo.name, ref, treeUrl, options);
    if (treeResponse.status !== 200) {
      continue;
    }

    const tree = JSON.parse(treeResponse.body as string) as { tree?: Record<string, unknown>[] };
    for (const file of tree.tree ?? []) {
      if (file.type !== 'blob' || typeof file.path !== 'string') {
        continue;
      }
      if (!codeEntryMatchesQualifiers(file.path, query)) {
        continue;
      }

      let content = '';
      if (codeSearchNeedsContent(query) && Number(file.size ?? 0) <= MAX_CODE_SEARCH_BLOB_BYTES) {
        const blobResponse = await handleGetGitBlob(ctx, repo.ownerDid, repo.name, String(file.sha ?? ''), url, options);
        if (blobResponse.status === 200) {
          content = decodeBlobContent(JSON.parse(blobResponse.body as string) as Record<string, unknown>);
        }
      }

      const score = scoreTerms(query.terms, codeSearchValues(file.path, content, query));
      if (score > 0) {
        items.push(buildCodeSearchItem(repo, file, ref, baseUrl, score));
      }
    }
  }

  return sortSearchItems(items, url, 'code');
}

export async function handleSearchCode(ctx: AgentContext, url: URL, options: GitObjectOptions = {}): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  const repos = await filterRepoEntries(ctx, await listLocalRepoSearchEntries(ctx, url), parsed);
  const items = await collectSearchCode(ctx, repos, parsed, url, options);
  return searchEnvelope(items, items.length, url, '/search/code');
}

// ---------------------------------------------------------------------------
// Commit search
// ---------------------------------------------------------------------------

function commitSearchRef(entry: SearchRepoEntry, query: ParsedSearchQuery): string {
  return qualifierValues(query, 'ref')[0] ?? entry.repo.defaultBranch ?? 'HEAD';
}

function personMatches(person: Record<string, unknown>, filters: string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  const values = [person.name, person.email].map(value => String(value ?? '').toLowerCase());
  return filters.some(filter => values.some(value => value.includes(filter)));
}

function dateMatches(value: unknown, filters: string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return filters.every((filter) => {
    const range = filter.split('..');
    if (range.length === 2) {
      const start = range[0] ? Date.parse(range[0]) : -Infinity;
      const end = range[1] ? Date.parse(range[1]) : Infinity;
      return timestamp >= start && timestamp <= end;
    }
    if (filter.startsWith('>=')) {
      return timestamp >= Date.parse(filter.slice(2));
    }
    if (filter.startsWith('>')) {
      return timestamp > Date.parse(filter.slice(1));
    }
    if (filter.startsWith('<=')) {
      return timestamp <= Date.parse(filter.slice(2));
    }
    if (filter.startsWith('<')) {
      return timestamp < Date.parse(filter.slice(1));
    }
    return String(value ?? '').startsWith(filter);
  });
}

function commitMatchesQualifiers(commitItem: Record<string, unknown>, query: ParsedSearchQuery): boolean {
  const commit = asRecord(commitItem.commit);
  const author = asRecord(commit.author);
  const committer = asRecord(commit.committer);
  const sha = String(commitItem.sha ?? '').toLowerCase();

  const hashFilters = qualifierList(query, 'hash');
  if (hashFilters.length > 0 && !hashFilters.some(filter => sha.startsWith(filter))) {
    return false;
  }

  if (!personMatches(author, [...qualifierList(query, 'author'), ...qualifierList(query, 'author-name')])) {
    return false;
  }
  if (!personMatches(committer, [...qualifierList(query, 'committer'), ...qualifierList(query, 'committer-name')])) {
    return false;
  }
  if (!personMatches({ email: author.email }, qualifierList(query, 'author-email'))) {
    return false;
  }
  if (!personMatches({ email: committer.email }, qualifierList(query, 'committer-email'))) {
    return false;
  }
  if (!dateMatches(author.date, qualifierList(query, 'author-date'))) {
    return false;
  }
  if (!dateMatches(committer.date, qualifierList(query, 'committer-date'))) {
    return false;
  }

  const mergeFilters = qualifierList(query, 'merge');
  if (mergeFilters.length > 0) {
    const isMerge = Array.isArray(commitItem.parents) && commitItem.parents.length > 1;
    if (mergeFilters.includes('true') && !isMerge) {
      return false;
    }
    if (mergeFilters.includes('false') && isMerge) {
      return false;
    }
  }

  return true;
}

function commitSearchScore(commitItem: Record<string, unknown>, query: ParsedSearchQuery): number {
  const commit = asRecord(commitItem.commit);
  const author = asRecord(commit.author);
  const committer = asRecord(commit.committer);
  return scoreTerms(query.terms, [
    commitItem.sha,
    commit.message,
    author.name,
    author.email,
    committer.name,
    committer.email,
  ]);
}

async function collectSearchCommits(
  ctx: AgentContext, repos: SearchRepoEntry[], query: ParsedSearchQuery, url: URL, options: GitObjectOptions,
): Promise<SearchItem[]> {
  const items: SearchItem[] = [];

  for (const repo of repos) {
    const commitUrl = new URL(url);
    commitUrl.search = '';
    commitUrl.searchParams.set('sha', commitSearchRef(repo, query));
    commitUrl.searchParams.set('per_page', '100');
    const response = await handleListRepoCommits(ctx, repo.ownerDid, repo.name, commitUrl, options);
    if (response.status !== 200) {
      continue;
    }

    const commits = JSON.parse(response.body as string) as Record<string, unknown>[];
    for (const commit of commits) {
      if (!commitMatchesQualifiers(commit, query)) {
        continue;
      }
      const score = commitSearchScore(commit, query);
      if (score > 0) {
        items.push({
          ...commit,
          repository: repo.response,
          score,
        });
      }
    }
  }

  return sortSearchItems(items, url, 'commits');
}

export async function handleSearchCommits(ctx: AgentContext, url: URL, options: GitObjectOptions = {}): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  const repos = await filterRepoEntries(ctx, await listLocalRepoSearchEntries(ctx, url), parsed);
  const items = await collectSearchCommits(ctx, repos, parsed, url, options);
  return searchEnvelope(items, items.length, url, '/search/commits');
}

// ---------------------------------------------------------------------------
// Label search
// ---------------------------------------------------------------------------

function findRepoEntryById(entries: SearchRepoEntry[], value: string | null): SearchRepoEntry | JsonResponse {
  if (!value || !/^\d+$/.test(value)) {
    return jsonValidationError('Validation Failed: repository_id is required.');
  }

  const id = Number(value);
  const entry = entries.find(candidate => Number(candidate.response.id) === id);
  if (!entry) {
    return jsonNotFound(`Repository with id '${value}' not found.`);
  }
  return entry;
}

async function collectSearchLabels(
  ctx: AgentContext, repo: SearchRepoEntry, terms: string[], url: URL,
): Promise<SearchItem[]> {
  const labelsUrl = new URL(url);
  labelsUrl.search = '';
  labelsUrl.searchParams.set('per_page', '100');
  const response = await handleListRepoLabels(ctx, repo.ownerDid, repo.name, labelsUrl);
  if (response.status !== 200) {
    return [];
  }

  const labels = JSON.parse(response.body as string) as Record<string, unknown>[];
  const items = labels
    .map((label) => {
      const score = scoreTerms(terms, [label.name, label.description, label.color]);
      return {
        ...label,
        created_at : null,
        updated_at : null,
        score,
      };
    })
    .filter(item => item.score > 0);

  return sortSearchItems(items, url, 'labels');
}

export async function handleSearchLabels(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const terms = parseSearchTerms(url.searchParams.get('q'));
  if ('status' in terms) { return terms; }

  const repo = findRepoEntryById(await listLocalRepoSearchEntries(ctx, url), url.searchParams.get('repository_id'));
  if ('status' in repo) { return repo; }

  const items = await collectSearchLabels(ctx, repo, terms, url);
  return searchEnvelope(items, items.length, url, '/search/labels');
}

// ---------------------------------------------------------------------------
// Topic search
// ---------------------------------------------------------------------------

function displayTopicName(name: string): string {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function topicDescription(name: string): string {
  return `Repositories tagged ${name}.`;
}

function buildTopicSearchItem(entry: TopicSearchEntry, score: number): SearchItem {
  return {
    name              : entry.name,
    display_name      : displayTopicName(entry.name),
    short_description : topicDescription(entry.name),
    description       : topicDescription(entry.name),
    created_by        : null,
    released          : null,
    created_at        : entry.createdAt,
    updated_at        : entry.updatedAt,
    featured          : false,
    curated           : false,
    score,
  };
}

function localTopicEntries(repos: SearchRepoEntry[]): TopicSearchEntry[] {
  const topics = new Map<string, TopicSearchEntry>();
  for (const repo of repos) {
    for (const topic of repo.topics) {
      const existing = topics.get(topic);
      const createdAt = repo.repo.dateCreated ?? null;
      const updatedAt = repo.repo.timestamp ?? repo.repo.dateCreated ?? null;
      if (!existing) {
        topics.set(topic, { name: topic, createdAt, updatedAt });
        continue;
      }
      if (createdAt && (!existing.createdAt || createdAt.localeCompare(existing.createdAt) < 0)) {
        existing.createdAt = createdAt;
      }
      if (updatedAt && (!existing.updatedAt || updatedAt.localeCompare(existing.updatedAt) > 0)) {
        existing.updatedAt = updatedAt;
      }
    }
  }
  return [...topics.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function handleSearchTopics(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  if (hasQualifier(parsed, 'is', 'featured') || hasQualifier(parsed, 'is', 'curated')) {
    return searchEnvelope([], 0, url, '/search/topics');
  }

  const items = localTopicEntries(await listLocalRepoSearchEntries(ctx, url))
    .map((entry) => {
      const score = scoreTerms(parsed.terms, [
        entry.name,
        displayTopicName(entry.name),
        topicDescription(entry.name),
      ]);
      return buildTopicSearchItem(entry, score);
    })
    .filter(item => item.score > 0);

  const sorted = sortSearchItems(items, url, 'topics');
  return searchEnvelope(sorted, sorted.length, url, '/search/topics');
}

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

export async function handleSearchUsers(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const parsed = parseSearchQuery(url.searchParams.get('q'));
  if ('status' in parsed) { return parsed; }

  const baseUrl = buildApiUrl(url);
  const allUsers = await collectVisibleUserDids(ctx);
  const items = allUsers
    .map((did) => {
      const profile = buildUserProfile(did, baseUrl);
      const score = scoreTerms(parsed.terms, [did]);
      return { ...profile, score };
    })
    .filter(item => item.score > 0);
  const sorted = sortSearchItems(items, url, 'users');
  return searchEnvelope(sorted, sorted.length, url, '/search/users');
}
