/**
 * `dwn-git social` — stars, follows, and activity feeds.
 *
 * Stars and follows live on the actor's DWN (data sovereignty).
 * Aggregate counts require an indexer.
 *
 * Usage:
 *   dwn-git star <did>                         Star a repo (by owner DID)
 *   dwn-git unstar <did>                       Remove a star
 *   dwn-git stars                              List starred repos
 *   dwn-git follow <did>                       Follow a user
 *   dwn-git unfollow <did>                     Unfollow a user
 *   dwn-git following                          List followed users
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function socialCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'star': return starRepo(ctx, rest);
    case 'unstar': return unstarRepo(ctx, rest);
    case 'stars': return listStars(ctx);
    case 'follow': return followUser(ctx, rest);
    case 'unfollow': return unfollowUser(ctx, rest);
    case 'following': return listFollowing(ctx);
    default:
      console.error('Usage: dwn-git social <star|unstar|stars|follow|unfollow|following>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// star
// ---------------------------------------------------------------------------

async function starRepo(ctx: AgentContext, args: string[]): Promise<void> {
  const repoDid = args[0];
  if (!repoDid) {
    console.error('Usage: dwn-git social star <repo-owner-did>');
    process.exit(1);
  }

  // Query the target DID's DWN for their repo record.
  // Use `from` to route the query to the remote DWN when the target
  // differs from the local agent.
  const from = repoDid === ctx.did ? undefined : repoDid;
  const { records: repoRecords } = await ctx.repo.records.query('repo', { from });

  if (repoRecords.length === 0) {
    console.error(`No repository found for ${repoDid}.`);
    process.exit(1);
  }

  const repoRecord = repoRecords[0];
  const repoRecordId = repoRecord.id;
  const repoData = await repoRecord.data.json();
  const repoName = repoData.name ?? undefined;

  // Check if already starred.
  const { records: existing } = await ctx.social.records.query('star', {
    filter: { tags: { repoDid } },
  });

  if (existing.length > 0) {
    console.log(`Already starred ${repoDid}.`);
    return;
  }

  const { status } = await ctx.social.records.create('star', {
    data : { repoDid, repoRecordId, repoName },
    tags : { repoDid, repoRecordId },
  });

  if (status.code >= 300) {
    console.error(`Failed to star repo: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Starred ${repoDid}${repoName ? ` (${repoName})` : ''}.`);
}

// ---------------------------------------------------------------------------
// unstar
// ---------------------------------------------------------------------------

async function unstarRepo(ctx: AgentContext, args: string[]): Promise<void> {
  const repoDid = args[0];
  if (!repoDid) {
    console.error('Usage: dwn-git social unstar <repo-owner-did>');
    process.exit(1);
  }

  const { records } = await ctx.social.records.query('star', {
    filter: { tags: { repoDid } },
  });

  if (records.length === 0) {
    console.error(`No star found for ${repoDid}.`);
    process.exit(1);
  }

  const { status } = await records[0].delete();
  if (status.code >= 300) {
    console.error(`Failed to unstar: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Unstarred ${repoDid}.`);
}

// ---------------------------------------------------------------------------
// stars
// ---------------------------------------------------------------------------

async function listStars(ctx: AgentContext): Promise<void> {
  const { records } = await ctx.social.records.query('star');

  if (records.length === 0) {
    console.log('No starred repos.');
    return;
  }

  console.log(`Starred repos (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    console.log(`  ${data.repoDid}${data.repoName ? ` (${data.repoName})` : ''}  ${date}`);
  }
}

// ---------------------------------------------------------------------------
// follow
// ---------------------------------------------------------------------------

async function followUser(ctx: AgentContext, args: string[]): Promise<void> {
  const targetDid = args[0];
  if (!targetDid) {
    console.error('Usage: dwn-git social follow <did>');
    process.exit(1);
  }

  // Check if already following.
  const { records: existing } = await ctx.social.records.query('follow', {
    filter: { tags: { targetDid } },
  });

  if (existing.length > 0) {
    console.log(`Already following ${targetDid}.`);
    return;
  }

  const { status } = await ctx.social.records.create('follow', {
    data : { targetDid },
    tags : { targetDid },
  });

  if (status.code >= 300) {
    console.error(`Failed to follow: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Following ${targetDid}.`);
}

// ---------------------------------------------------------------------------
// unfollow
// ---------------------------------------------------------------------------

async function unfollowUser(ctx: AgentContext, args: string[]): Promise<void> {
  const targetDid = args[0];
  if (!targetDid) {
    console.error('Usage: dwn-git social unfollow <did>');
    process.exit(1);
  }

  const { records } = await ctx.social.records.query('follow', {
    filter: { tags: { targetDid } },
  });

  if (records.length === 0) {
    console.error(`Not following ${targetDid}.`);
    process.exit(1);
  }

  const { status } = await records[0].delete();
  if (status.code >= 300) {
    console.error(`Failed to unfollow: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Unfollowed ${targetDid}.`);
}

// ---------------------------------------------------------------------------
// following
// ---------------------------------------------------------------------------

async function listFollowing(ctx: AgentContext): Promise<void> {
  const { records } = await ctx.social.records.query('follow');

  if (records.length === 0) {
    console.log('Not following anyone.');
    return;
  }

  console.log(`Following (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    console.log(`  ${data.targetDid}${data.alias ? ` (${data.alias})` : ''}  ${date}`);
  }
}
