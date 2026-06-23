/**
 * GitHub API shim — repository webhook endpoints.
 *
 * Maps owner-only encrypted forge repo webhook records to GitHub REST API v3
 * repository webhook responses.
 *
 * @module
 */

import { createHmac, randomUUID } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { OrgData } from '../org.js';
import type { JsonResponse, RepoInfo } from './helpers.js';
import type { WebhookData as RepoWebhookData, WebhookDeliveryData } from '../repo.js';

import {
  buildApiUrl,
  buildLinkHeader,
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

type WebhookData = RepoWebhookData;

type WebhookEntry = {
  record : any;
  data : WebhookData;
};

type OrgEntry = {
  record : any;
  data : Pick<OrgData, 'name'>;
  slug : string;
  routeLogin : string;
};

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeWebhookUrl(value: unknown): string | JsonResponse {
  if (typeof value !== 'string' || value.trim() === '') {
    return jsonValidationError('Validation Failed: config.url must be a URL string.');
  }

  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonValidationError('Validation Failed: config.url must use http or https.');
    }
  } catch {
    return jsonValidationError('Validation Failed: config.url must be a URL string.');
  }

  return url;
}

function normalizeSecret(value: unknown): string | JsonResponse {
  if (value === undefined || value === null) { return ''; }
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: config.secret must be a string.');
  }
  return value;
}

function normalizeEvents(value: unknown, fieldName: string, fallback: string[] = ['push']): string[] | JsonResponse {
  if (value === undefined || value === null) { return fallback; }
  if (!Array.isArray(value)) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be an array of strings.`);
  }

  const normalized: string[] = [];
  for (const event of value) {
    if (typeof event !== 'string' || event.trim() === '') {
      return jsonValidationError(`Validation Failed: ${fieldName} must be an array of strings.`);
    }
    const name = event.trim();
    if (!normalized.includes(name)) {
      normalized.push(name);
    }
  }
  return normalized;
}

function validateContentType(value: unknown): JsonResponse | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (value !== 'json' && value !== 'form') {
    return jsonValidationError('Validation Failed: config.content_type must be json or form.');
  }
  return undefined;
}

function validateInsecureSsl(value: unknown): JsonResponse | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (value === '0' || value === '1' || value === 0 || value === 1) {
    return undefined;
  }
  return jsonValidationError('Validation Failed: config.insecure_ssl must be 0 or 1.');
}

function normalizeActive(value: unknown, fallback: boolean): boolean | JsonResponse {
  if (value === undefined || value === null) { return fallback; }
  if (typeof value !== 'boolean') {
    return jsonValidationError('Validation Failed: active must be a boolean.');
  }
  return value;
}

function parseCreateWebhook(reqBody: Record<string, unknown>): WebhookData | JsonResponse {
  if (reqBody.name !== undefined && reqBody.name !== 'web') {
    return jsonValidationError('Validation Failed: name must be web.');
  }
  if (!isObject(reqBody.config)) {
    return jsonValidationError('Validation Failed: config is required.');
  }
  const config = reqBody.config;

  const contentTypeError = validateContentType(config.content_type);
  if (contentTypeError) { return contentTypeError; }
  const insecureSslError = validateInsecureSsl(config.insecure_ssl);
  if (insecureSslError) { return insecureSslError; }

  const url = normalizeWebhookUrl(config.url);
  if (typeof url !== 'string') { return url; }
  const secret = normalizeSecret(config.secret);
  if (typeof secret !== 'string') { return secret; }
  const events = normalizeEvents(reqBody.events, 'events');
  if (!Array.isArray(events)) { return events; }
  const active = normalizeActive(reqBody.active, true);
  if (typeof active !== 'boolean') { return active; }

  return { url, secret, events, active };
}

function applyEventPatch(current: string[], reqBody: Record<string, unknown>): string[] | JsonResponse {
  const replacement = normalizeEvents(reqBody.events, 'events', current);
  if (!Array.isArray(replacement)) { return replacement; }

  const addEvents = normalizeEvents(reqBody.add_events, 'add_events', []);
  if (!Array.isArray(addEvents)) { return addEvents; }
  const removeEvents = normalizeEvents(reqBody.remove_events, 'remove_events', []);
  if (!Array.isArray(removeEvents)) { return removeEvents; }

  let updated = [...replacement];
  for (const event of addEvents) {
    if (!updated.includes(event)) {
      updated.push(event);
    }
  }
  if (removeEvents.length > 0) {
    updated = updated.filter(event => !removeEvents.includes(event));
  }

  return updated;
}

function parseHookUpdate(current: WebhookData, reqBody: Record<string, unknown>): WebhookData | JsonResponse {
  let next: WebhookData = { ...current, events: [...current.events] };

  if (reqBody.config !== undefined) {
    if (!isObject(reqBody.config)) {
      return jsonValidationError('Validation Failed: config must be an object.');
    }
    const config = reqBody.config;
    const contentTypeError = validateContentType(config.content_type);
    if (contentTypeError) { return contentTypeError; }
    const insecureSslError = validateInsecureSsl(config.insecure_ssl);
    if (insecureSslError) { return insecureSslError; }

    if (config.url !== undefined) {
      const url = normalizeWebhookUrl(config.url);
      if (typeof url !== 'string') { return url; }
      next = { ...next, url };
    }
    if (config.secret === undefined) {
      next = { ...next, secret: '' };
    } else {
      const secret = normalizeSecret(config.secret);
      if (typeof secret !== 'string') { return secret; }
      next = { ...next, secret };
    }
  }

  const events = applyEventPatch(next.events, reqBody);
  if (!Array.isArray(events)) { return events; }
  const active = normalizeActive(reqBody.active, next.active);
  if (typeof active !== 'boolean') { return active; }

  return { ...next, events, active };
}

function parseConfigUpdate(current: WebhookData, reqBody: Record<string, unknown>): WebhookData | JsonResponse {
  const contentTypeError = validateContentType(reqBody.content_type);
  if (contentTypeError) { return contentTypeError; }
  const insecureSslError = validateInsecureSsl(reqBody.insecure_ssl);
  if (insecureSslError) { return insecureSslError; }

  let next = { ...current, events: [...current.events] };
  if (reqBody.url !== undefined) {
    const url = normalizeWebhookUrl(reqBody.url);
    if (typeof url !== 'string') { return url; }
    next = { ...next, url };
  }
  if (reqBody.secret !== undefined) {
    const secret = normalizeSecret(reqBody.secret);
    if (typeof secret !== 'string') { return secret; }
    next = { ...next, secret };
  }
  return next;
}

function normalizeDeliveryMap(value: unknown): Record<string, WebhookDeliveryData> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const deliveries: Record<string, WebhookDeliveryData> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isObject(raw)) { continue; }

    const id = Number.isInteger(raw.id) ? raw.id as number : parseInt(key, 10);
    if (!Number.isInteger(id) || id < 1) { continue; }

    const guid = typeof raw.guid === 'string' && raw.guid ? raw.guid : `delivery-${id}`;
    const deliveredAt = typeof raw.deliveredAt === 'string' ? raw.deliveredAt : new Date(0).toISOString();
    const status = typeof raw.status === 'string' ? raw.status : 'OK';
    const event = typeof raw.event === 'string' && raw.event ? raw.event : 'ping';

    deliveries[String(id)] = {
      id,
      guid,
      deliveredAt,
      redelivery     : typeof raw.redelivery === 'boolean' ? raw.redelivery : false,
      duration       : typeof raw.duration === 'number' ? raw.duration : 0,
      status,
      statusCode     : typeof raw.statusCode === 'number' ? raw.statusCode : 200,
      event,
      action         : typeof raw.action === 'string' || raw.action === null ? raw.action : null,
      installationId : typeof raw.installationId === 'number' || raw.installationId === null ? raw.installationId : null,
      repositoryId   : typeof raw.repositoryId === 'number' || raw.repositoryId === null ? raw.repositoryId : null,
      throttledAt    : typeof raw.throttledAt === 'string' || raw.throttledAt === null ? raw.throttledAt : null,
      request        : isObject(raw.request) ? raw.request as WebhookDeliveryData['request'] : undefined,
      response       : isObject(raw.response) ? raw.response as WebhookDeliveryData['response'] : undefined,
    };
  }

  return Object.keys(deliveries).length > 0 ? deliveries : undefined;
}

function normalizeWebhookData(data: Record<string, unknown>): WebhookData {
  const deliveries = normalizeDeliveryMap(data.deliveries);
  return {
    url    : typeof data.url === 'string' ? data.url : '',
    secret : typeof data.secret === 'string' ? data.secret : '',
    events : Array.isArray(data.events) ? data.events.filter((event: unknown) => typeof event === 'string') : ['push'],
    active : typeof data.active === 'boolean' ? data.active : true,
    ...(deliveries ? { deliveries } : {}),
  };
}

function deliveryEntries(data: WebhookData): WebhookDeliveryData[] {
  return Object.values(data.deliveries ?? {})
    .filter((delivery): delivery is WebhookDeliveryData => Boolean(delivery) && Number.isInteger(delivery.id))
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt) || b.id - a.id);
}

function nextDeliveryId(data: WebhookData): number {
  return deliveryEntries(data).reduce((max, delivery) => Math.max(max, delivery.id), 0) + 1;
}

function webhookDeliveryKey(id: number): string {
  return String(id);
}

function withDelivery(data: WebhookData, delivery: WebhookDeliveryData): WebhookData {
  return {
    ...data,
    deliveries: {
      ...(data.deliveries ?? {}),
      [webhookDeliveryKey(delivery.id)]: delivery,
    },
  };
}

async function saveWebhookData(
  entry: WebhookEntry, data: WebhookData, failureMessage: string,
): Promise<JsonResponse | undefined> {
  const { status } = await entry.record.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`${failureMessage}: ${status.detail}`);
  }
  entry.data = data;
  return undefined;
}

function deliverySignature(algorithm: 'sha1' | 'sha256', secret: string, payload: unknown): string {
  return createHmac(algorithm, secret).update(JSON.stringify(payload)).digest('hex');
}

function deliveryRequestHeaders(
  entry: WebhookEntry, event: string, guid: string, targetId: number, targetType: 'organization' | 'repository',
  payload: unknown,
): Record<string, string> {
  const hookId = numericId(entry.record.id ?? '');
  return {
    'X-GitHub-Delivery'                      : guid,
    'X-Hub-Signature-256'                    : `sha256=${deliverySignature('sha256', entry.data.secret, payload)}`,
    Accept                                   : '*/*',
    'X-GitHub-Hook-ID'                       : String(hookId),
    'User-Agent'                             : 'GitHub-Hookshot/gitd',
    'X-GitHub-Event'                         : event,
    'X-GitHub-Hook-Installation-Target-ID'   : String(targetId),
    'X-GitHub-Hook-Installation-Target-Type' : targetType,
    'content-type'                           : 'application/json',
    'X-Hub-Signature'                        : `sha1=${deliverySignature('sha1', entry.data.secret, payload)}`,
  };
}

function createSyntheticDelivery(
  entry: WebhookEntry,
  options: {
    event : string;
    action? : string | null;
    payload : Record<string, unknown>;
    redelivery? : boolean;
    guid? : string;
    targetId : number;
    targetType : 'organization' | 'repository';
    repositoryId? : number | null;
  },
): WebhookDeliveryData {
  const id = nextDeliveryId(entry.data);
  const guid = options.guid ?? randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    guid,
    deliveredAt    : now,
    redelivery     : options.redelivery ?? false,
    duration       : 0,
    status         : 'OK',
    statusCode     : 200,
    event          : options.event,
    action         : options.action ?? null,
    installationId : null,
    repositoryId   : options.repositoryId ?? null,
    throttledAt    : null,
    request        : {
      headers : deliveryRequestHeaders(entry, options.event, guid, options.targetId, options.targetType, options.payload),
      payload : options.payload,
    },
    response: {
      headers : { 'Content-Type': 'application/json' },
      payload : 'ok',
    },
  };
}

function buildDeliverySummary(delivery: WebhookDeliveryData): Record<string, unknown> {
  return {
    id              : delivery.id,
    guid            : delivery.guid,
    delivered_at    : toISODate(delivery.deliveredAt),
    redelivery      : delivery.redelivery,
    duration        : delivery.duration,
    status          : delivery.status,
    status_code     : delivery.statusCode,
    event           : delivery.event,
    action          : delivery.action ?? null,
    installation_id : delivery.installationId ?? null,
    repository_id   : delivery.repositoryId ?? null,
    throttled_at    : delivery.throttledAt ? toISODate(delivery.throttledAt) : null,
  };
}

function buildDeliveryDetail(delivery: WebhookDeliveryData, hook: WebhookData): Record<string, unknown> {
  return {
    ...buildDeliverySummary(delivery),
    url      : hook.url,
    request  : delivery.request ?? { headers: {}, payload: {} },
    response : delivery.response ?? { headers: {}, payload: null },
  };
}

function filterDeliveries(data: WebhookData, url: URL): WebhookDeliveryData[] | JsonResponse {
  const status = url.searchParams.get('status');
  if (status && status !== 'success' && status !== 'failure') {
    return jsonValidationError('Validation Failed: status must be success or failure.');
  }

  const deliveries = deliveryEntries(data);
  if (!status) {
    return deliveries;
  }
  return deliveries.filter((delivery) => {
    const successful = delivery.statusCode >= 200 && delivery.statusCode <= 399;
    return status === 'success' ? successful : !successful;
  });
}

function deliveryPerPage(url: URL): number {
  const raw = parseInt(url.searchParams.get('per_page') ?? '30', 10);
  if (!Number.isInteger(raw) || raw < 1) { return 30; }
  return Math.min(raw, 100);
}

function deliveryListResponse(
  hook: WebhookData, url: URL, baseUrl: string, path: string,
): JsonResponse {
  const deliveries = filterDeliveries(hook, url);
  if ('status' in deliveries) { return deliveries; }

  const perPage = deliveryPerPage(url);
  const cursor = url.searchParams.get('cursor');
  const cursorId = cursor ? parseInt(cursor, 10) : NaN;
  const start = Number.isInteger(cursorId)
    ? Math.max(0, deliveries.findIndex(delivery => delivery.id === cursorId))
    : 0;
  const pageStart = start < 0 ? 0 : start;
  const paged = deliveries.slice(pageStart, pageStart + perPage);

  const extraHeaders: Record<string, string> = {};
  const next = deliveries[pageStart + perPage];
  if (next) {
    const params = new URLSearchParams();
    params.set('per_page', String(perPage));
    params.set('cursor', String(next.id));
    const status = url.searchParams.get('status');
    if (status) { params.set('status', status); }
    extraHeaders.Link = `<${baseUrl}${path}?${params.toString()}>; rel="next"`;
  }

  return jsonOk(paged.map(buildDeliverySummary), extraHeaders);
}

function findDelivery(data: WebhookData, deliveryId: string): WebhookDeliveryData | null {
  const id = parseInt(deliveryId, 10);
  if (!Number.isInteger(id)) { return null; }
  return data.deliveries?.[webhookDeliveryKey(id)] ?? null;
}

function repoWebhookPayload(
  ctx: AgentContext, repo: RepoInfo, targetDid: string, event: string, action: string | null,
): Record<string, unknown> {
  return {
    ...(action ? { action } : {}),
    zen        : 'Design for decentralization.',
    hook_id    : numericId(`${targetDid}/${repo.name}/${event}`),
    repository : {
      id             : numericId(repo.contextId || `${targetDid}/${repo.name}`),
      name           : repo.name,
      full_name      : `${targetDid}/${repo.name}`,
      default_branch : repo.defaultBranch,
      private        : repo.visibility !== 'public',
    },
    sender: {
      login : ctx.did,
      id    : numericId(ctx.did),
      type  : 'User',
    },
  };
}

function orgWebhookPayload(
  ctx: AgentContext, org: OrgEntry, event: string, action: string | null,
): Record<string, unknown> {
  return {
    ...(action ? { action } : {}),
    zen          : 'Design for decentralization.',
    hook_id      : numericId(`${org.routeLogin}/${event}`),
    organization : {
      id    : numericId(org.record.id ?? org.slug),
      login : org.routeLogin,
    },
    sender: {
      login : ctx.did,
      id    : numericId(ctx.did),
      type  : 'User',
    },
  };
}

async function listWebhookEntries(ctx: AgentContext, targetDid: string, repo: RepoInfo): Promise<WebhookEntry[]> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo/webhook' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const entries: WebhookEntry[] = [];
  for (const record of records) {
    const data = await record.data.json();
    entries.push({
      record,
      data: normalizeWebhookData(data),
    });
  }

  entries.sort((a, b) => a.record.dateCreated.localeCompare(b.record.dateCreated));
  return entries;
}

async function findWebhookEntry(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, hookId: string,
): Promise<WebhookEntry | null> {
  const requested = parseInt(hookId, 10);
  if (!Number.isInteger(requested)) { return null; }

  const entries = await listWebhookEntries(ctx, targetDid, repo);
  return entries.find(entry => numericId(entry.record.id ?? '') === requested) ?? null;
}

async function listOrgEntries(ctx: AgentContext): Promise<OrgEntry[]> {
  const { records } = await ctx.org.records.query('org' as any, {});

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
      data       : { name: data.name },
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

async function listOrgWebhookEntries(ctx: AgentContext, org: OrgEntry): Promise<WebhookEntry[]> {
  const { records } = await ctx.org.records.query('org/webhook' as any, {
    filter: { contextId: org.record.contextId },
  });

  const entries: WebhookEntry[] = [];
  for (const record of records) {
    const data = await record.data.json();
    entries.push({
      record,
      data: normalizeWebhookData(data),
    });
  }

  entries.sort((a, b) => a.record.dateCreated.localeCompare(b.record.dateCreated));
  return entries;
}

async function findOrgWebhookEntry(
  ctx: AgentContext, org: OrgEntry, hookId: string,
): Promise<WebhookEntry | null> {
  const requested = parseInt(hookId, 10);
  if (!Number.isInteger(requested)) { return null; }

  const entries = await listOrgWebhookEntries(ctx, org);
  return entries.find(entry => numericId(entry.record.id ?? '') === requested) ?? null;
}

function buildWebhookConfig(data: WebhookData, includeSecret: boolean): Record<string, unknown> {
  return {
    content_type : 'json',
    insecure_ssl : '0',
    ...(includeSecret ? { secret: data.secret ? '********' : '' } : {}),
    url          : data.url,
  };
}

function buildOrgWebhookResponse(
  entry: WebhookEntry, org: OrgEntry, baseUrl: string,
): Record<string, unknown> {
  const id = numericId(entry.record.id ?? '');
  const url = `${baseUrl}/orgs/${routeOrgPath(org)}/hooks/${id}`;
  const created = toISODate(entry.record.dateCreated);
  const updated = toISODate(entry.record.timestamp ?? entry.record.dateCreated);

  return {
    type           : 'Organization',
    id,
    name           : 'web',
    active         : entry.data.active,
    events         : entry.data.events,
    config         : buildWebhookConfig(entry.data, false),
    updated_at     : updated,
    created_at     : created,
    url,
    ping_url       : `${url}/pings`,
    deliveries_url : `${url}/deliveries`,
  };
}

function buildWebhookResponse(
  entry: WebhookEntry, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const id = numericId(entry.record.id ?? '');
  const url = `${baseUrl}/repos/${targetDid}/${repoName}/hooks/${id}`;
  const created = toISODate(entry.record.dateCreated);
  const updated = toISODate(entry.record.timestamp ?? entry.record.dateCreated);

  return {
    type           : 'Repository',
    id,
    name           : 'web',
    active         : entry.data.active,
    events         : entry.data.events,
    config         : buildWebhookConfig(entry.data, false),
    updated_at     : updated,
    created_at     : created,
    url,
    test_url       : `${url}/tests`,
    ping_url       : `${url}/pings`,
    deliveries_url : `${url}/deliveries`,
    last_response  : { code: null, status: 'unused', message: null },
  };
}

async function getRepoOr404(ctx: AgentContext, targetDid: string, repoName: string): Promise<RepoInfo | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }
  return repo;
}

async function getOrgOr404(ctx: AgentContext, routeOrg: string): Promise<OrgEntry | JsonResponse> {
  const org = await findOrg(ctx, routeOrg);
  if (!org) {
    return jsonNotFound(`Organization '${decodeRouteParam(routeOrg)}' not found.`);
  }
  return org;
}

// ---------------------------------------------------------------------------
// /orgs/:org/hooks
// ---------------------------------------------------------------------------

export async function handleListOrgWebhooks(
  ctx: AgentContext, routeOrg: string, url: URL,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const hooks = await listOrgWebhookEntries(ctx, org);
  const paged = paginate(hooks, pagination);

  const linkHeader = buildLinkHeader(
    baseUrl, `/orgs/${routeOrgPath(org)}/hooks`,
    pagination.page, pagination.perPage, hooks.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(paged.map(hook => buildOrgWebhookResponse(hook, org, baseUrl)), extraHeaders);
}

export async function handleCreateOrgWebhook(
  ctx: AgentContext, routeOrg: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const data = parseCreateWebhook(reqBody);
  if ('status' in data) { return data; }

  const { status, record } = await ctx.org.records.create('org/webhook' as any, {
    data,
    parentContextId: org.record.contextId ?? '',
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create organization webhook: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create organization webhook record'); }

  return jsonCreated(buildOrgWebhookResponse({ record, data }, org, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /orgs/:org/hooks/:hook_id
// ---------------------------------------------------------------------------

export async function handleGetOrgWebhook(
  ctx: AgentContext, routeOrg: string, hookId: string, url: URL,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  return jsonOk(buildOrgWebhookResponse(entry, org, buildApiUrl(url)));
}

export async function handleUpdateOrgWebhook(
  ctx: AgentContext, routeOrg: string, hookId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const data = parseHookUpdate(entry.data, reqBody);
  if ('status' in data) { return data; }

  const { status } = await entry.record.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update organization webhook: ${status.detail}`);
  }

  return jsonOk(buildOrgWebhookResponse({ record: entry.record, data }, org, buildApiUrl(url)));
}

export async function handleDeleteOrgWebhook(
  ctx: AgentContext, routeOrg: string, hookId: string,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete organization webhook: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /orgs/:org/hooks/:hook_id/config
// ---------------------------------------------------------------------------

export async function handleGetOrgWebhookConfig(
  ctx: AgentContext, routeOrg: string, hookId: string,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  return jsonOk(buildWebhookConfig(entry.data, true));
}

export async function handleUpdateOrgWebhookConfig(
  ctx: AgentContext, routeOrg: string, hookId: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const data = parseConfigUpdate(entry.data, reqBody);
  if ('status' in data) { return data; }

  const { status } = await entry.record.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update organization webhook configuration: ${status.detail}`);
  }

  return jsonOk(buildWebhookConfig(data, true));
}

// ---------------------------------------------------------------------------
// /orgs/:org/hooks/:hook_id/pings
// ---------------------------------------------------------------------------

export async function handlePingOrgWebhook(
  ctx: AgentContext, routeOrg: string, hookId: string,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const delivery = createSyntheticDelivery(entry, {
    event        : 'ping',
    action       : 'ping',
    payload      : orgWebhookPayload(ctx, org, 'ping', 'ping'),
    targetId     : numericId(org.record.id ?? org.slug),
    targetType   : 'organization',
    repositoryId : null,
  });
  const saveError = await saveWebhookData(
    entry,
    withDelivery(entry.data, delivery),
    'Failed to record organization webhook delivery',
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /orgs/:org/hooks/:hook_id/deliveries
// ---------------------------------------------------------------------------

export async function handleListOrgWebhookDeliveries(
  ctx: AgentContext, routeOrg: string, hookId: string, url: URL,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return deliveryListResponse(
    entry.data,
    url,
    baseUrl,
    `/orgs/${routeOrgPath(org)}/hooks/${numericId(entry.record.id ?? '')}/deliveries`,
  );
}

export async function handleGetOrgWebhookDelivery(
  ctx: AgentContext, routeOrg: string, hookId: string, deliveryId: string,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const delivery = findDelivery(entry.data, deliveryId);
  if (!delivery) {
    return jsonNotFound(`Webhook delivery '${deliveryId}' not found.`);
  }

  return jsonOk(buildDeliveryDetail(delivery, entry.data));
}

export async function handleRedeliverOrgWebhookDelivery(
  ctx: AgentContext, routeOrg: string, hookId: string, deliveryId: string,
): Promise<JsonResponse> {
  const org = await getOrgOr404(ctx, routeOrg);
  if ('status' in org) { return org; }

  const entry = await findOrgWebhookEntry(ctx, org, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const original = findDelivery(entry.data, deliveryId);
  if (!original) {
    return jsonNotFound(`Webhook delivery '${deliveryId}' not found.`);
  }

  const payload = isObject(original.request?.payload)
    ? original.request.payload as Record<string, unknown>
    : orgWebhookPayload(ctx, org, original.event, original.action ?? null);
  const delivery = createSyntheticDelivery(entry, {
    event        : original.event,
    action       : original.action ?? null,
    payload,
    redelivery   : true,
    guid         : original.guid,
    targetId     : numericId(org.record.id ?? org.slug),
    targetType   : 'organization',
    repositoryId : original.repositoryId ?? null,
  });
  const saveError = await saveWebhookData(
    entry,
    withDelivery(entry.data, delivery),
    'Failed to record organization webhook redelivery',
  );
  if (saveError) { return saveError; }

  return jsonAccepted({});
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/hooks
// ---------------------------------------------------------------------------

export async function handleListRepoWebhooks(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const hooks = await listWebhookEntries(ctx, targetDid, repo);
  const paged = paginate(hooks, pagination);

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repo.name}/hooks`,
    pagination.page, pagination.perPage, hooks.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(paged.map(hook => buildWebhookResponse(hook, targetDid, repo.name, baseUrl)), extraHeaders);
}

export async function handleCreateRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const data = parseCreateWebhook(reqBody);
  if ('status' in data) { return data; }

  const { status, record } = await ctx.repo.records.create('repo/webhook' as any, {
    data            : data,
    parentContextId : repo.contextId,
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create webhook: ${status.detail}`);
  }
  if (!record) { throw new Error('Failed to create webhook record'); }

  return jsonCreated(buildWebhookResponse({ record, data }, targetDid, repo.name, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/hooks/:hook_id
// ---------------------------------------------------------------------------

export async function handleGetRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  return jsonOk(buildWebhookResponse(entry, targetDid, repo.name, buildApiUrl(url)));
}

export async function handleUpdateRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const data = parseHookUpdate(entry.data, reqBody);
  if ('status' in data) { return data; }

  const { status } = await entry.record.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update webhook: ${status.detail}`);
  }

  return jsonOk(buildWebhookResponse({ record: entry.record, data }, targetDid, repo.name, buildApiUrl(url)));
}

export async function handleDeleteRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete webhook: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/hooks/:hook_id/config
// ---------------------------------------------------------------------------

export async function handleGetRepoWebhookConfig(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  return jsonOk(buildWebhookConfig(entry.data, true));
}

export async function handleUpdateRepoWebhookConfig(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const data = parseConfigUpdate(entry.data, reqBody);
  if ('status' in data) { return data; }

  const { status } = await entry.record.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update webhook configuration: ${status.detail}`);
  }

  return jsonOk(buildWebhookConfig(data, true));
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/hooks/:hook_id/pings and /tests
// ---------------------------------------------------------------------------

export async function handlePingRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const delivery = createSyntheticDelivery(entry, {
    event        : 'ping',
    action       : 'ping',
    payload      : repoWebhookPayload(ctx, repo, targetDid, 'ping', 'ping'),
    targetId     : numericId(repo.contextId || `${targetDid}/${repo.name}`),
    targetType   : 'repository',
    repositoryId : numericId(repo.contextId || `${targetDid}/${repo.name}`),
  });
  const saveError = await saveWebhookData(
    entry,
    withDelivery(entry.data, delivery),
    'Failed to record webhook delivery',
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

export async function handleTestRepoWebhook(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  if (!entry.data.events.includes('push')) {
    return jsonNoContent();
  }

  const delivery = createSyntheticDelivery(entry, {
    event        : 'push',
    action       : null,
    payload      : repoWebhookPayload(ctx, repo, targetDid, 'push', null),
    targetId     : numericId(repo.contextId || `${targetDid}/${repo.name}`),
    targetType   : 'repository',
    repositoryId : numericId(repo.contextId || `${targetDid}/${repo.name}`),
  });
  const saveError = await saveWebhookData(
    entry,
    withDelivery(entry.data, delivery),
    'Failed to record webhook test delivery',
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/hooks/:hook_id/deliveries
// ---------------------------------------------------------------------------

export async function handleListRepoWebhookDeliveries(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return deliveryListResponse(
    entry.data,
    url,
    baseUrl,
    `/repos/${targetDid}/${repo.name}/hooks/${numericId(entry.record.id ?? '')}/deliveries`,
  );
}

export async function handleGetRepoWebhookDelivery(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, deliveryId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const delivery = findDelivery(entry.data, deliveryId);
  if (!delivery) {
    return jsonNotFound(`Webhook delivery '${deliveryId}' not found.`);
  }

  return jsonOk(buildDeliveryDetail(delivery, entry.data));
}

export async function handleRedeliverRepoWebhookDelivery(
  ctx: AgentContext, targetDid: string, repoName: string, hookId: string, deliveryId: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const entry = await findWebhookEntry(ctx, targetDid, repo, hookId);
  if (!entry) {
    return jsonNotFound(`Webhook '${hookId}' not found.`);
  }

  const original = findDelivery(entry.data, deliveryId);
  if (!original) {
    return jsonNotFound(`Webhook delivery '${deliveryId}' not found.`);
  }

  const payload = isObject(original.request?.payload)
    ? original.request.payload as Record<string, unknown>
    : repoWebhookPayload(ctx, repo, targetDid, original.event, original.action ?? null);
  const repositoryId = numericId(repo.contextId || `${targetDid}/${repo.name}`);
  const delivery = createSyntheticDelivery(entry, {
    event      : original.event,
    action     : original.action ?? null,
    payload,
    redelivery : true,
    guid       : original.guid,
    targetId   : repositoryId,
    targetType : 'repository',
    repositoryId,
  });
  const saveError = await saveWebhookData(
    entry,
    withDelivery(entry.data, delivery),
    'Failed to record webhook redelivery',
  );
  if (saveError) { return saveError; }

  return jsonAccepted({});
}
