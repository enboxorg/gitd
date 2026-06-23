/**
 * GitHub API shim — commit statuses and checks endpoints.
 *
 * Maps `forge-ci` check suites and check runs to GitHub REST API v3 status
 * and Checks API responses.
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
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonCreated,
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

type CiSuite = {
  rec : any;
  data : Record<string, any>;
  tags : Record<string, string>;
};

type CiRun = {
  suite : CiSuite;
  rec : any;
  data : Record<string, any>;
  tags : Record<string, string>;
};

type GitHubStatusState = 'error' | 'failure' | 'pending' | 'success';
type ForgeCiStatus = 'queued' | 'in_progress' | 'completed';
type ForgeCiConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';
type CheckRunListResult = { runs: CiRun[] } | { error: JsonResponse };
type CheckSuiteListResult = { suites: CiSuite[] } | { error: JsonResponse };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveCommitRef(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, ref: string,
): Promise<string> {
  const decoded = decodeRouteParam(ref);
  const from = fromOpt(ctx, targetDid);

  const { records } = await ctx.refs.records.query('repo/ref' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const candidates = [
    decoded,
    `refs/heads/${decoded}`,
    `refs/tags/${decoded}`,
    decoded.startsWith('heads/') ? `refs/${decoded}` : '',
    decoded.startsWith('tags/') ? `refs/${decoded}` : '',
  ].filter(Boolean);

  for (const rec of records) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    const name = data.name ?? tags.name;
    if (candidates.includes(name)) {
      return data.target ?? tags.target ?? decoded;
    }
  }

  return decoded;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function querySuites(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, commitSha?: string,
): Promise<CiSuite[]> {
  const from = fromOpt(ctx, targetDid);
  const filter: Record<string, unknown> = { contextId: repo.contextId };
  if (commitSha) { filter.tags = { commitSha }; }

  const { records } = await ctx.ci.records.query('repo/checkSuite' as any, {
    from,
    filter,
    dateSort: DateSort.CreatedDescending,
  });

  const suites: CiSuite[] = [];
  for (const rec of records) {
    suites.push({
      rec,
      data : await rec.data.json(),
      tags : (rec.tags as Record<string, string> | undefined) ?? {},
    });
  }
  return suites;
}

async function queryRunsForSuite(
  ctx: AgentContext, targetDid: string, suite: CiSuite,
): Promise<CiRun[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.ci.records.query('repo/checkSuite/checkRun' as any, {
    from,
    filter   : { contextId: suite.rec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const runs: CiRun[] = [];
  for (const rec of records) {
    runs.push({
      suite,
      rec,
      data : await rec.data.json(),
      tags : (rec.tags as Record<string, string> | undefined) ?? {},
    });
  }
  return runs;
}

async function queryRunsForSuites(
  ctx: AgentContext, targetDid: string, suites: CiSuite[],
): Promise<CiRun[]> {
  const runs: CiRun[] = [];
  for (const suite of suites) {
    runs.push(...await queryRunsForSuite(ctx, targetDid, suite));
  }
  return runs;
}

async function findSuiteByNumber(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, id: string,
): Promise<CiSuite | null> {
  const wanted = parseInt(id, 10);
  const suites = await querySuites(ctx, targetDid, repo);
  return suites.find(suite => numericId(suite.rec.id ?? '') === wanted) ?? null;
}

async function findRunByNumber(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, id: string,
): Promise<CiRun | null> {
  const wanted = parseInt(id, 10);
  const suites = await querySuites(ctx, targetDid, repo);
  for (const suite of suites) {
    const runs = await queryRunsForSuite(ctx, targetDid, suite);
    const match = runs.find(run => numericId(run.rec.id ?? '') === wanted);
    if (match) { return match; }
  }
  return null;
}

async function findBranchForCommit(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, commitSha: string,
): Promise<string | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.refs.records.query('repo/ref' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  for (const rec of records) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    const name = data.name ?? tags.name;
    const target = data.target ?? tags.target;
    const type = data.type ?? tags.type;
    if (target === commitSha && type === 'branch' && typeof name === 'string') {
      return name.replace(/^refs\/heads\//, '');
    }
  }

  return null;
}

function createdEmpty(): JsonResponse {
  return {
    status  : 201,
    headers : baseHeaders(),
    body    : '',
  };
}

function toGitHubStatusState(status: string | undefined, conclusion: string | undefined): GitHubStatusState {
  if (status !== 'completed') { return 'pending'; }
  if (conclusion === 'success' || conclusion === 'skipped') { return 'success'; }
  if (conclusion === 'cancelled') { return 'error'; }
  return 'failure';
}

function statusFromGitHubState(state: string): { status: ForgeCiStatus; conclusion?: ForgeCiConclusion } {
  switch (state) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failure':
      return { status: 'completed', conclusion: 'failure' };
    case 'error':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'pending':
      return { status: 'in_progress' };
    default:
      return { status: 'queued' };
  }
}

function combineStatus(states: GitHubStatusState[]): 'failure' | 'pending' | 'success' {
  if (states.length === 0) { return 'pending'; }
  if (states.some(state => state === 'failure' || state === 'error')) { return 'failure'; }
  if (states.some(state => state === 'pending')) { return 'pending'; }
  return 'success';
}

function buildApp(appName: string, baseUrl: string): Record<string, unknown> {
  return {
    id         : numericId(appName),
    slug       : appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gitd-ci',
    node_id    : appName,
    owner      : buildOwner(appName, baseUrl),
    name       : appName,
    html_url   : `${baseUrl}/apps/${encodeURIComponent(appName)}`,
    created_at : new Date(0).toISOString(),
    updated_at : new Date(0).toISOString(),
  };
}

function suiteAppName(suite: CiSuite): string {
  return suite.data.app ?? 'gitd-ci';
}

function rawRunOutput(run: CiRun): Record<string, any> {
  const output = run.data.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output;
  }
  return run.data;
}

function runAnnotations(run: CiRun): Record<string, any>[] {
  const annotations = rawRunOutput(run).annotations;
  return Array.isArray(annotations)
    ? annotations.filter(annotation => annotation && typeof annotation === 'object')
    : [];
}

function runOutput(
  run: CiRun, targetDid?: string, repo?: RepoInfo, baseUrl?: string,
): Record<string, string | number> {
  const output = rawRunOutput(run);
  const id = numericId(run.rec.id ?? '');
  return {
    title             : output.title ?? run.tags.name ?? 'check',
    summary           : output.summary ?? '',
    text              : output.text ?? '',
    annotations_count : runAnnotations(run).length,
    annotations_url   : targetDid && repo && baseUrl
      ? `${baseUrl}/repos/${targetDid}/${repo.name}/check-runs/${id}/annotations`
      : '',
  };
}

function suiteHeadSha(suite: CiSuite): string {
  return suite.tags.commitSha ?? '';
}

function runUpdatedAt(run: CiRun): number {
  const raw = run.rec.timestamp ?? run.rec.dateCreated ?? '';
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function applyLatestFilter(runs: CiRun[]): CiRun[] {
  const latestByName = new Map<string, CiRun>();
  for (const run of runs) {
    const name = run.tags.name ?? 'check';
    const previous = latestByName.get(name);
    if (!previous || runUpdatedAt(run) >= runUpdatedAt(previous)) {
      latestByName.set(name, run);
    }
  }
  return [...latestByName.values()];
}

function filterCheckRuns(runs: CiRun[], url: URL): CheckRunListResult {
  const status = url.searchParams.get('status');
  if (status && !['queued', 'in_progress', 'completed'].includes(status)) {
    return { error: jsonValidationError('Validation Failed: status must be queued, in_progress, or completed.') };
  }

  const filter = url.searchParams.get('filter') ?? 'latest';
  if (!['latest', 'all'].includes(filter)) {
    return { error: jsonValidationError('Validation Failed: filter must be latest or all.') };
  }

  const appId = url.searchParams.get('app_id');
  const parsedAppId = appId ? parseInt(appId, 10) : null;
  if (appId && Number.isNaN(parsedAppId)) {
    return { error: jsonValidationError('Validation Failed: app_id must be an integer.') };
  }

  const checkName = url.searchParams.get('check_name');
  let filtered = runs;
  if (checkName) {
    filtered = filtered.filter(run => (run.tags.name ?? 'check') === checkName);
  }
  if (status) {
    filtered = filtered.filter(run => (run.tags.status ?? 'queued') === status);
  }
  if (parsedAppId !== null) {
    filtered = filtered.filter(run => numericId(suiteAppName(run.suite)) === parsedAppId);
  }
  if (filter === 'latest') {
    filtered = applyLatestFilter(filtered);
  }

  filtered = [...filtered].sort((a, b) => runUpdatedAt(b) - runUpdatedAt(a));
  return { runs: filtered };
}

async function filterCheckSuites(
  ctx: AgentContext, targetDid: string, suites: CiSuite[], url: URL,
): Promise<CheckSuiteListResult> {
  const appId = url.searchParams.get('app_id');
  const parsedAppId = appId ? parseInt(appId, 10) : null;
  if (appId && Number.isNaN(parsedAppId)) {
    return { error: jsonValidationError('Validation Failed: app_id must be an integer.') };
  }

  const checkName = url.searchParams.get('check_name');
  let filtered = suites;
  if (parsedAppId !== null) {
    filtered = filtered.filter(suite => numericId(suiteAppName(suite)) === parsedAppId);
  }
  if (checkName) {
    const withNamedRun: CiSuite[] = [];
    for (const suite of filtered) {
      const runs = await queryRunsForSuite(ctx, targetDid, suite);
      if (runs.some(run => (run.tags.name ?? 'check') === checkName)) {
        withNamedRun.push(suite);
      }
    }
    filtered = withNamedRun;
  }

  return { suites: filtered };
}

async function checkSuitesResponse(
  ctx: AgentContext, suites: CiSuite[], targetDid: string, repo: RepoInfo, url: URL,
): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(suites, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, suites.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;
  const checkSuites = [];

  for (const suite of paged) {
    checkSuites.push(buildCheckSuiteResponse(suite, await queryRunsForSuite(ctx, targetDid, suite), targetDid, repo, baseUrl));
  }

  return jsonOk({
    total_count  : suites.length,
    check_suites : checkSuites,
  }, extraHeaders);
}

function checkRunsResponse(
  runs: CiRun[], targetDid: string, repo: RepoInfo, url: URL,
): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(runs, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, runs.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : runs.length,
    check_runs  : paged.map(run => buildCheckRunResponse(run, targetDid, repo, baseUrl)),
  }, extraHeaders);
}

function buildCheckSuiteResponse(
  suite: CiSuite, runs: CiRun[],
  targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const id = numericId(suite.rec.id ?? '');
  const commitSha = suiteHeadSha(suite);
  const appName = suiteAppName(suite);

  return {
    id,
    node_id                 : suite.rec.id ?? '',
    head_branch             : suite.tags.branch ?? suite.data.headBranch ?? null,
    head_sha                : commitSha,
    status                  : suite.tags.status ?? 'queued',
    conclusion              : suite.tags.conclusion ?? null,
    url                     : `${baseUrl}/repos/${targetDid}/${repo.name}/check-suites/${id}`,
    before                  : null,
    after                   : commitSha,
    pull_requests           : [],
    app                     : buildApp(appName, baseUrl),
    created_at              : toISODate(suite.rec.dateCreated),
    updated_at              : toISODate(suite.rec.timestamp),
    latest_check_runs_count : runs.length,
    check_runs_url          : `${baseUrl}/repos/${targetDid}/${repo.name}/check-suites/${id}/check-runs`,
  };
}

function buildCheckRunResponse(
  run: CiRun, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const id = numericId(run.rec.id ?? '');
  const suiteId = numericId(run.suite.rec.id ?? '');
  const appName = suiteAppName(run.suite);
  const status = run.tags.status ?? 'queued';
  const conclusion = run.tags.conclusion ?? null;

  return {
    id,
    node_id      : run.rec.id ?? '',
    name         : run.tags.name ?? 'check',
    head_sha     : suiteHeadSha(run.suite),
    external_id  : run.rec.id ?? '',
    url          : `${baseUrl}/repos/${targetDid}/${repo.name}/check-runs/${id}`,
    html_url     : `${baseUrl}/repos/${targetDid}/${repo.name}/checks/${id}`,
    details_url  : '',
    status,
    conclusion,
    started_at   : toISODate(run.data.startedAt ?? run.rec.dateCreated),
    completed_at : status === 'completed' ? toISODate(run.data.completedAt ?? run.rec.timestamp) : null,
    output       : runOutput(run, targetDid, repo, baseUrl),
    check_suite  : {
      id      : suiteId,
      node_id : run.suite.rec.id ?? '',
    },
    app           : buildApp(appName, baseUrl),
    pull_requests : [],
  };
}

function buildStatusResponse(
  run: CiRun, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const id = numericId(run.rec.id ?? '');
  const state = toGitHubStatusState(run.tags.status, run.tags.conclusion);
  const output = runOutput(run);
  const context = run.tags.name ?? suiteAppName(run.suite);

  return {
    url         : `${baseUrl}/repos/${targetDid}/${repo.name}/statuses/${suiteHeadSha(run.suite)}`,
    avatar_url  : '',
    id,
    node_id     : run.rec.id ?? '',
    state,
    description : output.summary || null,
    target_url  : '',
    context,
    created_at  : toISODate(run.rec.dateCreated),
    updated_at  : toISODate(run.rec.timestamp),
    creator     : buildOwner(run.rec.author ?? targetDid, baseUrl),
  };
}

function annotationNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function annotationString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function annotationNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function buildAnnotationResponse(
  run: CiRun, annotation: Record<string, any>, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const path = annotationString(annotation.path);
  const startLine = annotationNumber(annotation.start_line, 1);
  const endLine = annotationNumber(annotation.end_line, startLine);
  const level = annotationString(annotation.annotation_level, 'warning');
  const fallbackBlobHref = `${baseUrl}/repos/${targetDid}/${repo.name}/contents/${encodeURIComponent(path)}?ref=${suiteHeadSha(run.suite)}`;

  return {
    path,
    start_line       : startLine,
    end_line         : endLine,
    start_column     : typeof annotation.start_column === 'number' ? annotation.start_column : null,
    end_column       : typeof annotation.end_column === 'number' ? annotation.end_column : null,
    annotation_level : ['notice', 'warning', 'failure'].includes(level) ? level : 'warning',
    title            : annotationNullableString(annotation.title),
    message          : annotationString(annotation.message),
    raw_details      : annotationNullableString(annotation.raw_details),
    blob_href        : annotationString(annotation.blob_href, fallbackBlobHref),
  };
}

function requestOutput(reqBody: Record<string, unknown>): Record<string, any> | undefined {
  const output = reqBody.output;
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, any>
    : undefined;
}

function mergeCheckRunOutput(previous: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const merged = { ...previous, ...next };
  if (Array.isArray(next.annotations)) {
    merged.annotations = [
      ...(Array.isArray(previous.annotations) ? previous.annotations : []),
      ...next.annotations,
    ];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/commits/:ref/status
// ---------------------------------------------------------------------------

export async function handleGetCombinedStatus(
  ctx: AgentContext, targetDid: string, repoName: string, ref: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const commitSha = await resolveCommitRef(ctx, targetDid, repo, ref);
  const suites = await querySuites(ctx, targetDid, repo, commitSha);
  const runs = await queryRunsForSuites(ctx, targetDid, suites);
  const statuses = runs.map(run => buildStatusResponse(run, targetDid, repo, baseUrl));
  const states = statuses.map(status => status.state as GitHubStatusState);

  return jsonOk({
    state       : combineStatus(states),
    statuses,
    sha         : commitSha,
    total_count : statuses.length,
    repository  : buildRepoResponse(repo, targetDid, repo.name, baseUrl),
    commit_url  : `${baseUrl}/repos/${targetDid}/${repo.name}/commits/${commitSha}`,
    url         : `${baseUrl}/repos/${targetDid}/${repo.name}/commits/${commitSha}/status`,
  });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/commits/:ref/statuses
// ---------------------------------------------------------------------------

export async function handleListCommitStatuses(
  ctx: AgentContext, targetDid: string, repoName: string, ref: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const commitSha = await resolveCommitRef(ctx, targetDid, repo, ref);
  const suites = await querySuites(ctx, targetDid, repo, commitSha);
  const runs = await queryRunsForSuites(ctx, targetDid, suites);

  return jsonOk(runs.map(run => buildStatusResponse(run, targetDid, repo, baseUrl)));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/statuses/:sha
// ---------------------------------------------------------------------------

export async function handleCreateCommitStatus(
  ctx: AgentContext, targetDid: string, repoName: string,
  sha: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const state = reqBody.state as string | undefined;
  if (!state || !['error', 'failure', 'pending', 'success'].includes(state)) {
    return jsonValidationError('Validation Failed: state must be error, failure, pending, or success.');
  }

  const context = (reqBody.context as string) ?? 'default';
  const description = (reqBody.description as string) ?? '';
  const mapped = statusFromGitHubState(state);
  const baseUrl = buildApiUrl(url);

  const suiteTags: Record<string, string> = {
    commitSha : sha,
    status    : mapped.status,
  };
  if (mapped.conclusion) { suiteTags.conclusion = mapped.conclusion; }

  const { status: suiteStatus, record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
    data            : { app: 'github-status' },
    tags            : suiteTags,
    parentContextId : repo.contextId,
  } as any);

  if (suiteStatus.code >= 300) {
    return jsonValidationError(`Failed to create status suite: ${suiteStatus.detail}`);
  }
  if (!suiteRec) {throw new Error('Failed to create status suite record');}

  const runTags: Record<string, string> = {
    name   : context,
    status : mapped.status,
  };
  if (mapped.conclusion) { runTags.conclusion = mapped.conclusion; }

  const { status: runStatus, record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
    data            : { output: { title: context, summary: description } },
    tags            : runTags,
    parentContextId : suiteRec.contextId,
  } as any);

  if (runStatus.code >= 300) {
    return jsonValidationError(`Failed to create status run: ${runStatus.detail}`);
  }
  if (!runRec) {throw new Error('Failed to create status run record');}

  const suite: CiSuite = {
    rec  : suiteRec,
    data : await suiteRec.data.json(),
    tags : (suiteRec.tags as Record<string, string> | undefined) ?? {},
  };
  const run: CiRun = {
    suite,
    rec  : runRec,
    data : await runRec.data.json(),
    tags : (runRec.tags as Record<string, string> | undefined) ?? {},
  };

  return jsonCreated(buildStatusResponse(run, targetDid, repo, baseUrl));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/commits/:ref/check-suites
// ---------------------------------------------------------------------------

export async function handleListCheckSuitesForRef(
  ctx: AgentContext, targetDid: string, repoName: string, ref: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const commitSha = await resolveCommitRef(ctx, targetDid, repo, ref);
  const suites = await querySuites(ctx, targetDid, repo, commitSha);
  const result = await filterCheckSuites(ctx, targetDid, suites, url);
  if ('error' in result) { return result.error; }

  return checkSuitesResponse(ctx, result.suites, targetDid, repo, url);
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/check-suites
// ---------------------------------------------------------------------------

export async function handleCreateCheckSuite(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const headSha = reqBody.head_sha as string | undefined;
  if (!headSha) { return jsonValidationError('Validation Failed: head_sha is required.'); }

  const app = typeof reqBody.app === 'string' && reqBody.app ? reqBody.app : 'github-checks';
  const suites = await querySuites(ctx, targetDid, repo, headSha);
  const existing = suites.find(suite => suiteAppName(suite) === app);
  if (existing) {
    return jsonOk(buildCheckSuiteResponse(
      existing, await queryRunsForSuite(ctx, targetDid, existing), targetDid, repo, buildApiUrl(url),
    ));
  }

  const branch = await findBranchForCommit(ctx, targetDid, repo, headSha);
  const tags: Record<string, string> = { commitSha: headSha, status: 'queued' };
  if (branch) { tags.branch = branch; }

  const { status, record } = await ctx.ci.records.create('repo/checkSuite' as any, {
    data            : { app, headBranch: branch ?? '' },
    tags,
    parentContextId : repo.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create check suite: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create check suite record'); }

  const suite: CiSuite = {
    rec  : record,
    data : await record.data.json(),
    tags : (record.tags as Record<string, string> | undefined) ?? {},
  };

  return jsonCreated(buildCheckSuiteResponse(suite, [], targetDid, repo, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/commits/:ref/check-runs
// ---------------------------------------------------------------------------

export async function handleListCheckRunsForRef(
  ctx: AgentContext, targetDid: string, repoName: string, ref: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const commitSha = await resolveCommitRef(ctx, targetDid, repo, ref);
  const suites = await querySuites(ctx, targetDid, repo, commitSha);
  const result = filterCheckRuns(await queryRunsForSuites(ctx, targetDid, suites), url);
  if ('error' in result) { return result.error; }

  return checkRunsResponse(result.runs, targetDid, repo, url);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/check-suites/:id
// ---------------------------------------------------------------------------

export async function handleGetCheckSuite(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Check suite ${id} not found.`);
  }

  return jsonOk(buildCheckSuiteResponse(
    suite, await queryRunsForSuite(ctx, targetDid, suite), targetDid, repo, buildApiUrl(url),
  ));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/check-suites/:id/rerequest
// ---------------------------------------------------------------------------

export async function handleRerequestCheckSuite(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Check suite ${id} not found.`);
  }

  const tags: Record<string, string> = { ...suite.tags, status: 'queued' };
  delete tags.conclusion;
  const { status } = await suite.rec.update({ data: suite.data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to rerequest check suite: ${status.detail}`);
  }

  return createdEmpty();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/check-suites/:id/check-runs
// ---------------------------------------------------------------------------

export async function handleListCheckRunsForSuite(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Check suite ${id} not found.`);
  }

  const result = filterCheckRuns(await queryRunsForSuite(ctx, targetDid, suite), url);
  if ('error' in result) { return result.error; }

  return checkRunsResponse(result.runs, targetDid, repo, url);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/check-runs/:id
// ---------------------------------------------------------------------------

export async function handleGetCheckRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Check run ${id} not found.`);
  }

  return jsonOk(buildCheckRunResponse(run, targetDid, repo, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/check-runs/:id/annotations
// ---------------------------------------------------------------------------

export async function handleListCheckRunAnnotations(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Check run ${id} not found.`);
  }

  const baseUrl = buildApiUrl(url);
  const annotations = runAnnotations(run).map(annotation => buildAnnotationResponse(run, annotation, targetDid, repo, baseUrl));
  const pagination = parsePagination(url);
  const paged = paginate(annotations, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, annotations.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk(paged, extraHeaders);
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/check-runs/:id/rerequest
// ---------------------------------------------------------------------------

export async function handleRerequestCheckRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Check run ${id} not found.`);
  }

  const tags: Record<string, string> = { ...run.suite.tags, status: 'queued' };
  delete tags.conclusion;
  const { status } = await run.suite.rec.update({ data: run.suite.data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to rerequest check run: ${status.detail}`);
  }

  return createdEmpty();
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/check-runs
// ---------------------------------------------------------------------------

export async function handleCreateCheckRun(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const name = reqBody.name as string | undefined;
  const headSha = reqBody.head_sha as string | undefined;
  if (!name) { return jsonValidationError('Validation Failed: name is required.'); }
  if (!headSha) { return jsonValidationError('Validation Failed: head_sha is required.'); }

  const status = ((reqBody.status as string | undefined) ?? 'queued') as ForgeCiStatus;
  if (!['queued', 'in_progress', 'completed'].includes(status)) {
    return jsonValidationError('Validation Failed: status must be queued, in_progress, or completed.');
  }

  const conclusion = reqBody.conclusion as ForgeCiConclusion | undefined;
  const output = requestOutput(reqBody) ?? {};

  const suiteTags: Record<string, string> = { commitSha: headSha, status };
  if (conclusion) { suiteTags.conclusion = conclusion; }

  const { status: suiteStatus, record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
    data            : { app: 'github-checks' },
    tags            : suiteTags,
    parentContextId : repo.contextId,
  } as any);

  if (suiteStatus.code >= 300) {
    return jsonValidationError(`Failed to create check suite: ${suiteStatus.detail}`);
  }
  if (!suiteRec) {throw new Error('Failed to create check suite record');}

  const runTags: Record<string, string> = { name, status };
  if (conclusion) { runTags.conclusion = conclusion; }

  const { status: runStatus, record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
    data            : { output },
    tags            : runTags,
    parentContextId : suiteRec.contextId,
  } as any);

  if (runStatus.code >= 300) {
    return jsonValidationError(`Failed to create check run: ${runStatus.detail}`);
  }
  if (!runRec) {throw new Error('Failed to create check run record');}

  const suite: CiSuite = {
    rec  : suiteRec,
    data : await suiteRec.data.json(),
    tags : (suiteRec.tags as Record<string, string> | undefined) ?? {},
  };
  const run: CiRun = {
    suite,
    rec  : runRec,
    data : await runRec.data.json(),
    tags : (runRec.tags as Record<string, string> | undefined) ?? {},
  };

  return jsonCreated(buildCheckRunResponse(run, targetDid, repo, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/check-runs/:id
// ---------------------------------------------------------------------------

export async function handleUpdateCheckRun(
  ctx: AgentContext, targetDid: string, repoName: string,
  id: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Check run ${id} not found.`);
  }

  const status = ((reqBody.status as string | undefined) ?? run.tags.status ?? 'queued') as ForgeCiStatus;
  if (!['queued', 'in_progress', 'completed'].includes(status)) {
    return jsonValidationError('Validation Failed: status must be queued, in_progress, or completed.');
  }

  const conclusion = (reqBody.conclusion as ForgeCiConclusion | undefined) ?? run.tags.conclusion;
  const nextOutput = requestOutput(reqBody);
  const output = nextOutput
    ? mergeCheckRunOutput(rawRunOutput(run), nextOutput)
    : rawRunOutput(run);
  const tags: Record<string, string> = { ...run.tags, status };
  if (conclusion) { tags.conclusion = conclusion; }

  const { status: updateStatus } = await run.rec.update({
    data: { output },
    tags,
  });

  if (updateStatus.code >= 300) {
    return jsonValidationError(`Failed to update check run: ${updateStatus.detail}`);
  }

  const suiteTags: Record<string, string> = { ...run.suite.tags, status };
  if (conclusion) { suiteTags.conclusion = conclusion; }
  await run.suite.rec.update({
    data : run.suite.data,
    tags : suiteTags,
  });

  const updatedRun: CiRun = {
    ...run,
    data  : { output },
    tags,
    suite : {
      ...run.suite,
      tags: suiteTags,
    },
  };

  return jsonOk(buildCheckRunResponse(updatedRun, targetDid, repo, buildApiUrl(url)));
}
