/**
 * Indexer module — crawls DWN records and serves aggregated views.
 *
 * @module
 */

export { handleApiRequest, startApiServer } from './api.js';
export type { ApiServerOptions } from './api.js';
export { handleExploreRequest } from './explore.js';
export type { ExploreResponse } from './explore.js';

export { IndexerCrawler } from './crawler.js';
export type { CrawlOptions, CrawlResult } from './crawler.js';

export { IndexerStore } from './store.js';
export type {
  CrawlCursor,
  IndexedFollow,
  IndexedIssue,
  IndexedPatch,
  IndexedRelease,
  IndexedRepo,
  IndexedStar,
  IndexerStats,
  RepoWithStars,
  SearchResult,
  StarredRepo,
  UserSearchResult,
  UserProfile,
} from './store.js';
