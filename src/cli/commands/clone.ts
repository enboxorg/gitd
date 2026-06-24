/**
 * `gitd clone <did>/<repo>` — clone a repository by DID.
 *
 * Convenience wrapper that:
 * 1. Validates the DID/repo argument
 * 2. Spawns `git clone did::<did>/<repo>` with inherited stdio
 *
 * Usage: gitd clone <did>/<repo> [--profile <identity>] [git-clone-args...]
 *
 * @module
 */

import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { recordLockfileRepoContext } from '../../daemon/lockfile.js';
import { resolveProfile } from '../../profiles/config.js';
import {
  getOrCreatePublicReaderPassword,
  PUBLIC_READER_PROFILE,
} from '../../profiles/public-reader.js';

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

type CloneTarget = {
  did : string;
  repo : string;
};

type CloneCommandArgs = {
  gitArgs : string[];
  profileName?: string;
};

type CloneProfileSelection = {
  profileName?: string;
  env : NodeJS.ProcessEnv;
  publicReader : boolean;
  publicReaderCreated : boolean;
};

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

/** Parse the user-facing clone target into DID and repo components. */
export function parseCloneTarget(target: string): CloneTarget {
  const slashIdx = target.indexOf('/');
  if (slashIdx === -1 || !target.startsWith('did:')) {
    throw new Error(`Invalid target: "${target}"\nExpected format: did:<method>:<id>/<repo>`);
  }

  const did = target.slice(0, slashIdx);
  const repo = target.slice(slashIdx + 1);

  if (did.split(':').length < 3) {
    throw new Error(`Invalid DID: "${did}"\nExpected format: did:<method>:<id>`);
  }

  if (!repo) {
    throw new Error('Missing repository name after DID.\nExpected format: did:<method>:<id>/<repo>');
  }

  return { did, repo };
}

/**
 * Split gitd-owned clone flags from arguments that should pass through to
 * native `git clone`.
 */
export function parseCloneCommandArgs(args: string[]): CloneCommandArgs {
  const gitArgs: string[] = [];
  let profileName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      gitArgs.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--profile') {
      if (!args[i + 1]) {
        throw new Error('--profile requires an identity name');
      }
      profileName = args[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith('--profile=')) {
      profileName = arg.slice('--profile='.length);
      continue;
    }

    gitArgs.push(arg);
  }

  return { gitArgs, profileName };
}

/** Use the hidden reader only when no explicit or ambient identity exists. */
export function shouldUsePublicReaderProfile(explicitProfile?: string, resolvedProfile?: string | null): boolean {
  return !explicitProfile && !resolvedProfile;
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

/** Store gitd repo context in the cloned repository's local git config. */
export function recordCloneContext(
  cloneDir: string,
  target: CloneTarget,
  profileName?: string,
): string[] {
  const warnings: string[] = [];
  const entries: [string, string][] = [
    ['enbox.repo', target.repo],
    ['enbox.owner', target.did],
  ];
  if (profileName) {
    entries.push(['enbox.profile', profileName]);
  }

  for (const [key, value] of entries) {
    const result = spawnSync('git', ['config', '--local', key, value], {
      cwd   : cloneDir,
      stdio : 'pipe',
    });
    if (result.status !== 0) {
      warnings.push(`could not write ${key} in ${cloneDir}`);
    }
  }

  return warnings;
}

/** Pass resolved gitd profile selection through to Git's remote helper. */
export function gitCloneEnv(
  env: NodeJS.ProcessEnv,
  profileName?: string,
  password?: string,
): NodeJS.ProcessEnv {
  if (!profileName && !password) { return env; }

  return {
    ...env,
    ...(profileName ? { GITD_PROFILE: profileName } : {}),
    ...(password ? { GITD_PASSWORD: password } : {}),
  };
}

/** Resolve clone identity, creating a local read-only cache when needed. */
export function selectCloneProfile(
  parsedArgs: CloneCommandArgs,
  env: NodeJS.ProcessEnv = process.env,
): CloneProfileSelection {
  const resolvedProfile = resolveProfile(parsedArgs.profileName);
  if (!shouldUsePublicReaderProfile(parsedArgs.profileName, resolvedProfile)) {
    const profileName = resolvedProfile ?? undefined;
    return {
      profileName,
      env                 : gitCloneEnv(env, profileName),
      publicReader        : false,
      publicReaderCreated : false,
    };
  }

  const reader = getOrCreatePublicReaderPassword();
  return {
    profileName         : PUBLIC_READER_PROFILE,
    env                 : gitCloneEnv(env, PUBLIC_READER_PROFILE, reader.password),
    publicReader        : true,
    publicReaderCreated : reader.created,
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cloneCommand(args: string[]): Promise<void> {
  const target = args[0];

  if (!target) {
    console.error('Usage: gitd clone <did>/<repo> [--profile <identity>] [git-clone-args...]');
    console.error('');
    console.error('Examples:');
    console.error('  gitd clone did:dht:abc123/my-repo');
    console.error('  gitd clone did:dht:abc123/my-repo --depth 1');
    console.error('  gitd clone did:dht:abc123/my-repo my-local-dir');
    process.exit(1);
  }

  let parsed: CloneTarget;
  try {
    parsed = parseCloneTarget(target);
  } catch (err) {
    console.error((err as Error).message);
    console.error('Example: did:dht:abc123/my-repo');
    process.exit(1);
  }

  let parsedArgs: CloneCommandArgs;
  try {
    parsedArgs = parseCloneCommandArgs(args.slice(1));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const profileSelection = selectCloneProfile(parsedArgs);
  const profileName = profileSelection.profileName;
  const extraArgs = parsedArgs.gitArgs;

  // Build the DID transport URL: `did::<did>/<repo>`
  const didUrl = `did::${parsed.did}/${parsed.repo}`;

  console.log(`Cloning ${parsed.did}/${parsed.repo}`);
  if (profileSelection.publicReader) {
    const cacheLabel = profileSelection.publicReaderCreated ? 'Created' : 'Using';
    console.log(`${cacheLabel} local public-read cache (no identity setup required).`);
  }
  console.log('');

  // Spawn git clone with inherited stdio so the user sees progress.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('git', ['clone', didUrl, ...extraArgs], {
      stdio : 'inherit',
      env   : profileSelection.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 128));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  // Determine the clone directory (git uses the repo name by default,
  // unless the user specified a destination in extraArgs).
  const cloneDir = inferCloneDirectory(parsed.repo, extraArgs);
  const warnings = recordCloneContext(cloneDir, parsed, profileName);
  recordLockfileRepoContext({
    ownerDid  : parsed.did,
    repo      : parsed.repo,
    path      : resolve(cloneDir),
    remoteUrl : didUrl,
  }, profileName);

  console.log('');
  console.log(`Checked out ${cloneDir}`);
  console.log(`Repo: ${parsed.did}/${parsed.repo}`);
  if (profileSelection.publicReader) {
    console.log('Access: public-read cache');
  } else if (profileName) {
    console.log(`Identity: ${profileName}`);
  }
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }
}
