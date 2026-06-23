/**
 * GitHub API shim — GitHub Pages endpoints.
 *
 * Stores GitHub-compatible Pages site, build, and deployment metadata in the
 * repository settings record.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import {
  baseHeaders,
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

type PagesBuildType = 'legacy' | 'workflow';
type PagesBuildStatus = 'queued' | 'building' | 'built' | 'errored';
type PagesDeploymentStatus = 'pending' | 'succeed' | 'failed' | 'cancelled';

type PagesSource = {
  branch : string;
  path : '/' | '/docs';
};

type PagesBuildEntry = {
  id : number;
  status : PagesBuildStatus;
  errorMessage : string | null;
  pusherDid : string;
  commit : string;
  duration : number;
  createdAt : string;
  updatedAt : string;
};

type PagesDeploymentEntry = {
  id : string;
  artifactId? : number;
  artifactUrl? : string;
  environment : string;
  pagesBuildVersion : string;
  oidcTokenHash : string;
  status : PagesDeploymentStatus;
  createdAt : string;
  updatedAt : string;
};

type PagesSettingsEntry = {
  status : PagesBuildStatus;
  cname : string | null;
  custom404 : boolean;
  source : PagesSource | null;
  buildType : PagesBuildType;
  public : boolean;
  httpsEnforced : boolean;
  createdAt : string;
  updatedAt : string;
  builds? : Record<string, PagesBuildEntry>;
  deployments? : Record<string, PagesDeploymentEntry>;
};

type RepoSettingsData = {
  pages? : PagesSettingsEntry;
};

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

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

function jsonConflict(message: string): JsonResponse {
  return {
    status  : 409,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest/pages/pages' }),
  };
}

function pagesKey(id: string | number): string {
  return String(id);
}

function sha1(...parts: string[]): string {
  return createHash('sha1').update(parts.join(':')).digest('hex');
}

function pagesHtmlUrl(site: PagesSettingsEntry, targetDid: string, repoName: string): string {
  if (site.cname) {
    return `https://${site.cname}`;
  }
  return `https://${encodeURIComponent(targetDid)}.pages.enbox.local/${encodeURIComponent(repoName)}`;
}

function parseSource(value: unknown, required: boolean): PagesSource | null | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    if (!required) { return undefined; }
    return jsonValidationError('Validation Failed: source.branch is required.');
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object') {
    return jsonValidationError('Validation Failed: source must be an object.');
  }

  const branch = (value as { branch?: unknown }).branch;
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    return jsonValidationError('Validation Failed: source.branch is required.');
  }

  const rawPath = (value as { path?: unknown }).path;
  const path = typeof rawPath === 'undefined' ? '/' : rawPath;
  if (path !== '/' && path !== '/docs') {
    return jsonValidationError('Validation Failed: source.path must be / or /docs.');
  }

  return { branch: branch.trim(), path };
}

function parseBuildType(value: unknown): PagesBuildType | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (value !== 'legacy' && value !== 'workflow') {
    return jsonValidationError('Validation Failed: build_type must be legacy or workflow.');
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

function parseOptionalCname(value: unknown): string | null | undefined | JsonResponse {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonValidationError('Validation Failed: cname must be a non-empty string or null.');
  }
  return value.trim();
}

function nextBuildId(site: PagesSettingsEntry): number {
  const ids = Object.values(site.builds ?? {}).map(build => build.id);
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

function pagesBuildEntries(site: PagesSettingsEntry): PagesBuildEntry[] {
  return Object.values(site.builds ?? {}).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function buildPagesSiteResponse(
  site: PagesSettingsEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const htmlUrl = pagesHtmlUrl(site, targetDid, repoName);
  const certificateDomain = site.cname ?? `${targetDid}.pages.enbox.local`;
  return {
    url                          : `${baseUrl}/repos/${targetDid}/${repoName}/pages`,
    status                       : site.status,
    cname                        : site.cname,
    custom_404                   : site.custom404,
    html_url                     : htmlUrl,
    source                       : site.source ? { branch: site.source.branch, path: site.source.path } : null,
    public                       : site.public,
    pending_domain_unverified_at : null,
    protected_domain_state       : site.cname ? 'verified' : null,
    https_certificate            : {
      state       : 'approved',
      description : 'Certificate is approved',
      domains     : [certificateDomain],
      expires_at  : null,
    },
    https_enforced: site.httpsEnforced,
  };
}

function buildPagesBuildResponse(
  build: PagesBuildEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    url        : `${baseUrl}/repos/${targetDid}/${repoName}/pages/builds/${build.id}`,
    status     : build.status,
    error      : { message: build.errorMessage },
    pusher     : buildOwner(build.pusherDid, baseUrl),
    commit     : build.commit,
    duration   : build.duration,
    created_at : toISODate(build.createdAt),
    updated_at : toISODate(build.updatedAt),
  };
}

function buildDeploymentResponse(
  deployment: PagesDeploymentEntry, site: PagesSettingsEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  return {
    id         : deployment.id,
    status_url : `${baseUrl}/repos/${targetDid}/${repoName}/pages/deployments/${deployment.id}/status`,
    page_url   : pagesHtmlUrl(site, targetDid, repoName),
  };
}

function buildHealthDomain(host: string, httpsEnforced: boolean): Record<string, unknown> {
  return {
    host,
    uri                                  : `http://${host}/`,
    nameservers                          : 'default',
    dns_resolves                         : true,
    is_proxied                           : false,
    is_cloudflare_ip                     : false,
    is_fastly_ip                         : false,
    is_old_ip_address                    : false,
    is_a_record                          : true,
    has_cname_record                     : !host.startsWith('www.'),
    has_mx_records_present               : false,
    is_valid_domain                      : true,
    is_apex_domain                       : !host.startsWith('www.'),
    should_be_a_record                   : !host.startsWith('www.'),
    is_cname_to_github_user_domain       : false,
    is_cname_to_pages_dot_github_dot_com : false,
    is_cname_to_fastly                   : false,
    is_pointed_to_github_pages_ip        : true,
    is_non_github_pages_ip_present       : false,
    is_pages_domain                      : false,
    is_served_by_pages                   : true,
    is_valid                             : true,
    reason                               : null,
    responds_to_https                    : true,
    enforces_https                       : httpsEnforced,
    https_error                          : null,
    is_https_eligible                    : true,
    caa_error                            : null,
  };
}

function requirePagesSite(lookup: RepoSettingsLookup): PagesSettingsEntry | JsonResponse {
  if (!lookup.settings.pages) {
    return jsonNotFound('GitHub Pages site not found.');
  }
  return lookup.settings.pages;
}

function isJsonResponse(value: PagesSettingsEntry | JsonResponse): value is JsonResponse {
  return typeof (value as JsonResponse).status === 'number';
}

function createQueuedBuild(site: PagesSettingsEntry, ctx: AgentContext, lookup: RepoSettingsLookup): PagesBuildEntry {
  const now = new Date().toISOString();
  const id = nextBuildId(site);
  return {
    id,
    status       : 'queued',
    errorMessage : null,
    pusherDid    : ctx.did,
    commit       : sha1(lookup.repo.contextId, lookup.repo.defaultBranch, String(id), now),
    duration     : 0,
    createdAt    : now,
    updatedAt    : now,
  };
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/pages
// ---------------------------------------------------------------------------

export async function handleGetPagesSite(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  return jsonOk(buildPagesSiteResponse(site, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleCreatePagesSite(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }
  if (lookup.settings.pages) {
    return jsonConflict('GitHub Pages site already exists.');
  }

  const buildType = parseBuildType(reqBody.build_type);
  if (typeof buildType === 'object') { return buildType; }

  const source = parseSource(reqBody.source, buildType !== 'workflow');
  if (typeof source === 'object' && source !== null && 'status' in source) { return source; }

  const now = new Date().toISOString();
  const site: PagesSettingsEntry = {
    status        : 'built',
    cname         : null,
    custom404     : false,
    source        : source === undefined ? null : source,
    buildType     : buildType ?? 'legacy',
    public        : lookup.repo.visibility === 'public',
    httpsEnforced : true,
    createdAt     : now,
    updatedAt     : now,
    builds        : {},
    deployments   : {},
  };

  const saveError = await saveRepoSettings(ctx, lookup, { ...lookup.settings, pages: site });
  if (saveError) { return saveError; }

  return jsonCreated(buildPagesSiteResponse(site, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleUpdatePagesSite(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const buildType = parseBuildType(reqBody.build_type);
  if (typeof buildType === 'object') { return buildType; }

  const source = parseSource(reqBody.source, false);
  if (typeof source === 'object' && source !== null && 'status' in source) { return source; }

  const cname = parseOptionalCname(reqBody.cname);
  if (typeof cname === 'object' && cname !== null && 'status' in cname) { return cname; }

  const httpsEnforced = parseOptionalBoolean(reqBody.https_enforced, 'https_enforced');
  if (typeof httpsEnforced === 'object') { return httpsEnforced; }

  const updated: PagesSettingsEntry = {
    ...site,
    cname         : cname === undefined ? site.cname : cname,
    httpsEnforced : httpsEnforced ?? site.httpsEnforced,
    buildType     : buildType ?? site.buildType,
    source        : source === undefined ? site.source : source,
    updatedAt     : new Date().toISOString(),
  };

  const saveError = await saveRepoSettings(ctx, lookup, { ...lookup.settings, pages: updated });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleDeletePagesSite(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  if (!lookup.settings.pages) {
    return jsonNotFound('GitHub Pages site not found.');
  }

  const next = { ...lookup.settings };
  delete next.pages;
  const saveError = await saveRepoSettings(ctx, lookup, next);
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/pages/builds
// ---------------------------------------------------------------------------

export async function handleListPagesBuilds(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const builds = pagesBuildEntries(site);
  const paged = paginate(builds, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/pages/builds`,
    pagination.page, pagination.perPage, builds.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(build => buildPagesBuildResponse(build, targetDid, lookup.repo.name, baseUrl)),
    extraHeaders,
  );
}

export async function handleRequestPagesBuild(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const build = createQueuedBuild(site, ctx, lookup);
  const updated: PagesSettingsEntry = {
    ...site,
    status    : 'queued',
    updatedAt : build.updatedAt,
    builds    : {
      ...(site.builds ?? {}),
      [pagesKey(build.id)]: build,
    },
  };

  const saveError = await saveRepoSettings(ctx, lookup, { ...lookup.settings, pages: updated });
  if (saveError) { return saveError; }

  return jsonCreated({
    url    : `${buildApiUrl(url)}/repos/${targetDid}/${lookup.repo.name}/pages/builds/latest`,
    status : build.status,
  });
}

export async function handleGetLatestPagesBuild(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const latest = pagesBuildEntries(site)[0];
  if (!latest) {
    return jsonNotFound('GitHub Pages build not found.');
  }

  return jsonOk(buildPagesBuildResponse(latest, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleGetPagesBuild(
  ctx: AgentContext, targetDid: string, repoName: string, buildId: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const build = site.builds?.[pagesKey(parseInt(buildId, 10))];
  if (!build) {
    return jsonNotFound(`GitHub Pages build ${buildId} not found.`);
  }

  return jsonOk(buildPagesBuildResponse(build, targetDid, lookup.repo.name, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/pages/deployments
// ---------------------------------------------------------------------------

export async function handleCreatePagesDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const artifactId = reqBody.artifact_id;
  const artifactUrl = reqBody.artifact_url;
  if (
    (typeof artifactId === 'undefined' || !Number.isInteger(artifactId))
    && (typeof artifactUrl !== 'string' || artifactUrl.trim().length === 0)
  ) {
    return jsonValidationError('Validation Failed: artifact_id or artifact_url is required.');
  }

  const pagesBuildVersion = reqBody.pages_build_version;
  if (typeof pagesBuildVersion !== 'string' || pagesBuildVersion.trim().length === 0) {
    return jsonValidationError('Validation Failed: pages_build_version is required.');
  }

  const oidcToken = reqBody.oidc_token;
  if (typeof oidcToken !== 'string' || oidcToken.trim().length === 0) {
    return jsonValidationError('Validation Failed: oidc_token is required.');
  }

  const environment = typeof reqBody.environment === 'string' && reqBody.environment.trim()
    ? reqBody.environment.trim()
    : 'github-pages';
  const id = pagesBuildVersion.trim();
  const now = new Date().toISOString();
  const deployment: PagesDeploymentEntry = {
    id,
    artifactId        : Number.isInteger(artifactId) ? artifactId as number : undefined,
    artifactUrl       : typeof artifactUrl === 'string' ? artifactUrl.trim() : undefined,
    environment,
    pagesBuildVersion : id,
    oidcTokenHash     : sha1(oidcToken),
    status            : 'succeed',
    createdAt         : now,
    updatedAt         : now,
  };

  const updated: PagesSettingsEntry = {
    ...site,
    status      : 'built',
    updatedAt   : now,
    deployments : {
      ...(site.deployments ?? {}),
      [deployment.id]: deployment,
    },
  };

  const saveError = await saveRepoSettings(ctx, lookup, { ...lookup.settings, pages: updated });
  if (saveError) { return saveError; }

  return jsonOk(buildDeploymentResponse(deployment, updated, targetDid, lookup.repo.name, buildApiUrl(url)));
}

export async function handleGetPagesDeploymentStatus(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const deployment = site.deployments?.[deploymentId];
  if (!deployment) {
    return jsonNotFound(`GitHub Pages deployment ${deploymentId} not found.`);
  }

  return jsonOk({ status: deployment.status });
}

export async function handleCancelPagesDeployment(
  ctx: AgentContext, targetDid: string, repoName: string, deploymentId: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  const deployment = site.deployments?.[deploymentId];
  if (!deployment) {
    return jsonNotFound(`GitHub Pages deployment ${deploymentId} not found.`);
  }

  const updatedDeployment: PagesDeploymentEntry = {
    ...deployment,
    status    : 'cancelled',
    updatedAt : new Date().toISOString(),
  };
  const updated: PagesSettingsEntry = {
    ...site,
    deployments: {
      ...(site.deployments ?? {}),
      [deploymentId]: updatedDeployment,
    },
  };

  const saveError = await saveRepoSettings(ctx, lookup, { ...lookup.settings, pages: updated });
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/pages/health
// ---------------------------------------------------------------------------

export async function handleGetPagesHealth(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const site = requirePagesSite(lookup);
  if (isJsonResponse(site)) { return site; }

  if (!site.cname) {
    return jsonValidationError('Validation Failed: there isn\'t a CNAME for this page.');
  }

  const host = site.cname;
  const altHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return jsonOk({
    domain     : buildHealthDomain(host, site.httpsEnforced),
    alt_domain : buildHealthDomain(altHost, site.httpsEnforced),
  });
}
