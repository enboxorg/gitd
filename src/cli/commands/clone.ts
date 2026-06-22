/**
 * `gitd clone <did>/<repo>` — clone a repository by DID.
 *
 * Convenience wrapper that:
 * 1. Validates the DID/repo argument
 * 2. Spawns `git clone did::<did>/<repo>` with inherited stdio
 *
 * Usage: gitd clone <did>/<repo> [git-clone-args...]
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

const CLONE_OPTIONS_WITH_VALUE = new Set([
  '--also-filter-submodules',
  '--branch',
  '--config',
  '--depth',
  '--filter',
  '--jobs',
  '--origin',
  '--reference',
  '--reference-if-able',
  '--recurse-submodules',
  '--separate-git-dir',
  '--server-option',
  '--shallow-exclude',
  '--shallow-since',
  '--template',
  '--upload-pack',
  '-b',
  '-c',
  '-j',
  '-o',
  '-u',
]);

/** Drop an optional separator kept for backwards-compatible usage. */
export function gitCloneArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

/** Infer the working-tree path that `git clone` will create. */
export function inferCloneDirectory(repoName: string, args: string[]): string {
  const positionals: string[] = [];
  let consumeNext = false;
  let onlyPositionals = false;

  for (const arg of args) {
    if (consumeNext) {
      consumeNext = false;
      continue;
    }

    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }

    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }

    if (arg.startsWith('--')) {
      if (!arg.includes('=') && CLONE_OPTIONS_WITH_VALUE.has(arg)) {
        consumeNext = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      if (CLONE_OPTIONS_WITH_VALUE.has(arg)) {
        consumeNext = true;
      }
      continue;
    }

    positionals.push(arg);
  }

  return positionals.at(-1) ?? repoName;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cloneCommand(args: string[]): Promise<void> {
  const target = args[0];

  if (!target) {
    console.error('Usage: gitd clone <did>/<repo> [git-clone-args...]');
    console.error('');
    console.error('Examples:');
    console.error('  gitd clone did:dht:abc123/my-repo');
    console.error('  gitd clone did:dht:abc123/my-repo --depth 1');
    console.error('  gitd clone did:dht:abc123/my-repo my-local-dir');
    process.exit(1);
  }

  // Parse the target: expect "did:<method>:<id>/<repo>" format.
  const slashIdx = target.indexOf('/');
  if (slashIdx === -1 || !target.startsWith('did:')) {
    console.error(`Invalid target: "${target}"`);
    console.error('Expected format: did:<method>:<id>/<repo>');
    console.error('Example: did:dht:abc123/my-repo');
    process.exit(1);
  }

  const didPart = target.slice(0, slashIdx);
  const repoPart = target.slice(slashIdx + 1);

  if (didPart.split(':').length < 3) {
    console.error(`Invalid DID: "${didPart}"`);
    console.error('Expected format: did:<method>:<id>');
    process.exit(1);
  }

  if (!repoPart) {
    console.error('Missing repository name after DID.');
    console.error('Expected format: did:<method>:<id>/<repo>');
    process.exit(1);
  }

  // Collect extra git args. A leading `--` remains supported from the
  // original command shape, but it is no longer required.
  const extraArgs = gitCloneArgs(args.slice(1));

  // Build the DID transport URL: `did::<did>/<repo>`
  const didUrl = `did::${didPart}/${repoPart}`;

  console.log(`Cloning ${didPart}/${repoPart} via DID transport...`);
  console.log('');

  // Spawn git clone with inherited stdio so the user sees progress.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('git', ['clone', didUrl, ...extraArgs], {
      stdio : 'inherit',
      env   : process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 128));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  // Determine the clone directory (git uses the repo name by default,
  // unless the user specified a destination in extraArgs).
  const cloneDir = inferCloneDirectory(repoPart, extraArgs);

  // Store the repo name in git config so subsequent commands can auto-detect it.
  spawnSync('git', ['config', 'enbox.repo', repoPart], {
    cwd   : cloneDir,
    stdio : 'pipe',
  });
}
