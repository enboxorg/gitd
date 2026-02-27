/**
 * `gitd init` — create a forge repository on the local DWN, initialize a
 * bare git repository for the server, and set up the local working
 * directory with the remote pre-configured.
 *
 * Usage: gitd init <name> [--description <text>] [--branch <name>]
 *                         [--repos <path>] [--dwn-endpoint <url>]
 *                         [--no-local]
 *
 * By default the command also initializes a git repository in the current
 * working directory (if one does not already exist) and adds an `origin`
 * remote pointing at `did::<did>/<name>`.  Pass `--no-local` to skip this
 * step and only create the server-side bare repo + DWN record.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { AgentContext } from '../agent.js';

import { getDwnEndpoints } from '../../git-server/did-service.js';
import { GitBackend } from '../../git-server/git-backend.js';
import { flagValue, hasFlag, resolveReposPath } from '../flags.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? flagValue(args, '-d');
  const branch = flagValue(args, '--branch') ?? flagValue(args, '-b') ?? 'main';
  const reposPath = resolveReposPath(args, ctx.profileName);
  const dwnEndpointFlag = flagValue(args, '--dwn-endpoint') ?? process.env.GITD_DWN_ENDPOINT;
  const skipLocal = hasFlag(args, '--no-local');

  if (!name) {
    console.error('Usage: gitd init <name> [--description <text>] [--branch <name>] [--repos <path>] [--dwn-endpoint <url>] [--no-local]');
    process.exit(1);
  }

  // Check if a repo with this name already exists.
  const { records: existing } = await ctx.repo.records.query('repo', {
    filter: { tags: { name } },
  });
  if (existing.length > 0) {
    console.error(`Repository "${name}" already exists (recordId: ${existing[0].id}).`);
    process.exit(1);
  }

  // Initialize the bare git repository on disk (server-side storage).
  const backend = new GitBackend({ basePath: reposPath });
  const gitPath = await backend.initRepo(ctx.did, name);

  // Resolve DWN endpoints: explicit flag > env > DID document > empty.
  const dwnEndpoints = dwnEndpointFlag
    ? [dwnEndpointFlag]
    : getDwnEndpoints(ctx.web5);

  // Create the DWN repo record.
  const { status, record } = await ctx.repo.records.create('repo', {
    data: {
      name,
      description   : description ?? '',
      defaultBranch : branch,
      dwnEndpoints,
    },
    tags: {
      name,
      visibility: 'public',
    },
  });

  if (status.code >= 300) {
    console.error(`Failed to create repo: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  const remoteUrl = `did::${ctx.did}/${name}`;

  console.log(`Initialized forge repo "${name}" (branch: ${branch})`);
  console.log(`  DID:       ${ctx.did}`);
  console.log(`  Record ID: ${record.id}`);
  console.log(`  Context:   ${record.contextId}`);
  console.log(`  Git path:  ${gitPath}`);

  // -----------------------------------------------------------------------
  // Local working directory setup
  // -----------------------------------------------------------------------

  if (!skipLocal) {
    const localResult = setupLocalRepo(branch, remoteUrl);
    console.log('');
    if (localResult.initialized) {
      console.log(`Initialized local git repo (branch: ${branch})`);
    }
    if (localResult.remoteAdded) {
      console.log(`Remote "origin" set to ${remoteUrl}`);
    } else if (localResult.remoteExists) {
      console.log(`Remote "origin" already exists — skipped.`);
      console.log(`  To add manually:  git remote add forge ${remoteUrl}`);
    }
  }

  // -----------------------------------------------------------------------
  // Next steps
  // -----------------------------------------------------------------------

  console.log('');
  console.log('Next steps:');
  console.log('');
  if (skipLocal) {
    console.log(`  git remote add origin ${remoteUrl}`);
  }
  console.log('  git add .');
  console.log('  git commit -m "initial commit"');
  console.log(`  git push -u origin ${branch}`);
  console.log('');
  console.log('To serve this repo locally:');
  console.log('');
  console.log('  gitd serve');
  console.log('');
  console.log('To make it publicly accessible (requires a public URL with TLS):');
  console.log('');
  console.log('  gitd serve --public-url https://git.example.com');
  console.log('');
  console.log('See DEPLOY.md for reverse proxy and deployment guidance.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LocalSetupResult = {
  initialized: boolean;
  remoteAdded: boolean;
  remoteExists: boolean;
};

/**
 * Initialize a git repo in CWD (if needed) and add the `origin` remote.
 *
 * @param branch - Default branch name for `git init -b`.
 * @param remoteUrl - Remote URL to set as `origin`.
 * @returns What actions were performed.
 */
function setupLocalRepo(branch: string, remoteUrl: string): LocalSetupResult {
  const result: LocalSetupResult = {
    initialized  : false,
    remoteAdded  : false,
    remoteExists : false,
  };

  // Initialize a new git repo if CWD is not already one.
  if (!existsSync('.git')) {
    const init = spawnSync('git', ['init', '-b', branch], { stdio: 'pipe' });
    if (init.status !== 0) {
      const msg = init.stderr?.toString().trim() || 'unknown error';
      console.error(`Warning: failed to initialize local git repo: ${msg}`);
      return result;
    }
    result.initialized = true;
  }

  // Check whether an "origin" remote already exists.
  const remoteCheck = spawnSync('git', ['remote', 'get-url', 'origin'], { stdio: 'pipe' });
  if (remoteCheck.status === 0) {
    // Remote already exists — don't overwrite.
    result.remoteExists = true;
    return result;
  }

  // Add the remote.
  const addRemote = spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { stdio: 'pipe' });
  if (addRemote.status !== 0) {
    const msg = addRemote.stderr?.toString().trim() || 'unknown error';
    console.error(`Warning: failed to add remote: ${msg}`);
    return result;
  }
  result.remoteAdded = true;

  return result;
}


