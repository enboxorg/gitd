/**
 * `gitd patch` — create, list, show, comment on, and merge patches (pull requests).
 *
 * Usage:
 *   gitd patch create <title> [--body <text>] [--base <branch>] [--head <branch>]
 *   gitd patch show <number>
 *   gitd patch comment <number> <body>
 *   gitd patch merge <number> [--strategy <merge|squash|rebase>]
 *   gitd patch close <number>
 *   gitd patch reopen <number>
 *   gitd patch list [--status <draft|open|closed|merged>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function patchCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return patchCreate(ctx, rest);
    case 'show': return patchShow(ctx, rest);
    case 'comment': return patchComment(ctx, rest);
    case 'merge': return patchMerge(ctx, rest);
    case 'close': return patchClose(ctx, rest);
    case 'reopen': return patchReopen(ctx, rest);
    case 'list':
    case 'ls': return patchList(ctx, rest);
    default:
      console.error('Usage: gitd patch <create|show|comment|merge|close|reopen|list>');
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
    console.error('Usage: gitd patch create <title> [--body <text>] [--base <branch>] [--head <branch>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  // Assign the next sequential number.
  const number = await getNextNumber(ctx, repoContextId);

  const tags: Record<string, string> = {
    status     : 'open',
    baseBranch : base,
    number     : String(number),
  };
  if (head) { tags.headBranch = head; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body, number },
    tags,
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create patch: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created patch #${number}: "${title}" (${base}${head ? ` <- ${head}` : ''})`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// patch show
// ---------------------------------------------------------------------------

async function patchShow(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd patch show <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const record = await findPatchByNumber(ctx, repoContextId, numberStr);
  if (!record) {
    console.error(`Patch #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';
  const num = data.number ?? tags?.number ?? '?';
  const base = tags?.baseBranch ?? '?';
  const head = tags?.headBranch;

  console.log(`Patch #${num}: ${data.title}`);
  console.log(`  Status:   ${st.toUpperCase()}`);
  console.log(`  Branches: ${base}${head ? ` <- ${head}` : ''}`);
  console.log(`  Created:  ${date}`);
  console.log(`  ID:       ${record.id}`);

  if (data.body) {
    console.log('');
    console.log(`  ${data.body}`);
  }

  // Fetch reviews.
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    filter: { contextId: record.contextId },
  });

  if (reviews.length > 0) {
    console.log('');
    console.log(`  Reviews (${reviews.length}):`);
    console.log('  ---');
    for (const review of reviews) {
      const reviewData = await review.data.json();
      const reviewTags = review.tags as Record<string, string> | undefined;
      const verdict = reviewTags?.verdict ?? 'comment';
      const reviewDate = review.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';
      const verdictLabel = verdict === 'approve' ? 'APPROVED' : verdict === 'reject' ? 'CHANGES REQUESTED' : 'COMMENTED';
      console.log(`  [${verdictLabel}] ${reviewDate}`);
      if (reviewData.body) {
        console.log(`  ${reviewData.body}`);
      }
      console.log('  ---');
    }
  }
}

// ---------------------------------------------------------------------------
// patch comment
// ---------------------------------------------------------------------------

async function patchComment(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  const body = args.slice(1).join(' ') || (flagValue(args, '--body') ?? flagValue(args, '-m'));

  if (!numberStr || !body) {
    console.error('Usage: gitd patch comment <number> <body>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const patch = await findPatchByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`Patch #${numberStr} not found.`);
    process.exit(1);
  }

  // Create a review with verdict: 'comment' (general comment, not approve/reject).
  const { status } = await ctx.patches.records.create('repo/patch/review' as any, {
    data            : { body },
    tags            : { verdict: 'comment' },
    parentContextId : patch.contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add comment: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added comment to patch #${numberStr}.`);
}

// ---------------------------------------------------------------------------
// patch merge
// ---------------------------------------------------------------------------

async function patchMerge(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  const strategy = flagValue(args, '--strategy') ?? 'merge';

  if (!numberStr) {
    console.error('Usage: gitd patch merge <number> [--strategy <merge|squash|rebase>]');
    process.exit(1);
  }

  if (!['merge', 'squash', 'rebase'].includes(strategy)) {
    console.error(`Invalid strategy: ${strategy}. Must be merge, squash, or rebase.`);
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const patch = await findPatchByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`Patch #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'merged') {
    console.log(`Patch #${numberStr} is already merged.`);
    return;
  }

  if (tags?.status === 'closed') {
    console.error(`Patch #${numberStr} is closed. Reopen it before merging.`);
    process.exit(1);
  }

  // Update the patch status to merged.
  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'merged' },
  });

  if (status.code >= 300) {
    console.error(`Failed to merge patch: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  // Create a merge result record.
  await ctx.patches.records.create('repo/patch/mergeResult' as any, {
    data            : { mergedBy: ctx.did },
    tags            : { mergeCommit: 'pending', strategy },
    parentContextId : patch.contextId,
  } as any);

  console.log(`Merged patch #${numberStr}: "${data.title}" (strategy: ${strategy})`);
}

// ---------------------------------------------------------------------------
// patch close
// ---------------------------------------------------------------------------

async function patchClose(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd patch close <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const patch = await findPatchByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`Patch #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`Patch #${numberStr} is already closed.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`Patch #${numberStr} is merged and cannot be closed.`);
    return;
  }

  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'closed' },
  });

  if (status.code >= 300) {
    console.error(`Failed to close patch: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Closed patch #${numberStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// patch reopen
// ---------------------------------------------------------------------------

async function patchReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd patch reopen <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const patch = await findPatchByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`Patch #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'open' || tags?.status === 'draft') {
    console.log(`Patch #${numberStr} is already open.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`Patch #${numberStr} is merged and cannot be reopened.`);
    return;
  }

  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'open' },
  });

  if (status.code >= 300) {
    console.error(`Failed to reopen patch: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Reopened patch #${numberStr}: "${data.title}"`);
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

  const filterTags: Record<string, string> = {};
  if (statusFilter) {
    filterTags.status = statusFilter;
  }
  if (Object.keys(filterTags).length > 0) {
    filter.tags = filterTags;
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
    const recTags = rec.tags as Record<string, string> | undefined;
    const st = recTags?.status ?? 'unknown';
    const base = recTags?.baseBranch ?? '?';
    const head = recTags?.headBranch;
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const num = data.number ?? recTags?.number ?? '?';
    const branches = head ? `${base} <- ${head}` : base;
    console.log(`  #${String(num).padEnd(4)} [${st.toUpperCase().padEnd(6)}] ${data.title} (${branches})`);
    console.log(`        created: ${date}  id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the next sequential patch number by querying existing patches.
 */
async function getNextNumber(ctx: AgentContext, repoContextId: string): Promise<number> {
  const { records } = await ctx.patches.records.query('repo/patch', {
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
 * Find a patch record by its sequential number.
 */
async function findPatchByNumber(
  ctx: AgentContext,
  repoContextId: string,
  numberStr: string,
): Promise<any | undefined> {
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: {
      contextId : repoContextId,
      tags      : { number: numberStr },
    },
  });

  return records[0];
}
