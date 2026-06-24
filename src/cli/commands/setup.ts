/**
 * `gitd setup` — configure git to use DID-based remotes and push auth.
 *
 * Creates wrapper commands for `git-remote-did` and `git-remote-did-credential` in
 * a directory on the user's PATH, and configures the global git credential
 * helper so that `git push` to DID remotes uses DID-signed tokens.
 *
 * Usage:
 *   gitd setup [--bin-dir <path>] [--quiet]  Install and configure
 *   gitd setup --check                       Validate without modifying anything
 *   gitd setup --uninstall                   Remove configuration and wrapper commands
 *
 * The default bin directory is `~/.gitd/bin`.
 *
 * @module
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/** Resolve the dist/esm or src root relative to this command module. */
function resolveModuleRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '..', '..');
}

/** Resolve the source binary paths. */
function resolveSourceBinaries(): Record<string, string> {
  const moduleRoot = resolveModuleRoot();
  const remoteJs = join(moduleRoot, 'git-remote', 'main.js');
  const credentialJs = join(moduleRoot, 'git-remote', 'credential-main.js');
  const remoteTs = join(moduleRoot, 'git-remote', 'main.ts');
  const credentialTs = join(moduleRoot, 'git-remote', 'credential-main.ts');

  return {
    'git-remote-did'            : existsSync(remoteJs) ? remoteJs : remoteTs,
    'git-remote-did-credential' : existsSync(credentialJs) ? credentialJs : credentialTs,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bunExecutable(): string {
  return process.execPath || 'bun';
}

function wrapperText(target: string): string {
  return `#!/usr/bin/env bash\nexec ${shellQuote(bunExecutable())} ${shellQuote(target)} "$@"\n`;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExpectedWrapper(path: string, target: string): boolean {
  try {
    return readFileSync(path, 'utf-8') === wrapperText(target);
  } catch {
    return false;
  }
}

function writeWrapper(path: string, target: string): void {
  if (existsSync(path) || lstatExists(path)) {
    unlinkSync(path);
  }

  writeFileSync(path, wrapperText(target), { encoding: 'utf-8', mode: 0o755 });
  chmodSync(path, 0o755);
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

  // Check wrappers.
  for (const name of BINARIES) {
    const wrapperPath = join(binDir, name);
    const target = sourceMap[name];

    if (!existsSync(wrapperPath) && !lstatExists(wrapperPath)) {
      console.log(`  [MISSING]  ${name} not found at ${wrapperPath}`);
      ok = false;
    } else if (!isExpectedWrapper(wrapperPath, target)) {
      console.log(`  [MISMATCH] ${name} wrapper at ${wrapperPath}`);
      console.log(`             Expected target: ${target}`);
      ok = false;
    } else if (!isExecutable(wrapperPath)) {
      console.log(`  [NOT EXEC] ${name} at ${wrapperPath}`);
      ok = false;
    } else {
      console.log(`  [OK]       ${name} -> ${target}`);
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

/** `gitd setup --uninstall` — remove configuration and wrapper commands. */
function uninstallSetup(binDir: string): void {
  console.log('Removing gitd setup...');
  console.log('');

  // Remove wrapper commands.
  for (const name of BINARIES) {
    const wrapperPath = join(binDir, name);
    if (existsSync(wrapperPath) || lstatExists(wrapperPath)) {
      unlinkSync(wrapperPath);
      console.log(`  Removed: ${wrapperPath}`);
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
  const quiet = hasFlag(args, '--quiet');

  if (hasFlag(args, '--check')) {
    checkSetup(binDir);
    return;
  }

  if (hasFlag(args, '--uninstall')) {
    uninstallSetup(binDir);
    return;
  }

  // --- Install mode ---
  const log = (...values: string[]): void => {
    if (!quiet) { console.log(...values); }
  };

  // 1. Create wrapper commands.
  mkdirSync(binDir, { recursive: true });

  const sourceMap = resolveSourceBinaries();

  for (const name of BINARIES) {
    const wrapperPath = join(binDir, name);
    const target = sourceMap[name];

    if (!existsSync(target)) {
      console.error(`Warning: source binary not found at ${target}`);
      console.error('  Run `bun run build` first, or install @enbox/gitd globally.');
      continue;
    }

    writeWrapper(wrapperPath, target);
    log(`  Installed: ${name} -> ${target}`);
  }

  // 2. Configure credential helper.
  const credBinPath = join(binDir, 'git-remote-did-credential');
  const existingHelper = gitConfigGet('credential.helper');

  if (existingHelper && existingHelper.includes('git-remote-did-credential')) {
    // Already configured — update the path in case binDir changed.
    gitConfigUnset('credential.helper');
  } else if (existingHelper) {
    log('');
    log(`  Note: existing credential.helper detected: ${existingHelper}`);
    log('  Adding gitd helper alongside it.');
  }

  gitConfigSet('credential.helper', credBinPath);
  log(`  Configured: credential.helper = ${credBinPath}`);

  // 3. Summary.
  log('');

  const onPath = isOnPath(binDir);
  if (onPath) {
    log(`Setup complete. ${binDir} is already on your PATH.`);
  } else {
    log('Setup complete. Add the bin directory to your PATH:');
    log('');
    log(`  export PATH="${binDir}:$PATH"`);
    log('');
    log('Add that line to your ~/.bashrc or ~/.zshrc to make it permanent.');
  }

  log('');
  log('Next steps:');
  log('  gitd auth login          Create an identity');
  log('  git clone did::<did>/<repo>   Clone a repo');
  log('  gitd setup --check       Verify configuration');
}
