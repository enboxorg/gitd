/**
 * `dwn-git issue` — create and list issues.
 *
 * Usage:
 *   dwn-git issue create <title> [--body <text>]
 *   dwn-git issue list [--status <open|closed>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function issueCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return issueCreate(ctx, rest);
    case 'list':
    case 'ls': return issueList(ctx, rest);
    default:
      console.error('Usage: dwn-git issue <create|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// issue create
// ---------------------------------------------------------------------------

async function issueCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const title = args[0];
  const body = flagValue(args, '--body') ?? flagValue(args, '-m') ?? '';

  if (!title) {
    console.error('Usage: dwn-git issue create <title> [--body <text>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body },
    tags            : { status: 'open' },
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created issue: "${title}"`);
  console.log(`  Record ID: ${record.id}`);
  console.log(`  Context:   ${record.contextId}`);
}

// ---------------------------------------------------------------------------
// issue list
// ---------------------------------------------------------------------------

async function issueList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const repoContextId = await getRepoContextId(ctx);

  const filter: Record<string, unknown> = {};
  if (repoContextId) {
    filter.contextId = repoContextId;
  }
  if (statusFilter) {
    filter.tags = { status: statusFilter };
  }

  const { records } = await ctx.issues.records.query('repo/issue', {
    filter,
  });

  if (records.length === 0) {
    console.log('No issues found.');
    return;
  }

  console.log(`Issues (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const st = tags?.status ?? 'unknown';
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    console.log(`  [${st.toUpperCase().padEnd(6)}] ${data.title}`);
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
