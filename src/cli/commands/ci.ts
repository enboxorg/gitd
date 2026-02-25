/**
 * `gitd ci` — view CI check suites and check runs.
 *
 * Usage:
 *   gitd ci status [<commit>]              Show latest check suite status
 *   gitd ci list [--limit <n>]             List recent check suites
 *   gitd ci show <suite-id>                Show check suite details + runs
 *   gitd ci create <commit> [--app <name>] Create a check suite (for CI bots)
 *   gitd ci run <suite-id> <name>          Add a check run to a suite
 *   gitd ci update <run-id> --status <s>   Update a check run status
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function ciCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'status': return ciStatus(ctx, rest);
    case 'list':
    case 'ls': return ciList(ctx, rest);
    case 'show': return ciShow(ctx, rest);
    case 'create': return ciCreate(ctx, rest);
    case 'run': return ciRun(ctx, rest);
    case 'update': return ciUpdate(ctx, rest);
    default:
      console.error('Usage: gitd ci <status|list|show|create|run|update>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// ci status
// ---------------------------------------------------------------------------

async function ciStatus(ctx: AgentContext, args: string[]): Promise<void> {
  const commitFilter = args[0];
  const repoContextId = await getRepoContextId(ctx);

  const filter: Record<string, unknown> = { contextId: repoContextId };
  if (commitFilter) {
    filter.tags = { commitSha: commitFilter };
  }

  const { records } = await ctx.ci.records.query('repo/checkSuite' as any, {
    filter,
    dateSort   : DateSort.CreatedDescending,
    pagination : { limit: 1 },
  });

  if (records.length === 0) {
    console.log('No CI check suites found.');
    return;
  }

  const suite = records[0];
  const data = await suite.data.json();
  const tags = suite.tags as Record<string, string> | undefined;
  const status = tags?.status ?? 'unknown';
  const conclusion = tags?.conclusion;
  const commit = tags?.commitSha ?? '?';
  const branch = tags?.branch;
  const date = suite.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';

  console.log(`CI Status: ${status.toUpperCase()}${conclusion ? ` (${conclusion})` : ''}`);
  console.log(`  Commit:  ${commit}${branch ? ` (${branch})` : ''}`);
  console.log(`  App:     ${data.app ?? 'unknown'}`);
  console.log(`  Date:    ${date}`);
  console.log(`  ID:      ${suite.id}`);
}

// ---------------------------------------------------------------------------
// ci list
// ---------------------------------------------------------------------------

async function ciList(ctx: AgentContext, args: string[]): Promise<void> {
  const limit = parseInt(flagValue(args, '--limit') ?? '10', 10);
  const repoContextId = await getRepoContextId(ctx);

  const { records } = await ctx.ci.records.query('repo/checkSuite' as any, {
    filter     : { contextId: repoContextId },
    dateSort   : DateSort.CreatedDescending,
    pagination : { limit },
  });

  if (records.length === 0) {
    console.log('No CI check suites found.');
    return;
  }

  console.log(`Check suites (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const status = tags?.status ?? 'unknown';
    const conclusion = tags?.conclusion;
    const commit = (tags?.commitSha ?? '?').slice(0, 8);
    const branch = tags?.branch;
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const statusStr = conclusion ? `${status}:${conclusion}` : status;
    console.log(`  [${statusStr.toUpperCase().padEnd(18)}] ${commit} ${data.app ?? ''}${branch ? ` (${branch})` : ''}  ${date}`);
    console.log(`${''.padEnd(24)}id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// ci show
// ---------------------------------------------------------------------------

async function ciShow(ctx: AgentContext, args: string[]): Promise<void> {
  const suiteId = args[0];
  if (!suiteId) {
    console.error('Usage: gitd ci show <suite-id>');
    process.exit(1);
  }

  const { records: suites } = await ctx.ci.records.query('repo/checkSuite' as any, {
    filter: { recordId: suiteId },
  });

  if (suites.length === 0) {
    console.error(`Check suite ${suiteId} not found.`);
    process.exit(1);
  }

  const suite = suites[0];
  const data = await suite.data.json();
  const tags = suite.tags as Record<string, string> | undefined;
  const status = tags?.status ?? 'unknown';
  const conclusion = tags?.conclusion;
  const commit = tags?.commitSha ?? '?';
  const branch = tags?.branch;
  const date = suite.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';

  console.log(`Check Suite: ${data.app ?? 'unknown'}`);
  console.log(`  Status:     ${status.toUpperCase()}${conclusion ? ` (${conclusion})` : ''}`);
  console.log(`  Commit:     ${commit}${branch ? ` (${branch})` : ''}`);
  console.log(`  Created:    ${date}`);
  console.log(`  ID:         ${suite.id}`);

  // Fetch check runs.
  const { records: runs } = await ctx.ci.records.query('repo/checkSuite/checkRun' as any, {
    filter: { contextId: suite.contextId },
  });

  if (runs.length > 0) {
    console.log('');
    console.log(`  Check runs (${runs.length}):`);
    console.log('  ---');
    for (const run of runs) {
      const runData = await run.data.json();
      const runTags = run.tags as Record<string, string> | undefined;
      const runStatus = runTags?.status ?? 'unknown';
      const runConclusion = runTags?.conclusion;
      const runName = runTags?.name ?? 'unnamed';
      const statusStr = runConclusion ? `${runStatus}:${runConclusion}` : runStatus;
      console.log(`  [${statusStr.toUpperCase()}] ${runName}`);
      if (runData.output) {
        console.log(`    ${runData.output.title}: ${runData.output.summary}`);
      }
      console.log('  ---');
    }
  }
}

// ---------------------------------------------------------------------------
// ci create
// ---------------------------------------------------------------------------

async function ciCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const commitSha = args[0];
  const app = flagValue(args, '--app') ?? 'gitd-ci';
  const branch = flagValue(args, '--branch');

  if (!commitSha) {
    console.error('Usage: gitd ci create <commit-sha> [--app <name>] [--branch <branch>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  const tags: Record<string, string> = {
    commitSha,
    status: 'queued',
  };
  if (branch) { tags.branch = branch; }

  const { status, record } = await ctx.ci.records.create('repo/checkSuite' as any, {
    data            : { app },
    tags,
    parentContextId : repoContextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create check suite: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created check suite for ${commitSha.slice(0, 8)} (app: ${app})`);
  console.log(`  Suite ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// ci run
// ---------------------------------------------------------------------------

async function ciRun(ctx: AgentContext, args: string[]): Promise<void> {
  const suiteId = args[0];
  const name = args[1];

  if (!suiteId || !name) {
    console.error('Usage: gitd ci run <suite-id> <name>');
    process.exit(1);
  }

  // Look up the suite to get its contextId.
  const { records: suites } = await ctx.ci.records.query('repo/checkSuite' as any, {
    filter: { recordId: suiteId },
  });

  if (suites.length === 0) {
    console.error(`Check suite ${suiteId} not found.`);
    process.exit(1);
  }

  const { status, record } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
    data            : {},
    tags            : { name, status: 'queued' },
    parentContextId : suites[0].contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create check run: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created check run "${name}" in suite ${suiteId.slice(0, 8)}...`);
  console.log(`  Run ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// ci update
// ---------------------------------------------------------------------------

async function ciUpdate(ctx: AgentContext, args: string[]): Promise<void> {
  const runId = args[0];
  const newStatus = flagValue(args, '--status');
  const conclusion = flagValue(args, '--conclusion');

  if (!runId || !newStatus) {
    console.error('Usage: gitd ci update <run-id> --status <queued|in_progress|completed> [--conclusion <success|failure|cancelled|skipped>]');
    process.exit(1);
  }

  if (!['queued', 'in_progress', 'completed'].includes(newStatus)) {
    console.error(`Invalid status: ${newStatus}. Must be queued, in_progress, or completed.`);
    process.exit(1);
  }

  // Find the run record.
  const { records: runs } = await ctx.ci.records.query('repo/checkSuite/checkRun' as any, {
    filter: { recordId: runId },
  });

  if (runs.length === 0) {
    console.error(`Check run ${runId} not found.`);
    process.exit(1);
  }

  const run = runs[0];
  const existingData = await run.data.json();
  const existingTags = run.tags as Record<string, string> | undefined;

  const updatedTags: Record<string, string> = { ...existingTags, status: newStatus };
  if (conclusion) { updatedTags.conclusion = conclusion; }

  const { status } = await run.update({
    data : existingData,
    tags : updatedTags,
  });

  if (status.code >= 300) {
    console.error(`Failed to update check run: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Updated check run ${runId.slice(0, 8)}... → ${newStatus}${conclusion ? ` (${conclusion})` : ''}`);
}
