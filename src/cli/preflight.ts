/**
 * Preflight checks — verify external dependencies before running commands.
 *
 * `checkGit()` verifies that `git` is on `$PATH` and meets the minimum
 * version requirement (>= 2.28.0, needed for `git init -b`).
 *
 * @module
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum git version required by gitd (`git init -b` support). */
const MIN_GIT_VERSION = '2.28.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a git preflight check. */
export type GitCheck = {
  /** Whether `git` was found on `$PATH`. */
  installed: boolean;

  /** Parsed version string (e.g. `"2.39.2"`), or `null` if not found. */
  version: string | null;

  /** Whether the installed version meets the minimum requirement. */
  meetsMinimum: boolean;
};

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/**
 * Compare two semver-style version strings (major.minor.patch).
 *
 * Returns a negative number if `a < b`, zero if equal, positive if `a > b`.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) { return na - nb; }
  }
  return 0;
}

/**
 * Parse the version string from `git --version` output.
 *
 * Handles common formats:
 * - `git version 2.39.2`
 * - `git version 2.39.2.windows.1`
 * - `git version 2.39.2 (Apple Git-143)`
 */
export function parseGitVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** Check whether `git` is installed and meets the minimum version. */
export function checkGit(): GitCheck {
  try {
    const result = spawnSync('git', ['--version'], {
      encoding : 'utf-8',
      timeout  : 5_000,
      stdio    : ['ignore', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      return { installed: false, version: null, meetsMinimum: false };
    }

    const version = parseGitVersion(result.stdout ?? '');
    if (!version) {
      // git ran but we couldn't parse the version — treat as installed
      // but we can't verify the minimum.
      return { installed: true, version: null, meetsMinimum: false };
    }

    return {
      installed    : true,
      version,
      meetsMinimum : compareVersions(version, MIN_GIT_VERSION) >= 0,
    };
  } catch {
    return { installed: false, version: null, meetsMinimum: false };
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Print a warning to stderr about a missing or outdated git installation.
 * Used by commands that bypass the hard gate (--version, help).
 */
export function warnGit(check: GitCheck): void {
  if (!check.installed) {
    console.error(
      'Warning: git not found on PATH. gitd requires git >= 2.28.0.\n'
      + '  Install git: https://git-scm.com/downloads\n',
    );
  } else if (!check.meetsMinimum) {
    console.error(
      `Warning: git ${check.version} detected, but gitd requires >= 2.28.0.\n`
      + '  Upgrade git: https://git-scm.com/downloads\n',
    );
  }
}

/**
 * Require git to be installed and meet the minimum version.
 * Exits the process with a clear error message if the check fails.
 */
export function requireGit(): void {
  const check = checkGit();

  if (!check.installed) {
    console.error(
      'Fatal: git not found on PATH. gitd requires git >= 2.28.0.\n'
      + '  Install git: https://git-scm.com/downloads',
    );
    process.exit(1);
  }

  if (!check.meetsMinimum) {
    console.error(
      `Fatal: git ${check.version} detected, but gitd requires >= 2.28.0.\n`
      + '  Upgrade git: https://git-scm.com/downloads',
    );
    process.exit(1);
  }
}
