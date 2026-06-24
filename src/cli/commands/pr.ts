/**
 * `gitd pr` — create, list, show, checkout, comment on, and merge pull requests.
 *
 * Usage:
 *   gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>] [--push|--no-push]
 *   gitd pr checkout <id> [--branch <name>] [--detach]
 *   gitd pr show <id>
 *   gitd pr comment <id> <body>
 *   gitd pr merge <id> [--squash | --rebase] [--no-delete-branch]
 *   gitd pr close <id>
 *   gitd pr reopen <id>
 *   gitd pr accept <submitter-did> <id>
 *   gitd pr ignore <submitter-did> <id> [--reason <text>]
 *   gitd pr list [--status <draft|open|closed|merged>]
 *
 * `gitd patch` is accepted as an alias for `gitd pr`.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';
import type { RepoContext, RepoRoleName } from '../repo-context.js';

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import * as p from '@clack/prompts';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import {
  DataStream,
  RecordsQuery,
  RecordsRead,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';

import { ForgePatchesDefinition } from '../../patches.js';
import { recordIgnoredSubmission } from '../submission-decisions.js';
import { shortId } from '../../github-shim/helpers.js';
import {
  bodyInit,
  configuredDwnEndpoints,
  jsonBody,
  messageSignerForContext,
  processMessageOnTargetEndpoints,
  sendRecordToTarget,
} from '../record-send.js';
import { contributorBranchPrefix, isContributorBranchRef } from '../../branch-state.js';
import { discussionIsLocked, latestActiveBlock, visibleCommentRecords } from '../moderation-state.js';
import { flagValue, hasFlag, resolveRepoName, resolveRepoOwner } from '../flags.js';
import { fromOpt, getRepoContext, getRepoContextForDid, resolveRepoProtocolRole } from '../repo-context.js';

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
    case 'accept': return prAccept(ctx, rest);
    case 'ignore': return prIgnore(ctx, rest);
    case 'list':
    case 'ls': return prList(ctx, rest);
    default:
      console.error('Usage: gitd pr <create|checkout|show|comment|merge|close|reopen|accept|ignore|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// pr create
// ---------------------------------------------------------------------------

async function prCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const title = args[0];
  const body = flagValue(args, '--body') ?? flagValue(args, '-m') ?? '';
  const explicitBase = flagValue(args, '--base');
  const head = flagValue(args, '--head');
  const noBundle = hasFlag(args, '--no-bundle');
  const pushContributorBranch = hasFlag(args, '--push');
  const noPushContributorBranch = hasFlag(args, '--no-push');
  const pushRemote = flagValue(args, '--remote') ?? 'origin';

  if (!title) {
    console.error('Usage: gitd pr create <title> [--body <text>] [--base <branch>] [--head <branch>] [--no-bundle] [--push|--no-push]');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const protocolRole = await patchCreateRole(ctx, target);
  if (target.remote) {
    await (ctx.patches as any).configure?.({ encryption: true });
  }

  const base = inferPrBaseBranch({
    explicitBase,
    repoDefaultBranch: target.repo.defaultBranch,
    git,
  });

  // Detect git context for revision + bundle creation.
  const gitInfo = noBundle ? null : detectGitContext(base);

  const headBranch = inferPrHeadBranch(head, gitInfo, git);

  const tags: Record<string, string> = {
    status     : 'open',
    baseBranch : base,
  };
  if (headBranch) { tags.headBranch = headBranch; }
  if (gitInfo) { tags.sourceDid = ctx.did; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body },
    tags,
    parentContextId : target.repo.contextId,
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create PR record');}
  if (target.remote) {
    await sendRecordToTarget(ctx, record, target.ownerDid, 'PR');
  }

  const id = shortId(record.id);

  console.log(`Created PR ${id}: "${title}" (${base}${headBranch ? ` <- ${headBranch}` : ''})`);
  console.log(`  Record ID: ${record.id}`);

  // Create revision + bundle if we have git context.
  if (gitInfo) {
    await createRevisionAndBundle(ctx, record, gitInfo, target);
  }

  const publishPlan = target.remote
    ? contributorBranchPublishPlan(ctx.did, headBranch, pushRemote)
    : undefined;
  if (publishPlan) {
    console.log(`  Contributor branch: ${publishPlan.refName}`);
    const shouldPush = await shouldPublishContributorBranch({
      plan          : publishPlan,
      pushRequested : pushContributorBranch,
      noPush        : noPushContributorBranch,
      stdinIsTTY    : process.stdin.isTTY,
      stdoutIsTTY   : process.stdout.isTTY,
    });
    if (shouldPush) {
      await publishContributorBranchToRemote(publishPlan);
    } else {
      console.log(`  Publish branch: ${publishPlan.commandText}`);
    }
  }
}

// ---------------------------------------------------------------------------
// pr checkout
// ---------------------------------------------------------------------------

async function prCheckout(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  const branchOverride = flagValue(args, '--branch') ?? flagValue(args, '-b');
  const detach = hasFlag(args, '--detach');

  if (!idStr) {
    console.error('Usage: gitd pr checkout <id> [--branch <name>] [--detach]');
    process.exit(1);
  }

  // Verify we're inside a git repo.
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!inRepo) {
    console.error('Not inside a git repository.');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  const patch = await findById(ctx, target, idStr);
  if (!patch) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  const patchTags = patch.tags as Record<string, string> | undefined;

  // Fetch the latest revision under this patch.
  const revisions = await queryPatchRecords(ctx, target, 'repo/patch/revision', {
    contextId: patch.contextId,
  });

  if (revisions.length === 0) {
    console.error(`PR ${idStr} has no revisions.`);
    process.exit(1);
  }

  // Pick the latest revision (last created).
  const revision = revisions[revisions.length - 1];
  const revisionTags = revision.tags as Record<string, string> | undefined;

  // Fetch the bundle from the revision.
  const bundles = await queryPatchRecords(ctx, target, 'repo/patch/revision/revisionBundle', {
    contextId: revision.contextId,
  });

  if (bundles.length === 0) {
    console.error(`PR ${idStr} has no bundle attached.`);
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

    const localBranch = branchOverride ?? patchTags?.headBranch ?? `pr/${idStr}`;

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
      console.log(`Checked out PR ${idStr} at ${tipCommit.slice(0, 7)} (detached HEAD)`);
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
      console.log(`Switched to branch '${localBranch}' (PR ${idStr})`);
    }
  } finally {
    try { unlinkSync(bundlePath); } catch { /* ignore cleanup errors */ }
  }
}

// ---------------------------------------------------------------------------
// pr show
// ---------------------------------------------------------------------------

async function prShow(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd pr show <id>');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  const record = await findById(ctx, target, idStr);
  if (!record) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';
  const id = shortId(record.id);
  const base = tags?.baseBranch ?? '?';
  const head = tags?.headBranch;

  console.log(`PR ${id}: ${data.title}`);
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
    ...(target.from ? { from: target.from } : {}),
    filter: { contextId: record.contextId },
  });

  const visibleReviews = await visibleCommentRecords(ctx, target, 'prComment', reviews);
  if (visibleReviews.length > 0) {
    console.log('');
    console.log(`  Reviews (${visibleReviews.length}):`);
    console.log('  ---');
    for (const review of visibleReviews) {
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
  const idStr = args[0];
  const flagBody = flagValue(args, '--body') ?? flagValue(args, '-m');
  const positional = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
  const body = flagBody ?? (positional || undefined);

  if (!idStr || !body) {
    console.error('Usage: gitd pr comment <id> <body>');
    console.error('       gitd pr comment <id> --body <text>');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const patch = await findById(ctx, target, idStr);
  if (!patch) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  if (await discussionIsLocked(ctx, target, 'pr', patch)) {
    console.error(`PR ${idStr} is locked.`);
    process.exit(1);
  }

  const protocolRole = await patchDiscussionRole(ctx, target);
  // Create a review with verdict: 'comment' (general comment, not approve/reject).
  const { status, record: reviewRecord } = await ctx.patches.records.create('repo/patch/review' as any, {
    data            : { body },
    tags            : { verdict: 'comment' },
    parentContextId : patch.contextId,
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add comment: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (target.remote) {
    if (!reviewRecord) { throw new Error('Failed to create PR comment record'); }
    await sendRecordToTarget(ctx, reviewRecord, target.ownerDid, 'PR comment');
  }

  console.log(`Added comment to PR ${idStr}.`);
}

// ---------------------------------------------------------------------------
// pr merge
// ---------------------------------------------------------------------------

async function prMerge(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  const strategy = hasFlag(args, '--squash')
    ? 'squash'
    : hasFlag(args, '--rebase')
      ? 'rebase'
      : 'merge';
  const deleteBranch = !hasFlag(args, '--no-delete-branch');

  if (!idStr) {
    console.error('Usage: gitd pr merge <id> [--squash | --rebase] [--no-delete-branch]');
    process.exit(1);
  }

  // Must be inside a git repo.
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!inRepo) {
    console.error('Not inside a git repository.');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const patch = await findById(ctx, target, idStr);
  if (!patch) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'merged') {
    console.log(`PR ${idStr} is already merged.`);
    return;
  }

  if (tags?.status === 'closed') {
    console.error(`PR ${idStr} is closed. Reopen it before merging.`);
    process.exit(1);
  }

  const protocolRole = await patchMaintainerRole(ctx, target);
  const baseBranch = tags?.baseBranch ?? 'main';
  const headBranch = tags?.headBranch ?? `pr/${idStr}`;

  // Ensure the PR branch exists locally.
  const branchExists = git(['rev-parse', '--verify', headBranch]);
  if (!branchExists) {
    console.error(`Branch '${headBranch}' not found locally. Run \`gitd pr checkout ${idStr}\` first.`);
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

  for (const line of formatPrMergeSummary({
    id       : idStr,
    title    : String(data.title ?? ''),
    actorDid : ctx.did,
    ownerDid : target.ownerDid,
    repoName : target.repo.name,
    baseBranch,
    headBranch,
    strategy,
    commitCount,
  })) {
    console.log(line);
  }

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
    const cm = spawnSync('git', ['commit', '-m', `Merge PR ${idStr}: ${data.title} (squash)`], {
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
    const mg = spawnSync('git', ['merge', '--no-ff', headBranch, '-m', `Merge PR ${idStr}: ${data.title}`], {
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
  if (isEndpointBackedRecord(patch)) {
    await updateEndpointBackedPatch(ctx, target, patch, data, { ...tags, status: 'merged' }, protocolRole);
  } else {
    const { status, record: updatedPatch } = await patch.update({
      data : data,
      tags : { ...tags, status: 'merged' },
      ...(target.remote ? { protocolRole, store: false } : {}),
    } as any);

    if (status.code >= 300) {
      console.error(`Failed to update PR status: ${status.code} ${status.detail}`);
      process.exit(1);
    }
    if (target.remote) {
      await sendRecordToTarget(ctx, updatedPatch ?? patch, target.ownerDid, 'PR update');
    }
  }

  // Create a merge result record with the actual commit SHA.
  if (isEndpointBackedRecord(patch)) {
    await createEndpointBackedPatchChild(ctx, target, {
      protocolPath    : 'repo/patch/mergeResult',
      schema          : ForgePatchesDefinition.types.mergeResult.schema,
      data            : { mergedBy: ctx.did },
      tags            : { mergeCommit, strategy },
      parentContextId : patch.contextId,
      protocolRole,
      label           : 'PR merge result',
    });
  } else {
    const mergeResult = await ctx.patches.records.create('repo/patch/mergeResult' as any, {
      data            : { mergedBy: ctx.did },
      tags            : { mergeCommit, strategy },
      parentContextId : patch.contextId,
      ...(target.remote ? { protocolRole, store: false } : {}),
    } as any);
    if (target.remote && mergeResult.record) {
      await sendRecordToTarget(ctx, mergeResult.record, target.ownerDid, 'PR merge result');
    }
  }

  // Create a status change record (audit trail).
  if (isEndpointBackedRecord(patch)) {
    await createEndpointBackedPatchChild(ctx, target, {
      protocolPath    : 'repo/patch/statusChange',
      schema          : ForgePatchesDefinition.types.statusChange.schema,
      data            : { reason: `Merged via ${strategy} strategy` },
      tags            : { from: tags?.status ?? 'open', to: 'merged' },
      parentContextId : patch.contextId,
      protocolRole,
      label           : 'PR status change',
    });
  } else {
    const statusChange = await ctx.patches.records.create('repo/patch/statusChange' as any, {
      data            : { reason: `Merged via ${strategy} strategy` },
      tags            : { from: tags?.status ?? 'open', to: 'merged' },
      parentContextId : patch.contextId,
      ...(target.remote ? { protocolRole, store: false } : {}),
    } as any);
    if (target.remote && statusChange.record) {
      await sendRecordToTarget(ctx, statusChange.record, target.ownerDid, 'PR status change');
    }
  }

  const commitLabel = commitCount > 0
    ? ` (${commitCount} commit${commitCount !== 1 ? 's' : ''})`
    : '';
  console.log(`Merged PR ${idStr}${commitLabel} into ${baseBranch} at ${mergeCommit.slice(0, 7)} (strategy: ${strategy})`);

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
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd pr close <id>');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const patch = await findById(ctx, target, idStr);
  if (!patch) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`PR ${idStr} is already closed.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`PR ${idStr} is merged and cannot be closed.`);
    return;
  }

  const protocolRole = await patchMaintainerRole(ctx, target);
  const { status, record: updatedPatch } = await patch.update({
    data : data,
    tags : { ...tags, status: 'closed' },
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to close PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (target.remote) {
    await sendRecordToTarget(ctx, updatedPatch ?? patch, target.ownerDid, 'PR update');
  }

  // Audit trail.
  const statusChange = await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: 'Closed by maintainer' },
    tags            : { from: tags?.status ?? 'open', to: 'closed' },
    parentContextId : patch.contextId,
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);
  if (target.remote && statusChange.record) {
    await sendRecordToTarget(ctx, statusChange.record, target.ownerDid, 'PR status change');
  }

  console.log(`Closed PR ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// pr reopen
// ---------------------------------------------------------------------------

async function prReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd pr reopen <id>');
    process.exit(1);
  }

  const target = await resolvePatchTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const patch = await findById(ctx, target, idStr);
  if (!patch) {
    console.error(`PR ${idStr} not found.`);
    process.exit(1);
  }

  const data = await patch.data.json();
  const tags = patch.tags as Record<string, string> | undefined;

  if (tags?.status === 'open' || tags?.status === 'draft') {
    console.log(`PR ${idStr} is already open.`);
    return;
  }

  if (tags?.status === 'merged') {
    console.log(`PR ${idStr} is merged and cannot be reopened.`);
    return;
  }

  const protocolRole = await patchMaintainerRole(ctx, target);
  const { status, record: updatedPatch } = await patch.update({
    data : data,
    tags : { ...tags, status: 'open' },
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to reopen PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (target.remote) {
    await sendRecordToTarget(ctx, updatedPatch ?? patch, target.ownerDid, 'PR update');
  }

  // Audit trail.
  const statusChange = await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: 'Reopened by maintainer' },
    tags            : { from: tags?.status ?? 'closed', to: 'open' },
    parentContextId : patch.contextId,
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);
  if (target.remote && statusChange.record) {
    await sendRecordToTarget(ctx, statusChange.record, target.ownerDid, 'PR status change');
  }

  console.log(`Reopened PR ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// pr accept
// ---------------------------------------------------------------------------

async function prAccept(ctx: AgentContext, args: string[]): Promise<void> {
  const submitterDid = args[0];
  const idStr = args[1];

  if (!submitterDid || !idStr) {
    console.error('Usage: gitd pr accept <submitter-did> <id> [--repo <name>]');
    process.exit(1);
  }

  const repo = await getRepoContext(ctx, resolveRepoName(args));
  const { records } = await ctx.patches.records.query('repo/patch', {
    from   : submitterDid,
    filter : { tags: { repoDid: ctx.did, repoRecordId: repo.recordId } },
  });

  const externalPatch = findExternalRecord(records, idStr);
  if (!externalPatch) {
    console.error(`External PR ${idStr} from ${submitterDid} not found for ${repo.name}.`);
    process.exit(1);
  }

  const externalTags = externalPatch.tags as Record<string, string> | undefined;
  if (externalTags?.repoDid !== ctx.did || externalTags?.repoRecordId !== repo.recordId) {
    console.error(`External PR ${idStr} does not target ${ctx.did}/${repo.name}.`);
    process.exit(1);
  }

  const data = await externalPatch.data.json();
  const title = typeof data.title === 'string' ? data.title : 'Untitled PR';
  const body = typeof data.body === 'string' ? data.body : '';
  const statusTag = validPatchStatus(externalTags?.status) ? externalTags.status : 'open';
  const baseBranch = externalTags?.baseBranch ?? 'main';
  const sourceDid = externalTags?.sourceDid ?? submitterDid;

  const tags: Record<string, string> = {
    status              : statusTag,
    baseBranch,
    sourceDid,
    submitterDid,
    submissionRecordId  : externalPatch.id,
    submissionContextId : externalPatch.contextId ?? '',
  };
  if (externalTags?.headBranch) { tags.headBranch = externalTags.headBranch; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body },
    tags,
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to accept PR: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (!record) {throw new Error('Failed to create accepted PR record');}

  const copiedRevisions = await copyExternalPatchRevisions(ctx, submitterDid, externalPatch, record);
  const copiedDiscussion = await copyExternalPatchDiscussion(
    ctx,
    submitterDid,
    externalPatch,
    record,
    copiedRevisions.revisionRecordIds,
  );

  console.log(`Accepted external PR ${shortId(externalPatch.id)} as ${shortId(record.id)}: "${title}"`);
  console.log(`  Submitter: ${submitterDid}`);
  console.log(`  Source record: ${externalPatch.id}`);
  console.log(`  Record ID: ${record.id}`);
  const copiedParts = [
    copiedRevisions.revisions > 0 ? `${copiedRevisions.revisions} revision${copiedRevisions.revisions !== 1 ? 's' : ''}` : '',
    copiedRevisions.bundles > 0 ? `${copiedRevisions.bundles} bundle${copiedRevisions.bundles !== 1 ? 's' : ''}` : '',
    copiedDiscussion.reviews > 0 ? `${copiedDiscussion.reviews} review${copiedDiscussion.reviews !== 1 ? 's' : ''}` : '',
    copiedDiscussion.reviewComments > 0 ? `${copiedDiscussion.reviewComments} review comment${copiedDiscussion.reviewComments !== 1 ? 's' : ''}` : '',
    copiedDiscussion.statusChanges > 0 ? `${copiedDiscussion.statusChanges} status change${copiedDiscussion.statusChanges !== 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  if (copiedParts.length > 0) {
    console.log(`  Copied: ${copiedParts.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// pr ignore
// ---------------------------------------------------------------------------

async function prIgnore(ctx: AgentContext, args: string[]): Promise<void> {
  const submitterDid = args[0];
  const idStr = args[1];
  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');

  if (!submitterDid || !idStr) {
    console.error('Usage: gitd pr ignore <submitter-did> <id> [--repo <name>] [--reason <text>]');
    process.exit(1);
  }

  const repo = await getRepoContext(ctx, resolveRepoName(args));
  const { records } = await ctx.patches.records.query('repo/patch', {
    from   : submitterDid,
    filter : { tags: { repoDid: ctx.did, repoRecordId: repo.recordId } },
  });

  const externalPatch = findExternalRecord(records, idStr);
  if (!externalPatch) {
    console.error(`External PR ${idStr} from ${submitterDid} not found for ${repo.name}.`);
    process.exit(1);
  }

  const externalTags = externalPatch.tags as Record<string, string> | undefined;
  if (externalTags?.repoDid !== ctx.did || externalTags?.repoRecordId !== repo.recordId) {
    console.error(`External PR ${idStr} does not target ${ctx.did}/${repo.name}.`);
    process.exit(1);
  }

  const decision = await recordIgnoredSubmission(ctx, repo, 'patch', submitterDid, externalPatch, reason);
  if (decision.status && decision.status.code >= 300) {
    console.error(`Failed to ignore PR: ${decision.status.code} ${decision.status.detail}`);
    process.exit(1);
  }

  if (!decision.created) {
    console.log(`External PR ${shortId(externalPatch.id)} is already ignored.`);
    return;
  }

  console.log(`Ignored external PR ${shortId(externalPatch.id)} from ${submitterDid}.`);
  console.log(`  Decision record: ${decision.record?.id ?? 'unknown'}`);
}

// ---------------------------------------------------------------------------
// pr list
// ---------------------------------------------------------------------------

async function prList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const target = await resolvePatchTarget(ctx, args);

  const filter: Record<string, unknown> = {};
  if (target.repo.contextId) {
    filter.contextId = target.repo.contextId;
  }

  const filterTags: Record<string, string> = {};
  if (statusFilter) {
    filterTags.status = statusFilter;
  }
  if (Object.keys(filterTags).length > 0) {
    filter.tags = filterTags;
  }

  const { records } = await ctx.patches.records.query('repo/patch', {
    ...(target.from ? { from: target.from } : {}),
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
    const id = shortId(rec.id);
    const branches = head ? `${base} <- ${head}` : base;
    console.log(`  ${id} [${st.toUpperCase().padEnd(6)}] ${data.title} (${branches})`);
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

type GitCommandRunner = (args: string[]) => string | null;

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

export type PrBaseBranchInferenceOptions = {
  explicitBase?: string;
  repoDefaultBranch?: string;
  git?: GitCommandRunner;
};

export function inferPrBaseBranch(options: PrBaseBranchInferenceOptions = {}): string {
  const explicitBase = cleanBranchName(options.explicitBase);
  if (explicitBase) { return explicitBase; }

  const repoDefaultBranch = cleanBranchName(options.repoDefaultBranch);
  if (repoDefaultBranch) { return repoDefaultBranch; }

  const runGit = options.git ?? git;
  const configured = cleanBranchName(runGit(['config', '--get', 'enbox.defaultBranch']));
  if (configured) { return configured; }

  const remoteHead = normalizeRemoteHeadBranch(runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']));
  if (remoteHead) { return remoteHead; }

  const initDefault = cleanBranchName(runGit(['config', '--get', 'init.defaultBranch']));
  if (initDefault && branchExists(runGit, initDefault)) { return initDefault; }

  for (const branch of ['main', 'master', 'trunk', 'develop']) {
    if (branchExists(runGit, branch)) { return branch; }
  }

  return 'main';
}

export function inferPrHeadBranch(
  explicitHead?: string,
  gitContext?: Pick<GitContext, 'headBranch'> | null,
  runGit: GitCommandRunner = git,
): string | undefined {
  const explicit = cleanBranchName(explicitHead);
  if (explicit) { return explicit; }

  const fromContext = cleanBranchName(gitContext?.headBranch);
  if (fromContext && fromContext !== 'HEAD') { return fromContext; }

  const current = cleanBranchName(runGit(['rev-parse', '--abbrev-ref', 'HEAD']));
  return current && current !== 'HEAD' ? current : undefined;
}

export type ContributorBranchPublishPlan = {
  remote : string;
  refName : string;
  refspec : string;
  commandText : string;
};

export type ContributorBranchPublishPromptOptions = {
  plan?: ContributorBranchPublishPlan;
  pushRequested?: boolean;
  noPush?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
};

export type ContributorBranchPublishConfirm = (plan: ContributorBranchPublishPlan) => Promise<boolean | 'cancel'>;

export function contributorBranchRefForHead(
  actorDid: string,
  headBranch?: string,
): string | undefined {
  const branch = cleanBranchName(headBranch);
  if (!branch || branch === 'HEAD') { return undefined; }

  const refName = branch.startsWith('refs/heads/')
    ? branch
    : `refs/heads/${branch}`;
  if (isContributorBranchRef(refName, actorDid)) { return refName; }

  const suffix = branch.startsWith('refs/heads/')
    ? branch.slice('refs/heads/'.length)
    : branch;
  if (!isSafeContributorBranchSuffix(suffix)) { return undefined; }

  return `${contributorBranchPrefix(actorDid)}${suffix}`;
}

export function contributorBranchPublishPlan(
  actorDid: string,
  headBranch?: string,
  remote = 'origin',
): ContributorBranchPublishPlan | undefined {
  const refName = contributorBranchRefForHead(actorDid, headBranch);
  if (!refName) { return undefined; }

  const refspec = `HEAD:${refName}`;
  return {
    remote,
    refName,
    refspec,
    commandText: `git push ${shellQuote(remote)} ${shellQuote(refspec)}`,
  };
}

export function shouldPromptContributorBranchPublish(options: ContributorBranchPublishPromptOptions): boolean {
  return Boolean(
    options.plan
    && !options.pushRequested
    && !options.noPush
    && options.stdinIsTTY
    && options.stdoutIsTTY,
  );
}

export async function shouldPublishContributorBranch(
  options: ContributorBranchPublishPromptOptions,
  confirm: ContributorBranchPublishConfirm = confirmContributorBranchPublish,
): Promise<boolean> {
  if (!options.plan) { return false; }
  if (options.pushRequested) { return true; }
  if (!shouldPromptContributorBranchPublish(options)) { return false; }

  const confirmed = await confirm(options.plan);
  if (confirmed === 'cancel') {
    p.cancel('Cancelled.');
    process.exit(130);
  }

  return Boolean(confirmed);
}

async function confirmContributorBranchPublish(plan: ContributorBranchPublishPlan): Promise<boolean | 'cancel'> {
  const confirmed = await p.confirm({
    message: `Publish current branch to ${plan.refName}?`,
  });
  return p.isCancel(confirmed) ? 'cancel' : Boolean(confirmed);
}

async function publishContributorBranchToRemote(plan: ContributorBranchPublishPlan): Promise<void> {
  console.log(`  Publishing branch: ${plan.commandText}`);
  const status = await new Promise<number>((resolveExit, reject) => {
    const child = spawn('git', ['push', plan.remote, plan.refspec], {
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 128));
  });

  if (status !== 0) {
    console.error(`Failed to publish contributor branch ${plan.refName}.`);
    process.exit(status);
  }
}

function cleanBranchName(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSafeContributorBranchSuffix(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !/[\s\0~^:?*[\]\\]/.test(value)
    && !value.split('/').some((part) => part === '' || part === '.' || part.endsWith('.lock'));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) { return value; }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRemoteHeadBranch(value: string | undefined | null): string | undefined {
  const branch = cleanBranchName(value);
  if (!branch) { return undefined; }
  return branch.startsWith('origin/')
    ? branch.slice('origin/'.length)
    : branch;
}

function branchExists(runGit: GitCommandRunner, branch: string): boolean {
  return runGit(['rev-parse', '--verify', `refs/heads/${branch}`]) !== null
    || runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]) !== null;
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
  target?: PatchTarget,
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
      ...(target?.remote ? { store: false } : {}),
    } as any,
  );

  if (revStatus.code >= 300) {
    console.error(`  Warning: failed to create revision record: ${revStatus.code} ${revStatus.detail}`);
    return;
  }
  if (!revisionRecord) {throw new Error('Failed to create revision record');}
  if (target?.remote) {
    await sendRecordToTarget(ctx, revisionRecord, target.ownerDid, 'PR revision');
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

    const { status: bundleStatus, record: bundleRecord } = await ctx.patches.records.create(
      'repo/patch/revision/revisionBundle' as any,
      {
        data       : bundleBytes,
        dataFormat : 'application/x-git-bundle',
        tags       : {
          headCommit : gitCtx.headCommit,
          baseCommit : gitCtx.baseCommit,
          refCount,
          size       : bundleSize,
        },
        parentContextId: revisionRecord.contextId,
        ...(target?.remote ? { store: false } : {}),
      } as any,
    );

    if (bundleStatus.code >= 300) {
      console.error(`  Warning: failed to attach bundle: ${bundleStatus.code} ${bundleStatus.detail}`);
      return;
    }
    if (target?.remote) {
      if (!bundleRecord) { throw new Error('Failed to create PR bundle record'); }
      await sendRecordToTarget(ctx, bundleRecord, target.ownerDid, 'PR bundle');
    }

    console.log(`  Bundle: ${bundleSize} bytes, ${refCount} ref${refCount !== 1 ? 's' : ''}`);
  } finally {
    try { unlinkSync(bundlePath); } catch { /* ignore cleanup errors */ }
  }
}

async function copyExternalPatchRevisions(
  ctx: AgentContext,
  submitterDid: string,
  externalPatch: any,
  acceptedPatch: any,
): Promise<{ revisions: number; bundles: number; revisionRecordIds: Map<string, string> }> {
  const { records: revisions } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from   : submitterDid,
    filter : { contextId: externalPatch.contextId },
  });

  let copiedRevisions = 0;
  let copiedBundles = 0;
  const revisionRecordIds = new Map<string, string>();
  for (const revision of revisions) {
    const revisionData = await revision.data.json();
    const revisionTags = (revision.tags ?? {}) as Record<string, unknown>;
    const { status, record: acceptedRevision } = await ctx.patches.records.create(
      'repo/patch/revision' as any,
      {
        data            : revisionData,
        tags            : revisionTags,
        parentContextId : acceptedPatch.contextId,
      } as any,
    );
    if (status.code >= 300 || !acceptedRevision) {
      console.error(`  Warning: failed to copy revision ${revision.id}: ${status.code} ${status.detail}`);
      continue;
    }
    copiedRevisions++;
    revisionRecordIds.set(revision.id, acceptedRevision.id);

    const { records: bundles } = await ctx.patches.records.query('repo/patch/revision/revisionBundle' as any, {
      from   : submitterDid,
      filter : { contextId: revision.contextId },
    });
    for (const bundle of bundles) {
      const blob = await bundle.data.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const bundleTags = (bundle.tags ?? {}) as Record<string, unknown>;
      const { status: bundleStatus } = await ctx.patches.records.create(
        'repo/patch/revision/revisionBundle' as any,
        {
          data            : bytes,
          dataFormat      : 'application/x-git-bundle',
          tags            : bundleTags,
          parentContextId : acceptedRevision.contextId,
        } as any,
      );
      if (bundleStatus.code >= 300) {
        console.error(`  Warning: failed to copy bundle ${bundle.id}: ${bundleStatus.code} ${bundleStatus.detail}`);
        continue;
      }
      copiedBundles++;
    }
  }

  return { revisions: copiedRevisions, bundles: copiedBundles, revisionRecordIds };
}

async function copyExternalPatchDiscussion(
  ctx: AgentContext,
  submitterDid: string,
  externalPatch: any,
  acceptedPatch: any,
  revisionRecordIds: Map<string, string>,
): Promise<{ reviews: number; reviewComments: number; statusChanges: number }> {
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    from   : submitterDid,
    filter : { contextId: externalPatch.contextId },
  });

  let copiedReviews = 0;
  let copiedReviewComments = 0;
  for (const review of reviews) {
    const reviewData = await review.data.json();
    const reviewTags = { ...((review.tags ?? {}) as Record<string, unknown>) };
    const revisionRecordId = reviewTags.revisionRecordId;
    if (typeof revisionRecordId === 'string' && revisionRecordIds.has(revisionRecordId)) {
      reviewTags.revisionRecordId = revisionRecordIds.get(revisionRecordId);
    }

    const { status, record: acceptedReview } = await ctx.patches.records.create(
      'repo/patch/review' as any,
      {
        data            : reviewData,
        tags            : reviewTags,
        parentContextId : acceptedPatch.contextId,
      } as any,
    );
    if (status.code >= 300 || !acceptedReview) {
      console.error(`  Warning: failed to copy review ${review.id}: ${status.code} ${status.detail}`);
      continue;
    }
    copiedReviews++;

    const { records: reviewComments } = await ctx.patches.records.query('repo/patch/review/reviewComment' as any, {
      from   : submitterDid,
      filter : { contextId: review.contextId },
    });
    for (const reviewComment of reviewComments) {
      const commentData = await reviewComment.data.json();
      const commentTags = (reviewComment.tags ?? {}) as Record<string, unknown>;
      const { status: commentStatus } = await ctx.patches.records.create(
        'repo/patch/review/reviewComment' as any,
        {
          data            : commentData,
          tags            : commentTags,
          parentContextId : acceptedReview.contextId,
        } as any,
      );
      if (commentStatus.code >= 300) {
        console.error(`  Warning: failed to copy review comment ${reviewComment.id}: ${commentStatus.code} ${commentStatus.detail}`);
        continue;
      }
      copiedReviewComments++;
    }
  }

  const { records: statusChanges } = await ctx.patches.records.query('repo/patch/statusChange' as any, {
    from   : submitterDid,
    filter : { contextId: externalPatch.contextId },
  });

  let copiedStatusChanges = 0;
  for (const statusChange of statusChanges) {
    const statusData = await statusChange.data.json();
    const statusTags = (statusChange.tags ?? {}) as Record<string, unknown>;
    const { status } = await ctx.patches.records.create('repo/patch/statusChange' as any, {
      data            : statusData,
      tags            : statusTags,
      parentContextId : acceptedPatch.contextId,
    } as any);
    if (status.code >= 300) {
      console.error(`  Warning: failed to copy PR status change ${statusChange.id}: ${status.code} ${status.detail}`);
      continue;
    }
    copiedStatusChanges++;
  }

  return { reviews: copiedReviews, reviewComments: copiedReviewComments, statusChanges: copiedStatusChanges };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a PR record by its short hash ID (or prefix).
 */
async function findById(
  ctx: AgentContext,
  target: PatchTarget,
  idStr: string,
): Promise<any | undefined> {
  const records = await queryPatchRecords(ctx, target, 'repo/patch', {
    contextId: target.repo.contextId,
  });

  const record = findExternalRecord(records, idStr);
  if (record) {
    return record;
  }

  if (target.remote && idStr.startsWith('bafy')) {
    return {
      id        : idStr,
      contextId : `${target.repo.contextId}/${idStr}`,
      tags      : {},
      data      : {
        json: async () => ({ title: idStr, body: '' }),
      },
    };
  }
}

async function queryPatchRecords(
  ctx: AgentContext,
  target: PatchTarget,
  protocolPath: string,
  filter: Record<string, unknown>,
): Promise<any[]> {
  const { records } = await ctx.patches.records.query(protocolPath as any, {
    ...(target.from ? { from: target.from } : {}),
    filter,
  });
  if (records.length > 0) {
    return records;
  }

  return queryEndpointPatchRecords(ctx, target, protocolPath, filter);
}

async function queryEndpointPatchRecords(
  ctx: AgentContext,
  target: PatchTarget,
  protocolPath: string,
  filter: Record<string, unknown>,
): Promise<any[]> {
  const endpoints = configuredDwnEndpoints(ctx);
  if (endpoints.length === 0) {
    return [];
  }

  const query = await RecordsQuery.create({
    signer : await messageSignerForContext(ctx),
    filter : {
      protocol: ForgePatchesDefinition.protocol,
      protocolPath,
      ...filter,
    },
  });
  const client = new HttpDwnRpcClient();

  for (const endpoint of endpoints) {
    let errorMessage: string | undefined;
    const reply = await client.sendDwnRequest({
      dwnUrl    : endpoint,
      targetDid : target.ownerDid,
      message   : query.message,
      signal    : AbortSignal.timeout(15_000),
      timeoutMs : 15_000,
    }).catch((err) => {
      errorMessage = (err as Error).message;
      return undefined;
    });

    if (process.env.GITD_DEBUG === '1') {
      console.error(`[pr] endpoint query ${protocolPath} ${endpoint} status=${reply?.status.code ?? '<error>'} entries=${reply?.entries?.length ?? 0}${errorMessage ? ` error=${errorMessage}` : ''}`);
    }

    if (reply?.status.code === 200 && (reply.entries?.length ?? 0) > 0) {
      return (reply.entries ?? []).map((entry) => endpointBackedRecord(ctx, target, entry));
    }
  }

  return [];
}

function endpointBackedRecord(ctx: AgentContext, target: PatchTarget, entry: any): any {
  const descriptor = entry.descriptor ?? entry.initialWrite?.descriptor ?? {};
  const recordId = entry.recordId ?? entry.initialWrite?.recordId;
  const contextId = entry.contextId ?? entry.initialWrite?.contextId;

  return {
    __gitdEndpointBackedRecord : true,
    id                         : recordId,
    contextId,
    tags                       : descriptor.tags ?? {},
    rawMessage                 : entry,
    dataSize                   : descriptor.dataSize ?? 0,
    data                       : {
      json : async () => JSON.parse(new TextDecoder().decode(await endpointRecordBytes(ctx, target, entry))),
      blob : async () => new Blob(
        [await endpointRecordBytes(ctx, target, entry)],
        { type: descriptor.dataFormat ?? 'application/octet-stream' },
      ),
    },
  };
}

function isEndpointBackedRecord(record: any): boolean {
  return record?.__gitdEndpointBackedRecord === true;
}

async function endpointRecordBytes(
  ctx: AgentContext,
  target: PatchTarget,
  entry: any,
): Promise<Uint8Array> {
  if (typeof entry.encodedData === 'string') {
    return decodeBase64Url(entry.encodedData);
  }

  const recordId = entry.recordId ?? entry.initialWrite?.recordId;
  if (!recordId) {
    throw new Error('Endpoint record is missing recordId');
  }

  const endpoints = configuredDwnEndpoints(ctx);
  const read = await RecordsRead.create({
    signer : await messageSignerForContext(ctx),
    filter : { recordId },
  });
  const client = new HttpDwnRpcClient();

  for (const endpoint of endpoints) {
    let errorMessage: string | undefined;
    const reply = await client.sendDwnRequest({
      dwnUrl    : endpoint,
      targetDid : target.ownerDid,
      message   : read.message,
      signal    : AbortSignal.timeout(15_000),
      timeoutMs : 15_000,
    }).catch((err) => {
      errorMessage = (err as Error).message;
      return undefined;
    });

    if (process.env.GITD_DEBUG === '1') {
      console.error(`[pr] endpoint read ${recordId} ${endpoint} status=${reply?.status.code ?? '<error>'}${errorMessage ? ` error=${errorMessage}` : ''}`);
    }

    if (reply?.status.code === 200 && reply.entry?.data) {
      return DataStream.toBytes(reply.entry.data);
    }

    const encodedData = (reply?.entry as any)?.encodedData
      ?? (reply?.entry?.recordsWrite as any)?.encodedData;
    if (reply?.status.code === 200 && typeof encodedData === 'string') {
      return decodeBase64Url(encodedData);
    }
  }

  throw new Error(`Endpoint record ${recordId} has no readable data`);
}

async function updateEndpointBackedPatch(
  ctx: AgentContext,
  target: PatchTarget,
  patch: any,
  data: unknown,
  tags: Record<string, string>,
  protocolRole: string | undefined,
): Promise<void> {
  const dataBytes = jsonBody(data);
  const write = await RecordsWrite.create({
    recordId        : patch.id,
    dateCreated     : patch.rawMessage.descriptor.dateCreated,
    protocol        : ForgePatchesDefinition.protocol,
    protocolPath    : 'repo/patch',
    schema          : ForgePatchesDefinition.types.patch.schema,
    parentContextId : target.repo.contextId,
    data            : dataBytes,
    dataFormat      : 'application/json',
    tags,
    published       : true,
    ...(patch.rawMessage.descriptor.recipient ? { recipient: patch.rawMessage.descriptor.recipient } : {}),
    ...(protocolRole ? { protocolRole } : {}),
    signer          : await messageSignerForContext(ctx),
  });

  await processMessageOnTargetEndpoints(ctx, target.ownerDid, write.message, 'PR update', bodyInit(dataBytes));
}

async function createEndpointBackedPatchChild(
  ctx: AgentContext,
  target: PatchTarget,
  options: {
    protocolPath: string;
    schema: string;
    data: unknown;
    tags: Record<string, string>;
    parentContextId: string;
    protocolRole?: string;
    label: string;
  },
): Promise<void> {
  const dataBytes = jsonBody(options.data);
  const write = await RecordsWrite.create({
    protocol        : ForgePatchesDefinition.protocol,
    protocolPath    : options.protocolPath,
    schema          : options.schema,
    parentContextId : options.parentContextId,
    data            : dataBytes,
    dataFormat      : 'application/json',
    tags            : options.tags,
    published       : true,
    recipient       : target.ownerDid,
    ...(options.protocolRole ? { protocolRole: options.protocolRole } : {}),
    signer          : await messageSignerForContext(ctx),
  });

  await processMessageOnTargetEndpoints(ctx, target.ownerDid, write.message, options.label, bodyInit(dataBytes));
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

type PatchTarget = {
  ownerDid : string;
  repo : RepoContext;
  from? : string;
  remote : boolean;
};

export type PrMergeSummary = {
  id : string;
  title : string;
  actorDid : string;
  ownerDid : string;
  repoName : string;
  baseBranch : string;
  headBranch : string;
  strategy : string;
  commitCount : number;
};

export function formatPrMergeSummary(summary: PrMergeSummary): string[] {
  const commitLabel = `${summary.commitCount} commit${summary.commitCount === 1 ? '' : 's'}`;
  return [
    `Merging PR ${summary.id}: ${summary.title}`,
    `  Repo:     ${summary.ownerDid}/${summary.repoName}`,
    `  Actor:    ${summary.actorDid}`,
    `  Base:     ${summary.baseBranch}`,
    `  Head:     ${summary.headBranch}`,
    `  Strategy: ${summary.strategy}`,
    `  Commits:  ${commitLabel}`,
  ];
}

async function resolvePatchTarget(ctx: AgentContext, args: string[]): Promise<PatchTarget> {
  const ownerDid = resolveRepoOwner(args) ?? ctx.did;
  const repo = await getRepoContextForDid(ctx, ownerDid, resolveRepoName(args));
  const from = fromOpt(ctx, ownerDid);
  return { ownerDid, repo, from, remote: ownerDid !== ctx.did };
}

async function patchCreateRole(ctx: AgentContext, target: PatchTarget): Promise<string | undefined> {
  return resolvePatchRole(ctx, target, ['contributor', 'maintainer'], 'contributor');
}

async function ensureRepoWriteAllowed(ctx: AgentContext, target: PatchTarget): Promise<void> {
  const block = await latestActiveBlock(ctx, target);
  if (!block) {
    return;
  }

  const reason = block.data.reason ? ` Reason: ${block.data.reason}` : '';
  console.error(`You are blocked from writing to ${target.ownerDid}/${target.repo.name}.${reason}`);
  process.exit(1);
}

async function patchDiscussionRole(ctx: AgentContext, target: PatchTarget): Promise<string | undefined> {
  return resolvePatchRole(ctx, target, ['contributor', 'maintainer', 'moderator'], 'contributor');
}

async function patchMaintainerRole(
  ctx: AgentContext,
  target: PatchTarget,
): Promise<string | undefined> {
  const protocolRole = await resolvePatchRole(ctx, target, ['maintainer']);
  if (target.remote && !protocolRole) {
    console.error(`You need maintainer access to write maintainer actions on ${target.ownerDid}/${target.repo.name}.`);
    process.exit(1);
  }
  return protocolRole;
}

async function resolvePatchRole(
  ctx: AgentContext,
  target: PatchTarget,
  candidates: readonly RepoRoleName[],
  fallback?: RepoRoleName,
): Promise<string | undefined> {
  if (target.remote && fallback) {
    return `repo:repo/${fallback}`;
  }
  return resolveRepoProtocolRole(ctx, target.ownerDid, target.repo.contextId, candidates, fallback);
}

function findExternalRecord(records: any[], idStr: string): any | undefined {
  return records.find(record => record.id === idStr || shortId(record.id).startsWith(idStr.toLowerCase()));
}

function validPatchStatus(value: string | undefined): value is 'draft' | 'open' | 'closed' | 'merged' {
  return value === 'draft' || value === 'open' || value === 'closed' || value === 'merged';
}
