/**
 * GitHub API shim - user GPG key endpoints.
 *
 * Maps forge-social `gpgKey` records to GitHub REST API v3 GPG key
 * responses. GitHub parses armored keys into cryptographic key material;
 * this shim preserves the uploaded armored key and exposes deterministic
 * compatibility metadata.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { GpgKeyData, GpgKeyEmailData, GpgSubkeyData } from '../social.js';

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

type GpgKeyEntry = {
  record : any;
  data : GpgKeyData;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gpgKeyNumericId(entry: GpgKeyEntry): number {
  return numericId(entry.record.contextId ?? entry.record.id);
}

function gpgKeyIdFromMaterial(material: string): string {
  return createHash('sha256').update(material).digest('hex').slice(0, 16).toUpperCase();
}

function normalizeEmails(value: unknown): GpgKeyEmailData[] {
  if (!Array.isArray(value)) { return []; }

  const emails: GpgKeyEmailData[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.email !== 'string' || item.email.trim() === '') { continue; }
    emails.push({
      email    : item.email.trim(),
      verified : item.verified === true,
    });
  }
  return emails;
}

function extractEmailsFromArmoredKey(armoredPublicKey: string): GpgKeyEmailData[] {
  const matches = armoredPublicKey.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(matches.map(email => email.toLowerCase()))].map(email => ({ email, verified: false }));
}

function normalizeSubkeys(value: unknown): GpgSubkeyData[] {
  if (!Array.isArray(value)) { return []; }

  const subkeys: GpgSubkeyData[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.publicKey !== 'string' || item.publicKey.trim() === '') { continue; }
    subkeys.push({
      publicKey         : item.publicKey.trim(),
      id                : typeof item.id === 'number' ? item.id : undefined,
      primaryKeyId      : typeof item.primaryKeyId === 'number' ? item.primaryKeyId : undefined,
      keyId             : typeof item.keyId === 'string' && item.keyId.trim() !== '' ? item.keyId.trim() : undefined,
      emails            : normalizeEmails(item.emails),
      canSign           : typeof item.canSign === 'boolean' ? item.canSign : undefined,
      canEncryptComms   : typeof item.canEncryptComms === 'boolean' ? item.canEncryptComms : undefined,
      canEncryptStorage : typeof item.canEncryptStorage === 'boolean' ? item.canEncryptStorage : undefined,
      canCertify        : typeof item.canCertify === 'boolean' ? item.canCertify : undefined,
      createdAt         : typeof item.createdAt === 'string' ? item.createdAt : undefined,
      expiresAt         : typeof item.expiresAt === 'string' || item.expiresAt === null ? item.expiresAt : undefined,
      revoked           : typeof item.revoked === 'boolean' ? item.revoked : undefined,
    });
  }
  return subkeys;
}

function normalizeGpgKeyData(data: unknown, tags?: Record<string, unknown>): GpgKeyData | null {
  if (!isObject(data)) { return null; }

  const armoredPublicKey = data.armoredPublicKey ?? data.armored_public_key;
  if (typeof armoredPublicKey !== 'string' || armoredPublicKey.trim() === '') { return null; }

  const trimmedKey = armoredPublicKey.trim();
  const keyId = typeof tags?.keyId === 'string' ? tags.keyId : data.keyId;
  const emails = normalizeEmails(data.emails);
  return {
    armoredPublicKey  : trimmedKey,
    name              : typeof data.name === 'string' ? data.name : undefined,
    publicKey         : typeof data.publicKey === 'string' ? data.publicKey : undefined,
    keyId             : typeof keyId === 'string' && keyId.trim() !== '' ? keyId.trim() : gpgKeyIdFromMaterial(trimmedKey),
    emails            : emails.length > 0 ? emails : extractEmailsFromArmoredKey(trimmedKey),
    subkeys           : normalizeSubkeys(data.subkeys),
    canSign           : typeof data.canSign === 'boolean' ? data.canSign : undefined,
    canEncryptComms   : typeof data.canEncryptComms === 'boolean' ? data.canEncryptComms : undefined,
    canEncryptStorage : typeof data.canEncryptStorage === 'boolean' ? data.canEncryptStorage : undefined,
    canCertify        : typeof data.canCertify === 'boolean' ? data.canCertify : undefined,
    createdAt         : typeof data.createdAt === 'string' ? data.createdAt : undefined,
    expiresAt         : typeof data.expiresAt === 'string' || data.expiresAt === null ? data.expiresAt : undefined,
    revoked           : typeof data.revoked === 'boolean' ? data.revoked : undefined,
  };
}

async function normalizeGpgKeyEntry(record: any): Promise<GpgKeyEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeGpgKeyData(await record.data.json(), tags);
  if (!data) { return null; }
  return { record, data };
}

async function listGpgKeyEntries(ctx: AgentContext, userDid: string): Promise<GpgKeyEntry[]> {
  const { records } = await ctx.social.records.query('gpgKey' as any, {
    from     : fromOpt(ctx, userDid),
    dateSort : DateSort.CreatedAscending,
  } as any);

  const entries: GpgKeyEntry[] = [];
  for (const record of records) {
    const entry = await normalizeGpgKeyEntry(record);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function findGpgKey(ctx: AgentContext, userDid: string, keyId: string): Promise<GpgKeyEntry | null> {
  const id = Number.parseInt(keyId, 10);
  if (!Number.isInteger(id) || id <= 0) { return null; }

  const entries = await listGpgKeyEntries(ctx, userDid);
  return entries.find(entry => gpgKeyNumericId(entry) === id) ?? null;
}

function defaultGpgKeyName(data: GpgKeyData): string {
  return data.emails?.[0]?.email ? `${data.emails[0].email} GPG key` : `GPG key ${data.keyId ?? gpgKeyIdFromMaterial(data.armoredPublicKey)}`;
}

function gpgCreatedAt(entry: GpgKeyEntry): string {
  return toISODate(entry.data.createdAt ?? entry.record.dateCreated ?? entry.record.timestamp);
}

function nullableISODate(date: string | null | undefined): string | null {
  return date ? toISODate(date) : null;
}

function buildGpgSubkeyResponse(subkey: GpgSubkeyData, entry: GpgKeyEntry, index: number): Record<string, unknown> {
  const primaryKeyId = gpgKeyNumericId(entry);
  return {
    id                  : subkey.id ?? numericId(`${entry.record.id}:subkey:${index}`),
    primary_key_id      : subkey.primaryKeyId ?? primaryKeyId,
    key_id              : subkey.keyId ?? gpgKeyIdFromMaterial(subkey.publicKey),
    public_key          : subkey.publicKey,
    emails              : subkey.emails ?? [],
    can_sign            : subkey.canSign === true,
    can_encrypt_comms   : subkey.canEncryptComms === true,
    can_encrypt_storage : subkey.canEncryptStorage === true,
    can_certify         : subkey.canCertify === true,
    created_at          : toISODate(subkey.createdAt ?? entry.data.createdAt ?? entry.record.dateCreated ?? entry.record.timestamp),
    expires_at          : nullableISODate(subkey.expiresAt),
    revoked             : subkey.revoked === true,
  };
}

function buildGpgKeyResponse(entry: GpgKeyEntry): Record<string, unknown> {
  const id = gpgKeyNumericId(entry);
  const keyId = entry.data.keyId ?? gpgKeyIdFromMaterial(entry.data.armoredPublicKey);
  return {
    id,
    name                : entry.data.name ?? defaultGpgKeyName(entry.data),
    primary_key_id      : id,
    key_id              : keyId,
    public_key          : entry.data.publicKey ?? entry.data.armoredPublicKey,
    emails              : entry.data.emails ?? [],
    subkeys             : (entry.data.subkeys ?? []).map((subkey, index) => buildGpgSubkeyResponse(subkey, entry, index)),
    can_sign            : entry.data.canSign !== false,
    can_encrypt_comms   : entry.data.canEncryptComms === true,
    can_encrypt_storage : entry.data.canEncryptStorage === true,
    can_certify         : entry.data.canCertify !== false,
    created_at          : gpgCreatedAt(entry),
    expires_at          : nullableISODate(entry.data.expiresAt),
    revoked             : entry.data.revoked === true,
    raw_key             : entry.data.armoredPublicKey,
  };
}

function parseCreateGpgKeyInput(body: unknown): GpgKeyData | JsonResponse {
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const armoredPublicKey = body.armored_public_key;
  if (typeof armoredPublicKey !== 'string' || armoredPublicKey.trim() === '') {
    return jsonValidationError('Validation Failed: armored_public_key is required.');
  }

  const trimmedKey = armoredPublicKey.trim();
  if (!trimmedKey.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    return jsonValidationError('Validation Failed: armored_public_key must be an ASCII-armored GPG public key.');
  }

  const name = body.name;
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    return jsonValidationError('Validation Failed: name must be a non-empty string.');
  }

  return {
    armoredPublicKey  : trimmedKey,
    name              : typeof name === 'string' ? name.trim() : undefined,
    publicKey         : trimmedKey,
    keyId             : gpgKeyIdFromMaterial(trimmedKey),
    emails            : extractEmailsFromArmoredKey(trimmedKey),
    subkeys           : [],
    canSign           : true,
    canEncryptComms   : false,
    canEncryptStorage : false,
    canCertify        : true,
    createdAt         : new Date().toISOString(),
    expiresAt         : null,
    revoked           : false,
  };
}

async function hasDuplicateGpgKey(ctx: AgentContext, keyId: string, armoredPublicKey: string): Promise<boolean> {
  const entries = await listGpgKeyEntries(ctx, ctx.did);
  return entries.some(entry => entry.data.keyId === keyId || entry.data.armoredPublicKey === armoredPublicKey);
}

function pagedGpgKeys(entries: GpgKeyEntry[], url: URL, path: string): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, entries.length);
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(buildGpgKeyResponse), extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /user/gpg_keys
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedGpgKeys(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = await listGpgKeyEntries(ctx, ctx.did);
  return pagedGpgKeys(entries, url, '/user/gpg_keys');
}

// ---------------------------------------------------------------------------
// POST /user/gpg_keys
// ---------------------------------------------------------------------------

export async function handleCreateAuthenticatedGpgKey(ctx: AgentContext, body: unknown): Promise<JsonResponse> {
  const parsed = parseCreateGpgKeyInput(body);
  if ('status' in parsed) { return parsed; }

  const keyId = parsed.keyId ?? gpgKeyIdFromMaterial(parsed.armoredPublicKey);
  if (await hasDuplicateGpgKey(ctx, keyId, parsed.armoredPublicKey)) {
    return jsonValidationError('Validation Failed: key already exists.');
  }

  const { record, status } = await ctx.social.records.create('gpgKey' as any, {
    data : parsed,
    tags : { keyId },
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create GPG key: ${status.detail}`);
  }

  const entry = await normalizeGpgKeyEntry(record);
  if (!entry) {
    return jsonValidationError('Failed to create GPG key.');
  }

  return jsonCreated(buildGpgKeyResponse(entry));
}

// ---------------------------------------------------------------------------
// GET /user/gpg_keys/:gpg_key_id
// ---------------------------------------------------------------------------

export async function handleGetAuthenticatedGpgKey(ctx: AgentContext, keyId: string): Promise<JsonResponse> {
  const entry = await findGpgKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('GPG key not found.'); }
  return jsonOk(buildGpgKeyResponse(entry));
}

// ---------------------------------------------------------------------------
// DELETE /user/gpg_keys/:gpg_key_id
// ---------------------------------------------------------------------------

export async function handleDeleteAuthenticatedGpgKey(ctx: AgentContext, keyId: string): Promise<JsonResponse> {
  const entry = await findGpgKey(ctx, ctx.did, keyId);
  if (!entry) { return jsonNotFound('GPG key not found.'); }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete GPG key: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /users/:did/gpg_keys
// ---------------------------------------------------------------------------

export async function handleListUserGpgKeys(
  ctx: AgentContext, userDid: string, url: URL,
): Promise<JsonResponse> {
  const entries = await listGpgKeyEntries(ctx, userDid);
  return pagedGpgKeys(entries, url, `/users/${userDid}/gpg_keys`);
}
