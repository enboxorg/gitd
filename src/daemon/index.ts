/**
 * Unified daemon — barrel exports.
 *
 * @module
 */

export type { DaemonConfig, ResolvedShimConfig, ShimAdapter, ShimConfig } from './adapter.js';
export type { DaemonInstance, DaemonOptions } from './server.js';

export { createAdapterServer, resolveConfig, startDaemon } from './server.js';
export { builtinAdapters, findAdapter } from './adapters/index.js';

export type { DaemonLock } from './lockfile.js';
export { lockfilePath, readLockfile, removeLockfile, writeLockfile } from './lockfile.js';

export { githubAdapter } from './adapters/github.js';
export { goAdapter } from './adapters/go.js';
export { npmAdapter } from './adapters/npm.js';
export { ociAdapter } from './adapters/oci.js';
