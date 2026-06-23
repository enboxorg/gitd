/**
 * GitHub API shim — Actions workflow run and job endpoints.
 *
 * Maps `forge-ci` check suites and check runs to GitHub Actions-compatible
 * workflow run and workflow job responses.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { buildRepoResponse } from './repos.js';

import {
  baseHeaders,
  binaryOk,
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
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

type CiArtifact = {
  suite : CiSuite;
  run : CiRun;
  rec : any;
  tags : Record<string, any>;
};

type WorkflowState = 'active' | 'disabled_manually';

type WorkflowSettingsEntry = {
  id : number;
  name : string;
  path : string;
  state : WorkflowState;
  createdAt : string;
  updatedAt : string;
};

type ActionsVariableEntry = {
  name : string;
  value : string;
  createdAt : string;
  updatedAt : string;
};

type ActionsSecretEntry = {
  name : string;
  encryptedValue : string;
  keyId : string;
  createdAt : string;
  updatedAt : string;
};

type ActionsCacheEntry = {
  id : number;
  ref : string;
  key : string;
  version : string;
  lastAccessedAt : string;
  createdAt : string;
  sizeInBytes : number;
};

type ActionsAllowedActionsPolicy = 'all' | 'local_only' | 'selected';
type ActionsDefaultWorkflowPermissions = 'read' | 'write';

type ActionsSelectedActionsSettings = {
  githubOwnedAllowed : boolean;
  verifiedAllowed : boolean;
  patternsAllowed : string[];
};

type ActionsPermissionsSettings = {
  enabled : boolean;
  allowedActions : ActionsAllowedActionsPolicy;
  shaPinningRequired : boolean;
  selectedActions : ActionsSelectedActionsSettings;
  defaultWorkflowPermissions : ActionsDefaultWorkflowPermissions;
  canApprovePullRequestReviews : boolean;
};

type EnvironmentSettingsEntry = {
  id : number;
  name : string;
  createdAt : string;
  updatedAt : string;
  waitTimer? : number;
  preventSelfReview? : boolean;
  reviewers? : Array<{ type: 'User' | 'Team'; id: number }>;
  deploymentBranchPolicy? : { protectedBranches: boolean; customBranchPolicies: boolean } | null;
  variables? : Record<string, ActionsVariableEntry>;
  secrets? : Record<string, ActionsSecretEntry>;
};

type RepoSettingsData = {
  actionsWorkflows? : Record<string, WorkflowSettingsEntry>;
  actionsVariables? : Record<string, ActionsVariableEntry>;
  actionsSecrets? : Record<string, ActionsSecretEntry>;
  actionsCaches? : Record<string, ActionsCacheEntry>;
  actionsCacheRetentionLimitDays? : number;
  actionsCacheStorageLimitGb? : number;
  actionsPermissions? : ActionsPermissionsSettings;
  environments? : Record<string, EnvironmentSettingsEntry>;
};

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

type WorkflowInfo = {
  id : number;
  name : string;
  path : string;
  state : WorkflowState;
  createdAt : string;
  updatedAt : string;
};

const ACTION_RUN_STATUSES = new Set([
  'completed',
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'success',
  'timed_out',
  'in_progress',
  'queued',
  'requested',
  'waiting',
  'pending',
]);

const DEFAULT_ACTIONS_CACHE_RETENTION_LIMIT_DAYS = 7;
const DEFAULT_ACTIONS_CACHE_STORAGE_LIMIT_GB = 10;
const ACTIONS_CACHE_SORTS = new Set(['created_at', 'last_accessed_at', 'size_in_bytes']);
const ACTIONS_ALLOWED_ACTIONS_POLICIES = new Set(['all', 'local_only', 'selected']);
const ACTIONS_DEFAULT_WORKFLOW_PERMISSIONS = new Set(['read', 'write']);
const SORT_ASC = 'asc';
const SORT_DESC = 'desc';

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function querySuites(
  ctx: AgentContext, targetDid: string, repo: RepoInfo,
): Promise<CiSuite[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.ci.records.query('repo/checkSuite' as any, {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
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

async function queryArtifactsForRun(
  ctx: AgentContext, targetDid: string, run: CiRun,
): Promise<CiArtifact[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.ci.records.query('repo/checkSuite/checkRun/artifact' as any, {
    from,
    filter   : { contextId: run.rec.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  return records.map(rec => ({
    suite : run.suite,
    run,
    rec,
    tags  : (rec.tags as Record<string, any> | undefined) ?? {},
  }));
}

async function querySettings(
  ctx: AgentContext, targetDid: string, repo: RepoInfo,
): Promise<RepoSettingsLookup> {
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

function createdEmpty(): JsonResponse {
  return {
    status  : 201,
    headers : baseHeaders(),
    body    : '',
  };
}

function acceptedEmpty(): JsonResponse {
  return {
    status  : 202,
    headers : baseHeaders(),
    body    : '',
  };
}

function jsonConflict(message: string): JsonResponse {
  return {
    status  : 409,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest' }),
  };
}

function suiteId(suite: CiSuite): number {
  return numericId(suite.rec.id ?? '');
}

function runId(run: CiRun): number {
  return numericId(run.rec.id ?? '');
}

function suiteAppName(suite: CiSuite): string {
  return suite.data.app ?? 'gitd-ci';
}

function workflowId(name: string): number {
  return numericId(`workflow:${name}`);
}

function workflowSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gitd-ci';
}

function workflowPath(name: string): string {
  return `.github/workflows/${workflowSlug(name)}.yml`;
}

function workflowSettingsKey(workflow: WorkflowInfo): string {
  return String(workflow.id);
}

function suiteHeadSha(suite: CiSuite): string {
  return suite.tags.commitSha ?? '';
}

function suiteHeadBranch(suite: CiSuite, repo: RepoInfo): string {
  return suite.tags.branch ?? suite.data.headBranch ?? repo.defaultBranch;
}

function suiteStatus(suite: CiSuite): string {
  return suite.tags.status ?? 'queued';
}

function suiteConclusion(suite: CiSuite): string | null {
  return suite.tags.conclusion ?? null;
}

function elapsedMs(start: unknown, end: unknown): number {
  const startTime = Date.parse(String(start ?? ''));
  const endTime = Date.parse(String(end ?? ''));
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) { return 0; }
  return Math.max(0, endTime - startTime);
}

function workflowRunDurationMs(suite: CiSuite): number {
  return elapsedMs(
    suite.data.startedAt ?? suite.rec.dateCreated,
    suite.data.completedAt ?? suite.rec.timestamp ?? suite.rec.dateCreated,
  );
}

function workflowJobDurationMs(run: CiRun): number {
  return elapsedMs(
    run.data.startedAt ?? run.rec.dateCreated,
    run.data.completedAt ?? run.rec.timestamp ?? run.rec.dateCreated,
  );
}

function rawRunOutput(run: CiRun): Record<string, any> {
  const output = run.data.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output;
  }
  return run.data;
}

function actionActor(suite: CiSuite, targetDid: string, baseUrl: string): Record<string, unknown> {
  return buildOwner(suite.rec.author ?? targetDid, baseUrl);
}

function buildWorkflowResponse(
  workflow: WorkflowInfo, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  return {
    id         : workflow.id,
    node_id    : `workflow:${workflow.name}`,
    name       : workflow.name,
    path       : workflow.path,
    state      : workflow.state,
    created_at : workflow.createdAt,
    updated_at : workflow.updatedAt,
    url        : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/workflows/${workflow.id}`,
    html_url   : `${baseUrl}/repos/${targetDid}/${repo.name}/blob/${repo.defaultBranch}/${workflow.path}`,
    badge_url  : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/workflows/${encodeURIComponent(workflow.name)}/badge.svg`,
  };
}

function buildWorkflowRunResponse(
  suite: CiSuite, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const id = suiteId(suite);
  const appName = suiteAppName(suite);
  const branch = suiteHeadBranch(suite, repo);
  const headSha = suiteHeadSha(suite);
  const idForWorkflow = workflowId(appName);
  const actor = actionActor(suite, targetDid, baseUrl);
  const repository = buildRepoResponse(repo, targetDid, repo.name, baseUrl);

  return {
    id,
    name                : appName,
    node_id             : suite.rec.id ?? '',
    check_suite_id      : id,
    check_suite_node_id : suite.rec.id ?? '',
    head_branch         : branch,
    head_sha            : headSha,
    path                : `${workflowPath(appName)}@${branch}`,
    run_number          : id,
    event               : suite.data.event ?? 'push',
    display_title       : suite.data.displayTitle ?? appName,
    status              : suiteStatus(suite),
    conclusion          : suiteConclusion(suite),
    workflow_id         : idForWorkflow,
    url                 : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}`,
    html_url            : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}`,
    pull_requests       : [],
    created_at          : toISODate(suite.rec.dateCreated),
    updated_at          : toISODate(suite.rec.timestamp),
    actor,
    run_attempt         : 1,
    run_started_at      : toISODate(suite.data.startedAt ?? suite.rec.dateCreated),
    triggering_actor    : actor,
    jobs_url            : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}/jobs`,
    logs_url            : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}/logs`,
    check_suite_url     : `${baseUrl}/repos/${targetDid}/${repo.name}/check-suites/${id}`,
    artifacts_url       : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}/artifacts`,
    cancel_url          : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}/cancel`,
    rerun_url           : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${id}/rerun`,
    workflow_url        : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/workflows/${idForWorkflow}`,
    head_commit         : {
      id        : headSha,
      tree_id   : '',
      message   : suite.data.message ?? `${appName} workflow run`,
      timestamp : toISODate(suite.rec.dateCreated),
      author    : { name: suite.rec.author ?? targetDid, email: '' },
      committer : { name: suite.rec.author ?? targetDid, email: '' },
    },
    repository,
    head_repository: repository,
  };
}

function workflowsFromSuites(suites: CiSuite[], settings: RepoSettingsData): WorkflowInfo[] {
  const byId = new Map<number, WorkflowInfo>();

  for (const suite of suites) {
    const name = suiteAppName(suite);
    const id = workflowId(name);
    const existing = byId.get(id);
    const createdAt = toISODate(suite.rec.dateCreated);
    const updatedAt = toISODate(suite.rec.timestamp);
    if (!existing) {
      byId.set(id, {
        id,
        name,
        path  : workflowPath(name),
        state : settings.actionsWorkflows?.[String(id)]?.state ?? 'active',
        createdAt,
        updatedAt,
      });
      continue;
    }

    if (createdAt < existing.createdAt) { existing.createdAt = createdAt; }
    if (updatedAt > existing.updatedAt) { existing.updatedAt = updatedAt; }
  }

  for (const workflow of Object.values(settings.actionsWorkflows ?? {})) {
    if (!byId.has(workflow.id)) {
      byId.set(workflow.id, {
        id        : workflow.id,
        name      : workflow.name,
        path      : workflow.path,
        state     : workflow.state,
        createdAt : workflow.createdAt,
        updatedAt : workflow.updatedAt,
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function workflowMatchesParam(workflow: WorkflowInfo, rawId: string): boolean {
  const decoded = decodeRouteParam(rawId);
  const basename = workflow.path.split('/').pop() ?? workflow.path;
  const slug = workflowSlug(workflow.name);
  return decoded === String(workflow.id)
    || decoded === workflow.path
    || decoded === basename
    || decoded === workflow.name
    || decoded === slug
    || decoded === `${slug}.yml`
    || decoded === `${slug}.yaml`;
}

async function listWorkflows(
  ctx: AgentContext, targetDid: string, repo: RepoInfo,
): Promise<{ suites: CiSuite[]; settingsLookup: RepoSettingsLookup; workflows: WorkflowInfo[] }> {
  const [suites, settingsLookup] = await Promise.all([
    querySuites(ctx, targetDid, repo),
    querySettings(ctx, targetDid, repo),
  ]);
  return { suites, settingsLookup, workflows: workflowsFromSuites(suites, settingsLookup.settings) };
}

async function findWorkflow(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, id: string,
): Promise<{ suites: CiSuite[]; settingsLookup: RepoSettingsLookup; workflow: WorkflowInfo } | null> {
  const result = await listWorkflows(ctx, targetDid, repo);
  const workflow = result.workflows.find(candidate => workflowMatchesParam(candidate, id));
  return workflow ? { ...result, workflow } : null;
}

function workflowSettingsWithState(
  settings: RepoSettingsData, workflow: WorkflowInfo, state: WorkflowState,
): RepoSettingsData {
  const actionsWorkflows = { ...(settings.actionsWorkflows ?? {}) };
  actionsWorkflows[workflowSettingsKey(workflow)] = {
    id        : workflow.id,
    name      : workflow.name,
    path      : workflow.path,
    state,
    createdAt : workflow.createdAt,
    updatedAt : new Date().toISOString(),
  };
  return { ...settings, actionsWorkflows };
}

function variableKey(name: string): string {
  return name.toUpperCase();
}

function environmentKey(name: string): string {
  return name.toLowerCase();
}

function decodeRequiredRouteParam(value: string, fieldName: string): string | JsonResponse {
  const decoded = decodeRouteParam(value).trim();
  if (!decoded) {
    return jsonValidationError(`Validation Failed: ${fieldName} is invalid.`);
  }
  return decoded;
}

function parseRequiredString(value: unknown, fieldName: string): string | JsonResponse {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonValidationError(`Validation Failed: ${fieldName} is required.`);
  }
  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function parseRequiredValue(value: unknown, fieldName: string): string | JsonResponse {
  if (typeof value !== 'string') {
    return jsonValidationError(`Validation Failed: ${fieldName} is required.`);
  }
  return value;
}

function parseOptionalValue(value: unknown, fieldName: string): string | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return jsonValidationError(`Validation Failed: ${fieldName} must be a string.`);
  }
  return value;
}

function parseRequiredBoolean(value: unknown, fieldName: string): boolean | JsonResponse {
  if (typeof value !== 'boolean') {
    return jsonValidationError(`Validation Failed: ${fieldName} is required.`);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    return jsonValidationError(`Validation Failed: ${fieldName} must be a boolean.`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, fieldName: string): number | JsonResponse {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be a positive integer.`);
  }
  return value;
}

function parseAllowedActionsPolicy(value: unknown): ActionsAllowedActionsPolicy | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string' || !ACTIONS_ALLOWED_ACTIONS_POLICIES.has(value)) {
    return jsonValidationError('Validation Failed: allowed_actions must be all, local_only, or selected.');
  }
  return value as ActionsAllowedActionsPolicy;
}

function parseDefaultWorkflowPermissions(value: unknown): ActionsDefaultWorkflowPermissions | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string' || !ACTIONS_DEFAULT_WORKFLOW_PERMISSIONS.has(value)) {
    return jsonValidationError('Validation Failed: default_workflow_permissions must be read or write.');
  }
  return value as ActionsDefaultWorkflowPermissions;
}

function parseOptionalStringArray(value: unknown, fieldName: string): string[] | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be an array of strings.`);
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return jsonValidationError(`Validation Failed: ${fieldName} must be an array of non-empty strings.`);
    }
    const trimmed = item.trim();
    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function buildVariableResponse(variable: ActionsVariableEntry): Record<string, unknown> {
  return {
    name       : variable.name,
    value      : variable.value,
    created_at : toISODate(variable.createdAt),
    updated_at : toISODate(variable.updatedAt),
  };
}

function normalizedActionsPermissions(settings: RepoSettingsData): ActionsPermissionsSettings {
  const permissions = settings.actionsPermissions;
  return {
    enabled            : permissions?.enabled ?? true,
    allowedActions     : permissions?.allowedActions ?? 'all',
    shaPinningRequired : permissions?.shaPinningRequired ?? false,
    selectedActions    : {
      githubOwnedAllowed : permissions?.selectedActions?.githubOwnedAllowed ?? true,
      verifiedAllowed    : permissions?.selectedActions?.verifiedAllowed ?? true,
      patternsAllowed    : [...(permissions?.selectedActions?.patternsAllowed ?? [])],
    },
    defaultWorkflowPermissions   : permissions?.defaultWorkflowPermissions ?? 'read',
    canApprovePullRequestReviews : permissions?.canApprovePullRequestReviews ?? false,
  };
}

function buildActionsPermissionsResponse(
  permissions: ActionsPermissionsSettings, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    enabled              : permissions.enabled,
    allowed_actions      : permissions.allowedActions,
    selected_actions_url : `${baseUrl}/repos/${targetDid}/${repoName}/actions/permissions/selected-actions`,
    sha_pinning_required : permissions.shaPinningRequired,
  };
}

function buildSelectedActionsResponse(permissions: ActionsPermissionsSettings): Record<string, unknown> {
  return {
    github_owned_allowed : permissions.selectedActions.githubOwnedAllowed,
    verified_allowed     : permissions.selectedActions.verifiedAllowed,
    patterns_allowed     : permissions.selectedActions.patternsAllowed,
  };
}

function buildWorkflowPermissionsResponse(permissions: ActionsPermissionsSettings): Record<string, unknown> {
  return {
    default_workflow_permissions     : permissions.defaultWorkflowPermissions,
    can_approve_pull_request_reviews : permissions.canApprovePullRequestReviews,
  };
}

function buildSecretPublicKey(scope: string): Record<string, string> {
  return {
    key_id : String(numericId(`actions-secret-key:${scope}`) || 1),
    key    : createHash('sha256').update(`gitd-actions-secret-key:${scope}`).digest('base64'),
  };
}

function buildSecretResponse(secret: ActionsSecretEntry): Record<string, unknown> {
  return {
    name       : secret.name,
    created_at : toISODate(secret.createdAt),
    updated_at : toISODate(secret.updatedAt),
  };
}

function buildActionsCacheResponse(cache: ActionsCacheEntry): Record<string, unknown> {
  return {
    id               : cache.id,
    ref              : cache.ref,
    key              : cache.key,
    version          : cache.version,
    last_accessed_at : toISODate(cache.lastAccessedAt),
    created_at       : toISODate(cache.createdAt),
    size_in_bytes    : cache.sizeInBytes,
  };
}

function variableEntries(variables?: Record<string, ActionsVariableEntry>): ActionsVariableEntry[] {
  return Object.values(variables ?? {})
    .filter((variable): variable is ActionsVariableEntry => Boolean(variable) && typeof variable.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function secretEntries(secrets?: Record<string, ActionsSecretEntry>): ActionsSecretEntry[] {
  return Object.values(secrets ?? {})
    .filter((secret): secret is ActionsSecretEntry => Boolean(secret) && typeof secret.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cacheEntries(caches?: Record<string, ActionsCacheEntry>): ActionsCacheEntry[] {
  return Object.values(caches ?? {})
    .filter((cache): cache is ActionsCacheEntry => (
      Boolean(cache)
      && typeof cache.id === 'number'
      && typeof cache.key === 'string'
      && typeof cache.ref === 'string'
    ));
}

function variableListResponse(variables: ActionsVariableEntry[], url: URL): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(variables, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, variables.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : variables.length,
    variables   : paged.map(buildVariableResponse),
  }, extraHeaders);
}

function secretListResponse(secrets: ActionsSecretEntry[], url: URL): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(secrets, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, secrets.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : secrets.length,
    secrets     : paged.map(buildSecretResponse),
  }, extraHeaders);
}

function sortedCacheEntries(caches: ActionsCacheEntry[], sort: string, direction: string): ActionsCacheEntry[] {
  const multiplier = direction === SORT_ASC ? 1 : -1;
  return [...caches].sort((a, b) => {
    let result = 0;
    if (sort === 'size_in_bytes') {
      result = a.sizeInBytes - b.sizeInBytes;
    } else {
      const left = sort === 'created_at' ? a.createdAt : a.lastAccessedAt;
      const right = sort === 'created_at' ? b.createdAt : b.lastAccessedAt;
      result = Date.parse(left) - Date.parse(right);
    }
    if (result === 0) {
      result = a.id - b.id;
    }
    return result * multiplier;
  });
}

function filteredCacheEntries(caches: ActionsCacheEntry[], url: URL): ActionsCacheEntry[] | JsonResponse {
  const sort = url.searchParams.get('sort') ?? 'last_accessed_at';
  if (!ACTIONS_CACHE_SORTS.has(sort)) {
    return jsonValidationError('Validation Failed: sort must be one of created_at, last_accessed_at, size_in_bytes.');
  }

  const direction = url.searchParams.get('direction') ?? SORT_DESC;
  if (direction !== SORT_ASC && direction !== SORT_DESC) {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const ref = url.searchParams.get('ref');
  const key = url.searchParams.get('key');
  const filtered = caches.filter(cache => {
    if (ref && cache.ref !== ref) { return false; }
    if (key && !cache.key.startsWith(key)) { return false; }
    return true;
  });
  return sortedCacheEntries(filtered, sort, direction);
}

function actionsCacheListResponse(caches: ActionsCacheEntry[], url: URL): JsonResponse {
  const filtered = filteredCacheEntries(caches, url);
  if ('status' in filtered) { return filtered; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, filtered.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count    : filtered.length,
    actions_caches : paged.map(buildActionsCacheResponse),
  }, extraHeaders);
}

function repositoryVariableSettingsWithChange(
  settings: RepoSettingsData, key: string, variable: ActionsVariableEntry | null,
): RepoSettingsData {
  const actionsVariables = { ...(settings.actionsVariables ?? {}) };
  if (variable) {
    actionsVariables[key] = variable;
  } else {
    delete actionsVariables[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(actionsVariables).length > 0) {
    next.actionsVariables = actionsVariables;
  } else {
    delete next.actionsVariables;
  }
  return next;
}

function repositorySecretSettingsWithChange(
  settings: RepoSettingsData, key: string, secret: ActionsSecretEntry | null,
): RepoSettingsData {
  const actionsSecrets = { ...(settings.actionsSecrets ?? {}) };
  if (secret) {
    actionsSecrets[key] = secret;
  } else {
    delete actionsSecrets[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(actionsSecrets).length > 0) {
    next.actionsSecrets = actionsSecrets;
  } else {
    delete next.actionsSecrets;
  }
  return next;
}

function repositoryCacheSettingsWithChange(
  settings: RepoSettingsData, key: string, cache: ActionsCacheEntry | null,
): RepoSettingsData {
  const actionsCaches = { ...(settings.actionsCaches ?? {}) };
  if (cache) {
    actionsCaches[key] = cache;
  } else {
    delete actionsCaches[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(actionsCaches).length > 0) {
    next.actionsCaches = actionsCaches;
  } else {
    delete next.actionsCaches;
  }
  return next;
}

function environmentVariableSettingsWithChange(
  settings: RepoSettingsData,
  environmentKeyValue: string,
  environment: EnvironmentSettingsEntry,
  key: string,
  variable: ActionsVariableEntry | null,
): RepoSettingsData {
  const variables = { ...(environment.variables ?? {}) };
  if (variable) {
    variables[key] = variable;
  } else {
    delete variables[key];
  }

  const updatedEnvironment: EnvironmentSettingsEntry = { ...environment };
  if (Object.keys(variables).length > 0) {
    updatedEnvironment.variables = variables;
  } else {
    delete updatedEnvironment.variables;
  }

  return {
    ...settings,
    environments: {
      ...(settings.environments ?? {}),
      [environmentKeyValue]: updatedEnvironment,
    },
  };
}

function environmentSecretSettingsWithChange(
  settings: RepoSettingsData,
  environmentKeyValue: string,
  environment: EnvironmentSettingsEntry,
  key: string,
  secret: ActionsSecretEntry | null,
): RepoSettingsData {
  const secrets = { ...(environment.secrets ?? {}) };
  if (secret) {
    secrets[key] = secret;
  } else {
    delete secrets[key];
  }

  const updatedEnvironment: EnvironmentSettingsEntry = { ...environment };
  if (Object.keys(secrets).length > 0) {
    updatedEnvironment.secrets = secrets;
  } else {
    delete updatedEnvironment.secrets;
  }

  return {
    ...settings,
    environments: {
      ...(settings.environments ?? {}),
      [environmentKeyValue]: updatedEnvironment,
    },
  };
}

async function getRepoSettingsLookup(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoSettingsLookup | JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }
  return querySettings(ctx, targetDid, repo);
}

async function findRepositoryVariable(
  ctx: AgentContext, targetDid: string, repoName: string, rawName: string,
): Promise<{ lookup: RepoSettingsLookup; variable: ActionsVariableEntry; key: string } | JsonResponse> {
  const name = decodeRequiredRouteParam(rawName, 'name');
  if (typeof name !== 'string') { return name; }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = variableKey(name);
  const variable = lookup.settings.actionsVariables?.[key];
  if (!variable) {
    return jsonNotFound(`Variable '${name}' not found.`);
  }
  return { lookup, variable, key };
}

async function findRepositorySecret(
  ctx: AgentContext, targetDid: string, repoName: string, rawName: string,
): Promise<{ lookup: RepoSettingsLookup; secret: ActionsSecretEntry; key: string } | JsonResponse> {
  const name = decodeRequiredRouteParam(rawName, 'secret_name');
  if (typeof name !== 'string') { return name; }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = variableKey(name);
  const secret = lookup.settings.actionsSecrets?.[key];
  if (!secret) {
    return jsonNotFound(`Secret '${name}' not found.`);
  }
  return { lookup, secret, key };
}

async function findRepositoryCache(
  ctx: AgentContext, targetDid: string, repoName: string, rawId: string,
): Promise<{ lookup: RepoSettingsLookup; cache: ActionsCacheEntry; key: string } | JsonResponse> {
  const cacheId = parseInt(rawId, 10);
  if (!Number.isInteger(cacheId) || cacheId < 1) {
    return jsonNotFound(`Actions cache '${rawId}' not found.`);
  }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  for (const [key, cache] of Object.entries(lookup.settings.actionsCaches ?? {})) {
    if (cache.id === cacheId) {
      return { lookup, cache, key };
    }
  }
  return jsonNotFound(`Actions cache '${rawId}' not found.`);
}

async function findEnvironmentForVariables(
  ctx: AgentContext, targetDid: string, repoName: string, rawEnvironmentName: string,
): Promise<{ lookup: RepoSettingsLookup; environment: EnvironmentSettingsEntry; key: string; name: string } | JsonResponse> {
  const environmentName = decodeRequiredRouteParam(rawEnvironmentName, 'environment_name');
  if (typeof environmentName !== 'string') { return environmentName; }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = environmentKey(environmentName);
  const environment = lookup.settings.environments?.[key];
  if (!environment) {
    return jsonNotFound(`Environment '${environmentName}' not found.`);
  }
  return { lookup, environment, key, name: environmentName };
}

async function findEnvironmentVariable(
  ctx: AgentContext, targetDid: string, repoName: string, rawEnvironmentName: string, rawName: string,
): Promise<{
  lookup: RepoSettingsLookup;
  environment: EnvironmentSettingsEntry;
  environmentKey: string;
  variable: ActionsVariableEntry;
  variableKey: string;
} | JsonResponse> {
  const environmentResult = await findEnvironmentForVariables(ctx, targetDid, repoName, rawEnvironmentName);
  if ('status' in environmentResult) { return environmentResult; }

  const name = decodeRequiredRouteParam(rawName, 'name');
  if (typeof name !== 'string') { return name; }

  const key = variableKey(name);
  const variable = environmentResult.environment.variables?.[key];
  if (!variable) {
    return jsonNotFound(`Variable '${name}' not found in environment '${environmentResult.name}'.`);
  }

  return {
    lookup         : environmentResult.lookup,
    environment    : environmentResult.environment,
    environmentKey : environmentResult.key,
    variable,
    variableKey    : key,
  };
}

async function findEnvironmentSecret(
  ctx: AgentContext, targetDid: string, repoName: string, rawEnvironmentName: string, rawName: string,
): Promise<{
  lookup: RepoSettingsLookup;
  environment: EnvironmentSettingsEntry;
  environmentKey: string;
  secret: ActionsSecretEntry;
  secretKey: string;
} | JsonResponse> {
  const environmentResult = await findEnvironmentForVariables(ctx, targetDid, repoName, rawEnvironmentName);
  if ('status' in environmentResult) { return environmentResult; }

  const name = decodeRequiredRouteParam(rawName, 'secret_name');
  if (typeof name !== 'string') { return name; }

  const key = variableKey(name);
  const secret = environmentResult.environment.secrets?.[key];
  if (!secret) {
    return jsonNotFound(`Secret '${name}' not found in environment '${environmentResult.name}'.`);
  }

  return {
    lookup         : environmentResult.lookup,
    environment    : environmentResult.environment,
    environmentKey : environmentResult.key,
    secret,
    secretKey      : key,
  };
}

function workflowJobSteps(run: CiRun): Record<string, unknown>[] {
  const output = rawRunOutput(run);
  if (Array.isArray(output.steps)) {
    return output.steps
      .filter(step => step && typeof step === 'object')
      .map((step, index) => ({
        name         : typeof step.name === 'string' ? step.name : `Step ${index + 1}`,
        status       : typeof step.status === 'string' ? step.status : run.tags.status ?? 'queued',
        conclusion   : typeof step.conclusion === 'string' ? step.conclusion : run.tags.conclusion ?? null,
        number       : typeof step.number === 'number' ? step.number : index + 1,
        started_at   : toISODate(step.started_at ?? run.data.startedAt ?? run.rec.dateCreated),
        completed_at : step.completed_at ? toISODate(step.completed_at) : null,
      }));
  }

  return [{
    name         : output.title ?? run.tags.name ?? 'check',
    status       : run.tags.status ?? 'queued',
    conclusion   : run.tags.conclusion ?? null,
    number       : 1,
    started_at   : toISODate(run.data.startedAt ?? run.rec.dateCreated),
    completed_at : run.tags.status === 'completed' ? toISODate(run.data.completedAt ?? run.rec.timestamp) : null,
  }];
}

function buildWorkflowJobResponse(
  run: CiRun, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const id = runId(run);
  const workflowRunId = suiteId(run.suite);
  const status = run.tags.status ?? 'queued';

  return {
    id,
    run_id        : workflowRunId,
    run_url       : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${workflowRunId}`,
    node_id       : run.rec.id ?? '',
    head_sha      : suiteHeadSha(run.suite),
    url           : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/jobs/${id}`,
    html_url      : `${baseUrl}/repos/${targetDid}/${repo.name}/runs/${workflowRunId}/jobs/${id}`,
    logs_url      : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/jobs/${id}/logs`,
    status,
    conclusion    : run.tags.conclusion ?? null,
    started_at    : toISODate(run.data.startedAt ?? run.rec.dateCreated),
    completed_at  : status === 'completed' ? toISODate(run.data.completedAt ?? run.rec.timestamp) : null,
    name          : run.tags.name ?? 'check',
    steps         : workflowJobSteps(run),
    check_run_url : `${baseUrl}/repos/${targetDid}/${repo.name}/check-runs/${id}`,
    labels        : ['gitd'],
    runner_id     : null,
    runner_name   : null,
    workflow_name : suiteAppName(run.suite),
    head_branch   : suiteHeadBranch(run.suite, repo),
  };
}

function artifactId(artifact: CiArtifact): number {
  return numericId(artifact.rec.id ?? '');
}

function artifactName(artifact: CiArtifact): string {
  return String(artifact.tags.name ?? artifact.tags.filename ?? 'artifact');
}

function artifactExpired(artifact: CiArtifact): boolean {
  return artifact.tags.expired === true || artifact.tags.expired === 'true';
}

function artifactExpiresAt(artifact: CiArtifact): string {
  if (artifact.tags.expiresAt) { return toISODate(artifact.tags.expiresAt); }
  const created = Date.parse(String(artifact.rec.dateCreated ?? ''));
  const base = Number.isFinite(created) ? created : 0;
  return new Date(base + 90 * 24 * 60 * 60 * 1000).toISOString();
}

function taggedArtifactSize(artifact: CiArtifact): number | null {
  const raw = artifact.tags.size;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) { return parsed; }
  }
  return null;
}

async function artifactBytes(artifact: CiArtifact): Promise<Uint8Array> {
  const blob = await artifact.rec.data.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

async function artifactDigest(artifact: CiArtifact): Promise<string> {
  if (artifact.tags.digest) { return artifact.tags.digest; }
  const bytes = await artifactBytes(artifact);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function buildArtifactResponse(
  artifact: CiArtifact, targetDid: string, repo: RepoInfo, baseUrl: string,
): Promise<Record<string, unknown>> {
  const id = artifactId(artifact);
  const size = taggedArtifactSize(artifact) ?? (await artifactBytes(artifact)).byteLength;
  const repositoryId = numericId(repo.contextId);

  return {
    id,
    node_id              : artifact.rec.id ?? '',
    name                 : artifactName(artifact),
    size_in_bytes        : size,
    url                  : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/artifacts/${id}`,
    archive_download_url : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/artifacts/${id}/zip`,
    expired              : artifactExpired(artifact),
    created_at           : toISODate(artifact.rec.dateCreated),
    expires_at           : artifactExpiresAt(artifact),
    updated_at           : toISODate(artifact.rec.timestamp ?? artifact.rec.dateCreated),
    digest               : await artifactDigest(artifact),
    workflow_run         : {
      id                 : suiteId(artifact.suite),
      repository_id      : repositoryId,
      head_repository_id : repositoryId,
      head_branch        : suiteHeadBranch(artifact.suite, repo),
      head_sha           : suiteHeadSha(artifact.suite),
    },
  };
}

async function queryArtifactsForRuns(
  ctx: AgentContext, targetDid: string, runs: CiRun[],
): Promise<CiArtifact[]> {
  const artifacts: CiArtifact[] = [];
  for (const run of runs) {
    artifacts.push(...await queryArtifactsForRun(ctx, targetDid, run));
  }
  return artifacts;
}

async function queryArtifactsForRepo(
  ctx: AgentContext, targetDid: string, repo: RepoInfo,
): Promise<CiArtifact[]> {
  const artifacts: CiArtifact[] = [];
  for (const suite of await querySuites(ctx, targetDid, repo)) {
    artifacts.push(...await queryArtifactsForRuns(ctx, targetDid, await queryRunsForSuite(ctx, targetDid, suite)));
  }
  return sortArtifactsByCreatedAt(artifacts, 'desc');
}

function sortArtifactsByCreatedAt(artifacts: CiArtifact[], direction: 'asc' | 'desc'): CiArtifact[] {
  return [...artifacts].sort((left, right) => {
    const leftTime = Date.parse(String(left.rec.dateCreated ?? '')) || 0;
    const rightTime = Date.parse(String(right.rec.dateCreated ?? '')) || 0;
    return direction === 'asc' ? leftTime - rightTime : rightTime - leftTime;
  });
}

function sortArtifacts(artifacts: CiArtifact[], direction: string): CiArtifact[] | JsonResponse {
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }
  return sortArtifactsByCreatedAt(artifacts, direction);
}

function filterArtifacts(artifacts: CiArtifact[], url: URL): CiArtifact[] | JsonResponse {
  const name = url.searchParams.get('name');
  const direction = url.searchParams.get('direction') ?? 'desc';
  const filtered = name ? artifacts.filter(artifact => artifactName(artifact) === name) : artifacts;
  return sortArtifacts(filtered, direction);
}

async function artifactsResponse(
  artifacts: CiArtifact[], targetDid: string, repo: RepoInfo, url: URL,
): Promise<JsonResponse> {
  const filtered = filterArtifacts(artifacts, url);
  if (!Array.isArray(filtered)) { return filtered; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, filtered.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : filtered.length,
    artifacts   : await Promise.all(paged.map(artifact => buildArtifactResponse(artifact, targetDid, repo, baseUrl))),
  }, extraHeaders);
}

async function findArtifactByNumber(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, id: string,
): Promise<CiArtifact | null> {
  const wanted = parseInt(id, 10);
  if (Number.isNaN(wanted)) { return null; }
  const artifacts = await queryArtifactsForRepo(ctx, targetDid, repo);
  return artifacts.find(artifact => artifactId(artifact) === wanted) ?? null;
}

function artifactDownloadRedirect(location: string): JsonResponse {
  return {
    status  : 302,
    headers : {
      ...baseHeaders(),
      Location: location,
    },
    body: '',
  };
}

function artifactGone(message: string): JsonResponse {
  return {
    status  : 410,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest' }),
  };
}

type ZipEntry = {
  name : string;
  data : Uint8Array;
};

const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    chunks.push(local, entry.data);

    const directory = new Uint8Array(46 + name.byteLength);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, entry.data.byteLength, true);
    directoryView.setUint32(24, entry.data.byteLength, true);
    directoryView.setUint16(28, name.byteLength, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);

    offset += local.byteLength + entry.data.byteLength;
  }

  const centralDirectory = concatBytes(central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, offset, true);

  return concatBytes([...chunks, centralDirectory, end]);
}

function safeLogFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'job';
}

function workflowJobLogText(run: CiRun): string {
  const output = rawRunOutput(run);
  if (run.data.logsDeleted === true || output.logsDeleted === true) {
    return '';
  }

  const lines = [
    `# ${String(run.tags.name ?? output.title ?? 'check')}`,
    `status: ${String(run.tags.status ?? 'queued')}`,
  ];
  if (run.tags.conclusion) {
    lines.push(`conclusion: ${run.tags.conclusion}`);
  }
  if (typeof output.summary === 'string' && output.summary.length > 0) {
    lines.push('', output.summary);
  }
  if (typeof output.text === 'string' && output.text.length > 0) {
    lines.push('', output.text);
  }
  if (Array.isArray(output.steps)) {
    for (const [index, step] of output.steps.entries()) {
      if (!step || typeof step !== 'object') { continue; }
      lines.push('', `## ${typeof step.name === 'string' ? step.name : `Step ${index + 1}`}`);
      const stepLog = [step.log, step.logs, step.text, step.output].find(value => typeof value === 'string');
      if (typeof stepLog === 'string' && stepLog.length > 0) {
        lines.push(stepLog);
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function workflowRunLogArchive(runs: CiRun[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = runs.map(run => ({
    name : `${String(runId(run)).padStart(2, '0')}_${safeLogFilename(String(run.tags.name ?? 'check'))}.txt`,
    data : encoder.encode(workflowJobLogText(run)),
  }));
  return createStoredZip(entries);
}

function downloadRedirect(location: string): JsonResponse {
  return {
    status  : 302,
    headers : {
      ...baseHeaders(),
      Location: location,
    },
    body: '',
  };
}

function dataWithDeletedLogs(run: CiRun): Record<string, any> {
  const data: Record<string, any> = { ...run.data, logsDeleted: true };
  const output = rawRunOutput(run);
  if (output !== run.data) {
    const nextOutput: Record<string, any> = { ...output, logsDeleted: true };
    delete nextOutput.text;
    delete nextOutput.log;
    delete nextOutput.logs;
    if (Array.isArray(nextOutput.steps)) {
      nextOutput.steps = nextOutput.steps.map((step: unknown) => {
        if (!step || typeof step !== 'object') { return step; }
        const nextStep = { ...(step as Record<string, unknown>) };
        delete nextStep.text;
        delete nextStep.log;
        delete nextStep.logs;
        delete nextStep.output;
        return nextStep;
      });
    }
    data.output = nextOutput;
  }
  return data;
}

function filterWorkflowRuns(suites: CiSuite[], url: URL): CiSuite[] | JsonResponse {
  const checkSuiteId = url.searchParams.get('check_suite_id');
  const parsedCheckSuiteId = checkSuiteId ? parseInt(checkSuiteId, 10) : null;
  if (checkSuiteId && Number.isNaN(parsedCheckSuiteId)) {
    return jsonValidationError('Validation Failed: check_suite_id must be an integer.');
  }

  const status = url.searchParams.get('status');
  if (status && !ACTION_RUN_STATUSES.has(status)) {
    return jsonValidationError('Validation Failed: status is not a supported workflow run status or conclusion.');
  }

  const branch = url.searchParams.get('branch');
  const headSha = url.searchParams.get('head_sha');
  const event = url.searchParams.get('event');
  const actor = url.searchParams.get('actor');

  return suites.filter((suite) => {
    if (parsedCheckSuiteId !== null && suiteId(suite) !== parsedCheckSuiteId) { return false; }
    if (branch && branch !== (suite.tags.branch ?? suite.data.headBranch)) { return false; }
    if (headSha && headSha !== suiteHeadSha(suite)) { return false; }
    if (event && event !== (suite.data.event ?? 'push')) { return false; }
    if (actor && actor !== (suite.rec.author ?? '')) { return false; }
    if (status && status !== suiteStatus(suite) && status !== suiteConclusion(suite)) { return false; }
    return true;
  });
}

async function resolveWorkflowRef(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, ref: string,
): Promise<{ headSha: string; branch: string }> {
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
    if (!candidates.includes(name)) { continue; }

    const target = data.target ?? tags.target ?? decoded;
    const type = data.type ?? tags.type;
    if (type === 'branch' && typeof name === 'string') {
      return { headSha: target, branch: name.replace(/^refs\/heads\//, '') };
    }
    return { headSha: target, branch: decoded };
  }

  return { headSha: decoded, branch: decoded.replace(/^refs\/heads\//, '') };
}

async function updateSuiteQueued(suite: CiSuite): Promise<JsonResponse | undefined> {
  const tags: Record<string, string> = { ...suite.tags, status: 'queued' };
  delete tags.conclusion;
  const { status } = await suite.rec.update({ data: suite.data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to re-run workflow: ${status.detail}`);
  }
  suite.tags = tags;
  return undefined;
}

async function updateRunQueued(run: CiRun): Promise<JsonResponse | undefined> {
  const tags: Record<string, string> = { ...run.tags, status: 'queued' };
  delete tags.conclusion;
  const { status } = await run.rec.update({ data: run.data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to re-run workflow job: ${status.detail}`);
  }
  run.tags = tags;
  return undefined;
}

async function updateSuiteCancelled(suite: CiSuite): Promise<JsonResponse | undefined> {
  const data = { ...suite.data, conclusion: 'cancelled', completedAt: new Date().toISOString() };
  const tags: Record<string, string> = { ...suite.tags, status: 'completed', conclusion: 'cancelled' };
  const { status } = await suite.rec.update({ data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to cancel workflow run: ${status.detail}`);
  }
  suite.data = data;
  suite.tags = tags;
  return undefined;
}

async function updateRunCancelled(run: CiRun): Promise<JsonResponse | undefined> {
  const data = { ...run.data, completedAt: new Date().toISOString() };
  const tags: Record<string, string> = { ...run.tags, status: 'completed', conclusion: 'cancelled' };
  const { status } = await run.rec.update({ data, tags });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to cancel workflow job: ${status.detail}`);
  }
  run.data = data;
  run.tags = tags;
  return undefined;
}

async function deleteWorkflowRunRecords(
  ctx: AgentContext, targetDid: string, suite: CiSuite,
): Promise<JsonResponse | undefined> {
  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    for (const artifact of await queryArtifactsForRun(ctx, targetDid, run)) {
      const { status } = await artifact.rec.delete();
      if (status.code >= 300) {
        return jsonValidationError(`Failed to delete workflow artifact: ${status.detail}`);
      }
    }

    const { status } = await run.rec.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete workflow job: ${status.detail}`);
    }
  }

  const { status } = await suite.rec.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete workflow run: ${status.detail}`);
  }
  return undefined;
}

async function getRepo(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoInfo | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/actions/permissions
// ---------------------------------------------------------------------------

export async function handleGetActionsPermissions(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildActionsPermissionsResponse(
    normalizedActionsPermissions(lookup.settings),
    targetDid,
    lookup.repo.name,
    buildApiUrl(url),
  ));
}

export async function handleSetActionsPermissions(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const enabled = parseRequiredBoolean(reqBody.enabled, 'enabled');
  if (typeof enabled !== 'boolean') { return enabled; }

  const allowedActions = parseAllowedActionsPolicy(reqBody.allowed_actions);
  if (typeof allowedActions === 'object') { return allowedActions; }

  const shaPinningRequired = parseOptionalBoolean(reqBody.sha_pinning_required, 'sha_pinning_required');
  if (typeof shaPinningRequired === 'object') { return shaPinningRequired; }

  const permissions = normalizedActionsPermissions(lookup.settings);
  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    actionsPermissions: {
      ...permissions,
      enabled,
      allowedActions     : allowedActions ?? permissions.allowedActions,
      shaPinningRequired : shaPinningRequired ?? permissions.shaPinningRequired,
    },
  });
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/actions/permissions/selected-actions
// ---------------------------------------------------------------------------

export async function handleGetActionsSelectedActions(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return jsonOk(buildSelectedActionsResponse(normalizedActionsPermissions(lookup.settings)));
}

export async function handleSetActionsSelectedActions(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const githubOwnedAllowed = parseOptionalBoolean(reqBody.github_owned_allowed, 'github_owned_allowed');
  if (typeof githubOwnedAllowed === 'object') { return githubOwnedAllowed; }

  const verifiedAllowed = parseOptionalBoolean(reqBody.verified_allowed, 'verified_allowed');
  if (typeof verifiedAllowed === 'object') { return verifiedAllowed; }

  const patternsAllowed = parseOptionalStringArray(reqBody.patterns_allowed, 'patterns_allowed');
  if (patternsAllowed && 'status' in patternsAllowed) { return patternsAllowed; }

  const permissions = normalizedActionsPermissions(lookup.settings);
  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    actionsPermissions: {
      ...permissions,
      selectedActions: {
        githubOwnedAllowed : githubOwnedAllowed ?? permissions.selectedActions.githubOwnedAllowed,
        verifiedAllowed    : verifiedAllowed ?? permissions.selectedActions.verifiedAllowed,
        patternsAllowed    : patternsAllowed ?? permissions.selectedActions.patternsAllowed,
      },
    },
  });
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/actions/permissions/workflow
// ---------------------------------------------------------------------------

export async function handleGetActionsWorkflowPermissions(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return jsonOk(buildWorkflowPermissionsResponse(normalizedActionsPermissions(lookup.settings)));
}

export async function handleSetActionsWorkflowPermissions(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const defaultWorkflowPermissions = parseDefaultWorkflowPermissions(reqBody.default_workflow_permissions);
  if (typeof defaultWorkflowPermissions === 'object') { return defaultWorkflowPermissions; }

  const canApprovePullRequestReviews = parseOptionalBoolean(
    reqBody.can_approve_pull_request_reviews,
    'can_approve_pull_request_reviews',
  );
  if (typeof canApprovePullRequestReviews === 'object') { return canApprovePullRequestReviews; }

  const permissions = normalizedActionsPermissions(lookup.settings);
  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    actionsPermissions: {
      ...permissions,
      defaultWorkflowPermissions   : defaultWorkflowPermissions ?? permissions.defaultWorkflowPermissions,
      canApprovePullRequestReviews : canApprovePullRequestReviews ?? permissions.canApprovePullRequestReviews,
    },
  });
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/actions/cache/retention-limit
// ---------------------------------------------------------------------------

export async function handleGetActionsCacheRetentionLimit(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return jsonOk({
    max_cache_retention_days: lookup.settings.actionsCacheRetentionLimitDays ?? DEFAULT_ACTIONS_CACHE_RETENTION_LIMIT_DAYS,
  });
}

export async function handleSetActionsCacheRetentionLimit(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const limit = parsePositiveInteger(reqBody.max_cache_retention_days, 'max_cache_retention_days');
  if (typeof limit !== 'number') { return limit; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    actionsCacheRetentionLimitDays: limit,
  });
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/actions/cache/storage-limit
// ---------------------------------------------------------------------------

export async function handleGetActionsCacheStorageLimit(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return jsonOk({
    max_cache_size_gb: lookup.settings.actionsCacheStorageLimitGb ?? DEFAULT_ACTIONS_CACHE_STORAGE_LIMIT_GB,
  });
}

export async function handleSetActionsCacheStorageLimit(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const limit = parsePositiveInteger(reqBody.max_cache_size_gb, 'max_cache_size_gb');
  if (typeof limit !== 'number') { return limit; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    actionsCacheStorageLimitGb: limit,
  });
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/cache/usage
// ---------------------------------------------------------------------------

export async function handleGetActionsCacheUsage(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const caches = cacheEntries(lookup.settings.actionsCaches);
  return jsonOk({
    full_name                   : `${targetDid}/${lookup.repo.name}`,
    active_caches_size_in_bytes : caches.reduce((sum, cache) => sum + Math.max(0, cache.sizeInBytes), 0),
    active_caches_count         : caches.length,
  });
}

// ---------------------------------------------------------------------------
// GET/DELETE /repos/:did/:repo/actions/caches
// ---------------------------------------------------------------------------

export async function handleListActionsCaches(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return actionsCacheListResponse(cacheEntries(lookup.settings.actionsCaches), url);
}

export async function handleDeleteActionsCachesByKey(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const key = url.searchParams.get('key')?.trim();
  if (!key) {
    return jsonValidationError('Validation Failed: key is required.');
  }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const ref = url.searchParams.get('ref');
  const deleted: ActionsCacheEntry[] = [];
  let settings = lookup.settings;
  for (const [settingsKey, cache] of Object.entries(lookup.settings.actionsCaches ?? {})) {
    if (cache.key !== key) { continue; }
    if (ref && cache.ref !== ref) { continue; }
    deleted.push(cache);
    settings = repositoryCacheSettingsWithChange(settings, settingsKey, null);
  }

  if (deleted.length > 0) {
    const saveError = await saveRepoSettings(ctx, lookup, settings);
    if (saveError) { return saveError; }
  }
  return jsonOk({
    total_count    : deleted.length,
    actions_caches : sortedCacheEntries(deleted, 'last_accessed_at', SORT_DESC).map(buildActionsCacheResponse),
  });
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/actions/caches/:cache_id
// ---------------------------------------------------------------------------

export async function handleDeleteActionsCacheById(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const result = await findRepositoryCache(ctx, targetDid, repoName, id);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    repositoryCacheSettingsWithChange(result.lookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/secrets/public-key
// ---------------------------------------------------------------------------

export async function handleGetRepositorySecretsPublicKey(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return jsonOk(buildSecretPublicKey(`repo:${targetDid}/${lookup.repo.name}`));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/secrets
// ---------------------------------------------------------------------------

export async function handleListRepositorySecrets(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return secretListResponse(secretEntries(lookup.settings.actionsSecrets), url);
}

// ---------------------------------------------------------------------------
// GET/PUT/DELETE /repos/:did/:repo/actions/secrets/:secret_name
// ---------------------------------------------------------------------------

export async function handleGetRepositorySecret(
  ctx: AgentContext, targetDid: string, repoName: string, name: string,
): Promise<JsonResponse> {
  const result = await findRepositorySecret(ctx, targetDid, repoName, name);
  if ('status' in result) { return result; }
  return jsonOk(buildSecretResponse(result.secret));
}

export async function handleCreateOrUpdateRepositorySecret(
  ctx: AgentContext, targetDid: string, repoName: string, name: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const decodedName = decodeRequiredRouteParam(name, 'secret_name');
  if (typeof decodedName !== 'string') { return decodedName; }

  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const encryptedValue = parseRequiredString(reqBody.encrypted_value, 'encrypted_value');
  if (typeof encryptedValue !== 'string') { return encryptedValue; }

  const keyId = parseRequiredString(reqBody.key_id, 'key_id');
  if (typeof keyId !== 'string') { return keyId; }

  const key = variableKey(decodedName);
  const existing = lookup.settings.actionsSecrets?.[key];
  const now = new Date().toISOString();
  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    repositorySecretSettingsWithChange(lookup.settings, key, {
      name      : decodedName,
      encryptedValue,
      keyId,
      createdAt : existing?.createdAt ?? now,
      updatedAt : now,
    }),
  );
  if (saveError) { return saveError; }
  return existing ? jsonNoContent() : createdEmpty();
}

export async function handleDeleteRepositorySecret(
  ctx: AgentContext, targetDid: string, repoName: string, name: string,
): Promise<JsonResponse> {
  const result = await findRepositorySecret(ctx, targetDid, repoName, name);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    repositorySecretSettingsWithChange(result.lookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST /repos/:did/:repo/actions/variables
// ---------------------------------------------------------------------------

export async function handleListRepositoryVariables(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  return variableListResponse(variableEntries(lookup.settings.actionsVariables), url);
}

export async function handleCreateRepositoryVariable(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettingsLookup(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const name = parseRequiredString(reqBody.name, 'name');
  if (typeof name !== 'string') { return name; }

  const value = parseRequiredValue(reqBody.value, 'value');
  if (typeof value !== 'string') { return value; }

  const key = variableKey(name);
  if (lookup.settings.actionsVariables?.[key]) {
    return jsonConflict(`Variable '${name}' already exists.`);
  }

  const now = new Date().toISOString();
  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    repositoryVariableSettingsWithChange(lookup.settings, key, {
      name,
      value,
      createdAt : now,
      updatedAt : now,
    }),
  );
  if (saveError) { return saveError; }
  return createdEmpty();
}

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /repos/:did/:repo/actions/variables/:name
// ---------------------------------------------------------------------------

export async function handleGetRepositoryVariable(
  ctx: AgentContext, targetDid: string, repoName: string, name: string,
): Promise<JsonResponse> {
  const result = await findRepositoryVariable(ctx, targetDid, repoName, name);
  if ('status' in result) { return result; }
  return jsonOk(buildVariableResponse(result.variable));
}

export async function handleUpdateRepositoryVariable(
  ctx: AgentContext, targetDid: string, repoName: string, name: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await findRepositoryVariable(ctx, targetDid, repoName, name);
  if ('status' in result) { return result; }

  if (typeof reqBody.name === 'undefined' && typeof reqBody.value === 'undefined') {
    return jsonValidationError('Validation Failed: name or value is required.');
  }

  const nextName = parseOptionalString(reqBody.name, 'name');
  if (typeof nextName === 'object') { return nextName; }

  const nextValue = parseOptionalValue(reqBody.value, 'value');
  if (typeof nextValue === 'object') { return nextValue; }

  const updatedVariable: ActionsVariableEntry = {
    name      : nextName ?? result.variable.name,
    value     : nextValue ?? result.variable.value,
    createdAt : result.variable.createdAt,
    updatedAt : new Date().toISOString(),
  };
  const nextKey = variableKey(updatedVariable.name);
  if (nextKey !== result.key && result.lookup.settings.actionsVariables?.[nextKey]) {
    return jsonConflict(`Variable '${updatedVariable.name}' already exists.`);
  }

  let settings = repositoryVariableSettingsWithChange(result.lookup.settings, result.key, null);
  settings = repositoryVariableSettingsWithChange(settings, nextKey, updatedVariable);
  const saveError = await saveRepoSettings(ctx, result.lookup, settings);
  if (saveError) { return saveError; }
  return jsonNoContent();
}

export async function handleDeleteRepositoryVariable(
  ctx: AgentContext, targetDid: string, repoName: string, name: string,
): Promise<JsonResponse> {
  const result = await findRepositoryVariable(ctx, targetDid, repoName, name);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    repositoryVariableSettingsWithChange(result.lookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/environments/:environment_name/secrets/public-key
// ---------------------------------------------------------------------------

export async function handleGetEnvironmentSecretsPublicKey(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string,
): Promise<JsonResponse> {
  const result = await findEnvironmentForVariables(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }
  return jsonOk(buildSecretPublicKey(`env:${targetDid}/${repoName}/${result.environment.name}`));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/environments/:environment_name/secrets
// ---------------------------------------------------------------------------

export async function handleListEnvironmentSecrets(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, url: URL,
): Promise<JsonResponse> {
  const result = await findEnvironmentForVariables(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }
  return secretListResponse(secretEntries(result.environment.secrets), url);
}

// ---------------------------------------------------------------------------
// GET/PUT/DELETE /repos/:did/:repo/environments/:environment_name/secrets/:secret_name
// ---------------------------------------------------------------------------

export async function handleGetEnvironmentSecret(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
): Promise<JsonResponse> {
  const result = await findEnvironmentSecret(ctx, targetDid, repoName, environmentName, name);
  if ('status' in result) { return result; }
  return jsonOk(buildSecretResponse(result.secret));
}

export async function handleCreateOrUpdateEnvironmentSecret(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
  reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await findEnvironmentForVariables(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }

  const decodedName = decodeRequiredRouteParam(name, 'secret_name');
  if (typeof decodedName !== 'string') { return decodedName; }

  const encryptedValue = parseRequiredString(reqBody.encrypted_value, 'encrypted_value');
  if (typeof encryptedValue !== 'string') { return encryptedValue; }

  const keyId = parseRequiredString(reqBody.key_id, 'key_id');
  if (typeof keyId !== 'string') { return keyId; }

  const key = variableKey(decodedName);
  const existing = result.environment.secrets?.[key];
  const now = new Date().toISOString();
  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    environmentSecretSettingsWithChange(result.lookup.settings, result.key, result.environment, key, {
      name      : decodedName,
      encryptedValue,
      keyId,
      createdAt : existing?.createdAt ?? now,
      updatedAt : now,
    }),
  );
  if (saveError) { return saveError; }
  return existing ? jsonNoContent() : createdEmpty();
}

export async function handleDeleteEnvironmentSecret(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
): Promise<JsonResponse> {
  const result = await findEnvironmentSecret(ctx, targetDid, repoName, environmentName, name);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    environmentSecretSettingsWithChange(
      result.lookup.settings, result.environmentKey, result.environment, result.secretKey, null,
    ),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST /repos/:did/:repo/environments/:environment_name/variables
// ---------------------------------------------------------------------------

export async function handleListEnvironmentVariables(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, url: URL,
): Promise<JsonResponse> {
  const result = await findEnvironmentForVariables(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }
  return variableListResponse(variableEntries(result.environment.variables), url);
}

export async function handleCreateEnvironmentVariable(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await findEnvironmentForVariables(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }

  const name = parseRequiredString(reqBody.name, 'name');
  if (typeof name !== 'string') { return name; }

  const value = parseRequiredValue(reqBody.value, 'value');
  if (typeof value !== 'string') { return value; }

  const key = variableKey(name);
  if (result.environment.variables?.[key]) {
    return jsonConflict(`Variable '${name}' already exists in environment '${result.name}'.`);
  }

  const now = new Date().toISOString();
  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    environmentVariableSettingsWithChange(result.lookup.settings, result.key, result.environment, key, {
      name,
      value,
      createdAt : now,
      updatedAt : now,
    }),
  );
  if (saveError) { return saveError; }
  return createdEmpty();
}

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /repos/:did/:repo/environments/:environment_name/variables/:name
// ---------------------------------------------------------------------------

export async function handleGetEnvironmentVariable(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
): Promise<JsonResponse> {
  const result = await findEnvironmentVariable(ctx, targetDid, repoName, environmentName, name);
  if ('status' in result) { return result; }
  return jsonOk(buildVariableResponse(result.variable));
}

export async function handleUpdateEnvironmentVariable(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
  reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await findEnvironmentVariable(ctx, targetDid, repoName, environmentName, name);
  if ('status' in result) { return result; }

  if (typeof reqBody.name === 'undefined' && typeof reqBody.value === 'undefined') {
    return jsonValidationError('Validation Failed: name or value is required.');
  }

  const nextName = parseOptionalString(reqBody.name, 'name');
  if (typeof nextName === 'object') { return nextName; }

  const nextValue = parseOptionalValue(reqBody.value, 'value');
  if (typeof nextValue === 'object') { return nextValue; }

  const updatedVariable: ActionsVariableEntry = {
    name      : nextName ?? result.variable.name,
    value     : nextValue ?? result.variable.value,
    createdAt : result.variable.createdAt,
    updatedAt : new Date().toISOString(),
  };
  const nextKey = variableKey(updatedVariable.name);
  if (nextKey !== result.variableKey && result.environment.variables?.[nextKey]) {
    return jsonConflict(`Variable '${updatedVariable.name}' already exists in this environment.`);
  }

  let settings = environmentVariableSettingsWithChange(
    result.lookup.settings, result.environmentKey, result.environment, result.variableKey, null,
  );
  const environment = settings.environments?.[result.environmentKey] ?? result.environment;
  settings = environmentVariableSettingsWithChange(settings, result.environmentKey, environment, nextKey, updatedVariable);
  const saveError = await saveRepoSettings(ctx, result.lookup, settings);
  if (saveError) { return saveError; }
  return jsonNoContent();
}

export async function handleDeleteEnvironmentVariable(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, name: string,
): Promise<JsonResponse> {
  const result = await findEnvironmentVariable(ctx, targetDid, repoName, environmentName, name);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    environmentVariableSettingsWithChange(
      result.lookup.settings, result.environmentKey, result.environment, result.variableKey, null,
    ),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/artifacts
// ---------------------------------------------------------------------------

export async function handleListArtifacts(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  return artifactsResponse(await queryArtifactsForRepo(ctx, targetDid, repo), targetDid, repo, url);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/runs/:run_id/artifacts
// ---------------------------------------------------------------------------

export async function handleListWorkflowRunArtifacts(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const artifacts = await queryArtifactsForRuns(ctx, targetDid, await queryRunsForSuite(ctx, targetDid, suite));
  return artifactsResponse(artifacts, targetDid, repo, url);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/artifacts/:artifact_id
// ---------------------------------------------------------------------------

export async function handleGetArtifact(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const artifact = await findArtifactByNumber(ctx, targetDid, repo, id);
  if (!artifact) {
    return jsonNotFound(`Artifact ${id} not found.`);
  }

  return jsonOk(await buildArtifactResponse(artifact, targetDid, repo, buildApiUrl(url)));
}

export async function handleDeleteArtifact(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const artifact = await findArtifactByNumber(ctx, targetDid, repo, id);
  if (!artifact) {
    return jsonNotFound(`Artifact ${id} not found.`);
  }

  const { status } = await artifact.rec.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete artifact: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleDownloadArtifact(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, archiveFormat: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  if (archiveFormat !== 'zip') {
    return jsonValidationError('Validation Failed: archive_format must be zip.');
  }

  const artifact = await findArtifactByNumber(ctx, targetDid, repo, id);
  if (!artifact) {
    return jsonNotFound(`Artifact ${id} not found.`);
  }
  if (artifactExpired(artifact)) {
    return artifactGone(`Artifact ${id} has expired.`);
  }

  const baseUrl = buildApiUrl(url);
  if (url.searchParams.get('download') !== '1') {
    return artifactDownloadRedirect(
      `${baseUrl}/repos/${targetDid}/${repo.name}/actions/artifacts/${artifactId(artifact)}/zip?download=1`,
    );
  }

  const filename = `${artifactName(artifact).replace(/"/g, '')}.zip`;
  const contentType = String(artifact.tags.contentType ?? artifact.rec.dataFormat ?? 'application/zip');
  return binaryOk(await artifactBytes(artifact), contentType, {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/workflows
// ---------------------------------------------------------------------------

export async function handleListWorkflows(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const { workflows } = await listWorkflows(ctx, targetDid, repo);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(workflows, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, workflows.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : workflows.length,
    workflows   : paged.map(workflow => buildWorkflowResponse(workflow, targetDid, repo, baseUrl)),
  }, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/workflows/:workflow_id
// ---------------------------------------------------------------------------

export async function handleGetWorkflow(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }

  return jsonOk(buildWorkflowResponse(result.workflow, targetDid, repo, buildApiUrl(url)));
}

export async function handleDisableWorkflow(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }

  const error = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    workflowSettingsWithState(result.settingsLookup.settings, result.workflow, 'disabled_manually'),
  );
  if (error) { return error; }
  return jsonNoContent();
}

export async function handleEnableWorkflow(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }

  const error = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    workflowSettingsWithState(result.settingsLookup.settings, result.workflow, 'active'),
  );
  if (error) { return error; }
  return jsonNoContent();
}

export async function handleCreateWorkflowDispatch(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }
  if (result.workflow.state !== 'active') {
    return jsonValidationError('Validation Failed: workflow is disabled.');
  }

  const ref = reqBody.ref;
  if (typeof ref !== 'string' || !ref) {
    return jsonValidationError('Validation Failed: ref is required.');
  }

  const inputs = reqBody.inputs;
  if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
    return jsonValidationError('Validation Failed: inputs must be an object.');
  }
  if (inputs && Object.keys(inputs as Record<string, unknown>).length > 25) {
    return jsonValidationError('Validation Failed: inputs may not contain more than 25 properties.');
  }

  const resolved = await resolveWorkflowRef(ctx, targetDid, repo, ref);
  const tags: Record<string, string> = {
    branch    : resolved.branch,
    commitSha : resolved.headSha,
    status    : 'queued',
  };
  const { status, record } = await ctx.ci.records.create('repo/checkSuite' as any, {
    data: {
      app          : result.workflow.name,
      displayTitle : result.workflow.name,
      event        : 'workflow_dispatch',
      headBranch   : resolved.branch,
      inputs       : inputs ?? {},
      message      : 'Manual workflow dispatch',
    },
    tags,
    parentContextId: repo.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to dispatch workflow: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create workflow dispatch record'); }

  const runId = numericId(record.id ?? '');
  const baseUrl = buildApiUrl(url);
  return jsonOk({
    workflow_run_id : runId,
    run_url         : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${runId}`,
    html_url        : `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${runId}`,
  });
}

export async function handleGetWorkflowUsage(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }

  return jsonOk({ billable: {} });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/workflows/:workflow_id/runs
// ---------------------------------------------------------------------------

export async function handleListWorkflowRunsForWorkflow(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const result = await findWorkflow(ctx, targetDid, repo, id);
  if (!result) {
    return jsonNotFound(`Workflow ${decodeRouteParam(id)} not found.`);
  }

  const suitesForWorkflow = result.suites.filter(suite => suiteAppName(suite) === result.workflow.name);
  const suites = filterWorkflowRuns(suitesForWorkflow, url);
  if (!Array.isArray(suites)) { return suites; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(suites, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, suites.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count   : suites.length,
    workflow_runs : paged.map(suite => buildWorkflowRunResponse(suite, targetDid, repo, baseUrl)),
  }, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/runs
// ---------------------------------------------------------------------------

export async function handleListWorkflowRuns(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suites = filterWorkflowRuns(await querySuites(ctx, targetDid, repo), url);
  if (!Array.isArray(suites)) { return suites; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(suites, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, suites.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count   : suites.length,
    workflow_runs : paged.map(suite => buildWorkflowRunResponse(suite, targetDid, repo, baseUrl)),
  }, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/runs/:run_id
// ---------------------------------------------------------------------------

export async function handleGetWorkflowRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  return jsonOk(buildWorkflowRunResponse(suite, targetDid, repo, buildApiUrl(url)));
}

export async function handleGetWorkflowRunAttempt(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, attempt: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite || attempt !== '1') {
    return jsonNotFound(`Workflow run attempt ${attempt} for run ${id} not found.`);
  }

  return jsonOk(buildWorkflowRunResponse(suite, targetDid, repo, buildApiUrl(url)));
}

export async function handleGetWorkflowRunUsage(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const runs = await queryRunsForSuite(ctx, targetDid, suite);
  const jobRuns = runs.map(run => ({
    job_id      : runId(run),
    duration_ms : workflowJobDurationMs(run),
  }));
  const totalMs = jobRuns.reduce((sum, run) => sum + run.duration_ms, 0);

  return jsonOk({
    billable: jobRuns.length > 0
      ? { UBUNTU: { total_ms: totalMs, jobs: jobRuns.length, job_runs: jobRuns } }
      : {},
    run_duration_ms: workflowRunDurationMs(suite),
  });
}

export async function handleDownloadWorkflowRunLogs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const baseUrl = buildApiUrl(url);
  if (url.searchParams.get('download') !== '1') {
    return downloadRedirect(`${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${suiteId(suite)}/logs?download=1`);
  }

  const archive = workflowRunLogArchive(await queryRunsForSuite(ctx, targetDid, suite));
  return binaryOk(archive, 'application/zip', {
    'Content-Disposition': `attachment; filename="actions-run-${suiteId(suite)}-logs.zip"`,
  });
}

export async function handleDownloadWorkflowRunAttemptLogs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, attempt: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite || attempt !== '1') {
    return jsonNotFound(`Workflow run attempt ${attempt} for run ${id} not found.`);
  }

  const baseUrl = buildApiUrl(url);
  if (url.searchParams.get('download') !== '1') {
    return downloadRedirect(
      `${baseUrl}/repos/${targetDid}/${repo.name}/actions/runs/${suiteId(suite)}/attempts/1/logs?download=1`,
    );
  }

  const archive = workflowRunLogArchive(await queryRunsForSuite(ctx, targetDid, suite));
  return binaryOk(archive, 'application/zip', {
    'Content-Disposition': `attachment; filename="actions-run-${suiteId(suite)}-attempt-1-logs.zip"`,
  });
}

export async function handleDeleteWorkflowRunLogs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    const data = dataWithDeletedLogs(run);
    const { status } = await run.rec.update({ data, tags: run.tags });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete workflow run logs: ${status.detail}`);
    }
    run.data = data;
  }

  return jsonNoContent();
}

export async function handleCancelWorkflowRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }
  if (suiteStatus(suite) === 'completed') {
    return jsonConflict(`Workflow run ${id} is already completed.`);
  }

  const suiteError = await updateSuiteCancelled(suite);
  if (suiteError) { return suiteError; }

  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    if (run.tags.status === 'completed') { continue; }
    const runError = await updateRunCancelled(run);
    if (runError) { return runError; }
  }

  return acceptedEmpty();
}

export async function handleForceCancelWorkflowRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const suiteError = await updateSuiteCancelled(suite);
  if (suiteError) { return suiteError; }

  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    const runError = await updateRunCancelled(run);
    if (runError) { return runError; }
  }

  return acceptedEmpty();
}

export async function handleDeleteWorkflowRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const deleteError = await deleteWorkflowRunRecords(ctx, targetDid, suite);
  if (deleteError) { return deleteError; }

  return jsonNoContent();
}

export async function handleRerunWorkflowRun(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const suiteError = await updateSuiteQueued(suite);
  if (suiteError) { return suiteError; }

  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    const runError = await updateRunQueued(run);
    if (runError) { return runError; }
  }

  return createdEmpty();
}

export async function handleRerunFailedWorkflowJobs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const suiteError = await updateSuiteQueued(suite);
  if (suiteError) { return suiteError; }

  for (const run of await queryRunsForSuite(ctx, targetDid, suite)) {
    if (run.tags.status !== 'completed' || run.tags.conclusion === 'success' || run.tags.conclusion === 'skipped') {
      continue;
    }
    const runError = await updateRunQueued(run);
    if (runError) { return runError; }
  }

  return createdEmpty();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/runs/:run_id/jobs
// ---------------------------------------------------------------------------

export async function handleListWorkflowRunJobs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const suite = await findSuiteByNumber(ctx, targetDid, repo, id);
  if (!suite) {
    return jsonNotFound(`Workflow run ${id} not found.`);
  }

  const runs = await queryRunsForSuite(ctx, targetDid, suite);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(runs, pagination);
  const linkHeader = buildLinkHeader(baseUrl, url.pathname, pagination.page, pagination.perPage, runs.length);
  const extraHeaders = linkHeader ? { Link: linkHeader } : undefined;

  return jsonOk({
    total_count : runs.length,
    jobs        : paged.map(run => buildWorkflowJobResponse(run, targetDid, repo, baseUrl)),
  }, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/actions/jobs/:job_id
// ---------------------------------------------------------------------------

export async function handleGetWorkflowJob(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Workflow job ${id} not found.`);
  }

  return jsonOk(buildWorkflowJobResponse(run, targetDid, repo, buildApiUrl(url)));
}

export async function handleDownloadWorkflowJobLogs(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Workflow job ${id} not found.`);
  }

  const baseUrl = buildApiUrl(url);
  if (url.searchParams.get('download') !== '1') {
    return downloadRedirect(`${baseUrl}/repos/${targetDid}/${repo.name}/actions/jobs/${runId(run)}/logs?download=1`);
  }

  const bytes = new TextEncoder().encode(workflowJobLogText(run));
  return binaryOk(bytes, 'text/plain; charset=utf-8', {
    'Content-Disposition': `attachment; filename="${safeLogFilename(String(run.tags.name ?? 'check'))}.txt"`,
  });
}

export async function handleRerunWorkflowJob(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const repo = await getRepo(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const run = await findRunByNumber(ctx, targetDid, repo, id);
  if (!run) {
    return jsonNotFound(`Workflow job ${id} not found.`);
  }

  const suiteError = await updateSuiteQueued(run.suite);
  if (suiteError) { return suiteError; }

  const runError = await updateRunQueued(run);
  if (runError) { return runError; }

  return createdEmpty();
}
