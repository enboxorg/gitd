/**
 * `gitd init` — create a forge repository record on the local DWN
 * and initialize a bare git repository on the filesystem.
 *
 * Usage: gitd init <name> [--description <text>] [--branch <name>] [--repos <path>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getDwnEndpoints } from '../../git-server/did-service.js';
import { GitBackend } from '../../git-server/git-backend.js';
import { flagValue, resolveReposPath } from '../flags.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? flagValue(args, '-d');
  const branch = flagValue(args, '--branch') ?? flagValue(args, '-b') ?? 'main';
  const reposPath = resolveReposPath(args, ctx.profileName);
  const dwnEndpointFlag = flagValue(args, '--dwn-endpoint') ?? process.env.GITD_DWN_ENDPOINT;

  if (!name) {
    console.error('Usage: gitd init <name> [--description <text>] [--branch <name>] [--repos <path>] [--dwn-endpoint <url>]');
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

  // Initialize the bare git repository on disk.
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

  console.log(`Initialized forge repo "${name}" (branch: ${branch})`);
  console.log(`  DID:       ${ctx.did}`);
  console.log(`  Record ID: ${record.id}`);
  console.log(`  Context:   ${record.contextId}`);
  console.log(`  Git path:  ${gitPath}`);
  console.log('');
  console.log('Next steps — push an existing repository:');
  console.log('');
  console.log(`  git remote add origin did::${ctx.did}/${name}`);
  console.log(`  git push -u origin ${branch}`);
  console.log('');
  console.log('Or start from scratch:');
  console.log('');
  console.log('  git init');
  console.log(`  git remote add origin did::${ctx.did}/${name}`);
  console.log('  git add .');
  console.log('  git commit -m "initial commit"');
  console.log(`  git push -u origin ${branch}`);
  console.log('');
  console.log('To serve this repo:');
  console.log('');
  console.log('  gitd serve');
}


