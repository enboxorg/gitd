/**
 * Indexer REST API — serves JSON responses from the materialized views
 * in the IndexerStore.
 *
 * Endpoints:
 *
 *   GET /api/repos                   List all repos (sorted by stars)
 *   GET /api/repos/search?q=<query>  Search repos by name/topic/language
 *   GET /api/repos/trending          Trending repos (recent star activity)
 *   GET /api/repos/:did              First repo detail for a DID (compatibility)
 *   GET /api/repos/:did/stars        Stars for the first repo for a DID (compatibility)
 *   GET /api/repos/:did/:repo        Repo detail for a specific DID/repo
 *   GET /api/repos/:did/:repo/issues Issue summaries for a specific DID/repo
 *   GET /api/repos/:did/:repo/issues/:recordId Issue detail for a specific DID/repo
 *   GET /api/repos/:did/:repo/patches Patch summaries for a specific DID/repo
 *   GET /api/repos/:did/:repo/patches/:recordId Patch detail for a specific DID/repo
 *   GET /api/repos/:did/:repo/releases Release summaries for a specific DID/repo
 *   GET /api/repos/:did/:repo/releases/:recordId Release detail for a specific DID/repo
 *   GET /api/repos/:did/:repo/submissions/issues External issue submissions for a specific DID/repo
 *   GET /api/repos/:did/:repo/submissions/issues/:recordId External issue submission detail
 *   GET /api/repos/:did/:repo/submissions/patches External patch submissions for a specific DID/repo
 *   GET /api/repos/:did/:repo/submissions/patches/:recordId External patch submission detail
 *   GET /api/repos/:did/:repo/stars  Stars for a specific DID/repo
 *   GET /api/users/:did              User profile summary
 *   GET /api/users/:did/repos        Repos owned by a DID
 *   GET /api/users/:did/starred      Repos starred by a DID
 *   GET /api/users/:did/followers    DIDs following a DID
 *   GET /api/users/:did/following    DIDs followed by a DID
 *   GET /api/users/search?q=<query>  Search indexed DIDs
 *   GET /api/stats                   Indexer statistics
 *
 * All responses are JSON with `Content-Type: application/json`.
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { handleExploreRequest } from './explore.js';

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

  // GET /api/repos/:did/:repo/(issues|patches|releases)/:recordId
  const namedRepoItemMatch = path.match(
    /^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/(issues|patches|releases)\/([^/]+)$/,
  );
  if (namedRepoItemMatch) {
    const did = namedRepoItemMatch[1];
    const name = decodeURIComponent(namedRepoItemMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }

    const collection = namedRepoItemMatch[3];
    const recordId = decodeURIComponent(namedRepoItemMatch[4]);
    if (collection === 'issues') {
      const issue = store.getIssueByRecord(repo.did, repo.recordId, recordId);
      return issue ? json(200, issue) : json(404, { error: 'Issue not found' });
    }
    if (collection === 'patches') {
      const patch = store.getPatchByRecord(repo.did, repo.recordId, recordId);
      return patch ? json(200, patch) : json(404, { error: 'Patch not found' });
    }
    const release = store.getReleaseByRecord(repo.did, repo.recordId, recordId);
    return release ? json(200, release) : json(404, { error: 'Release not found' });
  }

  // GET /api/repos/:did/:repo/(issues|patches|releases)
  const namedRepoItemsMatch =
    path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/(issues|patches|releases)$/);
  if (namedRepoItemsMatch) {
    const did = namedRepoItemsMatch[1];
    const name = decodeURIComponent(namedRepoItemsMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }

    const collection = namedRepoItemsMatch[3];
    if (collection === 'issues') {
      return json(200, store.getIssuesForRepo(repo.did, repo.recordId));
    }
    if (collection === 'patches') {
      return json(200, store.getPatchesForRepo(repo.did, repo.recordId));
    }
    return json(200, store.getReleasesForRepo(repo.did, repo.recordId));
  }

  // GET /api/repos/:did/:repo/submissions/(issues|patches)/:recordId
  const submissionItemMatch = path.match(
    /^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/submissions\/(issues|patches)\/([^/]+)$/,
  );
  if (submissionItemMatch) {
    const did = submissionItemMatch[1];
    const name = decodeURIComponent(submissionItemMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }

    const collection = submissionItemMatch[3];
    const recordId = decodeURIComponent(submissionItemMatch[4]);
    if (collection === 'issues') {
      const submission = store.getIssueSubmissionByRecord(repo.did, repo.recordId, recordId);
      return submission ? json(200, submission) : json(404, { error: 'Issue submission not found' });
    }
    const submission = store.getPatchSubmissionByRecord(repo.did, repo.recordId, recordId);
    return submission ? json(200, submission) : json(404, { error: 'Patch submission not found' });
  }

  // GET /api/repos/:did/:repo/submissions/(issues|patches)
  const submissionMatch =
    path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/submissions\/(issues|patches)$/);
  if (submissionMatch) {
    const did = submissionMatch[1];
    const name = decodeURIComponent(submissionMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }

    const collection = submissionMatch[3];
    if (collection === 'issues') {
      return json(200, store.getIssueSubmissionsForRepo(repo.did, repo.recordId));
    }
    return json(200, store.getPatchSubmissionsForRepo(repo.did, repo.recordId));
  }

  // GET /api/repos/:did/:repo/stars
  const namedStarsMatch = path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/stars$/);
  if (namedStarsMatch) {
    const did = namedStarsMatch[1];
    const name = decodeURIComponent(namedStarsMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }
    return json(200, {
      repo,
      starCount : store.getStarCount(repo.did, repo.recordId),
      stars     : store.getStarsForRepo(repo.did, repo.recordId),
    });
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

  // GET /api/repos/:did/:repo
  const namedRepoMatch = path.match(/^\/api\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)$/);
  if (namedRepoMatch) {
    const did = namedRepoMatch[1];
    const name = decodeURIComponent(namedRepoMatch[2]);
    const repo = store.getRepoByName(did, name);
    if (!repo) { return json(404, { error: 'Repo not found' }); }
    return json(200, {
      ...repo,
      starCount: store.getStarCount(repo.did, repo.recordId),
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

  // GET /api/users/search?q=<query>
  if (path === '/api/users/search') {
    const q = url.searchParams.get('q') ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    if (!q) {
      return json(400, { error: 'Missing query parameter: q' });
    }
    return json(200, store.searchUsers(q, limit));
  }

  // GET /api/users/:did/repos
  const userReposMatch = path.match(/^\/api\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/repos$/);
  if (userReposMatch) {
    const did = userReposMatch[1];
    return json(200, store.getReposForDid(did));
  }

  // GET /api/users/:did/starred
  const userStarredMatch = path.match(/^\/api\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/starred$/);
  if (userStarredMatch) {
    const did = userStarredMatch[1];
    return json(200, store.getStarredReposByUser(did));
  }

  // GET /api/users/:did/followers
  const userFollowersMatch = path.match(/^\/api\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/followers$/);
  if (userFollowersMatch) {
    const did = userFollowersMatch[1];
    return json(200, store.getFollowersForUser(did));
  }

  // GET /api/users/:did/following
  const userFollowingMatch = path.match(/^\/api\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/following$/);
  if (userFollowingMatch) {
    const did = userFollowingMatch[1];
    return json(200, store.getFollowingForUser(did));
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
      if (!url.pathname.startsWith('/api/')) {
        const result = handleExploreRequest(store, url);
        res.writeHead(result.status, {
          'Content-Type'                : 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin' : '*',
        });
        res.end(result.body);
        return;
      }

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
    console.log('[indexer-api] Explore:');
    console.log('  GET /                           Browse indexed repos and users');
    console.log('  GET /repos                      Repository search and listing');
    console.log('  GET /users                      User search and listing');
    console.log('[indexer-api] Endpoints:');
    console.log('  GET /api/repos                  List all repos');
    console.log('  GET /api/repos/search?q=<query> Search repos');
    console.log('  GET /api/repos/trending          Trending repos');
    console.log('  GET /api/repos/:did/:repo         Repo detail');
    console.log('  GET /api/repos/:did/:repo/issues  Repo issue summaries');
    console.log('  GET /api/repos/:did/:repo/issues/:id Issue detail');
    console.log('  GET /api/repos/:did/:repo/patches Repo patch summaries');
    console.log('  GET /api/repos/:did/:repo/patches/:id Patch detail');
    console.log('  GET /api/repos/:did/:repo/releases Repo release summaries');
    console.log('  GET /api/repos/:did/:repo/releases/:id Release detail');
    console.log('  GET /api/repos/:did/:repo/submissions/issues External issue submissions');
    console.log('  GET /api/repos/:did/:repo/submissions/issues/:id External issue submission detail');
    console.log('  GET /api/repos/:did/:repo/submissions/patches External patch submissions');
    console.log('  GET /api/repos/:did/:repo/submissions/patches/:id External patch submission detail');
    console.log('  GET /api/repos/:did/:repo/stars   Star list');
    console.log('  GET /api/repos/:did              First repo detail (compat)');
    console.log('  GET /api/repos/:did/stars         First repo stars (compat)');
    console.log('  GET /api/users/:did              User profile');
    console.log('  GET /api/users/:did/repos         User repositories');
    console.log('  GET /api/users/:did/starred       User starred repos');
    console.log('  GET /api/users/:did/followers     User followers');
    console.log('  GET /api/users/:did/following     User following');
    console.log('  GET /api/users/search?q=<query>   Search users');
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
