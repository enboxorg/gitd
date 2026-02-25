/**
 * GitHub API compatibility shim — HTTP server and router.
 *
 * Translates GitHub REST API v3 requests into DWN queries / writes and
 * returns GitHub-compatible JSON responses.  This allows existing tools
 * that speak the GitHub API (VS Code extensions, `gh` CLI, CI/CD
 * systems) to interact with any DWN-enabled git forge.
 *
 * Read endpoints (GET):
 *   GET  /repos/:did/:repo                          Repository info
 *   GET  /repos/:did/:repo/issues                   List issues
 *   GET  /repos/:did/:repo/issues/:number           Issue detail
 *   GET  /repos/:did/:repo/issues/:number/comments  Issue comments
 *   GET  /repos/:did/:repo/pulls                    List pull requests
 *   GET  /repos/:did/:repo/pulls/:number            Pull request detail
 *   GET  /repos/:did/:repo/pulls/:number/reviews    Pull request reviews
 *   GET  /repos/:did/:repo/releases                 List releases
 *   GET  /repos/:did/:repo/releases/tags/:tag       Release by tag
 *   GET  /users/:did                                User profile
 *
 * Write endpoints (POST/PATCH/PUT):
 *   POST  /repos/:did/:repo/issues                    Create issue
 *   PATCH /repos/:did/:repo/issues/:number            Update issue
 *   POST  /repos/:did/:repo/issues/:number/comments   Create issue comment
 *   POST  /repos/:did/:repo/pulls                     Create pull request
 *   PATCH /repos/:did/:repo/pulls/:number             Update pull request
 *   PUT   /repos/:did/:repo/pulls/:number/merge       Merge pull request
 *   POST  /repos/:did/:repo/pulls/:number/reviews     Create pull review
 *   POST  /repos/:did/:repo/releases                  Create release
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { handleGetRepo } from './repos.js';
import { handleGetUser } from './users.js';

import { baseHeaders, jsonMethodNotAllowed, jsonNotFound, jsonUnauthorized, validateBearerToken } from './helpers.js';
import { handleCreateIssue, handleCreateIssueComment, handleGetIssue, handleListIssueComments, handleListIssues, handleUpdateIssue } from './issues.js';
import { handleCreatePull, handleCreatePullReview, handleGetPull, handleListPullReviews, handleListPulls, handleMergePull, handleUpdatePull } from './pulls.js';
import { handleCreateRelease, handleGetReleaseByTag, handleListReleases } from './releases.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShimServerOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// Supported HTTP methods
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);

/** Maximum JSON request body size (1 MB). */
const MAX_JSON_BODY = 1 * 1024 * 1024;

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
 *
 * @param method  HTTP method (defaults to `'GET'` for backward compat).
 * @param reqBody Parsed JSON body for POST/PATCH/PUT requests.
 * @param authHeader The Authorization header value (for write endpoint auth).
 */
export async function handleShimRequest(
  ctx: AgentContext,
  url: URL,
  method: string = 'GET',
  reqBody: Record<string, unknown> = {},
  authHeader: string | null = null,
): Promise<JsonResponse> {
  // Authenticate mutating requests when DWN_GIT_API_TOKEN is configured.
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (!validateBearerToken(authHeader)) {
      return jsonUnauthorized('Valid Bearer token required for write operations.');
    }
  }
  const path = url.pathname;

  // -------------------------------------------------------------------------
  // GET /users/:did
  // -------------------------------------------------------------------------
  const userMatch = path.match(USERS_RE);
  if (userMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users endpoints.`);
    }
    return handleGetUser(userMatch[1], url);
  }

  // -------------------------------------------------------------------------
  // /repos/:did/:repo/...
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
    return await dispatchRepoRoute(ctx, targetDid, repoName, rest, url, method, reqBody);
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
 * namespace.  Considers both the URL path and the HTTP method.
 */
async function dispatchRepoRoute(
  ctx: AgentContext, targetDid: string, repoName: string,
  rest: string, url: URL, method: string, reqBody: Record<string, unknown>,
): Promise<JsonResponse> {
  // GET /repos/:did/:repo
  if (rest === '' || rest === '/') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /repos/:did/:repo.`); }
    return handleGetRepo(ctx, targetDid, repoName, url);
  }

  // /repos/:did/:repo/issues[/...]
  if (rest === '/issues') {
    if (method === 'POST') { return handleCreateIssue(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'GET') { return handleListIssues(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues.`);
  }

  // /repos/:did/:repo/pulls[/...]
  if (rest === '/pulls') {
    if (method === 'POST') { return handleCreatePull(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'GET') { return handleListPulls(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls.`);
  }

  // /repos/:did/:repo/releases
  if (rest === '/releases') {
    if (method === 'POST') { return handleCreateRelease(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'GET') { return handleListReleases(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /releases.`);
  }

  // GET /repos/:did/:repo/releases/tags/:tag
  const releaseTagMatch = rest.match(/^\/releases\/tags\/(.+)$/);
  if (releaseTagMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /releases/tags/:tag.`); }
    return handleGetReleaseByTag(ctx, targetDid, repoName, releaseTagMatch[1], url);
  }

  // /repos/:did/:repo/issues/:number/comments
  const issueCommentsMatch = rest.match(/^\/issues\/(\d+)\/comments$/);
  if (issueCommentsMatch) {
    if (method === 'POST') { return handleCreateIssueComment(ctx, targetDid, repoName, issueCommentsMatch[1], reqBody, url); }
    if (method === 'GET') { return handleListIssueComments(ctx, targetDid, repoName, issueCommentsMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/comments.`);
  }

  // /repos/:did/:repo/issues/:number
  const issueMatch = rest.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    if (method === 'PATCH') { return handleUpdateIssue(ctx, targetDid, repoName, issueMatch[1], reqBody, url); }
    if (method === 'GET') { return handleGetIssue(ctx, targetDid, repoName, issueMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number.`);
  }

  // /repos/:did/:repo/pulls/:number/merge
  const pullMergeMatch = rest.match(/^\/pulls\/(\d+)\/merge$/);
  if (pullMergeMatch) {
    if (method === 'PUT') { return handleMergePull(ctx, targetDid, repoName, pullMergeMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/merge.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews
  const pullReviewsMatch = rest.match(/^\/pulls\/(\d+)\/reviews$/);
  if (pullReviewsMatch) {
    if (method === 'POST') { return handleCreatePullReview(ctx, targetDid, repoName, pullReviewsMatch[1], reqBody, url); }
    if (method === 'GET') { return handleListPullReviews(ctx, targetDid, repoName, pullReviewsMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews.`);
  }

  // /repos/:did/:repo/pulls/:number
  const pullMatch = rest.match(/^\/pulls\/(\d+)$/);
  if (pullMatch) {
    if (method === 'PATCH') { return handleUpdatePull(ctx, targetDid, repoName, pullMatch[1], reqBody, url); }
    if (method === 'GET') { return handleGetPull(ctx, targetDid, repoName, pullMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number.`);
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
    const method = req.method ?? 'GET';

    // Health check endpoint.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'github-api' }));
      return;
    }

    // Handle CORS preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers' : 'Authorization, Accept, Content-Type',
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    // Reject unsupported methods.
    if (!ALLOWED_METHODS.has(method)) {
      res.writeHead(405, baseHeaders());
      res.end(JSON.stringify({ message: `Method ${method} is not supported.` }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // Parse request body for mutating methods (with size limit).
      let reqBody: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        let tooLarge = false;
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalSize += buf.length;
          if (totalSize > MAX_JSON_BODY) { tooLarge = true; break; }
          chunks.push(buf);
        }
        if (tooLarge) {
          res.writeHead(413, baseHeaders());
          res.end(JSON.stringify({ message: 'Payload Too Large' }));
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw.length > 0) {
          try {
            reqBody = JSON.parse(raw);
          } catch {
            res.writeHead(400, baseHeaders());
            res.end(JSON.stringify({ message: 'Invalid JSON in request body.' }));
            return;
          }
        }
      }

      const authHeader = req.headers.authorization ?? null;
      const result = await handleShimRequest(ctx, url, method, reqBody, authHeader);

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
    console.log('[github-shim] Read endpoints (GET):');
    console.log('  GET  /repos/:did/:repo                  Repository info');
    console.log('  GET  /repos/:did/:repo/issues           List issues');
    console.log('  GET  /repos/:did/:repo/issues/:number   Issue detail');
    console.log('  GET  /repos/:did/:repo/issues/:n/comments  Issue comments');
    console.log('  GET  /repos/:did/:repo/pulls            List pull requests');
    console.log('  GET  /repos/:did/:repo/pulls/:number    Pull request detail');
    console.log('  GET  /repos/:did/:repo/pulls/:n/reviews Pull request reviews');
    console.log('  GET  /repos/:did/:repo/releases         List releases');
    console.log('  GET  /repos/:did/:repo/releases/tags/:t Release by tag');
    console.log('  GET  /users/:did                        User profile');
    console.log('[github-shim] Write endpoints (POST/PATCH/PUT):');
    console.log('  POST  /repos/:did/:repo/issues            Create issue');
    console.log('  PATCH /repos/:did/:repo/issues/:number    Update issue');
    console.log('  POST  /repos/:did/:repo/issues/:n/comments  Create comment');
    console.log('  POST  /repos/:did/:repo/pulls             Create pull request');
    console.log('  PATCH /repos/:did/:repo/pulls/:number     Update pull request');
    console.log('  PUT   /repos/:did/:repo/pulls/:n/merge    Merge pull request');
    console.log('  POST  /repos/:did/:repo/pulls/:n/reviews  Create review');
    console.log('  POST  /repos/:did/:repo/releases          Create release');
    console.log('');
  });

  return server;
}
