/**
 * `dwn-git setup` — configure git to use DID-based remotes and push auth.
 *
 * Creates symlinks for `git-remote-did` and `git-remote-did-credential` in
 * a directory on the user's PATH, and configures the git credential helper
 * for any host using the DID transport.
 *
 * Usage: dwn-git setup [--bin-dir <path>]
 *
 * The default bin directory is `~/.dwn-git/bin`. The command also ensures
 * that directory is in the user's PATH (prints instructions if not).
 *
 * @module
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';

import { homedir } from 'node:os';

import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BIN_DIR = join(homedir(), '.dwn-git', 'bin');

/** Binary names that must be on PATH for git DID transport to work. */
const BINARIES = ['git-remote-did', 'git-remote-did-credential'] as const;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function setupCommand(args: string[]): Promise<void> {
  const binDir = flagValue(args, '--bin-dir') ?? DEFAULT_BIN_DIR;

  // Ensure the bin directory exists.
  mkdirSync(binDir, { recursive: true });

  // Find the dist directory — relative to this compiled file.
  // In the installed package: dist/esm/cli/commands/setup.js
  // Binary sources:           dist/esm/git-remote/main.js
  //                           dist/esm/git-remote/credential-main.js
  const thisFile = new URL(import.meta.url).pathname;
  const distEsm = resolve(thisFile, '..', '..', '..');
  const remoteBin = join(distEsm, 'git-remote', 'main.js');
  const credentialBin = join(distEsm, 'git-remote', 'credential-main.js');

  const sourceMap: Record<string, string> = {
    'git-remote-did'            : remoteBin,
    'git-remote-did-credential' : credentialBin,
  };

  for (const name of BINARIES) {
    const linkPath = join(binDir, name);
    const target = sourceMap[name];

    if (!existsSync(target)) {
      console.error(`Warning: source binary not found at ${target}`);
      console.error('  Run `bun run build` first, or install @enbox/dwn-git globally.');
      continue;
    }

    // Remove existing symlink if present.
    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }

    symlinkSync(target, linkPath);
    console.log(`  Linked: ${name} -> ${target}`);
  }

  // Check if binDir is on PATH.
  const pathDirs = (process.env.PATH ?? '').split(':');
  const onPath = pathDirs.some((d) => resolve(d) === resolve(binDir));

  console.log('');
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
  console.log('You can now clone repos via DID:');
  console.log('  git clone did::<did>/<repo>');
  console.log('');
  console.log('Or use the convenience wrapper:');
  console.log('  dwn-git clone <did>/<repo>');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}
