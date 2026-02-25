/**
 * Go module proxy shim module — DID-scoped module resolution via the
 * GOPROXY HTTP protocol.
 *
 * @module
 */

export { handleGoProxyRequest, parseGoModulePath } from './proxy.js';

export type { GoProxyResponse } from './proxy.js';

export { startGoShim } from './server.js';

export type { GoShimOptions } from './server.js';
