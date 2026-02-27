/**
 * Shared CLI argument helpers.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';

import { profileReposPath } from '../profiles/config.js';

/** Extract the value following a flag in argv (e.g. `--port 8080`). */
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}

/** Check whether a boolean flag is present in argv. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Resolve the active repo name from CLI flags, env, or git config.
 *
 * Priority:
 *   1. `--repo <name>` flag
 *   2. `GITD_REPO` env var
 *   3. `git config enbox.repo` in the current working directory
 *   4. `undefined` (caller decides: single-repo fallback or error)
 */
export function resolveRepoName(args: string[]): string | undefined {
  const flag = flagValue(args, '--repo');
  if (flag) { return flag; }

  const env = process.env.GITD_REPO;
  if (env) { return env; }

  // Try git config in the current directory.
  try {
    const result = spawnSync('git', ['config', 'enbox.repo'], {
      encoding : 'utf-8',
      timeout  : 2000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    const value = result.stdout?.trim();
    if (value && result.status === 0) { return value; }
  } catch {
    // Not in a git repo or git not available — fall through.
  }

  return undefined;
}

/**
 * Parse a port number string, validating that it's a valid TCP port.
 * Exits the process with an error if the value is not a valid port.
 *
 * @param value - The port string to parse
 * @returns A valid port number (1–65535)
 */
export function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port number: '${value}'. Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

/**
 * Resolve the base path for bare git repositories.
 *
 * Priority (highest to lowest):
 *   1. `--repos <path>` CLI flag
 *   2. `GITD_REPOS` environment variable
 *   3. Profile-based path: `~/.enbox/profiles/<name>/repos/`
 *   4. Fallback: `~/.enbox/profiles/default/repos/`
 *
 * All paths resolve to the home directory — no CWD-relative paths.
 */
export function resolveReposPath(
  args: string[],
  profileName?: string | null,
): string {
  const flag = flagValue(args, '--repos');
  if (flag) { return flag; }

  const env = process.env.GITD_REPOS;
  if (env) { return env; }

  if (profileName) { return profileReposPath(profileName); }

  // No profile — fall back to a well-known home directory path rather
  // than polluting the current working directory.
  return profileReposPath('default');
}
