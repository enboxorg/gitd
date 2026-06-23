/**
 * Git remote helper — DID-based remote transport for git.
 *
 * @module git-remote
 */

export * from './credential-cache.js';
export * from './credential-helper.js';
export * from './parse-url.js';
export { assertNotPrivateUrl, resolveGitEndpoint } from './resolve.js';
export type { GitEndpoint } from './resolve.js';
export * from './service.js';
