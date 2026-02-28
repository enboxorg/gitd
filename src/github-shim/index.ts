/**
 * GitHub API compatibility shim — barrel exports.
 *
 * @module
 */

export { handleShimRequest, startShimServer } from './server.js';
export type { ShimServerOptions } from './server.js';

export { handleGetRepo, buildRepoResponse } from './repos.js';
export { handleCreateIssue, handleCreateIssueComment, handleGetIssue, handleListIssueComments, handleListIssues, handleUpdateIssue } from './issues.js';
export { handleCreatePull, handleCreatePullReview, handleGetPull, handleListPullReviews, handleListPulls, handleMergePull, handleUpdatePull } from './pulls.js';
export { handleCreateRelease, handleGetReleaseByTag, handleListReleases } from './releases.js';
export { handleGetUser } from './users.js';

export {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  findByShortId,
  fromOpt,
  getRepoRecord,
  numericId,
  paginate,
  parsePagination,
  shortId,
  toISODate,
} from './helpers.js';

export type {
  GitHubOwner,
  JsonResponse,
  PaginationParams,
  RepoInfo,
} from './helpers.js';
