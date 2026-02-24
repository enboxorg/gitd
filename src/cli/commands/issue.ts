/**
 * `dwn-git issue` — create, list, show, comment on, and manage issues.
 *
 * Usage:
 *   dwn-git issue create <title> [--body <text>]
 *   dwn-git issue show <number>
 *   dwn-git issue comment <number> <body>
 *   dwn-git issue close <number> [--reason <text>]
 *   dwn-git issue reopen <number>
 *   dwn-git issue list [--status <open|closed>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

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
      console.error('Usage: dwn-git issue <create|show|comment|close|reopen|list>');
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

  // Assign the next sequential number.
  const number = await getNextNumber(ctx, repoContextId);

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body, number },
    tags            : { status: 'open', number: String(number) },
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created issue #${number}: "${title}"`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

async function issueShow(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: dwn-git issue show <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const record = await findIssueByNumber(ctx, repoContextId, numberStr);
  if (!record) {
    console.error(`Issue #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';
  const num = data.number ?? tags?.number ?? '?';

  console.log(`Issue #${num}: ${data.title}`);
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
  const numberStr = args[0];
  const body = args.slice(1).join(' ') || (flagValue(args, '--body') ?? flagValue(args, '-m'));

  if (!numberStr || !body) {
    console.error('Usage: dwn-git issue comment <number> <body>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const issue = await findIssueByNumber(ctx, repoContextId, numberStr);
  if (!issue) {
    console.error(`Issue #${numberStr} not found.`);
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

  console.log(`Added comment to issue #${numberStr}.`);
}

// ---------------------------------------------------------------------------
// issue close
// ---------------------------------------------------------------------------

async function issueClose(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: dwn-git issue close <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const issue = await findIssueByNumber(ctx, repoContextId, numberStr);
  if (!issue) {
    console.error(`Issue #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`Issue #${numberStr} is already closed.`);
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

  console.log(`Closed issue #${numberStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// issue reopen
// ---------------------------------------------------------------------------

async function issueReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: dwn-git issue reopen <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const issue = await findIssueByNumber(ctx, repoContextId, numberStr);
  if (!issue) {
    console.error(`Issue #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'open') {
    console.log(`Issue #${numberStr} is already open.`);
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

  console.log(`Reopened issue #${numberStr}: "${data.title}"`);
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
    const num = data.number ?? recTags?.number ?? '?';
    console.log(`  #${String(num).padEnd(4)} [${st.toUpperCase().padEnd(6)}] ${data.title}`);
    console.log(`        created: ${date}  id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the next sequential issue number by querying existing issues.
 * Returns `max(existing numbers) + 1`, or 1 if no issues exist.
 */
async function getNextNumber(ctx: AgentContext, repoContextId: string): Promise<number> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repoContextId },
  });

  let maxNumber = 0;
  for (const rec of records) {
    const recTags = rec.tags as Record<string, string> | undefined;
    const num = parseInt(recTags?.number ?? '0', 10);
    if (num > maxNumber) { maxNumber = num; }
  }

  return maxNumber + 1;
}

/**
 * Find an issue record by its sequential number.
 */
async function findIssueByNumber(
  ctx: AgentContext,
  repoContextId: string,
  numberStr: string,
): Promise<any | undefined> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: {
      contextId : repoContextId,
      tags      : { number: numberStr },
    },
  });

  return records[0];
}
