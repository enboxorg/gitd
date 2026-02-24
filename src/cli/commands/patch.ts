/**
 * `dwn-git patch` — create and list patches (pull requests).
 *
 * Usage:
 *   dwn-git patch create <title> [--body <text>] [--base <branch>] [--head <branch>]
 *   dwn-git patch list [--status <draft|open|closed|merged>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function patchCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return patchCreate(ctx, rest);
    case 'list':
    case 'ls': return patchList(ctx, rest);
    default:
      console.error('Usage: dwn-git patch <create|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// patch create
// ---------------------------------------------------------------------------

async function patchCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const title = args[0];
  const body = flagValue(args, '--body') ?? flagValue(args, '-m') ?? '';
  const base = flagValue(args, '--base') ?? 'main';
  const head = flagValue(args, '--head');

  if (!title) {
    console.error('Usage: dwn-git patch create <title> [--body <text>] [--base <branch>] [--head <branch>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  const tags: Record<string, string> = {
    status     : 'open',
    baseBranch : base,
  };
  if (head) { tags.headBranch = head; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body },
    tags,
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create patch: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created patch: "${title}" (${base}${head ? ` <- ${head}` : ''})`);
  console.log(`  Record ID: ${record.id}`);
  console.log(`  Context:   ${record.contextId}`);
}

// ---------------------------------------------------------------------------
// patch list
// ---------------------------------------------------------------------------

async function patchList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const repoContextId = await getRepoContextId(ctx);

  const filter: Record<string, unknown> = {};
  if (repoContextId) {
    filter.contextId = repoContextId;
  }
  if (statusFilter) {
    filter.tags = { status: statusFilter };
  }

  const { records } = await ctx.patches.records.query('repo/patch', {
    filter,
  });

  if (records.length === 0) {
    console.log('No patches found.');
    return;
  }

  console.log(`Patches (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const st = tags?.status ?? 'unknown';
    const base = tags?.baseBranch ?? '?';
    const head = tags?.headBranch;
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const branches = head ? `${base} <- ${head}` : base;
    console.log(`  [${st.toUpperCase().padEnd(6)}] ${data.title} (${branches})`);
    console.log(`           id: ${rec.id}  created: ${date}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}
