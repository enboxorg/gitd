/**
 * `gitd setup` — configure git to use DID-based remotes and push auth.
 *
 * Creates symlinks for `git-remote-did` and `git-remote-did-credential` in
 * a directory on the user's PATH, and configures the global git credential
 * helper so that `git push` to DID remotes uses DID-signed tokens.
 *
 * Usage:
 *   gitd setup [--bin-dir <path>]     Install and configure
 *   gitd setup --check                Validate without modifying anything
 *   gitd setup --uninstall            Remove configuration and symlinks
 *
 * The default bin directory is `~/.gitd/bin`.
 *
 * @module
 */

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { flagValue, hasFlag } from '../flags.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BIN_DIR = join(homedir(), '.gitd', 'bin');

/** Binary names that must be on PATH for git DID transport to work. */
const BINARIES = ['git-remote-did', 'git-remote-did-credential'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a git config value, returning undefined if unset. */
function gitConfigGet(key: string): string | undefined {
  try {
    return execSync(`git config --global --get ${key}`, { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

/** Set a git config value globally. */
function gitConfigSet(key: string, value: string): void {
  execSync(`git config --global ${key} "${value}"`);
}

/** Unset a git config value globally. */
function gitConfigUnset(key: string): void {
  try {
    execSync(`git config --global --unset-all ${key}`);
  } catch {
    // Ignore — may not be set.
  }
}

/** Resolve the dist/esm directory relative to the compiled setup.js file. */
function resolveDistEsm(): string {
  const thisFile = new URL(import.meta.url).pathname;
  return resolve(thisFile, '..', '..', '..');
}

/** Resolve the source binary paths. */
function resolveSourceBinaries(): Record<string, string> {
  const distEsm = resolveDistEsm();
  return {
    'git-remote-did'            : join(distEsm, 'git-remote', 'main.js'),
    'git-remote-did-credential' : join(distEsm, 'git-remote', 'credential-main.js'),
  };
}

/** Check if a directory is on the system PATH. */
function isOnPath(dir: string): boolean {
  const pathDirs = (process.env.PATH ?? '').split(':');
  return pathDirs.some((d) => resolve(d) === resolve(dir));
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `gitd setup --check` — validate the current setup without modifications. */
function checkSetup(binDir: string): void {
  const sourceMap = resolveSourceBinaries();
  let ok = true;

  console.log('Checking gitd setup...');
  console.log('');

  // Check binaries.
  for (const name of BINARIES) {
    const linkPath = join(binDir, name);
    const target = sourceMap[name];

    if (!existsSync(linkPath)) {
      console.log(`  [MISSING]  ${name} not found at ${linkPath}`);
      ok = false;
    } else {
      try {
        const actual = readlinkSync(linkPath);
        if (resolve(actual) !== resolve(target)) {
          console.log(`  [MISMATCH] ${name} -> ${actual} (expected ${target})`);
        } else {
          console.log(`  [OK]       ${name} -> ${target}`);
        }
      } catch {
        console.log(`  [EXISTS]   ${name} at ${linkPath} (not a symlink)`);
      }
    }
  }

  // Check PATH.
  if (isOnPath(binDir)) {
    console.log(`  [OK]       ${binDir} is on PATH`);
  } else {
    console.log(`  [MISSING]  ${binDir} is not on PATH`);
    ok = false;
  }

  // Check credential helper.
  const credHelper = gitConfigGet('credential.helper');
  const expectedHelper = join(binDir, 'git-remote-did-credential');
  if (credHelper && credHelper.includes('git-remote-did-credential')) {
    console.log(`  [OK]       credential.helper = ${credHelper}`);
  } else if (credHelper) {
    console.log(`  [OTHER]    credential.helper = ${credHelper} (not gitd)`);
    console.log(`             Expected: ${expectedHelper}`);
    ok = false;
  } else {
    console.log(`  [MISSING]  credential.helper not configured`);
    ok = false;
  }

  console.log('');
  if (ok) {
    console.log('All checks passed.');
  } else {
    console.log('Some checks failed. Run `gitd setup` to fix.');
  }
}

/** `gitd setup --uninstall` — remove configuration and symlinks. */
function uninstallSetup(binDir: string): void {
  console.log('Removing gitd setup...');
  console.log('');

  // Remove symlinks.
  for (const name of BINARIES) {
    const linkPath = join(binDir, name);
    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
      console.log(`  Removed: ${linkPath}`);
    }
  }

  // Remove credential helper config.
  const credHelper = gitConfigGet('credential.helper');
  if (credHelper && credHelper.includes('git-remote-did-credential')) {
    gitConfigUnset('credential.helper');
    console.log('  Removed: credential.helper from git config');
  }

  console.log('');
  console.log('Uninstall complete. You may also want to remove the bin directory:');
  console.log(`  rm -rf ${binDir}`);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function setupCommand(args: string[]): Promise<void> {
  const binDir = flagValue(args, '--bin-dir') ?? DEFAULT_BIN_DIR;

  if (hasFlag(args, '--check')) {
    checkSetup(binDir);
    return;
  }

  if (hasFlag(args, '--uninstall')) {
    uninstallSetup(binDir);
    return;
  }

  // --- Install mode ---

  // 1. Create symlinks.
  mkdirSync(binDir, { recursive: true });

  const sourceMap = resolveSourceBinaries();

  for (const name of BINARIES) {
    const linkPath = join(binDir, name);
    const target = sourceMap[name];

    if (!existsSync(target)) {
      console.error(`Warning: source binary not found at ${target}`);
      console.error('  Run `bun run build` first, or install @enbox/gitd globally.');
      continue;
    }

    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }

    symlinkSync(target, linkPath);
    console.log(`  Linked: ${name} -> ${target}`);
  }

  // 2. Configure credential helper.
  const credBinPath = join(binDir, 'git-remote-did-credential');
  const existingHelper = gitConfigGet('credential.helper');

  if (existingHelper && existingHelper.includes('git-remote-did-credential')) {
    // Already configured — update the path in case binDir changed.
    gitConfigUnset('credential.helper');
  } else if (existingHelper) {
    console.log('');
    console.log(`  Note: existing credential.helper detected: ${existingHelper}`);
    console.log('  Adding gitd helper alongside it.');
  }

  gitConfigSet('credential.helper', credBinPath);
  console.log(`  Configured: credential.helper = ${credBinPath}`);

  // 3. Summary.
  console.log('');

  const onPath = isOnPath(binDir);
  if (onPath) {
    console.log(`Setup complete. ${binDir} is already on your PATH.`);
  } else {
    console.log('Setup complete. Add the bin directory to your PATH:');
    console.log('');
    console.log(`  export PATH="${binDir}:$PATH"`);
    console.log('');
    console.log('Add that line to your ~/.bashrc or ~/.zshrc to make it permanent.');
  }

  console.log('');
  console.log('Next steps:');
  console.log('  gitd auth login          Create an identity');
  console.log('  git clone did::<did>/<repo>   Clone a repo');
  console.log('  gitd setup --check       Verify configuration');
}
