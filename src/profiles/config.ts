/**
 * Profile configuration — persistent config at `~/.enbox/config.json`.
 *
 * Manages the set of named identity profiles and the default selection.
 * This module handles reading, writing, and resolving profiles across
 * multiple selection sources (flag, env, git config, global default).
 *
 * Storage layout:
 *   ~/.enbox/
 *     config.json               Global config (this module)
 *     profiles/
 *       <name>/DATA/AGENT/...   Per-profile Web5 agent stores
 *
 * @module
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory for all enbox data.  Override with `ENBOX_HOME`. */
export function enboxHome(): string {
  return process.env.ENBOX_HOME ?? join(homedir(), '.enbox');
}

/** Path to the global config file. */
export function configPath(): string {
  return join(enboxHome(), 'config.json');
}

/** Base directory for all profile agent data. */
export function profilesDir(): string {
  return join(enboxHome(), 'profiles');
}

/** Path to a specific profile's agent data directory. */
export function profileDataPath(name: string): string {
  return join(profilesDir(), name, 'DATA', 'AGENT');
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** Metadata about a single profile stored in config.json. */
export type ProfileEntry = {
  /** Display name for the profile. */
  name : string;
  /** The DID URI associated with this profile. */
  did : string;
  /** ISO 8601 timestamp when the profile was created. */
  createdAt : string;
};

/** Top-level config.json shape. */
export type EnboxConfig = {
  /** Schema version for forward-compatibility. */
  version : number;
  /** Name of the default profile. */
  defaultProfile : string;
  /** Map of profile name → metadata. */
  profiles : Record<string, ProfileEntry>;
};

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

/** Read the global config.  Returns a default if the file doesn't exist. */
export function readConfig(): EnboxConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { version: 1, defaultProfile: '', profiles: {} };
  }
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as EnboxConfig;
}

/** Write the global config atomically. */
export function writeConfig(config: EnboxConfig): void {
  const path = configPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Add or update a profile entry in the global config. */
export function upsertProfile(name: string, entry: ProfileEntry): void {
  const config = readConfig();
  config.profiles[name] = entry;

  // If this is the first profile, make it the default.
  if (!config.defaultProfile || Object.keys(config.profiles).length === 1) {
    config.defaultProfile = name;
  }

  writeConfig(config);
}

/** Remove a profile entry from the global config. */
export function removeProfile(name: string): void {
  const config = readConfig();
  delete config.profiles[name];

  // If we removed the default, pick the first remaining (or clear).
  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.defaultProfile = remaining[0] ?? '';
  }

  writeConfig(config);
}

/** List all profile names. */
export function listProfiles(): string[] {
  return Object.keys(readConfig().profiles);
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which profile to use.
 *
 * Precedence (highest to lowest):
 *   1. `--profile <name>` flag (passed as `flagProfile`)
 *   2. `ENBOX_PROFILE` environment variable
 *   3. `.git/config` → `[enbox] profile = <name>`
 *   4. `~/.enbox/config.json` → `defaultProfile`
 *   5. First (and only) profile, if exactly one exists
 *
 * Returns `null` when no profile can be resolved (i.e. none exist).
 */
export function resolveProfile(flagProfile?: string): string | null {
  // 1. Explicit flag.
  if (flagProfile) { return flagProfile; }

  // 2. Environment variable.
  const envProfile = process.env.ENBOX_PROFILE;
  if (envProfile) { return envProfile; }

  // 3. Per-repo git config.
  const gitProfile = readGitConfigProfile();
  if (gitProfile) { return gitProfile; }

  // 4. Global default.
  const config = readConfig();
  if (config.defaultProfile) { return config.defaultProfile; }

  // 5. Single profile fallback.
  const names = Object.keys(config.profiles);
  if (names.length === 1) { return names[0]; }

  return null;
}

/**
 * Read the `[enbox] profile` setting from the current repo's `.git/config`.
 * Returns `null` if not in a git repo or the setting is absent.
 */
function readGitConfigProfile(): string | null {
  try {
    const result = spawnSync('git', ['config', '--local', 'enbox.profile'], {
      stdio   : ['pipe', 'pipe', 'pipe'],
      timeout : 2_000,
    });
    const value = result.stdout?.toString().trim();
    if (result.status === 0 && value) { return value; }
  } catch {
    // Not in a git repo or git not available.
  }
  return null;
}

/**
 * Write the `[enbox] profile` setting to the current repo's `.git/config`.
 */
export function setGitConfigProfile(name: string): void {
  spawnSync('git', ['config', '--local', 'enbox.profile', name], {
    stdio   : ['pipe', 'pipe', 'pipe'],
    timeout : 2_000,
  });
}
