/**
 * npm registry shim module — DID-scoped package resolution via the
 * standard npm registry HTTP API.
 *
 * @module
 */

export { handleNpmRequest, parseNpmScope } from './registry.js';

export type { NpmResponse } from './registry.js';

export { startNpmShim } from './server.js';

export type { NpmShimOptions } from './server.js';
