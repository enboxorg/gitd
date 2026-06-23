/**
 * GitHub API shim — deployment endpoints.
 *
 * Stores GitHub-compatible deployment metadata in the repo settings record.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  getRepoRecord,
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

type DeploymentState = 'error' | 'failure' | 'inactive' | 'in_progress' | 'queued' | 'pending' | 'success';

type DeploymentStatusEntry = {
  id : number;
  state : DeploymentState;
  targetUrl : string;
  logUrl : string;
  description : string;
  environment : string;
  environmentUrl : string;
  creatorDid : string;
  createdAt : string;
  updatedAt : string;
};

type DeploymentEntry = {
  id : number;
  sha : string;
  ref : string;
  task : string;
  payload : unknown;
  originalEnvironment : string;
  environment : string;
  description : string | null;
  creatorDid : string;
  transientEnvironment : boolean;
  productionEnvironment : boolean;
  createdAt : string;
  updatedAt : string;
  statuses? : Record<string, DeploymentStatusEntry>;
};

type DeploymentReviewerEntry = {
  type : 'User' | 'Team';
  id : number;
};

type DeploymentBranchPolicyEntry = {
  protectedBranches : boolean;
  customBranchPolicies : boolean;
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

type EnvironmentEntry = {
  id : number;
  name : string;
  createdAt : string;
  updatedAt : string;
  waitTimer? : number;
  preventSelfReview? : boolean;
  reviewers? : DeploymentReviewerEntry[];
  deploymentBranchPolicy? : DeploymentBranchPolicyEntry | null;
  variables? : Record<string, ActionsVariableEntry>;
  secrets? : Record<string, ActionsSecretEntry>;
};

type RepoSettingsData = {
  branchProtection? : Record<string, unknown>;
  labels? : Record<string, unknown>;
  milestones? : Record<string, unknown>;
  deployments? : Record<string, DeploymentEntry>;
  environments? : Record<string, EnvironmentEntry>;
  mergeStrategies? : string[];
  autoDeleteBranch? : boolean;
};

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

type DeploymentLookup = {
  repo : RepoInfo;
  settingsLookup : RepoSettingsLookup;
  deployment : DeploymentEntry;
  key : string;
};

const DEPLOYMENT_STATES = new Set<string>([
  'error',
  'failure',
  'inactive',
  'in_progress',
  'queued',
  'pending',
  'success',
]);

async function getRepoSettings(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoSettingsLookup | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const { records } = await ctx.repo.records.query('repo/settings' as any, {
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
  });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create repository settings: ${status.detail}`);
  }
  return undefined;
}

function deploymentEntries(settings: RepoSettingsData): DeploymentEntry[] {
  return Object.values(settings.deployments ?? {})
    .filter((entry): entry is DeploymentEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

function deploymentKey(id: number): string {
  return String(id);
}

function nextDeploymentId(settings: RepoSettingsData): number {
  return deploymentEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function nextDeploymentStatusId(deployment: DeploymentEntry): number {
  return Object.values(deployment.statuses ?? {}).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function stringParam(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanParam(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function productionDefault(environment: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return environment === 'production';
}

function normalizePayload(value: unknown): unknown {
  if (typeof value === 'undefined') {
    return {};
  }
  return value;
}

function buildDeploymentResponse(
  deployment: DeploymentEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const base = `${baseUrl}/repos/${targetDid}/${repoName}`;
  return {
    url                    : `${base}/deployments/${deployment.id}`,
    id                     : deployment.id,
    node_id                : `deployment:${deployment.id}`,
    sha                    : deployment.sha,
    ref                    : deployment.ref,
    task                   : deployment.task,
    payload                : deployment.payload,
    original_environment   : deployment.originalEnvironment,
    environment            : deployment.environment,
    description            : deployment.description,
    creator                : buildOwner(deployment.creatorDid, baseUrl),
    created_at             : toISODate(deployment.createdAt),
    updated_at             : toISODate(deployment.updatedAt),
    statuses_url           : `${base}/deployments/${deployment.id}/statuses`,
    repository_url         : base,
    transient_environment  : deployment.transientEnvironment,
    production_environment : deployment.productionEnvironment,
  };
}

function buildDeploymentStatusResponse(
  status: DeploymentStatusEntry, deployment: DeploymentEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const base = `${baseUrl}/repos/${targetDid}/${repoName}`;
  return {
    url             : `${base}/deployments/${deployment.id}/statuses/${status.id}`,
    id              : status.id,
    node_id         : `deployment-status:${status.id}`,
    state           : status.state,
    creator         : buildOwner(status.creatorDid, baseUrl),
    description     : status.description,
    environment     : status.environment,
    target_url      : status.targetUrl,
    created_at      : toISODate(status.createdAt),
    updated_at      : toISODate(status.updatedAt),
    deployment_url  : `${base}/deployments/${deployment.id}`,
    repository_url  : base,
    environment_url : status.environmentUrl,
    log_url         : status.logUrl,
  };
}

async function findDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string,
): Promise<DeploymentLookup | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const id = parseInt(deploymentId, 10);
  const key = deploymentKey(id);
  const deployment = lookup.settings.deployments?.[key];
  if (!deployment) {
    return jsonNotFound(`Deployment ${deploymentId} not found.`);
  }

  return {
    repo           : lookup.repo,
    settingsLookup : lookup,
    deployment,
    key,
  };
}

function filteredDeployments(entries: DeploymentEntry[], url: URL): DeploymentEntry[] {
  const sha = url.searchParams.get('sha');
  const ref = url.searchParams.get('ref');
  const task = url.searchParams.get('task');
  const environment = url.searchParams.get('environment');

  return entries.filter((entry) => {
    if (sha && entry.sha !== sha) { return false; }
    if (ref && entry.ref !== ref && entry.sha !== ref) { return false; }
    if (task && entry.task !== task) { return false; }
    if (environment && entry.environment !== environment) { return false; }
    return true;
  });
}

function statusesNewestFirst(deployment: DeploymentEntry): DeploymentStatusEntry[] {
  return Object.values(deployment.statuses ?? {})
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

function latestStatus(deployment: DeploymentEntry): DeploymentStatusEntry | undefined {
  return statusesNewestFirst(deployment)[0];
}

function canDeleteDeployment(settings: RepoSettingsData, deployment: DeploymentEntry): boolean {
  const deployments = deploymentEntries(settings);
  if (deployments.length <= 1) {
    return true;
  }
  return latestStatus(deployment)?.state === 'inactive';
}

function deploymentSettingsWithChange(
  settings: RepoSettingsData, key: string, deployment: DeploymentEntry | null,
): RepoSettingsData {
  const deployments = { ...(settings.deployments ?? {}) };
  if (deployment) {
    deployments[key] = deployment;
  } else {
    delete deployments[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(deployments).length > 0) {
    next.deployments = deployments;
  } else {
    delete next.deployments;
  }
  return next;
}

function environmentEntries(settings: RepoSettingsData): EnvironmentEntry[] {
  return Object.values(settings.environments ?? {})
    .filter((entry): entry is EnvironmentEntry => Boolean(entry) && Number.isInteger(entry.id) && typeof entry.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

function environmentKey(name: string): string {
  return name.toLowerCase();
}

function nextEnvironmentId(settings: RepoSettingsData): number {
  return environmentEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function environmentSettingsWithChange(
  settings: RepoSettingsData, key: string, environment: EnvironmentEntry | null,
): RepoSettingsData {
  const environments = { ...(settings.environments ?? {}) };
  if (environment) {
    environments[key] = environment;
  } else {
    delete environments[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(environments).length > 0) {
    next.environments = environments;
  } else {
    delete next.environments;
  }
  return next;
}

function decodeEnvironmentName(environmentName: string): string | undefined {
  try {
    const decoded = decodeURIComponent(environmentName).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function environmentApiPath(targetDid: string, repoName: string, environmentName: string): string {
  return `/repos/${targetDid}/${repoName}/environments/${encodeURIComponent(environmentName)}`;
}

function buildReviewerResponse(reviewer: DeploymentReviewerEntry, baseUrl: string): Record<string, unknown> {
  if (reviewer.type === 'Team') {
    const slug = `team-${reviewer.id}`;
    return {
      type     : 'Team',
      reviewer : {
        id               : reviewer.id,
        node_id          : `team:${reviewer.id}`,
        url              : `${baseUrl}/teams/${reviewer.id}`,
        html_url         : `${baseUrl}/teams/${reviewer.id}`,
        name             : slug,
        slug,
        description      : null,
        privacy          : 'closed',
        permission       : 'push',
        members_url      : `${baseUrl}/teams/${reviewer.id}/members{/member}`,
        repositories_url : `${baseUrl}/teams/${reviewer.id}/repos`,
        parent           : null,
      },
    };
  }

  const login = `user-${reviewer.id}`;
  return {
    type     : 'User',
    reviewer : {
      login               : login,
      id                  : reviewer.id,
      node_id             : `user:${reviewer.id}`,
      avatar_url          : `${baseUrl}/avatars/${reviewer.id}`,
      gravatar_id         : '',
      url                 : `${baseUrl}/users/${login}`,
      html_url            : `${baseUrl}/users/${login}`,
      followers_url       : `${baseUrl}/users/${login}/followers`,
      following_url       : `${baseUrl}/users/${login}/following{/other_user}`,
      gists_url           : `${baseUrl}/users/${login}/gists{/gist_id}`,
      starred_url         : `${baseUrl}/users/${login}/starred{/owner}{/repo}`,
      subscriptions_url   : `${baseUrl}/users/${login}/subscriptions`,
      organizations_url   : `${baseUrl}/users/${login}/orgs`,
      repos_url           : `${baseUrl}/users/${login}/repos`,
      events_url          : `${baseUrl}/users/${login}/events{/privacy}`,
      received_events_url : `${baseUrl}/users/${login}/received_events`,
      type                : 'User',
      site_admin          : false,
    },
  };
}

function buildProtectionRules(environment: EnvironmentEntry, baseUrl: string): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];

  if (Number.isInteger(environment.waitTimer)) {
    rules.push({
      id         : environment.id * 100 + 1,
      node_id    : `environment-rule:${environment.id}:wait_timer`,
      type       : 'wait_timer',
      wait_timer : environment.waitTimer,
    });
  }

  if ((environment.reviewers?.length ?? 0) > 0 || typeof environment.preventSelfReview === 'boolean') {
    rules.push({
      id                  : environment.id * 100 + 2,
      node_id             : `environment-rule:${environment.id}:required_reviewers`,
      type                : 'required_reviewers',
      prevent_self_review : environment.preventSelfReview ?? false,
      reviewers           : (environment.reviewers ?? []).map(reviewer => buildReviewerResponse(reviewer, baseUrl)),
    });
  }

  if (environment.deploymentBranchPolicy) {
    rules.push({
      id      : environment.id * 100 + 3,
      node_id : `environment-rule:${environment.id}:branch_policy`,
      type    : 'branch_policy',
    });
  }

  return rules;
}

function buildEnvironmentResponse(
  environment: EnvironmentEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const apiPath = environmentApiPath(targetDid, repoName, environment.name);
  const activityLog = `${baseUrl}/repos/${targetDid}/${repoName}/deployments/activity_log`;
  return {
    id                       : environment.id,
    node_id                  : `environment:${environment.id}`,
    name                     : environment.name,
    url                      : `${baseUrl}${apiPath}`,
    html_url                 : `${activityLog}?environments_filter=${encodeURIComponent(environment.name)}`,
    created_at               : toISODate(environment.createdAt),
    updated_at               : toISODate(environment.updatedAt),
    protection_rules         : buildProtectionRules(environment, baseUrl),
    deployment_branch_policy : environment.deploymentBranchPolicy
      ? {
        protected_branches     : environment.deploymentBranchPolicy.protectedBranches,
        custom_branch_policies : environment.deploymentBranchPolicy.customBranchPolicies,
      }
      : null,
  };
}

function parseWaitTimer(value: unknown): number | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 43_200) {
    return jsonValidationError('Validation Failed: wait_timer must be an integer between 0 and 43200.');
  }
  return value as number;
}

function parsePreventSelfReview(value: unknown): boolean | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    return jsonValidationError('Validation Failed: prevent_self_review must be a boolean.');
  }
  return value;
}

function parseReviewers(value: unknown): DeploymentReviewerEntry[] | null | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > 6) {
    return jsonValidationError('Validation Failed: reviewers must be an array with no more than 6 users or teams.');
  }

  const reviewers: DeploymentReviewerEntry[] = [];
  for (const reviewer of value) {
    if (
      typeof reviewer !== 'object'
      || reviewer === null
      || (reviewer as { type?: unknown }).type !== 'User' && (reviewer as { type?: unknown }).type !== 'Team'
      || !Number.isInteger((reviewer as { id?: unknown }).id)
    ) {
      return jsonValidationError('Validation Failed: reviewers must contain objects with type User or Team and integer id.');
    }

    reviewers.push({
      type : (reviewer as { type: 'User' | 'Team' }).type,
      id   : (reviewer as { id: number }).id,
    });
  }
  return reviewers;
}

function parseDeploymentBranchPolicy(value: unknown): DeploymentBranchPolicyEntry | null | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return jsonValidationError('Validation Failed: deployment_branch_policy must be an object or null.');
  }

  const protectedBranches = (value as { protected_branches?: unknown }).protected_branches;
  const customBranchPolicies = (value as { custom_branch_policies?: unknown }).custom_branch_policies;
  if (typeof protectedBranches !== 'boolean' || typeof customBranchPolicies !== 'boolean') {
    return jsonValidationError('Validation Failed: deployment_branch_policy requires protected_branches and custom_branch_policies booleans.');
  }
  if (protectedBranches === customBranchPolicies) {
    return jsonValidationError('Validation Failed: protected_branches and custom_branch_policies cannot have the same value.');
  }

  return {
    protectedBranches,
    customBranchPolicies,
  };
}

async function findEnvironment(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string,
): Promise<{ lookup: RepoSettingsLookup; environment: EnvironmentEntry; key: string } | JsonResponse> {
  const decodedName = decodeEnvironmentName(environmentName);
  if (!decodedName) {
    return jsonValidationError('Validation Failed: environment_name is invalid.');
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = environmentKey(decodedName);
  const environment = lookup.settings.environments?.[key];
  if (!environment) {
    return jsonNotFound(`Environment '${decodedName}' not found.`);
  }

  return { lookup, environment, key };
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/environments
// ---------------------------------------------------------------------------

export async function handleListEnvironments(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const environments = environmentEntries(lookup.settings);
  const paged = paginate(environments, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/environments`,
    pagination.page, pagination.perPage, environments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk({
    total_count  : environments.length,
    environments : paged.map(environment => buildEnvironmentResponse(environment, targetDid, lookup.repo.name, baseUrl)),
  }, extraHeaders);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/environments/:environment_name
// ---------------------------------------------------------------------------

export async function handleGetEnvironment(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, url: URL,
): Promise<JsonResponse> {
  const result = await findEnvironment(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }
  return jsonOk(buildEnvironmentResponse(result.environment, targetDid, result.lookup.repo.name, buildApiUrl(url)));
}

export async function handleCreateOrUpdateEnvironment(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const decodedName = decodeEnvironmentName(environmentName);
  if (!decodedName) {
    return jsonValidationError('Validation Failed: environment_name is invalid.');
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const waitTimer = parseWaitTimer(reqBody.wait_timer);
  if (typeof waitTimer === 'object') { return waitTimer; }

  const preventSelfReview = parsePreventSelfReview(reqBody.prevent_self_review);
  if (typeof preventSelfReview === 'object') { return preventSelfReview; }

  const reviewers = parseReviewers(reqBody.reviewers);
  if (typeof reviewers === 'object' && reviewers !== null && 'status' in reviewers) { return reviewers; }

  const deploymentBranchPolicy = parseDeploymentBranchPolicy(reqBody.deployment_branch_policy);
  if (typeof deploymentBranchPolicy === 'object' && deploymentBranchPolicy !== null && 'status' in deploymentBranchPolicy) {
    return deploymentBranchPolicy;
  }

  const key = environmentKey(decodedName);
  const existing = lookup.settings.environments?.[key];
  const now = new Date().toISOString();
  const environment: EnvironmentEntry = {
    id                     : existing?.id ?? nextEnvironmentId(lookup.settings),
    name                   : decodedName,
    createdAt              : existing?.createdAt ?? now,
    updatedAt              : now,
    waitTimer              : waitTimer ?? existing?.waitTimer,
    preventSelfReview      : preventSelfReview ?? existing?.preventSelfReview,
    reviewers              : reviewers === null ? undefined : reviewers ?? existing?.reviewers,
    deploymentBranchPolicy : deploymentBranchPolicy === undefined
      ? existing?.deploymentBranchPolicy ?? null
      : deploymentBranchPolicy,
    variables : existing?.variables,
    secrets   : existing?.secrets,
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    environmentSettingsWithChange(lookup.settings, key, environment),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildEnvironmentResponse(environment, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleDeleteEnvironment(
  ctx: AgentContext, targetDid: string, repoName: string, environmentName: string,
): Promise<JsonResponse> {
  const result = await findEnvironment(ctx, targetDid, repoName, environmentName);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    environmentSettingsWithChange(result.lookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/deployments
// ---------------------------------------------------------------------------

export async function handleListDeployments(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const deployments = filteredDeployments(deploymentEntries(lookup.settings), url);
  const paged = paginate(deployments, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/deployments`,
    pagination.page, pagination.perPage, deployments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(deployment => buildDeploymentResponse(deployment, targetDid, lookup.repo.name, baseUrl)),
    extraHeaders,
  );
}

export async function handleCreateDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const ref = stringParam(reqBody.ref).trim();
  if (!ref) {
    return jsonValidationError('Validation Failed: ref is required.');
  }

  const now = new Date().toISOString();
  const environment = stringParam(reqBody.environment, 'production').trim() || 'production';
  const id = nextDeploymentId(lookup.settings);
  const deployment: DeploymentEntry = {
    id,
    sha                   : stringParam(reqBody.sha, ref),
    ref,
    task                  : stringParam(reqBody.task, 'deploy') || 'deploy',
    payload               : normalizePayload(reqBody.payload),
    originalEnvironment   : environment,
    environment,
    description           : reqBody.description === null ? null : stringParam(reqBody.description),
    creatorDid            : ctx.did,
    transientEnvironment  : booleanParam(reqBody.transient_environment, false),
    productionEnvironment : productionDefault(environment, reqBody.production_environment),
    createdAt             : now,
    updatedAt             : now,
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    deploymentSettingsWithChange(lookup.settings, deploymentKey(id), deployment),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildDeploymentResponse(deployment, targetDid, lookup.repo.name, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/deployments/:id
// ---------------------------------------------------------------------------

export async function handleGetDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string, url: URL,
): Promise<JsonResponse> {
  const result = await findDeployment(ctx, targetDid, repoName, deploymentId);
  if ('status' in result) { return result; }
  return jsonOk(buildDeploymentResponse(result.deployment, targetDid, result.repo.name, buildApiUrl(url)));
}

export async function handleDeleteDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string,
): Promise<JsonResponse> {
  const result = await findDeployment(ctx, targetDid, repoName, deploymentId);
  if ('status' in result) { return result; }

  if (!canDeleteDeployment(result.settingsLookup.settings, result.deployment)) {
    return jsonValidationError('Validation Failed: active deployment cannot be deleted while other deployments exist.');
  }

  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    deploymentSettingsWithChange(result.settingsLookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/deployments/:id/statuses
// ---------------------------------------------------------------------------

export async function handleListDeploymentStatuses(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string, url: URL,
): Promise<JsonResponse> {
  const result = await findDeployment(ctx, targetDid, repoName, deploymentId);
  if ('status' in result) { return result; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const statuses = statusesNewestFirst(result.deployment);
  const paged = paginate(statuses, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${result.repo.name}/deployments/${result.deployment.id}/statuses`,
    pagination.page, pagination.perPage, statuses.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(status => buildDeploymentStatusResponse(status, result.deployment, targetDid, result.repo.name, baseUrl)),
    extraHeaders,
  );
}

export async function handleCreateDeploymentStatus(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await findDeployment(ctx, targetDid, repoName, deploymentId);
  if ('status' in result) { return result; }

  const state = stringParam(reqBody.state);
  if (!DEPLOYMENT_STATES.has(state)) {
    return jsonValidationError('Validation Failed: state must be one of error, failure, inactive, in_progress, queued, pending, success.');
  }

  const now = new Date().toISOString();
  const statusId = nextDeploymentStatusId(result.deployment);
  const environment = stringParam(reqBody.environment, latestStatus(result.deployment)?.environment ?? result.deployment.environment)
    || result.deployment.environment;
  const logUrl = stringParam(reqBody.log_url, stringParam(reqBody.target_url));
  const targetUrl = logUrl || stringParam(reqBody.target_url);
  const status: DeploymentStatusEntry = {
    id             : statusId,
    state          : state as DeploymentState,
    targetUrl,
    logUrl,
    description    : stringParam(reqBody.description),
    environment,
    environmentUrl : stringParam(reqBody.environment_url),
    creatorDid     : ctx.did,
    createdAt      : now,
    updatedAt      : now,
  };

  const updatedDeployment: DeploymentEntry = {
    ...result.deployment,
    environment : status.environment,
    updatedAt   : now,
    statuses    : {
      ...(result.deployment.statuses ?? {}),
      [deploymentKey(statusId)]: status,
    },
  };

  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    deploymentSettingsWithChange(result.settingsLookup.settings, result.key, updatedDeployment),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildDeploymentStatusResponse(status, updatedDeployment, targetDid, result.repo.name, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/deployments/:id/statuses/:status_id
// ---------------------------------------------------------------------------

export async function handleGetDeploymentStatus(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string, statusId: string, url: URL,
): Promise<JsonResponse> {
  const result = await findDeployment(ctx, targetDid, repoName, deploymentId);
  if ('status' in result) { return result; }

  const status = result.deployment.statuses?.[deploymentKey(parseInt(statusId, 10))];
  if (!status) {
    return jsonNotFound(`Deployment status ${statusId} not found.`);
  }

  return jsonOk(buildDeploymentStatusResponse(status, result.deployment, targetDid, result.repo.name, buildApiUrl(url)));
}
