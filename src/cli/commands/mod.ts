/**
 * `gitd mod` — focused repository moderator management.
 *
 * Usage:
 *   gitd mod add <did> [--alias <name>]      Grant moderator role
 *   gitd mod remove <did>                    Revoke moderator role
 *   gitd mod list                            List repository moderators
 *
 * @module
 */

import type { AgentContext } from '../agent.js';
import type { ModerationEventData } from '../../repo.js';

import { repoCommand } from './repo.js';
import { sendRecordToTarget } from '../record-send.js';
import { flagValue, resolveRepoName, resolveRepoOwner } from '../flags.js';
import { getRepoContextForDid, getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function modCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add': return repoCommand(ctx, ['add-moderator', ...rest]);
    case 'remove':
    case 'rm': return repoCommand(ctx, ['remove-moderator', ...rest]);
    case 'list':
    case 'ls': return modList(ctx, rest);
    case 'block': return moderationTargetDid(ctx, rest, 'block');
    case 'unblock': return moderationTargetDid(ctx, rest, 'unblock');
    case 'lock': return moderationLock(ctx, rest, 'lock');
    case 'unlock': return moderationLock(ctx, rest, 'unlock');
    case 'hide-comment': return moderationComment(ctx, rest, 'hideComment');
    case 'unhide-comment': return moderationComment(ctx, rest, 'unhideComment');
    case 'delete-comment': return moderationComment(ctx, rest, 'deleteComment');
    case 'report': return moderationReport(ctx, rest);
    case 'resolve-report': return moderationReportDecision(ctx, rest, 'resolveReport');
    case 'dismiss-report': return moderationReportDecision(ctx, rest, 'dismissReport');
    case 'interaction-limit': return moderationInteractionLimit(ctx, rest);
    default:
      console.error('Usage: gitd mod <add|remove|list|block|unblock|lock|unlock|hide-comment|unhide-comment|delete-comment|report|resolve-report|dismiss-report|interaction-limit>');
      process.exit(1);
  }
}

async function modList(ctx: AgentContext, args: string[]): Promise<void> {
  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  const { records } = await ctx.repo.records.query('repo/moderator' as any, {
    filter: { contextId: repoContextId },
  });

  if (records.length === 0) {
    console.log('No moderators found.');
    return;
  }

  console.log(`Moderators (${records.length}):`);
  for (const record of records) {
    const data = await record.data.json();
    const alias = data.alias ? ` (${data.alias})` : '';
    console.log(`  - ${data.did}${alias}`);
  }
}

async function moderationTargetDid(
  ctx: AgentContext,
  args: string[],
  action: 'block' | 'unblock',
): Promise<void> {
  const did = args[0];
  if (!did) {
    console.error(`Usage: gitd mod ${action} <did> [--reason <reason>] [--repo <name>] [--owner <did>]`);
    process.exit(1);
  }

  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');
  await createModerationEvent(ctx, args, {
    action,
    targetDid  : did,
    targetKind : 'repo',
    reason,
  });

  if (action === 'block') {
    await revokeBlockedRoles(ctx, args, did);
  }

  console.log(`${action === 'block' ? 'Blocked' : 'Unblocked'} ${did}.`);
}

async function moderationLock(
  ctx: AgentContext,
  args: string[],
  action: 'lock' | 'unlock',
): Promise<void> {
  const targetKind = parseDiscussionKind(args[0]);
  const targetId = args[1];
  if (!targetKind || !targetId) {
    console.error(`Usage: gitd mod ${action} <issue|pr> <id> [--reason <reason>] [--repo <name>] [--owner <did>]`);
    process.exit(1);
  }

  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');
  await createModerationEvent(ctx, args, {
    action,
    targetKind,
    targetId,
    reason,
  });

  console.log(`${action === 'lock' ? 'Locked' : 'Unlocked'} ${targetKind} ${targetId}.`);
}

async function moderationComment(
  ctx: AgentContext,
  args: string[],
  action: 'hideComment' | 'unhideComment' | 'deleteComment',
): Promise<void> {
  const targetId = args[0];
  if (!targetId) {
    const command = action === 'hideComment'
      ? 'hide-comment'
      : action === 'unhideComment'
        ? 'unhide-comment'
        : 'delete-comment';
    console.error(`Usage: gitd mod ${command} <comment-id> [--kind <issue|pr>] [--reason <reason>] [--repo <name>] [--owner <did>]`);
    process.exit(1);
  }

  const kind = flagValue(args, '--kind') === 'pr' ? 'prComment' : 'issueComment';
  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');
  await createModerationEvent(ctx, args, {
    action,
    targetKind: kind,
    targetId,
    reason,
  });

  const label = action === 'hideComment'
    ? 'Hid'
    : action === 'unhideComment'
      ? 'Unhid'
      : 'Deleted';
  console.log(`${label} comment ${targetId}.`);
}

async function moderationReport(ctx: AgentContext, args: string[]): Promise<void> {
  const targetId = args[0];
  if (!targetId) {
    console.error('Usage: gitd mod report <record-id> [--kind <issue|pr|issue-comment|pr-comment>] [--reason <reason>] [--repo <name>] [--owner <did>]');
    process.exit(1);
  }

  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');
  await createModerationEvent(ctx, args, {
    action       : 'report',
    targetKind   : parseReportKind(flagValue(args, '--kind')),
    targetId,
    reason,
    reportStatus : 'open',
  });
  console.log(`Reported ${targetId}.`);
}

async function moderationReportDecision(
  ctx: AgentContext,
  args: string[],
  action: 'resolveReport' | 'dismissReport',
): Promise<void> {
  const targetId = args[0];
  if (!targetId) {
    const command = action === 'resolveReport' ? 'resolve-report' : 'dismiss-report';
    console.error(`Usage: gitd mod ${command} <report-id> [--reason <reason>] [--repo <name>] [--owner <did>]`);
    process.exit(1);
  }

  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');
  await createModerationEvent(ctx, args, {
    action,
    targetKind   : 'report',
    targetId,
    reason,
    reportStatus : action === 'resolveReport' ? 'resolved' : 'dismissed',
  });
  console.log(`${action === 'resolveReport' ? 'Resolved' : 'Dismissed'} report ${targetId}.`);
}

async function moderationInteractionLimit(ctx: AgentContext, args: string[]): Promise<void> {
  const limit = args[0] as ModerationEventData['interactionLimit'] | undefined;
  if (!limit || !['off', 'contributors', 'collaborators'].includes(limit)) {
    console.error('Usage: gitd mod interaction-limit <off|contributors|collaborators> [--duration <duration>] [--repo <name>] [--owner <did>]');
    process.exit(1);
  }

  await createModerationEvent(ctx, args, {
    action           : 'interactionLimit',
    targetKind       : 'repo',
    interactionLimit : limit,
    duration         : flagValue(args, '--duration'),
  });
  console.log(`Set interaction limit: ${limit}.`);
}

async function createModerationEvent(
  ctx: AgentContext,
  args: string[],
  partial: Omit<ModerationEventData, 'actorDid' | 'createdAt'>,
): Promise<any> {
  const ownerDid = resolveRepoOwner(args) ?? ctx.did;
  const repoName = resolveRepoName(args);
  const repo = await getRepoContextForDid(ctx, ownerDid, repoName);
  const remote = ownerDid !== ctx.did;
  const roleName = remote ? 'moderator' : undefined;
  const protocolRole = roleName ? `repo/${roleName}` : undefined;
  const data: ModerationEventData = {
    ...partial,
    actorDid  : ctx.did,
    createdAt : new Date().toISOString(),
  };
  const tags = moderationTags(data);
  for (const line of formatModerationEventSummary({
    action   : data.action,
    actorDid : ctx.did,
    ownerDid,
    repoName : repo.name,
    target   : moderationTargetLabel(data),
    reason   : data.reason,
  })) {
    console.log(line);
  }

  const { status, record } = await ctx.repo.records.create('repo/moderationEvent' as any, {
    data,
    tags,
    parentContextId: repo.contextId,
    ...(remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create moderation event: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (!record) { throw new Error('Failed to create moderation event record'); }

  if (remote) {
    await sendRecordToTarget(ctx, record, ownerDid, 'moderation event');
  }

  return record;
}

function moderationTags(data: ModerationEventData): Record<string, string> {
  const tags: Record<string, string> = {
    action   : data.action,
    actorDid : data.actorDid,
  };
  if (data.targetDid) { tags.targetDid = data.targetDid; }
  if (data.targetKind) { tags.targetKind = data.targetKind; }
  if (data.targetId) { tags.targetId = data.targetId; }
  if (data.reportStatus) { tags.reportStatus = data.reportStatus; }
  if (data.interactionLimit) { tags.interactionLimit = data.interactionLimit; }
  return tags;
}

async function revokeBlockedRoles(ctx: AgentContext, args: string[], did: string): Promise<void> {
  const ownerDid = resolveRepoOwner(args) ?? ctx.did;
  if (ownerDid !== ctx.did) {
    return;
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  for (const role of ['contributor', 'moderator'] as const) {
    const { records } = await ctx.repo.records.query(`repo/${role}` as any, {
      filter: { contextId: repoContextId, tags: { did } },
    });
    for (const record of records) {
      await record.delete();
    }
  }
}

function parseDiscussionKind(value: string | undefined): 'issue' | 'pr' | undefined {
  if (value === 'issue' || value === 'pr') {
    return value;
  }
  return undefined;
}

function parseReportKind(value: string | undefined): ModerationEventData['targetKind'] {
  if (value === 'pr') { return 'pr'; }
  if (value === 'issue-comment') { return 'issueComment'; }
  if (value === 'pr-comment') { return 'prComment'; }
  return 'issue';
}

export type ModerationEventSummary = {
  action : string;
  actorDid : string;
  ownerDid : string;
  repoName : string;
  target : string;
  reason?: string;
};

export function formatModerationEventSummary(summary: ModerationEventSummary): string[] {
  return [
    `Moderation: ${summary.action}`,
    `  Repo:   ${summary.ownerDid}/${summary.repoName}`,
    `  Actor:  ${summary.actorDid}`,
    `  Target: ${summary.target}`,
    ...(summary.reason ? [`  Reason: ${summary.reason}`] : []),
  ];
}

function moderationTargetLabel(data: ModerationEventData): string {
  if (data.targetDid) { return data.targetDid; }
  if (data.targetId && data.targetKind) { return `${data.targetKind}:${data.targetId}`; }
  if (data.interactionLimit) { return `repo:${data.interactionLimit}`; }
  return data.targetKind ?? 'repo';
}
