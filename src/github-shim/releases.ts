/**
 * GitHub API shim — `/repos/:did/:repo/releases` endpoints.
 *
 * Maps DWN release records to GitHub REST API v3 release responses.
 *
 * Endpoints:
 *   GET  /repos/:did/:repo/releases            List releases
 *   GET  /repos/:did/:repo/releases/tags/:tag  Release by tag name
 *   POST /repos/:did/:repo/releases            Create release
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonCreated,
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

function buildReleaseResponse(
  rec: any, data: any, tags: Record<string, unknown>,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const owner = buildOwner(targetDid, baseUrl);
  const tagName = (tags.tagName as string) ?? '';
  const prerelease = tags.prerelease === true;
  const draft = tags.draft === true;
  const id = numericId(rec.id ?? '');

  return {
    id,
    node_id          : rec.id ?? '',
    url              : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}`,
    html_url         : `${baseUrl}/repos/${targetDid}/${repoName}/releases/tags/${tagName}`,
    assets_url       : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}/assets`,
    upload_url       : `${baseUrl}/repos/${targetDid}/${repoName}/releases/${id}/assets{?name,label}`,
    tarball_url      : `${baseUrl}/repos/${targetDid}/${repoName}/tarball/${tagName}`,
    zipball_url      : `${baseUrl}/repos/${targetDid}/${repoName}/zipball/${tagName}`,
    tag_name         : tagName,
    target_commitish : 'main',
    name             : data.name ?? tagName,
    body             : data.body ?? '',
    draft,
    prerelease,
    created_at       : toISODate(rec.dateCreated),
    published_at     : toISODate(rec.dateCreated),
    author           : owner,
    assets           : [],
  };
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
    items.push(buildReleaseResponse(rec, data, tags, targetDid, repoName, baseUrl));
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
// GET /repos/:did/:repo/releases/tags/:tag
// ---------------------------------------------------------------------------

export async function handleGetReleaseByTag(
  ctx: AgentContext, targetDid: string, repoName: string, tag: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId, tags: { tagName: tag } },
  });

  if (records.length === 0) {
    return jsonNotFound(`Release with tag '${tag}' not found.`);
  }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, unknown> | undefined) ?? {};

  return jsonOk(buildReleaseResponse(rec, data, tags, targetDid, repoName, baseUrl));
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

  const name = (reqBody.name as string) ?? tagName;
  const body = (reqBody.body as string) ?? '';
  const baseUrl = buildApiUrl(url);

  const tags: Record<string, unknown> = { tagName };
  if (reqBody.target_commitish) { tags.commitSha = reqBody.target_commitish; }
  if (reqBody.prerelease === true) { tags.prerelease = true; }
  if (reqBody.draft === true) { tags.draft = true; }

  const { status, record } = await ctx.releases.records.create('repo/release' as any, {
    data            : { name, body },
    tags,
    parentContextId : repo.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create release: ${status.detail}`);
  }

  const recTags = (record.tags as Record<string, unknown> | undefined) ?? {};
  const data = await record.data.json();
  const release = buildReleaseResponse(record, data, recTags, targetDid, repoName, baseUrl);

  return jsonCreated(release);
}
