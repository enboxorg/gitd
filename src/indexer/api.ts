/**
 * Indexer REST API — serves JSON responses from the materialized views
 * in the IndexerStore.
 *
 * Endpoints:
 *
 *   GET /api/repos                   List all repos (sorted by stars)
 *   GET /api/repos/search?q=<query>  Search repos by name/topic/language
 *   GET /api/repos/trending          Trending repos (recent star activity)
 *   GET /api/repos/:did              Repo detail for a specific DID
 *   GET /api/repos/:did/stars        Stars for a specific repo
 *   GET /api/users/:did              User profile summary
 *   GET /api/stats                   Indexer statistics
 *
 * All responses are JSON with `Content-Type: application/json`.
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import type { IndexerStore } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiServerOptions = {
  store : IndexerStore;
  port : number;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Route an incoming request to the appropriate API handler. */
export function handleApiRequest(
  store: IndexerStore,
  url: URL,
): { status: number; body: string } {
  const path = url.pathname;

  // GET /api/stats
  if (path === '/api/stats') {
    return json(200, store.getStats());
  }

  // GET /api/repos/search?q=<query>
  if (path === '/api/repos/search') {
    const q = url.searchParams.get('q') ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    if (!q) {
      return json(400, { error: 'Missing query parameter: q' });
    }
    return json(200, store.search(q, limit));
  }

  // GET /api/repos/trending
  if (path === '/api/repos/trending') {
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const days = parseInt(url.searchParams.get('days') ?? '7', 10);
    return json(200, store.getTrending(limit, days * 24 * 60 * 60 * 1000));
  }

  // GET /api/repos (list all)
  if (path === '/api/repos') {
    const language = url.searchParams.get('language');
    const topic = url.searchParams.get('topic');
    if (language) {
      return json(200, store.getReposByLanguage(language));
    }
    if (topic) {
      return json(200, store.getReposByTopic(topic));
    }
    return json(200, store.getReposWithStars());
  }

  // GET /api/repos/:did/stars
  const starsMatch = path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/stars$/);
  if (starsMatch) {
    const did = starsMatch[1];
    const repo = store.getRepo(did);
    if (!repo) { return json(404, { error: 'Repo not found' }); }
    return json(200, {
      starCount : store.getStarCount(repo.did, repo.recordId),
      stars     : store.getStarsForRepo(repo.did, repo.recordId),
    });
  }

  // GET /api/repos/:did
  const repoMatch = path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/);
  if (repoMatch) {
    const did = repoMatch[1];
    const repo = store.getRepo(did);
    if (!repo) { return json(404, { error: 'Repo not found' }); }
    return json(200, {
      ...repo,
      starCount: store.getStarCount(repo.did, repo.recordId),
    });
  }

  // GET /api/users/:did
  const userMatch = path.match(/^\/api\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/);
  if (userMatch) {
    const did = userMatch[1];
    return json(200, store.getUserProfile(did));
  }

  return json(404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the indexer API server. */
export function startApiServer(options: ApiServerOptions): Server {
  const { store, port } = options;

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = handleApiRequest(store, url);

      res.writeHead(result.status, {
        'Content-Type'                : 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin' : '*',
      });
      res.end(result.body);
    } catch (err) {
      console.error(`[indexer-api] Error: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    console.log(`[indexer-api] Listening on http://localhost:${port}`);
    console.log('[indexer-api] Endpoints:');
    console.log('  GET /api/repos                  List all repos');
    console.log('  GET /api/repos/search?q=<query> Search repos');
    console.log('  GET /api/repos/trending          Trending repos');
    console.log('  GET /api/repos/:did              Repo detail');
    console.log('  GET /api/repos/:did/stars         Star list');
    console.log('  GET /api/users/:did              User profile');
    console.log('  GET /api/stats                   Indexer stats');
    console.log('');
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(status: number, data: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(data) };
}
