/**
 * GitHub API compatibility shim — barrel exports.
 *
 * @module
 */

export { handleShimRequest, startShimServer } from './server.js';
export type { ShimServerOptions } from './server.js';

export { handleGetRepo, buildRepoResponse } from './repos.js';
export { handleGetIssue, handleListIssueComments, handleListIssues } from './issues.js';
export { handleGetPull, handleListPullReviews, handleListPulls } from './pulls.js';
export { handleGetReleaseByTag, handleListReleases } from './releases.js';
export { handleGetUser } from './users.js';

export {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

export type {
  GitHubOwner,
  JsonResponse,
  PaginationParams,
  RepoInfo,
} from './helpers.js';
