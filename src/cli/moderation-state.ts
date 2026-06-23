import type { AgentContext } from './agent.js';
import type { RepoContext } from './repo-context.js';
import type { ModerationEventData } from '../repo.js';

import { shortId } from '../github-shim/helpers.js';

export type ModerationTarget = {
  ownerDid : string;
  repo : RepoContext;
  from? : string;
};

type ModerationEventEntry = {
  record : any;
  data : Partial<ModerationEventData>;
  tags : Record<string, string>;
};

/** Return the latest block event for `actorDid`, if it has not been unblocked. */
export async function latestActiveBlock(
  ctx: AgentContext,
  target: ModerationTarget,
  actorDid = ctx.did,
): Promise<ModerationEventEntry | undefined> {
  if (actorDid === target.ownerDid) {
    return undefined;
  }

  const events = await listModerationEvents(ctx, target);
  const latest = events
    .filter((entry) =>
      eventTargetDid(entry) === actorDid
      && (eventAction(entry) === 'block' || eventAction(entry) === 'unblock'))
    .sort(compareModerationEventsDesc)[0];

  return eventAction(latest) === 'block' ? latest : undefined;
}

/** Return true when the latest lock/unlock event locks a discussion record. */
export async function discussionIsLocked(
  ctx: AgentContext,
  target: ModerationTarget,
  kind: 'issue' | 'pr',
  record: any,
): Promise<boolean> {
  const events = await listModerationEvents(ctx, target);
  const latest = events
    .filter((entry) =>
      eventTargetKind(entry) === kind
      && (eventAction(entry) === 'lock' || eventAction(entry) === 'unlock')
      && matchesTargetRecord(eventTargetId(entry), record))
    .sort(compareModerationEventsDesc)[0];

  return eventAction(latest) === 'lock';
}

/** Remove comments whose latest moderation event hides or deletes them. */
export async function visibleCommentRecords(
  ctx: AgentContext,
  target: ModerationTarget,
  kind: 'issueComment' | 'prComment',
  comments: readonly any[],
): Promise<any[]> {
  const events = await listModerationEvents(ctx, target);
  return comments.filter((comment) => {
    const latest = events
      .filter((entry) =>
        eventTargetKind(entry) === kind
        && (eventAction(entry) === 'hideComment'
          || eventAction(entry) === 'unhideComment'
          || eventAction(entry) === 'deleteComment')
        && matchesTargetRecord(eventTargetId(entry), comment))
      .sort(compareModerationEventsDesc)[0];

    return eventAction(latest) !== 'hideComment' && eventAction(latest) !== 'deleteComment';
  });
}

async function listModerationEvents(
  ctx: AgentContext,
  target: ModerationTarget,
): Promise<ModerationEventEntry[]> {
  const { records } = await ctx.repo.records.query('repo/moderationEvent' as any, {
    ...(target.from ? { from: target.from } : {}),
    filter: { contextId: target.repo.contextId },
  });

  const entries: ModerationEventEntry[] = [];
  for (const record of records) {
    entries.push({
      record,
      data: {},
      tags: (record.tags ?? {}) as Record<string, string>,
    });
  }
  return entries;
}

function compareModerationEventsDesc(a: ModerationEventEntry, b: ModerationEventEntry): number {
  const byTime = moderationTimestamp(b).localeCompare(moderationTimestamp(a));
  if (byTime !== 0) {
    return byTime;
  }
  return String(b.record.id ?? '').localeCompare(String(a.record.id ?? ''));
}

function moderationTimestamp(entry: ModerationEventEntry): string {
  return entry.data.createdAt || entry.record.dateCreated || '';
}

function eventAction(entry: ModerationEventEntry | undefined): ModerationEventData['action'] | undefined {
  return (entry?.tags.action ?? entry?.data.action) as ModerationEventData['action'] | undefined;
}

function eventTargetDid(entry: ModerationEventEntry): string | undefined {
  return entry.tags.targetDid ?? entry.data.targetDid;
}

function eventTargetKind(entry: ModerationEventEntry): ModerationEventData['targetKind'] | undefined {
  return (entry.tags.targetKind ?? entry.data.targetKind) as ModerationEventData['targetKind'] | undefined;
}

function eventTargetId(entry: ModerationEventEntry): string | undefined {
  return entry.tags.targetId ?? entry.data.targetId;
}

function matchesTargetRecord(targetId: string | undefined, record: any): boolean {
  if (!targetId) {
    return false;
  }
  const recordId = String(record.id ?? '');
  return targetId === recordId || shortId(recordId).startsWith(targetId.toLowerCase());
}
