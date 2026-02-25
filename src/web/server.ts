/**
 * Read-only web UI server for gitd.
 *
 * Serves HTML pages rendered from DWN records.  Supports viewing ANY
 * DWN-enabled git repo — the target DID is extracted from the URL path:
 *
 *   GET /                              Landing page (browse any DID)
 *   GET /:did                          Repo list for that DID
 *   GET /:did/:repo                    Repo overview
 *   GET /:did/:repo/issues             Issues list
 *   GET /:did/:repo/issues/:number     Issue detail
 *   GET /:did/:repo/patches            Patches list
 *   GET /:did/:repo/patches/:number    Patch detail
 *   GET /:did/:repo/releases           Releases list
 *   GET /:did/:repo/wiki               Wiki list
 *   GET /:did/:repo/wiki/:slug         Wiki page detail
 *
 * When `targetDid` differs from the local agent's DID, every query
 * passes `from: targetDid` so the SDK routes the request to the remote
 * DWN endpoint resolved from the target's DID document.
 *
 * No client-side JavaScript, no build step — pure server-rendered HTML.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { esc } from './html.js';
import {
  issueDetailPage,
  issuesListPage,
  overviewPage,
  patchDetailPage,
  patchesListPage,
  releasesListPage,
  repoListPage,
  wikiDetailPage,
  wikiListPage,
} from './routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebServerOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// DID extraction
// ---------------------------------------------------------------------------

/**
 * DID methods use the pattern `did:<method>:<id>`.  The method and id
 * segments may contain alphanumerics, dots, dashes, underscores, and
 * percent-encoded characters.  We capture everything up to the next `/`
 * or end of string.
 */
const DID_PREFIX_RE = /^\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)(\/.*)?$/;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Route an incoming request to the appropriate page handler. */
export async function handleRequest(
  ctx: AgentContext,
  url: URL,
): Promise<{ status: number; body: string }> {
  const path = url.pathname;

  // Root landing page — browse any DID.
  if (path === '/' || path === '') {
    return { status: 200, body: landingPage(ctx.did) };
  }

  // Extract the target DID from the URL.
  const didMatch = path.match(DID_PREFIX_RE);
  if (!didMatch) {
    return { status: 404, body: notFound('Page not found') };
  }

  const targetDid = didMatch[1];
  const rest = didMatch[2] ?? '/';
  const didBasePath = `/${targetDid}`;

  // Wrap route dispatch in try/catch — DID resolution failures (invalid
  // or unreachable DIDs) are surfaced as a friendly error page rather
  // than crashing the server.
  try {
    return await dispatchRoute(ctx, targetDid, didBasePath, rest);
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    return { status: 502, body: didError(targetDid, msg) };
  }
}

/**
 * Dispatch to the correct route handler.
 *
 * URL structure: `/:did` lists repos, `/:did/:repo/...` targets a specific repo.
 */
async function dispatchRoute(
  ctx: AgentContext, targetDid: string, didBasePath: string, rest: string,
): Promise<{ status: number; body: string }> {
  // /:did — list all repos for this DID.
  if (rest === '/' || rest === '') {
    return { status: 200, body: await repoListPage(ctx, targetDid, didBasePath) };
  }

  // Extract repo name as the first segment after the DID.
  const repoMatch = rest.match(/^\/([a-zA-Z0-9._-]+)(\/.*)?$/);
  if (!repoMatch) {
    return { status: 404, body: notFound('Page not found') };
  }

  const repoName = repoMatch[1];
  const repoRest = repoMatch[2] ?? '/';
  const basePath = `${didBasePath}/${repoName}`;

  // /:did/:repo — repo overview.
  if (repoRest === '/' || repoRest === '') {
    return { status: 200, body: await overviewPage(ctx, targetDid, repoName, basePath) };
  }

  if (repoRest === '/issues') {
    return { status: 200, body: await issuesListPage(ctx, targetDid, repoName, basePath) };
  }

  if (repoRest === '/patches') {
    return { status: 200, body: await patchesListPage(ctx, targetDid, repoName, basePath) };
  }

  if (repoRest === '/releases') {
    return { status: 200, body: await releasesListPage(ctx, targetDid, repoName, basePath) };
  }

  if (repoRest === '/wiki') {
    return { status: 200, body: await wikiListPage(ctx, targetDid, repoName, basePath) };
  }

  // Dynamic route matching.
  const issueMatch2 = repoRest.match(/^\/issues\/(\d+)$/);
  if (issueMatch2) {
    const html = await issueDetailPage(ctx, targetDid, repoName, basePath, issueMatch2[1]);
    if (html) { return { status: 200, body: html }; }
    return { status: 404, body: notFound('Issue not found') };
  }

  const patchMatch2 = repoRest.match(/^\/patches\/(\d+)$/);
  if (patchMatch2) {
    const html = await patchDetailPage(ctx, targetDid, repoName, basePath, patchMatch2[1]);
    if (html) { return { status: 200, body: html }; }
    return { status: 404, body: notFound('Patch not found') };
  }

  const wikiMatch2 = repoRest.match(/^\/wiki\/([a-zA-Z0-9_-]+)$/);
  if (wikiMatch2) {
    const html = await wikiDetailPage(ctx, targetDid, repoName, basePath, wikiMatch2[1]);
    if (html) { return { status: 200, body: html }; }
    return { status: 404, body: notFound('Wiki page not found') };
  }

  return { status: 404, body: notFound('Page not found') };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the web UI server. Returns the server instance. */
export function startWebServer(options: WebServerOptions): Server {
  const { ctx, port } = options;

  const server = createServer(async (req, res) => {
    // Health check endpoint.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'web-ui' }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = await handleRequest(ctx, url);
      res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.body);
    } catch (err) {
      console.error(`Web UI error: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFound('Internal server error'));
    }
  });

  server.listen(port, () => {
    console.log(`Web UI running at http://localhost:${port}`);
    console.log(`\nBrowse your own repo:  http://localhost:${port}/${ctx.did}`);
    console.log('Browse any DWN repo:   http://localhost:' + `${port}/<did>`);
    console.log('\nPress Ctrl+C to stop.\n');
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function didError(targetDid: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><title>DID Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f8fa}
.msg{text-align:center;max-width:600px}h1{color:#24292f}p{color:#57606a}code{background:#f0f0f0;padding:2px 6px;border-radius:4px}
a{color:#0969da}</style></head>
<body><div class="msg"><h1>Cannot reach DWN</h1>
<p>Could not resolve or connect to <code>${esc(targetDid)}</code>.</p>
<p style="font-size:0.9em">${esc(message)}</p>
<p><a href="/">Go to home</a></p></div></body></html>`;
}

function notFound(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>${esc(message)}</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f8fa}
.msg{text-align:center}h1{color:#24292f}a{color:#0969da}</style></head>
<body><div class="msg"><h1>${esc(message)}</h1><p><a href="/">Go to home</a></p></div></body></html>`;
}

function landingPage(localDid: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>gitd — Decentralized Code Forge</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6; color: #24292f; margin: 0; padding: 0; background: #f6f8fa; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 640px; margin: 80px auto; padding: 0 16px; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 24px; margin-bottom: 16px; }
    h1 { margin-top: 0; }
    .meta { color: #57606a; font-size: 0.9em; }
    input[type=text] { width: 100%; padding: 10px 14px; font-size: 1em; border: 1px solid #d0d7de;
      border-radius: 6px; font-family: monospace; margin-bottom: 12px; }
    button { background: #2da44e; color: #fff; border: none; padding: 10px 20px; font-size: 1em;
      border-radius: 6px; cursor: pointer; }
    button:hover { background: #218838; }
    .or { text-align: center; color: #57606a; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>gitd</h1>
      <p>Browse any DWN-enabled git repository by entering a DID below.</p>
      <form onsubmit="location.href='/'+document.getElementById('did').value;return false">
        <input type="text" id="did" placeholder="did:dht:..." autocomplete="off">
        <button type="submit">Browse</button>
      </form>
    </div>
    <div class="or">&mdash; or &mdash;</div>
    <div class="card">
      <p>Browse the local agent's repository:</p>
      <p><a href="/${esc(localDid)}"><code>${esc(localDid)}</code></a></p>
    </div>
  </div>
</body>
</html>`;
}
