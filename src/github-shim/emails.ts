/**
 * GitHub API shim - authenticated user email endpoints.
 *
 * Maps forge-social `email` records to GitHub REST API v3 email responses.
 * Email records are account-owned metadata used by GitHub-compatible clients
 * to discover commit identity and public profile email visibility.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { EmailData } from '../social.js';
import type { JsonResponse } from './helpers.js';

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

type EmailEntry = {
  record : any;
  data : EmailData;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { return null; }
  return email;
}

function normalizeVisibility(value: unknown): 'public' | 'private' | null | undefined {
  if (value === 'public' || value === 'private' || value === null) { return value; }
  return undefined;
}

function normalizeEmailData(data: unknown, tags?: Record<string, unknown>): EmailData | null {
  if (!isObject(data)) { return null; }

  const email = normalizeEmailAddress(typeof tags?.email === 'string' ? tags.email : data.email);
  if (!email) { return null; }

  return {
    email,
    primary    : data.primary === true,
    verified   : data.verified === true,
    visibility : normalizeVisibility(data.visibility) ?? (data.primary === true ? 'private' : null),
    createdAt  : typeof data.createdAt === 'string' ? data.createdAt : undefined,
  };
}

async function normalizeEmailEntry(record: any): Promise<EmailEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeEmailData(await record.data.json(), tags);
  if (!data) { return null; }
  return { record, data };
}

async function listEmailEntries(ctx: AgentContext, userDid: string): Promise<EmailEntry[]> {
  const { records } = await ctx.social.records.query('email' as any, {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: EmailEntry[] = [];
  for (const record of records) {
    const entry = await normalizeEmailEntry(record);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

function buildEmailResponse(entry: EmailEntry): Record<string, unknown> {
  return {
    email      : entry.data.email,
    verified   : entry.data.verified === true,
    primary    : entry.data.primary === true,
    visibility : entry.data.visibility ?? null,
  };
}

function parseEmailList(body: unknown): string[] | JsonResponse {
  const value = isObject(body) && 'emails' in body ? body.emails : body;
  const rawEmails = Array.isArray(value) ? value : [value];
  const emails = rawEmails.map(normalizeEmailAddress);
  if (emails.length === 0 || emails.some(email => !email)) {
    return jsonValidationError('Validation Failed: emails must contain at least one valid email address.');
  }

  const uniqueEmails = [...new Set(emails as string[])];
  if (uniqueEmails.length !== emails.length) {
    return jsonValidationError('Validation Failed: duplicate email addresses are not allowed.');
  }
  return uniqueEmails;
}

function pagedEmails(entries: EmailEntry[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, entries.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildEmailResponse), extraHeaders);
}

async function updatePrimaryVisibility(entries: EmailEntry[], visibility: 'public' | 'private'): Promise<JsonResponse | null> {
  const primaryEntries = entries.filter(entry => entry.data.primary === true);
  if (primaryEntries.length === 0) {
    return jsonValidationError('Validation Failed: no primary email exists.');
  }

  for (const entry of primaryEntries) {
    const nextData = { ...entry.data, visibility };
    const { status } = await entry.record.update({ data: nextData, tags: { email: entry.data.email } } as any);
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update email visibility: ${status.detail}`);
    }
    entry.data = nextData;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /user/emails
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedEmails(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = await listEmailEntries(ctx, ctx.did);
  return pagedEmails(entries, url, '/user/emails');
}

// ---------------------------------------------------------------------------
// POST /user/emails
// ---------------------------------------------------------------------------

export async function handleAddAuthenticatedEmails(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  const parsed = parseEmailList(body);
  if (!Array.isArray(parsed)) { return parsed; }

  const existing = await listEmailEntries(ctx, ctx.did);
  const existingEmails = new Set(existing.map(entry => entry.data.email));
  if (parsed.some(email => existingEmails.has(email))) {
    return jsonValidationError('Validation Failed: email already exists.');
  }

  const hasPrimary = existing.some(entry => entry.data.primary === true);
  const created: EmailEntry[] = [];
  for (const [index, email] of parsed.entries()) {
    const primary = !hasPrimary && index === 0;
    const data: EmailData = {
      email,
      primary,
      verified   : false,
      visibility : primary ? 'private' : null,
      createdAt  : new Date().toISOString(),
    };
    const { record, status } = await ctx.social.records.create('email' as any, {
      data,
      tags: { email },
    } as any);
    if (status.code >= 300 || !record) {
      return jsonValidationError(`Failed to add email address: ${status.detail}`);
    }

    const entry = await normalizeEmailEntry(record);
    if (entry) { created.push(entry); }
  }

  return jsonCreated(created.map(buildEmailResponse));
}

// ---------------------------------------------------------------------------
// DELETE /user/emails
// ---------------------------------------------------------------------------

export async function handleDeleteAuthenticatedEmails(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  const parsed = parseEmailList(body);
  if (!Array.isArray(parsed)) { return parsed; }

  const entries = await listEmailEntries(ctx, ctx.did);
  const entriesByEmail = new Map(entries.map(entry => [entry.data.email, entry]));
  for (const email of parsed) {
    const entry = entriesByEmail.get(email);
    if (!entry) {
      return jsonValidationError(`Validation Failed: email '${email}' is not associated with this account.`);
    }
  }

  for (const email of parsed) {
    const entry = entriesByEmail.get(email);
    if (!entry) { continue; }
    const { status } = await entry.record.delete();
    if (status.code >= 300) {
      return jsonValidationError(`Failed to delete email address: ${status.detail}`);
    }
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// PATCH /user/email/visibility
// ---------------------------------------------------------------------------

export async function handleSetPrimaryEmailVisibility(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  if (!isObject(body) || (body.visibility !== 'public' && body.visibility !== 'private')) {
    return jsonValidationError('Validation Failed: visibility must be public or private.');
  }

  const entries = await listEmailEntries(ctx, ctx.did);
  const error = await updatePrimaryVisibility(entries, body.visibility);
  if (error) { return error; }

  return jsonOk(entries.map(buildEmailResponse));
}

// ---------------------------------------------------------------------------
// GET /user/public_emails
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedPublicEmails(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = await listEmailEntries(ctx, ctx.did);
  return pagedEmails(entries.filter(entry => entry.data.visibility === 'public'), url, '/user/public_emails');
}
