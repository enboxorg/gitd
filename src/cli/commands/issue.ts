/**
 * `gitd issue` — create, list, show, comment on, and manage issues.
 *
 * Usage:
 *   gitd issue create <title> [--body <text>]
 *   gitd issue show <id>
 *   gitd issue comment <id> <body>
 *   gitd issue close <id> [--reason <text>]
 *   gitd issue reopen <id>
 *   gitd issue list [--status <open|closed>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getRepoContextId } from '../repo-context.js';
import { findByShortId, shortId } from '../../github-shim/helpers.js';
import { flagValue, resolveRepoName } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function issueCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return issueCreate(ctx, rest);
    case 'show': return issueShow(ctx, rest);
    case 'comment': return issueComment(ctx, rest);
    case 'close': return issueClose(ctx, rest);
    case 'reopen': return issueReopen(ctx, rest);
    case 'list':
    case 'ls': return issueList(ctx, rest);
    default:
      console.error('Usage: gitd issue <create|show|comment|close|reopen|list>');
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
    console.error('Usage: gitd issue create <title> [--body <text>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body },
    tags            : { status: 'open' },
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create issue record');}

  const id = shortId(record.id);
  console.log(`Created issue ${id}: "${title}"`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

async function issueShow(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue show <id>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const record = await findById(ctx, repoContextId, idStr);
  if (!record) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';

  console.log(`Issue ${shortId(record.id)}: ${data.title}`);
  console.log(`  Status:  ${st.toUpperCase()}`);
  console.log(`  Created: ${date}`);
  console.log(`  ID:      ${record.id}`);

  if (data.body) {
    console.log('');
    console.log(`  ${data.body}`);
  }

  // Fetch comments.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    filter: { contextId: record.contextId },
  });

  if (comments.length > 0) {
    console.log('');
    console.log(`  Comments (${comments.length}):`);
    console.log('  ---');
    for (const comment of comments) {
      const commentData = await comment.data.json();
      const commentDate = comment.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';
      console.log(`  ${commentDate}`);
      console.log(`  ${commentData.body}`);
      console.log('  ---');
    }
  }
}

// ---------------------------------------------------------------------------
// issue comment
// ---------------------------------------------------------------------------

async function issueComment(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  const flagBody = flagValue(args, '--body') ?? flagValue(args, '-m');
  const positional = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
  const body = flagBody ?? (positional || undefined);

  if (!idStr || !body) {
    console.error('Usage: gitd issue comment <id> <body>');
    console.error('       gitd issue comment <id> --body <text>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const issue = await findById(ctx, repoContextId, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const { status } = await ctx.issues.records.create('repo/issue/comment' as any, {
    data            : { body },
    parentContextId : issue.contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add comment: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added comment to issue ${idStr}.`);
}

// ---------------------------------------------------------------------------
// issue close
// ---------------------------------------------------------------------------

async function issueClose(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue close <id>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const issue = await findById(ctx, repoContextId, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`Issue ${idStr} is already closed.`);
    return;
  }

  const { status } = await issue.update({
    data : data,
    tags : { ...tags, status: 'closed' },
  });

  if (status.code >= 300) {
    console.error(`Failed to close issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Closed issue ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// issue reopen
// ---------------------------------------------------------------------------

async function issueReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue reopen <id>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const issue = await findById(ctx, repoContextId, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'open') {
    console.log(`Issue ${idStr} is already open.`);
    return;
  }

  const { status } = await issue.update({
    data : data,
    tags : { ...tags, status: 'open' },
  });

  if (status.code >= 300) {
    console.error(`Failed to reopen issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Reopened issue ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// issue list
// ---------------------------------------------------------------------------

async function issueList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

  const filter: Record<string, unknown> = {};
  if (repoContextId) {
    filter.contextId = repoContextId;
  }

  const tags: Record<string, string> = {};
  if (statusFilter) {
    tags.status = statusFilter;
  }
  if (Object.keys(tags).length > 0) {
    filter.tags = tags;
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
    const recTags = rec.tags as Record<string, string> | undefined;
    const st = recTags?.status ?? 'unknown';
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const id = shortId(rec.id);
    console.log(`  ${id} [${st.toUpperCase().padEnd(6)}] ${data.title}`);
    console.log(`        created: ${date}  id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find an issue record by its short hash ID (or unambiguous prefix).
 */
async function findById(
  ctx: AgentContext,
  repoContextId: string,
  idStr: string,
): Promise<any | undefined> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repoContextId },
  });

  return findByShortId(records, idStr);
}
