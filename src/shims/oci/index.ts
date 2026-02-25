/**
 * OCI Distribution registry shim module — DID-scoped container image
 * resolution via the OCI Distribution Spec HTTP API.
 *
 * @module
 */

export { handleOciRequest, parseOciName } from './registry.js';

export type { OciResponse } from './registry.js';

export { startOciShim } from './server.js';

export type { OciShimOptions } from './server.js';
