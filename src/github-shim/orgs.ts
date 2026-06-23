/**
 * GitHub API shim - organization and team endpoints.
 *
 * Maps forge-org records onto GitHub REST API v3 organization, membership,
 * and team routes.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { OrgBlockedUserData } from '../org.js';
import type { OrgCustomPropertyData } from '../org.js';
import type { OrgData } from '../org.js';
import type { OrgIssueFieldData } from '../org.js';
import type { OrgIssueFieldOptionData } from '../org.js';
import type { OrgIssueTypeData } from '../org.js';
import type { OrgMemberData } from '../org.js';
import type { RepoCreateOptions } from './repos.js';
import type { RepositoryCustomPropertyValue } from '../repo.js';
import type { SettingsData } from '../repo.js';
import type { TeamData } from '../org.js';
import type { TeamMemberData } from '../org.js';
import type { CodeScanningAlertEntry, DependabotAlertEntry, SecretScanningAlertEntry, SecurityAdvisoryEntry } from './repo-metadata.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildCodeScanningAlertResponse,
  buildDependabotAlertResponse,
  buildSecretScanningAlertResponse,
  buildSecurityAdvisoryResponse,
  codeScanningAlertEntries,
  dependabotAlertEntries,
  filterCodeScanningAlerts,
  filterDependabotAlerts,
  filterSecretScanningAlerts,
  filterSecurityAdvisories,
  parseBooleanQuery,
  secretScanningAlertEntries,
  securityAdvisoryEntries,
} from './repo-metadata.js';
import { buildRepoResponse, createRepoForOwner, handleListRepos, listRepoEntries, repoInfoFromRecord } from './repos.js';

import {
  baseHeaders,
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

type OrgEntry = {
  record : any;
  data : OrgData;
  slug : string;
  routeLogin : string;
};

type OrgMemberRole = 'admin' | 'member';

type OrgMemberEntry = {
  record : any;
  data : OrgMemberData;
  role : OrgMemberRole;
};

type OrgBlockedUserEntry = {
  record : any;
  data : OrgBlockedUserData;
};

type TeamEntry = {
  record : any;
  data : TeamData;
  slug : string;
};

type TeamMemberEntry = {
  record : any;
  data : TeamMemberData;
};

type TeamMemberRole = NonNullable<TeamMemberData['role']>;
type TeamMemberRoleFilter = TeamMemberRole | 'all';
type TeamMemberState = NonNullable<TeamMemberData['state']>;
type OrgInvitationRoleFilter = 'all' | 'admin' | 'direct_member' | 'billing_manager' | 'hiring_manager';
type OrgInvitationSourceFilter = 'all' | 'member' | 'scim';

type TeamRepositoryPermission = NonNullable<TeamData['repositories']>[string]['permission'];

type TeamRepositoryGrant = {
  owner : string;
  repo : string;
  permission : TeamRepositoryPermission;
};

type OrgInvitationEntry = {
  did : string;
  members : TeamMemberEntry[];
  teams : TeamEntry[];
};

type OutsideCollaboratorEntry = {
  did : string;
  alias : string;
  recordId : string;
};

type TeamLookup = {
  org : OrgEntry;
  team : TeamEntry;
};

type OrgRepoEntry = {
  record : any;
  repo : RepoInfo;
  name : string;
};

type OrgSecurityAdvisoryItem = {
  advisory : SecurityAdvisoryEntry;
  repo : RepoInfo;
};

type OrgCodeScanningAlertItem = {
  alert : CodeScanningAlertEntry;
  repo : RepoInfo;
};

type OrgDependabotAlertItem = {
  alert : DependabotAlertEntry;
  repo : RepoInfo;
};

type OrgSecretScanningAlertItem = {
  alert : SecretScanningAlertEntry;
  repo : RepoInfo;
};

type OrgIssueFieldEntry = {
  record : any;
  data : OrgIssueFieldData;
};

type OrgIssueTypeEntry = {
  record : any;
  data : OrgIssueTypeData;
};

type OrgCustomPropertyEntry = {
  record : any;
  data : OrgCustomPropertyData;
};

type RepoSettingsEntry = {
  entry : OrgRepoEntry;
  record? : {
    update : (options: { data: SettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : SettingsData;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const REPO_COLLABORATOR_TYPES = ['repo/maintainer', 'repo/contributor', 'repo/triager', 'repo/viewer'] as const;
const ISSUE_FIELD_DATA_TYPES = ['text', 'date', 'single_select', 'multi_select', 'number'] as const;
const ISSUE_FIELD_OPTION_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;
const ISSUE_TYPE_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;
const CUSTOM_PROPERTY_VALUE_TYPES = ['string', 'single_select', 'multi_select', 'true_false', 'url'] as const;
const CUSTOM_PROPERTY_VALUES_EDITABLE_BY = ['org_actors', 'org_and_repo_actors'] as const;

type IssueFieldDataType = typeof ISSUE_FIELD_DATA_TYPES[number];
type IssueFieldOptionColor = typeof ISSUE_FIELD_OPTION_COLORS[number];
type IssueFieldVisibility = NonNullable<OrgIssueFieldData['visibility']>;
type IssueTypeColor = typeof ISSUE_TYPE_COLORS[number];
type CustomPropertyValueType = typeof CUSTOM_PROPERTY_VALUE_TYPES[number];
type CustomPropertyValuesEditableBy = typeof CUSTOM_PROPERTY_VALUES_EDITABLE_BY[number];

function jsonForbidden(message: string): JsonResponse {
  return {
    status  : 403,
    headers : baseHeaders(),
    body    : JSON.stringify({
      message,
      documentation_url: 'https://docs.github.com/rest',
    }),
  };
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || value.trim().toLowerCase();
}

function normalizeOrgRoute(value: string): string {
  return decodeRouteParam(value).trim();
}

function orgMatchesRoute(org: OrgEntry, routeOrg: string, ctxDid: string): boolean {
  const route = normalizeOrgRoute(routeOrg).toLowerCase();
  if (route === ctxDid.toLowerCase()) { return true; }
  if (route === org.data.name.toLowerCase()) { return true; }
  return route === org.slug.toLowerCase();
}

function routeOrgPath(org: OrgEntry): string {
  return encodeURIComponent(org.routeLogin);
}

function parseNumericRouteId(value: string): number | null {
  const id = Number(decodeRouteParam(value));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function orgNumericId(org: OrgEntry): number {
  return numericId(org.record.contextId ?? org.record.id);
}

function teamNumericId(team: TeamEntry): number {
  return numericId(team.record.contextId ?? team.record.id);
}

function issueFieldNumericId(field: OrgIssueFieldEntry): number {
  return numericId(field.record.contextId ?? field.record.id);
}

function issueTypeNumericId(issueType: OrgIssueTypeEntry): number {
  return numericId(issueType.record.contextId ?? issueType.record.id);
}

async function listOrgEntries(ctx: AgentContext): Promise<OrgEntry[]> {
  const { records } = await ctx.org.records.query('org', {
    dateSort: DateSort.CreatedAscending,
  } as any);

  const entries: OrgEntry[] = [];
  for (const record of records) {
    let data: OrgData;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    if (!isNonEmptyString(data.name)) { continue; }

    entries.push({
      record,
      data,
      slug       : slugify(data.name),
      routeLogin : data.name,
    });
  }
  return entries;
}

async function findOrg(ctx: AgentContext, routeOrg: string): Promise<OrgEntry | null> {
  const orgs = await listOrgEntries(ctx);
  return orgs.find(org => orgMatchesRoute(org, routeOrg, ctx.did)) ?? null;
}

async function findOrgByNumericId(ctx: AgentContext, routeOrgId: string): Promise<OrgEntry | null> {
  const orgId = parseNumericRouteId(routeOrgId);
  if (!orgId) { return null; }

  const orgs = await listOrgEntries(ctx);
  return orgs.find(org => orgNumericId(org) === orgId) ?? null;
}

export async function orgRouteExists(ctx: AgentContext, routeOrg: string): Promise<boolean> {
  return (await findOrg(ctx, routeOrg)) !== null;
}

function buildOrgResponse(org: OrgEntry, baseUrl: string): Record<string, unknown> {
  const login = org.routeLogin;
  const encodedLogin = routeOrgPath(org);
  const avatarUrl = org.data.avatar ?? '';

  return {
    login,
    id                        : numericId(org.record.contextId ?? org.record.id),
    node_id                   : org.record.id,
    url                       : `${baseUrl}/orgs/${encodedLogin}`,
    repos_url                 : `${baseUrl}/orgs/${encodedLogin}/repos`,
    events_url                : `${baseUrl}/orgs/${encodedLogin}/events`,
    hooks_url                 : `${baseUrl}/orgs/${encodedLogin}/hooks`,
    issues_url                : `${baseUrl}/orgs/${encodedLogin}/issues`,
    members_url               : `${baseUrl}/orgs/${encodedLogin}/members{/member}`,
    public_members_url        : `${baseUrl}/orgs/${encodedLogin}/public_members{/member}`,
    avatar_url                : avatarUrl,
    description               : org.data.description ?? null,
    name                      : org.data.name,
    company                   : null,
    blog                      : org.data.homepage ?? '',
    location                  : null,
    email                     : null,
    twitter_username          : null,
    is_verified               : false,
    has_organization_projects : false,
    has_repository_projects   : false,
    public_repos              : 0,
    public_gists              : 0,
    followers                 : 0,
    following                 : 0,
    html_url                  : `${baseUrl}/orgs/${encodedLogin}`,
    type                      : 'Organization',
    created_at                : toISODate(org.record.dateCreated),
    updated_at                : toISODate(org.record.timestamp),
  };
}

function buildOrgUser(member: OrgMemberEntry | TeamMemberEntry, baseUrl: string): Record<string, unknown> {
  const user = buildOwner(member.data.did, baseUrl);
  return {
    ...user,
    node_id             : member.record.id,
    gravatar_id         : '',
    followers_url       : `${baseUrl}/users/${member.data.did}/followers`,
    following_url       : `${baseUrl}/users/${member.data.did}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${member.data.did}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${member.data.did}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${member.data.did}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${member.data.did}/orgs`,
    repos_url           : `${baseUrl}/users/${member.data.did}/repos`,
    events_url          : `${baseUrl}/users/${member.data.did}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${member.data.did}/received_events`,
    site_admin          : false,
    ...(member.data.alias ? { name: member.data.alias } : {}),
  };
}

function parseBlockedUserDid(value: string): string | null {
  const did = decodeRouteParam(value).trim();
  return did === '' ? null : did;
}

function blockedUserTags(data: OrgBlockedUserData): Record<string, string> {
  return { did: data.did };
}

function normalizeBlockedUserData(data: unknown): OrgBlockedUserData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { return null; }
  const raw = data as Record<string, unknown>;
  if (!isNonEmptyString(raw.did)) { return null; }
  return {
    did       : raw.did.trim(),
    blockedAt : typeof raw.blockedAt === 'string' ? raw.blockedAt : undefined,
    blockedBy : typeof raw.blockedBy === 'string' ? raw.blockedBy : undefined,
  };
}

function buildBlockedOrgUser(entry: OrgBlockedUserEntry, baseUrl: string): Record<string, unknown> {
  const user = buildOwner(entry.data.did, baseUrl);
  return {
    ...user,
    node_id             : entry.record.id,
    gravatar_id         : '',
    followers_url       : `${baseUrl}/users/${entry.data.did}/followers`,
    following_url       : `${baseUrl}/users/${entry.data.did}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${entry.data.did}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${entry.data.did}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${entry.data.did}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${entry.data.did}/orgs`,
    repos_url           : `${baseUrl}/users/${entry.data.did}/repos`,
    events_url          : `${baseUrl}/users/${entry.data.did}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${entry.data.did}/received_events`,
    site_admin          : false,
  };
}

async function listOrgBlockedUsers(ctx: AgentContext, org: OrgEntry): Promise<OrgBlockedUserEntry[]> {
  const { records } = await ctx.org.records.query('org/blockedUser' as any, {
    filter   : { contextId: org.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const blockedUsers: OrgBlockedUserEntry[] = [];
  for (const record of records) {
    let data: unknown;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }

    const normalized = normalizeBlockedUserData(data);
    if (normalized) {
      blockedUsers.push({ record, data: normalized });
    }
  }
  return blockedUsers.sort((a, b) => a.data.did.localeCompare(b.data.did));
}

async function findOrgBlockedUser(
  ctx: AgentContext, org: OrgEntry, routeUsername: string,
): Promise<OrgBlockedUserEntry | null> {
  const did = parseBlockedUserDid(routeUsername);
  if (!did) { return null; }

  return (await listOrgBlockedUsers(ctx, org))
    .find(blockedUser => blockedUser.data.did === did) ?? null;
}

async function listOrgMembers(ctx: AgentContext, org: OrgEntry): Promise<OrgMemberEntry[]> {
  const entries = await listOrgMemberRecords(ctx, org);

  const byDid = new Map<string, OrgMemberEntry>();
  for (const entry of entries) {
    const existing = byDid.get(entry.data.did);
    if (!existing || entry.role === 'admin') {
      byDid.set(entry.data.did, entry);
    }
  }

  return [...byDid.values()];
}

async function listOrgMemberRecords(ctx: AgentContext, org: OrgEntry): Promise<OrgMemberEntry[]> {
  const entries: OrgMemberEntry[] = [];

  for (const [recordType, role] of [
    ['org/owner', 'admin'],
    ['org/member', 'member'],
  ] as const) {
    const { records } = await ctx.org.records.query(recordType as any, {
      filter   : { contextId: org.record.contextId ?? '' },
      dateSort : DateSort.CreatedAscending,
    } as any);

    for (const record of records) {
      let data: OrgMemberData;
      try {
        data = await record.data.json();
      } catch {
        continue;
      }
      if (isNonEmptyString(data.did)) {
        entries.push({ record, data, role });
      }
    }
  }

  return entries;
}

async function findOrgMember(ctx: AgentContext, org: OrgEntry, did: string): Promise<OrgMemberEntry | null> {
  const members = await listOrgMembers(ctx, org);
  return members.find(member => member.data.did === did) ?? null;
}

function orgMemberRecordType(role: OrgMemberRole): 'org/owner' | 'org/member' {
  return role === 'admin' ? 'org/owner' : 'org/member';
}

function orgMembershipRole(value: unknown): OrgMemberRole | null {
  if (value === undefined || value === null) { return 'member'; }
  if (value === 'admin' || value === 'member') { return value; }
  return null;
}

function orgMemberIsPublic(member: OrgMemberEntry): boolean {
  return member.data.public !== false;
}

async function setOrgMemberPublicVisibility(member: OrgMemberEntry, visible: boolean): Promise<OrgMemberEntry | JsonResponse> {
  const nextData: OrgMemberData = { ...member.data, public: visible };
  const { status } = await member.record.update({ data: nextData });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update public organization membership: ${status.detail}`);
  }
  return { ...member, data: nextData };
}

function teamPrivacyFromGitHub(value: unknown): 'visible' | 'secret' | null {
  if (value === undefined || value === null) { return 'visible'; }
  if (value === 'closed' || value === 'visible') { return 'visible'; }
  if (value === 'secret') { return 'secret'; }
  return null;
}

function teamPrivacyToGitHub(value: TeamData['privacy']): 'closed' | 'secret' {
  return value === 'secret' ? 'secret' : 'closed';
}

function teamRepositoryPermission(value: unknown): TeamRepositoryPermission | null {
  if (value === undefined || value === null) { return 'pull'; }
  if (value === 'pull' || value === 'triage' || value === 'push' || value === 'maintain' || value === 'admin') {
    return value;
  }
  return null;
}

function teamMemberRole(value: unknown): TeamMemberRole | null {
  if (value === undefined || value === null) { return 'member'; }
  if (value === 'member' || value === 'maintainer') { return value; }
  return null;
}

function teamMemberRoleFilter(value: string | null): TeamMemberRoleFilter | null {
  if (value === null || value === '' || value === 'all') { return 'all'; }
  if (value === 'member' || value === 'maintainer') { return value; }
  return null;
}

function teamMemberEffectiveRole(member: TeamMemberEntry, orgOwnerDids: Set<string>): TeamMemberRole {
  if (orgOwnerDids.has(member.data.did)) { return 'maintainer'; }
  return teamMemberRole(member.data.role) ?? 'member';
}

function teamMemberState(member: TeamMemberEntry): TeamMemberState {
  return member.data.state === 'pending' ? 'pending' : 'active';
}

function teamMemberIsActive(member: TeamMemberEntry): boolean {
  return teamMemberState(member) === 'active';
}

function orgOwnerDidSet(members: OrgMemberEntry[]): Set<string> {
  return new Set(members.filter(member => member.role === 'admin').map(member => member.data.did));
}

function orgMemberDidSet(members: OrgMemberEntry[]): Set<string> {
  return new Set(members.map(member => member.data.did));
}

function orgInvitationRoleFilter(value: string | null): OrgInvitationRoleFilter | null {
  if (value === null || value === '' || value === 'all') { return 'all'; }
  if (value === 'admin' || value === 'direct_member' || value === 'billing_manager' || value === 'hiring_manager') {
    return value;
  }
  return null;
}

function orgInvitationSourceFilter(value: string | null): OrgInvitationSourceFilter | null {
  if (value === null || value === '' || value === 'all') { return 'all'; }
  if (value === 'member' || value === 'scim') { return value; }
  return null;
}

function outsideCollaboratorFilter(value: string | null): 'all' | '2fa_disabled' | '2fa_insecure' | null {
  if (value === null || value === '' || value === 'all') { return 'all'; }
  if (value === '2fa_disabled' || value === '2fa_insecure') { return value; }
  return null;
}

function orgInvitationId(org: OrgEntry, did: string): number {
  return numericId(`org-invitation:${org.record.contextId ?? org.record.id}:${did}`);
}

function teamRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function teamRepositoryGrants(team: TeamEntry): Record<string, TeamRepositoryGrant> {
  const grants = team.data.repositories;
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) { return {}; }

  const normalized: Record<string, TeamRepositoryGrant> = {};
  for (const [key, grant] of Object.entries(grants)) {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) { continue; }
    const data = grant as Record<string, unknown>;
    const owner = typeof data.owner === 'string' ? data.owner : '';
    const repo = typeof data.repo === 'string' ? data.repo : '';
    const permission = teamRepositoryPermission(data.permission);
    if (!owner || !repo || !permission) { continue; }
    normalized[key] = { owner, repo, permission };
  }
  return normalized;
}

function teamPermissionBooleans(permission: TeamRepositoryPermission): Record<string, boolean> {
  return {
    admin    : permission === 'admin',
    maintain : permission === 'admin' || permission === 'maintain',
    push     : permission === 'admin' || permission === 'maintain' || permission === 'push',
    triage   : permission === 'admin' || permission === 'maintain' || permission === 'push' || permission === 'triage',
    pull     : true,
  };
}

function teamRepositoryRoleName(permission: TeamRepositoryPermission): string {
  if (permission === 'pull') { return 'read'; }
  if (permission === 'push') { return 'write'; }
  return permission;
}

function issueFieldDataType(value: unknown): IssueFieldDataType | null {
  if (typeof value !== 'string') { return null; }
  return (ISSUE_FIELD_DATA_TYPES as readonly string[]).includes(value) ? value as IssueFieldDataType : null;
}

function issueFieldOptionColor(value: unknown): IssueFieldOptionColor | null {
  if (typeof value !== 'string') { return null; }
  return (ISSUE_FIELD_OPTION_COLORS as readonly string[]).includes(value) ? value as IssueFieldOptionColor : null;
}

function issueFieldVisibility(value: unknown): IssueFieldVisibility | null {
  if (value === undefined || value === null) { return 'organization_members_only'; }
  if (value === 'organization_members_only' || value === 'all') { return value; }
  return null;
}

function isIssueFieldSelectType(dataType: IssueFieldDataType): boolean {
  return dataType === 'single_select' || dataType === 'multi_select';
}

function issueFieldTags(data: OrgIssueFieldData): Record<string, string> {
  return {
    name     : data.name,
    dataType : data.dataType,
  };
}

function normalizeIssueFieldData(data: unknown): OrgIssueFieldData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { return null; }
  const raw = data as Record<string, unknown>;
  const dataType = issueFieldDataType(raw.dataType);
  if (!isNonEmptyString(raw.name) || !dataType) { return null; }

  const visibility = issueFieldVisibility(raw.visibility);
  return {
    name        : raw.name.trim(),
    description : typeof raw.description === 'string' || raw.description === null ? raw.description : undefined,
    dataType,
    ...(visibility ? { visibility } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options as OrgIssueFieldOptionData[] } : {}),
  };
}

function sortedIssueFieldOptions(options: OrgIssueFieldOptionData[] | undefined): OrgIssueFieldOptionData[] {
  return [...(options ?? [])].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

function nextIssueFieldOptionId(options: OrgIssueFieldOptionData[]): number {
  let max = 0;
  for (const option of options) {
    if (Number.isSafeInteger(option.id) && (option.id ?? 0) > max) {
      max = option.id ?? 0;
    }
  }
  return max + 1;
}

function buildIssueFieldOptionResponse(
  option: OrgIssueFieldOptionData, index: number, field: OrgIssueFieldEntry,
): Record<string, unknown> {
  return {
    id          : option.id ?? index + 1,
    name        : option.name,
    description : option.description ?? null,
    color       : option.color,
    priority    : option.priority,
    created_at  : toISODate(field.record.dateCreated),
    updated_at  : toISODate(field.record.timestamp),
  };
}

function buildIssueFieldResponse(field: OrgIssueFieldEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id          : issueFieldNumericId(field),
    node_id     : field.record.id,
    name        : field.data.name,
    description : field.data.description ?? null,
    data_type   : field.data.dataType,
    visibility  : field.data.visibility ?? 'organization_members_only',
    created_at  : toISODate(field.record.dateCreated),
    updated_at  : toISODate(field.record.timestamp),
  };

  if (isIssueFieldSelectType(field.data.dataType)) {
    result.options = sortedIssueFieldOptions(field.data.options)
      .map((option, index) => buildIssueFieldOptionResponse(option, index, field));
  }

  return result;
}

function parseIssueFieldDescription(value: unknown): string | null | undefined | JsonResponse {
  if (value === undefined) { return undefined; }
  if (value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: description must be a string or null.');
  }
  return value;
}

function parseIssueFieldOptionDescription(value: unknown): string | null | undefined | JsonResponse {
  if (value === undefined) { return undefined; }
  if (value === null) { return null; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: option description must be a string or null.');
  }
  return value;
}

function parseIssueFieldOptionPriority(value: unknown, fallback: number): number | JsonResponse {
  if (value === undefined || value === null) { return fallback; }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return jsonValidationError('Validation Failed: option priority must be a positive integer.');
  }
  return value;
}

function parseIssueFieldOptionId(value: unknown): number | undefined | JsonResponse {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return jsonValidationError('Validation Failed: option id must be a positive integer.');
  }
  return value;
}

function parseIssueFieldOptions(
  value: unknown,
  dataType: IssueFieldDataType,
  required: boolean,
  existingOptions: OrgIssueFieldOptionData[] = [],
): OrgIssueFieldOptionData[] | undefined | JsonResponse {
  if (value === undefined || value === null) {
    if (required && isIssueFieldSelectType(dataType)) {
      return jsonValidationError('Validation Failed: options are required for single_select and multi_select issue fields.');
    }
    return undefined;
  }

  if (!isIssueFieldSelectType(dataType)) {
    return jsonValidationError('Validation Failed: options are only supported for single_select and multi_select issue fields.');
  }
  if (!Array.isArray(value)) {
    return jsonValidationError('Validation Failed: options must be an array.');
  }
  if (required && value.length === 0) {
    return jsonValidationError('Validation Failed: options are required for single_select and multi_select issue fields.');
  }

  const existingById = new Map<number, OrgIssueFieldOptionData>();
  for (const option of existingOptions) {
    if (Number.isSafeInteger(option.id)) {
      existingById.set(option.id ?? 0, option);
    }
  }

  const seenIds = new Set<number>();
  let nextId = nextIssueFieldOptionId(existingOptions);
  const options: OrgIssueFieldOptionData[] = [];
  for (const [index, rawOption] of value.entries()) {
    if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
      return jsonValidationError('Validation Failed: each option must be an object.');
    }

    const raw = rawOption as Record<string, unknown>;
    if (!isNonEmptyString(raw.name)) {
      return jsonValidationError('Validation Failed: option name is required.');
    }

    const color = issueFieldOptionColor(raw.color);
    if (!color) {
      return jsonValidationError('Validation Failed: option color must be one of gray, blue, green, yellow, orange, red, pink, or purple.');
    }

    const optionId = parseIssueFieldOptionId(raw.id);
    if (typeof optionId !== 'number' && optionId !== undefined && 'status' in optionId) { return optionId; }

    let id = optionId;
    if (id === undefined) {
      while (seenIds.has(nextId) || existingById.has(nextId)) {
        nextId += 1;
      }
      id = nextId;
      nextId += 1;
    }
    if (seenIds.has(id)) {
      return jsonValidationError('Validation Failed: option ids must be unique.');
    }
    seenIds.add(id);

    const existing = existingById.get(id);
    const description = parseIssueFieldOptionDescription(raw.description);
    if (description !== undefined && description !== null && typeof description !== 'string' && 'status' in description) {
      return description;
    }

    const priority = parseIssueFieldOptionPriority(raw.priority, existing?.priority ?? index + 1);
    if (typeof priority !== 'number') { return priority; }

    options.push({
      id,
      name        : raw.name.trim(),
      description : description ?? null,
      color,
      priority,
    });
  }

  return options;
}

async function listOrgIssueFields(ctx: AgentContext, org: OrgEntry): Promise<OrgIssueFieldEntry[]> {
  const { records } = await ctx.org.records.query('org/issueField' as any, {
    filter   : { contextId: org.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const fields: OrgIssueFieldEntry[] = [];
  for (const record of records) {
    let data: unknown;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }

    const normalized = normalizeIssueFieldData(data);
    if (normalized) {
      fields.push({ record, data: normalized });
    }
  }
  return fields;
}

async function findOrgIssueField(ctx: AgentContext, org: OrgEntry, routeFieldId: string): Promise<OrgIssueFieldEntry | null> {
  const fieldId = parseNumericRouteId(routeFieldId);
  if (!fieldId) { return null; }

  const fields = await listOrgIssueFields(ctx, org);
  return fields.find(field => issueFieldNumericId(field) === fieldId) ?? null;
}

async function hasDuplicateIssueFieldName(
  ctx: AgentContext, org: OrgEntry, name: string, exceptRecordId?: string,
): Promise<boolean> {
  const normalized = name.toLowerCase();
  return (await listOrgIssueFields(ctx, org))
    .some(field => field.record.id !== exceptRecordId && field.data.name.toLowerCase() === normalized);
}

function parseCreateIssueFieldInput(body: Record<string, unknown>): OrgIssueFieldData | JsonResponse {
  if (!isNonEmptyString(body.name)) {
    return jsonValidationError('Validation Failed: name is required.');
  }

  const dataType = issueFieldDataType(body.data_type);
  if (!dataType) {
    return jsonValidationError('Validation Failed: data_type must be one of text, date, single_select, multi_select, or number.');
  }

  const visibility = issueFieldVisibility(body.visibility);
  if (!visibility) {
    return jsonValidationError('Validation Failed: visibility must be organization_members_only or all.');
  }

  const description = parseIssueFieldDescription(body.description);
  if (description !== undefined && description !== null && typeof description !== 'string' && 'status' in description) {
    return description;
  }

  const options = parseIssueFieldOptions(body.options, dataType, true);
  if (options !== undefined && !Array.isArray(options) && 'status' in options) { return options; }

  const data: OrgIssueFieldData = {
    name: body.name.trim(),
    ...(description !== undefined ? { description } : {}),
    dataType,
    visibility,
    ...(Array.isArray(options) ? { options } : {}),
  };
  return data;
}

function parseUpdateIssueFieldInput(field: OrgIssueFieldEntry, body: Record<string, unknown>): OrgIssueFieldData | JsonResponse {
  const next: OrgIssueFieldData = { ...field.data };

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name)) {
      return jsonValidationError('Validation Failed: name must be a non-empty string.');
    }
    next.name = body.name.trim();
  }

  if (body.description !== undefined) {
    const description = parseIssueFieldDescription(body.description);
    if (description !== undefined && description !== null && typeof description !== 'string' && 'status' in description) {
      return description;
    }
    next.description = description;
  }

  if (body.visibility !== undefined) {
    const visibility = issueFieldVisibility(body.visibility);
    if (!visibility) {
      return jsonValidationError('Validation Failed: visibility must be organization_members_only or all.');
    }
    next.visibility = visibility;
  }

  if (body.options !== undefined) {
    const options = parseIssueFieldOptions(body.options, field.data.dataType, false, field.data.options ?? []);
    if (options !== undefined && !Array.isArray(options) && 'status' in options) { return options; }
    next.options = options;
  }

  return next;
}

function issueTypeColor(value: unknown): IssueTypeColor | null | undefined {
  if (value === undefined) { return undefined; }
  if (value === null) { return null; }
  if (typeof value !== 'string') { return undefined; }
  return (ISSUE_TYPE_COLORS as readonly string[]).includes(value) ? value as IssueTypeColor : undefined;
}

function issueTypeTags(data: OrgIssueTypeData): Record<string, string | boolean> {
  return {
    name      : data.name,
    isEnabled : data.isEnabled,
  };
}

function normalizeIssueTypeData(data: unknown): OrgIssueTypeData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { return null; }
  const raw = data as Record<string, unknown>;
  if (!isNonEmptyString(raw.name) || typeof raw.isEnabled !== 'boolean') { return null; }

  const color = issueTypeColor(raw.color);
  return {
    name        : raw.name.trim(),
    description : typeof raw.description === 'string' || raw.description === null ? raw.description : null,
    color       : color ?? null,
    isEnabled   : raw.isEnabled,
  };
}

function buildIssueTypeResponse(issueType: OrgIssueTypeEntry): Record<string, unknown> {
  return {
    id          : issueTypeNumericId(issueType),
    node_id     : issueType.record.id,
    name        : issueType.data.name,
    description : issueType.data.description ?? null,
    color       : issueType.data.color ?? null,
    is_enabled  : issueType.data.isEnabled,
    created_at  : toISODate(issueType.record.dateCreated),
    updated_at  : toISODate(issueType.record.timestamp),
  };
}

async function listOrgIssueTypes(ctx: AgentContext, org: OrgEntry): Promise<OrgIssueTypeEntry[]> {
  const { records } = await ctx.org.records.query('org/issueType' as any, {
    filter   : { contextId: org.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const issueTypes: OrgIssueTypeEntry[] = [];
  for (const record of records) {
    let data: unknown;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }

    const normalized = normalizeIssueTypeData(data);
    if (normalized) {
      issueTypes.push({ record, data: normalized });
    }
  }
  return issueTypes;
}

async function findOrgIssueType(
  ctx: AgentContext, org: OrgEntry, routeIssueTypeId: string,
): Promise<OrgIssueTypeEntry | null> {
  const issueTypeId = parseNumericRouteId(routeIssueTypeId);
  if (!issueTypeId) { return null; }

  const issueTypes = await listOrgIssueTypes(ctx, org);
  return issueTypes.find(issueType => issueTypeNumericId(issueType) === issueTypeId) ?? null;
}

async function hasDuplicateIssueTypeName(
  ctx: AgentContext, org: OrgEntry, name: string, exceptRecordId?: string,
): Promise<boolean> {
  const normalized = name.toLowerCase();
  return (await listOrgIssueTypes(ctx, org))
    .some(issueType => issueType.record.id !== exceptRecordId && issueType.data.name.toLowerCase() === normalized);
}

function parseIssueTypeInput(body: Record<string, unknown>): OrgIssueTypeData | JsonResponse {
  if (!isNonEmptyString(body.name)) {
    return jsonValidationError('Validation Failed: name is required.');
  }
  if (typeof body.is_enabled !== 'boolean') {
    return jsonValidationError('Validation Failed: is_enabled is required and must be a boolean.');
  }

  const description = parseIssueFieldDescription(body.description);
  if (description !== undefined && description !== null && typeof description !== 'string' && 'status' in description) {
    return description;
  }

  const color = issueTypeColor(body.color);
  if (color === undefined && body.color !== undefined) {
    return jsonValidationError('Validation Failed: color must be one of gray, blue, green, yellow, orange, red, pink, purple, or null.');
  }

  return {
    name        : body.name.trim(),
    description : description ?? null,
    color       : color ?? null,
    isEnabled   : body.is_enabled,
  };
}

function customPropertyValueType(value: unknown): CustomPropertyValueType | null {
  if (typeof value !== 'string') { return null; }
  return (CUSTOM_PROPERTY_VALUE_TYPES as readonly string[]).includes(value) ? value as CustomPropertyValueType : null;
}

function customPropertyValuesEditableBy(value: unknown): CustomPropertyValuesEditableBy | null | undefined {
  if (value === undefined) { return undefined; }
  if (value === null) { return null; }
  if (typeof value !== 'string') { return undefined; }
  return (CUSTOM_PROPERTY_VALUES_EDITABLE_BY as readonly string[]).includes(value) ? value as CustomPropertyValuesEditableBy : undefined;
}

function parseCustomPropertyName(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const name = value.trim();
  if (!name || name.length > 75 || /\s/.test(name)) { return null; }
  return name;
}

function customPropertyTags(data: OrgCustomPropertyData): Record<string, string> {
  return {
    propertyName : data.propertyName,
    valueType    : data.valueType,
  };
}

function normalizeCustomPropertyData(data: unknown): OrgCustomPropertyData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { return null; }
  const raw = data as Record<string, unknown>;
  const propertyName = parseCustomPropertyName(raw.propertyName);
  const valueType = customPropertyValueType(raw.valueType);
  if (!propertyName || !valueType) { return null; }

  const valuesEditableBy = customPropertyValuesEditableBy(raw.valuesEditableBy);
  return {
    propertyName,
    valueType,
    required              : typeof raw.required === 'boolean' ? raw.required : false,
    defaultValue          : parseStoredCustomPropertyDefault(raw.defaultValue),
    description           : typeof raw.description === 'string' || raw.description === null ? raw.description : null,
    allowedValues         : Array.isArray(raw.allowedValues) && raw.allowedValues.every(item => typeof item === 'string') ? [...raw.allowedValues] : null,
    valuesEditableBy      : valuesEditableBy === undefined ? 'org_actors' : valuesEditableBy,
    requireExplicitValues : typeof raw.requireExplicitValues === 'boolean' ? raw.requireExplicitValues : false,
  };
}

function parseStoredCustomPropertyDefault(value: unknown): string | string[] | null {
  if (typeof value === 'string') { return value; }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) { return [...value]; }
  return null;
}

function buildCustomPropertyResponse(
  org: OrgEntry, property: OrgCustomPropertyData, baseUrl: string,
): Record<string, unknown> {
  const orgPath = routeOrgPath(org);
  return {
    property_name           : property.propertyName,
    url                     : `${baseUrl}/orgs/${orgPath}/properties/schema/${encodeURIComponent(property.propertyName)}`,
    source_type             : 'organization',
    value_type              : property.valueType,
    required                : property.required ?? false,
    default_value           : property.defaultValue ?? null,
    description             : property.description ?? null,
    allowed_values          : property.allowedValues ?? null,
    values_editable_by      : property.valuesEditableBy === undefined ? 'org_actors' : property.valuesEditableBy,
    require_explicit_values : property.requireExplicitValues ?? false,
  };
}

function parseStringArray(value: unknown, fieldName: string, maxItems?: number): string[] | null | JsonResponse {
  if (value === null) { return null; }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be an array of strings or null.`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    return jsonValidationError(`Validation Failed: ${fieldName} cannot contain more than ${maxItems} values.`);
  }
  return [...value];
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCustomPropertyDefaultValue(
  value: unknown, valueType: CustomPropertyValueType, allowedValues: string[] | null,
): string | string[] | null | JsonResponse {
  if (value === undefined || value === null) { return null; }
  if (valueType === 'multi_select') {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      return jsonValidationError('Validation Failed: default_value must be an array of strings or null for multi_select properties.');
    }
    if (allowedValues && value.some(item => !allowedValues.includes(item))) {
      return jsonValidationError('Validation Failed: default_value must be one of the allowed_values.');
    }
    return [...value];
  }

  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: default_value must be a string or null.');
  }
  if (valueType === 'single_select' && allowedValues && !allowedValues.includes(value)) {
    return jsonValidationError('Validation Failed: default_value must be one of the allowed_values.');
  }
  if (valueType === 'true_false' && value !== 'true' && value !== 'false') {
    return jsonValidationError('Validation Failed: default_value for true_false properties must be true or false.');
  }
  if (valueType === 'url' && !isValidUrl(value)) {
    return jsonValidationError('Validation Failed: default_value for url properties must be an HTTP or HTTPS URL.');
  }
  return value;
}

function parseCustomPropertyDefinitionInput(
  body: Record<string, unknown>, routePropertyName?: string,
): OrgCustomPropertyData | JsonResponse {
  const propertyName = parseCustomPropertyName(routePropertyName ?? body.property_name);
  if (!propertyName) {
    return jsonValidationError('Validation Failed: property_name is required, cannot contain whitespace, and must be 75 characters or fewer.');
  }

  if (body.source_type !== undefined && body.source_type !== 'organization' && body.source_type !== 'enterprise') {
    return jsonValidationError('Validation Failed: source_type must be organization or enterprise.');
  }

  const valueType = customPropertyValueType(body.value_type);
  if (!valueType) {
    return jsonValidationError('Validation Failed: value_type must be string, single_select, multi_select, true_false, or url.');
  }

  if (body.required !== undefined && typeof body.required !== 'boolean') {
    return jsonValidationError('Validation Failed: required must be a boolean.');
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    return jsonValidationError('Validation Failed: description must be a string or null.');
  }
  if (body.require_explicit_values !== undefined && typeof body.require_explicit_values !== 'boolean') {
    return jsonValidationError('Validation Failed: require_explicit_values must be a boolean.');
  }

  const valuesEditableBy = customPropertyValuesEditableBy(body.values_editable_by);
  if (valuesEditableBy === undefined && body.values_editable_by !== undefined) {
    return jsonValidationError('Validation Failed: values_editable_by must be org_actors, org_and_repo_actors, or null.');
  }

  const allowedValues = body.allowed_values === undefined
    ? null
    : parseStringArray(body.allowed_values, 'allowed_values', 200);
  if (allowedValues !== null && !Array.isArray(allowedValues) && 'status' in allowedValues) { return allowedValues; }
  if ((valueType === 'single_select' || valueType === 'multi_select') && Array.isArray(allowedValues) && allowedValues.length === 0) {
    return jsonValidationError('Validation Failed: allowed_values cannot be empty for select properties.');
  }
  if (valueType !== 'single_select' && valueType !== 'multi_select' && Array.isArray(allowedValues)) {
    return jsonValidationError('Validation Failed: allowed_values are only supported for single_select and multi_select properties.');
  }

  const defaultValue = parseCustomPropertyDefaultValue(body.default_value, valueType, Array.isArray(allowedValues) ? allowedValues : null);
  if (defaultValue !== null && typeof defaultValue !== 'string' && !Array.isArray(defaultValue) && 'status' in defaultValue) {
    return defaultValue;
  }

  return {
    propertyName,
    valueType,
    required              : typeof body.required === 'boolean' ? body.required : false,
    defaultValue,
    description           : typeof body.description === 'string' || body.description === null ? body.description : null,
    allowedValues         : Array.isArray(allowedValues) ? allowedValues : null,
    valuesEditableBy      : valuesEditableBy === undefined ? 'org_actors' : valuesEditableBy,
    requireExplicitValues : typeof body.require_explicit_values === 'boolean' ? body.require_explicit_values : false,
  };
}

function validateCustomPropertyValue(
  property: OrgCustomPropertyData, value: unknown,
): RepositoryCustomPropertyValue | null | JsonResponse {
  if (value === null) { return null; }
  const allowed = property.allowedValues ?? null;

  if (property.valueType === 'multi_select') {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      return jsonValidationError('Validation Failed: multi_select property values must be arrays of strings.');
    }
    if (allowed && value.some(item => !allowed.includes(item))) {
      return jsonValidationError(`Validation Failed: value for '${property.propertyName}' must be one of the allowed_values.`);
    }
    return [...value];
  }

  if (typeof value !== 'string') {
    return jsonValidationError(`Validation Failed: value for '${property.propertyName}' must be a string or null.`);
  }
  if (property.valueType === 'single_select' && allowed && !allowed.includes(value)) {
    return jsonValidationError(`Validation Failed: value for '${property.propertyName}' must be one of the allowed_values.`);
  }
  if (property.valueType === 'true_false' && value !== 'true' && value !== 'false') {
    return jsonValidationError(`Validation Failed: value for '${property.propertyName}' must be true or false.`);
  }
  if (property.valueType === 'url' && !isValidUrl(value)) {
    return jsonValidationError(`Validation Failed: value for '${property.propertyName}' must be an HTTP or HTTPS URL.`);
  }
  return value;
}

async function listOrgCustomProperties(ctx: AgentContext, org: OrgEntry): Promise<OrgCustomPropertyEntry[]> {
  const { records } = await ctx.org.records.query('org/customProperty' as any, {
    filter   : { contextId: org.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const properties: OrgCustomPropertyEntry[] = [];
  for (const record of records) {
    let data: unknown;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    const normalized = normalizeCustomPropertyData(data);
    if (normalized) {
      properties.push({ record, data: normalized });
    }
  }
  return properties.sort((a, b) => a.data.propertyName.localeCompare(b.data.propertyName));
}

async function findOrgCustomProperty(
  ctx: AgentContext, org: OrgEntry, routePropertyName: string,
): Promise<OrgCustomPropertyEntry | null> {
  const propertyName = decodeRouteParam(routePropertyName);
  return (await listOrgCustomProperties(ctx, org))
    .find(property => property.data.propertyName === propertyName) ?? null;
}

async function upsertOrgCustomProperty(
  ctx: AgentContext, org: OrgEntry, data: OrgCustomPropertyData,
): Promise<OrgCustomPropertyEntry | JsonResponse> {
  const existing = (await listOrgCustomProperties(ctx, org))
    .find(property => property.data.propertyName === data.propertyName);
  if (existing) {
    const { status } = await existing.record.update({ data, tags: customPropertyTags(data) } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update custom property: ${status.detail}`);
    }
    return { ...existing, data };
  }

  const { record, status } = await ctx.org.records.create('org/customProperty' as any, {
    data,
    tags            : customPropertyTags(data),
    parentContextId : org.record.contextId ?? '',
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create custom property: ${status.detail}`);
  }
  return { record, data };
}

async function getRepoSettingsEntry(ctx: AgentContext, entry: OrgRepoEntry): Promise<RepoSettingsEntry> {
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from   : fromOpt(ctx, ctx.did),
    filter : { contextId: entry.repo.contextId },
  } as any);

  if (records.length === 0) {
    return { entry, settings: {} };
  }

  const record = records[0] as RepoSettingsEntry['record'] & { data: { json: () => Promise<SettingsData> } };
  const settings = await record.data.json();
  return { entry, record, settings: settings ?? {} };
}

async function saveRepoSettingsEntry(
  ctx: AgentContext, lookup: RepoSettingsEntry, settings: SettingsData,
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

function customPropertyValueEntries(settings: SettingsData): Array<{ property_name: string; value: RepositoryCustomPropertyValue }> {
  return Object.entries(settings.customProperties ?? {})
    .filter((entry): entry is [string, RepositoryCustomPropertyValue] => typeof entry[0] === 'string')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([propertyName, value]) => ({
      property_name: propertyName,
      value,
    }));
}

function buildOrgRepoCustomPropertiesResponse(entry: OrgRepoEntry, ownerDid: string, settings: SettingsData): Record<string, unknown> {
  return {
    repository_id        : numericId(entry.repo.contextId || entry.record.id),
    repository_name      : entry.repo.name,
    repository_full_name : `${ownerDid}/${entry.repo.name}`,
    properties           : customPropertyValueEntries(settings),
  };
}

function filterOrgRepoCustomPropertyEntries(entries: OrgRepoEntry[], ownerDid: string, url: URL): OrgRepoEntry[] {
  const query = url.searchParams.get('repository_query')?.trim().toLowerCase();
  if (!query) { return entries; }

  const terms = query
    .split(/\s+/)
    .map(term => term.replace(/^repo:/, '').replace(/^org:/, ''))
    .filter(Boolean);
  if (terms.length === 0) { return entries; }

  return entries.filter(entry => {
    const haystack = `${entry.repo.name} ${repoFullName(ownerDid, entry)}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

function repoFullName(ownerDid: string, entry: OrgRepoEntry): string {
  return `${ownerDid}/${entry.repo.name}`;
}

function parseOrgCustomPropertyValuesInput(
  body: Record<string, unknown>, definitions: Map<string, OrgCustomPropertyData>,
): { repositoryNames: string[]; values: Record<string, RepositoryCustomPropertyValue | null> } | JsonResponse {
  if (!Array.isArray(body.repository_names) || !body.repository_names.every(name => typeof name === 'string' && name.trim() !== '')) {
    return jsonValidationError('Validation Failed: repository_names must be a non-empty array of repository names.');
  }
  if (body.repository_names.length > 30) {
    return jsonValidationError('Validation Failed: repository_names cannot contain more than 30 repositories.');
  }
  if (!Array.isArray(body.properties)) {
    return jsonValidationError('Validation Failed: properties must be an array.');
  }

  const repositoryNames = [...new Set(body.repository_names.map(name => String(name).trim()))];
  const values: Record<string, RepositoryCustomPropertyValue | null> = {};
  for (const property of body.properties) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
      return jsonValidationError('Validation Failed: each property must be an object.');
    }
    const raw = property as Record<string, unknown>;
    const propertyName = parseCustomPropertyName(raw.property_name);
    if (!propertyName) {
      return jsonValidationError('Validation Failed: property_name is required, cannot contain whitespace, and must be 75 characters or fewer.');
    }
    if (!Object.prototype.hasOwnProperty.call(raw, 'value')) {
      return jsonValidationError('Validation Failed: value is required.');
    }

    const definition = definitions.get(propertyName);
    if (!definition) {
      return jsonValidationError(`Validation Failed: custom property '${propertyName}' is not defined for this organization.`);
    }

    const value = validateCustomPropertyValue(definition, raw.value);
    if (value !== null && typeof value !== 'string' && !Array.isArray(value) && 'status' in value) { return value; }
    values[propertyName] = value;
  }

  return { repositoryNames, values };
}

function buildTeamRepositoryResponse(
  repo: RepoInfo,
  ownerDid: string,
  repoName: string,
  baseUrl: string,
  permission: TeamRepositoryPermission,
): Record<string, unknown> {
  return {
    ...buildRepoResponse(repo, ownerDid, repoName, baseUrl),
    permissions : teamPermissionBooleans(permission),
    role_name   : teamRepositoryRoleName(permission),
  };
}

async function listTeams(ctx: AgentContext, org: OrgEntry): Promise<TeamEntry[]> {
  const { records } = await ctx.org.records.query('org/team' as any, {
    filter   : { contextId: org.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const teams: TeamEntry[] = [];
  for (const record of records) {
    let data: TeamData;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    if (isNonEmptyString(data.name)) {
      teams.push({
        record,
        data : { ...data, privacy: data.privacy === 'secret' ? 'secret' : 'visible' },
        slug : slugify(data.name),
      });
    }
  }
  return teams;
}

async function findTeam(ctx: AgentContext, org: OrgEntry, routeTeam: string): Promise<TeamEntry | null> {
  const slug = slugify(decodeRouteParam(routeTeam));
  const teams = await listTeams(ctx, org);
  return teams.find(team => team.slug === slug || team.data.name.toLowerCase() === decodeRouteParam(routeTeam).toLowerCase()) ?? null;
}

async function findTeamByNumericId(ctx: AgentContext, routeTeamId: string): Promise<TeamLookup | null> {
  const teamId = parseNumericRouteId(routeTeamId);
  if (!teamId) { return null; }

  for (const org of await listOrgEntries(ctx)) {
    const team = (await listTeams(ctx, org)).find(candidate => teamNumericId(candidate) === teamId);
    if (team) { return { org, team }; }
  }
  return null;
}

async function findOrgTeamByNumericIds(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string,
): Promise<TeamLookup | null> {
  const teamId = parseNumericRouteId(routeTeamId);
  if (!teamId) { return null; }

  const org = await findOrgByNumericId(ctx, routeOrgId);
  if (!org) { return null; }

  const team = (await listTeams(ctx, org)).find(candidate => teamNumericId(candidate) === teamId);
  return team ? { org, team } : null;
}

function buildTeamResponse(team: TeamEntry, org: OrgEntry, baseUrl: string): Record<string, unknown> {
  const orgPath = routeOrgPath(org);
  const teamPath = encodeURIComponent(team.slug);

  return {
    id                   : numericId(team.record.contextId ?? team.record.id),
    node_id              : team.record.id,
    url                  : `${baseUrl}/orgs/${orgPath}/teams/${teamPath}`,
    html_url             : `${baseUrl}/orgs/${orgPath}/teams/${teamPath}`,
    name                 : team.data.name,
    slug                 : team.slug,
    description          : team.data.description ?? null,
    privacy              : teamPrivacyToGitHub(team.data.privacy),
    notification_setting : 'notifications_enabled',
    permission           : 'pull',
    members_url          : `${baseUrl}/orgs/${orgPath}/teams/${teamPath}/members{/member}`,
    repositories_url     : `${baseUrl}/orgs/${orgPath}/teams/${teamPath}/repos`,
    parent               : null,
  };
}

function buildDetailedTeamResponse(team: TeamEntry, org: OrgEntry, baseUrl: string, membersCount: number): Record<string, unknown> {
  return {
    ...buildTeamResponse(team, org, baseUrl),
    members_count : membersCount,
    repos_count   : Object.keys(teamRepositoryGrants(team)).length,
    created_at    : toISODate(team.record.dateCreated),
    updated_at    : toISODate(team.record.timestamp),
    organization  : buildOrgResponse(org, baseUrl),
  };
}

async function listTeamMembers(ctx: AgentContext, team: TeamEntry): Promise<TeamMemberEntry[]> {
  const { records } = await ctx.org.records.query('org/team/teamMember' as any, {
    filter   : { contextId: team.record.contextId ?? '' },
    dateSort : DateSort.CreatedAscending,
  } as any);

  const members: TeamMemberEntry[] = [];
  for (const record of records) {
    let data: TeamMemberData;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    if (isNonEmptyString(data.did)) {
      members.push({ record, data });
    }
  }
  return members;
}

async function findTeamMember(ctx: AgentContext, team: TeamEntry, did: string): Promise<TeamMemberEntry | null> {
  const members = await listTeamMembers(ctx, team);
  return members.find(member => member.data.did === did) ?? null;
}

async function listPendingOrgInvitations(ctx: AgentContext, org: OrgEntry): Promise<OrgInvitationEntry[]> {
  const byDid = new Map<string, OrgInvitationEntry>();
  for (const team of await listTeams(ctx, org)) {
    for (const member of await listTeamMembers(ctx, team)) {
      if (teamMemberState(member) !== 'pending') { continue; }

      const existing = byDid.get(member.data.did);
      if (existing) {
        existing.members.push(member);
        existing.teams.push(team);
      } else {
        byDid.set(member.data.did, {
          did     : member.data.did,
          members : [member],
          teams   : [team],
        });
      }
    }
  }

  return [...byDid.values()].sort((a, b) => a.did.localeCompare(b.did));
}

async function findOrgInvitation(ctx: AgentContext, org: OrgEntry, routeInvitationId: string): Promise<OrgInvitationEntry | null> {
  const invitationId = Number(decodeRouteParam(routeInvitationId));
  if (!Number.isSafeInteger(invitationId) || invitationId <= 0) { return null; }

  const invitations = await listPendingOrgInvitations(ctx, org);
  return invitations.find(invitation => orgInvitationId(org, invitation.did) === invitationId) ?? null;
}

async function listOrgRepoEntries(ctx: AgentContext): Promise<OrgRepoEntry[]> {
  const { records } = await ctx.repo.records.query('repo', {
    dateSort: DateSort.CreatedAscending,
  } as any);

  const repos: OrgRepoEntry[] = [];
  for (const record of records) {
    let data: Record<string, unknown>;
    try {
      data = await record.data.json();
    } catch {
      continue;
    }
    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    const repo = repoInfoFromRecord(record, data, tags);
    repos.push({ record, repo, name: repo.name });
  }
  return repos;
}

async function getRepoSettings(ctx: AgentContext, targetDid: string, repo: RepoInfo): Promise<SettingsData> {
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from   : fromOpt(ctx, targetDid),
    filter : { contextId: repo.contextId },
  });

  if (records.length === 0) {
    return {};
  }

  const record = records[0] as { data: { json: () => Promise<SettingsData> } };
  return (await record.data.json()) ?? {};
}

function buildOutsideCollaboratorUser(collab: OutsideCollaboratorEntry, baseUrl: string): Record<string, unknown> {
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

function addOutsideCollaborator(
  byDid: Map<string, OutsideCollaboratorEntry>,
  candidate: OutsideCollaboratorEntry,
  orgMemberDids: Set<string>,
): void {
  if (orgMemberDids.has(candidate.did)) { return; }

  const existing = byDid.get(candidate.did);
  if (!existing || (!existing.alias && candidate.alias)) {
    byDid.set(candidate.did, candidate);
  }
}

async function listOutsideCollaborators(ctx: AgentContext, org: OrgEntry): Promise<OutsideCollaboratorEntry[]> {
  const orgMemberDids = orgMemberDidSet(await listOrgMembers(ctx, org));
  const byDid = new Map<string, OutsideCollaboratorEntry>();

  for (const entry of await listOrgRepoEntries(ctx)) {
    for (const recordType of REPO_COLLABORATOR_TYPES) {
      const { records } = await ctx.repo.records.query(recordType as any, {
        filter: { contextId: entry.repo.contextId },
      } as any);

      for (const record of records) {
        const tags = (record.tags as Record<string, string> | undefined) ?? {};
        let data: Record<string, unknown> = {};
        try {
          data = await record.data.json();
        } catch {
          data = {};
        }

        const did = typeof data.did === 'string' ? data.did : tags.did;
        if (!isNonEmptyString(did)) { continue; }

        addOutsideCollaborator(byDid, {
          did,
          alias    : typeof data.alias === 'string' ? data.alias : '',
          recordId : record.id ?? `${did}:${recordType}`,
        }, orgMemberDids);
      }
    }
  }

  for (const team of await listTeams(ctx, org)) {
    if (Object.keys(teamRepositoryGrants(team)).length === 0) { continue; }

    for (const member of await listTeamMembers(ctx, team)) {
      if (!teamMemberIsActive(member)) { continue; }

      addOutsideCollaborator(byDid, {
        did      : member.data.did,
        alias    : member.data.alias ?? '',
        recordId : member.record.id ?? `${member.data.did}:${team.slug}`,
      }, orgMemberDids);
    }
  }

  return [...byDid.values()].sort((a, b) => a.did.localeCompare(b.did));
}

async function deleteOutsideCollaboratorRepoRoles(ctx: AgentContext, did: string): Promise<JsonResponse | null> {
  for (const entry of await listOrgRepoEntries(ctx)) {
    for (const recordType of REPO_COLLABORATOR_TYPES) {
      const { records } = await ctx.repo.records.query(recordType as any, {
        filter: { contextId: entry.repo.contextId, tags: { did } },
      } as any);
      for (const record of records) {
        const { status } = await record.delete();
        if (status.code >= 300) {
          return jsonValidationError(`Failed to remove outside collaborator repository access: ${status.detail}`);
        }
      }
    }
  }
  return null;
}

async function deleteOutsideCollaboratorTeamMemberships(ctx: AgentContext, org: OrgEntry, did: string): Promise<JsonResponse | null> {
  for (const team of await listTeams(ctx, org)) {
    for (const member of await listTeamMembers(ctx, team)) {
      if (member.data.did !== did) { continue; }

      const { status } = await member.record.delete();
      if (status.code >= 300) {
        return jsonValidationError(`Failed to remove outside collaborator team access: ${status.detail}`);
      }
    }
  }
  return null;
}

function buildTeamMembershipResponse(
  team: TeamEntry,
  member: TeamMemberEntry,
  org: OrgEntry,
  baseUrl: string,
  role: TeamMemberRole,
  state: TeamMemberState,
): Record<string, unknown> {
  const teamUrl = `${baseUrl}/orgs/${routeOrgPath(org)}/teams/${encodeURIComponent(team.slug)}`;

  return {
    url          : `${teamUrl}/memberships/${encodeURIComponent(member.data.did)}`,
    role,
    state,
    organization : buildOrgResponse(org, baseUrl),
    team         : buildTeamResponse(team, org, baseUrl),
    user         : buildOrgUser(member, baseUrl),
  };
}

function buildTeamInvitationResponse(
  team: TeamEntry,
  member: TeamMemberEntry,
  org: OrgEntry,
  baseUrl: string,
  inviterDid: string,
): Record<string, unknown> {
  return {
    ...buildOrgInvitationResponse(
      org,
      { did: member.data.did, members: [member], teams: [team] },
      baseUrl,
      inviterDid,
    ),
    team: buildTeamResponse(team, org, baseUrl),
  };
}

function buildOrgInvitationResponse(
  org: OrgEntry,
  invitation: OrgInvitationEntry,
  baseUrl: string,
  inviterDid: string,
): Record<string, unknown> {
  const invitationId = orgInvitationId(org, invitation.did);
  const firstMember = invitation.members[0];
  const inviter = {
    ...buildOwner(inviterDid, baseUrl),
    gravatar_id : '',
    type        : 'User',
    site_admin  : false,
  };

  return {
    id                   : invitationId,
    login                : invitation.did,
    node_id              : firstMember?.record.id ?? String(invitationId),
    email                : null,
    role                 : 'direct_member',
    created_at           : toISODate(firstMember?.record.dateCreated),
    failed_at            : '',
    failed_reason        : '',
    inviter,
    team_count           : invitation.teams.length,
    invitation_teams_url : `${baseUrl}/organizations/${numericId(org.record.contextId ?? org.record.id)}/invitations/${invitationId}/teams`,
    invitation_source    : 'member',
  };
}

function buildOrgMembershipResponse(org: OrgEntry, member: OrgMemberEntry, baseUrl: string): Record<string, unknown> {
  const orgUrl = `${baseUrl}/orgs/${routeOrgPath(org)}`;

  return {
    url                                            : `${orgUrl}/memberships/${encodeURIComponent(member.data.did)}`,
    state                                          : 'active',
    role                                           : member.role,
    organization_url                               : orgUrl,
    direct_membership                              : true,
    enterprise_teams_providing_indirect_membership : [],
    organization                                   : buildOrgResponse(org, baseUrl),
    user                                           : buildOrgUser(member, baseUrl),
  };
}

function pagedResponse(items: Record<string, unknown>[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(items, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, items.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }
  return jsonOk(paged, extraHeaders);
}

async function listUserOrgs(ctx: AgentContext, userDid: string): Promise<OrgEntry[]> {
  const orgs = await listOrgEntries(ctx);
  const matches: OrgEntry[] = [];
  for (const org of orgs) {
    const members = await listOrgMembers(ctx, org);
    if (members.some(member => member.data.did === userDid)) {
      matches.push(org);
    }
  }
  return matches;
}

function orgListItem(org: OrgEntry, baseUrl: string): Record<string, unknown> {
  const full = buildOrgResponse(org, baseUrl);
  return {
    login              : full.login,
    id                 : full.id,
    node_id            : full.node_id,
    url                : full.url,
    repos_url          : full.repos_url,
    events_url         : full.events_url,
    hooks_url          : full.hooks_url,
    issues_url         : full.issues_url,
    members_url        : full.members_url,
    public_members_url : full.public_members_url,
    avatar_url         : full.avatar_url,
    description        : full.description,
  };
}

function pagedOrgs(orgs: OrgEntry[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const items = orgs.map(org => orgListItem(org, baseUrl));
  return pagedResponse(items, url, path);
}

function listOrganizationsSince(orgs: OrgEntry[], url: URL): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const since = parseInt(url.searchParams.get('since') ?? '0', 10);
  const minId = Number.isNaN(since) ? 0 : since;
  const sorted = [...orgs]
    .map(org => ({ org, id: numericId(org.record.contextId ?? org.record.id) }))
    .filter(entry => entry.id > minId)
    .sort((a, b) => a.id - b.id);
  const paged = sorted.slice(0, pagination.perPage);
  const items = paged.map(entry => orgListItem(entry.org, baseUrl));
  const extraHeaders: Record<string, string> = {};

  if (sorted.length > pagination.perPage) {
    const nextSince = paged[paged.length - 1]?.id ?? minId;
    extraHeaders.Link = `<${baseUrl}/organizations?since=${nextSince}&per_page=${pagination.perPage}>; rel="next"`;
  }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// Organization handlers
// ---------------------------------------------------------------------------

export async function handleGetOrg(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }
  return jsonOk(buildOrgResponse(org, buildApiUrl(url)));
}

export async function handleListOrganizations(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  return listOrganizationsSince(await listOrgEntries(ctx), url);
}

export async function handleListAuthenticatedOrgs(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  return pagedOrgs(await listUserOrgs(ctx, ctx.did), url, '/user/orgs');
}

export async function handleListAuthenticatedOrgMemberships(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  const state = url.searchParams.get('state');
  if (state !== null && state !== 'active' && state !== 'pending') {
    return jsonValidationError('Validation Failed: state must be active or pending.');
  }
  if (state === 'pending') {
    return pagedResponse([], url, '/user/memberships/orgs');
  }

  const baseUrl = buildApiUrl(url);
  const memberships: Record<string, unknown>[] = [];
  for (const org of await listOrgEntries(ctx)) {
    const member = await findOrgMember(ctx, org, ctx.did);
    if (member) {
      memberships.push(buildOrgMembershipResponse(org, member, baseUrl));
    }
  }
  return pagedResponse(memberships, url, '/user/memberships/orgs');
}

export async function handleGetAuthenticatedOrgMembership(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  return handleGetOrgMembership(ctx, routeOrg, ctx.did, url);
}

export async function handleUpdateAuthenticatedOrgMembership(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  if (body.state !== 'active') {
    return jsonValidationError('Validation Failed: state must be active.');
  }
  return handleGetOrgMembership(ctx, routeOrg, ctx.did, url);
}

export async function handleListUserOrgs(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  return pagedOrgs(await listUserOrgs(ctx, decodeRouteParam(userDid)), url, `/users/${userDid}/orgs`);
}

export async function handleListOrgBlockedUsers(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const items = (await listOrgBlockedUsers(ctx, org))
    .map(blockedUser => buildBlockedOrgUser(blockedUser, baseUrl));
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/blocks`);
}

export async function handleCheckOrgBlockedUser(
  ctx: AgentContext, routeOrg: string, routeUsername: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const blockedUser = await findOrgBlockedUser(ctx, org, routeUsername);
  if (!blockedUser) {
    return jsonNotFound(`User '${decodeRouteParam(routeUsername)}' is not blocked by organization '${org.routeLogin}'.`);
  }
  return jsonNoContent();
}

export async function handleBlockOrgUser(
  ctx: AgentContext, routeOrg: string, routeUsername: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = parseBlockedUserDid(routeUsername);
  if (!did) { return jsonValidationError('Validation Failed: username is required.'); }

  const existing = await findOrgBlockedUser(ctx, org, routeUsername);
  if (existing) { return jsonNoContent(); }

  const member = await findOrgMember(ctx, org, did);
  if (member) {
    return jsonValidationError(`Validation Failed: organization members cannot be blocked. Remove '${did}' from the organization first.`);
  }

  const data: OrgBlockedUserData = {
    did,
    blockedAt : new Date().toISOString(),
    blockedBy : ctx.did,
  };
  const { record, status } = await ctx.org.records.create('org/blockedUser' as any, {
    data,
    tags            : blockedUserTags(data),
    parentContextId : org.record.contextId ?? '',
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to block user: ${status.detail}`);
  }
  return jsonNoContent();
}

export async function handleUnblockOrgUser(
  ctx: AgentContext, routeOrg: string, routeUsername: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const blockedUser = await findOrgBlockedUser(ctx, org, routeUsername);
  if (!blockedUser) { return jsonNoContent(); }

  const { status } = await blockedUser.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unblock user: ${status.detail}`);
  }
  return jsonNoContent();
}

export async function handleUpdateOrg(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const next: OrgData = { ...org.data };
  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name)) {
      return jsonValidationError('Validation Failed: name must be a non-empty string.');
    }
    next.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return jsonValidationError('Validation Failed: description must be a string or null.');
    }
    next.description = body.description ?? undefined;
  }
  if (body.blog !== undefined || body.homepage !== undefined) {
    const homepage = body.blog ?? body.homepage;
    if (homepage !== null && homepage !== undefined && typeof homepage !== 'string') {
      return jsonValidationError('Validation Failed: blog must be a string or null.');
    }
    next.homepage = homepage ? String(homepage) : undefined;
  }
  if (body.avatar_url !== undefined || body.avatar !== undefined) {
    const avatar = body.avatar_url ?? body.avatar;
    if (avatar !== null && avatar !== undefined && typeof avatar !== 'string') {
      return jsonValidationError('Validation Failed: avatar_url must be a string or null.');
    }
    next.avatar = avatar ? String(avatar) : undefined;
  }

  const { status } = await org.record.update({ data: next });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update organization: ${status.detail}`);
  }

  return jsonOk(buildOrgResponse({ ...org, data: next, slug: slugify(next.name), routeLogin: next.name }, buildApiUrl(url)));
}

export async function handleListOrgMembers(
  ctx: AgentContext, routeOrg: string, url: URL, publicOnly: boolean = false,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const role = url.searchParams.get('role');
  let members = await listOrgMembers(ctx, org);
  if (publicOnly) {
    members = members.filter(orgMemberIsPublic);
  } else if (role === 'admin') {
    members = members.filter(member => member.role === 'admin');
  } else if (role === 'member') {
    members = members.filter(member => member.role === 'member');
  }

  const baseUrl = buildApiUrl(url);
  const items = members.map(member => buildOrgUser(member, baseUrl));
  const path = publicOnly
    ? `/orgs/${routeOrgPath(org)}/public_members`
    : `/orgs/${routeOrgPath(org)}/members`;
  return pagedResponse(items, url, path);
}

export async function handleCheckOrgMember(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const member = await findOrgMember(ctx, org, decodeRouteParam(memberDid));
  return member ? jsonNoContent() : jsonNotFound(`User '${decodeRouteParam(memberDid)}' is not an organization member.`);
}

export async function handleCheckPublicOrgMember(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findOrgMember(ctx, org, did);
  return member && orgMemberIsPublic(member)
    ? jsonNoContent()
    : jsonNotFound(`User '${did}' is not a public organization member.`);
}

export async function handleSetPublicOrgMembership(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findOrgMember(ctx, org, did);
  if (!member) {
    return jsonNotFound(`User '${did}' is not an organization member.`);
  }
  if (orgMemberIsPublic(member)) {
    return jsonNoContent();
  }

  const updated = await setOrgMemberPublicVisibility(member, true);
  return 'status' in updated ? updated : jsonNoContent();
}

export async function handleRemovePublicOrgMembership(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findOrgMember(ctx, org, did);
  if (!member) {
    return jsonNotFound(`User '${did}' is not an organization member.`);
  }
  if (!orgMemberIsPublic(member)) {
    return jsonNoContent();
  }

  const updated = await setOrgMemberPublicVisibility(member, false);
  return 'status' in updated ? updated : jsonNoContent();
}

export async function handleGetOrgMembership(
  ctx: AgentContext, routeOrg: string, memberDid: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findOrgMember(ctx, org, did);
  if (!member) {
    return jsonNotFound(`User '${did}' is not an organization member.`);
  }

  return jsonOk(buildOrgMembershipResponse(org, member, buildApiUrl(url)));
}

export async function handleSetOrgMembership(
  ctx: AgentContext, routeOrg: string, memberDid: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  if (!isNonEmptyString(did)) {
    return jsonValidationError('Validation Failed: member must be a DID.');
  }

  const role = orgMembershipRole(body.role);
  if (!role) {
    return jsonValidationError('Validation Failed: role must be admin or member.');
  }

  const existingRecords = (await listOrgMemberRecords(ctx, org)).filter(member => member.data.did === did);
  let target = existingRecords.find(member => member.role === role) ?? null;
  const publicVisibility = typeof body.public === 'boolean'
    ? body.public
    : existingRecords.find(member => member.data.public !== undefined)?.data.public;

  if (!target) {
    const alias = typeof body.alias === 'string' ? body.alias : undefined;
    const data: OrgMemberData = {
      did,
      ...(alias ? { alias } : {}),
      ...(publicVisibility !== undefined ? { public: publicVisibility } : {}),
    };
    const { record, status } = await ctx.org.records.create(orgMemberRecordType(role) as any, {
      data,
      tags            : { did },
      parentContextId : org.record.contextId ?? '',
      recipient       : did,
    } as any);
    if (status.code >= 300 || !record) {
      return jsonValidationError(`Failed to set organization membership: ${status.detail}`);
    }
    target = { record, data, role };
  } else if (typeof body.alias === 'string' && body.alias !== target.data.alias) {
    const nextData: OrgMemberData = {
      ...target.data,
      alias: body.alias,
      ...(publicVisibility !== undefined ? { public: publicVisibility } : {}),
    };
    const { status } = await target.record.update({ data: nextData });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update organization membership: ${status.detail}`);
    }
    target = { ...target, data: nextData };
  }

  for (const member of existingRecords) {
    if (member.record.id === target.record.id) { continue; }
    const { status } = await member.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update organization membership: ${status.detail}`);
    }
  }

  return jsonOk(buildOrgMembershipResponse(org, target, buildApiUrl(url)));
}

export async function handleRemoveOrgMembership(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const members = await listOrgMemberRecords(ctx, org);
  const matching = members.filter(member => member.data.did === did);
  if (matching.length === 0) {
    return jsonNotFound(`User '${did}' is not an organization member.`);
  }

  for (const member of matching) {
    const { status } = await member.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to remove organization membership: ${status.detail}`);
    }
  }
  return jsonNoContent();
}

export async function handleListOrgRepos(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  return handleListRepos(ctx, ctx.did, url, `/orgs/${routeOrgPath(org)}/repos`, 'org');
}

export async function handleListOrgSecurityAdvisories(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const items: OrgSecurityAdvisoryItem[] = [];
  for (const entry of await listRepoEntries(ctx, ctx.did)) {
    const settings = await getRepoSettings(ctx, ctx.did, entry.repo);
    for (const advisory of securityAdvisoryEntries(settings)) {
      items.push({ advisory, repo: entry.repo });
    }
  }

  const itemByAdvisory = new Map<SecurityAdvisoryEntry, OrgSecurityAdvisoryItem>();
  for (const item of items) {
    itemByAdvisory.set(item.advisory, item);
  }

  const filtered = filterSecurityAdvisories(items.map(item => item.advisory), url);
  if ('status' in filtered) { return filtered; }

  const filteredItems = filtered
    .map(advisory => itemByAdvisory.get(advisory))
    .filter((item): item is OrgSecurityAdvisoryItem => Boolean(item));
  const pagination = parsePagination(url);
  const paged = paginate(filteredItems, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/orgs/${routeOrgPath(org)}/security-advisories`,
    pagination.page, pagination.perPage, filteredItems.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(item => buildSecurityAdvisoryResponse(item.advisory, ctx.did, item.repo, baseUrl)),
    extraHeaders,
  );
}

function orgCodeScanningAlertIsOnDefaultBranch(alert: CodeScanningAlertEntry, repo: RepoInfo): boolean {
  return alert.mostRecentInstance.ref === `refs/heads/${repo.defaultBranch || 'main'}`;
}

export async function handleListOrgCodeScanningAlerts(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const items: OrgCodeScanningAlertItem[] = [];
  for (const entry of await listRepoEntries(ctx, ctx.did)) {
    const settings = await getRepoSettings(ctx, ctx.did, entry.repo);
    for (const alert of codeScanningAlertEntries(settings)) {
      if (orgCodeScanningAlertIsOnDefaultBranch(alert, entry.repo)) {
        items.push({ alert, repo: entry.repo });
      }
    }
  }

  const itemByAlert = new Map<CodeScanningAlertEntry, OrgCodeScanningAlertItem>();
  for (const item of items) {
    itemByAlert.set(item.alert, item);
  }

  const filtered = filterCodeScanningAlerts(items.map(item => item.alert), url);
  if ('status' in filtered) { return filtered; }

  const filteredItems = filtered
    .map(alert => itemByAlert.get(alert))
    .filter((item): item is OrgCodeScanningAlertItem => Boolean(item));
  const pagination = parsePagination(url);
  const paged = paginate(filteredItems, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/orgs/${routeOrgPath(org)}/code-scanning/alerts`,
    pagination.page, pagination.perPage, filteredItems.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(item => ({
      ...buildCodeScanningAlertResponse(item.alert, ctx.did, item.repo, baseUrl),
      repository: buildRepoResponse(item.repo, ctx.did, item.repo.name, baseUrl),
    })),
    extraHeaders,
  );
}

export async function handleListOrgDependabotAlerts(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const items: OrgDependabotAlertItem[] = [];
  for (const entry of await listRepoEntries(ctx, ctx.did)) {
    const settings = await getRepoSettings(ctx, ctx.did, entry.repo);
    for (const alert of dependabotAlertEntries(settings)) {
      items.push({ alert, repo: entry.repo });
    }
  }

  const itemByAlert = new Map<DependabotAlertEntry, OrgDependabotAlertItem>();
  for (const item of items) {
    itemByAlert.set(item.alert, item);
  }

  const filtered = filterDependabotAlerts(items.map(item => item.alert), url);
  if ('status' in filtered) { return filtered; }

  const filteredItems = filtered
    .map(alert => itemByAlert.get(alert))
    .filter((item): item is OrgDependabotAlertItem => Boolean(item));
  const pagination = parsePagination(url);
  const paged = paginate(filteredItems, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/orgs/${routeOrgPath(org)}/dependabot/alerts`,
    pagination.page, pagination.perPage, filteredItems.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(item => buildDependabotAlertResponse(item.alert, ctx.did, item.repo, baseUrl)),
    extraHeaders,
  );
}

export async function handleListOrgSecretScanningAlerts(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const hideSecret = parseBooleanQuery(url, 'hide_secret');
  if (hideSecret !== null && typeof hideSecret !== 'boolean') { return hideSecret; }

  const items: OrgSecretScanningAlertItem[] = [];
  for (const entry of await listRepoEntries(ctx, ctx.did)) {
    const settings = await getRepoSettings(ctx, ctx.did, entry.repo);
    for (const alert of secretScanningAlertEntries(settings)) {
      items.push({ alert, repo: entry.repo });
    }
  }

  const itemByAlert = new Map<SecretScanningAlertEntry, OrgSecretScanningAlertItem>();
  for (const item of items) {
    itemByAlert.set(item.alert, item);
  }

  const filtered = filterSecretScanningAlerts(items.map(item => item.alert), url);
  if ('status' in filtered) { return filtered; }

  const filteredItems = filtered
    .map(alert => itemByAlert.get(alert))
    .filter((item): item is OrgSecretScanningAlertItem => Boolean(item));
  const pagination = parsePagination(url);
  const paged = paginate(filteredItems, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/orgs/${routeOrgPath(org)}/secret-scanning/alerts`,
    pagination.page, pagination.perPage, filteredItems.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(item => buildSecretScanningAlertResponse(item.alert, ctx.did, item.repo, baseUrl, hideSecret === true)),
    extraHeaders,
  );
}

export async function handleCreateOrgRepo(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>, url: URL, options: RepoCreateOptions = {},
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  return createRepoForOwner(ctx, ctx.did, body, url, options);
}

// ---------------------------------------------------------------------------
// Organization issue field handlers
// ---------------------------------------------------------------------------

export async function handleListOrgIssueFields(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const items = (await listOrgIssueFields(ctx, org)).map(buildIssueFieldResponse);
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/issue-fields`);
}

export async function handleCreateOrgIssueField(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const data = parseCreateIssueFieldInput(body);
  if ('status' in data) { return data; }
  if (await hasDuplicateIssueFieldName(ctx, org, data.name)) {
    return jsonValidationError(`Validation Failed: issue field '${data.name}' already exists.`);
  }

  const { record, status } = await ctx.org.records.create('org/issueField' as any, {
    data,
    tags            : issueFieldTags(data),
    parentContextId : org.record.contextId ?? '',
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create issue field: ${status.detail}`);
  }

  return jsonOk(buildIssueFieldResponse({ record, data }));
}

export async function handleUpdateOrgIssueField(
  ctx: AgentContext, routeOrg: string, routeFieldId: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const field = await findOrgIssueField(ctx, org, routeFieldId);
  if (!field) { return jsonNotFound(`Issue field '${decodeRouteParam(routeFieldId)}' not found.`); }

  const data = parseUpdateIssueFieldInput(field, body);
  if ('status' in data) { return data; }
  if (await hasDuplicateIssueFieldName(ctx, org, data.name, field.record.id)) {
    return jsonValidationError(`Validation Failed: issue field '${data.name}' already exists.`);
  }

  const { status } = await field.record.update({ data, tags: issueFieldTags(data) } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update issue field: ${status.detail}`);
  }

  return jsonOk(buildIssueFieldResponse({ ...field, data }));
}

export async function handleDeleteOrgIssueField(
  ctx: AgentContext, routeOrg: string, routeFieldId: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const field = await findOrgIssueField(ctx, org, routeFieldId);
  if (!field) { return jsonNotFound(`Issue field '${decodeRouteParam(routeFieldId)}' not found.`); }

  const { status } = await field.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete issue field: ${status.detail}`);
  }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// Organization issue type handlers
// ---------------------------------------------------------------------------

export async function handleListOrgIssueTypes(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const items = (await listOrgIssueTypes(ctx, org)).map(buildIssueTypeResponse);
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/issue-types`);
}

export async function handleCreateOrgIssueType(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const data = parseIssueTypeInput(body);
  if ('status' in data) { return data; }
  if (await hasDuplicateIssueTypeName(ctx, org, data.name)) {
    return jsonValidationError(`Validation Failed: issue type '${data.name}' already exists.`);
  }

  const { record, status } = await ctx.org.records.create('org/issueType' as any, {
    data,
    tags            : issueTypeTags(data),
    parentContextId : org.record.contextId ?? '',
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create issue type: ${status.detail}`);
  }

  return jsonOk(buildIssueTypeResponse({ record, data }));
}

export async function handleUpdateOrgIssueType(
  ctx: AgentContext, routeOrg: string, routeIssueTypeId: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const issueType = await findOrgIssueType(ctx, org, routeIssueTypeId);
  if (!issueType) { return jsonNotFound(`Issue type '${decodeRouteParam(routeIssueTypeId)}' not found.`); }

  const data = parseIssueTypeInput(body);
  if ('status' in data) { return data; }
  if (await hasDuplicateIssueTypeName(ctx, org, data.name, issueType.record.id)) {
    return jsonValidationError(`Validation Failed: issue type '${data.name}' already exists.`);
  }

  const { status } = await issueType.record.update({ data, tags: issueTypeTags(data) } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update issue type: ${status.detail}`);
  }

  return jsonOk(buildIssueTypeResponse({ ...issueType, data }));
}

export async function handleDeleteOrgIssueType(
  ctx: AgentContext, routeOrg: string, routeIssueTypeId: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const issueType = await findOrgIssueType(ctx, org, routeIssueTypeId);
  if (!issueType) { return jsonNotFound(`Issue type '${decodeRouteParam(routeIssueTypeId)}' not found.`); }

  const { status } = await issueType.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete issue type: ${status.detail}`);
  }
  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// Organization custom property handlers
// ---------------------------------------------------------------------------

export async function handleListOrgCustomProperties(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const properties = (await listOrgCustomProperties(ctx, org))
    .map(property => buildCustomPropertyResponse(org, property.data, baseUrl));
  return jsonOk(properties);
}

export async function handleUpsertOrgCustomProperties(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }
  if (!Array.isArray(body.properties)) {
    return jsonValidationError('Validation Failed: properties must be an array.');
  }

  const parsed: OrgCustomPropertyData[] = [];
  for (const item of body.properties) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return jsonValidationError('Validation Failed: each property must be an object.');
    }
    const property = parseCustomPropertyDefinitionInput(item as Record<string, unknown>);
    if ('status' in property) { return property; }
    parsed.push(property);
  }

  const baseUrl = buildApiUrl(url);
  const responses: Record<string, unknown>[] = [];
  for (const property of parsed) {
    const saved = await upsertOrgCustomProperty(ctx, org, property);
    if ('status' in saved) { return saved; }
    responses.push(buildCustomPropertyResponse(org, saved.data, baseUrl));
  }

  return jsonOk(responses);
}

export async function handleGetOrgCustomProperty(
  ctx: AgentContext, routeOrg: string, routePropertyName: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const property = await findOrgCustomProperty(ctx, org, routePropertyName);
  if (!property) { return jsonNotFound(`Custom property '${decodeRouteParam(routePropertyName)}' not found.`); }

  return jsonOk(buildCustomPropertyResponse(org, property.data, buildApiUrl(url)));
}

export async function handlePutOrgCustomProperty(
  ctx: AgentContext, routeOrg: string, routePropertyName: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const data = parseCustomPropertyDefinitionInput(body, decodeRouteParam(routePropertyName));
  if ('status' in data) { return data; }

  const saved = await upsertOrgCustomProperty(ctx, org, data);
  if ('status' in saved) { return saved; }

  return jsonOk(buildCustomPropertyResponse(org, saved.data, buildApiUrl(url)));
}

export async function handleDeleteOrgCustomProperty(
  ctx: AgentContext, routeOrg: string, routePropertyName: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const property = await findOrgCustomProperty(ctx, org, routePropertyName);
  if (!property) { return jsonNotFound(`Custom property '${decodeRouteParam(routePropertyName)}' not found.`); }

  const { status } = await property.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete custom property: ${status.detail}`);
  }
  return jsonNoContent();
}

export async function handleListOrgCustomPropertyValues(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const entries = filterOrgRepoCustomPropertyEntries(await listOrgRepoEntries(ctx), ctx.did, url);
  const items: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const settings = await getRepoSettingsEntry(ctx, entry);
    items.push(buildOrgRepoCustomPropertiesResponse(entry, ctx.did, settings.settings));
  }

  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/properties/values`);
}

export async function handleUpdateOrgCustomPropertyValues(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const definitions = new Map((await listOrgCustomProperties(ctx, org)).map(property => [property.data.propertyName, property.data]));
  const parsed = parseOrgCustomPropertyValuesInput(body, definitions);
  if ('status' in parsed) { return parsed; }

  const entries = await listOrgRepoEntries(ctx);
  const byName = new Map(entries.map(entry => [entry.repo.name, entry]));
  for (const repoName of parsed.repositoryNames) {
    if (!byName.has(repoName)) {
      return jsonNotFound(`Repository '${repoName}' not found in organization '${org.routeLogin}'.`);
    }
  }

  for (const repoName of parsed.repositoryNames) {
    const entry = byName.get(repoName);
    if (!entry) { continue; }

    const lookup = await getRepoSettingsEntry(ctx, entry);
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

    const saveError = await saveRepoSettingsEntry(ctx, lookup, settings);
    if (saveError) { return saveError; }
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// Team handlers
// ---------------------------------------------------------------------------

export async function handleListOrgTeams(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const items = (await listTeams(ctx, org)).map(team => buildTeamResponse(team, org, baseUrl));
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/teams`);
}

export async function handleListAuthenticatedUserTeams(
  ctx: AgentContext, url: URL,
): Promise<JsonResponse> {
  const matches: Array<{ members: TeamMemberEntry[]; org: OrgEntry; team: TeamEntry }> = [];
  for (const org of await listOrgEntries(ctx)) {
    for (const team of await listTeams(ctx, org)) {
      const members = await listTeamMembers(ctx, team);
      if (members.some(member => member.data.did === ctx.did && teamMemberIsActive(member))) {
        matches.push({ members, org, team });
      }
    }
  }

  matches.sort((a, b) => `${a.org.routeLogin}/${a.team.slug}`.localeCompare(`${b.org.routeLogin}/${b.team.slug}`));

  const baseUrl = buildApiUrl(url);
  const items = matches.map(({ members, org, team }) => buildDetailedTeamResponse(team, org, baseUrl, members.filter(teamMemberIsActive).length));
  return pagedResponse(items, url, '/user/teams');
}

export async function handleCreateOrgTeam(
  ctx: AgentContext, routeOrg: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }
  if (!isNonEmptyString(body.name)) {
    return jsonValidationError('Validation Failed: name is required.');
  }

  const privacy = teamPrivacyFromGitHub(body.privacy);
  if (!privacy) {
    return jsonValidationError('Validation Failed: privacy must be closed, visible, or secret.');
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    return jsonValidationError('Validation Failed: description must be a string or null.');
  }

  const name = body.name.trim();
  const existing = await findTeam(ctx, org, slugify(name));
  if (existing) {
    return jsonValidationError(`Validation Failed: team '${name}' already exists.`);
  }

  const data: TeamData = {
    name,
    privacy,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
  };
  const { record, status } = await ctx.org.records.create('org/team' as any, {
    data,
    parentContextId: org.record.contextId ?? '',
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create team: ${status.detail}`);
  }

  const team = { record, data, slug: slugify(data.name) };
  return jsonCreated(buildTeamResponse(team, org, buildApiUrl(url)));
}

export async function handleGetTeamById(
  ctx: AgentContext, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return jsonOk(buildTeamResponse(lookup.team, lookup.org, buildApiUrl(url)));
}

export async function handleGetOrgTeamById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return jsonOk(buildTeamResponse(lookup.team, lookup.org, buildApiUrl(url)));
}

export async function handleGetOrgTeam(
  ctx: AgentContext, routeOrg: string, routeTeam: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }
  return jsonOk(buildTeamResponse(team, org, buildApiUrl(url)));
}

export async function handleUpdateOrgTeam(
  ctx: AgentContext, routeOrg: string, routeTeam: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const next: TeamData = { ...team.data };
  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name)) {
      return jsonValidationError('Validation Failed: name must be a non-empty string.');
    }
    const name = body.name.trim();
    const existing = await findTeam(ctx, org, slugify(name));
    if (existing && existing.record.id !== team.record.id) {
      return jsonValidationError(`Validation Failed: team '${name}' already exists.`);
    }
    next.name = name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return jsonValidationError('Validation Failed: description must be a string or null.');
    }
    next.description = body.description ?? undefined;
  }
  if (body.privacy !== undefined) {
    const privacy = teamPrivacyFromGitHub(body.privacy);
    if (!privacy) {
      return jsonValidationError('Validation Failed: privacy must be closed, visible, or secret.');
    }
    next.privacy = privacy;
  }
  if (
    body.notification_setting !== undefined &&
    body.notification_setting !== 'notifications_enabled' &&
    body.notification_setting !== 'notifications_disabled'
  ) {
    return jsonValidationError('Validation Failed: notification_setting must be notifications_enabled or notifications_disabled.');
  }
  if (body.permission !== undefined && body.permission !== 'pull' && body.permission !== 'push' && body.permission !== 'admin') {
    return jsonValidationError('Validation Failed: permission must be pull, push, or admin.');
  }
  if (body.parent_team_id !== undefined && body.parent_team_id !== null) {
    return jsonValidationError('Validation Failed: nested teams are not supported by this forge.');
  }

  const { status } = await team.record.update({ data: next });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update team: ${status.detail}`);
  }

  return jsonOk(buildTeamResponse({ ...team, data: next, slug: slugify(next.name) }, org, buildApiUrl(url)));
}

export async function handleUpdateTeamById(
  ctx: AgentContext, routeTeamId: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleUpdateOrgTeam(ctx, lookup.org.routeLogin, lookup.team.slug, body, url);
}

export async function handleUpdateOrgTeamById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleUpdateOrgTeam(ctx, lookup.org.routeLogin, lookup.team.slug, body, url);
}

export async function handleListOrgTeamChildTeams(
  ctx: AgentContext, routeOrg: string, routeTeam: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  return pagedResponse([], url, `/orgs/${routeOrgPath(org)}/teams/${encodeURIComponent(team.slug)}/teams`);
}

export async function handleListTeamChildTeamsById(
  ctx: AgentContext, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamChildTeams(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgTeamChildTeamsById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamChildTeams(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgTeamInvitations(
  ctx: AgentContext, routeOrg: string, routeTeam: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const invitations = (await listTeamMembers(ctx, team))
    .filter(member => teamMemberState(member) === 'pending')
    .map(member => buildTeamInvitationResponse(team, member, org, baseUrl, ctx.did));
  return pagedResponse(invitations, url, `/orgs/${routeOrgPath(org)}/teams/${encodeURIComponent(team.slug)}/invitations`);
}

export async function handleListTeamInvitationsById(
  ctx: AgentContext, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamInvitations(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgTeamInvitationsById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamInvitations(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgInvitations(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const role = orgInvitationRoleFilter(url.searchParams.get('role'));
  if (!role) {
    return jsonValidationError('Validation Failed: role must be one of all, admin, direct_member, billing_manager, hiring_manager.');
  }

  const source = orgInvitationSourceFilter(url.searchParams.get('invitation_source'));
  if (!source) {
    return jsonValidationError('Validation Failed: invitation_source must be one of all, member, scim.');
  }

  const baseUrl = buildApiUrl(url);
  const invitations = (await listPendingOrgInvitations(ctx, org))
    .filter(() => role === 'all' || role === 'direct_member')
    .filter(() => source === 'all' || source === 'member')
    .map(invitation => buildOrgInvitationResponse(org, invitation, baseUrl, ctx.did));
  return pagedResponse(invitations, url, `/orgs/${routeOrgPath(org)}/invitations`);
}

export async function handleListFailedOrgInvitations(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  return pagedResponse([], url, `/orgs/${routeOrgPath(org)}/failed_invitations`);
}

export async function handleListOutsideCollaborators(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const filter = outsideCollaboratorFilter(url.searchParams.get('filter'));
  if (!filter) {
    return jsonValidationError('Validation Failed: filter must be one of all, 2fa_disabled, or 2fa_insecure.');
  }

  const baseUrl = buildApiUrl(url);
  const collaborators = filter === 'all'
    ? await listOutsideCollaborators(ctx, org)
    : [];
  const items = collaborators.map(collab => buildOutsideCollaboratorUser(collab, baseUrl));
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/outside_collaborators`);
}

export async function handleConvertOrgMemberToOutsideCollaborator(
  ctx: AgentContext, routeOrg: string, memberDid: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  if (body.async !== undefined && typeof body.async !== 'boolean') {
    return jsonValidationError('Validation Failed: async must be a boolean.');
  }

  const did = decodeRouteParam(memberDid);
  const members = await listOrgMemberRecords(ctx, org);
  const matching = members.filter(member => member.data.did === did);
  if (matching.length === 0) {
    return jsonForbidden(`User '${did}' is not an organization member.`);
  }

  const ownerDids = orgOwnerDidSet(members);
  if (matching.some(member => member.role === 'admin') && ownerDids.size <= 1) {
    return jsonForbidden(`User '${did}' is the last organization owner.`);
  }

  for (const member of matching) {
    const { status } = await member.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to convert organization member to outside collaborator: ${status.detail}`);
    }
  }

  return body.async === true ? jsonAccepted({}) : jsonNoContent();
}

export async function handleRemoveOutsideCollaborator(
  ctx: AgentContext, routeOrg: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findOrgMember(ctx, org, did);
  if (member) {
    return jsonValidationError(`Validation Failed: User '${did}' is an organization member.`);
  }

  const roleDelete = await deleteOutsideCollaboratorRepoRoles(ctx, did);
  if (roleDelete) { return roleDelete; }

  const teamDelete = await deleteOutsideCollaboratorTeamMemberships(ctx, org, did);
  if (teamDelete) { return teamDelete; }

  return jsonNoContent();
}

export async function handleListOrgInvitationTeams(
  ctx: AgentContext, routeOrg: string, routeInvitationId: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const invitation = await findOrgInvitation(ctx, org, routeInvitationId);
  if (!invitation) {
    return jsonNotFound(`Organization invitation '${decodeRouteParam(routeInvitationId)}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  const teams = invitation.teams.map(team => buildTeamResponse(team, org, baseUrl));
  return pagedResponse(teams, url, `/orgs/${routeOrgPath(org)}/invitations/${decodeRouteParam(routeInvitationId)}/teams`);
}

export async function handleCancelOrgInvitation(
  ctx: AgentContext, routeOrg: string, routeInvitationId: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const invitation = await findOrgInvitation(ctx, org, routeInvitationId);
  if (!invitation) {
    return jsonNotFound(`Organization invitation '${decodeRouteParam(routeInvitationId)}' not found.`);
  }

  for (const member of invitation.members) {
    const { status } = await member.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to cancel organization invitation: ${status.detail}`);
    }
  }
  return jsonNoContent();
}

export async function handleDeleteOrgTeam(
  ctx: AgentContext, routeOrg: string, routeTeam: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  for (const member of await listTeamMembers(ctx, team)) {
    const { status } = await member.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete team membership: ${status.detail}`);
    }
  }

  const { status } = await team.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete team: ${status.detail}`);
  }
  return jsonNoContent();
}

export async function handleDeleteTeamById(
  ctx: AgentContext, routeTeamId: string,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleDeleteOrgTeam(ctx, lookup.org.routeLogin, lookup.team.slug);
}

export async function handleDeleteOrgTeamById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleDeleteOrgTeam(ctx, lookup.org.routeLogin, lookup.team.slug);
}

export async function handleListOrgTeamRepos(
  ctx: AgentContext, routeOrg: string, routeTeam: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const grants = Object.values(teamRepositoryGrants(team)).sort((a, b) => teamRepoKey(a.owner, a.repo).localeCompare(teamRepoKey(b.owner, b.repo)));
  const items: Record<string, unknown>[] = [];
  for (const grant of grants) {
    const repo = await getRepoRecord(ctx, grant.owner, grant.repo);
    if (!repo) { continue; }
    items.push(buildTeamRepositoryResponse(repo, grant.owner, repo.name, baseUrl, grant.permission));
  }

  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/teams/${encodeURIComponent(team.slug)}/repos`);
}

export async function handleListTeamReposById(
  ctx: AgentContext, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamRepos(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgTeamReposById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamRepos(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListRepoTeams(
  ctx: AgentContext, routeOwner: string, routeRepo: string, url: URL,
): Promise<JsonResponse> {
  const owner = decodeRouteParam(routeOwner);
  const repoName = decodeRouteParam(routeRepo);
  const repo = await getRepoRecord(ctx, owner, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${owner}'.`);
  }

  const matches: Array<{ org: OrgEntry; permission: TeamRepositoryPermission; team: TeamEntry }> = [];
  for (const org of await listOrgEntries(ctx)) {
    for (const team of await listTeams(ctx, org)) {
      const grant = Object.values(teamRepositoryGrants(team))
        .find(item => item.owner === owner && item.repo === repo.name);
      if (grant) {
        matches.push({ org, permission: grant.permission, team });
      }
    }
  }

  matches.sort((a, b) => `${a.org.routeLogin}/${a.team.slug}`.localeCompare(`${b.org.routeLogin}/${b.team.slug}`));

  const baseUrl = buildApiUrl(url);
  const items = matches.map(({ org, permission, team }) => ({
    ...buildTeamResponse(team, org, baseUrl),
    permission,
  }));
  return pagedResponse(items, url, `/repos/${owner}/${repo.name}/teams`);
}

export async function handleCheckOrgTeamRepo(
  ctx: AgentContext, routeOrg: string, routeTeam: string, routeOwner: string, routeRepo: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const owner = decodeRouteParam(routeOwner);
  const repoName = decodeRouteParam(routeRepo);
  const grant = teamRepositoryGrants(team)[teamRepoKey(owner, repoName)];
  if (!grant) {
    return jsonNotFound(`Team '${team.slug}' does not have repository '${owner}/${repoName}'.`);
  }

  const repo = await getRepoRecord(ctx, grant.owner, grant.repo);
  if (!repo) {
    return jsonNotFound(`Repository '${owner}/${repoName}' not found.`);
  }

  return jsonOk(buildTeamRepositoryResponse(repo, grant.owner, repo.name, buildApiUrl(url), grant.permission));
}

export async function handleCheckTeamRepoById(
  ctx: AgentContext, routeTeamId: string, routeOwner: string, routeRepo: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleCheckOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo, url);
}

export async function handleCheckOrgTeamRepoById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, routeOwner: string, routeRepo: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleCheckOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo, url);
}

export async function handleAddOrUpdateOrgTeamRepo(
  ctx: AgentContext, routeOrg: string, routeTeam: string, routeOwner: string, routeRepo: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const owner = decodeRouteParam(routeOwner);
  const repoName = decodeRouteParam(routeRepo);
  if (owner !== ctx.did) {
    return jsonValidationError('Validation Failed: repository must be owned by the organization.');
  }

  const repo = await getRepoRecord(ctx, owner, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${owner}'.`);
  }

  const permission = teamRepositoryPermission(body.permission);
  if (!permission) {
    return jsonValidationError('Validation Failed: permission must be pull, triage, push, maintain, or admin.');
  }

  const repositories = {
    ...teamRepositoryGrants(team),
    [teamRepoKey(owner, repo.name)]: { owner, repo: repo.name, permission },
  };
  const next: TeamData = { ...team.data, repositories };
  const { status } = await team.record.update({ data: next });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update team repository permissions: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleAddOrUpdateTeamRepoById(
  ctx: AgentContext, routeTeamId: string, routeOwner: string, routeRepo: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleAddOrUpdateOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo, body);
}

export async function handleAddOrUpdateOrgTeamRepoById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, routeOwner: string, routeRepo: string, body: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleAddOrUpdateOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo, body);
}

export async function handleRemoveOrgTeamRepo(
  ctx: AgentContext, routeOrg: string, routeTeam: string, routeOwner: string, routeRepo: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const owner = decodeRouteParam(routeOwner);
  const repoName = decodeRouteParam(routeRepo);
  const repositories = teamRepositoryGrants(team);
  const key = teamRepoKey(owner, repoName);
  if (!repositories[key]) {
    return jsonNotFound(`Team '${team.slug}' does not have repository '${owner}/${repoName}'.`);
  }

  delete repositories[key];
  const next: TeamData = { ...team.data, repositories };
  const { status } = await team.record.update({ data: next });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to remove team repository permissions: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleRemoveTeamRepoById(
  ctx: AgentContext, routeTeamId: string, routeOwner: string, routeRepo: string,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleRemoveOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo);
}

export async function handleRemoveOrgTeamRepoById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, routeOwner: string, routeRepo: string,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleRemoveOrgTeamRepo(ctx, lookup.org.routeLogin, lookup.team.slug, routeOwner, routeRepo);
}

export async function handleListOrgTeamMembers(
  ctx: AgentContext, routeOrg: string, routeTeam: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const roleFilter = teamMemberRoleFilter(url.searchParams.get('role'));
  if (!roleFilter) {
    return jsonValidationError('Validation Failed: role must be one of member, maintainer, all.');
  }

  const baseUrl = buildApiUrl(url);
  const orgOwnerDids = orgOwnerDidSet(await listOrgMembers(ctx, org));
  const members = await listTeamMembers(ctx, team);
  const items = members
    .filter(teamMemberIsActive)
    .filter(member => roleFilter === 'all' || teamMemberEffectiveRole(member, orgOwnerDids) === roleFilter)
    .map(member => buildOrgUser(member, baseUrl));
  return pagedResponse(items, url, `/orgs/${routeOrgPath(org)}/teams/${encodeURIComponent(team.slug)}/members`);
}

export async function handleListTeamMembersById(
  ctx: AgentContext, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamMembers(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleListOrgTeamMembersById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleListOrgTeamMembers(ctx, lookup.org.routeLogin, lookup.team.slug, url);
}

export async function handleCheckOrgTeamMember(
  ctx: AgentContext, routeOrg: string, routeTeam: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const member = await findTeamMember(ctx, team, decodeRouteParam(memberDid));
  return member && teamMemberIsActive(member) ? jsonNoContent() : jsonNotFound(`User '${decodeRouteParam(memberDid)}' is not a team member.`);
}

export async function handleCheckTeamMemberById(
  ctx: AgentContext, routeTeamId: string, memberDid: string,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleCheckOrgTeamMember(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid);
}

export async function handleAddOrgTeamMembership(
  ctx: AgentContext, routeOrg: string, routeTeam: string, memberDid: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  if (!isNonEmptyString(did)) {
    return jsonValidationError('Validation Failed: member must be a DID.');
  }

  const role = teamMemberRole(body.role);
  if (!role) {
    return jsonValidationError('Validation Failed: role must be one of member, maintainer.');
  }

  const baseUrl = buildApiUrl(url);
  const orgMembers = await listOrgMembers(ctx, org);
  const orgOwnerDids = orgOwnerDidSet(orgMembers);
  const state: TeamMemberState = orgMemberDidSet(orgMembers).has(did) ? 'active' : 'pending';
  const existing = await findTeamMember(ctx, team, did);
  if (existing) {
    const alias = typeof body.alias === 'string' ? body.alias : existing.data.alias;
    const nextData: TeamMemberData = { ...existing.data, role, state, ...(alias ? { alias } : {}) };
    const { status } = await existing.record.update({ data: nextData });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update team membership: ${status.detail}`);
    }
    const updated = { ...existing, data: nextData };
    return jsonOk(buildTeamMembershipResponse(team, updated, org, baseUrl, teamMemberEffectiveRole(updated, orgOwnerDids), teamMemberState(updated)));
  }

  const alias = typeof body.alias === 'string' ? body.alias : undefined;
  const data: TeamMemberData = { did, role, state, ...(alias ? { alias } : {}) };
  const { record, status } = await ctx.org.records.create('org/team/teamMember' as any, {
    data,
    tags            : { did },
    parentContextId : team.record.contextId ?? '',
    recipient       : did,
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to add team membership: ${status.detail}`);
  }

  const member = { record, data };
  return jsonOk(buildTeamMembershipResponse(team, member, org, baseUrl, teamMemberEffectiveRole(member, orgOwnerDids), teamMemberState(member)));
}

export async function handleAddTeamMembershipById(
  ctx: AgentContext, routeTeamId: string, memberDid: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleAddOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid, body, url);
}

export async function handleAddOrgTeamMembershipById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, memberDid: string, body: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleAddOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid, body, url);
}

export async function handleGetOrgTeamMembership(
  ctx: AgentContext, routeOrg: string, routeTeam: string, memberDid: string, url: URL,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const did = decodeRouteParam(memberDid);
  const member = await findTeamMember(ctx, team, did);
  if (!member) {
    return jsonNotFound(`User '${did}' is not a team member.`);
  }

  const orgOwnerDids = orgOwnerDidSet(await listOrgMembers(ctx, org));
  const role = teamMemberEffectiveRole(member, orgOwnerDids);
  const state = teamMemberState(member);
  return jsonOk(buildTeamMembershipResponse(team, member, org, buildApiUrl(url), role, state));
}

export async function handleGetTeamMembershipById(
  ctx: AgentContext, routeTeamId: string, memberDid: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleGetOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid, url);
}

export async function handleGetOrgTeamMembershipById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, memberDid: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleGetOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid, url);
}

export async function handleRemoveOrgTeamMembership(
  ctx: AgentContext, routeOrg: string, routeTeam: string, memberDid: string,
): Promise<JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) { return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`); }

  const team = await findTeam(ctx, org, routeTeam);
  if (!team) { return jsonNotFound(`Team '${decodeRouteParam(routeTeam)}' not found.`); }

  const member = await findTeamMember(ctx, team, decodeRouteParam(memberDid));
  if (!member) { return jsonNotFound(`User '${decodeRouteParam(memberDid)}' is not a team member.`); }

  const { status } = await member.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to remove team membership: ${status.detail}`);
  }
  return jsonNoContent();
}

export async function handleRemoveTeamMembershipById(
  ctx: AgentContext, routeTeamId: string, memberDid: string,
): Promise<JsonResponse> {
  const lookup = await findTeamByNumericId(ctx, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleRemoveOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid);
}

export async function handleRemoveOrgTeamMembershipById(
  ctx: AgentContext, routeOrgId: string, routeTeamId: string, memberDid: string,
): Promise<JsonResponse> {
  const lookup = await findOrgTeamByNumericIds(ctx, routeOrgId, routeTeamId);
  if (!lookup) { return jsonNotFound(`Team '${decodeRouteParam(routeTeamId)}' not found.`); }

  return handleRemoveOrgTeamMembership(ctx, lookup.org.routeLogin, lookup.team.slug, memberDid);
}
