/**
 * GitHub API shim — `/repos/:did/:repo/releases` endpoints.
 *
 * Maps DWN release records to GitHub REST API v3 release responses.
 *
 * Endpoints:
 *   GET  /repos/:did/:repo/releases            List releases
 *   GET  /repos/:did/:repo/releases/latest     Latest published full release
 *   GET  /repos/:did/:repo/releases/:id        Release by numeric ID
 *   GET  /repos/:did/:repo/releases/:id/assets List release assets
 *   GET  /repos/:did/:repo/releases/assets/:id Release asset metadata
 *   GET  /repos/:did/:repo/releases/tags/:tag  Release by tag name
 *   GET  /repos/:did/:repo/releases/download/:tag/:asset Release asset bytes
 *   POST /repos/:did/:repo/releases            Create release
 *   POST /repos/:did/:repo/releases/generate-notes Generate release notes
 *   POST /repos/:did/:repo/releases/:id/assets Upload release asset
 *   PATCH /repos/:did/:repo/releases/:id       Update release
 *   DELETE /repos/:did/:repo/releases/:id      Delete release
 *   PATCH /repos/:did/:repo/releases/assets/:id Update release asset metadata
 *   DELETE /repos/:did/:repo/releases/assets/:id Delete release asset
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';

import { createHash } from 'node:crypto';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  binaryOk,
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
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
// Release object builder
// ---------------------------------------------------------------------------

type AssetOverride = {
  name? : string;
  label? : string | null;
  state? : string;
  updatedAt? : string;
};

type ReleaseReactionEntry = {
  id : number;
  userDid : string;
  content : ReleaseReactionContent;
  createdAt : string;
};

type ReleaseUploadOptions = {
  rawBody? : Uint8Array;
  contentType? : string;
};

type MakeLatestMode = 'true' | 'false' | 'legacy';

type ReleaseCandidate = {
  release: any;
  tags: Record<string, unknown>;
  data: any;
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const MAKE_LATEST_MODES = new Set<MakeLatestMode>(['true', 'false', 'legacy']);
const RELEASE_REACTION_CONTENTS = ['+1', 'laugh', 'heart', 'hooray', 'rocket', 'eyes'] as const;
const RELEASE_REACTION_CONTENT_SET = new Set<string>(RELEASE_REACTION_CONTENTS);
type ReleaseReactionContent = typeof RELEASE_REACTION_CONTENTS[number];

function overrideHas<K extends keyof AssetOverride>(override: AssetOverride, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(override, key);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function releaseId(rec: any): number {
  return numericId(rec.id ?? '');
}

function releaseAssetId(rec: any): number {
  return numericId(rec.id ?? '');
}

function releaseMatchesId(rec: any, id: string): boolean {
  return String(releaseId(rec)) === id;
}

function releaseAssetMatchesId(rec: any, id: string): boolean {
  return String(releaseAssetId(rec)) === id;
}

function tagNameForRelease(tags: Record<string, unknown>): string {
  return (tags.tagName as string) ?? '';
}

function tagFlag(tags: Record<string, unknown>, name: string): boolean {
  const value = tags[name];
  return value === true || value === 'true';
}

function releaseCreatedTime(rec: any): number {
  const parsed = Date.parse(String(rec.dateCreated ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function semverFromTag(tag: string): ParsedSemver | null {
  const match = tag.match(/(?:^|[^0-9A-Za-z])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }

  return {
    major      : parseInt(match[1], 10),
    minor      : parseInt(match[2], 10),
    patch      : parseInt(match[3], 10),
    prerelease : match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) { return -1; }
    if (rightPart === undefined) { return 1; }
    if (leftPart === rightPart) { continue; }

    const leftNumber = /^\d+$/.test(leftPart) ? parseInt(leftPart, 10) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? parseInt(rightPart, 10) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) { return left.major - right.major; }
  if (left.minor !== right.minor) { return left.minor - right.minor; }
  if (left.patch !== right.patch) { return left.patch - right.patch; }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function compareLegacyLatestCandidates(left: ReleaseCandidate, right: ReleaseCandidate): number {
  const leftSemver = semverFromTag(tagNameForRelease(left.tags));
  const rightSemver = semverFromTag(tagNameForRelease(right.tags));
  if (leftSemver && rightSemver) {
    const semverOrder = compareSemver(rightSemver, leftSemver);
    if (semverOrder !== 0) {
      return semverOrder;
    }
  }

  return releaseCreatedTime(right.release) - releaseCreatedTime(left.release);
}

function isPublishedFullRelease(tags: Record<string, unknown>): boolean {
  return !tagFlag(tags, 'draft') && !tagFlag(tags, 'prerelease');
}

function parseMakeLatest(value: unknown): MakeLatestMode | undefined {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string' && MAKE_LATEST_MODES.has(value as MakeLatestMode)) {
    return value as MakeLatestMode;
  }
  return undefined;
}

function releaseMakeLatest(data: any): MakeLatestMode {
  return parseMakeLatest(data?.makeLatest) ?? 'legacy';
}

function parseDiscussionCategoryName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim() ? value : null;
}

function parseReleaseReactionContent(value: unknown): ReleaseReactionContent | JsonResponse {
  if (typeof value !== 'string' || !RELEASE_REACTION_CONTENT_SET.has(value)) {
    return jsonValidationError(
      `Validation Failed: content must be one of ${RELEASE_REACTION_CONTENTS.map(content => `'${content}'`).join(', ')}.`,
    );
  }
  return value as ReleaseReactionContent;
}

function releaseDiscussionUrl(
  rec: any, data: any, targetDid: string, repoName: string, baseUrl: string,
): string | undefined {
  if (typeof data?.discussionCategoryName !== 'string' || !data.discussionCategoryName.trim()) {
    return undefined;
  }

  return `${baseUrl}/repos/${targetDid}/${repoName}/discussions/${numericId(`${rec.id ?? releaseId(rec)}:discussion`)}`;
}

async function repoImmutableReleasesEnabled(
  ctx: AgentContext, targetDid: string, repoContextId: string,
): Promise<boolean> {
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from   : fromOpt(ctx, targetDid),
    filter : { contextId: repoContextId },
  });

  if (records.length === 0) {
    return false;
  }

  const settings = await records[0].data.json();
  return settings?.immutableReleasesEnabled === true;
}

function assetSize(tags: Record<string, unknown>, fallback = 0): number {
  const raw = tags.size;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function assetOverrides(data: any): Record<string, AssetOverride> {
  if (!data.assetOverrides || typeof data.assetOverrides !== 'object' || Array.isArray(data.assetOverrides)) {
    return {};
  }
  return data.assetOverrides as Record<string, AssetOverride>;
}

function releaseReactions(data: any): Record<string, ReleaseReactionEntry> {
  if (!data.reactions || typeof data.reactions !== 'object' || Array.isArray(data.reactions)) {
    return {};
  }
  return data.reactions as Record<string, ReleaseReactionEntry>;
}

function releaseReactionEntries(data: any): ReleaseReactionEntry[] {
  return Object.values(releaseReactions(data))
    .filter((entry): entry is ReleaseReactionEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function nextReleaseReactionId(data: any): number {
  return releaseReactionEntries(data).reduce((max, reaction) => Math.max(max, reaction.id), 0) + 1;
}

function releaseReactionKey(id: number): string {
  return String(id);
}

function assetOverrideKey(rec: any): string {
  return rec.id ?? String(releaseAssetId(rec));
}

async function releaseAssetDigest(rec: any): Promise<string> {
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};
  if (typeof tags.digest === 'string' && tags.digest) {
    return tags.digest;
  }

  const bytes = await readAssetBytes(rec);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function buildAssetResponse(
  rec: any, releaseTagName: string, targetDid: string, repoName: string, baseUrl: string,
  override: AssetOverride = {},
): Promise<Record<string, unknown>> {
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};
  const filename = override.name ?? String(tags.filename ?? 'asset');
  const contentType = String(tags.contentType ?? rec.dataFormat ?? 'application/octet-stream');
  const label = overrideHas(override, 'label')
    ? (override.label ?? null)
    : (typeof tags.label === 'string' ? tags.label : null);
  const id = releaseAssetId(rec);
  const encodedTag = encodeURIComponent(releaseTagName);
  const encodedName = encodeURIComponent(filename);
  const owner = buildOwner(targetDid, baseUrl);

  return {
    url                  : `${baseUrl}/repos/${targetDid}/${repoName}/releases/assets/${id}`,
    id,
    node_id              : rec.id ?? '',
    name                 : filename,
    label,
    uploader             : owner,
    content_type         : contentType,
    state                : override.state ?? 'uploaded',
    size                 : assetSize(tags),
    digest               : await releaseAssetDigest(rec),
    download_count       : 0,
    created_at           : toISODate(rec.dateCreated),
    updated_at           : override.updatedAt ?? toISODate(rec.timestamp ?? rec.dateCreated),
    browser_download_url : `${baseUrl}/repos/${targetDid}/${repoName}/releases/download/${encodedTag}/${encodedName}`,
  };
}

function buildReleaseReactionResponse(
  reaction: ReleaseReactionEntry, baseUrl: string,
): Record<string, unknown> {
  return {
    id         : reaction.id,
    node_id    : `release-reaction:${reaction.id}`,
    user       : buildOwner(reaction.userDid, baseUrl),
    content    : reaction.content,
    created_at : toISODate(reaction.createdAt),
  };
}

async function listReleaseAssets(ctx: AgentContext, from: string | undefined, releaseContextId: string): Promise<any[]> {
  const { records } = await ctx.releases.records.query('repo/release/asset' as any, {
    from,
    filter   : { contextId: releaseContextId },
    dateSort : DateSort.CreatedAscending,
  });

  return records;
}

async function buildReleaseResponse(
  ctx: AgentContext, from: string | undefined,
  rec: any, data: any, tags: Record<string, unknown>,
  targetDid: string, repoName: string, baseUrl: string,
  immutableReleasesEnabled = false, defaultBranch = 'main',
): Promise<Record<string, unknown>> {
  const owner = buildOwner(targetDid, baseUrl);
  const tagName = tagNameForRelease(tags);
  const prerelease = tagFlag(tags, 'prerelease');
  const draft = tagFlag(tags, 'draft');
  const id = releaseId(rec);
  const assetRecords = await listReleaseAssets(ctx, from, rec.contextId ?? '');
  const overrides = assetOverrides(data);
  const assets = await Promise.all(assetRecords.map((asset) => {
    return buildAssetResponse(asset, tagName, targetDid, repoName, baseUrl, overrides[assetOverrideKey(asset)]);
  }));

  const response: Record<string, unknown> = {
    id,
    node_id          : rec.id ?? '',
    url              : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}`,
    html_url         : `${baseUrl}/repos/${targetDid}/${repoName}/releases/tags/${tagName}`,
    assets_url       : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}/assets`,
    upload_url       : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}/assets{?name,label}`,
    tarball_url      : `${baseUrl}/repos/${targetDid}/${repoName}/tarball/${tagName}`,
    zipball_url      : `${baseUrl}/repos/${targetDid}/${repoName}/zipball/${tagName}`,
    tag_name         : tagName,
    target_commitish : (tags.commitSha as string) ?? defaultBranch,
    name             : data.name ?? tagName,
    body             : data.body ?? '',
    draft,
    prerelease,
    immutable        : immutableReleasesEnabled,
    created_at       : toISODate(rec.dateCreated),
    published_at     : draft ? null : toISODate(data.publishedAt ?? rec.dateCreated),
    author           : owner,
    assets,
  };
  const discussionUrl = releaseDiscussionUrl(rec, data, targetDid, repoName, baseUrl);
  if (discussionUrl) {
    response.discussion_url = discussionUrl;
  }

  return response;
}

async function findReleaseById(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<{
  from: string | undefined;
  immutableReleasesEnabled: boolean;
  defaultBranch: string;
  repoContextId: string;
  release: any;
  tags: Record<string, unknown>;
  data: any;
} | null> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return null;
  }

  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId },
  });
  const release = records.find((rec: any) => releaseMatchesId(rec, id));
  if (!release) {
    return null;
  }

  return {
    from,
    immutableReleasesEnabled : await repoImmutableReleasesEnabled(ctx, targetDid, repo.contextId),
    defaultBranch            : repo.defaultBranch,
    repoContextId            : repo.contextId,
    release,
    tags                     : (release.tags as Record<string, unknown> | undefined) ?? {},
    data                     : await release.data.json(),
  };
}

async function clearExplicitLatestReleases(
  ctx: AgentContext, from: string | undefined, repoContextId: string, keepId: string,
): Promise<JsonResponse | undefined> {
  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repoContextId },
  });

  for (const rec of records) {
    if (rec.id === keepId) {
      continue;
    }

    const data = await rec.data.json();
    if (releaseMakeLatest(data) !== 'true') {
      continue;
    }

    const { status } = await rec.update({
      data : { ...data, makeLatest: 'false' },
      tags : ((rec.tags as Record<string, unknown> | undefined) ?? {}) as any,
    });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update release latest state: ${status.detail}`);
    }
  }

  return undefined;
}

async function findAssetById(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<{
  from: string | undefined;
  release: any;
  releaseData: any;
  releaseTags: Record<string, unknown>;
  asset: any;
} | null> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return null;
  }

  const from = fromOpt(ctx, targetDid);
  const { records: releases } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  for (const release of releases) {
    const assets = await listReleaseAssets(ctx, from, release.contextId ?? '');
    const asset = assets.find((rec: any) => releaseAssetMatchesId(rec, id));
    if (asset) {
      return {
        from,
        release,
        releaseData : await release.data.json(),
        releaseTags : (release.tags as Record<string, unknown> | undefined) ?? {},
        asset,
      };
    }
  }

  return null;
}

function effectiveAssetName(asset: any, overrides: Record<string, AssetOverride>): string {
  const tags = (asset.tags as Record<string, unknown> | undefined) ?? {};
  return overrides[assetOverrideKey(asset)]?.name ?? String(tags.filename ?? '');
}

async function readAssetBytes(asset: any): Promise<Uint8Array> {
  const blob = await asset.data.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases
// ---------------------------------------------------------------------------

export async function handleListReleases(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const immutableReleasesEnabled = await repoImmutableReleasesEnabled(ctx, targetDid, repo.contextId);

  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  const paged = paginate(records, pagination);

  const items: Record<string, unknown>[] = [];
  for (const rec of paged) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};
    items.push(await buildReleaseResponse(
      ctx, from, rec, data, tags, targetDid, repoName, baseUrl, immutableReleasesEnabled,
      repo.defaultBranch,
    ));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/releases`,
    pagination.page, pagination.perPage, records.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/latest
// ---------------------------------------------------------------------------

export async function handleGetLatestRelease(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const immutableReleasesEnabled = await repoImmutableReleasesEnabled(ctx, targetDid, repo.contextId);
  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const explicitCandidates: ReleaseCandidate[] = [];
  const legacyCandidates: ReleaseCandidate[] = [];
  for (const release of records) {
    const tags = (release.tags as Record<string, unknown> | undefined) ?? {};
    if (isPublishedFullRelease(tags)) {
      const data = await release.data.json();
      const makeLatest = releaseMakeLatest(data);
      if (makeLatest === 'true') {
        explicitCandidates.push({ release, tags, data });
      } else if (makeLatest === 'legacy') {
        legacyCandidates.push({ release, tags, data });
      }
    }
  }

  explicitCandidates.sort((left, right) => releaseCreatedTime(right.release) - releaseCreatedTime(left.release));
  legacyCandidates.sort(compareLegacyLatestCandidates);
  const latest = explicitCandidates[0] ?? legacyCandidates[0];
  if (!latest) {
    return jsonNotFound('Latest release not found.');
  }

  return jsonOk(await buildReleaseResponse(
    ctx, from, latest.release, latest.data, latest.tags, targetDid, repoName, buildApiUrl(url),
    immutableReleasesEnabled, repo.defaultBranch,
  ));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/:id
// ---------------------------------------------------------------------------

export async function handleGetReleaseById(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(await buildReleaseResponse(
    ctx, found.from, found.release, found.data, found.tags, targetDid, repoName, baseUrl,
    found.immutableReleasesEnabled, found.defaultBranch,
  ));
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/releases/:id
// ---------------------------------------------------------------------------

export async function handleUpdateRelease(
  ctx: AgentContext, targetDid: string, repoName: string,
  id: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const makeLatestProvided = hasOwn(reqBody, 'make_latest');
  const requestedMakeLatest = makeLatestProvided ? parseMakeLatest(reqBody.make_latest) : undefined;
  if (makeLatestProvided && requestedMakeLatest === undefined) {
    return jsonValidationError('Validation Failed: make_latest must be one of true, false, or legacy.');
  }

  const hasLinkedDiscussion = typeof found.data.discussionCategoryName === 'string'
    && found.data.discussionCategoryName.trim() !== '';
  const discussionCategoryProvided = hasOwn(reqBody, 'discussion_category_name');
  const requestedDiscussionCategory = discussionCategoryProvided && !hasLinkedDiscussion
    ? parseDiscussionCategoryName(reqBody.discussion_category_name)
    : undefined;
  if (discussionCategoryProvided && !hasLinkedDiscussion && requestedDiscussionCategory === null) {
    return jsonNotFound('Discussion category not found.');
  }

  const tagName = typeof reqBody.tag_name === 'string' ? reqBody.tag_name : tagNameForRelease(found.tags);
  if (!tagName) {
    return jsonValidationError('Validation Failed: tag_name is required.');
  }
  const existingTagRelease = await findReleaseByTag(ctx, targetDid, repoName, tagName);
  if (existingTagRelease && String(releaseId(existingTagRelease.release)) !== id) {
    return jsonValidationError(`Validation Failed: release already exists for tag_name '${tagName}'.`);
  }

  const updatedData: Record<string, unknown> = {
    ...found.data,
    name : typeof reqBody.name === 'string' ? reqBody.name : found.data.name,
    body : typeof reqBody.body === 'string' ? reqBody.body : (found.data.body ?? ''),
  };
  if (requestedDiscussionCategory) {
    updatedData.discussionCategoryName = requestedDiscussionCategory;
  }
  const updatedTags: Record<string, unknown> = {
    ...found.tags,
    tagName,
  };

  if (typeof reqBody.target_commitish === 'string') {
    updatedTags.commitSha = reqBody.target_commitish;
  }
  if (typeof reqBody.draft === 'boolean') {
    updatedTags.draft = reqBody.draft;
  }
  if (typeof reqBody.prerelease === 'boolean') {
    updatedTags.prerelease = reqBody.prerelease;
  }
  if (tagFlag(found.tags, 'draft') && updatedTags.draft === false && typeof updatedData.publishedAt !== 'string') {
    updatedData.publishedAt = new Date().toISOString();
  }

  let latestMode = requestedMakeLatest ?? releaseMakeLatest(found.data);
  if (makeLatestProvided && requestedMakeLatest === 'true' && !isPublishedFullRelease(updatedTags)) {
    return jsonValidationError('Validation Failed: draft and prerelease releases cannot be set as latest.');
  }
  if (!isPublishedFullRelease(updatedTags)) {
    latestMode = 'false';
  }
  if (latestMode === 'true' || makeLatestProvided || !isPublishedFullRelease(updatedTags)) {
    updatedData.makeLatest = latestMode;
  }

  const { status } = await found.release.update({
    data : updatedData,
    tags : updatedTags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update release: ${status.detail}`);
  }

  if (updatedData.makeLatest === 'true') {
    const clearError = await clearExplicitLatestReleases(ctx, found.from, found.repoContextId, found.release.id ?? '');
    if (clearError) { return clearError; }
  }

  return jsonOk(await buildReleaseResponse(
    ctx, found.from, found.release, updatedData, updatedTags, targetDid, repoName, buildApiUrl(url),
    found.immutableReleasesEnabled, found.defaultBranch,
  ));
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/releases/:id
// ---------------------------------------------------------------------------

export async function handleDeleteRelease(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const { status } = await found.release.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete release: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /repos/:did/:repo/releases/:id/reactions
// ---------------------------------------------------------------------------

export async function handleListReleaseReactions(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const contentFilter = url.searchParams.get('content');
  if (contentFilter !== null) {
    const parsed = parseReleaseReactionContent(contentFilter);
    if (typeof parsed !== 'string') { return parsed; }
  }

  const pagination = parsePagination(url);
  const reactions = contentFilter === null
    ? releaseReactionEntries(found.data)
    : releaseReactionEntries(found.data).filter(reaction => reaction.content === contentFilter);
  const paged = paginate(reactions, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/releases/${id}/reactions`,
    pagination.page, pagination.perPage, reactions.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(reaction => buildReleaseReactionResponse(reaction, baseUrl)), extraHeaders);
}

export async function handleCreateReleaseReaction(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const content = parseReleaseReactionContent(reqBody.content);
  if (typeof content !== 'string') { return content; }

  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  const duplicate = releaseReactionEntries(found.data).find((reaction) => {
    return reaction.userDid === ctx.did && reaction.content === content;
  });
  if (duplicate) {
    return jsonOk(buildReleaseReactionResponse(duplicate, baseUrl));
  }

  const reaction: ReleaseReactionEntry = {
    id        : nextReleaseReactionId(found.data),
    userDid   : ctx.did,
    content,
    createdAt : new Date().toISOString(),
  };
  const reactions = releaseReactions(found.data);
  const updatedData = {
    ...found.data,
    reactions: {
      ...reactions,
      [releaseReactionKey(reaction.id)]: reaction,
    },
  };
  const { status } = await found.release.update({
    data : updatedData,
    tags : found.tags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create release reaction: ${status.detail}`);
  }

  return jsonCreated(buildReleaseReactionResponse(reaction, baseUrl));
}

export async function handleDeleteReleaseReaction(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, reactionId: string,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const parsedId = parseInt(reactionId, 10);
  const reactions = releaseReactions(found.data);
  const reaction = Object.values(reactions).find(entry => entry.id === parsedId);
  if (!reaction) {
    return jsonNotFound(`Reaction #${reactionId} not found on release #${id}.`);
  }

  const updatedReactions = { ...reactions };
  delete updatedReactions[releaseReactionKey(reaction.id)];
  const updatedData: Record<string, unknown> = { ...found.data };
  if (Object.keys(updatedReactions).length > 0) {
    updatedData.reactions = updatedReactions;
  } else {
    delete updatedData.reactions;
  }

  const { status } = await found.release.update({
    data : updatedData,
    tags : found.tags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete release reaction: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/:id/assets
// ---------------------------------------------------------------------------

export async function handleListReleaseAssets(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  const tagName = tagNameForRelease(found.tags);
  const pagination = parsePagination(url);
  const assets = await listReleaseAssets(ctx, found.from, found.release.contextId ?? '');
  const overrides = assetOverrides(found.data);
  const paged = paginate(assets, pagination);
  const items = await Promise.all(paged.map((asset) => {
    return buildAssetResponse(asset, tagName, targetDid, repoName, baseUrl, overrides[assetOverrideKey(asset)]);
  }));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/releases/${id}/assets`,
    pagination.page, pagination.perPage, assets.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/releases/:id/assets
// ---------------------------------------------------------------------------

export async function handleUploadReleaseAsset(
  ctx: AgentContext, targetDid: string, repoName: string,
  id: string, url: URL, options: ReleaseUploadOptions = {},
): Promise<JsonResponse> {
  const found = await findReleaseById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release '${id}' not found.`);
  }

  const name = url.searchParams.get('name') ?? '';
  if (!name) {
    return jsonValidationError('Validation Failed: name is required.');
  }

  const assets = await listReleaseAssets(ctx, found.from, found.release.contextId ?? '');
  const overrides = assetOverrides(found.data);
  if (assets.some((asset) => effectiveAssetName(asset, overrides) === name)) {
    return jsonValidationError('Validation Failed: asset with same filename already exists.');
  }

  const bytes = options.rawBody ? new Uint8Array(options.rawBody) : new Uint8Array();
  const contentType = options.contentType?.split(';')[0]?.trim() || 'application/octet-stream';
  const label = url.searchParams.get('label');
  const tags: Record<string, unknown> = {
    filename    : name,
    contentType : contentType,
    size        : bytes.byteLength,
  };

  const { status, record } = await ctx.releases.records.create('repo/release/asset' as any, {
    data            : bytes,
    dataFormat      : contentType,
    tags,
    parentContextId : found.release.contextId ?? '',
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to upload release asset: ${status.detail}`);
  }
  if (!record) {throw new Error('Failed to create release asset record');}

  let override: AssetOverride = {};
  if (label !== null) {
    override = { label, updatedAt: new Date().toISOString() };
    const { status: updateStatus } = await found.release.update({
      data: {
        ...found.data,
        assetOverrides: {
          ...overrides,
          [assetOverrideKey(record)]: override,
        },
      },
      tags: found.tags,
    });

    if (updateStatus.code >= 300) {
      return jsonValidationError(`Failed to store release asset label: ${updateStatus.detail}`);
    }
  }

  return jsonCreated(await buildAssetResponse(
    record, tagNameForRelease(found.tags), targetDid, repoName, buildApiUrl(url), override,
  ));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/assets/:id
// ---------------------------------------------------------------------------

export async function handleGetReleaseAsset(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
  mediaKind: 'binary' | null = null,
): Promise<JsonResponse> {
  const found = await findAssetById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release asset '${id}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  if (mediaKind === 'binary') {
    return releaseAssetBinaryResponse(found.asset, baseUrl, targetDid, repoName);
  }

  return jsonOk(await buildAssetResponse(
    found.asset, tagNameForRelease(found.releaseTags), targetDid, repoName, baseUrl,
    assetOverrides(found.releaseData)[assetOverrideKey(found.asset)],
  ));
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/releases/assets/:id
// ---------------------------------------------------------------------------

export async function handleUpdateReleaseAsset(
  ctx: AgentContext, targetDid: string, repoName: string,
  id: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const found = await findAssetById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release asset '${id}' not found.`);
  }

  if (reqBody.name !== undefined && typeof reqBody.name !== 'string') {
    return jsonValidationError('Validation Failed: name must be a string.');
  }
  if (reqBody.label !== undefined && reqBody.label !== null && typeof reqBody.label !== 'string') {
    return jsonValidationError('Validation Failed: label must be a string or null.');
  }
  if (reqBody.state !== undefined && typeof reqBody.state !== 'string') {
    return jsonValidationError('Validation Failed: state must be a string.');
  }

  const overrides = assetOverrides(found.releaseData);
  const key = assetOverrideKey(found.asset);
  const nextOverride: AssetOverride = {
    ...(overrides[key] ?? {}),
    ...(typeof reqBody.name === 'string' ? { name: reqBody.name } : {}),
    ...(reqBody.label !== undefined ? { label: reqBody.label as string | null } : {}),
    ...(typeof reqBody.state === 'string' ? { state: reqBody.state } : {}),
    updatedAt: new Date().toISOString(),
  };
  const updatedReleaseData = {
    ...found.releaseData,
    assetOverrides: {
      ...overrides,
      [key]: nextOverride,
    },
  };

  const { status } = await found.release.update({
    data : updatedReleaseData,
    tags : found.releaseTags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update release asset: ${status.detail}`);
  }

  return jsonOk(await buildAssetResponse(
    found.asset, tagNameForRelease(found.releaseTags), targetDid, repoName, buildApiUrl(url), nextOverride,
  ));
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/releases/assets/:id
// ---------------------------------------------------------------------------

export async function handleDeleteReleaseAsset(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const found = await findAssetById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release asset '${id}' not found.`);
  }

  const { status } = await found.asset.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete release asset: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/assets/:id/download
// ---------------------------------------------------------------------------

export async function handleDownloadReleaseAsset(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const found = await findAssetById(ctx, targetDid, repoName, id);
  if (!found) {
    return jsonNotFound(`Release asset '${id}' not found.`);
  }

  return releaseAssetBinaryResponse(found.asset, buildApiUrl(url), targetDid, repoName);
}

async function releaseAssetBinaryResponse(
  asset: any, baseUrl: string, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const tags = (asset.tags as Record<string, unknown> | undefined) ?? {};
  const filename = String(tags.filename ?? 'asset');
  const contentType = String(tags.contentType ?? asset.dataFormat ?? 'application/octet-stream');
  const bytes = await readAssetBytes(asset);

  return binaryOk(bytes, contentType, {
    'Content-Disposition' : `attachment; filename="${filename.replace(/"/g, '')}"`,
    'X-GitHub-Asset-Url'  : `${baseUrl}/repos/${targetDid}/${repoName}/releases/assets/${releaseAssetId(asset)}`,
  });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/download/:tag/:asset
// ---------------------------------------------------------------------------

export async function handleDownloadReleaseAssetByName(
  ctx: AgentContext, targetDid: string, repoName: string, rawTag: string, rawName: string,
): Promise<JsonResponse> {
  const tag = decodeRouteParam(rawTag);
  const name = decodeRouteParam(rawName);
  const release = await findReleaseByTag(ctx, targetDid, repoName, tag);
  if (!release) {
    return jsonNotFound(`Release with tag '${tag}' not found.`);
  }

  const assets = await listReleaseAssets(ctx, release.from, release.release.contextId ?? '');
  const overrides = assetOverrides(release.data);
  const asset = assets.find((rec) => {
    return effectiveAssetName(rec, overrides) === name;
  });
  if (!asset) {
    return jsonNotFound(`Release asset '${name}' not found.`);
  }

  const tags = (asset.tags as Record<string, unknown> | undefined) ?? {};
  const contentType = String(tags.contentType ?? asset.dataFormat ?? 'application/octet-stream');
  const effectiveName = overrides[assetOverrideKey(asset)]?.name ?? name;
  return binaryOk(await readAssetBytes(asset), contentType, {
    'Content-Disposition': `attachment; filename="${effectiveName.replace(/"/g, '')}"`,
  });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/releases/tags/:tag
// ---------------------------------------------------------------------------

async function findReleaseByTag(
  ctx: AgentContext, targetDid: string, repoName: string, tag: string,
): Promise<{
  from: string | undefined;
  immutableReleasesEnabled: boolean;
  defaultBranch: string;
  release: any;
  tags: Record<string, unknown>;
  data: any;
} | null> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return null;
  }

  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId, tags: { tagName: tag } },
  });

  if (records.length === 0) {
    return null;
  }

  const release = records[0];
  return {
    from,
    immutableReleasesEnabled : await repoImmutableReleasesEnabled(ctx, targetDid, repo.contextId),
    defaultBranch            : repo.defaultBranch,
    release,
    tags                     : (release.tags as Record<string, unknown> | undefined) ?? {},
    data                     : await release.data.json(),
  };
}

export async function handleGetReleaseByTag(
  ctx: AgentContext, targetDid: string, repoName: string, rawTag: string, url: URL,
): Promise<JsonResponse> {
  const tag = decodeRouteParam(rawTag);
  const found = await findReleaseByTag(ctx, targetDid, repoName, tag);
  if (!found) {
    return jsonNotFound(`Release with tag '${tag}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(await buildReleaseResponse(
    ctx, found.from, found.release, found.data, found.tags, targetDid, repoName, baseUrl,
    found.immutableReleasesEnabled, found.defaultBranch,
  ));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/releases/generate-notes
// ---------------------------------------------------------------------------

function buildGeneratedReleaseNotes(
  targetDid: string, repoName: string, tagName: string, targetCommitish: string, previousTagName: string | null = null,
): { name: string; body: string } {
  const body = [
    `## Changes in ${tagName}`,
    '',
    `Generated release notes for ${targetDid}/${repoName}.`,
    '',
    `Target: ${targetCommitish}`,
    ...(previousTagName ? [`Previous tag: ${previousTagName}`] : []),
  ].join('\n');

  return {
    name: `Release ${tagName}`,
    body,
  };
}

export async function handleGenerateReleaseNotes(
  ctx: AgentContext, targetDid: string, repoName: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const tagName = typeof reqBody.tag_name === 'string' ? reqBody.tag_name : '';
  if (!tagName) {
    return jsonValidationError('Validation Failed: tag_name is required.');
  }

  const targetCommitish = typeof reqBody.target_commitish === 'string'
    ? reqBody.target_commitish
    : repo.defaultBranch;
  const previousTagName = typeof reqBody.previous_tag_name === 'string'
    ? reqBody.previous_tag_name
    : null;

  return jsonOk(buildGeneratedReleaseNotes(targetDid, repoName, tagName, targetCommitish, previousTagName));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/releases — create release
// ---------------------------------------------------------------------------

export async function handleCreateRelease(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const tagName = reqBody.tag_name as string | undefined;
  if (!tagName) {
    return jsonValidationError('Validation Failed: tag_name is required.');
  }
  const existingRelease = await findReleaseByTag(ctx, targetDid, repoName, tagName);
  if (existingRelease) {
    return jsonValidationError(`Validation Failed: release already exists for tag_name '${tagName}'.`);
  }

  let name = typeof reqBody.name === 'string' ? reqBody.name : tagName;
  let body = typeof reqBody.body === 'string' ? reqBody.body : '';
  const baseUrl = buildApiUrl(url);
  const immutableReleasesEnabled = await repoImmutableReleasesEnabled(ctx, targetDid, repo.contextId);

  const tags: Record<string, unknown> = { tagName };
  if (reqBody.target_commitish) { tags.commitSha = reqBody.target_commitish; }
  if (reqBody.prerelease === true) { tags.prerelease = true; }
  if (reqBody.draft === true) { tags.draft = true; }

  if (reqBody.generate_release_notes === true) {
    const targetCommitish = typeof reqBody.target_commitish === 'string'
      ? reqBody.target_commitish
      : repo.defaultBranch;
    const notes = buildGeneratedReleaseNotes(targetDid, repoName, tagName, targetCommitish);
    if (typeof reqBody.name !== 'string') {
      name = notes.name;
    }
    body = body ? `${body}\n\n${notes.body}` : notes.body;
  }

  const makeLatestProvided = hasOwn(reqBody, 'make_latest');
  const requestedMakeLatest = makeLatestProvided ? parseMakeLatest(reqBody.make_latest) : undefined;
  if (makeLatestProvided && requestedMakeLatest === undefined) {
    return jsonValidationError('Validation Failed: make_latest must be one of true, false, or legacy.');
  }
  if (requestedMakeLatest === 'true' && !isPublishedFullRelease(tags)) {
    return jsonValidationError('Validation Failed: draft and prerelease releases cannot be set as latest.');
  }
  const makeLatest = requestedMakeLatest ?? (isPublishedFullRelease(tags) ? 'true' : 'false');
  const releaseData: Record<string, unknown> = { name, body, makeLatest };
  if (hasOwn(reqBody, 'discussion_category_name')) {
    const discussionCategoryName = parseDiscussionCategoryName(reqBody.discussion_category_name);
    if (discussionCategoryName === null) {
      return jsonNotFound('Discussion category not found.');
    }
    releaseData.discussionCategoryName = discussionCategoryName;
  }

  const { status, record } = await ctx.releases.records.create('repo/release' as any, {
    data            : releaseData,
    tags,
    parentContextId : repo.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create release: ${status.detail}`);
  }
  if (!record) {throw new Error('Failed to create release record');}

  if (makeLatest === 'true') {
    const clearError = await clearExplicitLatestReleases(ctx, fromOpt(ctx, targetDid), repo.contextId, record.id ?? '');
    if (clearError) { return clearError; }
  }

  const recTags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = await record.data.json();
  const release = await buildReleaseResponse(
    ctx, fromOpt(ctx, targetDid), record, data, recTags, targetDid, repoName, baseUrl,
    immutableReleasesEnabled, repo.defaultBranch,
  );

  return jsonCreated(release);
}
