/**
 * GitHub API shim — repository README, license, and contents endpoints.
 *
 * Maps repo-scoped DWN metadata records (`repo/readme`, `repo/license`) to
 * GitHub REST API v3 content responses.  This is intentionally limited to
 * metadata files that gitd stores as DWN records; full git tree browsing still
 * belongs to the git transport layer.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { renderMarkdownText } from './meta.js';
import {
  binaryOk,
  buildApiUrl,
  fromOpt,
  getRepoRecord,
  jsonNotFound,
  jsonOk,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentResource = {
  protocolPath : 'repo/readme' | 'repo/license';
  name : string;
  path : string;
};

type TextRecord = {
  text : string;
};

export type ContentMediaKind = 'raw' | 'html' | 'object';

// ---------------------------------------------------------------------------
// Resource mapping
// ---------------------------------------------------------------------------

const README_RESOURCE: ContentResource = {
  protocolPath : 'repo/readme',
  name         : 'README.md',
  path         : 'README.md',
};

const LICENSE_RESOURCE: ContentResource = {
  protocolPath : 'repo/license',
  name         : 'LICENSE',
  path         : 'LICENSE',
};

function resourceForPath(path: string): ContentResource | null {
  const normalized = path.replace(/^\/+/, '').toLowerCase();
  if (normalized === 'readme' || normalized === 'readme.md') {
    return README_RESOURCE;
  }
  if (normalized === 'license' || normalized === 'license.md' || normalized === 'license.txt') {
    return LICENSE_RESOURCE;
  }
  return null;
}

function decodeContentPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function encodeContentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// DWN reads
// ---------------------------------------------------------------------------

async function readTextRecord(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, resource: ContentResource,
): Promise<TextRecord | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query(resource.protocolPath as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const record = records[0];
  if (!record) { return null; }

  const blob = await record.data.blob();
  return { text: await blob.text() };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function contentSha(text: string): string {
  return createHash('sha1').update(Buffer.from(text, 'utf-8')).digest('hex');
}

function contentSize(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function rawContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) { return 'text/markdown; charset=utf-8'; }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) { return 'text/html; charset=utf-8'; }
  if (lower.endsWith('.css')) { return 'text/css; charset=utf-8'; }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { return 'application/javascript; charset=utf-8'; }
  if (lower.endsWith('.json')) { return 'application/json; charset=utf-8'; }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) { return 'application/typescript; charset=utf-8'; }
  if (lower.endsWith('.txt') || lower === 'license') { return 'text/plain; charset=utf-8'; }
  return 'application/octet-stream';
}

function renderContentHtml(path: string, text: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return renderMarkdownText(text);
  }
  return `<pre>${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</pre>`;
}

function buildContentUrls(
  targetDid: string, repoName: string, baseUrl: string, path: string, sha: string,
): Record<string, string> {
  const fullName = `${targetDid}/${repoName}`;
  const encodedPath = encodeContentPath(path);

  return {
    url          : `${baseUrl}/repos/${fullName}/contents/${encodedPath}`,
    html_url     : `${baseUrl}/repos/${fullName}/blob/HEAD/${encodedPath}`,
    git_url      : `${baseUrl}/repos/${fullName}/git/blobs/${sha}`,
    download_url : `${baseUrl}/repos/${fullName}/raw/HEAD/${encodedPath}`,
  };
}

function buildDirectoryEntry(
  resource: ContentResource, text: string,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const sha = contentSha(text);
  const urls = buildContentUrls(targetDid, repoName, baseUrl, resource.path, sha);

  return {
    name   : resource.name,
    path   : resource.path,
    sha,
    size   : contentSize(text),
    type   : 'file',
    ...urls,
    _links : {
      self : urls.url,
      git  : urls.git_url,
      html : urls.html_url,
    },
  };
}

function buildFileResponse(
  resource: ContentResource, text: string,
  targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const buffer = Buffer.from(text, 'utf-8');
  const entry = buildDirectoryEntry(resource, text, targetDid, repoName, baseUrl);

  return {
    ...entry,
    content  : buffer.toString('base64'),
    encoding : 'base64',
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/readme[/:dir]
// ---------------------------------------------------------------------------

export async function handleGetReadme(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, mediaKind?: ContentMediaKind | null,
): Promise<JsonResponse> {
  return handleGetResource(ctx, targetDid, repoName, README_RESOURCE, url, mediaKind);
}

export async function handleGetReadmeInDirectory(
  ctx: AgentContext, targetDid: string, repoName: string, dir: string,
): Promise<JsonResponse> {
  if (!await getRepoRecord(ctx, targetDid, repoName)) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  return jsonNotFound(`README not found in '${decodeContentPath(dir)}'.`);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/license
// ---------------------------------------------------------------------------

export async function handleGetLicense(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, mediaKind?: ContentMediaKind | null,
): Promise<JsonResponse> {
  const res = await getResourceResponse(ctx, targetDid, repoName, LICENSE_RESOURCE, url, mediaKind);
  if (res.status !== 200 || mediaKind === 'raw' || mediaKind === 'html') { return res; }

  return {
    ...res,
    body: JSON.stringify({
      ...JSON.parse(res.body as string) as Record<string, unknown>,
      license: null,
    }),
  };
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/contents[/path]
// ---------------------------------------------------------------------------

export async function handleGetContents(
  ctx: AgentContext, targetDid: string, repoName: string, path: string | null, url: URL, mediaKind?: ContentMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  if (!path) {
    const entries: Record<string, unknown>[] = [];
    for (const resource of [README_RESOURCE, LICENSE_RESOURCE]) {
      const record = await readTextRecord(ctx, targetDid, repo, resource);
      if (record) {
        entries.push(buildDirectoryEntry(resource, record.text, targetDid, repo.name, baseUrl));
      }
    }
    return jsonOk(mediaKind === 'object' ? { entries } : entries);
  }

  const decodedPath = decodeContentPath(path);
  const resource = resourceForPath(decodedPath);
  if (!resource) {
    return jsonNotFound(`Content '${decodedPath}' not found in DWN repo metadata.`);
  }

  return handleGetResource(ctx, targetDid, repoName, resource, url, mediaKind);
}

export async function handleGetRawContent(
  ctx: AgentContext, targetDid: string, repoName: string, rawRef: string, path: string,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const ref = decodeContentPath(rawRef).replace(/^\/+/, '');
  if (ref && ref !== 'HEAD' && ref !== repo.defaultBranch) {
    return jsonNotFound(`Git ref '${ref}' not found.`);
  }

  const decodedPath = decodeContentPath(path);
  const resource = resourceForPath(decodedPath);
  if (!resource) {
    return jsonNotFound(`Content '${decodedPath}' not found.`);
  }

  const record = await readTextRecord(ctx, targetDid, repo, resource);
  if (!record) {
    return jsonNotFound(`Content '${resource.path}' not found.`);
  }

  return binaryOk(Buffer.from(record.text, 'utf-8'), rawContentType(resource.path));
}

async function handleGetResource(
  ctx: AgentContext, targetDid: string, repoName: string,
  resource: ContentResource, url: URL, mediaKind?: ContentMediaKind | null,
): Promise<JsonResponse> {
  return getResourceResponse(ctx, targetDid, repoName, resource, url, mediaKind);
}

async function getResourceResponse(
  ctx: AgentContext, targetDid: string, repoName: string,
  resource: ContentResource, url: URL, mediaKind?: ContentMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const textRecord = await readTextRecord(ctx, targetDid, repo, resource);
  if (!textRecord) {
    return jsonNotFound(`${resource.name} not found.`);
  }

  if (mediaKind === 'raw') {
    return binaryOk(Buffer.from(textRecord.text, 'utf-8'), rawContentType(resource.path));
  }

  if (mediaKind === 'html') {
    return binaryOk(Buffer.from(renderContentHtml(resource.path, textRecord.text), 'utf-8'), 'text/html; charset=utf-8');
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(buildFileResponse(resource, textRecord.text, targetDid, repo.name, baseUrl));
}
