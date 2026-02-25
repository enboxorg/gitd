/**
 * `gitd init` — create a forge repository record on the local DWN
 * and initialize a bare git repository on the filesystem.
 *
 * Usage: gitd init <name> [--description <text>] [--branch <name>] [--repos <path>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { GitBackend } from '../../git-server/git-backend.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? flagValue(args, '-d');
  const branch = flagValue(args, '--branch') ?? flagValue(args, '-b') ?? 'main';
  const reposPath = flagValue(args, '--repos') ?? process.env.GITD_REPOS ?? './repos';

  if (!name) {
    console.error('Usage: gitd init <name> [--description <text>] [--branch <name>] [--repos <path>]');
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

  // Create the DWN repo record.
  const { status, record } = await ctx.repo.records.create('repo', {
    data: {
      name,
      description   : description ?? '',
      defaultBranch : branch,
      dwnEndpoints  : [],
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
}


