/**
 * GitHub API shim — Gist endpoints.
 *
 * Stores GitHub-compatible gists as forge-social `gist` records owned by a DID.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { GistCommentData, GistData, GistFileData, GistStarData } from '../social.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { collectVisibleUserDids } from './users.js';
import {
  binaryOk,
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
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

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

type GistEntry = {
  record : any;
  ownerDid : string;
  data : GistData;
};

type GistCommentEntry = {
  record : any;
  ownerDid : string;
  data : GistCommentData;
};

type GistStarEntry = {
  record : any;
  data : GistStarData;
};

type ParsedGistFileChange = {
  filename? : string;
  content? : string;
};

const TEXT_ENCODER = new TextEncoder();

const FILE_TYPES: Record<string, { type: string; language: string | null }> = {
  '.css'  : { type: 'text/css', language: 'CSS' },
  '.html' : { type: 'text/html', language: 'HTML' },
  '.js'   : { type: 'application/javascript', language: 'JavaScript' },
  '.json' : { type: 'application/json', language: 'JSON' },
  '.md'   : { type: 'text/markdown', language: 'Markdown' },
  '.py'   : { type: 'text/x-python', language: 'Python' },
  '.rb'   : { type: 'application/x-ruby', language: 'Ruby' },
  '.rs'   : { type: 'text/rust', language: 'Rust' },
  '.ts'   : { type: 'application/typescript', language: 'TypeScript' },
  '.txt'  : { type: 'text/plain', language: null },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonResponse(value: unknown): value is JsonResponse {
  return isObject(value) && typeof value.status === 'number' && isObject(value.headers);
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function inferFileType(filename: string): { type: string; language: string | null } {
  return FILE_TYPES[fileExtension(filename)] ?? { type: 'text/plain', language: null };
}

function rawFileContentType(file: GistFileData): string {
  const inferred = inferFileType(file.filename);
  const type = file.type ?? inferred.type;
  const utf8Type = type.startsWith('text/')
    || type === 'application/javascript'
    || type === 'application/json'
    || type === 'application/typescript'
    || type === 'application/x-ruby';
  return utf8Type
    ? `${type}; charset=utf-8`
    : type;
}

function normalizeFilename(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const filename = value.trim();
  if (!filename || filename.includes('\0') || filename.startsWith('/')) { return null; }
  return filename;
}

function normalizePublicFlag(value: unknown): boolean {
  if (value === true || value === 'true') { return true; }
  if (value === false || value === 'false') { return false; }
  return false;
}

function normalizeStoredFile(key: string, value: unknown): GistFileData | null {
  if (!isObject(value)) { return null; }

  const filename = normalizeFilename(value.filename) ?? normalizeFilename(key);
  if (!filename || typeof value.content !== 'string') { return null; }
  const inferred = inferFileType(filename);
  return {
    filename,
    content  : value.content,
    type     : typeof value.type === 'string' ? value.type : inferred.type,
    language : typeof value.language === 'string' || value.language === null ? value.language : inferred.language,
  };
}

function normalizeGistData(data: unknown, tags?: Record<string, unknown>): GistData | null {
  if (!isObject(data) || !isObject(data.files)) { return null; }

  const files: Record<string, GistFileData> = {};
  for (const [key, value] of Object.entries(data.files)) {
    const file = normalizeStoredFile(key, value);
    if (file) { files[file.filename] = file; }
  }
  if (Object.keys(files).length === 0) { return null; }

  const forkOfOwnerDid = typeof tags?.forkOfOwnerDid === 'string'
    ? tags.forkOfOwnerDid
    : typeof data.forkOfOwnerDid === 'string' ? data.forkOfOwnerDid : undefined;
  const forkOfGistId = typeof tags?.forkOfGistId === 'string'
    ? tags.forkOfGistId
    : typeof data.forkOfGistId === 'string' ? data.forkOfGistId : undefined;

  return {
    description : typeof data.description === 'string' ? data.description : '',
    public      : tags?.visibility === 'public' || data.public === true,
    files,
    forkOfOwnerDid,
    forkOfGistId,
    forkedAt    : typeof data.forkedAt === 'string' ? data.forkedAt : undefined,
    createdAt   : typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedAt   : typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}

async function normalizeGistEntry(record: any, ownerDid: string): Promise<GistEntry | null> {
  const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = normalizeGistData(await record.data.json(), tags);
  if (!data) { return null; }
  return { record, ownerDid, data };
}

async function listGistEntries(ctx: AgentContext, ownerDid: string, includeSecret: boolean): Promise<GistEntry[]> {
  let records: any[];
  try {
    const result = await ctx.social.records.query('gist' as any, {
      from     : fromOpt(ctx, ownerDid),
      dateSort : DateSort.CreatedDescending,
    } as any);
    records = result.records;
  } catch {
    return [];
  }

  const entries: GistEntry[] = [];
  for (const record of records) {
    const entry = await normalizeGistEntry(record, ownerDid);
    if (entry && (includeSecret || entry.data.public !== false)) {
      entries.push(entry);
    }
  }
  return entries.sort((left, right) => gistUpdatedMs(right) - gistUpdatedMs(left));
}

async function listVisiblePublicGists(ctx: AgentContext): Promise<GistEntry[]> {
  const dids = await collectVisibleUserDids(ctx);
  const entries: GistEntry[] = [];
  for (const did of dids) {
    entries.push(...await listGistEntries(ctx, did, false));
  }
  return entries.sort((left, right) => gistUpdatedMs(right) - gistUpdatedMs(left));
}

async function findGistById(ctx: AgentContext, gistId: string, localOnly = false): Promise<GistEntry | null> {
  const dids = localOnly ? [ctx.did] : await collectVisibleUserDids(ctx);
  for (const did of dids) {
    const entry = (await listGistEntries(ctx, did, true)).find(gist => gist.record.id === gistId);
    if (entry) { return entry; }
  }
  return null;
}

async function listGistForkEntries(ctx: AgentContext, source: GistEntry): Promise<GistEntry[]> {
  const dids = await collectVisibleUserDids(ctx);
  const entries: GistEntry[] = [];
  for (const did of dids) {
    const forks = (await listGistEntries(ctx, did, true)).filter(gist =>
      gist.data.forkOfGistId === source.record.id && gist.data.forkOfOwnerDid === source.ownerDid);
    entries.push(...forks);
  }
  return entries.sort((left, right) => gistCreatedMs(left) - gistCreatedMs(right));
}

async function findLocalGistFork(ctx: AgentContext, source: GistEntry): Promise<GistEntry | null> {
  return (await listGistEntries(ctx, ctx.did, true)).find(gist =>
    gist.data.forkOfGistId === source.record.id && gist.data.forkOfOwnerDid === source.ownerDid) ?? null;
}

function gistCreatedAt(entry: GistEntry): string {
  return toISODate(entry.data.createdAt ?? entry.record.dateCreated);
}

function gistCreatedMs(entry: GistEntry): number {
  return Date.parse(gistCreatedAt(entry)) || 0;
}

function gistUpdatedAt(entry: GistEntry): string {
  return toISODate(entry.data.updatedAt ?? entry.record.timestamp ?? entry.data.createdAt ?? entry.record.dateCreated);
}

function gistUpdatedMs(entry: GistEntry): number {
  return Date.parse(gistUpdatedAt(entry)) || 0;
}

function applySinceFilter(entries: GistEntry[], url: URL): GistEntry[] {
  const since = Date.parse(url.searchParams.get('since') ?? '');
  if (!Number.isFinite(since)) { return entries; }
  return entries.filter(entry => gistUpdatedMs(entry) > since);
}

function buildGistOwner(did: string, baseUrl: string): Record<string, unknown> {
  return {
    ...buildOwner(did, baseUrl),
    node_id             : did,
    gravatar_id         : '',
    followers_url       : `${baseUrl}/users/${did}/followers`,
    following_url       : `${baseUrl}/users/${did}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${did}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${did}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${did}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${did}/orgs`,
    repos_url           : `${baseUrl}/users/${did}/repos`,
    events_url          : `${baseUrl}/users/${did}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${did}/received_events`,
    site_admin          : false,
  };
}

function buildGistFileResponse(
  entry: GistEntry, file: GistFileData, baseUrl: string, includeContent: boolean,
): Record<string, unknown> {
  const inferred = inferFileType(file.filename);
  const response: Record<string, unknown> = {
    filename : file.filename,
    type     : file.type ?? inferred.type,
    language : file.language ?? inferred.language,
    raw_url  : `${baseUrl}/gists/${entry.record.id}/raw/${encodeURIComponent(file.filename)}`,
    size     : TEXT_ENCODER.encode(file.content).byteLength,
  };
  if (includeContent) {
    response.truncated = false;
    response.content = file.content;
    response.encoding = 'utf-8';
  }
  return response;
}

function buildGistFilesResponse(entry: GistEntry, baseUrl: string, includeContent: boolean): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const file of Object.values(entry.data.files).sort((left, right) => left.filename.localeCompare(right.filename))) {
    files[file.filename] = buildGistFileResponse(entry, file, baseUrl, includeContent);
  }
  return files;
}

function gistVersion(entry: GistEntry): string {
  const hash = createHash('sha1');
  hash.update(entry.record.id ?? '');
  hash.update('\0');
  hash.update(gistUpdatedAt(entry));
  hash.update('\0');
  hash.update(entry.data.description ?? '');
  hash.update('\0');
  hash.update(String(entry.data.public !== false));
  for (const file of Object.values(entry.data.files).sort((left, right) => left.filename.localeCompare(right.filename))) {
    hash.update('\0');
    hash.update(file.filename);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
    hash.update(file.type ?? '');
    hash.update('\0');
    hash.update(file.language ?? '');
  }
  return hash.digest('hex');
}

function contentLineCount(content: string): number {
  if (!content) { return 0; }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmedTrailingNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmedTrailingNewline ? trimmedTrailingNewline.split('\n').length : 0;
}

function buildGistChangeStatus(entry: GistEntry): Record<string, number> {
  const additions = Object.values(entry.data.files).reduce((sum, file) => sum + contentLineCount(file.content), 0);
  return {
    deletions : 0,
    additions,
    total     : additions,
  };
}

function buildGistCommitResponse(entry: GistEntry, baseUrl: string): Record<string, unknown> {
  const version = gistVersion(entry);
  return {
    url           : `${baseUrl}/gists/${entry.record.id}/${version}`,
    version,
    user          : buildGistOwner(entry.ownerDid, baseUrl),
    change_status : buildGistChangeStatus(entry),
    committed_at  : gistUpdatedAt(entry),
  };
}

function buildGistResponse(
  entry: GistEntry, baseUrl: string, includeContent: boolean, commentCount = 0,
): Record<string, unknown> {
  const gistUrl = `${baseUrl}/gists/${entry.record.id}`;
  const response: Record<string, unknown> = {
    url              : gistUrl,
    forks_url        : `${gistUrl}/forks`,
    commits_url      : `${gistUrl}/commits`,
    id               : entry.record.id,
    node_id          : entry.record.id,
    git_pull_url     : `${gistUrl}.git`,
    git_push_url     : `${gistUrl}.git`,
    html_url         : gistUrl,
    files            : buildGistFilesResponse(entry, baseUrl, includeContent),
    public           : entry.data.public !== false,
    created_at       : gistCreatedAt(entry),
    updated_at       : gistUpdatedAt(entry),
    description      : entry.data.description ?? '',
    comments         : commentCount,
    comments_enabled : true,
    user             : null,
    comments_url     : `${gistUrl}/comments`,
    owner            : buildGistOwner(entry.ownerDid, baseUrl),
    forks            : [],
    history          : [buildGistCommitResponse(entry, baseUrl)],
    truncated        : false,
  };
  if (entry.data.forkOfGistId && entry.data.forkOfOwnerDid) {
    response.fork_of = {
      url      : `${baseUrl}/gists/${entry.data.forkOfGistId}`,
      id       : entry.data.forkOfGistId,
      node_id  : entry.data.forkOfGistId,
      owner    : buildGistOwner(entry.data.forkOfOwnerDid, baseUrl),
      html_url : `${baseUrl}/gists/${entry.data.forkOfGistId}`,
    };
  }
  return response;
}

async function pagedGistResponse(ctx: AgentContext, entries: GistEntry[], url: URL, path: string): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(entries, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, entries.length);
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }

  const response: Record<string, unknown>[] = [];
  for (const entry of paged) {
    response.push(buildGistResponse(entry, baseUrl, false, await gistCommentCount(ctx, entry.record.id)));
  }
  return jsonOk(response, headers);
}

function parseCreateFiles(value: unknown): Record<string, GistFileData> | JsonResponse {
  if (!isObject(value) || Object.keys(value).length === 0) {
    return jsonValidationError('Validation Failed: files must include at least one file with content.');
  }

  const files: Record<string, GistFileData> = {};
  for (const [key, fileValue] of Object.entries(value)) {
    if (!isObject(fileValue) || typeof fileValue.content !== 'string') {
      return jsonValidationError('Validation Failed: each gist file must include string content.');
    }
    const filename = normalizeFilename(fileValue.filename) ?? normalizeFilename(key);
    if (!filename) {
      return jsonValidationError('Validation Failed: gist file names must be non-empty relative paths.');
    }
    const inferred = inferFileType(filename);
    files[filename] = {
      filename,
      content  : fileValue.content,
      type     : inferred.type,
      language : inferred.language,
    };
  }
  return files;
}

function parseFilePatch(value: unknown): Record<string, ParsedGistFileChange | null> | JsonResponse {
  if (!isObject(value)) {
    return jsonValidationError('Validation Failed: files must be an object.');
  }

  const changes: Record<string, ParsedGistFileChange | null> = {};
  for (const [key, fileValue] of Object.entries(value)) {
    const currentName = normalizeFilename(key);
    if (!currentName) {
      return jsonValidationError('Validation Failed: gist file names must be non-empty relative paths.');
    }
    if (fileValue === null) {
      changes[currentName] = null;
      continue;
    }
    if (!isObject(fileValue)) {
      return jsonValidationError('Validation Failed: gist file updates must be objects or null.');
    }
    const filename = fileValue.filename === null ? undefined : normalizeFilename(fileValue.filename);
    if (fileValue.filename !== undefined && fileValue.filename !== null && !filename) {
      return jsonValidationError('Validation Failed: gist file names must be non-empty relative paths.');
    }
    if (fileValue.content !== undefined && typeof fileValue.content !== 'string') {
      return jsonValidationError('Validation Failed: gist file content must be a string.');
    }
    changes[currentName] = {
      ...(filename ? { filename } : {}),
      ...(typeof fileValue.content === 'string' ? { content: fileValue.content } : {}),
    };
  }
  return changes;
}

function applyFilePatch(
  existing: Record<string, GistFileData>, changes: Record<string, ParsedGistFileChange | null>,
): Record<string, GistFileData> {
  const files = { ...existing };
  for (const [currentName, change] of Object.entries(changes)) {
    if (change === null || (!change.filename && change.content === undefined)) {
      delete files[currentName];
      continue;
    }

    const nextName = change.filename ?? currentName;
    const previous = files[currentName] ?? {
      filename : currentName,
      content  : '',
      ...inferFileType(currentName),
    };
    if (nextName !== currentName) {
      delete files[currentName];
    }
    const inferred = inferFileType(nextName);
    files[nextName] = {
      filename : nextName,
      content  : change.content ?? previous.content,
      type     : inferred.type,
      language : inferred.language,
    };
  }
  return files;
}

function parseCreateBody(body: unknown): GistData | JsonResponse {
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const files = parseCreateFiles(body.files);
  if (isJsonResponse(files)) { return files; }

  const now = new Date().toISOString();
  return {
    description : typeof body.description === 'string' ? body.description : '',
    public      : normalizePublicFlag(body.public),
    files,
    createdAt   : now,
    updatedAt   : now,
  };
}

function gistTags(data: GistData): Record<string, string> {
  return {
    visibility: data.public === false ? 'secret' : 'public',
    ...(data.forkOfOwnerDid ? { forkOfOwnerDid: data.forkOfOwnerDid } : {}),
    ...(data.forkOfGistId ? { forkOfGistId: data.forkOfGistId } : {}),
  };
}

function normalizeGistCommentData(data: unknown, tags?: Record<string, unknown>): GistCommentData | null {
  if (!isObject(data)) { return null; }

  const gistId = typeof tags?.gistId === 'string' ? tags.gistId : data.gistId;
  if (typeof gistId !== 'string' || gistId.trim() === '') { return null; }
  if (typeof data.body !== 'string') { return null; }

  return {
    gistId    : gistId.trim(),
    body      : data.body,
    userDid   : typeof data.userDid === 'string' ? data.userDid : undefined,
    createdAt : typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedAt : typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}

async function normalizeGistCommentEntry(record: any, ownerDid: string): Promise<GistCommentEntry | null> {
  try {
    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    const data = normalizeGistCommentData(await record.data.json(), tags);
    if (!data) { return null; }
    return { record, ownerDid: data.userDid ?? ownerDid, data };
  } catch {
    return null;
  }
}

async function listGistCommentEntries(
  ctx: AgentContext, gistId: string, localOnly = false,
): Promise<GistCommentEntry[]> {
  const dids = localOnly ? [ctx.did] : await collectVisibleUserDids(ctx);
  const entries: GistCommentEntry[] = [];
  for (const did of dids) {
    let records: any[];
    try {
      const result = await ctx.social.records.query('gistComment' as any, {
        from     : fromOpt(ctx, did),
        filter   : { tags: { gistId } },
        dateSort : DateSort.CreatedAscending,
      } as any);
      records = result.records;
    } catch {
      continue;
    }

    for (const record of records) {
      const entry = await normalizeGistCommentEntry(record, did);
      if (entry) { entries.push(entry); }
    }
  }
  return entries.sort((left, right) => gistCommentCreatedMs(left) - gistCommentCreatedMs(right));
}

async function gistCommentCount(ctx: AgentContext, gistId: string): Promise<number> {
  return (await listGistCommentEntries(ctx, gistId)).length;
}

function gistCommentCreatedAt(entry: GistCommentEntry): string {
  return toISODate(entry.data.createdAt ?? entry.record.dateCreated);
}

function gistCommentUpdatedAt(entry: GistCommentEntry): string {
  return toISODate(entry.data.updatedAt ?? entry.record.timestamp ?? entry.data.createdAt ?? entry.record.dateCreated);
}

function gistCommentCreatedMs(entry: GistCommentEntry): number {
  return Date.parse(gistCommentCreatedAt(entry)) || 0;
}

function gistCommentId(entry: GistCommentEntry): number {
  return numericId(entry.record.id ?? '');
}

function parseCommentBody(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') { return null; }
  return value;
}

function buildGistCommentResponse(
  comment: GistCommentEntry, gist: GistEntry, baseUrl: string,
): Record<string, unknown> {
  const id = gistCommentId(comment);
  return {
    id,
    node_id            : comment.record.id ?? `gist-comment:${id}`,
    url                : `${baseUrl}/gists/${gist.record.id}/comments/${id}`,
    body               : comment.data.body,
    user               : buildGistOwner(comment.ownerDid, baseUrl),
    created_at         : gistCommentCreatedAt(comment),
    updated_at         : gistCommentUpdatedAt(comment),
    author_association : comment.ownerDid === gist.ownerDid ? 'OWNER' : 'CONTRIBUTOR',
  };
}

async function findGistCommentById(
  ctx: AgentContext, gistId: string, commentId: string, localOnly = false,
): Promise<GistCommentEntry | null> {
  const id = Number.parseInt(commentId, 10);
  if (!Number.isInteger(id) || id < 1) { return null; }
  return (await listGistCommentEntries(ctx, gistId, localOnly)).find(entry => gistCommentId(entry) === id) ?? null;
}

function normalizeGistStarData(data: unknown, tags?: Record<string, unknown>): GistStarData | null {
  if (!isObject(data)) { return null; }

  const ownerDid = typeof tags?.ownerDid === 'string' ? tags.ownerDid : data.ownerDid;
  const gistId = typeof tags?.gistId === 'string' ? tags.gistId : data.gistId;
  if (typeof ownerDid !== 'string' || ownerDid.trim() === '') { return null; }
  if (typeof gistId !== 'string' || gistId.trim() === '') { return null; }

  return {
    ownerDid  : ownerDid.trim(),
    gistId    : gistId.trim(),
    createdAt : typeof data.createdAt === 'string' ? data.createdAt : undefined,
  };
}

async function normalizeGistStarEntry(record: any): Promise<GistStarEntry | null> {
  try {
    const tags = (record.tags as Record<string, unknown> | undefined) ?? {};
    const data = normalizeGistStarData(await record.data.json(), tags);
    if (!data) { return null; }
    return { record, data };
  } catch {
    return null;
  }
}

async function listGistStarEntries(ctx: AgentContext): Promise<GistStarEntry[]> {
  let records: any[];
  try {
    const result = await ctx.social.records.query('gistStar' as any, {
      dateSort: DateSort.CreatedAscending,
    } as any);
    records = result.records;
  } catch {
    return [];
  }

  const entries: GistStarEntry[] = [];
  for (const record of records) {
    const entry = await normalizeGistStarEntry(record);
    if (entry) { entries.push(entry); }
  }
  return entries;
}

async function findGistStar(ctx: AgentContext, gistId: string): Promise<GistStarEntry | null> {
  return (await listGistStarEntries(ctx)).find(entry => entry.data.gistId === gistId) ?? null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleListAuthenticatedGists(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = applySinceFilter(await listGistEntries(ctx, ctx.did, true), url);
  return pagedGistResponse(ctx, entries, url, '/gists');
}

export async function handleCreateGist(ctx: AgentContext, body: unknown, url: URL): Promise<JsonResponse> {
  const parsed = parseCreateBody(body);
  if (isJsonResponse(parsed)) { return parsed; }

  const { status, record } = await ctx.social.records.create('gist' as any, {
    data : parsed,
    tags : gistTags(parsed),
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create gist: ${status.detail}`);
  }

  const entry = await normalizeGistEntry(record, ctx.did);
  if (!entry) {
    return jsonValidationError('Failed to create gist: stored gist data is invalid.');
  }
  return jsonCreated(buildGistResponse(entry, buildApiUrl(url), true));
}

export async function handleListPublicGists(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries = applySinceFilter(await listVisiblePublicGists(ctx), url);
  return pagedGistResponse(ctx, entries, url, '/gists/public');
}

export async function handleListStarredGists(ctx: AgentContext, url: URL): Promise<JsonResponse> {
  const entries: GistEntry[] = [];
  const seen = new Set<string>();
  for (const star of await listGistStarEntries(ctx)) {
    if (seen.has(star.data.gistId)) { continue; }
    const gist = await findGistById(ctx, star.data.gistId);
    if (gist) {
      entries.push(gist);
      seen.add(gist.record.id);
    }
  }

  const sorted = entries.sort((left, right) => gistUpdatedMs(right) - gistUpdatedMs(left));
  return pagedGistResponse(ctx, applySinceFilter(sorted, url), url, '/gists/starred');
}

export async function handleListUserGists(ctx: AgentContext, userDid: string, url: URL): Promise<JsonResponse> {
  const entries = applySinceFilter(await listGistEntries(ctx, userDid, false), url);
  return pagedGistResponse(ctx, entries, url, `/users/${userDid}/gists`);
}

export async function handleGetGist(ctx: AgentContext, gistId: string, url: URL): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }
  return jsonOk(buildGistResponse(entry, buildApiUrl(url), true, await gistCommentCount(ctx, entry.record.id)));
}

export async function handleGetGistRawFile(
  ctx: AgentContext, gistId: string, encodedFilename: string,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return jsonNotFound(`Gist file '${encodedFilename}' not found.`);
  }

  if (!normalizeFilename(filename)) {
    return jsonNotFound(`Gist file '${filename}' not found.`);
  }

  const file = entry.data.files[filename] ?? Object.values(entry.data.files).find(item => item.filename === filename);
  if (!file) { return jsonNotFound(`Gist file '${filename}' not found.`); }

  return binaryOk(TEXT_ENCODER.encode(file.content), rawFileContentType(file));
}

export async function handleListGistCommits(ctx: AgentContext, gistId: string, url: URL): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const commits = [buildGistCommitResponse(entry, baseUrl)];
  const paged = paginate(commits, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/gists/${entry.record.id}/commits`,
    pagination.page, pagination.perPage, commits.length,
  );
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }
  return jsonOk(paged, headers);
}

export async function handleGetGistRevision(
  ctx: AgentContext, gistId: string, version: string, url: URL,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }
  if (version.toLowerCase() !== gistVersion(entry)) {
    return jsonNotFound(`Gist revision '${version}' not found.`);
  }
  return jsonOk(buildGistResponse(entry, buildApiUrl(url), true, await gistCommentCount(ctx, entry.record.id)));
}

export async function handleListGistForks(ctx: AgentContext, gistId: string, url: URL): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const forks = await listGistForkEntries(ctx, entry);
  const paged = paginate(forks, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/gists/${entry.record.id}/forks`,
    pagination.page, pagination.perPage, forks.length,
  );
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }

  const response: Record<string, unknown>[] = [];
  for (const fork of paged) {
    response.push(buildGistResponse(fork, baseUrl, false, await gistCommentCount(ctx, fork.record.id)));
  }
  return jsonOk(response, headers);
}

export async function handleForkGist(ctx: AgentContext, gistId: string, url: URL): Promise<JsonResponse> {
  const source = await findGistById(ctx, gistId);
  if (!source) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const existing = await findLocalGistFork(ctx, source);
  if (existing) {
    return jsonValidationError(`Validation Failed: gist '${gistId}' has already been forked by the authenticated user.`);
  }

  const now = new Date().toISOString();
  const files = Object.fromEntries(
    Object.entries(source.data.files).map(([name, file]) => [name, { ...file }]),
  );
  const data: GistData = {
    description    : source.data.description ?? '',
    public         : source.data.public !== false,
    files,
    forkOfOwnerDid : source.ownerDid,
    forkOfGistId   : source.record.id,
    forkedAt       : now,
    createdAt      : now,
    updatedAt      : now,
  };

  const { status, record } = await ctx.social.records.create('gist' as any, {
    data,
    tags: gistTags(data),
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to fork gist: ${status.detail}`);
  }

  const fork = await normalizeGistEntry(record, ctx.did);
  if (!fork) {
    return jsonValidationError('Failed to fork gist: stored gist data is invalid.');
  }
  return jsonCreated(buildGistResponse(fork, buildApiUrl(url), true));
}

export async function handleListGistComments(ctx: AgentContext, gistId: string, url: URL): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const comments = await listGistCommentEntries(ctx, entry.record.id);
  const paged = paginate(comments, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/gists/${entry.record.id}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }

  return jsonOk(paged.map(comment => buildGistCommentResponse(comment, entry, baseUrl)), headers);
}

export async function handleCreateGistComment(
  ctx: AgentContext, gistId: string, body: unknown, url: URL,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const commentBody = parseCommentBody(body.body);
  if (!commentBody) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const now = new Date().toISOString();
  const data: GistCommentData = {
    gistId    : entry.record.id,
    body      : commentBody,
    userDid   : ctx.did,
    createdAt : now,
    updatedAt : now,
  };
  const { status, record } = await ctx.social.records.create('gistComment' as any, {
    data,
    tags: { gistId: data.gistId },
  } as any);
  if (status.code >= 300 || !record) {
    return jsonValidationError(`Failed to create gist comment: ${status.detail}`);
  }

  const comment = await normalizeGistCommentEntry(record, ctx.did);
  if (!comment) {
    return jsonValidationError('Failed to create gist comment: stored comment data is invalid.');
  }
  return jsonCreated(buildGistCommentResponse(comment, entry, buildApiUrl(url)));
}

export async function handleGetGistComment(
  ctx: AgentContext, gistId: string, commentId: string, url: URL,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const comment = await findGistCommentById(ctx, entry.record.id, commentId);
  if (!comment) { return jsonNotFound(`Gist comment #${commentId} not found.`); }

  return jsonOk(buildGistCommentResponse(comment, entry, buildApiUrl(url)));
}

export async function handleCheckGistStar(ctx: AgentContext, gistId: string): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const star = await findGistStar(ctx, gistId);
  return star ? jsonNoContent() : jsonNotFound(`Gist '${gistId}' is not starred.`);
}

export async function handleStarGist(ctx: AgentContext, gistId: string): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const existing = await findGistStar(ctx, entry.record.id);
  if (existing) { return jsonNoContent(); }

  const data: GistStarData = {
    ownerDid  : entry.ownerDid,
    gistId    : entry.record.id,
    createdAt : new Date().toISOString(),
  };
  const { status } = await ctx.social.records.create('gistStar' as any, {
    data,
    tags: { ownerDid: data.ownerDid, gistId: data.gistId },
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to star gist: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleUnstarGist(ctx: AgentContext, gistId: string): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const star = await findGistStar(ctx, entry.record.id);
  if (!star) { return jsonNoContent(); }

  const { status } = await star.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to unstar gist: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleUpdateGistComment(
  ctx: AgentContext, gistId: string, commentId: string, body: unknown, url: URL,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }
  if (!isObject(body)) {
    return jsonValidationError('Validation Failed: request body must be an object.');
  }

  const commentBody = parseCommentBody(body.body);
  if (!commentBody) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const comment = await findGistCommentById(ctx, entry.record.id, commentId, true);
  if (!comment) { return jsonNotFound(`Gist comment #${commentId} not found.`); }

  const nextData: GistCommentData = {
    ...comment.data,
    body      : commentBody,
    updatedAt : new Date().toISOString(),
  };
  const { status } = await comment.record.update({
    data : nextData,
    tags : { gistId: entry.record.id },
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update gist comment: ${status.detail}`);
  }

  return jsonOk(buildGistCommentResponse({ ...comment, data: nextData }, entry, buildApiUrl(url)));
}

export async function handleDeleteGistComment(
  ctx: AgentContext, gistId: string, commentId: string,
): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const comment = await findGistCommentById(ctx, entry.record.id, commentId, true);
  if (!comment) { return jsonNotFound(`Gist comment #${commentId} not found.`); }

  const { status } = await comment.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete gist comment: ${status.detail}`);
  }

  return jsonNoContent();
}

export async function handleUpdateGist(
  ctx: AgentContext, gistId: string, body: unknown, url: URL,
): Promise<JsonResponse> {
  if (!isObject(body) || (body.description === undefined && body.files === undefined)) {
    return jsonValidationError('Validation Failed: at least one of description or files is required.');
  }

  const entry = await findGistById(ctx, gistId, true);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  let files = entry.data.files;
  if (body.files !== undefined) {
    const patch = parseFilePatch(body.files);
    if (isJsonResponse(patch)) { return patch; }
    files = applyFilePatch(files, patch);
    if (Object.keys(files).length === 0) {
      return jsonValidationError('Validation Failed: a gist must contain at least one file.');
    }
  }

  const now = new Date().toISOString();
  const nextData: GistData = {
    ...entry.data,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    files,
    updatedAt: now,
  };
  const { status } = await entry.record.update({
    data : nextData,
    tags : gistTags(nextData),
  } as any);
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update gist: ${status.detail}`);
  }

  return jsonOk(buildGistResponse(
    { ...entry, data: nextData }, buildApiUrl(url), true, await gistCommentCount(ctx, entry.record.id),
  ));
}

export async function handleDeleteGist(ctx: AgentContext, gistId: string): Promise<JsonResponse> {
  const entry = await findGistById(ctx, gistId, true);
  if (!entry) { return jsonNotFound(`Gist '${gistId}' not found.`); }

  const { status } = await entry.record.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete gist: ${status.detail}`);
  }
  return jsonNoContent();
}
