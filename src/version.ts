/**
 * Package version resolution.
 *
 * Reads the version from `package.json` by walking up from the current
 * file.  Works from both `src/` (development) and `dist/` (production).
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Cached version string. */
let cached: string | null | undefined;

/**
 * Get the current gitd version from `package.json`.
 *
 * @returns The version string (e.g. `"0.6.1"`), or `null` if not found.
 */
export function getVersion(): string | null {
  if (cached !== undefined) { return cached; }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      cached = pkg.version ?? null;
      return cached;
    } catch {
      dir = dirname(dir);
    }
  }

  cached = null;
  return null;
}
