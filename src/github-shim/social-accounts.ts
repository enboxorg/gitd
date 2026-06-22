/**
 * GitHub API shim - authenticated user social account endpoints.
 *
 * Maps forge-social `socialAccount` records to GitHub REST API v3 social
 * account responses. The canonical social account URL is stored as a DWN tag
 * so add/delete operations can detect duplicates consistently.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { SocialAccountData } from '../social.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  buildLinkHeader,
  fromOpt,
  jsonCreated,
  jsonNoContent,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
} from './helpers.js';

type SocialAccountEntry = {
  record : any;
  data : SocialAccountData;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSocialUrl(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { return null; }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function providerFromUrl(accountUrl: string): string {
  const host = new URL(accountUrl).hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'x.com') { return 'x'; }
  if (host.endsWith('twitter.com')) { return 'twitter'; }
  if (host.endsWith('github.com')) { return 'github'; }
  if (host.endsWith('youtube.com') || host === 'youtu.be') { return 'youtube'; }
  if (host.endsWith('linkedin.com')) { return 'linkedin'; }
  if (host.endsWith('mastodon.social')) { return 'mastodon'; }
  return host.split('.')[0] || 'web';
}

function normalizeSocialAccountData(data: unknown, tags?: Record<string, unknown>): SocialAccountData | null {
  if (!isObject(data)) { return null; }

  const url = normalizeSocialUrl(typeof tags?.url === 'string' ? tags.url : data.url);
  if (!url) { return null; }

  const provider = typeof data.provider === 'string' && data.provider.trim() !== ''
    ? data.provider.trim().toLowerCase()
    : providerFromUrl(url);

  return {
    provider,
    url,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  };
}

async function normalizeSocialAccountEntry(record: any): Promise<SocialAccountEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeSocialAccountData(await record.data.json(), tags);
  if (!data) { return null; }
  return { record, data };
}

async function listSocialAccountEntries(ctx: AgentContext, userDid: string): Promise<SocialAccountEntry[]> {
  const { records } = await ctx.social.records.query('socialAccount' as any, {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: SocialAccountEntry[] = [];
  for (const record of records) {
    const entry = await normalizeSocialAccountEntry(record);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

function buildSocialAccountResponse(entry: SocialAccountEntry): Record<string, unknown> {
  return {
    provider : entry.data.provider,
    url      : entry.data.url,
  };
}

function parseAccountUrls(body: unknown): string[] | JsonResponse {
  if (!isObject(body) || !Array.isArray(body.account_urls)) {
    return jsonValidationError('Validation Failed: account_urls must be an array of full social account URLs.');
  }

  const accountUrls = body.account_urls.map(normalizeSocialUrl);
  if (accountUrls.length === 0 || accountUrls.some(accountUrl => !accountUrl)) {
    return jsonValidationError('Validation Failed: account_urls must contain at least one valid HTTP or HTTPS URL.');
  }

  const uniqueAccountUrls = [...new Set(accountUrls as string[])];
  if (uniqueAccountUrls.length !== accountUrls.length) {
    return jsonValidationError('Validation Failed: duplicate social account URLs are not allowed.');
  }
  return uniqueAccountUrls;
}

function pagedSocialAccounts(entries: SocialAccountEntry[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, entries.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildSocialAccountResponse), extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/social_accounts
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedSocialAccounts(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = await listSocialAccountEntries(ctx, ctx.did);
  return pagedSocialAccounts(entries, url, '/user/social_accounts');
}

// ---------------------------------------------------------------------------
// POST /user/social_accounts
// ---------------------------------------------------------------------------

export async function handleAddAuthenticatedSocialAccounts(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  const parsed = parseAccountUrls(body);
  if (!Array.isArray(parsed)) { return parsed; }

  const existing = await listSocialAccountEntries(ctx, ctx.did);
  const existingUrls = new Set(existing.map(entry => entry.data.url));
  if (parsed.some(accountUrl => existingUrls.has(accountUrl))) {
    return jsonValidationError('Validation Failed: social account URL already exists.');
  }

  const created: SocialAccountEntry[] = [];
  for (const accountUrl of parsed) {
    const data: SocialAccountData = {
      provider  : providerFromUrl(accountUrl),
      url       : accountUrl,
      createdAt : new Date().toISOString(),
    };
    const { record, status } = await ctx.social.records.create('socialAccount' as any, {
      data,
      tags: { url: accountUrl },
    } as any);
    if (status.code >= 300 || !record) {
      return jsonValidationError(`Failed to add social account URL: ${status.detail}`);
    }

    const entry = await normalizeSocialAccountEntry(record);
    if (entry) { created.push(entry); }
  }

  return jsonCreated(created.map(buildSocialAccountResponse));
}

// ---------------------------------------------------------------------------
// DELETE /user/social_accounts
// ---------------------------------------------------------------------------

export async function handleDeleteAuthenticatedSocialAccounts(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  const parsed = parseAccountUrls(body);
  if (!Array.isArray(parsed)) { return parsed; }

  const entries = await listSocialAccountEntries(ctx, ctx.did);
  const entriesByUrl = new Map(entries.map(entry => [entry.data.url, entry]));
  for (const accountUrl of parsed) {
    const entry = entriesByUrl.get(accountUrl);
    if (!entry) {
      return jsonValidationError(`Validation Failed: social account URL '${accountUrl}' is not associated with this account.`);
    }
  }

  for (const accountUrl of parsed) {
    const entry = entriesByUrl.get(accountUrl);
    if (!entry) { continue; }
    const { status } = await entry.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete social account URL: ${status.detail}`);
    }
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /users/:did/social_accounts
// ---------------------------------------------------------------------------

export async function handleListUserSocialAccounts(ctx: AgentContext, userDid: string, url: URL): Promise<JsonResponse> {
  const entries = await listSocialAccountEntries(ctx, userDid);
  return pagedSocialAccounts(entries, url, `/users/${userDid}/social_accounts`);
}
