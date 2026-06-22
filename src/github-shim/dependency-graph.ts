/**
 * GitHub API shim — dependency graph endpoints.
 *
 * Provides a repository-scoped SPDX SBOM export so clients that expect
 * GitHub's dependency graph API can discover a stable software bill of
 * materials for a gitd repository.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import {
  baseHeaders,
  buildApiUrl,
  getRepoRecord,
  jsonCreated,
  jsonNotFound,
  jsonOk,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableSbomReportId(targetDid: string, repoName: string): string {
  const hex = createHash('sha256').update(`dependency-graph:sbom:${targetDid}/${repoName}`).digest('hex');
  const variant = ((parseInt(hex[16] ?? '8', 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function repoApiPath(baseUrl: string, targetDid: string, repoName: string): string {
  return `${baseUrl}/repos/${targetDid}/${repoName}`;
}

function packageUrl(targetDid: string, repo: RepoInfo): string {
  const owner = encodeURIComponent(targetDid);
  const name = encodeURIComponent(repo.name);
  const version = encodeURIComponent(repo.defaultBranch || 'HEAD');
  return `pkg:generic/${owner}/${name}@${version}`;
}

function buildRepositorySbom(targetDid: string, repo: RepoInfo, baseUrl: string): Record<string, unknown> {
  const repoUrl = repoApiPath(baseUrl, targetDid, repo.name);
  const reportId = stableSbomReportId(targetDid, repo.name);

  return {
    sbom: {
      SPDXID       : 'SPDXRef-DOCUMENT',
      spdxVersion  : 'SPDX-2.3',
      creationInfo : {
        created  : toISODate(repo.timestamp || repo.dateCreated),
        creators : ['Tool: gitd-github-shim'],
      },
      name              : `${targetDid}/${repo.name}`,
      dataLicense       : 'CC0-1.0',
      documentNamespace : `${repoUrl}/dependency-graph/sbom/${reportId}`,
      packages          : [{
        name                  : `${targetDid}/${repo.name}`,
        SPDXID                : 'SPDXRef-Repository',
        versionInfo           : repo.defaultBranch || 'HEAD',
        downloadLocation      : repoUrl,
        filesAnalyzed         : false,
        supplier              : 'NOASSERTION',
        primaryPackagePurpose : 'SOURCE',
        externalRefs          : [{
          referenceCategory : 'PACKAGE-MANAGER',
          referenceType     : 'purl',
          referenceLocator  : packageUrl(targetDid, repo),
        }],
      }],
      relationships: [{
        spdxElementId      : 'SPDXRef-DOCUMENT',
        relationshipType   : 'DESCRIBES',
        relatedSpdxElement : 'SPDXRef-Repository',
      }],
    },
  };
}

async function getRepoOrNotFound(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoInfo | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }
  return repo;
}

function redirectFound(location: string): JsonResponse {
  return {
    status  : 302,
    headers : {
      ...baseHeaders(),
      Location           : location,
      'Content-Length'   : '0',
      'X-GitHub-Request' : 'dependency-graph-sbom',
    },
    body: '',
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleExportDependencyGraphSbom(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOrNotFound(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  return jsonOk(buildRepositorySbom(targetDid, repo, buildApiUrl(url)));
}

export async function handleGenerateDependencyGraphSbom(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOrNotFound(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  const baseUrl = buildApiUrl(url);
  const reportId = stableSbomReportId(targetDid, repo.name);
  const sbomUrl = `${repoApiPath(baseUrl, targetDid, repo.name)}/dependency-graph/sbom/fetch-report/${reportId}`;

  return jsonCreated({ sbom_url: sbomUrl }, { Location: sbomUrl });
}

export async function handleFetchDependencyGraphSbom(
  ctx: AgentContext, targetDid: string, repoName: string, sbomUuid: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOrNotFound(ctx, targetDid, repoName);
  if ('status' in repo) { return repo; }

  if (sbomUuid !== stableSbomReportId(targetDid, repo.name)) {
    return jsonNotFound(`SBOM report '${sbomUuid}' not found for repository '${repo.name}'.`);
  }

  const location = `${repoApiPath(buildApiUrl(url), targetDid, repo.name)}/dependency-graph/sbom?download=1`;
  return redirectFound(location);
}
