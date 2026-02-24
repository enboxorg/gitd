/**
 * `dwn-git wiki` — collaborative documentation pages.
 *
 * Usage:
 *   dwn-git wiki create <slug> <title> [--body <markdown>]
 *   dwn-git wiki show <slug>
 *   dwn-git wiki edit <slug> --body <markdown> [--summary <text>]
 *   dwn-git wiki list
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function wikiCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return wikiCreate(ctx, rest);
    case 'show': return wikiShow(ctx, rest);
    case 'edit': return wikiEdit(ctx, rest);
    case 'list':
    case 'ls': return wikiList(ctx, rest);
    default:
      console.error('Usage: dwn-git wiki <create|show|edit|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// wiki create
// ---------------------------------------------------------------------------

async function wikiCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const slug = args[0];
  const title = args[1];
  const body = flagValue(args, '--body') ?? '';

  if (!slug || !title) {
    console.error('Usage: dwn-git wiki create <slug> <title> [--body <markdown>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  // Check for duplicate slug.
  const existing = await findPageBySlug(ctx, repoContextId, slug);
  if (existing) {
    console.error(`Wiki page "${slug}" already exists. Use \`dwn-git wiki edit ${slug}\` to update it.`);
    process.exit(1);
  }

  const { status, record } = await ctx.wiki.records.create('repo/page' as any, {
    data            : body,
    dataFormat      : 'text/markdown',
    tags            : { slug, title },
    parentContextId : repoContextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create wiki page: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Created wiki page: ${title} (/${slug})`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// wiki show
// ---------------------------------------------------------------------------

async function wikiShow(ctx: AgentContext, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: dwn-git wiki show <slug>');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const page = await findPageBySlug(ctx, repoContextId, slug);
  if (!page) {
    console.error(`Wiki page "${slug}" not found.`);
    process.exit(1);
  }

  const tags = page.tags as Record<string, string> | undefined;
  const title = tags?.title ?? slug;
  const date = page.dateCreated?.slice(0, 10) ?? '';
  const modified = (page as any).dateModified?.slice(0, 10) ?? date;

  // Wiki pages use text/markdown as the data format.
  const blob = await page.data.blob();
  const content = await blob.text();

  console.log(`Wiki: ${title} (/${slug})`);
  console.log(`  Created:  ${date}`);
  if (modified !== date) {
    console.log(`  Modified: ${modified}`);
  }
  console.log(`  ID:       ${page.id}`);
  console.log('');
  console.log(content);
}

// ---------------------------------------------------------------------------
// wiki edit
// ---------------------------------------------------------------------------

async function wikiEdit(ctx: AgentContext, args: string[]): Promise<void> {
  const slug = args[0];
  const body = flagValue(args, '--body');
  const summary = flagValue(args, '--summary');

  if (!slug || !body) {
    console.error('Usage: dwn-git wiki edit <slug> --body <markdown> [--summary <text>]');
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);
  const page = await findPageBySlug(ctx, repoContextId, slug);
  if (!page) {
    console.error(`Wiki page "${slug}" not found. Use \`dwn-git wiki create\` first.`);
    process.exit(1);
  }

  const tags = page.tags as Record<string, string> | undefined;

  const { status } = await page.update({
    data       : body,
    dataFormat : 'text/markdown',
    tags       : { ...tags },
  });

  if (status.code >= 300) {
    console.error(`Failed to update wiki page: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  // Create a history entry (immutable audit trail).
  await ctx.wiki.records.create('repo/page/pageHistory' as any, {
    data            : { editedBy: ctx.did, summary: summary ?? 'Page updated' },
    parentContextId : page.contextId,
  } as any);

  console.log(`Updated wiki page: ${tags?.title ?? slug} (/${slug})`);
}

// ---------------------------------------------------------------------------
// wiki list
// ---------------------------------------------------------------------------

async function wikiList(ctx: AgentContext, _args: string[]): Promise<void> {
  const repoContextId = await getRepoContextId(ctx);

  const { records } = await ctx.wiki.records.query('repo/page' as any, {
    filter: { contextId: repoContextId },
  });

  if (records.length === 0) {
    console.log('No wiki pages found.');
    return;
  }

  console.log(`Wiki pages (${records.length}):\n`);
  for (const rec of records) {
    const tags = rec.tags as Record<string, string> | undefined;
    const slug = tags?.slug ?? '?';
    const title = tags?.title ?? slug;
    const date = (rec as any).dateModified?.slice(0, 10) ?? rec.dateCreated?.slice(0, 10) ?? '';
    console.log(`  /${slug.padEnd(20)} ${title}  ${date}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findPageBySlug(
  ctx: AgentContext,
  repoContextId: string,
  slug: string,
): Promise<any | undefined> {
  const { records } = await ctx.wiki.records.query('repo/page' as any, {
    filter: {
      contextId : repoContextId,
      tags      : { slug },
    },
  });
  return records[0];
}
