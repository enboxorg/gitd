/**
 * Adapter registry — all available shim adapters.
 *
 * To add a new ecosystem shim:
 *   1. Create `src/daemon/adapters/<name>.ts` implementing `ShimAdapter`
 *   2. Import and add it to the `builtinAdapters` array below
 *   3. The daemon picks it up automatically
 *
 * @module
 */

import type { ShimAdapter } from '../adapter.js';

import { githubAdapter } from './github.js';
import { goAdapter } from './go.js';
import { npmAdapter } from './npm.js';
import { ociAdapter } from './oci.js';

/**
 * All built-in shim adapters, in display order.
 *
 * Each adapter is registered once and referenced by its `id` in
 * configuration.  The daemon iterates this list to resolve config
 * entries to concrete adapters.
 */
export const builtinAdapters: readonly ShimAdapter[] = [
  githubAdapter,
  npmAdapter,
  goAdapter,
  ociAdapter,
];

/** Look up an adapter by its `id`. Returns `undefined` if not found. */
export function findAdapter(id: string): ShimAdapter | undefined {
  return builtinAdapters.find((a) => a.id === id);
}
