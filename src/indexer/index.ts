/**
 * Indexer module — crawls DWN records and serves aggregated views.
 *
 * @module
 */

export { handleApiRequest, startApiServer } from './api.js';
export type { ApiServerOptions } from './api.js';

export { IndexerCrawler } from './crawler.js';
export type { CrawlOptions, CrawlResult } from './crawler.js';

export { IndexerStore } from './store.js';
export type {
  CrawlCursor,
  IndexedFollow,
  IndexedRepo,
  IndexedStar,
  RepoWithStars,
  SearchResult,
  UserProfile,
} from './store.js';
