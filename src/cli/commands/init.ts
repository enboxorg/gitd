/**
 * `dwn-git init` — create a forge repository record on the local DWN.
 *
 * Usage: dwn-git init <name> [--description <text>] [--branch <name>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? flagValue(args, '-d');
  const branch = flagValue(args, '--branch') ?? flagValue(args, '-b') ?? 'main';

  if (!name) {
    console.error('Usage: dwn-git init <name> [--description <text>] [--branch <name>]');
    process.exit(1);
  }

  // Check if a repo already exists (singleton).
  const { records: existing } = await ctx.repo.records.query('repo');
  if (existing.length > 0) {
    const data = await existing[0].data.json();
    console.error(`Repository "${data.name}" already exists (recordId: ${existing[0].id}).`);
    console.error('The forge-repo protocol allows only one repo record per DWN.');
    process.exit(1);
  }

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the value following a flag in argv. */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}
