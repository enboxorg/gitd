/**
 * GitHub API shim — branch, tag, and git ref endpoints.
 *
 * Maps mirrored `forge-refs` DWN records to GitHub REST API v3 responses.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type {
  BranchProtectionRestrictionsData,
  BranchProtectionRuleData,
  SettingsData,
} from '../repo.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

import { GitBackend } from '../git-server/git-backend.js';
import { resolveReposPath } from '../cli/flags.js';

import { rulesetProtectsBranch } from './repo-metadata.js';
import {
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
} from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GitRefInfo = {
  id : string;
  nodeId : string;
  name : string;
  target : string;
  type : 'branch' | 'tag';
};

type BranchProtectionRule = BranchProtectionRuleData;

type BranchProtectionRestrictions = BranchProtectionRestrictionsData;

type ParsedRequiredChecks = {
  checkApps : Record<string, number | null>;
  contexts : string[];
  contextsProvided : boolean;
  enabled : boolean;
  strict? : boolean;
  strictProvided : boolean;
};

type RequiredStatusCheck = {
  app_id : number | null;
  context : string;
};

type ParsedRequiredReviews = {
  bypassAllowances? : BranchProtectionRestrictions;
  bypassAllowancesProvided : boolean;
  count : number;
  countProvided : boolean;
  dismissalRestrictions? : BranchProtectionRestrictions;
  dismissalRestrictionsProvided : boolean;
  dismissStaleReviews? : boolean;
  dismissStaleReviewsProvided : boolean;
  enabled : boolean;
  requireCodeOwnerReviews? : boolean;
  requireCodeOwnerReviewsProvided : boolean;
  requireLastPushApproval? : boolean;
  requireLastPushApprovalProvided : boolean;
};

export type BranchRestrictionKind = 'apps' | 'teams' | 'users';

type BranchProtectionBooleanRuleKey =
  | 'allowDeletions'
  | 'allowForcePushes'
  | 'allowForkSyncing'
  | 'blockCreations'
  | 'enforceAdmins'
  | 'lockBranch'
  | 'requiredConversationResolution'
  | 'requiredLinearHistory';

type BranchProtectionBooleanField = {
  requestKey : string;
  ruleKey : BranchProtectionBooleanRuleKey;
};

const BRANCH_PROTECTION_BOOLEAN_FIELDS: BranchProtectionBooleanField[] = [
  { requestKey: 'enforce_admins', ruleKey: 'enforceAdmins' },
  { requestKey: 'required_linear_history', ruleKey: 'requiredLinearHistory' },
  { requestKey: 'allow_force_pushes', ruleKey: 'allowForcePushes' },
  { requestKey: 'allow_deletions', ruleKey: 'allowDeletions' },
  { requestKey: 'block_creations', ruleKey: 'blockCreations' },
  { requestKey: 'required_conversation_resolution', ruleKey: 'requiredConversationResolution' },
  { requestKey: 'lock_branch', ruleKey: 'lockBranch' },
  { requestKey: 'allow_fork_syncing', ruleKey: 'allowForkSyncing' },
];

type RepoSettingsData = SettingsData;

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

type BranchProtectionLookup = {
  lookup : RepoSettingsLookup;
  branchName : string;
  rule? : BranchProtectionRule;
};

export type GitRefOptions = {
  /** Base directory where gitd stores bare repositories. */
  reposPath? : string;
};

// ---------------------------------------------------------------------------
// DWN reads
// ---------------------------------------------------------------------------

async function listRefRecords(
  ctx: AgentContext, targetDid: string, repo: RepoInfo,
): Promise<GitRefInfo[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.refs.records.query('repo/ref' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const refs: GitRefInfo[] = [];
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    const name = data.name ?? tags.name ?? '';
    const target = data.target ?? tags.target ?? '';
    const rawType = data.type ?? tags.type ?? (name.startsWith('refs/tags/') ? 'tag' : 'branch');
    const type = rawType === 'tag' ? 'tag' : 'branch';

    if (!name || !target) { continue; }
    refs.push({
      id     : rec.id ?? name,
      nodeId : rec.id ?? '',
      name,
      target,
      type,
    });
  }

  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
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
  ctx: AgentContext, repo: RepoInfo, lookup: RepoSettingsLookup, settings: RepoSettingsData,
): Promise<JsonResponse | undefined> {
  if (lookup.record) {
    const { status } = await lookup.record.update({ data: settings });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update branch protection: ${status.detail}`);
    }
    return undefined;
  }

  const { status } = await ctx.repo.records.create('repo/settings' as any, {
    data            : settings,
    parentContextId : repo.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create branch protection: ${status.detail}`);
  }
  return undefined;
}

function shortRefName(refName: string): string {
  return refName.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeGitRef(ref: string): string {
  const decoded = decodeRouteParam(ref).replace(/^\/+/, '');
  return decoded.startsWith('refs/') ? decoded : `refs/${decoded}`;
}

async function findBranchRef(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, branch: string,
): Promise<{ branchName: string; ref?: GitRefInfo }> {
  const branchName = decodeRouteParam(branch);
  const refs = await listRefRecords(ctx, targetDid, repo);
  return {
    branchName,
    ref: refs.find(r => r.name === `refs/heads/${branchName}`),
  };
}

function protectionRuleFor(settings: RepoSettingsData, branchName: string): BranchProtectionRule | undefined {
  return settings.branchProtection?.[branchName];
}

function branchIsProtected(settings: RepoSettingsData, repo: RepoInfo, branchName: string): boolean {
  return Boolean(protectionRuleFor(settings, branchName))
    || rulesetProtectsBranch(settings, branchName, repo.defaultBranch);
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | JsonResponse {
  if (!Array.isArray(value)) {
    return jsonValidationError(`${fieldName} must be an array of strings.`);
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return jsonValidationError(`${fieldName} must be an array of strings.`);
    }
    if (!normalized.includes(item)) {
      normalized.push(item);
    }
  }
  return normalized;
}

function parseRequiredCheckAppId(value: unknown, fieldName: string): number | null | JsonResponse {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1) {
    return jsonValidationError(`${fieldName} must be an integer greater than or equal to -1.`);
  }
  return value;
}

function parseRequiredChecks(value: unknown): ParsedRequiredChecks | JsonResponse {
  if (value === undefined || value === null) {
    return {
      checkApps        : {},
      contexts         : [],
      contextsProvided : false,
      enabled          : false,
      strictProvided   : false,
    };
  }
  if (typeof value !== 'object') {
    return jsonValidationError('required_status_checks must be an object or null.');
  }

  const requiredStatusChecks = value as Record<string, unknown>;
  const rawStrict = requiredStatusChecks.strict;
  if (rawStrict !== undefined && rawStrict !== null && typeof rawStrict !== 'boolean') {
    return jsonValidationError('required_status_checks.strict must be a boolean or null.');
  }

  const contexts = requiredStatusChecks.contexts === undefined
    ? []
    : normalizeStringArray(requiredStatusChecks.contexts, 'required_status_checks.contexts');
  if (!Array.isArray(contexts)) { return contexts; }

  const checks = requiredStatusChecks.checks;
  const combined = [...contexts];
  const checkApps: Record<string, number | null> = {};
  for (const context of contexts) {
    checkApps[context] = null;
  }
  if (checks !== undefined) {
    if (!Array.isArray(checks)) {
      return jsonValidationError('required_status_checks.checks must be an array.');
    }
    for (const [index, check] of checks.entries()) {
      if (typeof check !== 'object' || check === null || typeof (check as Record<string, unknown>).context !== 'string') {
        return jsonValidationError('required_status_checks.checks items must include a string context.');
      }
      const rawCheck = check as Record<string, unknown>;
      const appId = parseRequiredCheckAppId(rawCheck.app_id, `required_status_checks.checks[${index}].app_id`);
      if (typeof appId !== 'number' && appId !== null) { return appId; }

      const context = rawCheck.context as string;
      if (!combined.includes(context)) {
        combined.push(context);
      }
      checkApps[context] = appId;
    }
  }

  return {
    checkApps        : checkApps,
    contexts         : combined,
    contextsProvided : requiredStatusChecks.contexts !== undefined || checks !== undefined,
    enabled          : true,
    strict           : rawStrict === true,
    strictProvided   : typeof rawStrict === 'boolean',
  };
}

function parseOptionalObjectBoolean(
  source: Record<string, unknown>, key: string, fieldName: string,
): { provided: boolean; value: boolean } | JsonResponse {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return { provided: false, value: false };
  }
  if (typeof raw !== 'boolean') {
    return jsonValidationError(`${fieldName} must be a boolean.`);
  }
  return { provided: true, value: raw };
}

function parseRequiredReviews(value: unknown): ParsedRequiredReviews | JsonResponse {
  if (value === undefined || value === null) {
    return {
      bypassAllowancesProvided        : false,
      count                           : 0,
      countProvided                   : false,
      dismissalRestrictionsProvided   : false,
      dismissStaleReviewsProvided     : false,
      enabled                         : false,
      requireCodeOwnerReviewsProvided : false,
      requireLastPushApprovalProvided : false,
    };
  }
  if (typeof value !== 'object') {
    return jsonValidationError('required_pull_request_reviews must be an object or null.');
  }

  const requiredPullRequestReviews = value as Record<string, unknown>;
  const rawCount = requiredPullRequestReviews.required_approving_review_count;
  const countProvided = rawCount !== undefined && rawCount !== null;
  if (countProvided && (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 0 || rawCount > 6)) {
    return jsonValidationError('required_pull_request_reviews.required_approving_review_count must be an integer between 0 and 6.');
  }

  const dismissalRestrictionsProvided = requiredPullRequestReviews.dismissal_restrictions !== undefined;
  const dismissalRestrictions = dismissalRestrictionsProvided
    ? parseOptionalBranchProtectionRestrictions(
      requiredPullRequestReviews.dismissal_restrictions,
      'required_pull_request_reviews.dismissal_restrictions',
    )
    : emptyBranchProtectionRestrictions();
  if ('status' in dismissalRestrictions) { return dismissalRestrictions; }

  const bypassAllowancesProvided = requiredPullRequestReviews.bypass_pull_request_allowances !== undefined;
  const bypassAllowances = bypassAllowancesProvided
    ? parseOptionalBranchProtectionRestrictions(
      requiredPullRequestReviews.bypass_pull_request_allowances,
      'required_pull_request_reviews.bypass_pull_request_allowances',
    )
    : emptyBranchProtectionRestrictions();
  if ('status' in bypassAllowances) { return bypassAllowances; }

  const dismissStaleReviews = parseOptionalObjectBoolean(
    requiredPullRequestReviews,
    'dismiss_stale_reviews',
    'required_pull_request_reviews.dismiss_stale_reviews',
  );
  if ('status' in dismissStaleReviews) { return dismissStaleReviews; }

  const requireCodeOwnerReviews = parseOptionalObjectBoolean(
    requiredPullRequestReviews,
    'require_code_owner_reviews',
    'required_pull_request_reviews.require_code_owner_reviews',
  );
  if ('status' in requireCodeOwnerReviews) { return requireCodeOwnerReviews; }

  const requireLastPushApproval = parseOptionalObjectBoolean(
    requiredPullRequestReviews,
    'require_last_push_approval',
    'required_pull_request_reviews.require_last_push_approval',
  );
  if ('status' in requireLastPushApproval) { return requireLastPushApproval; }

  return {
    bypassAllowances                : bypassAllowances,
    bypassAllowancesProvided        : bypassAllowancesProvided,
    count                           : countProvided ? rawCount as number : 0,
    countProvided                   : countProvided,
    dismissalRestrictions           : dismissalRestrictions,
    dismissalRestrictionsProvided   : dismissalRestrictionsProvided,
    dismissStaleReviews             : dismissStaleReviews.value,
    dismissStaleReviewsProvided     : dismissStaleReviews.provided,
    enabled                         : true,
    requireCodeOwnerReviews         : requireCodeOwnerReviews.value,
    requireCodeOwnerReviewsProvided : requireCodeOwnerReviews.provided,
    requireLastPushApproval         : requireLastPushApproval.value,
    requireLastPushApprovalProvided : requireLastPushApproval.provided,
  };
}

function parseOptionalBranchProtectionBoolean(value: unknown, fieldName: string): boolean | JsonResponse {
  if (value === undefined || value === null) { return false; }
  if (typeof value !== 'boolean') {
    return jsonValidationError(`${fieldName} must be a boolean or null.`);
  }
  return value;
}

function parseBranchProtectedFilter(url: URL): boolean | undefined | JsonResponse {
  const value = url.searchParams.get('protected');
  if (value === null) { return undefined; }
  if (value === 'true') { return true; }
  if (value === 'false') { return false; }
  return jsonValidationError('Validation Failed: protected must be true or false.');
}

function parseRequiredRestrictionList(value: unknown, fieldName: string): string[] | JsonResponse {
  if (value === undefined) {
    return jsonValidationError(`${fieldName} must be an array of strings.`);
  }
  return normalizeStringArray(value, fieldName);
}

function parseOptionalRestrictionList(value: unknown, fieldName: string): string[] | JsonResponse {
  if (value === undefined || value === null) { return []; }
  return normalizeStringArray(value, fieldName);
}

function totalRestrictionActors(restrictions: BranchProtectionRestrictions): number {
  return restrictions.apps.length + restrictions.teams.length + restrictions.users.length;
}

function parseBranchProtectionRestrictions(value: unknown): BranchProtectionRestrictions | undefined | JsonResponse {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return jsonValidationError('restrictions must be an object or null.');
  }

  const raw = value as Record<string, unknown>;
  const users = parseRequiredRestrictionList(raw.users, 'restrictions.users');
  if (!Array.isArray(users)) { return users; }
  const teams = parseRequiredRestrictionList(raw.teams, 'restrictions.teams');
  if (!Array.isArray(teams)) { return teams; }
  const apps = parseRequiredRestrictionList(raw.apps, 'restrictions.apps');
  if (!Array.isArray(apps)) { return apps; }

  const restrictions = { apps, teams, users };
  if (totalRestrictionActors(restrictions) > 100) {
    return jsonValidationError('restrictions users, teams, and apps are limited to 100 total items.');
  }
  return restrictions;
}

function parseOptionalBranchProtectionRestrictions(value: unknown, fieldName: string): BranchProtectionRestrictions | JsonResponse {
  if (value === undefined || value === null) {
    return emptyBranchProtectionRestrictions();
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return jsonValidationError(`${fieldName} must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const users = parseOptionalRestrictionList(raw.users, `${fieldName}.users`);
  if (!Array.isArray(users)) { return users; }
  const teams = parseOptionalRestrictionList(raw.teams, `${fieldName}.teams`);
  if (!Array.isArray(teams)) { return teams; }
  const apps = parseOptionalRestrictionList(raw.apps, `${fieldName}.apps`);
  if (!Array.isArray(apps)) { return apps; }

  const restrictions = { apps, teams, users };
  if (totalRestrictionActors(restrictions) > 100) {
    return jsonValidationError(`${fieldName} users, teams, and apps are limited to 100 total items.`);
  }
  return restrictions;
}

function parseRestrictionActorBody(reqBody: Record<string, unknown>, kind: BranchRestrictionKind): string[] | JsonResponse {
  const actors = normalizeStringArray(reqBody[kind], kind);
  if (!Array.isArray(actors)) { return actors; }
  return actors;
}

function emptyBranchProtectionRestrictions(): BranchProtectionRestrictions {
  return { apps: [], teams: [], users: [] };
}

function normalizeStoredRestrictions(restrictions: BranchProtectionRestrictions | undefined): BranchProtectionRestrictions | undefined {
  if (!restrictions) { return undefined; }
  return {
    apps  : Array.isArray(restrictions.apps) ? restrictions.apps.filter(item => typeof item === 'string') : [],
    teams : Array.isArray(restrictions.teams) ? restrictions.teams.filter(item => typeof item === 'string') : [],
    users : Array.isArray(restrictions.users) ? restrictions.users.filter(item => typeof item === 'string') : [],
  };
}

function mergeRestrictionActors(current: string[], additions: string[]): string[] {
  return normalizeStringArray([...current, ...additions], 'restrictions') as string[];
}

function removeRestrictionActors(current: string[], removals: string[]): string[] {
  return current.filter(actor => !removals.includes(actor));
}

function parseContextsBody(reqBody: Record<string, unknown>): string[] | JsonResponse {
  return normalizeStringArray(reqBody.contexts, 'contexts');
}

function hasRequiredChecks(rule: BranchProtectionRule | undefined): boolean {
  return Boolean(rule) && (
    Object.prototype.hasOwnProperty.call(rule, 'requiredChecks') ||
    Object.prototype.hasOwnProperty.call(rule, 'requiredCheckApps')
  );
}

function hasRequiredReviews(rule: BranchProtectionRule | undefined): boolean {
  return Boolean(rule) && (
    Object.prototype.hasOwnProperty.call(rule, 'requiredReviews') ||
    Object.prototype.hasOwnProperty.call(rule, 'reviewBypassAllowances') ||
    Object.prototype.hasOwnProperty.call(rule, 'reviewDismissalRestrictions') ||
    Object.prototype.hasOwnProperty.call(rule, 'dismissStaleReviews') ||
    Object.prototype.hasOwnProperty.call(rule, 'requireCodeOwnerReviews') ||
    Object.prototype.hasOwnProperty.call(rule, 'requireLastPushApproval')
  );
}

function requiredChecks(rule: BranchProtectionRule | undefined): string[] {
  const contexts = Array.isArray(rule?.requiredChecks)
    ? rule.requiredChecks.filter((context): context is string => typeof context === 'string')
    : [];
  for (const context of Object.keys(requiredCheckApps(rule))) {
    if (!contexts.includes(context)) {
      contexts.push(context);
    }
  }
  return contexts;
}

function requiredCheckApps(rule: BranchProtectionRule | undefined): Record<string, number | null> {
  if (!rule?.requiredCheckApps || typeof rule.requiredCheckApps !== 'object' || Array.isArray(rule.requiredCheckApps)) {
    return {};
  }

  const appIds: Record<string, number | null> = {};
  for (const [context, appId] of Object.entries(rule.requiredCheckApps)) {
    if (appId === null || (typeof appId === 'number' && Number.isInteger(appId) && appId >= -1)) {
      appIds[context] = appId;
    }
  }
  return appIds;
}

function requiredStatusChecks(rule: BranchProtectionRule | undefined): RequiredStatusCheck[] {
  const appIds = requiredCheckApps(rule);
  return requiredChecks(rule).map(context => ({
    app_id  : appIds[context] ?? null,
    context : context,
  }));
}

function persistRequiredCheckApps(rule: BranchProtectionRule, checkApps: Record<string, number | null>): void {
  const persisted: Record<string, number | null> = {};
  for (const [context, appId] of Object.entries(checkApps)) {
    if (appId !== null) {
      persisted[context] = appId;
    }
  }

  if (Object.keys(persisted).length > 0) {
    rule.requiredCheckApps = persisted;
  } else {
    delete rule.requiredCheckApps;
  }
}

function pruneRequiredCheckApps(rule: BranchProtectionRule, contexts: string[]): void {
  const appIds = requiredCheckApps(rule);
  const persisted: Record<string, number | null> = {};
  for (const context of contexts) {
    const appId = appIds[context] ?? null;
    if (appId !== null) {
      persisted[context] = appId;
    }
  }

  if (Object.keys(persisted).length > 0) {
    rule.requiredCheckApps = persisted;
  } else {
    delete rule.requiredCheckApps;
  }
}

function buildAdminBranchProtectionResponse(
  rule: BranchProtectionRule | undefined,
  targetDid: string,
  repoName: string,
  branchName: string,
  baseUrl: string,
): Record<string, unknown> {
  const encodedBranch = encodeURIComponent(branchName);
  return {
    url     : `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection/enforce_admins`,
    enabled : rule?.enforceAdmins === true,
  };
}

function buildCommitSignatureProtectionResponse(
  rule: BranchProtectionRule | undefined,
  targetDid: string,
  repoName: string,
  branchName: string,
  baseUrl: string,
): Record<string, unknown> {
  const encodedBranch = encodeURIComponent(branchName);
  return {
    url     : `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection/required_signatures`,
    enabled : rule?.requiredSignatures === true,
  };
}

function buildRestrictedUser(login: string, baseUrl: string): Record<string, unknown> {
  const id = numericId(login);
  const encodedLogin = encodeURIComponent(login);
  return {
    login               : login,
    id                  : id,
    node_id             : `U_${id.toString(36)}`,
    avatar_url          : '',
    gravatar_id         : '',
    url                 : `${baseUrl}/users/${encodedLogin}`,
    html_url            : `${baseUrl}/users/${encodedLogin}`,
    followers_url       : `${baseUrl}/users/${encodedLogin}/followers`,
    following_url       : `${baseUrl}/users/${encodedLogin}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${encodedLogin}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${encodedLogin}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${encodedLogin}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${encodedLogin}/orgs`,
    repos_url           : `${baseUrl}/users/${encodedLogin}/repos`,
    events_url          : `${baseUrl}/users/${encodedLogin}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${encodedLogin}/received_events`,
    type                : 'User',
    site_admin          : false,
  };
}

function buildRestrictedTeam(slug: string, baseUrl: string): Record<string, unknown> {
  const id = numericId(`team:${slug}`);
  const encodedSlug = encodeURIComponent(slug);
  return {
    id                   : id,
    node_id              : `T_${id.toString(36)}`,
    url                  : `${baseUrl}/teams/${id}`,
    html_url             : `${baseUrl}/teams/${encodedSlug}`,
    name                 : slug,
    slug                 : slug,
    description          : null,
    privacy              : 'closed',
    notification_setting : 'notifications_enabled',
    permission           : 'pull',
    members_url          : `${baseUrl}/teams/${id}/members{/member}`,
    repositories_url     : `${baseUrl}/teams/${id}/repos`,
    parent               : null,
  };
}

function buildRestrictedApp(slug: string, baseUrl: string): Record<string, unknown> {
  const id = numericId(`app:${slug}`);
  const encodedSlug = encodeURIComponent(slug);
  return {
    id           : id,
    slug         : slug,
    node_id      : `A_${id.toString(36)}`,
    owner        : buildOwner(slug, baseUrl),
    name         : slug,
    description  : '',
    external_url : null,
    html_url     : `${baseUrl}/apps/${encodedSlug}`,
    created_at   : new Date(0).toISOString(),
    updated_at   : new Date(0).toISOString(),
    permissions  : { metadata: 'read' },
    events       : [],
  };
}

function buildRestrictionActorsResponse(
  restrictions: BranchProtectionRestrictions, kind: BranchRestrictionKind, baseUrl: string,
): Record<string, unknown>[] {
  if (kind === 'apps') {
    return restrictions.apps.map(app => buildRestrictedApp(app, baseUrl));
  }
  if (kind === 'teams') {
    return restrictions.teams.map(team => buildRestrictedTeam(team, baseUrl));
  }
  return restrictions.users.map(user => buildRestrictedUser(user, baseUrl));
}

function buildBranchAccessRestrictionsResponse(
  rule: BranchProtectionRule,
  targetDid: string,
  repoName: string,
  branchName: string,
  baseUrl: string,
): Record<string, unknown> | null {
  const restrictions = normalizeStoredRestrictions(rule.restrictions);
  if (!restrictions) { return null; }

  const encodedBranch = encodeURIComponent(branchName);
  const base = `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection/restrictions`;
  return {
    url       : base,
    users_url : `${base}/users`,
    teams_url : `${base}/teams`,
    apps_url  : `${base}/apps`,
    users     : buildRestrictionActorsResponse(restrictions, 'users', baseUrl),
    teams     : buildRestrictionActorsResponse(restrictions, 'teams', baseUrl),
    apps      : buildRestrictionActorsResponse(restrictions, 'apps', baseUrl),
  };
}

async function saveBranchProtectionRule(
  ctx: AgentContext, lookup: RepoSettingsLookup, branchName: string, rule: BranchProtectionRule,
): Promise<JsonResponse | undefined> {
  const settings: RepoSettingsData = {
    ...lookup.settings,
    branchProtection: {
      ...(lookup.settings.branchProtection ?? {}),
      [branchName]: rule,
    },
  };
  return saveRepoSettings(ctx, lookup.repo, lookup, settings);
}

async function getBranchProtectionLookup(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<BranchProtectionLookup | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const { branchName, ref } = await findBranchRef(ctx, targetDid, lookup.repo, branch);
  if (!ref) {
    return jsonNotFound(`Branch '${branchName}' not found.`);
  }

  return {
    lookup,
    branchName,
    rule: protectionRuleFor(lookup.settings, branchName),
  };
}

// ---------------------------------------------------------------------------
// Local git helpers
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

function localRepoPath(ctx: AgentContext, targetDid: string, repoName: string, options?: GitRefOptions): string | null {
  const reposPath = options?.reposPath ?? resolveReposPath([], ctx.profileName ?? null);
  const backend = new GitBackend({ basePath: reposPath });

  try {
    return backend.exists(targetDid, repoName) ? backend.repoPath(targetDid, repoName) : null;
  } catch {
    return null;
  }
}

async function gitText(repoPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      env   : process.env,
      stdio : ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf-8').trim());
    });
  });
}

async function peelTagCommit(repoPath: string | null, ref: GitRefInfo): Promise<string> {
  if (!repoPath || !ref.name.startsWith('refs/tags/')) {
    return ref.target;
  }

  const peeled = await gitText(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref.name}^{commit}`]);
  return peeled && FULL_SHA_RE.test(peeled) ? peeled.toLowerCase() : ref.target;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildBranchResponse(
  ref: GitRefInfo, targetDid: string, repoName: string, baseUrl: string, rule?: BranchProtectionRule, protectedBranch = Boolean(rule),
): Record<string, unknown> {
  const branchName = shortRefName(ref.name);
  const contexts = requiredChecks(rule);
  return {
    name   : branchName,
    commit : {
      sha : ref.target,
      url : `${baseUrl}/repos/${targetDid}/${repoName}/commits/${ref.target}`,
    },
    protected  : protectedBranch,
    protection : {
      enabled                : protectedBranch,
      required_status_checks : {
        enforcement_level : contexts.length > 0 ? 'non_admins' : 'off',
        contexts          : contexts,
      },
    },
    protection_url: `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodeURIComponent(branchName)}/protection`,
  };
}

function buildBranchProtectionResponse(
  rule: BranchProtectionRule, targetDid: string, repoName: string, branchName: string, baseUrl: string,
): Record<string, unknown> {
  const encodedBranch = encodeURIComponent(branchName);
  const base = `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection`;

  return {
    url                              : base,
    required_status_checks           : buildRequiredStatusChecksResponse(rule, targetDid, repoName, branchName, baseUrl),
    enforce_admins                   : buildAdminBranchProtectionResponse(rule, targetDid, repoName, branchName, baseUrl),
    required_pull_request_reviews    : buildPullRequestReviewProtectionResponse(rule, targetDid, repoName, branchName, baseUrl),
    required_signatures              : buildCommitSignatureProtectionResponse(rule, targetDid, repoName, branchName, baseUrl),
    restrictions                     : buildBranchAccessRestrictionsResponse(rule, targetDid, repoName, branchName, baseUrl),
    required_linear_history          : { enabled: rule.requiredLinearHistory === true },
    allow_force_pushes               : { enabled: rule.allowForcePushes === true },
    allow_deletions                  : { enabled: rule.allowDeletions === true },
    block_creations                  : { enabled: rule.blockCreations === true },
    required_conversation_resolution : { enabled: rule.requiredConversationResolution === true },
    lock_branch                      : { enabled: rule.lockBranch === true },
    allow_fork_syncing               : { enabled: rule.allowForkSyncing === true },
  };
}

function buildRequiredStatusChecksResponse(
  rule: BranchProtectionRule, targetDid: string, repoName: string, branchName: string, baseUrl: string,
): Record<string, unknown> {
  const encodedBranch = encodeURIComponent(branchName);
  const base = `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection/required_status_checks`;
  const contexts = requiredChecks(rule);

  return {
    url          : base,
    strict       : rule.requiredChecksStrict === true,
    checks       : requiredStatusChecks(rule),
    contexts     : contexts,
    contexts_url : `${base}/contexts`,
  };
}

function buildPullRequestReviewProtectionResponse(
  rule: BranchProtectionRule, targetDid: string, repoName: string, branchName: string, baseUrl: string,
): Record<string, unknown> {
  const encodedBranch = encodeURIComponent(branchName);
  const base = `${baseUrl}/repos/${targetDid}/${repoName}/branches/${encodedBranch}/protection/required_pull_request_reviews`;
  const restrictionsBase = `${base.replace('/required_pull_request_reviews', '')}/dismissal_restrictions`;
  const requiredReviews = Number.isInteger(rule.requiredReviews) ? rule.requiredReviews ?? 0 : 0;
  const bypassAllowances = normalizeStoredRestrictions(rule.reviewBypassAllowances) ?? emptyBranchProtectionRestrictions();
  const dismissalRestrictions = normalizeStoredRestrictions(rule.reviewDismissalRestrictions) ?? emptyBranchProtectionRestrictions();

  return {
    url                    : base,
    dismissal_restrictions : {
      url       : restrictionsBase,
      users_url : `${restrictionsBase}/users`,
      teams_url : `${restrictionsBase}/teams`,
      users     : buildRestrictionActorsResponse(dismissalRestrictions, 'users', baseUrl),
      teams     : buildRestrictionActorsResponse(dismissalRestrictions, 'teams', baseUrl),
      apps      : buildRestrictionActorsResponse(dismissalRestrictions, 'apps', baseUrl),
    },
    bypass_pull_request_allowances: {
      users : buildRestrictionActorsResponse(bypassAllowances, 'users', baseUrl),
      teams : buildRestrictionActorsResponse(bypassAllowances, 'teams', baseUrl),
      apps  : buildRestrictionActorsResponse(bypassAllowances, 'apps', baseUrl),
    },
    dismiss_stale_reviews           : rule.dismissStaleReviews === true,
    require_code_owner_reviews      : rule.requireCodeOwnerReviews === true,
    required_approving_review_count : requiredReviews,
    require_last_push_approval      : rule.requireLastPushApproval === true,
  };
}

function buildGitRefResponse(
  ref: GitRefInfo, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const refPath = ref.name.replace(/^refs\//, '');
  const objectType = ref.type === 'tag' ? 'tag' : 'commit';

  return {
    ref     : ref.name,
    node_id : ref.nodeId,
    url     : `${baseUrl}/repos/${targetDid}/${repoName}/git/refs/${refPath}`,
    object  : {
      type : objectType,
      sha  : ref.target,
      url  : `${baseUrl}/repos/${targetDid}/${repoName}/git/${objectType}s/${ref.target}`,
    },
  };
}

function buildTagResponse(
  ref: GitRefInfo, targetDid: string, repoName: string, baseUrl: string, commitSha = ref.target,
): Record<string, unknown> {
  const tagName = shortRefName(ref.name);

  return {
    name        : tagName,
    node_id     : ref.nodeId,
    zipball_url : `${baseUrl}/repos/${targetDid}/${repoName}/zipball/${encodeURIComponent(tagName)}`,
    tarball_url : `${baseUrl}/repos/${targetDid}/${repoName}/tarball/${encodeURIComponent(tagName)}`,
    commit      : {
      sha : commitSha,
      url : `${baseUrl}/repos/${targetDid}/${repoName}/commits/${commitSha}`,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/branches
// ---------------------------------------------------------------------------

export async function handleListBranches(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const protectedFilter = parseBranchProtectedFilter(url);
  if (typeof protectedFilter !== 'boolean' && protectedFilter !== undefined) { return protectedFilter; }

  let refs = (await listRefRecords(ctx, targetDid, lookup.repo)).filter(r => r.type === 'branch');
  if (typeof protectedFilter === 'boolean') {
    refs = refs.filter(ref => branchIsProtected(lookup.settings, lookup.repo, shortRefName(ref.name)) === protectedFilter);
  }
  const paged = paginate(refs, pagination);
  const listPath = `/repos/${targetDid}/${lookup.repo.name}/branches${typeof protectedFilter === 'boolean' ? `?protected=${protectedFilter}` : ''}`;

  const linkHeader = buildLinkHeader(
    baseUrl, listPath,
    pagination.page, pagination.perPage, refs.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(
    paged.map(ref => {
      const branchName = shortRefName(ref.name);
      const rule = protectionRuleFor(lookup.settings, branchName);
      return buildBranchResponse(
        ref,
        targetDid,
        lookup.repo.name,
        baseUrl,
        rule,
        branchIsProtected(lookup.settings, lookup.repo, branchName),
      );
    }),
    extraHeaders,
  );
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/branches/:branch
// ---------------------------------------------------------------------------

export async function handleGetBranch(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const { branchName, ref } = await findBranchRef(ctx, targetDid, lookup.repo, branch);
  if (!ref) {
    return jsonNotFound(`Branch '${branchName}' not found.`);
  }

  return jsonOk(buildBranchResponse(
    ref,
    targetDid,
    lookup.repo.name,
    buildApiUrl(url),
    protectionRuleFor(lookup.settings, branchName),
    branchIsProtected(lookup.settings, lookup.repo, branchName),
  ));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection
// ---------------------------------------------------------------------------

export async function handleGetBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  return jsonOk(buildBranchProtectionResponse(rule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleUpdateBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName } = result;

  const requiredChecks = parseRequiredChecks(reqBody.required_status_checks);
  if ('status' in requiredChecks) { return requiredChecks; }

  const requiredReviews = parseRequiredReviews(reqBody.required_pull_request_reviews);
  if ('status' in requiredReviews) { return requiredReviews; }

  const restrictions = parseBranchProtectionRestrictions(reqBody.restrictions);
  if (restrictions && 'status' in restrictions) { return restrictions; }

  const rule: BranchProtectionRule = {};
  if (requiredChecks.enabled) {
    rule.requiredChecks = requiredChecks.contexts;
    persistRequiredCheckApps(rule, requiredChecks.checkApps);
    if (requiredChecks.strict === true) {
      rule.requiredChecksStrict = true;
    }
  }
  if (requiredReviews.enabled) {
    rule.requiredReviews = requiredReviews.count;
    if (
      requiredReviews.bypassAllowancesProvided &&
      requiredReviews.bypassAllowances &&
      totalRestrictionActors(requiredReviews.bypassAllowances) > 0
    ) {
      rule.reviewBypassAllowances = requiredReviews.bypassAllowances;
    }
    if (
      requiredReviews.dismissalRestrictionsProvided &&
      requiredReviews.dismissalRestrictions &&
      totalRestrictionActors(requiredReviews.dismissalRestrictions) > 0
    ) {
      rule.reviewDismissalRestrictions = requiredReviews.dismissalRestrictions;
    }
    if (requiredReviews.dismissStaleReviews === true) {
      rule.dismissStaleReviews = true;
    }
    if (requiredReviews.requireCodeOwnerReviews === true) {
      rule.requireCodeOwnerReviews = true;
    }
    if (requiredReviews.requireLastPushApproval === true) {
      rule.requireLastPushApproval = true;
    }
  }
  for (const { requestKey, ruleKey } of BRANCH_PROTECTION_BOOLEAN_FIELDS) {
    const value = parseOptionalBranchProtectionBoolean(reqBody[requestKey], requestKey);
    if (typeof value !== 'boolean') { return value; }
    if (value) {
      rule[ruleKey] = true;
    }
  }
  if (restrictions) {
    rule.restrictions = restrictions;
  }

  const error = await saveBranchProtectionRule(ctx, lookup, branchName, rule);
  if (error) { return error; }

  return jsonOk(buildBranchProtectionResponse(rule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleDeleteBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName } = result;

  if (!lookup.settings.branchProtection?.[branchName]) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const branchProtection = { ...lookup.settings.branchProtection };
  delete branchProtection[branchName];
  const settings: RepoSettingsData = { ...lookup.settings };
  if (Object.keys(branchProtection).length > 0) {
    settings.branchProtection = branchProtection;
  } else {
    delete settings.branchProtection;
  }

  const error = await saveRepoSettings(ctx, lookup.repo, lookup, settings);
  if (error) { return error; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/restrictions
// ---------------------------------------------------------------------------

export async function handleGetBranchAccessRestrictions(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const restrictions = buildBranchAccessRestrictionsResponse(rule, targetDid, lookup.repo.name, branchName, buildApiUrl(url));
  if (!restrictions) {
    return jsonNotFound(`Access restrictions for '${branchName}' not found.`);
  }
  return jsonOk(restrictions);
}

export async function handleDeleteBranchAccessRestrictions(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }
  if (!rule.restrictions) {
    return jsonNotFound(`Access restrictions for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...rule };
  delete updatedRule.restrictions;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonNoContent();
}

export async function handleListBranchAccessRestrictionActors(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  branch: string,
  kind: BranchRestrictionKind,
  url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const restrictions = normalizeStoredRestrictions(rule.restrictions);
  if (!restrictions) {
    return jsonNotFound(`Access restrictions for '${branchName}' not found.`);
  }
  return jsonOk(buildRestrictionActorsResponse(restrictions, kind, buildApiUrl(url)));
}

export async function handleAddBranchAccessRestrictionActors(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  branch: string,
  kind: BranchRestrictionKind,
  reqBody: Record<string, unknown>,
  url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const actors = parseRestrictionActorBody(reqBody, kind);
  if (!Array.isArray(actors)) { return actors; }

  const restrictions = normalizeStoredRestrictions(rule.restrictions) ?? emptyBranchProtectionRestrictions();
  restrictions[kind] = mergeRestrictionActors(restrictions[kind], actors);
  if (totalRestrictionActors(restrictions) > 100) {
    return jsonValidationError('restrictions users, teams, and apps are limited to 100 total items.');
  }

  const updatedRule: BranchProtectionRule = { ...rule, restrictions };
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildRestrictionActorsResponse(restrictions, kind, buildApiUrl(url)));
}

export async function handleSetBranchAccessRestrictionActors(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  branch: string,
  kind: BranchRestrictionKind,
  reqBody: Record<string, unknown>,
  url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const actors = parseRestrictionActorBody(reqBody, kind);
  if (!Array.isArray(actors)) { return actors; }

  const restrictions = normalizeStoredRestrictions(rule.restrictions) ?? emptyBranchProtectionRestrictions();
  restrictions[kind] = actors;
  if (totalRestrictionActors(restrictions) > 100) {
    return jsonValidationError('restrictions users, teams, and apps are limited to 100 total items.');
  }

  const updatedRule: BranchProtectionRule = { ...rule, restrictions };
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildRestrictionActorsResponse(restrictions, kind, buildApiUrl(url)));
}

export async function handleRemoveBranchAccessRestrictionActors(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  branch: string,
  kind: BranchRestrictionKind,
  reqBody: Record<string, unknown>,
  url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const actors = parseRestrictionActorBody(reqBody, kind);
  if (!Array.isArray(actors)) { return actors; }

  const restrictions = normalizeStoredRestrictions(rule.restrictions);
  if (!restrictions) {
    return jsonNotFound(`Access restrictions for '${branchName}' not found.`);
  }
  restrictions[kind] = removeRestrictionActors(restrictions[kind], actors);

  const updatedRule: BranchProtectionRule = { ...rule, restrictions };
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildRestrictionActorsResponse(restrictions, kind, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/required_signatures
// ---------------------------------------------------------------------------

export async function handleGetCommitSignatureProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  return jsonOk(buildCommitSignatureProtectionResponse(rule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleCreateCommitSignatureProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...rule, requiredSignatures: true };
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildCommitSignatureProtectionResponse(updatedRule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleDeleteCommitSignatureProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...rule };
  delete updatedRule.requiredSignatures;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/enforce_admins
// ---------------------------------------------------------------------------

export async function handleGetAdminBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  return jsonOk(buildAdminBranchProtectionResponse(rule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleSetAdminBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...rule, enforceAdmins: true };
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildAdminBranchProtectionResponse(updatedRule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleDeleteAdminBranchProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!rule) {
    return jsonNotFound(`Branch protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...rule };
  delete updatedRule.enforceAdmins;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/required_status_checks
// ---------------------------------------------------------------------------

export async function handleGetRequiredStatusChecksProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!hasRequiredChecks(rule)) {
    return jsonNotFound(`Status check protection for '${branchName}' not found.`);
  }

  return jsonOk(buildRequiredStatusChecksResponse(rule ?? {}, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleUpdateRequiredStatusChecksProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;

  const contexts = parseRequiredChecks(reqBody);
  if ('status' in contexts) { return contexts; }

  const updatedRule: BranchProtectionRule = {
    ...(rule ?? {}),
    requiredChecks: contexts.contextsProvided ? contexts.contexts : requiredChecks(rule),
  };
  if (contexts.contextsProvided) {
    persistRequiredCheckApps(updatedRule, contexts.checkApps);
  }
  if (contexts.strictProvided) {
    if (contexts.strict === true) {
      updatedRule.requiredChecksStrict = true;
    } else {
      delete updatedRule.requiredChecksStrict;
    }
  }
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildRequiredStatusChecksResponse(updatedRule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleDeleteRequiredStatusChecksProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!hasRequiredChecks(rule)) {
    return jsonNotFound(`Status check protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...(rule ?? {}) };
  delete updatedRule.requiredChecks;
  delete updatedRule.requiredCheckApps;
  delete updatedRule.requiredChecksStrict;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts
// ---------------------------------------------------------------------------

export async function handleListStatusCheckContexts(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { branchName, rule } = result;
  if (!hasRequiredChecks(rule)) {
    return jsonNotFound(`Status check protection for '${branchName}' not found.`);
  }

  return jsonOk(requiredChecks(rule));
}

export async function handleAddStatusCheckContexts(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;

  const contexts = parseContextsBody(reqBody);
  if (!Array.isArray(contexts)) { return contexts; }

  const combined = [...requiredChecks(rule)];
  for (const context of contexts) {
    if (!combined.includes(context)) {
      combined.push(context);
    }
  }

  const updatedRule: BranchProtectionRule = { ...(rule ?? {}), requiredChecks: combined };
  pruneRequiredCheckApps(updatedRule, combined);
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(combined);
}

export async function handleSetStatusCheckContexts(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;

  const contexts = parseContextsBody(reqBody);
  if (!Array.isArray(contexts)) { return contexts; }

  const updatedRule: BranchProtectionRule = { ...(rule ?? {}), requiredChecks: contexts };
  delete updatedRule.requiredCheckApps;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(contexts);
}

export async function handleRemoveStatusCheckContexts(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!hasRequiredChecks(rule)) {
    return jsonNotFound(`Status check protection for '${branchName}' not found.`);
  }

  const contexts = parseContextsBody(reqBody);
  if (!Array.isArray(contexts)) { return contexts; }

  const remaining = requiredChecks(rule).filter(context => !contexts.includes(context));
  const updatedRule: BranchProtectionRule = { ...(rule ?? {}), requiredChecks: remaining };
  pruneRequiredCheckApps(updatedRule, remaining);
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(remaining);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews
// ---------------------------------------------------------------------------

export async function handleGetPullRequestReviewProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!hasRequiredReviews(rule)) {
    return jsonNotFound(`Pull request review protection for '${branchName}' not found.`);
  }

  return jsonOk(buildPullRequestReviewProtectionResponse(rule ?? {}, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleUpdatePullRequestReviewProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;

  const requiredReviews = parseRequiredReviews(reqBody);
  if ('status' in requiredReviews) { return requiredReviews; }

  const updatedRule: BranchProtectionRule = { ...(rule ?? {}) };
  updatedRule.requiredReviews = requiredReviews.countProvided
    ? requiredReviews.count
    : rule?.requiredReviews ?? 0;

  if (requiredReviews.dismissStaleReviewsProvided) {
    if (requiredReviews.dismissStaleReviews === true) {
      updatedRule.dismissStaleReviews = true;
    } else {
      delete updatedRule.dismissStaleReviews;
    }
  }
  if (requiredReviews.requireCodeOwnerReviewsProvided) {
    if (requiredReviews.requireCodeOwnerReviews === true) {
      updatedRule.requireCodeOwnerReviews = true;
    } else {
      delete updatedRule.requireCodeOwnerReviews;
    }
  }
  if (requiredReviews.requireLastPushApprovalProvided) {
    if (requiredReviews.requireLastPushApproval === true) {
      updatedRule.requireLastPushApproval = true;
    } else {
      delete updatedRule.requireLastPushApproval;
    }
  }
  if (requiredReviews.dismissalRestrictionsProvided) {
    if (requiredReviews.dismissalRestrictions && totalRestrictionActors(requiredReviews.dismissalRestrictions) > 0) {
      updatedRule.reviewDismissalRestrictions = requiredReviews.dismissalRestrictions;
    } else {
      delete updatedRule.reviewDismissalRestrictions;
    }
  }
  if (requiredReviews.bypassAllowancesProvided) {
    if (requiredReviews.bypassAllowances && totalRestrictionActors(requiredReviews.bypassAllowances) > 0) {
      updatedRule.reviewBypassAllowances = requiredReviews.bypassAllowances;
    } else {
      delete updatedRule.reviewBypassAllowances;
    }
  }

  if (!hasRequiredReviews(updatedRule)) {
    updatedRule.requiredReviews = 0;
  }
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonOk(buildPullRequestReviewProtectionResponse(updatedRule, targetDid, lookup.repo.name, branchName, buildApiUrl(url)));
}

export async function handleDeletePullRequestReviewProtection(
  ctx: AgentContext, targetDid: string, repoName: string, branch: string,
): Promise<JsonResponse> {
  const result = await getBranchProtectionLookup(ctx, targetDid, repoName, branch);
  if ('status' in result) { return result; }
  const { lookup, branchName, rule } = result;
  if (!hasRequiredReviews(rule)) {
    return jsonNotFound(`Pull request review protection for '${branchName}' not found.`);
  }

  const updatedRule: BranchProtectionRule = { ...(rule ?? {}) };
  delete updatedRule.requiredReviews;
  delete updatedRule.reviewBypassAllowances;
  delete updatedRule.reviewDismissalRestrictions;
  delete updatedRule.dismissStaleReviews;
  delete updatedRule.requireCodeOwnerReviews;
  delete updatedRule.requireLastPushApproval;
  const error = await saveBranchProtectionRule(ctx, lookup, branchName, updatedRule);
  if (error) { return error; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/tags
// ---------------------------------------------------------------------------

export async function handleListTags(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options?: GitRefOptions,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const refs = (await listRefRecords(ctx, targetDid, repo)).filter(r => r.type === 'tag');
  const paged = paginate(refs, pagination);
  const repoPath = localRepoPath(ctx, targetDid, repo.name, options);
  const commitShas = await Promise.all(paged.map(ref => peelTagCommit(repoPath, ref)));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/tags`,
    pagination.page, pagination.perPage, refs.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(
    paged.map((ref, index) => buildTagResponse(ref, targetDid, repo.name, baseUrl, commitShas[index])),
    extraHeaders,
  );
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/git/ref/:ref
// ---------------------------------------------------------------------------

export async function handleGetGitRef(
  ctx: AgentContext, targetDid: string, repoName: string, refPath: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const fullRef = normalizeGitRef(refPath);
  const refs = await listRefRecords(ctx, targetDid, repo);
  const ref = refs.find(r => r.name === fullRef);
  if (!ref) {
    return jsonNotFound(`Reference '${fullRef}' not found.`);
  }

  return jsonOk(buildGitRefResponse(ref, targetDid, repo.name, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/git/matching-refs/:ref
// ---------------------------------------------------------------------------

export async function handleListMatchingGitRefs(
  ctx: AgentContext, targetDid: string, repoName: string, refPrefix: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const prefix = normalizeGitRef(refPrefix);
  const refs = await listRefRecords(ctx, targetDid, repo);
  const matching = refs.filter(r => r.name.startsWith(prefix));

  return jsonOk(matching.map(ref => buildGitRefResponse(ref, targetDid, repo.name, buildApiUrl(url))));
}
