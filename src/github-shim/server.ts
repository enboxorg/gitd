/**
 * GitHub API compatibility shim — HTTP server and router.
 *
 * Translates GitHub REST API v3 requests into DWN queries and returns
 * GitHub-compatible JSON responses.  This allows existing tools that
 * speak the GitHub API (VS Code extensions, `gh` CLI, CI/CD systems)
 * to read data from any DWN-enabled git forge.
 *
 * Phase 1 is read-only — only GET endpoints are supported.
 *
 * URL scheme:
 *   GET /repos/:did/:repo                          Repository info
 *   GET /repos/:did/:repo/issues                   List issues
 *   GET /repos/:did/:repo/issues/:number           Issue detail
 *   GET /repos/:did/:repo/issues/:number/comments  Issue comments
 *   GET /repos/:did/:repo/pulls                    List pull requests
 *   GET /repos/:did/:repo/pulls/:number            Pull request detail
 *   GET /repos/:did/:repo/pulls/:number/reviews    Pull request reviews
 *   GET /repos/:did/:repo/releases                 List releases
 *   GET /repos/:did/:repo/releases/tags/:tag       Release by tag
 *   GET /users/:did                                User profile
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { handleGetRepo } from './repos.js';
import { handleGetUser } from './users.js';

import { baseHeaders, jsonNotFound } from './helpers.js';
import { handleGetIssue, handleListIssueComments, handleListIssues } from './issues.js';
import { handleGetPull, handleListPullReviews, handleListPulls } from './pulls.js';
import { handleGetReleaseByTag, handleListReleases } from './releases.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShimServerOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// DID extraction regex
// ---------------------------------------------------------------------------

/**
 * DID methods use the pattern `did:<method>:<id>`.  We capture the full
 * DID and the remaining path segments.
 */
const REPOS_RE = /^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([^/]+)(\/.*)?$/;
const USERS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route an incoming request to the appropriate handler.
 *
 * This function is exported for testing — tests can call it directly
 * with a constructed URL without starting an HTTP server.
 */
export async function handleShimRequest(
  ctx: AgentContext,
  url: URL,
): Promise<JsonResponse> {
  const path = url.pathname;

  // -------------------------------------------------------------------------
  // GET /users/:did
  // -------------------------------------------------------------------------
  const userMatch = path.match(USERS_RE);
  if (userMatch) {
    return handleGetUser(userMatch[1], url);
  }

  // -------------------------------------------------------------------------
  // GET /repos/:did/:repo/...
  // -------------------------------------------------------------------------
  const repoMatch = path.match(REPOS_RE);
  if (!repoMatch) {
    return jsonNotFound('Not found');
  }

  const targetDid = repoMatch[1];
  const repoName = repoMatch[2];
  const rest = repoMatch[3] ?? '';

  // Try/catch — DID resolution failures should return 502.
  try {
    return await dispatchRepoRoute(ctx, targetDid, repoName, rest, url);
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    return {
      status  : 502,
      headers : baseHeaders(),
      body    : JSON.stringify({ message: `DWN error: ${msg}` }),
    };
  }
}

/**
 * Dispatch to the correct handler within the `/repos/:did/:repo/...`
 * namespace.
 */
async function dispatchRepoRoute(
  ctx: AgentContext, targetDid: string, repoName: string, rest: string, url: URL,
): Promise<JsonResponse> {
  // GET /repos/:did/:repo
  if (rest === '' || rest === '/') {
    return handleGetRepo(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/issues
  if (rest === '/issues') {
    return handleListIssues(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/pulls
  if (rest === '/pulls') {
    return handleListPulls(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/releases
  if (rest === '/releases') {
    return handleListReleases(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/releases/tags/:tag
  const releaseTagMatch = rest.match(/^\/releases\/tags\/(.+)$/);
  if (releaseTagMatch) {
    return handleGetReleaseByTag(ctx, targetDid, repoName, releaseTagMatch[1], url);
  }

  // GET /repos/:did/:repo/issues/:number/comments
  const issueCommentsMatch = rest.match(/^\/issues\/(\d+)\/comments$/);
  if (issueCommentsMatch) {
    return handleListIssueComments(ctx, targetDid, repoName, issueCommentsMatch[1], url);
  }

  // GET /repos/:did/:repo/issues/:number
  const issueMatch = rest.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    return handleGetIssue(ctx, targetDid, repoName, issueMatch[1], url);
  }

  // GET /repos/:did/:repo/pulls/:number/reviews
  const pullReviewsMatch = rest.match(/^\/pulls\/(\d+)\/reviews$/);
  if (pullReviewsMatch) {
    return handleListPullReviews(ctx, targetDid, repoName, pullReviewsMatch[1], url);
  }

  // GET /repos/:did/:repo/pulls/:number
  const pullMatch = rest.match(/^\/pulls\/(\d+)$/);
  if (pullMatch) {
    return handleGetPull(ctx, targetDid, repoName, pullMatch[1], url);
  }

  return jsonNotFound('Not found');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the GitHub API shim server. Returns the server instance. */
export function startShimServer(options: ShimServerOptions): Server {
  const { ctx, port } = options;

  const server = createServer(async (req, res) => {
    // Handle CORS preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : 'GET, OPTIONS',
        'Access-Control-Allow-Headers' : 'Authorization, Accept, Content-Type',
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    // Only support GET.
    if (req.method !== 'GET') {
      res.writeHead(405, baseHeaders());
      res.end(JSON.stringify({ message: 'Method not allowed. This shim is read-only (Phase 1).' }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = await handleShimRequest(ctx, url);

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error(`[github-shim] Error: ${(err as Error).message}`);
      res.writeHead(500, baseHeaders());
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    console.log(`[github-shim] GitHub API compatibility shim running at http://localhost:${port}`);
    console.log('[github-shim] Phase 1: read-only endpoints');
    console.log('[github-shim] Endpoints:');
    console.log('  GET /repos/:did/:repo                  Repository info');
    console.log('  GET /repos/:did/:repo/issues           List issues');
    console.log('  GET /repos/:did/:repo/issues/:number   Issue detail');
    console.log('  GET /repos/:did/:repo/issues/:n/comments  Issue comments');
    console.log('  GET /repos/:did/:repo/pulls            List pull requests');
    console.log('  GET /repos/:did/:repo/pulls/:number    Pull request detail');
    console.log('  GET /repos/:did/:repo/pulls/:n/reviews Pull request reviews');
    console.log('  GET /repos/:did/:repo/releases         List releases');
    console.log('  GET /repos/:did/:repo/releases/tags/:t Release by tag');
    console.log('  GET /users/:did                        User profile');
    console.log('');
  });

  return server;
}
