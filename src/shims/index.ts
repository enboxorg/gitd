/**
 * Package manager and container registry shims — local proxy servers
 * that translate native tool protocols into DWN queries.
 *
 * Each shim serves the native HTTP API of its ecosystem tool:
 *   - npm: npm registry API (for npm, bun, yarn, pnpm)
 *   - go:  GOPROXY protocol (for go get)
 *   - oci: OCI Distribution Spec v2 (for docker, podman)
 *
 * @module
 */

export { handleNpmRequest, parseNpmScope, startNpmShim } from './npm/index.js';
export type { NpmResponse, NpmShimOptions } from './npm/index.js';

export { handleGoProxyRequest, parseGoModulePath, startGoShim } from './go/index.js';
export type { GoProxyResponse, GoShimOptions } from './go/index.js';

export { handleOciRequest, parseOciName, startOciShim } from './oci/index.js';
export type { OciResponse, OciShimOptions } from './oci/index.js';
