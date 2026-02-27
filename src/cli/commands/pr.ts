/**
 * `gitd pr` — create, list, show, comment on, and merge pull requests.
 *
 * Usage:
 *   gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>]
 *   gitd pr show <number>
 *   gitd pr comment <number> <body>
 *   gitd pr merge <number> [--strategy <merge|squash|rebase>]
 *   gitd pr close <number>
 *   gitd pr reopen <number>
 *   gitd pr list [--status <draft|open|closed|merged>]
 *
 * `gitd patch` is accepted as an alias for `gitd pr`.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getRepoContextId } from '../repo-context.js';
import { flagValue, resolveRepoName } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function prCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return prCreate(ctx, rest);
    case 'show': return prShow(ctx, rest);
    case 'comment': return prComment(ctx, rest);
    case 'merge': return prMerge(ctx, rest);
    case 'close': return prClose(ctx, rest);
    case 'reopen': return prReopen(ctx, rest);
    case 'list':
    case 'ls': return prList(ctx, rest);
    default:
      console.error('Usage: gitd pr <create|show|comment|merge|close|reopen|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// pr create
// ---------------------------------------------------------------------------

async function prCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const title = args[0];
  const body = flagValue(args, '--body') ?? flagValue(args, '-m') ?? '';
  const base = flagValue(args, '--base') ?? 'main';
  const head = flagValue(args, '--head');

  if (!title) {
    console.error('Usage: gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

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
    console.error(`Failed to create PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created PR #${number}: "${title}" (${base}${head ? ` <- ${head}` : ''})`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// pr show
// ---------------------------------------------------------------------------

async function prShow(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd pr show <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const record = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!record) {
    console.error(`PR #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';
  const num = data.number ?? tags?.number ?? '?';
  const base = tags?.baseBranch ?? '?';
  const head = tags?.headBranch;

  console.log(`PR #${num}: ${data.title}`);
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
// pr comment
// ---------------------------------------------------------------------------

async function prComment(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  const body = args.slice(1).join(' ') || (flagValue(args, '--body') ?? flagValue(args, '-m'));

  if (!numberStr || !body) {
    console.error('Usage: gitd pr comment <number> <body>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const patch = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`PR #${numberStr} not found.`);
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

  console.log(`Added comment to PR #${numberStr}.`);
}

// ---------------------------------------------------------------------------
// pr merge
// ---------------------------------------------------------------------------

async function prMerge(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  const strategy = flagValue(args, '--strategy') ?? 'merge';

  if (!numberStr) {
    console.error('Usage: gitd pr merge <number> [--strategy <merge|squash|rebase>]');
    process.exit(1);
  }

  if (!['merge', 'squash', 'rebase'].includes(strategy)) {
    console.error(`Invalid strategy: ${strategy}. Must be merge, squash, or rebase.`);
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const patch = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`PR #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'merged') {
    console.log(`PR #${numberStr} is already merged.`);
    return;
  }

  if (tags?.status === 'closed') {
    console.error(`PR #${numberStr} is closed. Reopen it before merging.`);
    process.exit(1);
  }

  // Update the patch status to merged.
  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'merged' },
  });

  if (status.code >= 300) {
    console.error(`Failed to merge PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  // Create a merge result record.
  await ctx.patches.records.create('repo/patch/mergeResult' as any, {
    data            : { mergedBy: ctx.did },
    tags            : { mergeCommit: 'pending', strategy },
    parentContextId : patch.contextId,
  } as any);

  console.log(`Merged PR #${numberStr}: "${data.title}" (strategy: ${strategy})`);
}

// ---------------------------------------------------------------------------
// pr close
// ---------------------------------------------------------------------------

async function prClose(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd pr close <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const patch = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`PR #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`PR #${numberStr} is already closed.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`PR #${numberStr} is merged and cannot be closed.`);
    return;
  }

  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'closed' },
  });

  if (status.code >= 300) {
    console.error(`Failed to close PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Closed PR #${numberStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// pr reopen
// ---------------------------------------------------------------------------

async function prReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  if (!numberStr) {
    console.error('Usage: gitd pr reopen <number>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const patch = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`PR #${numberStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'open' || tags?.status === 'draft') {
    console.log(`PR #${numberStr} is already open.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`PR #${numberStr} is merged and cannot be reopened.`);
    return;
  }

  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'open' },
  });

  if (status.code >= 300) {
    console.error(`Failed to reopen PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Reopened PR #${numberStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// pr list
// ---------------------------------------------------------------------------

async function prList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

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
    console.log('No PRs found.');
    return;
  }

  console.log(`PRs (${records.length}):\n`);
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
 * Get the next sequential PR number by querying existing PRs.
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
 * Find a PR record by its sequential number.
 */
async function findPrByNumber(
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
