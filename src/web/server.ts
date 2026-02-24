/**
 * Read-only web UI server for dwn-git.
 *
 * Serves HTML pages rendered from DWN records.  No client-side JavaScript,
 * no build step — pure server-rendered HTML.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { Server } from 'node:http';

import { createServer } from 'node:http';

import {
  issueDetailPage,
  issuesListPage,
  overviewPage,
  patchDetailPage,
  patchesListPage,
  releasesListPage,
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
// Router
// ---------------------------------------------------------------------------

/** Route an incoming request to the appropriate page handler. */
export async function handleRequest(ctx: AgentContext, url: URL): Promise<{ status: number; body: string }> {
  const path = url.pathname;

  // Static route matching.
  if (path === '/' || path === '') {
    return { status: 200, body: await overviewPage(ctx) };
  }

  if (path === '/issues') {
    return { status: 200, body: await issuesListPage(ctx) };
  }

  if (path === '/patches') {
    return { status: 200, body: await patchesListPage(ctx) };
  }

  if (path === '/releases') {
    return { status: 200, body: await releasesListPage(ctx) };
  }

  if (path === '/wiki') {
    return { status: 200, body: await wikiListPage(ctx) };
  }

  // Dynamic route matching.
  const issueMatch = path.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    const html = await issueDetailPage(ctx, issueMatch[1]);
    if (html) { return { status: 200, body: html }; }
    return { status: 404, body: notFound('Issue not found') };
  }

  const patchMatch = path.match(/^\/patches\/(\d+)$/);
  if (patchMatch) {
    const html = await patchDetailPage(ctx, patchMatch[1]);
    if (html) { return { status: 200, body: html }; }
    return { status: 404, body: notFound('Patch not found') };
  }

  const wikiMatch = path.match(/^\/wiki\/([a-zA-Z0-9_-]+)$/);
  if (wikiMatch) {
    const html = await wikiDetailPage(ctx, wikiMatch[1]);
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
    console.log('Press Ctrl+C to stop.\n');
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFound(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>${message}</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f8fa}
.msg{text-align:center}h1{color:#24292f}a{color:#0969da}</style></head>
<body><div class="msg"><h1>${message}</h1><p><a href="/">Go to overview</a></p></div></body></html>`;
}
