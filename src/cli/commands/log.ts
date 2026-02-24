/**
 * `dwn-git log` — show recent forge activity.
 *
 * Displays recent issues, patches, and ref updates in reverse chronological
 * order, giving a unified activity feed for the repository.
 *
 * Usage: dwn-git log [--limit <n>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActivityEntry = {
  type : 'issue' | 'patch' | 'ref';
  date : string;
  line : string;
};

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function logCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const limitStr = flagValue(args, '--limit') ?? flagValue(args, '-n') ?? '20';
  const limit = parseInt(limitStr, 10);

  const repoContextId = await getRepoContextId(ctx);

  const entries: ActivityEntry[] = [];

  // Fetch recent issues.
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repoContextId },
  });

  for (const rec of issues) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const st = tags?.status ?? '?';
    const num = data.number ?? tags?.number ?? '?';
    entries.push({
      type : 'issue',
      date : rec.dateCreated ?? '',
      line : `issue  #${String(num).padEnd(4)} [${st.toUpperCase().padEnd(6)}] ${data.title}`,
    });
  }

  // Fetch recent patches.
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repoContextId },
  });

  for (const rec of patches) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const st = tags?.status ?? '?';
    const num = data.number ?? tags?.number ?? '?';
    entries.push({
      type : 'patch',
      date : rec.dateCreated ?? '',
      line : `patch  #${String(num).padEnd(4)} [${st.toUpperCase().padEnd(6)}] ${data.title}`,
    });
  }

  // Fetch recent ref updates.
  const { records: refs } = await ctx.refs.records.query('repo/ref' as any, {
    filter: { contextId: repoContextId },
  });

  for (const rec of refs) {
    const data = await rec.data.json();
    const shortSha = data.target?.slice(0, 7) ?? '???????';
    entries.push({
      type : 'ref',
      date : rec.dateCreated ?? '',
      line : `push   ${data.name?.replace('refs/heads/', '').replace('refs/tags/', 'tag ')} -> ${shortSha}`,
    });
  }

  // Sort by date descending.
  entries.sort((a, b) => b.date.localeCompare(a.date));

  // Apply limit.
  const display = entries.slice(0, limit);

  if (display.length === 0) {
    console.log('No activity yet.');
    return;
  }

  console.log(`Recent activity (${display.length}):\n`);
  for (const entry of display) {
    const date = entry.date.slice(0, 10);
    console.log(`  ${date}  ${entry.line}`);
  }
}


