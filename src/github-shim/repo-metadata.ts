/**
 * GitHub API shim — repository metadata, topics, deploy keys, and collaborator endpoints.
 *
 * Maps forge repo topic records and collaborator role records onto GitHub REST
 * API v3 repository metadata routes.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type {
  CodeScanningAlertData,
  DependabotAlertData,
  RepositoryRulesetData,
  RepositoryRulesetStateData,
  SettingsData,
} from '../repo.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

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

type CollaboratorRole = 'maintainer' | 'triager' | 'contributor' | 'viewer';
type CollaboratorAffiliationFilter = 'outside' | 'direct' | 'all';
type CollaboratorPermissionFilter = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

type CollaboratorInfo = {
  did : string;
  alias : string;
  role : CollaboratorRole;
  recordId : string;
};

type TopicRecord = {
  record : any;
  name : string;
};

type DeployKeyEntry = NonNullable<SettingsData['deployKeys']>[string];
type AutolinkEntry = NonNullable<SettingsData['autolinks']>[string];
type InteractionLimitEntry = NonNullable<SettingsData['interactionLimit']>;
type IssueTypeEntry = NonNullable<SettingsData['issueTypes']>[string];
type RuleSuiteEntry = NonNullable<SettingsData['ruleSuites']>[string];
type RulesetEntry = NonNullable<SettingsData['rulesets']>[string];
type CustomPropertyValue = NonNullable<SettingsData['customProperties']>[string];
type AttestationEntry = NonNullable<SettingsData['attestations']>[string];
export type CodeScanningAlertEntry = NonNullable<SettingsData['codeScanningAlerts']>[string];
type CodeScanningInstanceEntry = CodeScanningAlertEntry['mostRecentInstance'];
export type DependabotAlertEntry = NonNullable<SettingsData['dependabotAlerts']>[string];
export type SecretScanningAlertEntry = NonNullable<SettingsData['secretScanningAlerts']>[string];
type SecretScanningLocationEntry = NonNullable<SecretScanningAlertEntry['locations']>[number];
type SecretScanningScanEntry = NonNullable<NonNullable<SettingsData['secretScanningScanHistory']>['incrementalScans']>[number];
type SecretScanningBypassEntry = NonNullable<SettingsData['secretScanningPushProtectionBypasses']>[string];
export type SecurityAdvisoryEntry = NonNullable<SettingsData['securityAdvisories']>[string];

type RepoSettingsData = SettingsData;

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLES: CollaboratorRole[] = ['maintainer', 'contributor', 'triager', 'viewer'];
const COLLABORATOR_AFFILIATION_FILTERS = new Set<CollaboratorAffiliationFilter>([
  'outside',
  'direct',
  'all',
]);
const COLLABORATOR_PERMISSION_FILTERS = new Set<CollaboratorPermissionFilter>([
  'pull',
  'triage',
  'push',
  'maintain',
  'admin',
]);
const AUTOLINK_NUM_TOKEN = '<num>';
const INTERACTION_LIMITS = new Set(['existing_users', 'contributors_only', 'collaborators_only']);
const CODE_SCANNING_ALERT_STATES = new Set(['open', 'closed', 'dismissed', 'fixed']);
const CODE_SCANNING_UPDATE_STATES = new Set(['dismissed', 'open']);
const CODE_SCANNING_DISMISSAL_REASONS = new Set(['false positive', 'won\'t fix', 'used in tests']);
const CODE_SCANNING_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'warning', 'note', 'error']);
const CODE_SCANNING_SORTS = new Set(['created', 'updated']);
const DEPENDABOT_ALERT_STATES = new Set(['auto_dismissed', 'dismissed', 'fixed', 'open']);
const DEPENDABOT_ALERT_UPDATE_STATES = new Set(['dismissed', 'open']);
const DEPENDABOT_DISMISSAL_REASONS = new Set(['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk']);
const DEPENDABOT_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const DEPENDABOT_CLASSIFICATIONS = new Set(['malware', 'general']);
const DEPENDABOT_SCOPES = new Set(['development', 'runtime']);
const DEPENDABOT_SORTS = new Set(['created', 'updated', 'epss_percentage']);
const SECRET_SCANNING_STATES = new Set(['open', 'resolved']);
const SECRET_SCANNING_RESOLUTIONS = new Set(['false_positive', 'wont_fix', 'revoked', 'pattern_edited', 'pattern_deleted', 'used_in_tests']);
const SECRET_SCANNING_UPDATE_RESOLUTIONS = new Set(['false_positive', 'wont_fix', 'revoked', 'used_in_tests']);
const SECRET_SCANNING_VALIDITIES = new Set(['active', 'inactive', 'unknown']);
const SECRET_SCANNING_UPDATE_VALIDITIES = new Set(['active', 'inactive']);
const SECRET_SCANNING_SORTS = new Set(['created', 'updated']);
const SECRET_SCANNING_BYPASS_REASONS = new Set(['false_positive', 'used_in_tests', 'will_fix_later']);
const SECURITY_ADVISORY_STATES = new Set(['triage', 'draft', 'published', 'closed']);
const SECURITY_ADVISORY_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'unknown']);
const SECURITY_ADVISORY_SORTS = new Set(['created', 'updated', 'published']);
const RULE_SUITE_EVALUATE_STATUSES = new Set(['all', 'active', 'evaluate']);
const RULE_SUITE_RESULTS = new Set(['pass', 'fail', 'bypass', 'all']);
const RULE_SUITE_TIME_PERIOD_MS: Record<string, number> = {
  hour  : 60 * 60 * 1000,
  day   : 24 * 60 * 60 * 1000,
  week  : 7 * 24 * 60 * 60 * 1000,
  month : 30 * 24 * 60 * 60 * 1000,
};
const RULESET_TARGETS = new Set(['branch', 'tag', 'push']);
const RULESET_ENFORCEMENTS = new Set(['disabled', 'active', 'evaluate']);
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_ISSUE_TYPE_TEMPLATES = [
  { name: 'Bug', description: 'An unexpected problem or behavior' },
  { name: 'Task', description: 'A specific piece of work' },
  { name: 'Feature', description: 'A request for new functionality' },
] as const;
const INTERACTION_EXPIRY_DAYS: Record<string, number> = {
  one_day    : 1,
  three_days : 3,
  one_week   : 7,
  one_month  : 30,
  six_months : 180,
};

const ROLE_RANK: Record<CollaboratorRole, number> = {
  maintainer  : 3,
  contributor : 2,
  triager     : 1,
  viewer      : 0,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTopicName(name: unknown): string | null {
  if (typeof name !== 'string') {
    return null;
  }
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized.length > 50) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function roleFromPermission(permission: unknown): CollaboratorRole | null {
  const value = typeof permission === 'string' ? permission.toLowerCase() : 'push';
  if (value === 'admin' || value === 'maintain') {
    return 'maintainer';
  }
  if (value === 'push' || value === 'write') {
    return 'contributor';
  }
  if (value === 'triage') {
    return 'triager';
  }
  if (value === 'pull') {
    return 'viewer';
  }
  return null;
}

function permissionFromRole(role: CollaboratorRole): string {
  if (role === 'maintainer') {
    return 'admin';
  }
  if (role === 'contributor') {
    return 'write';
  }
  if (role === 'viewer') {
    return 'pull';
  }
  return 'triage';
}

function buildPermissions(role: CollaboratorRole): Record<string, boolean> {
  return {
    admin    : role === 'maintainer',
    maintain : role === 'maintainer',
    push     : role === 'maintainer' || role === 'contributor',
    triage   : role === 'maintainer' || role === 'contributor' || role === 'triager',
    pull     : true,
  };
}

function collaboratorAffiliationFilter(value: string | null): CollaboratorAffiliationFilter | null {
  if (!value) {
    return 'all';
  }
  const normalized = value.toLowerCase();
  return COLLABORATOR_AFFILIATION_FILTERS.has(normalized as CollaboratorAffiliationFilter)
    ? normalized as CollaboratorAffiliationFilter
    : null;
}

function collaboratorPermissionFilter(value: string | null): CollaboratorPermissionFilter | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  return COLLABORATOR_PERMISSION_FILTERS.has(normalized as CollaboratorPermissionFilter)
    ? normalized as CollaboratorPermissionFilter
    : null;
}

function collaboratorHasPermission(collab: CollaboratorInfo, permission: CollaboratorPermissionFilter): boolean {
  return buildPermissions(collab.role)[permission] === true;
}

function collaboratorMatchesAffiliation(
  collab: CollaboratorInfo, targetDid: string, affiliation: CollaboratorAffiliationFilter,
): boolean {
  if (affiliation === 'outside') {
    return collab.did !== targetDid;
  }
  return true;
}

function buildCollaboratorUser(collab: CollaboratorInfo, baseUrl: string): Record<string, unknown> {
  const user = buildOwner(collab.did, baseUrl);
  return {
    ...user,
    node_id             : collab.recordId,
    gravatar_id         : '',
    followers_url       : `${baseUrl}/users/${collab.did}/followers`,
    following_url       : `${baseUrl}/users/${collab.did}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${collab.did}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${collab.did}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${collab.did}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${collab.did}/orgs`,
    repos_url           : `${baseUrl}/users/${collab.did}/repos`,
    events_url          : `${baseUrl}/users/${collab.did}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${collab.did}/received_events`,
    site_admin          : false,
    ...(collab.alias ? { name: collab.alias } : {}),
  };
}

function buildCollaboratorResponse(collab: CollaboratorInfo, baseUrl: string): Record<string, unknown> {
  return {
    ...buildCollaboratorUser(collab, baseUrl),
    permissions : buildPermissions(collab.role),
    role_name   : collab.role,
  };
}

function buildPermissionResponse(collab: CollaboratorInfo, baseUrl: string): Record<string, unknown> {
  return {
    permission : permissionFromRole(collab.role),
    role_name  : collab.role,
    user       : buildCollaboratorUser(collab, baseUrl),
  };
}

function defaultIssueTypesForRepo(repo: RepoInfo): IssueTypeEntry[] {
  const createdAt = toISODate(repo.dateCreated);
  const updatedAt = toISODate(repo.timestamp);
  return DEFAULT_ISSUE_TYPE_TEMPLATES.map(template => ({
    id          : numericId(`issue-type:${template.name.toLowerCase()}`) || 1,
    name        : template.name,
    description : template.description,
    createdAt,
    updatedAt,
  }));
}

function issueTypeEntries(settings: RepoSettingsData, repo: RepoInfo): IssueTypeEntry[] {
  if (settings.issueTypes !== undefined) {
    return Object.values(settings.issueTypes)
      .filter(entry => entry.isEnabled !== false)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }
  return defaultIssueTypesForRepo(repo);
}

function buildIssueTypeResponse(entry: IssueTypeEntry): Record<string, unknown> {
  return {
    id          : entry.id,
    node_id     : `IT_${entry.id}`,
    name        : entry.name,
    description : entry.description ?? null,
    created_at  : entry.createdAt,
    updated_at  : entry.updatedAt,
  };
}

async function listTopicRecords(ctx: AgentContext, targetDid: string, repo: RepoInfo): Promise<TopicRecord[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo/topic' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const topics: TopicRecord[] = [];
  for (const record of records) {
    const tags = (record.tags as Record<string, string> | undefined) ?? {};
    let data: Record<string, unknown> = {};
    try {
      data = await record.data.json();
    } catch {
      data = {};
    }
    const name = normalizeTopicName(data.name ?? tags.name);
    if (name) {
      topics.push({ record, name });
    }
  }

  topics.sort((a, b) => a.name.localeCompare(b.name));
  return topics;
}

export async function listTopicNames(ctx: AgentContext, targetDid: string, repo: RepoInfo): Promise<string[]> {
  const topics = await listTopicRecords(ctx, targetDid, repo);
  return [...new Set(topics.map((topic) => topic.name))];
}

async function listCollaborators(ctx: AgentContext, targetDid: string, repo: RepoInfo): Promise<CollaboratorInfo[]> {
  const from = fromOpt(ctx, targetDid);
  const bestByDid = new Map<string, CollaboratorInfo>();

  for (const role of ROLES) {
    const { records } = await ctx.repo.records.query(`repo/${role}` as any, {
      from,
      filter: { contextId: repo.contextId },
    });

    for (const record of records) {
      const tags = (record.tags as Record<string, string> | undefined) ?? {};
      let data: Record<string, unknown> = {};
      try {
        data = await record.data.json();
      } catch {
        data = {};
      }

      const did = typeof data.did === 'string' ? data.did : tags.did;
      if (!did) {
        continue;
      }

      const collab: CollaboratorInfo = {
        did,
        alias    : typeof data.alias === 'string' ? data.alias : '',
        role,
        recordId : record.id ?? `${did}:${role}`,
      };

      const existing = bestByDid.get(did);
      if (!existing || ROLE_RANK[collab.role] > ROLE_RANK[existing.role]) {
        bestByDid.set(did, collab);
      }
    }
  }

  return [...bestByDid.values()].sort((a, b) => a.did.localeCompare(b.did));
}

async function findCollaborator(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, did: string,
): Promise<CollaboratorInfo | null> {
  const collaborators = await listCollaborators(ctx, targetDid, repo);
  return collaborators.find((collab) => collab.did === did) ?? null;
}

async function deleteCollaboratorRoles(
  ctx: AgentContext, repo: RepoInfo, did: string, preserveRecordId?: string,
): Promise<number> {
  let deleted = 0;
  for (const role of ROLES) {
    const { records } = await ctx.repo.records.query(`repo/${role}` as any, {
      filter: { contextId: repo.contextId, tags: { did } },
    });
    for (const record of records) {
      if (preserveRecordId && record.id === preserveRecordId) {
        continue;
      }
      const { status } = await record.delete();
      if (status.code < 300) {
        deleted++;
      }
    }
  }
  return deleted;
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

function deployKeyEntries(settings: RepoSettingsData): DeployKeyEntry[] {
  return Object.values(settings.deployKeys ?? {})
    .filter((entry): entry is DeployKeyEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function deployKeyRecordKey(id: number): string {
  return String(id);
}

function nextDeployKeyId(settings: RepoSettingsData): number {
  return deployKeyEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function settingsWithDeployKey(
  settings: RepoSettingsData, key: string, deployKey: DeployKeyEntry | null,
): RepoSettingsData {
  const deployKeys = { ...(settings.deployKeys ?? {}) };
  if (deployKey) {
    deployKeys[key] = deployKey;
  } else {
    delete deployKeys[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(deployKeys).length > 0) {
    next.deployKeys = deployKeys;
  } else {
    delete next.deployKeys;
  }
  return next;
}

function autolinkEntries(settings: RepoSettingsData): AutolinkEntry[] {
  return Object.values(settings.autolinks ?? {})
    .filter((entry): entry is AutolinkEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function autolinkRecordKey(id: number): string {
  return String(id);
}

function nextAutolinkId(settings: RepoSettingsData): number {
  return autolinkEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function settingsWithAutolink(
  settings: RepoSettingsData, key: string, autolink: AutolinkEntry | null,
): RepoSettingsData {
  const autolinks = { ...(settings.autolinks ?? {}) };
  if (autolink) {
    autolinks[key] = autolink;
  } else {
    delete autolinks[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(autolinks).length > 0) {
    next.autolinks = autolinks;
  } else {
    delete next.autolinks;
  }
  return next;
}

function buildAutolinkResponse(autolink: AutolinkEntry): Record<string, unknown> {
  return {
    id              : autolink.id,
    key_prefix      : autolink.keyPrefix,
    url_template    : autolink.urlTemplate,
    is_alphanumeric : autolink.isAlphanumeric,
  };
}

function validateAutolinkBody(body: Record<string, unknown>): AutolinkEntry | JsonResponse {
  const keyPrefix = typeof body.key_prefix === 'string' ? body.key_prefix.trim() : '';
  if (!keyPrefix) {
    return jsonValidationError('Validation Failed: key_prefix is required.');
  }

  const urlTemplate = typeof body.url_template === 'string' ? body.url_template.trim() : '';
  if (!urlTemplate) {
    return jsonValidationError('Validation Failed: url_template is required.');
  }
  if (!urlTemplate.includes(AUTOLINK_NUM_TOKEN)) {
    return jsonValidationError('Validation Failed: url_template must contain <num>.');
  }
  try {
    const parsed = new URL(urlTemplate.replaceAll(AUTOLINK_NUM_TOKEN, '1'));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonValidationError('Validation Failed: url_template must use http or https.');
    }
  } catch {
    return jsonValidationError('Validation Failed: url_template must be a valid URL.');
  }

  if (body.is_alphanumeric !== undefined && typeof body.is_alphanumeric !== 'boolean') {
    return jsonValidationError('Validation Failed: is_alphanumeric must be a boolean.');
  }

  return {
    id             : 0,
    keyPrefix,
    urlTemplate,
    isAlphanumeric : body.is_alphanumeric !== false,
  };
}

async function findAutolink(
  ctx: AgentContext, targetDid: string, repoName: string, autolinkId: string,
): Promise<{ lookup: RepoSettingsLookup; autolink: AutolinkEntry; key: string } | JsonResponse> {
  const id = parseInt(autolinkId, 10);
  if (!Number.isInteger(id) || id < 1) {
    return jsonNotFound(`Autolink '${autolinkId}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  for (const [key, autolink] of Object.entries(lookup.settings.autolinks ?? {})) {
    if (autolink.id === id) {
      return { lookup, autolink, key };
    }
  }
  return jsonNotFound(`Autolink '${autolinkId}' not found.`);
}

function activeInteractionLimit(settings: RepoSettingsData): InteractionLimitEntry | null {
  const entry = settings.interactionLimit;
  if (!entry) {
    return null;
  }
  if (Date.parse(entry.expiresAt) <= Date.now()) {
    return null;
  }
  return entry;
}

function buildInteractionLimitResponse(entry: InteractionLimitEntry): Record<string, unknown> {
  return {
    limit      : entry.limit,
    origin     : 'repository',
    expires_at : toISODate(entry.expiresAt),
  };
}

function validateInteractionLimitBody(body: Record<string, unknown>): InteractionLimitEntry | JsonResponse {
  if (typeof body.limit !== 'string' || !INTERACTION_LIMITS.has(body.limit)) {
    return jsonValidationError('Validation Failed: limit must be existing_users, contributors_only, or collaborators_only.');
  }

  const expiry = typeof body.expiry === 'string' ? body.expiry : 'one_day';
  const days = INTERACTION_EXPIRY_DAYS[expiry];
  if (!days) {
    return jsonValidationError('Validation Failed: expiry must be one_day, three_days, one_week, one_month, or six_months.');
  }

  const expiresAt = new Date(Date.now() + (days * 24 * 60 * 60 * 1000)).toISOString();
  return {
    limit: body.limit as InteractionLimitEntry['limit'],
    expiresAt,
  };
}

function rulesetEntries(settings: RepoSettingsData): RulesetEntry[] {
  return Object.values(settings.rulesets ?? {})
    .filter((entry): entry is RulesetEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function rulesetRecordKey(id: number): string {
  return String(id);
}

function nextRulesetId(settings: RepoSettingsData): number {
  return rulesetEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function settingsWithRuleset(
  settings: RepoSettingsData, key: string, ruleset: RulesetEntry | null,
): RepoSettingsData {
  const rulesets = { ...(settings.rulesets ?? {}) };
  if (ruleset) {
    rulesets[key] = ruleset;
  } else {
    delete rulesets[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(rulesets).length > 0) {
    next.rulesets = rulesets;
  } else {
    delete next.rulesets;
  }
  return next;
}

function rulesetSource(targetDid: string, repoName: string): string {
  return `${targetDid}/${repoName}`;
}

function buildRulesetNodeId(targetDid: string, repoName: string, rulesetId: number): string {
  return `RRS_${numericId(`${targetDid}:${repoName}:${rulesetId}`).toString(36)}`;
}

function buildRulesetLinks(
  ruleset: RepositoryRulesetStateData, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const base = `${baseUrl}/repos/${targetDid}/${repoName}`;
  return {
    self : { href: `${base}/rulesets/${ruleset.id}` },
    html : { href: `${base}/rules/${ruleset.id}` },
  };
}

function copyRulesetState(ruleset: RepositoryRulesetStateData): RepositoryRulesetStateData {
  return {
    id          : ruleset.id,
    name        : ruleset.name,
    target      : ruleset.target,
    enforcement : ruleset.enforcement,
    ...(ruleset.bypassActors ? { bypassActors: ruleset.bypassActors.map(actor => ({ ...actor })) } : {}),
    ...(ruleset.conditions ? { conditions: { ...ruleset.conditions } } : {}),
    rules       : ruleset.rules.map(rule => ({ ...rule })),
    versionId   : ruleset.versionId,
    createdAt   : ruleset.createdAt,
    updatedAt   : ruleset.updatedAt,
  };
}

function buildRulesetSummaryResponse(
  ruleset: RulesetEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    id          : ruleset.id,
    name        : ruleset.name,
    target      : ruleset.target,
    source_type : 'Repository',
    source      : rulesetSource(targetDid, repoName),
    enforcement : ruleset.enforcement,
    node_id     : buildRulesetNodeId(targetDid, repoName, ruleset.id),
    _links      : buildRulesetLinks(ruleset, targetDid, repoName, baseUrl),
    created_at  : toISODate(ruleset.createdAt),
    updated_at  : toISODate(ruleset.updatedAt),
  };
}

function buildRulesetResponse(
  ruleset: RepositoryRulesetStateData, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    ...buildRulesetSummaryResponse(ruleset as RulesetEntry, targetDid, repoName, baseUrl),
    bypass_actors : ruleset.bypassActors ?? [],
    conditions    : ruleset.conditions ?? {},
    rules         : ruleset.rules,
  };
}

function buildRulesetHistoryEntry(entry: NonNullable<RepositoryRulesetData['history']>[string]): Record<string, unknown> {
  return {
    version_id : entry.versionId,
    actor      : {
      id   : numericId(entry.actorDid),
      type : 'User',
    },
    updated_at: toISODate(entry.updatedAt),
  };
}

function validateRulesetRules(rules: unknown): Array<Record<string, unknown> & { type: string }> | JsonResponse {
  if (!Array.isArray(rules)) {
    return jsonValidationError('Validation Failed: rules must be an array.');
  }

  const parsed: Array<Record<string, unknown> & { type: string }> = [];
  for (const rule of rules) {
    if (!isPlainObject(rule) || typeof rule.type !== 'string' || rule.type.trim().length === 0) {
      return jsonValidationError('Validation Failed: each rule must be an object with a type.');
    }
    parsed.push({ ...rule, type: rule.type.trim() });
  }
  return parsed;
}

function validateRulesetBody(
  body: Record<string, unknown>, existing?: RulesetEntry,
): Partial<RulesetEntry> | JsonResponse {
  const parsed: Partial<RulesetEntry> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return jsonValidationError('Validation Failed: name is required.');
    }
    parsed.name = body.name.trim();
  } else if (!existing) {
    return jsonValidationError('Validation Failed: name is required.');
  }

  const target = body.target ?? (existing ? undefined : 'branch');
  if (target !== undefined) {
    if (typeof target !== 'string' || !RULESET_TARGETS.has(target)) {
      return jsonValidationError('Validation Failed: target must be branch, tag, or push.');
    }
    parsed.target = target as RulesetEntry['target'];
  }

  if (body.enforcement !== undefined) {
    if (typeof body.enforcement !== 'string' || !RULESET_ENFORCEMENTS.has(body.enforcement)) {
      return jsonValidationError('Validation Failed: enforcement must be disabled, active, or evaluate.');
    }
    parsed.enforcement = body.enforcement as RulesetEntry['enforcement'];
  } else if (!existing) {
    return jsonValidationError('Validation Failed: enforcement is required.');
  }

  if (body.bypass_actors !== undefined) {
    if (!Array.isArray(body.bypass_actors) || !body.bypass_actors.every(isPlainObject)) {
      return jsonValidationError('Validation Failed: bypass_actors must be an array of objects.');
    }
    parsed.bypassActors = body.bypass_actors.map(actor => ({ ...actor }));
  }

  if (body.conditions !== undefined) {
    if (!isPlainObject(body.conditions)) {
      return jsonValidationError('Validation Failed: conditions must be an object.');
    }
    parsed.conditions = { ...body.conditions };
  }

  if (body.rules !== undefined) {
    const rules = validateRulesetRules(body.rules);
    if ('status' in rules) { return rules; }
    parsed.rules = rules;
  } else if (!existing) {
    parsed.rules = [];
  }

  return parsed;
}

function customPropertyEntries(settings: RepoSettingsData): Array<{ property_name: string; value: CustomPropertyValue }> {
  return Object.entries(settings.customProperties ?? {})
    .filter((entry): entry is [string, CustomPropertyValue] => typeof entry[0] === 'string')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([propertyName, value]) => ({
      property_name: propertyName,
      value,
    }));
}

function validateCustomPropertiesBody(body: Record<string, unknown>): { values: Record<string, CustomPropertyValue | null> } | JsonResponse {
  if (!Array.isArray(body.properties)) {
    return jsonValidationError('Validation Failed: properties must be an array.');
  }

  const parsed: Record<string, CustomPropertyValue | null> = {};
  for (const property of body.properties) {
    if (!isPlainObject(property)) {
      return jsonValidationError('Validation Failed: each property must be an object.');
    }

    const propertyName = typeof property.property_name === 'string' ? property.property_name.trim() : '';
    if (!propertyName) {
      return jsonValidationError('Validation Failed: property_name is required.');
    }

    if (!Object.prototype.hasOwnProperty.call(property, 'value')) {
      return jsonValidationError('Validation Failed: value is required.');
    }

    if (property.value === null) {
      parsed[propertyName] = null;
    } else if (typeof property.value === 'string') {
      parsed[propertyName] = property.value;
    } else if (Array.isArray(property.value) && property.value.every(item => typeof item === 'string')) {
      parsed[propertyName] = [...property.value];
    } else {
      return jsonValidationError('Validation Failed: value must be null, a string, or an array of strings.');
    }
  }
  return { values: parsed };
}

function validateRepositoryDispatchBody(body: Record<string, unknown>): JsonResponse | undefined {
  if (typeof body.event_type !== 'string' || body.event_type.trim().length === 0 || body.event_type.length > 100) {
    return jsonValidationError('Validation Failed: event_type is required and must be 100 characters or fewer.');
  }

  if (body.client_payload === undefined) {
    return undefined;
  }

  if (!isPlainObject(body.client_payload)) {
    return jsonValidationError('Validation Failed: client_payload must be an object.');
  }
  if (Object.keys(body.client_payload).length > 10) {
    return jsonValidationError('Validation Failed: client_payload can contain at most 10 top-level properties.');
  }
  if (new TextEncoder().encode(JSON.stringify(body.client_payload)).length >= 64 * 1024) {
    return jsonValidationError('Validation Failed: client_payload must be less than 64KB.');
  }

  return undefined;
}

export function dependabotAlertEntries(settings: RepoSettingsData): DependabotAlertEntry[] {
  return Object.values(settings.dependabotAlerts ?? {})
    .filter((entry): entry is DependabotAlertEntry => (
      Boolean(entry)
      && Number.isInteger(entry.number)
      && DEPENDABOT_ALERT_STATES.has(entry.state)
    ))
    .sort((a, b) => a.number - b.number);
}

function csvQueryValues(url: URL, name: string): string[] {
  return url.searchParams.getAll(name)
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
}

function invalidCsvValues(values: string[], allowed: Set<string>): string[] {
  return values.filter(value => !allowed.has(value));
}

export function codeScanningAlertEntries(settings: RepoSettingsData): CodeScanningAlertEntry[] {
  return Object.values(settings.codeScanningAlerts ?? {})
    .filter((entry): entry is CodeScanningAlertEntry => (
      Boolean(entry)
      && Number.isInteger(entry.number)
      && CODE_SCANNING_ALERT_STATES.has(entry.state)
      && typeof entry.rule?.id === 'string'
      && typeof entry.tool?.name === 'string'
    ))
    .sort((a, b) => a.number - b.number);
}

function codeScanningAlertInstances(alert: CodeScanningAlertEntry): CodeScanningInstanceEntry[] {
  const instances = alert.instances && alert.instances.length > 0 ? alert.instances : [alert.mostRecentInstance];
  return instances.filter((instance): instance is CodeScanningInstanceEntry => (
    Boolean(instance)
    && typeof instance.ref === 'string'
    && typeof instance.analysisKey === 'string'
    && typeof instance.commitSha === 'string'
  ));
}

function codeScanningSeverity(alert: CodeScanningAlertEntry): string {
  if (typeof alert.rule.security_severity_level === 'string') {
    return alert.rule.security_severity_level;
  }
  return typeof alert.rule.severity === 'string' ? alert.rule.severity : '';
}

function codeScanningRefMatches(instanceRef: string, queryRef: string): boolean {
  if (instanceRef === queryRef) {
    return true;
  }
  if (queryRef.startsWith('refs/')) {
    return false;
  }
  return instanceRef === `refs/heads/${queryRef}` || instanceRef === `refs/tags/${queryRef}`;
}

function codeScanningAlertMatchesRef(alert: CodeScanningAlertEntry, ref: string): boolean {
  return codeScanningAlertInstances(alert).some(instance => codeScanningRefMatches(instance.ref, ref));
}

function codeScanningAlertMatchesPullRequest(alert: CodeScanningAlertEntry, pr: number): boolean {
  return codeScanningAlertInstances(alert).some(instance => instance.ref === `refs/pull/${pr}/merge`);
}

function codeScanningAssigneesMatch(assigned: string[], assignees: string[]): boolean {
  if (assignees.length === 0) { return true; }
  if (assignees.includes('*')) { return assigned.length > 0; }
  if (assignees.includes('none')) { return assigned.length === 0; }
  return assignees.some(assignee => assigned.includes(assignee));
}

function parseCodeScanningPullRequest(url: URL): number | null | JsonResponse {
  const pr = url.searchParams.get('pr');
  if (pr === null) { return null; }
  const number = parseInt(pr, 10);
  if (!Number.isInteger(number) || number < 1) {
    return jsonValidationError('Validation Failed: pr must be a positive integer.');
  }
  return number;
}

export function filterCodeScanningAlerts(alerts: CodeScanningAlertEntry[], url: URL): CodeScanningAlertEntry[] | JsonResponse {
  const toolName = url.searchParams.get('tool_name');
  const toolGuid = url.searchParams.get('tool_guid');
  if (toolName && toolGuid) {
    return jsonValidationError('Validation Failed: tool_name and tool_guid cannot both be specified.');
  }

  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const sort = url.searchParams.get('sort') ?? 'created';
  if (!CODE_SCANNING_SORTS.has(sort)) {
    return jsonValidationError('Validation Failed: sort must be created or updated.');
  }

  const state = csvQueryValues(url, 'state');
  const invalidState = invalidCsvValues(state, CODE_SCANNING_ALERT_STATES);
  if (invalidState.length > 0) {
    return jsonValidationError('Validation Failed: state must be open, closed, dismissed, or fixed.');
  }

  const severity = csvQueryValues(url, 'severity');
  const invalidSeverity = invalidCsvValues(severity, CODE_SCANNING_SEVERITIES);
  if (invalidSeverity.length > 0) {
    return jsonValidationError('Validation Failed: severity must be critical, high, medium, low, warning, note, or error.');
  }

  const pr = parseCodeScanningPullRequest(url);
  if (pr && typeof pr !== 'number') { return pr; }

  const ref = url.searchParams.get('ref');
  const assignees = csvQueryValues(url, 'assignees');
  const filtered = alerts
    .filter(alert => !toolName || alert.tool.name === toolName)
    .filter(alert => !toolGuid || alert.tool.guid === toolGuid)
    .filter(alert => !ref || codeScanningAlertMatchesRef(alert, ref))
    .filter(alert => pr === null || codeScanningAlertMatchesPullRequest(alert, pr))
    .filter(alert => state.length === 0 || state.includes(alert.state))
    .filter(alert => severity.length === 0 || severity.includes(codeScanningSeverity(alert)))
    .filter(alert => codeScanningAssigneesMatch(alert.assignees ?? [], assignees));

  return filtered.sort((a, b) => {
    const left = Date.parse(sort === 'updated' ? a.updatedAt : a.createdAt);
    const right = Date.parse(sort === 'updated' ? b.updatedAt : b.createdAt);
    const comparison = left - right || a.number - b.number;
    return direction === 'asc' ? comparison : -comparison;
  });
}

function filterCodeScanningInstances(alert: CodeScanningAlertEntry, url: URL): CodeScanningInstanceEntry[] | JsonResponse {
  const pr = parseCodeScanningPullRequest(url);
  if (pr && typeof pr !== 'number') { return pr; }

  const ref = url.searchParams.get('ref');
  return codeScanningAlertInstances(alert)
    .filter(instance => !ref || codeScanningRefMatches(instance.ref, ref))
    .filter(instance => pr === null || instance.ref === `refs/pull/${pr}/merge`);
}

function buildCodeScanningInstanceResponse(instance: CodeScanningInstanceEntry): Record<string, unknown> {
  return {
    ref             : instance.ref,
    analysis_key    : instance.analysisKey,
    environment     : instance.environment ?? '',
    category        : instance.category,
    state           : instance.state,
    commit_sha      : instance.commitSha,
    message         : instance.message ?? null,
    location        : instance.location ?? null,
    classifications : instance.classifications ?? [],
  };
}

export function buildCodeScanningAlertResponse(
  alert: CodeScanningAlertEntry, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const repoBase = `${baseUrl}/repos/${targetDid}/${repo.name}`;
  return {
    number               : alert.number,
    created_at           : toISODate(alert.createdAt),
    url                  : `${repoBase}/code-scanning/alerts/${alert.number}`,
    html_url             : `${repoBase}/code-scanning/${alert.number}`,
    state                : alert.state,
    fixed_at             : alert.fixedAt ? toISODate(alert.fixedAt) : null,
    dismissed_by         : alert.dismissedBy ? buildOwner(alert.dismissedBy, baseUrl) : null,
    dismissed_at         : alert.dismissedAt ? toISODate(alert.dismissedAt) : null,
    dismissed_reason     : alert.dismissedReason ?? null,
    dismissed_comment    : alert.dismissedComment ?? null,
    rule                 : { ...alert.rule },
    tool                 : { ...alert.tool },
    most_recent_instance : buildCodeScanningInstanceResponse(alert.mostRecentInstance),
    instances_url        : `${repoBase}/code-scanning/alerts/${alert.number}/instances`,
    assignees            : (alert.assignees ?? []).map(assignee => buildOwner(assignee, baseUrl)),
  };
}

async function findCodeScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string,
): Promise<{ lookup: RepoSettingsLookup; alert: CodeScanningAlertEntry; key: string } | JsonResponse> {
  const number = parseInt(alertNumber, 10);
  if (!Number.isInteger(number) || number < 1) {
    return jsonNotFound(`Code scanning alert '${alertNumber}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = String(number);
  const alert = lookup.settings.codeScanningAlerts?.[key]
    ?? codeScanningAlertEntries(lookup.settings).find(entry => entry.number === number);
  if (!alert) {
    return jsonNotFound(`Code scanning alert '${alertNumber}' not found.`);
  }

  return { lookup, alert, key: String(alert.number) };
}

function updatedCodeScanningInstances(
  alert: CodeScanningAlertEntry, state: CodeScanningAlertEntry['state'],
): CodeScanningInstanceEntry[] | undefined {
  if (!alert.instances) { return undefined; }
  return alert.instances.map((instance) => (
    instance.ref === alert.mostRecentInstance.ref && instance.commitSha === alert.mostRecentInstance.commitSha
      ? { ...instance, state }
      : instance
  ));
}

function validateCodeScanningAlertUpdate(
  body: Record<string, unknown>, existing: CodeScanningAlertEntry, actorDid: string,
): CodeScanningAlertEntry | JsonResponse {
  const hasState = Object.prototype.hasOwnProperty.call(body, 'state');
  const hasAssignees = Object.prototype.hasOwnProperty.call(body, 'assignees');
  if (!hasState && !hasAssignees) {
    return jsonValidationError('Validation Failed: state or assignees is required.');
  }

  let updated: CodeScanningAlertEntry = { ...existing, updatedAt: new Date().toISOString() };

  if (hasAssignees) {
    if (!Array.isArray(body.assignees) || !body.assignees.every(assignee => typeof assignee === 'string')) {
      return jsonValidationError('Validation Failed: assignees must be an array of strings.');
    }
    updated = { ...updated, assignees: [...new Set(body.assignees)] };
  }

  if (body.create_request !== undefined && typeof body.create_request !== 'boolean') {
    return jsonValidationError('Validation Failed: create_request must be a boolean.');
  }

  if (!hasState) {
    return updated;
  }

  if (typeof body.state !== 'string' || !CODE_SCANNING_UPDATE_STATES.has(body.state)) {
    return jsonValidationError('Validation Failed: state must be open or dismissed.');
  }

  if (body.state === 'open') {
    return {
      ...updated,
      state              : 'open',
      mostRecentInstance : { ...updated.mostRecentInstance, state: 'open' },
      instances          : updatedCodeScanningInstances(updated, 'open'),
      dismissedAt        : null,
      dismissedBy        : null,
      dismissedReason    : null,
      dismissedComment   : null,
    };
  }

  if (typeof body.dismissed_reason !== 'string' || !CODE_SCANNING_DISMISSAL_REASONS.has(body.dismissed_reason)) {
    return jsonValidationError('Validation Failed: dismissed_reason must be false positive, won\'t fix, or used in tests.');
  }
  if (body.dismissed_comment !== undefined && body.dismissed_comment !== null && typeof body.dismissed_comment !== 'string') {
    return jsonValidationError('Validation Failed: dismissed_comment must be a string.');
  }

  return {
    ...updated,
    state              : 'dismissed',
    mostRecentInstance : { ...updated.mostRecentInstance, state: 'dismissed' },
    instances          : updatedCodeScanningInstances(updated, 'dismissed'),
    dismissedAt        : updated.updatedAt,
    dismissedBy        : actorDid,
    dismissedReason    : body.dismissed_reason as CodeScanningAlertData['dismissedReason'],
    dismissedComment   : typeof body.dismissed_comment === 'string' ? body.dismissed_comment : null,
  };
}

function settingsWithCodeScanningAlert(
  settings: RepoSettingsData, key: string, alert: CodeScanningAlertEntry,
): RepoSettingsData {
  return {
    ...settings,
    codeScanningAlerts: {
      ...(settings.codeScanningAlerts ?? {}),
      [key]: alert,
    },
  };
}

function dependabotAlertSeverity(alert: DependabotAlertEntry): string {
  const vulnerability = alert.securityVulnerability;
  if (isPlainObject(vulnerability) && typeof vulnerability.severity === 'string') {
    return vulnerability.severity;
  }
  return typeof alert.securityAdvisory.severity === 'string' ? alert.securityAdvisory.severity : '';
}

function dependabotAlertClassification(alert: DependabotAlertEntry): string {
  return typeof alert.securityAdvisory.classification === 'string' ? alert.securityAdvisory.classification : 'general';
}

function dependabotAlertEpssPercentage(alert: DependabotAlertEntry): number {
  const epss = isPlainObject(alert.securityAdvisory.epss) ? alert.securityAdvisory.epss : null;
  return typeof epss?.percentage === 'number' ? epss.percentage : 0;
}

function parseDependabotEpssThreshold(value: string): number | null {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : null;
}

function dependabotEpssFilterMatches(percentage: number, filter: string): boolean | null {
  const rangeMatch = filter.match(/^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const start = parseDependabotEpssThreshold(rangeMatch[1]);
    const end = parseDependabotEpssThreshold(rangeMatch[2]);
    if (start === null || end === null || start > end) { return null; }
    return percentage >= start && percentage <= end;
  }

  const comparatorMatch = filter.match(/^(>=|<=|>|<)?(\d+(?:\.\d+)?)$/);
  if (!comparatorMatch) { return null; }
  const threshold = parseDependabotEpssThreshold(comparatorMatch[2]);
  if (threshold === null) { return null; }

  switch (comparatorMatch[1]) {
    case '>': return percentage > threshold;
    case '>=': return percentage >= threshold;
    case '<': return percentage < threshold;
    case '<=': return percentage <= threshold;
    default: return percentage === threshold;
  }
}

function dependabotAlertHasPatch(alert: DependabotAlertEntry): boolean {
  const vulnerability = alert.securityVulnerability;
  if (!isPlainObject(vulnerability)) {
    return false;
  }
  const firstPatched = vulnerability.first_patched_version;
  return isPlainObject(firstPatched) && typeof firstPatched.identifier === 'string' && firstPatched.identifier.length > 0;
}

export function filterDependabotAlerts(alerts: DependabotAlertEntry[], url: URL): DependabotAlertEntry[] | JsonResponse {
  const classification = csvQueryValues(url, 'classification');
  const invalidClassification = invalidCsvValues(classification, DEPENDABOT_CLASSIFICATIONS);
  if (invalidClassification.length > 0) {
    return jsonValidationError('Validation Failed: classification must be malware or general.');
  }

  const state = csvQueryValues(url, 'state');
  const invalidState = invalidCsvValues(state, DEPENDABOT_ALERT_STATES);
  if (invalidState.length > 0) {
    return jsonValidationError('Validation Failed: state must be auto_dismissed, dismissed, fixed, or open.');
  }

  const severity = csvQueryValues(url, 'severity');
  const invalidSeverity = invalidCsvValues(severity, DEPENDABOT_SEVERITIES);
  if (invalidSeverity.length > 0) {
    return jsonValidationError('Validation Failed: severity must be low, medium, high, or critical.');
  }

  const scope = csvQueryValues(url, 'scope');
  const invalidScope = invalidCsvValues(scope, DEPENDABOT_SCOPES);
  if (invalidScope.length > 0) {
    return jsonValidationError('Validation Failed: scope must be development or runtime.');
  }

  const has = csvQueryValues(url, 'has');
  if (has.some(value => value !== 'patch')) {
    return jsonValidationError('Validation Failed: has only supports patch.');
  }

  const epssPercentage = csvQueryValues(url, 'epss_percentage');
  if (epssPercentage.some(value => dependabotEpssFilterMatches(0, value) === null)) {
    return jsonValidationError('Validation Failed: epss_percentage must be a number from 0.0 to 1.0, comparator, or range.');
  }

  const sort = url.searchParams.get('sort') ?? 'created';
  if (!DEPENDABOT_SORTS.has(sort)) {
    return jsonValidationError('Validation Failed: sort must be created, updated, or epss_percentage.');
  }

  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const ecosystems = csvQueryValues(url, 'ecosystem');
  const packages = csvQueryValues(url, 'package');
  const manifests = csvQueryValues(url, 'manifest');
  const assignees = csvQueryValues(url, 'assignee');

  const filtered = alerts
    .filter(alert => classification.length === 0 || classification.includes(dependabotAlertClassification(alert)))
    .filter(alert => state.length === 0 || state.includes(alert.state))
    .filter(alert => severity.length === 0 || severity.includes(dependabotAlertSeverity(alert)))
    .filter(alert => ecosystems.length === 0 || ecosystems.includes(alert.dependency.package.ecosystem))
    .filter(alert => packages.length === 0 || packages.includes(alert.dependency.package.name))
    .filter(alert => manifests.length === 0 || manifests.includes(alert.dependency.manifestPath))
    .filter(alert => scope.length === 0 || scope.includes(alert.dependency.scope ?? 'runtime'))
    .filter(alert => has.length === 0 || dependabotAlertHasPatch(alert))
    .filter(alert => (
      epssPercentage.length === 0
      || epssPercentage.some(value => dependabotEpssFilterMatches(dependabotAlertEpssPercentage(alert), value) === true)
    ))
    .filter((alert) => {
      if (assignees.length === 0) { return true; }
      const assigned = alert.assignees ?? [];
      if (assignees.includes('*')) { return assigned.length > 0; }
      if (assignees.includes('none')) { return assigned.length === 0; }
      return assignees.some(assignee => assigned.includes(assignee));
    });

  return filtered.sort((a, b) => {
    const left = sort === 'epss_percentage' ? dependabotAlertEpssPercentage(a) : Date.parse(sort === 'updated' ? a.updatedAt : a.createdAt);
    const right = sort === 'epss_percentage' ? dependabotAlertEpssPercentage(b) : Date.parse(sort === 'updated' ? b.updatedAt : b.createdAt);
    const comparison = left - right || a.number - b.number;
    return direction === 'asc' ? comparison : -comparison;
  });
}

function buildDependabotRepositoryResponse(
  repo: RepoInfo, targetDid: string, baseUrl: string,
): Record<string, unknown> {
  const fullName = `${targetDid}/${repo.name}`;
  return {
    id          : numericId(repo.contextId || `${targetDid}/${repo.name}`),
    name        : repo.name,
    full_name   : fullName,
    owner       : buildOwner(targetDid, baseUrl),
    private     : repo.visibility !== 'public',
    html_url    : `${baseUrl}/repos/${fullName}`,
    description : repo.description || null,
    fork        : Boolean(repo.forkedFromDid),
    url         : `${baseUrl}/repos/${fullName}`,
  };
}

export function buildDependabotAlertResponse(
  alert: DependabotAlertEntry, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const repoBase = `${baseUrl}/repos/${targetDid}/${repo.name}`;
  return {
    number     : alert.number,
    state      : alert.state,
    dependency : {
      package       : { ...alert.dependency.package },
      manifest_path : alert.dependency.manifestPath,
      scope         : alert.dependency.scope ?? 'runtime',
    },
    security_advisory      : { ...alert.securityAdvisory },
    security_vulnerability : alert.securityVulnerability ? { ...alert.securityVulnerability } : null,
    url                    : `${repoBase}/dependabot/alerts/${alert.number}`,
    html_url               : `${repoBase}/security/dependabot/${alert.number}`,
    created_at             : toISODate(alert.createdAt),
    updated_at             : toISODate(alert.updatedAt),
    dismissed_at           : alert.dismissedAt ? toISODate(alert.dismissedAt) : null,
    dismissed_by           : alert.dismissedBy ? buildOwner(alert.dismissedBy, baseUrl) : null,
    dismissed_reason       : alert.dismissedReason ?? null,
    dismissed_comment      : alert.dismissedComment ?? null,
    fixed_at               : alert.fixedAt ? toISODate(alert.fixedAt) : null,
    assignees              : (alert.assignees ?? []).map(assignee => buildOwner(assignee, baseUrl)),
    repository             : buildDependabotRepositoryResponse(repo, targetDid, baseUrl),
  };
}

async function findDependabotAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string,
): Promise<{ lookup: RepoSettingsLookup; alert: DependabotAlertEntry; key: string } | JsonResponse> {
  const number = parseInt(alertNumber, 10);
  if (!Number.isInteger(number) || number < 1) {
    return jsonNotFound(`Dependabot alert '${alertNumber}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = String(number);
  const alert = lookup.settings.dependabotAlerts?.[key]
    ?? dependabotAlertEntries(lookup.settings).find(entry => entry.number === number);
  if (!alert) {
    return jsonNotFound(`Dependabot alert '${alertNumber}' not found.`);
  }

  return { lookup, alert, key: String(alert.number) };
}

function validateDependabotAlertUpdate(
  body: Record<string, unknown>, existing: DependabotAlertEntry, actorDid: string,
): DependabotAlertEntry | JsonResponse {
  const hasState = Object.prototype.hasOwnProperty.call(body, 'state');
  const hasAssignees = Object.prototype.hasOwnProperty.call(body, 'assignees');
  if (!hasState && !hasAssignees) {
    return jsonValidationError('Validation Failed: state or assignees is required.');
  }

  let updated: DependabotAlertEntry = { ...existing, updatedAt: new Date().toISOString() };

  if (hasAssignees) {
    if (!Array.isArray(body.assignees) || !body.assignees.every(assignee => typeof assignee === 'string')) {
      return jsonValidationError('Validation Failed: assignees must be an array of strings.');
    }
    updated = { ...updated, assignees: [...new Set(body.assignees)] };
  }

  if (!hasState) {
    return updated;
  }

  if (typeof body.state !== 'string' || !DEPENDABOT_ALERT_UPDATE_STATES.has(body.state)) {
    return jsonValidationError('Validation Failed: state must be dismissed or open.');
  }

  if (body.state === 'open') {
    return {
      ...updated,
      state            : 'open',
      dismissedAt      : null,
      dismissedBy      : null,
      dismissedReason  : null,
      dismissedComment : null,
    };
  }

  if (typeof body.dismissed_reason !== 'string' || !DEPENDABOT_DISMISSAL_REASONS.has(body.dismissed_reason)) {
    return jsonValidationError('Validation Failed: dismissed_reason must be fix_started, inaccurate, no_bandwidth, not_used, or tolerable_risk.');
  }
  if (body.dismissed_comment !== undefined && body.dismissed_comment !== null && typeof body.dismissed_comment !== 'string') {
    return jsonValidationError('Validation Failed: dismissed_comment must be a string.');
  }

  return {
    ...updated,
    state            : 'dismissed',
    dismissedAt      : updated.updatedAt,
    dismissedBy      : actorDid,
    dismissedReason  : body.dismissed_reason as DependabotAlertData['dismissedReason'],
    dismissedComment : typeof body.dismissed_comment === 'string' ? body.dismissed_comment : null,
  };
}

function settingsWithDependabotAlert(
  settings: RepoSettingsData, key: string, alert: DependabotAlertEntry,
): RepoSettingsData {
  return {
    ...settings,
    dependabotAlerts: {
      ...(settings.dependabotAlerts ?? {}),
      [key]: alert,
    },
  };
}

export function secretScanningAlertEntries(settings: RepoSettingsData): SecretScanningAlertEntry[] {
  return Object.values(settings.secretScanningAlerts ?? {})
    .filter((entry): entry is SecretScanningAlertEntry => (
      Boolean(entry)
      && Number.isInteger(entry.number)
      && SECRET_SCANNING_STATES.has(entry.state)
      && typeof entry.secretType === 'string'
      && typeof entry.secret === 'string'
    ))
    .sort((a, b) => a.number - b.number);
}

export function parseBooleanQuery(url: URL, name: string): boolean | null | JsonResponse {
  const value = url.searchParams.get(name);
  if (value === null) { return null; }
  if (value === 'true') { return true; }
  if (value === 'false') { return false; }
  return jsonValidationError(`Validation Failed: ${name} must be true or false.`);
}

function secretScanningAssigneeMatches(assignedTo: string | null | undefined, assignees: string[]): boolean {
  if (assignees.length === 0) { return true; }
  if (assignees.includes('*')) { return Boolean(assignedTo); }
  if (assignees.includes('none')) { return !assignedTo; }
  return Boolean(assignedTo && assignees.includes(assignedTo));
}

export function filterSecretScanningAlerts(alerts: SecretScanningAlertEntry[], url: URL): SecretScanningAlertEntry[] | JsonResponse {
  const secretTypes = csvQueryValues(url, 'secret_type');
  const excludedSecretTypes = csvQueryValues(url, 'exclude_secret_types');
  if (secretTypes.length > 0 && excludedSecretTypes.length > 0) {
    return jsonValidationError('Validation Failed: secret_type and exclude_secret_types cannot both be specified.');
  }

  const providers = csvQueryValues(url, 'providers');
  const excludedProviders = csvQueryValues(url, 'exclude_providers');
  if (providers.length > 0 && excludedProviders.length > 0) {
    return jsonValidationError('Validation Failed: providers and exclude_providers cannot both be specified.');
  }

  const state = csvQueryValues(url, 'state');
  const invalidState = invalidCsvValues(state, SECRET_SCANNING_STATES);
  if (invalidState.length > 0) {
    return jsonValidationError('Validation Failed: state must be open or resolved.');
  }

  const resolution = csvQueryValues(url, 'resolution');
  const invalidResolution = invalidCsvValues(resolution, SECRET_SCANNING_RESOLUTIONS);
  if (invalidResolution.length > 0) {
    return jsonValidationError('Validation Failed: resolution must be false_positive, wont_fix, revoked, pattern_edited, pattern_deleted, or used_in_tests.');
  }

  const validity = csvQueryValues(url, 'validity');
  const invalidValidity = invalidCsvValues(validity, SECRET_SCANNING_VALIDITIES);
  if (invalidValidity.length > 0) {
    return jsonValidationError('Validation Failed: validity must be active, inactive, or unknown.');
  }

  const sort = url.searchParams.get('sort') ?? 'created';
  if (!SECRET_SCANNING_SORTS.has(sort)) {
    return jsonValidationError('Validation Failed: sort must be created or updated.');
  }

  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  const publiclyLeaked = parseBooleanQuery(url, 'is_publicly_leaked');
  if (publiclyLeaked !== null && typeof publiclyLeaked !== 'boolean') { return publiclyLeaked; }

  const multiRepo = parseBooleanQuery(url, 'is_multi_repo');
  if (multiRepo !== null && typeof multiRepo !== 'boolean') { return multiRepo; }

  const bypassed = parseBooleanQuery(url, 'is_bypassed');
  if (bypassed !== null && typeof bypassed !== 'boolean') { return bypassed; }

  const assignees = csvQueryValues(url, 'assignee');
  const filtered = alerts
    .filter(alert => state.length === 0 || state.includes(alert.state))
    .filter(alert => secretTypes.length === 0 || secretTypes.includes(alert.secretType))
    .filter(alert => excludedSecretTypes.length === 0 || !excludedSecretTypes.includes(alert.secretType))
    .filter(alert => providers.length === 0 || providers.includes(alert.providerSlug ?? ''))
    .filter(alert => excludedProviders.length === 0 || !excludedProviders.includes(alert.providerSlug ?? ''))
    .filter(alert => (
      resolution.length === 0
      || (alert.resolution !== null && alert.resolution !== undefined && resolution.includes(alert.resolution))
    ))
    .filter(alert => validity.length === 0 || (alert.validity !== undefined && validity.includes(alert.validity)))
    .filter(alert => publiclyLeaked === null || Boolean(alert.publiclyLeaked) === publiclyLeaked)
    .filter(alert => multiRepo === null || Boolean(alert.multiRepo) === multiRepo)
    .filter(alert => bypassed === null || Boolean(alert.pushProtectionBypassed) === bypassed)
    .filter(alert => secretScanningAssigneeMatches(alert.assignedTo, assignees));

  return filtered.sort((a, b) => {
    const left = Date.parse(sort === 'updated' ? a.updatedAt : a.createdAt);
    const right = Date.parse(sort === 'updated' ? b.updatedAt : b.createdAt);
    const comparison = left - right || a.number - b.number;
    return direction === 'asc' ? comparison : -comparison;
  });
}

function buildSecretScanningLocationResponse(location: SecretScanningLocationEntry): Record<string, unknown> {
  return {
    type    : location.type,
    details : { ...location.details },
  };
}

export function buildSecretScanningAlertResponse(
  alert: SecretScanningAlertEntry, targetDid: string, repo: RepoInfo, baseUrl: string, hideSecret = false,
): Record<string, unknown> {
  const repoBase = `${baseUrl}/repos/${targetDid}/${repo.name}`;
  const bypassRequestReviewer = alert.pushProtectionBypassRequestReviewer
    ? buildOwner(alert.pushProtectionBypassRequestReviewer, baseUrl)
    : null;
  return {
    number                                          : alert.number,
    created_at                                      : toISODate(alert.createdAt),
    url                                             : `${repoBase}/secret-scanning/alerts/${alert.number}`,
    html_url                                        : `${repoBase}/security/secret-scanning/${alert.number}`,
    locations_url                                   : `${repoBase}/secret-scanning/alerts/${alert.number}/locations`,
    state                                           : alert.state,
    resolution                                      : alert.resolution ?? null,
    resolved_at                                     : alert.resolvedAt ? toISODate(alert.resolvedAt) : null,
    resolved_by                                     : alert.resolvedBy ? buildOwner(alert.resolvedBy, baseUrl) : null,
    secret_type                                     : alert.secretType,
    secret_type_display_name                        : alert.secretTypeDisplayName ?? alert.secretType,
    secret                                          : hideSecret ? '********' : alert.secret,
    provider                                        : alert.provider ?? null,
    provider_slug                                   : alert.providerSlug ?? null,
    push_protection_bypassed_by                     : alert.pushProtectionBypassedBy ? buildOwner(alert.pushProtectionBypassedBy, baseUrl) : null,
    push_protection_bypassed                        : Boolean(alert.pushProtectionBypassed),
    push_protection_bypassed_at                     : alert.pushProtectionBypassedAt ? toISODate(alert.pushProtectionBypassedAt) : null,
    push_protection_bypass_request_reviewer         : bypassRequestReviewer,
    push_protection_bypass_request_reviewer_comment : alert.pushProtectionBypassRequestReviewerComment ?? null,
    push_protection_bypass_request_comment          : alert.pushProtectionBypassRequestComment ?? null,
    push_protection_bypass_request_html_url         : alert.pushProtectionBypassRequestHtmlUrl ?? null,
    resolution_comment                              : alert.resolutionComment ?? null,
    validity                                        : alert.validity ?? 'unknown',
    publicly_leaked                                 : Boolean(alert.publiclyLeaked),
    multi_repo                                      : Boolean(alert.multiRepo),
    is_base64_encoded                               : Boolean(alert.isBase64Encoded),
    first_location_detected                         : alert.firstLocationDetected ?? null,
    has_more_locations                              : alert.hasMoreLocations ?? ((alert.locations?.length ?? 0) > 1),
    assigned_to                                     : alert.assignedTo ? buildOwner(alert.assignedTo, baseUrl) : null,
    repository                                      : buildDependabotRepositoryResponse(repo, targetDid, baseUrl),
  };
}

async function findSecretScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string,
): Promise<{ lookup: RepoSettingsLookup; alert: SecretScanningAlertEntry; key: string } | JsonResponse> {
  const number = parseInt(alertNumber, 10);
  if (!Number.isInteger(number) || number < 1) {
    return jsonNotFound(`Secret scanning alert '${alertNumber}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = String(number);
  const alert = lookup.settings.secretScanningAlerts?.[key]
    ?? secretScanningAlertEntries(lookup.settings).find(entry => entry.number === number);
  if (!alert) {
    return jsonNotFound(`Secret scanning alert '${alertNumber}' not found.`);
  }

  return { lookup, alert, key: String(alert.number) };
}

function validateSecretScanningAlertUpdate(
  body: Record<string, unknown>, existing: SecretScanningAlertEntry, actorDid: string,
): SecretScanningAlertEntry | JsonResponse {
  const hasState = Object.prototype.hasOwnProperty.call(body, 'state');
  const hasResolution = Object.prototype.hasOwnProperty.call(body, 'resolution');
  const hasResolutionComment = Object.prototype.hasOwnProperty.call(body, 'resolution_comment');
  const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assignee');
  const hasValidity = Object.prototype.hasOwnProperty.call(body, 'validity');
  if (!hasState && !hasResolution && !hasResolutionComment && !hasAssignee && !hasValidity) {
    return jsonValidationError('Validation Failed: state, resolution, resolution_comment, assignee, or validity is required.');
  }

  let updated: SecretScanningAlertEntry = { ...existing, updatedAt: new Date().toISOString() };

  if (hasAssignee) {
    if (body.assignee !== null && typeof body.assignee !== 'string') {
      return jsonValidationError('Validation Failed: assignee must be a string or null.');
    }
    updated = { ...updated, assignedTo: body.assignee === null ? null : body.assignee as string };
  }

  if (hasValidity) {
    if (body.validity === null) {
      const { validity: _validity, ...withoutValidity } = updated;
      updated = withoutValidity;
    } else if (typeof body.validity === 'string' && SECRET_SCANNING_UPDATE_VALIDITIES.has(body.validity)) {
      updated = { ...updated, validity: body.validity as SecretScanningAlertEntry['validity'] };
    } else {
      return jsonValidationError('Validation Failed: validity must be active, inactive, or null.');
    }
  }

  if (hasResolutionComment && body.resolution_comment !== null && typeof body.resolution_comment !== 'string') {
    return jsonValidationError('Validation Failed: resolution_comment must be a string or null.');
  }

  if (!hasState) {
    if (hasResolution) {
      return jsonValidationError('Validation Failed: state is required when resolution is provided.');
    }
    return updated;
  }

  if (typeof body.state !== 'string' || !SECRET_SCANNING_STATES.has(body.state)) {
    return jsonValidationError('Validation Failed: state must be open or resolved.');
  }

  if (body.state === 'open') {
    if (hasResolution && body.resolution !== null) {
      return jsonValidationError('Validation Failed: resolution must be null when state is open.');
    }
    return {
      ...updated,
      state             : 'open',
      resolution        : null,
      resolvedAt        : null,
      resolvedBy        : null,
      resolutionComment : typeof body.resolution_comment === 'string' ? body.resolution_comment : null,
    };
  }

  if (typeof body.resolution !== 'string' || !SECRET_SCANNING_UPDATE_RESOLUTIONS.has(body.resolution)) {
    return jsonValidationError('Validation Failed: resolution must be false_positive, wont_fix, revoked, or used_in_tests when state is resolved.');
  }

  return {
    ...updated,
    state             : 'resolved',
    resolution        : body.resolution as SecretScanningAlertEntry['resolution'],
    resolvedAt        : updated.updatedAt,
    resolvedBy        : actorDid,
    resolutionComment : typeof body.resolution_comment === 'string' ? body.resolution_comment : null,
  };
}

function settingsWithSecretScanningAlert(
  settings: RepoSettingsData, key: string, alert: SecretScanningAlertEntry,
): RepoSettingsData {
  return {
    ...settings,
    secretScanningAlerts: {
      ...(settings.secretScanningAlerts ?? {}),
      [key]: alert,
    },
  };
}

function validateSecretScanningPushProtectionBypass(
  body: Record<string, unknown>,
): { placeholderId: string; reason: SecretScanningBypassEntry['reason'] } | JsonResponse {
  if (typeof body.reason !== 'string' || !SECRET_SCANNING_BYPASS_REASONS.has(body.reason)) {
    return jsonValidationError('Validation Failed: reason must be false_positive, used_in_tests, or will_fix_later.');
  }

  if (typeof body.placeholder_id !== 'string' || body.placeholder_id.trim().length === 0) {
    return jsonValidationError('Validation Failed: placeholder_id is required.');
  }

  return {
    placeholderId : body.placeholder_id.trim(),
    reason        : body.reason as SecretScanningBypassEntry['reason'],
  };
}

function secretScanningPushProtectionBypassResponse(bypass: SecretScanningBypassEntry): Record<string, unknown> {
  return {
    reason     : bypass.reason,
    expire_at  : bypass.expireAt ? toISODate(bypass.expireAt) : null,
    token_type : bypass.tokenType,
  };
}

function settingsWithSecretScanningPushProtectionBypass(
  settings: RepoSettingsData, key: string, bypass: SecretScanningBypassEntry,
): RepoSettingsData {
  const next: RepoSettingsData = {
    ...settings,
    secretScanningPushProtectionBypasses: {
      ...(settings.secretScanningPushProtectionBypasses ?? {}),
      [key]: bypass,
    },
  };

  if (!bypass.alertNumber) {
    return next;
  }

  const alerts = { ...(settings.secretScanningAlerts ?? {}) };
  const alert = alerts[String(bypass.alertNumber)]
    ?? secretScanningAlertEntries(settings).find(entry => entry.number === bypass.alertNumber);
  if (!alert) {
    return next;
  }

  alerts[String(alert.number)] = {
    ...alert,
    pushProtectionBypassed   : true,
    pushProtectionBypassedBy : bypass.createdBy ?? null,
    pushProtectionBypassedAt : bypass.createdAt ?? null,
    updatedAt                : bypass.createdAt ?? alert.updatedAt,
  };
  next.secretScanningAlerts = alerts;
  return next;
}

function buildSecretScanningScanResponse(scan: SecretScanningScanEntry): Record<string, unknown> {
  return {
    type   : scan.type,
    status : scan.status,
    ...(scan.startedAt ? { started_at: toISODate(scan.startedAt) } : {}),
    ...(scan.completedAt ? { completed_at: toISODate(scan.completedAt) } : {}),
    ...(scan.patternSlug ? { pattern_slug: scan.patternSlug } : {}),
    ...(scan.patternScope ? { pattern_scope: scan.patternScope } : {}),
  };
}

function buildSecretScanningScanHistoryResponse(settings: RepoSettingsData, repo: RepoInfo): Record<string, unknown> {
  const history = settings.secretScanningScanHistory ?? {
    incrementalScans: [{
      type        : 'git',
      status      : 'completed',
      completedAt : toISODate(repo.timestamp),
    }],
  };

  return {
    incremental_scans              : (history.incrementalScans ?? []).map(buildSecretScanningScanResponse),
    backfill_scans                 : (history.backfillScans ?? []).map(buildSecretScanningScanResponse),
    pattern_update_scans           : (history.patternUpdateScans ?? []).map(buildSecretScanningScanResponse),
    custom_pattern_backfill_scans  : (history.customPatternBackfillScans ?? []).map(buildSecretScanningScanResponse),
    generic_secrets_backfill_scans : (history.genericSecretsBackfillScans ?? []).map(buildSecretScanningScanResponse),
  };
}

export function securityAdvisoryEntries(settings: RepoSettingsData): SecurityAdvisoryEntry[] {
  return Object.values(settings.securityAdvisories ?? {})
    .filter((entry): entry is SecurityAdvisoryEntry => (
      Boolean(entry)
      && typeof entry.ghsaId === 'string'
      && typeof entry.summary === 'string'
      && typeof entry.description === 'string'
      && SECURITY_ADVISORY_STATES.has(entry.state)
      && typeof entry.authorDid === 'string'
    ))
    .sort((a, b) => a.ghsaId.localeCompare(b.ghsaId));
}

function securityAdvisoryRecordKey(ghsaId: string): string {
  return ghsaId.toUpperCase();
}

function nextSecurityAdvisoryGhsaId(settings: RepoSettingsData, repo: RepoInfo, now: string): string {
  const used = new Set(securityAdvisoryEntries(settings).map(advisory => advisory.ghsaId.toUpperCase()));
  for (let i = used.size + 1; i < used.size + 1000; i++) {
    const suffix = numericId(`${repo.contextId}:${now}:${i}`).toString(36).padStart(12, '0').slice(0, 12);
    const ghsaId = `GHSA-${suffix.slice(0, 4)}-${suffix.slice(4, 8)}-${suffix.slice(8, 12)}`.toUpperCase();
    if (!used.has(ghsaId)) {
      return ghsaId;
    }
  }
  return `GHSA-${Date.now().toString(36).padStart(12, '0').slice(0, 4)}-TEMP-FALL`.toUpperCase();
}

function validateSecurityAdvisoryList(url: URL): { state: string[]; sort: string; direction: 'asc' | 'desc' } | JsonResponse {
  const state = csvQueryValues(url, 'state');
  const invalidState = invalidCsvValues(state, SECURITY_ADVISORY_STATES);
  if (invalidState.length > 0) {
    return jsonValidationError('Validation Failed: state must be triage, draft, published, or closed.');
  }

  const sort = url.searchParams.get('sort') ?? 'created';
  if (!SECURITY_ADVISORY_SORTS.has(sort)) {
    return jsonValidationError('Validation Failed: sort must be created, updated, or published.');
  }

  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') {
    return jsonValidationError('Validation Failed: direction must be asc or desc.');
  }

  return { state, sort, direction };
}

export function filterSecurityAdvisories(advisories: SecurityAdvisoryEntry[], url: URL): SecurityAdvisoryEntry[] | JsonResponse {
  const parsed = validateSecurityAdvisoryList(url);
  if ('status' in parsed) { return parsed; }

  const filtered = advisories.filter(advisory => parsed.state.length === 0 || parsed.state.includes(advisory.state));
  return filtered.sort((a, b) => {
    const left = Date.parse(parsed.sort === 'published' ? a.publishedAt ?? '' : parsed.sort === 'updated' ? a.updatedAt : a.createdAt);
    const right = Date.parse(parsed.sort === 'published' ? b.publishedAt ?? '' : parsed.sort === 'updated' ? b.updatedAt : b.createdAt);
    const comparison = (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right) || a.ghsaId.localeCompare(b.ghsaId);
    return parsed.direction === 'asc' ? comparison : -comparison;
  });
}

function securityAdvisoryCreditDetails(
  advisory: SecurityAdvisoryEntry, baseUrl: string,
): Array<Record<string, unknown>> {
  if (advisory.creditsDetailed) {
    return advisory.creditsDetailed.map(credit => ({ ...credit }));
  }
  return (advisory.credits ?? []).map((credit) => ({
    user  : typeof credit.login === 'string' ? buildOwner(credit.login, baseUrl) : null,
    type  : typeof credit.type === 'string' ? credit.type : 'other',
    state : typeof credit.state === 'string' ? credit.state : 'accepted',
  }));
}

function buildSecurityAdvisoryPrivateForkResponse(
  advisory: SecurityAdvisoryEntry, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> | null {
  if (!advisory.privateFork) {
    return null;
  }
  const fork = advisory.privateFork;
  const ownerDid = typeof fork.ownerDid === 'string' ? fork.ownerDid : targetDid;
  const name = typeof fork.name === 'string' ? fork.name : `${repo.name}-${advisory.ghsaId.toLowerCase()}`;
  const fullName = typeof fork.fullName === 'string' ? fork.fullName : `${ownerDid}/${name}`;
  const repoBase = `${baseUrl}/repos/${fullName}`;
  return {
    id                : numericId(fullName),
    node_id           : `R_${numericId(fullName).toString(36)}`,
    name,
    full_name         : fullName,
    owner             : buildOwner(ownerDid, baseUrl),
    private           : true,
    html_url          : repoBase,
    description       : null,
    fork              : false,
    url               : repoBase,
    archive_url       : `${repoBase}/{archive_format}{/ref}`,
    assignees_url     : `${repoBase}/assignees{/user}`,
    branches_url      : `${repoBase}/branches{/branch}`,
    collaborators_url : `${repoBase}/collaborators{/collaborator}`,
    contents_url      : `${repoBase}/contents/{+path}`,
    forks_url         : `${repoBase}/forks`,
    pulls_url         : `${repoBase}/pulls{/number}`,
    teams_url         : `${repoBase}/teams`,
  };
}

export function buildSecurityAdvisoryResponse(
  advisory: SecurityAdvisoryEntry, targetDid: string, repo: RepoInfo, baseUrl: string,
): Record<string, unknown> {
  const repoBase = `${baseUrl}/repos/${targetDid}/${repo.name}`;
  const identifiers = [
    { type: 'GHSA', value: advisory.ghsaId },
    ...(advisory.cveId ? [{ type: 'CVE', value: advisory.cveId }] : []),
  ];
  return {
    ghsa_id             : advisory.ghsaId,
    cve_id              : advisory.cveId ?? null,
    url                 : `${repoBase}/security-advisories/${advisory.ghsaId}`,
    html_url            : `${repoBase}/security/advisories/${advisory.ghsaId}`,
    summary             : advisory.summary,
    description         : advisory.description,
    severity            : advisory.severity ?? 'unknown',
    author              : buildOwner(advisory.authorDid, baseUrl),
    publisher           : advisory.publisherDid ? buildOwner(advisory.publisherDid, baseUrl) : null,
    identifiers,
    state               : advisory.state,
    created_at          : toISODate(advisory.createdAt),
    updated_at          : toISODate(advisory.updatedAt),
    published_at        : advisory.publishedAt ? toISODate(advisory.publishedAt) : null,
    closed_at           : advisory.closedAt ? toISODate(advisory.closedAt) : null,
    withdrawn_at        : advisory.withdrawnAt ? toISODate(advisory.withdrawnAt) : null,
    submission          : advisory.submission ?? null,
    vulnerabilities     : advisory.vulnerabilities ?? [],
    cvss_severities     : advisory.cvssSeverities ?? {},
    cwes                : advisory.cwes ?? (advisory.cweIds ?? []).map(cweId => ({ cwe_id: cweId, name: cweId })),
    cwe_ids             : advisory.cweIds ?? [],
    credits             : advisory.credits ?? [],
    credits_detailed    : securityAdvisoryCreditDetails(advisory, baseUrl),
    collaborating_users : (advisory.collaboratingUsers ?? []).map(did => buildOwner(did, baseUrl)),
    collaborating_teams : advisory.collaboratingTeams ?? [],
    private_fork        : buildSecurityAdvisoryPrivateForkResponse(advisory, targetDid, repo, baseUrl),
  };
}

function validateSecurityAdvisoryVulnerabilities(value: unknown, required: boolean): Array<Record<string, unknown>> | null | JsonResponse {
  if (value === undefined || value === null) {
    if (required) {
      return jsonValidationError('Validation Failed: vulnerabilities is required.');
    }
    return null;
  }
  if (!Array.isArray(value) || !value.every(item => isPlainObject(item))) {
    return jsonValidationError('Validation Failed: vulnerabilities must be an array of objects.');
  }
  return value.map(item => ({ ...item }));
}

function validateOptionalStringArray(value: unknown, name: string): string[] | null | JsonResponse {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return jsonValidationError(`Validation Failed: ${name} must be an array of strings.`);
  }
  return [...value];
}

function validateOptionalObjectArray(value: unknown, name: string): Array<Record<string, unknown>> | null | JsonResponse {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || !value.every(item => isPlainObject(item))) {
    return jsonValidationError(`Validation Failed: ${name} must be an array of objects.`);
  }
  return value.map(item => ({ ...item }));
}

function validateSecurityAdvisorySeverity(body: Record<string, unknown>): SecurityAdvisoryEntry['severity'] | JsonResponse {
  if (body.severity !== undefined && body.severity !== null && body.cvss_vector_string !== undefined && body.cvss_vector_string !== null) {
    return jsonValidationError('Validation Failed: specify either severity or cvss_vector_string, not both.');
  }
  if (body.severity === undefined || body.severity === null) {
    return undefined;
  }
  if (typeof body.severity !== 'string' || !SECURITY_ADVISORY_SEVERITIES.has(body.severity)) {
    return jsonValidationError('Validation Failed: severity must be critical, high, medium, low, or unknown.');
  }
  return body.severity as SecurityAdvisoryEntry['severity'];
}

function securityAdvisoryPrivateForkSeed(advisory: SecurityAdvisoryEntry, targetDid: string, repo: RepoInfo): Record<string, unknown> {
  const name = `${repo.name}-${advisory.ghsaId.toLowerCase()}`;
  return {
    ownerDid  : targetDid,
    name,
    fullName  : `${targetDid}/${name}`,
    createdAt : new Date().toISOString(),
  };
}

function buildSecurityAdvisoryFromBody(
  body: Record<string, unknown>, settings: RepoSettingsData, repo: RepoInfo, actorDid: string, targetDid: string, report: boolean,
): SecurityAdvisoryEntry | JsonResponse {
  if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
    return jsonValidationError('Validation Failed: summary is required.');
  }
  if (typeof body.description !== 'string' || body.description.trim().length === 0) {
    return jsonValidationError('Validation Failed: description is required.');
  }

  const vulnerabilities = validateSecurityAdvisoryVulnerabilities(body.vulnerabilities, !report);
  if (vulnerabilities && 'status' in vulnerabilities) { return vulnerabilities; }

  const cweIds = validateOptionalStringArray(body.cwe_ids, 'cwe_ids');
  if (cweIds && 'status' in cweIds) { return cweIds; }

  const credits = validateOptionalObjectArray(body.credits, 'credits');
  if (credits && 'status' in credits) { return credits; }

  const severity = validateSecurityAdvisorySeverity(body);
  if (severity && typeof severity !== 'string') { return severity; }

  if (body.start_private_fork !== undefined && typeof body.start_private_fork !== 'boolean') {
    return jsonValidationError('Validation Failed: start_private_fork must be a boolean.');
  }
  if (body.cve_id !== undefined && body.cve_id !== null && typeof body.cve_id !== 'string') {
    return jsonValidationError('Validation Failed: cve_id must be a string or null.');
  }

  const now = new Date().toISOString();
  const advisorySeverity = (typeof severity === 'string' ? severity : 'unknown') as SecurityAdvisoryEntry['severity'];
  const advisory: SecurityAdvisoryEntry = {
    ghsaId          : nextSecurityAdvisoryGhsaId(settings, repo, now),
    cveId           : body.cve_id === undefined ? null : body.cve_id as string | null,
    summary         : body.summary.trim(),
    description     : body.description.trim(),
    severity        : advisorySeverity,
    state           : report ? 'triage' : 'draft',
    authorDid       : actorDid,
    publisherDid    : null,
    createdAt       : now,
    updatedAt       : now,
    publishedAt     : null,
    closedAt        : null,
    withdrawnAt     : null,
    submission      : report ? { accepted: false } : null,
    vulnerabilities : vulnerabilities ?? [],
    cweIds          : cweIds ?? [],
    credits         : credits ?? [],
  };

  if (body.cvss_vector_string !== undefined && body.cvss_vector_string !== null) {
    if (typeof body.cvss_vector_string !== 'string' || body.cvss_vector_string.trim().length === 0) {
      return jsonValidationError('Validation Failed: cvss_vector_string must be a string.');
    }
    advisory.cvssSeverities = {
      cvss_v3: { vector_string: body.cvss_vector_string.trim(), score: null },
    };
  }

  if (body.start_private_fork === true) {
    advisory.privateFork = securityAdvisoryPrivateForkSeed(advisory, targetDid, repo);
  }

  return advisory;
}

async function findSecurityAdvisory(
  ctx: AgentContext, targetDid: string, repoName: string, ghsaId: string,
): Promise<{ lookup: RepoSettingsLookup; advisory: SecurityAdvisoryEntry; key: string } | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const normalized = securityAdvisoryRecordKey(ghsaId);
  const advisory = lookup.settings.securityAdvisories?.[normalized]
    ?? securityAdvisoryEntries(lookup.settings).find(entry => securityAdvisoryRecordKey(entry.ghsaId) === normalized);
  if (!advisory) {
    return jsonNotFound(`Repository security advisory '${ghsaId}' not found.`);
  }
  return { lookup, advisory, key: securityAdvisoryRecordKey(advisory.ghsaId) };
}

function updateSecurityAdvisoryFromBody(
  existing: SecurityAdvisoryEntry, body: Record<string, unknown>, actorDid: string,
): SecurityAdvisoryEntry | JsonResponse {
  if (Object.keys(body).length === 0) {
    return jsonValidationError('Validation Failed: at least one field is required.');
  }

  let updated: SecurityAdvisoryEntry = { ...existing, updatedAt: new Date().toISOString() };

  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
      return jsonValidationError('Validation Failed: summary must be a non-empty string.');
    }
    updated = { ...updated, summary: body.summary.trim() };
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.trim().length === 0) {
      return jsonValidationError('Validation Failed: description must be a non-empty string.');
    }
    updated = { ...updated, description: body.description.trim() };
  }
  if (body.cve_id !== undefined) {
    if (body.cve_id !== null && typeof body.cve_id !== 'string') {
      return jsonValidationError('Validation Failed: cve_id must be a string or null.');
    }
    updated = { ...updated, cveId: body.cve_id as string | null };
  }

  const vulnerabilities = validateSecurityAdvisoryVulnerabilities(body.vulnerabilities, false);
  if (vulnerabilities && 'status' in vulnerabilities) { return vulnerabilities; }
  if (vulnerabilities) { updated = { ...updated, vulnerabilities }; }

  const cweIds = validateOptionalStringArray(body.cwe_ids, 'cwe_ids');
  if (cweIds && 'status' in cweIds) { return cweIds; }
  if (cweIds) { updated = { ...updated, cweIds }; }

  const credits = validateOptionalObjectArray(body.credits, 'credits');
  if (credits && 'status' in credits) { return credits; }
  if (credits) { updated = { ...updated, credits }; }

  const collaboratingUsers = validateOptionalStringArray(body.collaborating_users, 'collaborating_users');
  if (collaboratingUsers && 'status' in collaboratingUsers) { return collaboratingUsers; }
  if (collaboratingUsers) { updated = { ...updated, collaboratingUsers }; }

  const severity = validateSecurityAdvisorySeverity(body);
  if (severity && typeof severity !== 'string') { return severity; }
  if (typeof severity === 'string') { updated = { ...updated, severity }; }

  if (body.cvss_vector_string !== undefined && body.cvss_vector_string !== null) {
    if (typeof body.cvss_vector_string !== 'string' || body.cvss_vector_string.trim().length === 0) {
      return jsonValidationError('Validation Failed: cvss_vector_string must be a string.');
    }
    updated = {
      ...updated,
      cvssSeverities: {
        ...(updated.cvssSeverities ?? {}),
        cvss_v3: { vector_string: body.cvss_vector_string.trim(), score: null },
      },
    };
  }

  if (body.state !== undefined) {
    if (typeof body.state !== 'string' || !SECURITY_ADVISORY_STATES.has(body.state)) {
      return jsonValidationError('Validation Failed: state must be triage, draft, published, or closed.');
    }
    updated = { ...updated, state: body.state as SecurityAdvisoryEntry['state'] };
    if (body.state === 'published' && !updated.publishedAt) {
      updated = { ...updated, publishedAt: updated.updatedAt, publisherDid: actorDid };
    }
    if (body.state === 'closed' && !updated.closedAt) {
      updated = { ...updated, closedAt: updated.updatedAt };
    }
  }

  return updated;
}

function settingsWithSecurityAdvisory(
  settings: RepoSettingsData, key: string, advisory: SecurityAdvisoryEntry,
): RepoSettingsData {
  return {
    ...settings,
    securityAdvisories: {
      ...(settings.securityAdvisories ?? {}),
      [key]: advisory,
    },
  };
}

function attestationEntries(settings: RepoSettingsData): AttestationEntry[] {
  return Object.values(settings.attestations ?? {})
    .filter((entry): entry is AttestationEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function nextAttestationId(settings: RepoSettingsData): number {
  return attestationEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function normalizeSubjectDigest(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return SHA256_DIGEST_PATTERN.test(normalized) ? normalized : null;
}

function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractAttestationStatement(bundle: Record<string, unknown>): Record<string, unknown> | null {
  const dsseEnvelope = isPlainObject(bundle.dsseEnvelope) ? bundle.dsseEnvelope : null;
  const payload = typeof dsseEnvelope?.payload === 'string' ? dsseEnvelope.payload : null;
  return payload ? decodeBase64Json(payload) : null;
}

function extractAttestationSubjectDigest(bundle: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const explicit = normalizeSubjectDigest(body.subject_digest);
  if (explicit) {
    return explicit;
  }

  const statement = extractAttestationStatement(bundle);
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  for (const subject of subjects) {
    if (!isPlainObject(subject) || !isPlainObject(subject.digest)) {
      continue;
    }
    const digest = normalizeSubjectDigest(`sha256:${subject.digest.sha256 ?? ''}`);
    if (digest) {
      return digest;
    }
  }
  return null;
}

function extractAttestationPredicateType(bundle: Record<string, unknown>): string | undefined {
  const statement = extractAttestationStatement(bundle);
  return typeof statement?.predicateType === 'string' && statement.predicateType.trim()
    ? statement.predicateType.trim()
    : undefined;
}

function settingsWithAttestation(
  settings: RepoSettingsData, attestation: AttestationEntry,
): RepoSettingsData {
  return {
    ...settings,
    attestations: {
      ...(settings.attestations ?? {}),
      [String(attestation.id)]: attestation,
    },
  };
}

function buildAttestationResponse(
  attestation: AttestationEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    id             : attestation.id,
    repository_id  : numericId(`${targetDid}/${repoName}`),
    repository_url : `${baseUrl}/repos/${targetDid}/${repoName}`,
    subject_digest : attestation.subjectDigest,
    predicate_type : attestation.predicateType ?? null,
    bundle         : attestation.bundle,
    created_at     : toISODate(attestation.createdAt),
  };
}

async function findRuleset(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string,
): Promise<{ lookup: RepoSettingsLookup; ruleset: RulesetEntry; key: string } | JsonResponse> {
  const id = parseInt(rulesetId, 10);
  if (!Number.isInteger(id) || id < 1) {
    return jsonNotFound(`Ruleset '${rulesetId}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const key = rulesetRecordKey(id);
  const ruleset = lookup.settings.rulesets?.[key];
  if (!ruleset) {
    return jsonNotFound(`Ruleset '${rulesetId}' not found.`);
  }

  return { lookup, ruleset, key };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function branchPatternMatches(pattern: string, branch: string, defaultBranch: string): boolean {
  if (pattern === '~ALL') {
    return true;
  }
  if (pattern === '~DEFAULT_BRANCH') {
    return branch === defaultBranch;
  }

  const branchRef = `refs/heads/${branch}`;
  if (pattern === branch || pattern === branchRef) {
    return true;
  }

  if (!pattern.includes('*')) {
    return false;
  }

  return globToRegExp(pattern).test(branch) || globToRegExp(pattern).test(branchRef);
}

function rulesetMatchesBranch(ruleset: RulesetEntry, branch: string, defaultBranch: string): boolean {
  if (ruleset.target !== 'branch' || ruleset.enforcement !== 'active') {
    return false;
  }

  const refName = isPlainObject(ruleset.conditions?.ref_name) ? ruleset.conditions.ref_name : null;
  if (!refName) {
    return true;
  }

  const include = Array.isArray(refName.include) ? refName.include.filter((item): item is string => typeof item === 'string') : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude.filter((item): item is string => typeof item === 'string') : [];
  const included = include.length === 0 || include.some(pattern => branchPatternMatches(pattern, branch, defaultBranch));
  const excluded = exclude.some(pattern => branchPatternMatches(pattern, branch, defaultBranch));
  return included && !excluded;
}

export function rulesetProtectsBranch(settings: RepoSettingsData, branch: string, defaultBranch: string): boolean {
  return rulesetEntries(settings)
    .some(ruleset => ruleset.rules.length > 0 && rulesetMatchesBranch(ruleset, branch, defaultBranch));
}

function buildBranchRuleResponse(
  rule: Record<string, unknown> & { type: string }, ruleset: RulesetEntry, targetDid: string, repoName: string,
): Record<string, unknown> {
  return {
    ...rule,
    ruleset_source_type : 'Repository',
    ruleset_source      : rulesetSource(targetDid, repoName),
    ruleset_id          : ruleset.id,
  };
}

function ruleSuiteEntries(settings: RepoSettingsData): RuleSuiteEntry[] {
  return Object.values(settings.ruleSuites ?? {})
    .filter((entry): entry is RuleSuiteEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt) || b.id - a.id);
}

function ruleSuiteRefMatches(suiteRef: string, queryRef: string): boolean {
  if (suiteRef === queryRef) {
    return true;
  }
  if (queryRef.startsWith('refs/heads/') || queryRef.startsWith('refs/tags/')) {
    return false;
  }
  return suiteRef === `refs/heads/${queryRef}` || suiteRef === `refs/tags/${queryRef}`;
}

function ruleSuiteMatchesEvaluateStatus(suite: RuleSuiteEntry, evaluateStatus: string): boolean {
  if (evaluateStatus === 'all') {
    return true;
  }
  const evaluations = suite.ruleEvaluations ?? [];
  const hasEvaluateRule = evaluations.some(evaluation => evaluation.enforcement === 'evaluate');
  return evaluateStatus === 'evaluate' ? hasEvaluateRule : !hasEvaluateRule;
}

function filterRuleSuites(suites: RuleSuiteEntry[], url: URL): RuleSuiteEntry[] | JsonResponse {
  const ref = url.searchParams.get('ref');
  if (ref?.includes('*')) {
    return jsonValidationError('Validation Failed: ref cannot contain wildcard characters.');
  }

  const timePeriod = url.searchParams.get('time_period') ?? 'day';
  const timeWindowMs = RULE_SUITE_TIME_PERIOD_MS[timePeriod];
  if (!timeWindowMs) {
    return jsonValidationError('Validation Failed: time_period must be hour, day, week, or month.');
  }

  const ruleSuiteResult = url.searchParams.get('rule_suite_result') ?? 'all';
  if (!RULE_SUITE_RESULTS.has(ruleSuiteResult)) {
    return jsonValidationError('Validation Failed: rule_suite_result must be pass, fail, bypass, or all.');
  }

  const evaluateStatus = url.searchParams.get('evaluate_status') ?? 'all';
  if (!RULE_SUITE_EVALUATE_STATUSES.has(evaluateStatus)) {
    return jsonValidationError('Validation Failed: evaluate_status must be all, active, or evaluate.');
  }

  const actorName = url.searchParams.get('actor_name');
  const since = Date.now() - timeWindowMs;
  return suites
    .filter(suite => !ref || ruleSuiteRefMatches(suite.ref, ref))
    .filter(suite => !actorName || suite.actorName === actorName)
    .filter(suite => ruleSuiteResult === 'all' || suite.result === ruleSuiteResult)
    .filter(suite => ruleSuiteMatchesEvaluateStatus(suite, evaluateStatus))
    .filter((suite) => {
      const pushedAt = Date.parse(suite.pushedAt);
      return Number.isFinite(pushedAt) && pushedAt >= since;
    });
}

function buildRuleSuiteSummaryResponse(
  suite: RuleSuiteEntry, targetDid: string, repoName: string,
): Record<string, unknown> {
  return {
    id              : suite.id,
    actor_id        : suite.actorId ?? numericId(suite.actorName),
    actor_name      : suite.actorName,
    before_sha      : suite.beforeSha,
    after_sha       : suite.afterSha,
    ref             : suite.ref,
    repository_id   : suite.repositoryId ?? numericId(`${targetDid}/${repoName}`),
    repository_name : suite.repositoryName ?? repoName,
    pushed_at       : toISODate(suite.pushedAt),
    result          : suite.result,
    ...(suite.evaluationResult ? { evaluation_result: suite.evaluationResult } : {}),
  };
}

function buildRuleEvaluationResponse(
  evaluation: NonNullable<RuleSuiteEntry['ruleEvaluations']>[number],
): Record<string, unknown> {
  return {
    rule_source : { ...evaluation.ruleSource },
    enforcement : evaluation.enforcement,
    result      : evaluation.result,
    rule_type   : evaluation.ruleType,
    ...(evaluation.details ? { details: evaluation.details } : {}),
  };
}

function buildRuleSuiteDetailResponse(
  suite: RuleSuiteEntry, targetDid: string, repoName: string,
): Record<string, unknown> {
  return {
    ...buildRuleSuiteSummaryResponse(suite, targetDid, repoName),
    rule_evaluations: (suite.ruleEvaluations ?? []).map(buildRuleEvaluationResponse),
  };
}

async function findRuleSuite(
  ctx: AgentContext, targetDid: string, repoName: string, ruleSuiteId: string,
): Promise<{ lookup: RepoSettingsLookup; suite: RuleSuiteEntry } | JsonResponse> {
  const id = parseInt(ruleSuiteId, 10);
  if (!Number.isInteger(id) || id < 1) {
    return jsonNotFound(`Rule suite '${ruleSuiteId}' not found.`);
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const suite = lookup.settings.ruleSuites?.[String(id)];
  if (!suite) {
    return jsonNotFound(`Rule suite '${ruleSuiteId}' not found.`);
  }

  return { lookup, suite };
}

function buildDeployKeyResponse(
  deployKey: DeployKeyEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const base = `${baseUrl}/repos/${targetDid}/${repoName}`;
  return {
    id         : deployKey.id,
    key        : deployKey.key,
    url        : `${base}/keys/${deployKey.id}`,
    title      : deployKey.title,
    verified   : deployKey.verified ?? true,
    created_at : toISODate(deployKey.createdAt),
    read_only  : deployKey.readOnly,
    added_by   : deployKey.addedBy ?? null,
    last_used  : deployKey.lastUsed ? toISODate(deployKey.lastUsed) : null,
    enabled    : deployKey.enabled ?? true,
  };
}

async function findDeployKey(
  ctx: AgentContext, targetDid: string, repoName: string, keyId: string,
): Promise<{ lookup: RepoSettingsLookup; deployKey: DeployKeyEntry; key: string } | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const id = parseInt(keyId, 10);
  const key = deployKeyRecordKey(id);
  const deployKey = lookup.settings.deployKeys?.[key];
  if (!deployKey) {
    return jsonNotFound(`Deploy key ${keyId} not found.`);
  }

  return { lookup, deployKey, key };
}

// ---------------------------------------------------------------------------
// GET/PUT /repos/:did/:repo/topics
// ---------------------------------------------------------------------------

export async function handleGetTopics(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  return jsonOk({ names: await listTopicNames(ctx, targetDid, repo) });
}

export async function handleReplaceTopics(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const names = reqBody.names;
  if (!Array.isArray(names)) {
    return jsonValidationError('Validation Failed: names must be an array.');
  }
  if (names.length > 20) {
    return jsonValidationError('Validation Failed: no more than 20 topics are allowed.');
  }

  const normalized = new Set<string>();
  for (const name of names) {
    const topic = normalizeTopicName(name);
    if (!topic) {
      return jsonValidationError('Validation Failed: topic names must be 1-50 characters and contain only letters, numbers, dots, hyphens, or underscores.');
    }
    normalized.add(topic);
  }

  const existing = await listTopicRecords(ctx, targetDid, repo);
  for (const topic of existing) {
    const { status } = await topic.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete topic '${topic.name}': ${status.detail}`);
    }
  }

  for (const name of normalized) {
    const { status } = await ctx.repo.records.create('repo/topic' as any, {
      data            : { name },
      tags            : { name },
      parentContextId : repo.contextId,
    } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to create topic '${name}': ${status.detail}`);
    }
  }

  return jsonOk({ names: [...normalized].sort((a, b) => a.localeCompare(b)) });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/languages
// ---------------------------------------------------------------------------

export async function handleGetLanguages(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }
  if (!repo.language) {
    return jsonOk({});
  }
  return jsonOk({ [repo.language]: 0 });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/issue-types
// ---------------------------------------------------------------------------

export async function handleListRepositoryIssueTypes(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk(issueTypeEntries(lookup.settings, lookup.repo).map(buildIssueTypeResponse));
}

// ---------------------------------------------------------------------------
// GET/PATCH /repos/:did/:repo/code-scanning/alerts
// ---------------------------------------------------------------------------

export async function handleListCodeScanningAlerts(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const filtered = filterCodeScanningAlerts(codeScanningAlertEntries(lookup.settings), url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/code-scanning/alerts`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(alert => buildCodeScanningAlertResponse(alert, targetDid, lookup.repo, baseUrl)),
    extraHeaders,
  );
}

export async function handleGetCodeScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, url: URL,
): Promise<JsonResponse> {
  const result = await findCodeScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  return jsonOk(buildCodeScanningAlertResponse(result.alert, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleUpdateCodeScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await findCodeScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const updated = validateCodeScanningAlertUpdate(reqBody, result.alert, ctx.did);
  if ('status' in updated) { return updated; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    settingsWithCodeScanningAlert(result.lookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildCodeScanningAlertResponse(updated, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleListCodeScanningAlertInstances(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, url: URL,
): Promise<JsonResponse> {
  const result = await findCodeScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const filtered = filterCodeScanningInstances(result.alert, url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${result.lookup.repo.name}/code-scanning/alerts/${result.alert.number}/instances`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildCodeScanningInstanceResponse), extraHeaders);
}

// ---------------------------------------------------------------------------
// GET/PATCH /repos/:did/:repo/dependabot/alerts
// ---------------------------------------------------------------------------

export async function handleListDependabotAlerts(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const filtered = filterDependabotAlerts(dependabotAlertEntries(lookup.settings), url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/dependabot/alerts`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(alert => buildDependabotAlertResponse(alert, targetDid, lookup.repo, baseUrl)),
    extraHeaders,
  );
}

export async function handleGetDependabotAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, url: URL,
): Promise<JsonResponse> {
  const result = await findDependabotAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  return jsonOk(buildDependabotAlertResponse(result.alert, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleUpdateDependabotAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await findDependabotAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const updated = validateDependabotAlertUpdate(reqBody, result.alert, ctx.did);
  if ('status' in updated) { return updated; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    settingsWithDependabotAlert(result.lookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildDependabotAlertResponse(updated, targetDid, result.lookup.repo, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET/PATCH /repos/:did/:repo/secret-scanning/alerts
// ---------------------------------------------------------------------------

export async function handleListSecretScanningAlerts(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const hideSecret = parseBooleanQuery(url, 'hide_secret');
  if (hideSecret !== null && typeof hideSecret !== 'boolean') { return hideSecret; }

  const filtered = filterSecretScanningAlerts(secretScanningAlertEntries(lookup.settings), url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/secret-scanning/alerts`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(alert => buildSecretScanningAlertResponse(alert, targetDid, lookup.repo, baseUrl, hideSecret === true)),
    extraHeaders,
  );
}

export async function handleGetSecretScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, url: URL,
): Promise<JsonResponse> {
  const result = await findSecretScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const hideSecret = parseBooleanQuery(url, 'hide_secret');
  if (hideSecret !== null && typeof hideSecret !== 'boolean') { return hideSecret; }

  return jsonOk(buildSecretScanningAlertResponse(
    result.alert, targetDid, result.lookup.repo, buildApiUrl(url), hideSecret === true,
  ));
}

export async function handleUpdateSecretScanningAlert(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await findSecretScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const updated = validateSecretScanningAlertUpdate(reqBody, result.alert, ctx.did);
  if ('status' in updated) { return updated; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    settingsWithSecretScanningAlert(result.lookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildSecretScanningAlertResponse(updated, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleListSecretScanningAlertLocations(
  ctx: AgentContext, targetDid: string, repoName: string, alertNumber: string, url: URL,
): Promise<JsonResponse> {
  const result = await findSecretScanningAlert(ctx, targetDid, repoName, alertNumber);
  if ('status' in result) { return result; }

  const locations = result.alert.locations ?? [];
  const pagination = parsePagination(url);
  const paged = paginate(locations, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${result.lookup.repo.name}/secret-scanning/alerts/${result.alert.number}/locations`,
    pagination.page, pagination.perPage, locations.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildSecretScanningLocationResponse), extraHeaders);
}

export async function handleGetSecretScanningScanHistory(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildSecretScanningScanHistoryResponse(lookup.settings, lookup.repo));
}

export async function handleCreateSecretScanningPushProtectionBypass(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = validateSecretScanningPushProtectionBypass(reqBody);
  if ('status' in parsed) { return parsed; }

  const existing = lookup.settings.secretScanningPushProtectionBypasses?.[parsed.placeholderId];
  if (!existing) {
    return jsonNotFound(`Push protection bypass placeholder '${parsed.placeholderId}' not found.`);
  }

  const now = new Date().toISOString();
  const updated: SecretScanningBypassEntry = {
    ...existing,
    placeholderId : parsed.placeholderId,
    reason        : parsed.reason,
    expireAt      : existing.expireAt ?? new Date(Date.now() + (3 * 60 * 60 * 1000)).toISOString(),
    createdAt     : now,
    createdBy     : ctx.did,
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithSecretScanningPushProtectionBypass(lookup.settings, parsed.placeholderId, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(secretScanningPushProtectionBypassResponse(updated));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/security-advisories
// ---------------------------------------------------------------------------

export async function handleListSecurityAdvisories(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const filtered = filterSecurityAdvisories(securityAdvisoryEntries(lookup.settings), url);
  if ('status' in filtered) { return filtered; }

  const pagination = parsePagination(url);
  const paged = paginate(filtered, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/security-advisories`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(advisory => buildSecurityAdvisoryResponse(advisory, targetDid, lookup.repo, baseUrl)),
    extraHeaders,
  );
}

export async function handleCreateSecurityAdvisory(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const advisory = buildSecurityAdvisoryFromBody(reqBody, lookup.settings, lookup.repo, ctx.did, targetDid, false);
  if ('status' in advisory) { return advisory; }

  const key = securityAdvisoryRecordKey(advisory.ghsaId);
  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithSecurityAdvisory(lookup.settings, key, advisory),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildSecurityAdvisoryResponse(advisory, targetDid, lookup.repo, buildApiUrl(url)));
}

export async function handlePrivatelyReportSecurityVulnerability(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const advisory = buildSecurityAdvisoryFromBody(reqBody, lookup.settings, lookup.repo, ctx.did, targetDid, true);
  if ('status' in advisory) { return advisory; }

  const key = securityAdvisoryRecordKey(advisory.ghsaId);
  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithSecurityAdvisory(lookup.settings, key, advisory),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildSecurityAdvisoryResponse(advisory, targetDid, lookup.repo, buildApiUrl(url)));
}

export async function handleGetSecurityAdvisory(
  ctx: AgentContext, targetDid: string, repoName: string, ghsaId: string, url: URL,
): Promise<JsonResponse> {
  const result = await findSecurityAdvisory(ctx, targetDid, repoName, ghsaId);
  if ('status' in result) { return result; }

  return jsonOk(buildSecurityAdvisoryResponse(result.advisory, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleUpdateSecurityAdvisory(
  ctx: AgentContext, targetDid: string, repoName: string, ghsaId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const result = await findSecurityAdvisory(ctx, targetDid, repoName, ghsaId);
  if ('status' in result) { return result; }

  const updated = updateSecurityAdvisoryFromBody(result.advisory, reqBody, ctx.did);
  if ('status' in updated) { return updated; }

  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    settingsWithSecurityAdvisory(result.lookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildSecurityAdvisoryResponse(updated, targetDid, result.lookup.repo, buildApiUrl(url)));
}

export async function handleRequestSecurityAdvisoryCve(
  ctx: AgentContext, targetDid: string, repoName: string, ghsaId: string,
): Promise<JsonResponse> {
  const result = await findSecurityAdvisory(ctx, targetDid, repoName, ghsaId);
  if ('status' in result) { return result; }

  const now = new Date().toISOString();
  const updated: SecurityAdvisoryEntry = {
    ...result.advisory,
    cveRequestedAt : now,
    updatedAt      : now,
  };
  const saveError = await saveRepoSettings(
    ctx,
    result.lookup,
    settingsWithSecurityAdvisory(result.lookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonAccepted({});
}

export async function handleCreateSecurityAdvisoryPrivateFork(
  ctx: AgentContext, targetDid: string, repoName: string, ghsaId: string,
): Promise<JsonResponse> {
  const result = await findSecurityAdvisory(ctx, targetDid, repoName, ghsaId);
  if ('status' in result) { return result; }

  const updated: SecurityAdvisoryEntry = result.advisory.privateFork
    ? result.advisory
    : {
      ...result.advisory,
      privateFork : securityAdvisoryPrivateForkSeed(result.advisory, targetDid, result.lookup.repo),
      updatedAt   : new Date().toISOString(),
    };
  if (updated !== result.advisory) {
    const saveError = await saveRepoSettings(
      ctx,
      result.lookup,
      settingsWithSecurityAdvisory(result.lookup.settings, result.key, updated),
    );
    if (saveError) { return saveError; }
  }

  return jsonAccepted({});
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/keys
// ---------------------------------------------------------------------------

export async function handleListDeployKeys(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const deployKeys = deployKeyEntries(lookup.settings);
  const paged = paginate(deployKeys, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/keys`,
    pagination.page, pagination.perPage, deployKeys.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(deployKey => buildDeployKeyResponse(deployKey, targetDid, lookup.repo.name, baseUrl)),
    extraHeaders,
  );
}

export async function handleCreateDeployKey(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  if (typeof reqBody.key !== 'string' || reqBody.key.trim().length === 0) {
    return jsonValidationError('Validation Failed: key is required.');
  }
  if (typeof reqBody.title !== 'undefined' && typeof reqBody.title !== 'string') {
    return jsonValidationError('Validation Failed: title must be a string.');
  }
  if (typeof reqBody.read_only !== 'undefined' && typeof reqBody.read_only !== 'boolean') {
    return jsonValidationError('Validation Failed: read_only must be a boolean.');
  }

  const key = reqBody.key.trim();
  const existing = deployKeyEntries(lookup.settings).find(deployKey => deployKey.key === key);
  if (existing) {
    return jsonValidationError('Validation Failed: key is already in use.');
  }

  const title = typeof reqBody.title === 'string' && reqBody.title.trim()
    ? reqBody.title.trim()
    : 'Deploy key';
  const id = nextDeployKeyId(lookup.settings);
  const deployKey: DeployKeyEntry = {
    id,
    key,
    title,
    readOnly  : typeof reqBody.read_only === 'boolean' ? reqBody.read_only : true,
    verified  : true,
    addedBy   : ctx.did,
    lastUsed  : null,
    enabled   : true,
    createdAt : new Date().toISOString(),
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithDeployKey(lookup.settings, deployKeyRecordKey(id), deployKey),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildDeployKeyResponse(deployKey, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleGetDeployKey(
  ctx: AgentContext, targetDid: string, repoName: string, keyId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findDeployKey(ctx, targetDid, repoName, keyId);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildDeployKeyResponse(lookup.deployKey, targetDid, lookup.lookup.repo.name, buildApiUrl(url)));
}

export async function handleDeleteDeployKey(
  ctx: AgentContext, targetDid: string, repoName: string, keyId: string,
): Promise<JsonResponse> {
  const lookup = await findDeployKey(ctx, targetDid, repoName, keyId);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(
    ctx,
    lookup.lookup,
    settingsWithDeployKey(lookup.lookup.settings, lookup.key, null),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/autolinks
// ---------------------------------------------------------------------------

export async function handleListAutolinks(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk(autolinkEntries(lookup.settings).map(buildAutolinkResponse));
}

export async function handleCreateAutolink(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = validateAutolinkBody(reqBody);
  if ('status' in parsed) { return parsed; }

  const duplicate = autolinkEntries(lookup.settings)
    .find(autolink => autolink.keyPrefix.toLowerCase() === parsed.keyPrefix.toLowerCase());
  if (duplicate) {
    return jsonValidationError('Validation Failed: key_prefix is already in use.');
  }

  const id = nextAutolinkId(lookup.settings);
  const autolink: AutolinkEntry = { ...parsed, id };
  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithAutolink(lookup.settings, autolinkRecordKey(id), autolink),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildAutolinkResponse(autolink));
}

export async function handleGetAutolink(
  ctx: AgentContext, targetDid: string, repoName: string, autolinkId: string,
): Promise<JsonResponse> {
  const lookup = await findAutolink(ctx, targetDid, repoName, autolinkId);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildAutolinkResponse(lookup.autolink));
}

export async function handleDeleteAutolink(
  ctx: AgentContext, targetDid: string, repoName: string, autolinkId: string,
): Promise<JsonResponse> {
  const lookup = await findAutolink(ctx, targetDid, repoName, autolinkId);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(
    ctx,
    lookup.lookup,
    settingsWithAutolink(lookup.lookup.settings, lookup.key, null),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/interaction-limits
// ---------------------------------------------------------------------------

export async function handleGetInteractionLimit(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const limit = activeInteractionLimit(lookup.settings);
  return jsonOk(limit ? buildInteractionLimitResponse(limit) : {});
}

export async function handleSetInteractionLimit(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = validateInteractionLimitBody(reqBody);
  if ('status' in parsed) { return parsed; }

  const settings = { ...lookup.settings, interactionLimit: parsed };
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonOk(buildInteractionLimitResponse(parsed));
}

export async function handleDeleteInteractionLimit(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const settings = { ...lookup.settings };
  delete settings.interactionLimit;
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/vulnerability-alerts and /automated-security-fixes
// ---------------------------------------------------------------------------

export async function handleCheckVulnerabilityAlerts(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return lookup.settings.vulnerabilityAlertsEnabled
    ? jsonNoContent()
    : jsonNotFound('Vulnerability alerts are not enabled for this repository.');
}

export async function handleEnableVulnerabilityAlerts(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    vulnerabilityAlertsEnabled: true,
  });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleDisableVulnerabilityAlerts(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const settings = { ...lookup.settings };
  delete settings.vulnerabilityAlertsEnabled;
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleCheckAutomatedSecurityFixes(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return lookup.settings.automatedSecurityFixesEnabled
    ? jsonOk({ enabled: true, paused: lookup.settings.automatedSecurityFixesPaused ?? false })
    : jsonNotFound('Dependabot security updates are not enabled for this repository.');
}

export async function handleEnableAutomatedSecurityFixes(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    automatedSecurityFixesEnabled : true,
    automatedSecurityFixesPaused  : false,
  });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleDisableAutomatedSecurityFixes(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const settings = { ...lookup.settings };
  delete settings.automatedSecurityFixesEnabled;
  delete settings.automatedSecurityFixesPaused;
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// Repository custom properties, dispatches, hash metadata, and policy toggles
// ---------------------------------------------------------------------------

export async function handleGetRepositoryCustomProperties(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk(customPropertyEntries(lookup.settings));
}

export async function handleUpdateRepositoryCustomProperties(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = validateCustomPropertiesBody(reqBody);
  if ('status' in parsed) { return parsed; }

  const customProperties = { ...(lookup.settings.customProperties ?? {}) };
  for (const [propertyName, value] of Object.entries(parsed.values)) {
    if (value === null) {
      delete customProperties[propertyName];
    } else {
      customProperties[propertyName] = value;
    }
  }

  const settings = { ...lookup.settings };
  if (Object.keys(customProperties).length > 0) {
    settings.customProperties = customProperties;
  } else {
    delete settings.customProperties;
  }

  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleCreateRepositoryDispatch(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const validationError = validateRepositoryDispatchBody(reqBody);
  if (validationError) { return validationError; }

  return jsonNoContent();
}

export async function handleGetRepositoryHashAlgorithm(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  return jsonOk({ hash_algorithm: 'sha1' });
}

export async function handleListCodeownersErrors(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  return jsonOk({ errors: [] });
}

export async function handleCheckImmutableReleases(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return lookup.settings.immutableReleasesEnabled
    ? jsonOk({ enabled: true, enforced_by_owner: false })
    : jsonNotFound('Immutable releases are not enabled for this repository.');
}

export async function handleEnableImmutableReleases(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    immutableReleasesEnabled: true,
  });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleDisableImmutableReleases(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const settings = { ...lookup.settings };
  delete settings.immutableReleasesEnabled;
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleGetPrivateVulnerabilityReporting(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  return jsonOk({ enabled: lookup.settings.privateVulnerabilityReportingEnabled ?? false });
}

export async function handleEnablePrivateVulnerabilityReporting(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(ctx, lookup, {
    ...lookup.settings,
    privateVulnerabilityReportingEnabled: true,
  });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleDisablePrivateVulnerabilityReporting(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const settings = { ...lookup.settings };
  delete settings.privateVulnerabilityReportingEnabled;
  const saveError = await saveRepoSettings(ctx, lookup, settings);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleCreateRepositoryAttestation(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  if (!isPlainObject(reqBody.bundle)) {
    return jsonValidationError('Validation Failed: bundle is required.');
  }

  const subjectDigest = extractAttestationSubjectDigest(reqBody.bundle, reqBody);
  if (!subjectDigest) {
    return jsonValidationError('Validation Failed: bundle subject digest must include a sha256 digest.');
  }

  const predicateType = extractAttestationPredicateType(reqBody.bundle);
  const attestation: AttestationEntry = {
    id        : nextAttestationId(lookup.settings),
    subjectDigest,
    ...(predicateType ? { predicateType } : {}),
    bundle    : reqBody.bundle,
    createdAt : new Date().toISOString(),
  };

  const saveError = await saveRepoSettings(ctx, lookup, settingsWithAttestation(lookup.settings, attestation));
  if (saveError) { return saveError; }

  return jsonCreated(buildAttestationResponse(attestation, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleListRepositoryAttestations(
  ctx: AgentContext, targetDid: string, repoName: string, encodedSubjectDigest: string, url: URL,
): Promise<JsonResponse> {
  const subjectDigest = normalizeSubjectDigest(decodeRouteParam(encodedSubjectDigest));
  if (!subjectDigest) {
    return jsonValidationError('Validation Failed: subject_digest must be sha256:<64 hex characters>.');
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const predicateType = url.searchParams.get('predicate_type');
  const attestations = attestationEntries(lookup.settings)
    .filter(attestation => attestation.subjectDigest === subjectDigest)
    .filter(attestation => !predicateType || attestation.predicateType === predicateType);

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(attestations, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/attestations/${encodeURIComponent(subjectDigest)}`,
    pagination.page, pagination.perPage, attestations.length,
  );
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }

  return jsonOk({
    attestations: paged.map(attestation => buildAttestationResponse(attestation, targetDid, lookup.repo.name, baseUrl)),
  }, headers);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/rules and /rulesets
// ---------------------------------------------------------------------------

export async function handleGetRulesForBranch(
  ctx: AgentContext, targetDid: string, repoName: string, encodedBranch: string, url: URL,
): Promise<JsonResponse> {
  const branch = decodeRouteParam(encodedBranch);
  if (branch.includes('*')) {
    return jsonValidationError('Validation Failed: branch cannot contain wildcard characters.');
  }

  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const rules = rulesetEntries(lookup.settings)
    .filter(ruleset => rulesetMatchesBranch(ruleset, branch, lookup.repo.defaultBranch))
    .flatMap(ruleset => ruleset.rules.map(rule => buildBranchRuleResponse(rule, ruleset, targetDid, lookup.repo.name)));

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(rules, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/rules/branches/${encodeURIComponent(branch)}`,
    pagination.page, pagination.perPage, rules.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged, extraHeaders);
}

export async function handleListRepositoryRulesets(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const targetsParam = url.searchParams.get('targets');
  const targetFilter = new Set<string>();
  if (targetsParam) {
    for (const target of targetsParam.split(',').map(item => item.trim()).filter(Boolean)) {
      if (!RULESET_TARGETS.has(target)) {
        return jsonValidationError('Validation Failed: targets must contain only branch, tag, or push.');
      }
      targetFilter.add(target);
    }
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const rulesets = rulesetEntries(lookup.settings)
    .filter(ruleset => targetFilter.size === 0 || targetFilter.has(ruleset.target));
  const paged = paginate(rulesets, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/rulesets`,
    pagination.page, pagination.perPage, rulesets.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(ruleset => buildRulesetSummaryResponse(ruleset, targetDid, lookup.repo.name, baseUrl)),
    extraHeaders,
  );
}

export async function handleListRepositoryRuleSuites(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const suites = filterRuleSuites(ruleSuiteEntries(lookup.settings), url);
  if ('status' in suites) { return suites; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(suites, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/rulesets/rule-suites`,
    pagination.page, pagination.perPage, suites.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(suite => buildRuleSuiteSummaryResponse(suite, targetDid, lookup.repo.name)),
    extraHeaders,
  );
}

export async function handleGetRepositoryRuleSuite(
  ctx: AgentContext, targetDid: string, repoName: string, ruleSuiteId: string,
): Promise<JsonResponse> {
  const lookup = await findRuleSuite(ctx, targetDid, repoName, ruleSuiteId);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildRuleSuiteDetailResponse(lookup.suite, targetDid, lookup.lookup.repo.name));
}

export async function handleCreateRepositoryRuleset(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const parsed = validateRulesetBody(reqBody);
  if ('status' in parsed) { return parsed; }

  const now = new Date().toISOString();
  const id = nextRulesetId(lookup.settings);
  const ruleset: RulesetEntry = {
    id,
    name        : parsed.name!,
    target      : parsed.target!,
    enforcement : parsed.enforcement!,
    ...(parsed.bypassActors ? { bypassActors: parsed.bypassActors } : {}),
    ...(parsed.conditions ? { conditions: parsed.conditions } : {}),
    rules       : parsed.rules ?? [],
    versionId   : 1,
    createdAt   : now,
    updatedAt   : now,
  };
  ruleset.history = {
    '1': {
      versionId : 1,
      actorDid  : ctx.did,
      updatedAt : now,
      state     : copyRulesetState(ruleset),
    },
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithRuleset(lookup.settings, rulesetRecordKey(id), ruleset),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildRulesetResponse(ruleset, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleGetRepositoryRuleset(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRuleset(ctx, targetDid, repoName, rulesetId);
  if ('status' in lookup) { return lookup; }

  return jsonOk(buildRulesetResponse(lookup.ruleset, targetDid, lookup.lookup.repo.name, buildApiUrl(url)));
}

export async function handleUpdateRepositoryRuleset(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRuleset(ctx, targetDid, repoName, rulesetId);
  if ('status' in lookup) { return lookup; }

  const parsed = validateRulesetBody(reqBody, lookup.ruleset);
  if ('status' in parsed) { return parsed; }

  const now = new Date().toISOString();
  const versionId = lookup.ruleset.versionId + 1;
  const history = { ...(lookup.ruleset.history ?? {}) };
  const existingHistoryKey = rulesetRecordKey(lookup.ruleset.versionId);
  if (!history[existingHistoryKey]) {
    history[existingHistoryKey] = {
      versionId : lookup.ruleset.versionId,
      actorDid  : ctx.did,
      updatedAt : lookup.ruleset.updatedAt,
      state     : copyRulesetState(lookup.ruleset),
    };
  }

  const updated: RulesetEntry = {
    ...lookup.ruleset,
    ...parsed,
    versionId,
    updatedAt: now,
  };
  updated.history = {
    ...history,
    [rulesetRecordKey(versionId)]: {
      versionId,
      actorDid  : ctx.did,
      updatedAt : now,
      state     : copyRulesetState(updated),
    },
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup.lookup,
    settingsWithRuleset(lookup.lookup.settings, lookup.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildRulesetResponse(updated, targetDid, lookup.lookup.repo.name, buildApiUrl(url)));
}

export async function handleDeleteRepositoryRuleset(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string,
): Promise<JsonResponse> {
  const lookup = await findRuleset(ctx, targetDid, repoName, rulesetId);
  if ('status' in lookup) { return lookup; }

  const saveError = await saveRepoSettings(
    ctx,
    lookup.lookup,
    settingsWithRuleset(lookup.lookup.settings, lookup.key, null),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleListRepositoryRulesetHistory(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRuleset(ctx, targetDid, repoName, rulesetId);
  if ('status' in lookup) { return lookup; }

  const history = Object.values(lookup.ruleset.history ?? {})
    .sort((a, b) => b.versionId - a.versionId);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(history, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.lookup.repo.name}/rulesets/${lookup.ruleset.id}/history`,
    pagination.page, pagination.perPage, history.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildRulesetHistoryEntry), extraHeaders);
}

export async function handleGetRepositoryRulesetVersion(
  ctx: AgentContext, targetDid: string, repoName: string, rulesetId: string, versionId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findRuleset(ctx, targetDid, repoName, rulesetId);
  if ('status' in lookup) { return lookup; }

  const version = parseInt(versionId, 10);
  const entry = Number.isInteger(version) ? lookup.ruleset.history?.[rulesetRecordKey(version)] : undefined;
  if (!entry) {
    return jsonNotFound(`Ruleset version '${versionId}' not found.`);
  }

  return jsonOk({
    ...buildRulesetHistoryEntry(entry),
    state: buildRulesetResponse(entry.state, targetDid, lookup.lookup.repo.name, buildApiUrl(url)),
  });
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/assignees
// ---------------------------------------------------------------------------

export async function handleListAssignees(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const collaborators = await listCollaborators(ctx, targetDid, repo);
  const paged = paginate(collaborators, pagination);
  const items = paged.map((collab) => buildCollaboratorUser(collab, baseUrl));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/assignees`,
    pagination.page, pagination.perPage, collaborators.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCheckAssignee(
  ctx: AgentContext, targetDid: string, repoName: string, encodedDid: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const did = decodeRouteParam(encodedDid);
  const collab = await findCollaborator(ctx, targetDid, repo, did);
  return collab ? jsonNoContent() : jsonNotFound(`Assignee '${did}' not found.`);
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/collaborators
// ---------------------------------------------------------------------------

export async function handleListCollaborators(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const affiliationFilter = collaboratorAffiliationFilter(url.searchParams.get('affiliation'));
  if (!affiliationFilter) {
    return jsonValidationError('Validation Failed: affiliation must be one of outside, direct, or all.');
  }

  const permissionParam = url.searchParams.get('permission');
  const permissionFilter = collaboratorPermissionFilter(permissionParam);
  if (permissionParam && !permissionFilter) {
    return jsonValidationError('Validation Failed: permission must be one of pull, triage, push, maintain, or admin.');
  }

  const collaborators = await listCollaborators(ctx, targetDid, repo);
  let filtered = collaborators.filter(collab => collaboratorMatchesAffiliation(collab, targetDid, affiliationFilter));
  if (permissionFilter) {
    filtered = filtered.filter(collab => collaboratorHasPermission(collab, permissionFilter));
  }
  const paged = paginate(filtered, pagination);
  const items = paged.map((collab) => buildCollaboratorResponse(collab, baseUrl));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/collaborators`,
    pagination.page, pagination.perPage, filtered.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

export async function handleCheckCollaborator(
  ctx: AgentContext, targetDid: string, repoName: string, encodedDid: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const did = decodeRouteParam(encodedDid);
  const collab = await findCollaborator(ctx, targetDid, repo, did);
  return collab ? jsonNoContent() : jsonNotFound(`Collaborator '${did}' not found.`);
}

export async function handleGetCollaboratorPermission(
  ctx: AgentContext, targetDid: string, repoName: string, encodedDid: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const did = decodeRouteParam(encodedDid);
  const collab = await findCollaborator(ctx, targetDid, repo, did);
  if (!collab) {
    return jsonNotFound(`Collaborator '${did}' not found.`);
  }

  return jsonOk(buildPermissionResponse(collab, buildApiUrl(url)));
}

export async function handleAddCollaborator(
  ctx: AgentContext, targetDid: string, repoName: string,
  encodedDid: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const did = decodeRouteParam(encodedDid);
  if (!did.startsWith('did:')) {
    return jsonValidationError('Validation Failed: collaborator must be a DID.');
  }

  const role = roleFromPermission(reqBody.permission);
  if (!role) {
    return jsonValidationError('Validation Failed: permission must be one of pull, triage, push, write, maintain, or admin.');
  }

  const existing = await findCollaborator(ctx, targetDid, repo, did);

  const { status, record } = await ctx.repo.records.create(`repo/${role}` as any, {
    data            : { did, alias: typeof reqBody.alias === 'string' ? reqBody.alias : '' },
    tags            : { did },
    parentContextId : repo.contextId,
    recipient       : did,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to add collaborator: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create collaborator record'); }

  await deleteCollaboratorRoles(ctx, repo, did, record.id);

  if (existing) {
    return jsonNoContent();
  }

  const collab: CollaboratorInfo = {
    did,
    role,
    alias    : typeof reqBody.alias === 'string' ? reqBody.alias : '',
    recordId : record.id ?? `${did}:${role}`,
  };

  return jsonCreated({
    id          : numericId(collab.recordId),
    node_id     : collab.recordId,
    repository  : `${targetDid}/${repoName}`,
    invitee     : buildCollaboratorUser(collab, buildApiUrl(url)),
    permissions : permissionFromRole(role),
    role_name   : role,
  });
}

export async function handleRemoveCollaborator(
  ctx: AgentContext, targetDid: string, repoName: string, encodedDid: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const did = decodeRouteParam(encodedDid);
  const deleted = await deleteCollaboratorRoles(ctx, repo, did);
  return deleted > 0 ? jsonNoContent() : jsonNotFound(`Collaborator '${did}' not found.`);
}
