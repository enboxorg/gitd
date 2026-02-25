/**
 * `gitd release` — create, list, and show releases with immutable assets.
 *
 * Usage:
 *   gitd release create <tag> [--name <name>] [--body <text>] [--commit <sha>] [--prerelease] [--draft]
 *   gitd release show <tag>
 *   gitd release list [--limit <n>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { getRepoContextId } from '../repo-context.js';
import { flagValue, resolveRepoName } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function releaseCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return releaseCreate(ctx, rest);
    case 'show': return releaseShow(ctx, rest);
    case 'list':
    case 'ls': return releaseList(ctx, rest);
    default:
      console.error('Usage: gitd release <create|show|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// release create
// ---------------------------------------------------------------------------

async function releaseCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const tagName = args[0];
  const name = flagValue(args, '--name') ?? tagName;
  const body = flagValue(args, '--body') ?? '';
  const commitSha = flagValue(args, '--commit');
  const prerelease = args.includes('--prerelease');
  const draft = args.includes('--draft');

  if (!tagName) {
    console.error('Usage: gitd release create <tag> [--name <name>] [--body <text>] [--commit <sha>] [--prerelease] [--draft]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

  const tags: Record<string, unknown> = { tagName };
  if (commitSha) { tags.commitSha = commitSha; }
  if (prerelease) { tags.prerelease = true; }
  if (draft) { tags.draft = true; }

  const { status, record } = await ctx.releases.records.create('repo/release' as any, {
    data            : { name, body },
    tags,
    parentContextId : repoContextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create release: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created release ${tagName}${name !== tagName ? ` ("${name}")` : ''}`);
  console.log(`  Record ID: ${record.id}`);
  if (prerelease) { console.log('  Pre-release: yes'); }
  if (draft) { console.log('  Draft: yes'); }
}

// ---------------------------------------------------------------------------
// release show
// ---------------------------------------------------------------------------

async function releaseShow(ctx: AgentContext, args: string[]): Promise<void> {
  const tagName = args[0];
  if (!tagName) {
    console.error('Usage: gitd release show <tag>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const release = await findReleaseByTag(ctx, repoContextId, tagName);
  if (!release) {
    console.error(`Release ${tagName} not found.`);
    process.exit(1);
  }

  const data = await release.data.json();
  const tags = release.tags as Record<string, unknown> | undefined;
  const date = release.dateCreated?.slice(0, 10) ?? '';
  const commit = tags?.commitSha as string | undefined;
  const prerelease = tags?.prerelease === true;
  const draft = tags?.draft === true;

  console.log(`Release: ${data.name ?? tagName}`);
  console.log(`  Tag:        ${tags?.tagName ?? tagName}`);
  if (commit) { console.log(`  Commit:     ${commit}`); }
  console.log(`  Created:    ${date}`);
  if (prerelease) { console.log('  Pre-release: yes'); }
  if (draft) { console.log('  Draft: yes'); }
  console.log(`  ID:         ${release.id}`);

  if (data.body) {
    console.log('');
    console.log(`  ${data.body}`);
  }

  // Fetch assets.
  const { records: assets } = await ctx.releases.records.query('repo/release/asset' as any, {
    filter: { contextId: release.contextId },
  });

  if (assets.length > 0) {
    console.log('');
    console.log(`  Assets (${assets.length}):`);
    for (const asset of assets) {
      const assetTags = asset.tags as Record<string, unknown> | undefined;
      const filename = assetTags?.filename ?? 'unknown';
      const size = assetTags?.size as number | undefined;
      const sizeStr = size ? ` (${formatBytes(size)})` : '';
      console.log(`    ${filename}${sizeStr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// release list
// ---------------------------------------------------------------------------

async function releaseList(ctx: AgentContext, args: string[]): Promise<void> {
  const limit = parseInt(flagValue(args, '--limit') ?? '20', 10);
  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));

  const { records } = await ctx.releases.records.query('repo/release' as any, {
    filter     : { contextId: repoContextId },
    dateSort   : DateSort.CreatedDescending,
    pagination : { limit },
  });

  if (records.length === 0) {
    console.log('No releases found.');
    return;
  }

  console.log(`Releases (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, unknown> | undefined;
    const tagName = tags?.tagName ?? '?';
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const prerelease = tags?.prerelease === true ? ' [pre-release]' : '';
    const draft = tags?.draft === true ? ' [draft]' : '';
    console.log(`  ${String(tagName).padEnd(20)} ${data.name ?? ''}${prerelease}${draft}  ${date}`);
    console.log(`${''.padEnd(22)}id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findReleaseByTag(
  ctx: AgentContext,
  repoContextId: string,
  tagName: string,
): Promise<any | undefined> {
  const { records } = await ctx.releases.records.query('repo/release' as any, {
    filter: {
      contextId : repoContextId,
      tags      : { tagName },
    },
  });
  return records[0];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
