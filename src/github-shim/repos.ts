/**
 * GitHub API shim — `/repos/:did/:repo` endpoint.
 *
 * Maps the DWN singleton repo record to a GitHub REST API v3
 * repository response.  The `:repo` segment is validated against the
 * stored repo name but is otherwise informational — repos are singletons
 * per DID in gitd.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import {
  buildApiUrl,
  buildOwner,
  getRepoRecord,
  jsonNotFound,
  jsonOk,
  numericId,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo
// ---------------------------------------------------------------------------

/** Build a GitHub-style repository object from DWN data. */
export function buildRepoResponse(
  repo: RepoInfo, targetDid: string, repoName: string, baseUrl: string,
): Record<string, unknown> {
  const owner = buildOwner(targetDid, baseUrl);
  const fullName = `${targetDid}/${repoName}`;

  return {
    id                : numericId(repo.contextId || `${targetDid}/repo`),
    node_id           : repo.contextId || '',
    name              : repoName,
    full_name         : fullName,
    private           : repo.visibility !== 'public',
    owner,
    html_url          : `${baseUrl}/repos/${fullName}`,
    description       : repo.description || null,
    fork              : false,
    url               : `${baseUrl}/repos/${fullName}`,
    archive_url       : `${baseUrl}/repos/${fullName}/{archive_format}{/ref}`,
    issues_url        : `${baseUrl}/repos/${fullName}/issues{/number}`,
    pulls_url         : `${baseUrl}/repos/${fullName}/pulls{/number}`,
    releases_url      : `${baseUrl}/repos/${fullName}/releases{/id}`,
    created_at        : toISODate(repo.dateCreated),
    updated_at        : toISODate(repo.timestamp),
    pushed_at         : toISODate(repo.timestamp),
    git_url           : `did://${targetDid}/${repoName}.git`,
    clone_url         : `did://${targetDid}/${repoName}.git`,
    default_branch    : repo.defaultBranch,
    visibility        : repo.visibility,
    // Counts — zero unless enriched by an indexer.
    stargazers_count  : 0,
    watchers_count    : 0,
    forks_count       : 0,
    open_issues_count : 0,
    // Standard GitHub fields with sensible defaults.
    language          : null,
    has_issues        : true,
    has_projects      : false,
    has_wiki          : true,
    has_pages         : false,
    has_downloads     : true,
    archived          : false,
    disabled          : false,
    license           : null,
    topics            : [],
    forks             : 0,
    watchers          : 0,
    size              : 0,
  };
}

/**
 * Handle `GET /repos/:did/:repo`.
 *
 * Returns a GitHub-style repository JSON response.
 */
export async function handleGetRepo(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(buildRepoResponse(repo, targetDid, repo.name, baseUrl));
}
