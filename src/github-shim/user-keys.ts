/**
 * GitHub API shim - user SSH key endpoints.
 *
 * Maps forge-social `sshKey` records to GitHub REST API v3 user key
 * responses. Authenticated key management writes to the local actor's DWN;
 * public key listing reads from the target user's DWN.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { SshKeyData, SshSigningKeyData } from '../social.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  buildLinkHeader,
  fromOpt,
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

type SshKeyEntry = {
  record : any;
  ownerDid : string;
  data : SshKeyData;
};

type SshSigningKeyEntry = {
  record : any;
  ownerDid : string;
  data : SshSigningKeyData;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sshKeyNumericId(entry: SshKeyEntry): number {
  return numericId(entry.record.contextId ?? entry.record.id);
}

function sshSigningKeyNumericId(entry: SshSigningKeyEntry): number {
  return numericId(entry.record.contextId ?? entry.record.id);
}

function normalizeSshKeyData(data: unknown, tags?: Record<string, unknown>): SshKeyData | null {
  if (!isObject(data)) { return null; }

  const key = typeof tags?.key === 'string' ? tags.key : data.key;
  if (typeof key !== 'string' || key.trim() === '') { return null; }

  return {
    key       : key.trim(),
    title     : typeof data.title === 'string' ? data.title : undefined,
    createdAt : typeof data.createdAt === 'string' ? data.createdAt : undefined,
    verified  : typeof data.verified === 'boolean' ? data.verified : undefined,
    readOnly  : typeof data.readOnly === 'boolean' ? data.readOnly : undefined,
  };
}

function normalizeSshSigningKeyData(data: unknown, tags?: Record<string, unknown>): SshSigningKeyData | null {
  if (!isObject(data)) { return null; }

  const key = typeof tags?.key === 'string' ? tags.key : data.key;
  if (typeof key !== 'string' || key.trim() === '') { return null; }

  return {
    key       : key.trim(),
    title     : typeof data.title === 'string' ? data.title : undefined,
    createdAt : typeof data.createdAt === 'string' ? data.createdAt : undefined,
  };
}

async function normalizeSshKeyEntry(record: any, fallbackOwnerDid: string): Promise<SshKeyEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeSshKeyData(await record.data.json(), tags);
  if (!data) { return null; }

  return {
    record,
    ownerDid: typeof record.author === 'string' ? record.author : fallbackOwnerDid,
    data,
  };
}

async function normalizeSshSigningKeyEntry(record: any, fallbackOwnerDid: string): Promise<SshSigningKeyEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeSshSigningKeyData(await record.data.json(), tags);
  if (!data) { return null; }

  return {
    record,
    ownerDid: typeof record.author === 'string' ? record.author : fallbackOwnerDid,
    data,
  };
}

async function listSshKeyEntries(ctx: AgentContext, userDid: string): Promise<SshKeyEntry[]> {
  const { records } = await ctx.social.records.query('sshKey' as any, {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: SshKeyEntry[] = [];
  for (const record of records) {
    const entry = await normalizeSshKeyEntry(record, userDid);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function listSshSigningKeyEntries(ctx: AgentContext, userDid: string): Promise<SshSigningKeyEntry[]> {
  const { records } = await ctx.social.records.query('sshSigningKey' as any, {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: SshSigningKeyEntry[] = [];
  for (const record of records) {
    const entry = await normalizeSshSigningKeyEntry(record, userDid);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function findSshKey(ctx: AgentContext, userDid: string, keyId: string): Promise<SshKeyEntry | null> {
  const id = Number.parseInt(keyId, 10);
  if (!Number.isInteger(id) || id <= 0) { return null; }

  const entries = await listSshKeyEntries(ctx, userDid);
  return entries.find(entry => sshKeyNumericId(entry) === id) ?? null;
}

async function findSshSigningKey(ctx: AgentContext, userDid: string, keyId: string): Promise<SshSigningKeyEntry | null> {
  const id = Number.parseInt(keyId, 10);
  if (!Number.isInteger(id) || id <= 0) { return null; }

  const entries = await listSshSigningKeyEntries(ctx, userDid);
  return entries.find(entry => sshSigningKeyNumericId(entry) === id) ?? null;
}

function defaultSshKeyTitle(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1].slice(0, 16)}`;
  }
  return parts[0] || 'SSH key';
}

function sshKeyCreatedAt(entry: SshKeyEntry): string {
  return toISODate(entry.data.createdAt ?? entry.record.dateCreated ?? entry.record.timestamp);
}

function sshSigningKeyCreatedAt(entry: SshSigningKeyEntry): string {
  return toISODate(entry.data.createdAt ?? entry.record.dateCreated ?? entry.record.timestamp);
}

function buildAuthenticatedSshKeyResponse(entry: SshKeyEntry, baseUrl: string): Record<string, unknown> {
  const id = sshKeyNumericId(entry);
  return {
    key        : entry.data.key,
    id,
    url        : `${baseUrl}/user/keys/${id}`,
    title      : entry.data.title ?? defaultSshKeyTitle(entry.data.key),
    created_at : sshKeyCreatedAt(entry),
    verified   : entry.data.verified === true,
    read_only  : entry.data.readOnly === true,
  };
}

function buildSshSigningKeyResponse(entry: SshSigningKeyEntry): Record<string, unknown> {
  return {
    id         : sshSigningKeyNumericId(entry),
    key        : entry.data.key,
    title      : entry.data.title ?? defaultSshKeyTitle(entry.data.key),
    created_at : sshSigningKeyCreatedAt(entry),
  };
}

function buildPublicSshKeyResponse(entry: SshKeyEntry): Record<string, unknown> {
  return {
    id  : sshKeyNumericId(entry),
    key : entry.data.key,
  };
}

function parseCreateSshSigningKeyInput(body: unknown): SshSigningKeyData | JsonResponse {
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const key = body.key;
  if (typeof key !== 'string' || key.trim() === '') {
    return jsonValidationError('Validation Failed: key is required.');
  }

  const title = body.title;
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    return jsonValidationError('Validation Failed: title must be a non-empty string.');
  }

  const trimmedKey = key.trim();
  return {
    key       : trimmedKey,
    title     : typeof title === 'string' ? title.trim() : defaultSshKeyTitle(trimmedKey),
    createdAt : new Date().toISOString(),
  };
}

function parseCreateSshKeyInput(body: unknown): SshKeyData | JsonResponse {
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const key = body.key;
  if (typeof key !== 'string' || key.trim() === '') {
    return jsonValidationError('Validation Failed: key is required.');
  }

  const title = body.title;
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    return jsonValidationError('Validation Failed: title must be a non-empty string.');
  }

  const trimmedKey = key.trim();
  return {
    key       : trimmedKey,
    title     : typeof title === 'string' ? title.trim() : defaultSshKeyTitle(trimmedKey),
    createdAt : new Date().toISOString(),
    verified  : false,
    readOnly  : false,
  };
}

async function hasDuplicateSshKey(ctx: AgentContext, key: string): Promise<boolean> {
  const entries = await listSshKeyEntries(ctx, ctx.did);
  return entries.some(entry => entry.data.key === key);
}

async function hasDuplicateSshSigningKey(ctx: AgentContext, key: string): Promise<boolean> {
  const entries = await listSshSigningKeyEntries(ctx, ctx.did);
  return entries.some(entry => entry.data.key === key);
}

function pagedSshKeys<T>(
  entries: T[], url: URL, path: string, mapper: (entry: T) => Record<string, unknown>,
): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, entries.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(mapper), extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/keys
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedSshKeys(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const entries = await listSshKeyEntries(ctx, ctx.did);
  return pagedSshKeys(entries, url, '/user/keys', entry => buildAuthenticatedSshKeyResponse(entry, baseUrl));
}

// ---------------------------------------------------------------------------
// POST /user/keys
// ---------------------------------------------------------------------------

export async function handleCreateAuthenticatedSshKey(
  ctx: AgentContext, body: unknown, url: URL,
): Promise<JsonResponse> {
  const parsed = parseCreateSshKeyInput(body);
  if ('status' in parsed) { return parsed; }

  if (await hasDuplicateSshKey(ctx, parsed.key)) {
    return jsonValidationError('Validation Failed: key already exists.');
  }

  const { record, status } = await ctx.social.records.create('sshKey' as any, {
    data : parsed,
    tags : { key: parsed.key },
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create SSH key: ${status.detail}`);
  }

  const entry = await normalizeSshKeyEntry(record, ctx.did);
  if (!entry) {
    return jsonValidationError('Failed to create SSH key.');
  }

  return jsonCreated(buildAuthenticatedSshKeyResponse(entry, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// GET /user/keys/:key_id
// ---------------------------------------------------------------------------

export async function handleGetAuthenticatedSshKey(
  ctx: AgentContext, keyId: string, url: URL,
): Promise<JsonResponse> {
  const entry = await findSshKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('Public key not found.'); }
  return jsonOk(buildAuthenticatedSshKeyResponse(entry, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// DELETE /user/keys/:key_id
// ---------------------------------------------------------------------------

export async function handleDeleteAuthenticatedSshKey(ctx: AgentContext, keyId: string): Promise<JsonResponse> {
  const entry = await findSshKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('Public key not found.'); }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete SSH key: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /users/:did/keys
// ---------------------------------------------------------------------------

export async function handleListUserSshKeys(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listSshKeyEntries(ctx, userDid);
  return pagedSshKeys(entries, url, `/users/${userDid}/keys`, buildPublicSshKeyResponse);
}

// ---------------------------------------------------------------------------
// GET /user/ssh_signing_keys
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedSshSigningKeys(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = await listSshSigningKeyEntries(ctx, ctx.did);
  return pagedSshKeys(entries, url, '/user/ssh_signing_keys', buildSshSigningKeyResponse);
}

// ---------------------------------------------------------------------------
// POST /user/ssh_signing_keys
// ---------------------------------------------------------------------------

export async function handleCreateAuthenticatedSshSigningKey(
  ctx: AgentContext, body: unknown,
): Promise<JsonResponse> {
  const parsed = parseCreateSshSigningKeyInput(body);
  if ('status' in parsed) { return parsed; }

  if (await hasDuplicateSshSigningKey(ctx, parsed.key)) {
    return jsonValidationError('Validation Failed: key already exists.');
  }

  const { record, status } = await ctx.social.records.create('sshSigningKey' as any, {
    data : parsed,
    tags : { key: parsed.key },
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create SSH signing key: ${status.detail}`);
  }

  const entry = await normalizeSshSigningKeyEntry(record, ctx.did);
  if (!entry) {
    return jsonValidationError('Failed to create SSH signing key.');
  }

  return jsonCreated(buildSshSigningKeyResponse(entry));
}

// ---------------------------------------------------------------------------
// GET /user/ssh_signing_keys/:ssh_signing_key_id
// ---------------------------------------------------------------------------

export async function handleGetAuthenticatedSshSigningKey(
  ctx: AgentContext, keyId: string,
): Promise<JsonResponse> {
  const entry = await findSshSigningKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('SSH signing key not found.'); }
  return jsonOk(buildSshSigningKeyResponse(entry));
}

// ---------------------------------------------------------------------------
// DELETE /user/ssh_signing_keys/:ssh_signing_key_id
// ---------------------------------------------------------------------------

export async function handleDeleteAuthenticatedSshSigningKey(ctx: AgentContext, keyId: string): Promise<JsonResponse> {
  const entry = await findSshSigningKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('SSH signing key not found.'); }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete SSH signing key: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /users/:did/ssh_signing_keys
// ---------------------------------------------------------------------------

export async function handleListUserSshSigningKeys(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listSshSigningKeyEntries(ctx, userDid);
  return pagedSshKeys(entries, url, `/users/${userDid}/ssh_signing_keys`, buildSshSigningKeyResponse);
}
