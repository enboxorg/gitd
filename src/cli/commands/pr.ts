/**
 * `gitd pr` — create, list, show, checkout, comment on, and merge pull requests.
 *
 * Usage:
 *   gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>]
 *   gitd pr checkout <number> [--branch <name>] [--detach]
 *   gitd pr show <number>
 *   gitd pr comment <number> <body>
 *   gitd pr merge <number> [--squash | --rebase] [--no-delete-branch]
 *   gitd pr close <number>
 *   gitd pr reopen <number>
 *   gitd pr list [--status <draft|open|closed|merged>]
 *
 * `gitd patch` is accepted as an alias for `gitd pr`.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import { getRepoContextId } from '../repo-context.js';
import { flagValue, hasFlag, resolveRepoName } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function prCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return prCreate(ctx, rest);
    case 'checkout':
    case 'co': return prCheckout(ctx, rest);
    case 'show': return prShow(ctx, rest);
    case 'comment': return prComment(ctx, rest);
    case 'merge': return prMerge(ctx, rest);
    case 'close': return prClose(ctx, rest);
    case 'reopen': return prReopen(ctx, rest);
    case 'list':
    case 'ls': return prList(ctx, rest);
    default:
      console.error('Usage: gitd pr <create|checkout|show|comment|merge|close|reopen|list>');
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
  const noBundle = hasFlag(args, '--no-bundle');

  if (!title) {
    console.error('Usage: gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>] [--no-bundle]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

  // Assign the next sequential number.
  const number = await getNextNumber(ctx, repoContextId);

  // Detect git context for revision + bundle creation.
  const gitInfo = noBundle ? null : detectGitContext(base);

  const headBranch = head ?? gitInfo?.headBranch;

  const tags: Record<string, string> = {
    status     : 'open',
    baseBranch : base,
    number     : String(number),
  };
  if (headBranch) { tags.headBranch = headBranch; }
  if (gitInfo) { tags.sourceDid = ctx.did; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body, number },
    tags,
    parentContextId : repoContextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to create PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created PR #${number}: "${title}" (${base}${headBranch ? ` <- ${headBranch}` : ''})`);
  console.log(`  Record ID: ${record.id}`);

  // Create revision + bundle if we have git context.
  if (gitInfo) {
    await createRevisionAndBundle(ctx, record, gitInfo);
  }
}

// ---------------------------------------------------------------------------
// pr checkout
// ---------------------------------------------------------------------------

async function prCheckout(ctx: AgentContext, args: string[]): Promise<void> {
  const numberStr = args[0];
  const branchOverride = flagValue(args, '--branch') ?? flagValue(args, '-b');
  const detach = hasFlag(args, '--detach');

  if (!numberStr) {
    console.error('Usage: gitd pr checkout <number> [--branch <name>] [--detach]');
    process.exit(1);
  }

  // Verify we're inside a git repo.
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!inRepo) {
    console.error('Not inside a git repository.');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const patch = await findPrByNumber(ctx, repoContextId, numberStr);
  if (!patch) {
    console.error(`PR #${numberStr} not found.`);
    process.exit(1);
  }

  const patchTags = patch.tags as Record<string, string> | undefined;

  // Fetch the latest revision under this patch.
  const { records: revisions } = await ctx.patches.records.query('repo/patch/revision' as any, {
    filter: { contextId: patch.contextId },
  });

  if (revisions.length === 0) {
    console.error(`PR #${numberStr} has no revisions.`);
    process.exit(1);
  }

  // Pick the latest revision (last created).
  const revision = revisions[revisions.length - 1];
  const revisionTags = revision.tags as Record<string, string> | undefined;

  // Fetch the bundle from the revision.
  const { records: bundles } = await ctx.patches.records.query('repo/patch/revision/revisionBundle' as any, {
    filter: { contextId: revision.contextId },
  });

  if (bundles.length === 0) {
    console.error(`PR #${numberStr} has no bundle attached.`);
    process.exit(1);
  }

  const bundleRecord = bundles[0];
  const bundleData = await bundleRecord.data.blob();
  const bundleBytes = new Uint8Array(await bundleData.arrayBuffer());

  // Write bundle to temp file.
  const bundlePath = join(tmpdir(), `gitd-pr-checkout-${Date.now()}.bundle`);
  try {
    writeFileSync(bundlePath, bundleBytes);

    // Verify the bundle.
    const verify = git(['bundle', 'verify', bundlePath]);
    if (verify === null) {
      console.error('Bundle verification failed. Missing prerequisite objects?');
      process.exit(1);
    }

    // Fetch objects from the bundle.
    const fetchResult = spawnSync('git', ['fetch', bundlePath], {
      encoding : 'utf-8',
      timeout  : 60_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (fetchResult.status !== 0) {
      console.error(`Failed to fetch from bundle: ${fetchResult.stderr?.trim()}`);
      process.exit(1);
    }

    const tipCommit = revisionTags?.headCommit;
    if (!tipCommit) {
      console.error('Revision has no headCommit tag.');
      process.exit(1);
    }

    const localBranch = branchOverride ?? patchTags?.headBranch ?? `pr/${numberStr}`;

    if (detach) {
      // Detached HEAD at the tip commit.
      const coResult = spawnSync('git', ['checkout', '--detach', tipCommit], {
        encoding : 'utf-8',
        timeout  : 30_000,
        stdio    : ['pipe', 'pipe', 'pipe'],
      });
      if (coResult.status !== 0) {
        console.error(`Failed to checkout: ${coResult.stderr?.trim()}`);
        process.exit(1);
      }
      console.log(`Checked out PR #${numberStr} at ${tipCommit.slice(0, 7)} (detached HEAD)`);
    } else {
      // Create or reset a local branch at the tip commit, then switch to it.
      spawnSync('git', ['branch', '-f', localBranch, tipCommit], {
        encoding : 'utf-8',
        timeout  : 30_000,
        stdio    : ['pipe', 'pipe', 'pipe'],
      });
      const coResult = spawnSync('git', ['checkout', localBranch], {
        encoding : 'utf-8',
        timeout  : 30_000,
        stdio    : ['pipe', 'pipe', 'pipe'],
      });
      if (coResult.status !== 0) {
        console.error(`Failed to checkout branch '${localBranch}': ${coResult.stderr?.trim()}`);
        process.exit(1);
      }
      console.log(`Switched to branch '${localBranch}' (PR #${numberStr})`);
    }
  } finally {
    try { unlinkSync(bundlePath); } catch { /* ignore cleanup errors */ }
  }
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
  const flagBody = flagValue(args, '--body') ?? flagValue(args, '-m');
  const positional = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
  const body = flagBody ?? (positional || undefined);

  if (!numberStr || !body) {
    console.error('Usage: gitd pr comment <number> <body>');
    console.error('       gitd pr comment <number> --body <text>');
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
  const strategy = hasFlag(args, '--squash')
    ? 'squash'
    : hasFlag(args, '--rebase')
      ? 'rebase'
      : 'merge';
  const deleteBranch = !hasFlag(args, '--no-delete-branch');

  if (!numberStr) {
    console.error('Usage: gitd pr merge <number> [--squash | --rebase] [--no-delete-branch]');
    process.exit(1);
  }

  // Must be inside a git repo.
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!inRepo) {
    console.error('Not inside a git repository.');
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

  const baseBranch = tags?.baseBranch ?? 'main';
  const headBranch = tags?.headBranch ?? `pr/${numberStr}`;

  // Ensure the PR branch exists locally.
  const branchExists = git(['rev-parse', '--verify', headBranch]);
  if (!branchExists) {
    console.error(`Branch '${headBranch}' not found locally. Run \`gitd pr checkout ${numberStr}\` first.`);
    process.exit(1);
  }

  // Switch to the base branch.
  const coResult = spawnSync('git', ['checkout', baseBranch], {
    encoding : 'utf-8',
    timeout  : 30_000,
    stdio    : ['pipe', 'pipe', 'pipe'],
  });
  if (coResult.status !== 0) {
    console.error(`Failed to switch to base branch '${baseBranch}': ${coResult.stderr?.trim()}`);
    process.exit(1);
  }

  // Count commits being merged (for display).
  const countStr = git(['rev-list', '--count', `${baseBranch}..${headBranch}`]);
  const commitCount = parseInt(countStr ?? '0', 10);

  // Perform the merge with the chosen strategy.
  if (strategy === 'squash') {
    const sq = spawnSync('git', ['merge', '--squash', headBranch], {
      encoding : 'utf-8',
      timeout  : 60_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (sq.status !== 0) {
      console.error(`Squash merge failed: ${sq.stderr?.trim()}`);
      process.exit(1);
    }
    // Squash leaves changes staged — commit them.
    const cm = spawnSync('git', ['commit', '-m', `Merge PR #${numberStr}: ${data.title} (squash)`], {
      encoding : 'utf-8',
      timeout  : 30_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (cm.status !== 0) {
      console.error(`Squash commit failed: ${cm.stderr?.trim()}`);
      process.exit(1);
    }
  } else if (strategy === 'rebase') {
    // Rebase the head branch onto the base branch, then fast-forward merge.
    // 1. Switch to the head branch.
    const coHead = spawnSync('git', ['checkout', headBranch], {
      encoding : 'utf-8',
      timeout  : 30_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (coHead.status !== 0) {
      console.error(`Failed to switch to '${headBranch}': ${coHead.stderr?.trim()}`);
      process.exit(1);
    }
    // 2. Rebase onto the base branch.
    const rb = spawnSync('git', ['rebase', baseBranch], {
      encoding : 'utf-8',
      timeout  : 60_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (rb.status !== 0) {
      console.error(`Rebase failed: ${rb.stderr?.trim()}`);
      // Abort the rebase so we don't leave the repo in a broken state.
      spawnSync('git', ['rebase', '--abort'], {
        encoding : 'utf-8',
        stdio    : ['pipe', 'pipe', 'pipe'],
      });
      // Return to the base branch.
      spawnSync('git', ['checkout', baseBranch], {
        encoding : 'utf-8',
        stdio    : ['pipe', 'pipe', 'pipe'],
      });
      process.exit(1);
    }
    // 3. Switch back to the base branch and fast-forward merge.
    spawnSync('git', ['checkout', baseBranch], {
      encoding : 'utf-8',
      timeout  : 30_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    const ff = spawnSync('git', ['merge', '--ff-only', headBranch], {
      encoding : 'utf-8',
      timeout  : 60_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (ff.status !== 0) {
      console.error(`Fast-forward merge failed: ${ff.stderr?.trim()}`);
      process.exit(1);
    }
  } else {
    // Standard merge commit.
    const mg = spawnSync('git', ['merge', '--no-ff', headBranch, '-m', `Merge PR #${numberStr}: ${data.title}`], {
      encoding : 'utf-8',
      timeout  : 60_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (mg.status !== 0) {
      console.error(`Merge failed: ${mg.stderr?.trim()}`);
      process.exit(1);
    }
  }

  // Capture the merge commit SHA.
  const mergeCommit = git(['rev-parse', 'HEAD']) ?? 'unknown';

  // Update the patch status to merged.
  const { status } = await patch.update({
    data : data,
    tags : { ...tags, status: 'merged' },
  });

  if (status.code >= 300) {
    console.error(`Failed to update PR status: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  // Create a merge result record with the actual commit SHA.
  await ctx.patches.records.create('repo/patch/mergeResult' as any, {
    data            : { mergedBy: ctx.did },
    tags            : { mergeCommit, strategy },
    parentContextId : patch.contextId,
  } as any);

  // Create a status change record (audit trail).
  await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: `Merged via ${strategy} strategy` },
    parentContextId : patch.contextId,
  } as any);

  const commitLabel = commitCount > 0
    ? ` (${commitCount} commit${commitCount !== 1 ? 's' : ''})`
    : '';
  console.log(`Merged PR #${numberStr}${commitLabel} into ${baseBranch} at ${mergeCommit.slice(0, 7)} (strategy: ${strategy})`);

  // Clean up the local PR branch.
  if (deleteBranch) {
    const delResult = spawnSync('git', ['branch', '-D', headBranch], {
      encoding : 'utf-8',
      timeout  : 30_000,
      stdio    : ['pipe', 'pipe', 'pipe'],
    });
    if (delResult.status === 0) {
      console.log(`Deleted branch ${headBranch}`);
    }
  }
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

  // Audit trail.
  await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: 'Closed by maintainer' },
    parentContextId : patch.contextId,
  } as any);

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

  // Audit trail.
  await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: 'Reopened by maintainer' },
    parentContextId : patch.contextId,
  } as any);

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
// Git context detection + revision/bundle creation
// ---------------------------------------------------------------------------

/** Git information collected from the working directory. */
type GitContext = {
  headCommit : string;
  baseCommit : string;
  headBranch : string;
  commitCount : number;
  diffStat : { additions: number; deletions: number; filesChanged: number };
};

/** Run a git command synchronously, returning trimmed stdout or `null` on failure. */
function git(args: string[]): string | null {
  const result = spawnSync('git', args, {
    encoding : 'utf-8',
    timeout  : 30_000,
    stdio    : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) { return null; }
  return result.stdout?.trim() ?? null;
}

/**
 * Detect git context for the current working directory.
 *
 * Returns `null` if not in a git repo, the base branch doesn't exist,
 * or there are no commits to bundle.
 */
function detectGitContext(baseBranch: string): GitContext | null {
  // Check we're in a git repo.
  const headCommit = git(['rev-parse', 'HEAD']);
  if (!headCommit) { return null; }

  // Resolve the merge base.
  const baseCommit = git(['merge-base', 'HEAD', baseBranch]);
  if (!baseCommit) { return null; }

  // No new commits — nothing to bundle.
  if (headCommit === baseCommit) { return null; }

  // Current branch name.
  const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';

  // Commit count.
  const countStr = git(['rev-list', '--count', `${baseCommit}..HEAD`]);
  const commitCount = parseInt(countStr ?? '0', 10);
  if (commitCount === 0) { return null; }

  // Diff stat.
  const diffStat = parseDiffStat(
    git(['diff', '--stat', `${baseCommit}..HEAD`]) ?? '',
  );

  return { headCommit, baseCommit, headBranch, commitCount, diffStat };
}

/** Parse the summary line of `git diff --stat` output. */
function parseDiffStat(output: string): { additions: number; deletions: number; filesChanged: number } {
  // The last line looks like: " 3 files changed, 10 insertions(+), 2 deletions(-)"
  const lines = output.trim().split('\n');
  const summary = lines[lines.length - 1] ?? '';
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  const addMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);
  return {
    filesChanged : parseInt(filesMatch?.[1] ?? '0', 10),
    additions    : parseInt(addMatch?.[1] ?? '0', 10),
    deletions    : parseInt(delMatch?.[1] ?? '0', 10),
  };
}

/**
 * Create a revision record and attach a git bundle to a patch.
 *
 * 1. Creates a scoped git bundle (`HEAD ^<baseCommit>`)
 * 2. Writes a `repo/patch/revision` record with commit metadata
 * 3. Writes a `repo/patch/revision/revisionBundle` record with the bundle binary
 */
async function createRevisionAndBundle(
  ctx: AgentContext,
  patchRecord: any,
  gitCtx: GitContext,
): Promise<void> {
  // Create the revision record.
  const { status: revStatus, record: revisionRecord } = await ctx.patches.records.create(
    'repo/patch/revision' as any,
    {
      data: {
        description : `v1: ${gitCtx.commitCount} commit${gitCtx.commitCount !== 1 ? 's' : ''}`,
        diffStat    : gitCtx.diffStat,
      },
      tags: {
        headCommit  : gitCtx.headCommit,
        baseCommit  : gitCtx.baseCommit,
        commitCount : gitCtx.commitCount,
      },
      parentContextId: patchRecord.contextId,
    } as any,
  );

  if (revStatus.code >= 300) {
    console.error(`  Warning: failed to create revision record: ${revStatus.code} ${revStatus.detail}`);
    return;
  }

  console.log(`  Revision: ${gitCtx.commitCount} commit${gitCtx.commitCount !== 1 ? 's' : ''} (${gitCtx.baseCommit.slice(0, 7)}..${gitCtx.headCommit.slice(0, 7)})`);
  console.log(`  DiffStat: +${gitCtx.diffStat.additions} -${gitCtx.diffStat.deletions} (${gitCtx.diffStat.filesChanged} file${gitCtx.diffStat.filesChanged !== 1 ? 's' : ''})`);

  // Create the scoped git bundle.
  const bundlePath = join(tmpdir(), `gitd-pr-${Date.now()}.bundle`);
  const bundleResult = git(['bundle', 'create', bundlePath, 'HEAD', `^${gitCtx.baseCommit}`]);
  if (bundleResult === null) {
    console.error('  Warning: failed to create git bundle.');
    return;
  }

  try {
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));
    const bundleSize = statSync(bundlePath).size;

    // Count refs in the bundle.
    const refListOutput = git(['bundle', 'list-heads', bundlePath]) ?? '';
    const refCount = refListOutput.split('\n').filter((l) => l.trim().length > 0).length;

    const { status: bundleStatus } = await ctx.patches.records.create(
      'repo/patch/revision/revisionBundle' as any,
      {
        data       : bundleBytes,
        dataFormat : 'application/x-git-bundle',
        tags       : {
          tipCommit  : gitCtx.headCommit,
          baseCommit : gitCtx.baseCommit,
          refCount,
          size       : bundleSize,
        },
        parentContextId: revisionRecord.contextId,
      } as any,
    );

    if (bundleStatus.code >= 300) {
      console.error(`  Warning: failed to attach bundle: ${bundleStatus.code} ${bundleStatus.detail}`);
      return;
    }

    console.log(`  Bundle: ${bundleSize} bytes, ${refCount} ref${refCount !== 1 ? 's' : ''}`);
  } finally {
    try { unlinkSync(bundlePath); } catch { /* ignore cleanup errors */ }
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
