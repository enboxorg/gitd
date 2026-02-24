/**
 * `dwn-git notification` — personal notification inbox.
 *
 * Notifications are private (`published: false`) and only the DWN owner
 * can read, mark as read, or delete them.
 *
 * Usage:
 *   dwn-git notification list [--unread]       List notifications
 *   dwn-git notification read <id>             Mark a notification as read
 *   dwn-git notification clear                 Delete all read notifications
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { flagValue } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function notificationCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls': return notificationList(ctx, rest);
    case 'read': return notificationRead(ctx, rest);
    case 'clear': return notificationClear(ctx);
    default:
      console.error('Usage: dwn-git notification <list|read|clear>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// notification list
// ---------------------------------------------------------------------------

async function notificationList(ctx: AgentContext, args: string[]): Promise<void> {
  const unreadOnly = args.includes('--unread');
  const limit = parseInt(flagValue(args, '--limit') ?? '20', 10);

  const filter: Record<string, unknown> = {};
  if (unreadOnly) {
    filter.tags = { read: false };
  }

  const { records } = await ctx.notifications.records.query('notification', {
    filter,
    dateSort   : DateSort.CreatedDescending,
    pagination : { limit },
  });

  if (records.length === 0) {
    console.log(unreadOnly ? 'No unread notifications.' : 'No notifications.');
    return;
  }

  const unreadCount = records.filter((r) => {
    const tags = r.tags as Record<string, unknown> | undefined;
    return tags?.read === false;
  }).length;

  console.log(`Notifications (${records.length}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, unknown> | undefined;
    const isRead = tags?.read === true;
    const type = tags?.type ?? data.type ?? 'unknown';
    const date = rec.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';
    const marker = isRead ? ' ' : '*';
    console.log(`  ${marker} [${String(type).padEnd(16)}] ${data.title ?? ''}  ${date}`);
    if (data.body) {
      console.log(`    ${data.body}`);
    }
    console.log(`    id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// notification read
// ---------------------------------------------------------------------------

async function notificationRead(ctx: AgentContext, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: dwn-git notification read <id>');
    process.exit(1);
  }

  const { records } = await ctx.notifications.records.query('notification', {
    filter: { recordId: id },
  });

  if (records.length === 0) {
    console.error(`Notification ${id} not found.`);
    process.exit(1);
  }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, unknown> | undefined;

  if (tags?.read === true) {
    console.log('Notification is already marked as read.');
    return;
  }

  const { status } = await rec.update({
    data : data,
    tags : { ...tags, read: true },
  });

  if (status.code >= 300) {
    console.error(`Failed to mark as read: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log('Marked notification as read.');
}

// ---------------------------------------------------------------------------
// notification clear
// ---------------------------------------------------------------------------

async function notificationClear(ctx: AgentContext): Promise<void> {
  const { records } = await ctx.notifications.records.query('notification', {
    filter: { tags: { read: true } },
  });

  if (records.length === 0) {
    console.log('No read notifications to clear.');
    return;
  }

  let deleted = 0;
  for (const rec of records) {
    const { status } = await rec.delete();
    if (status.code < 300) { deleted++; }
  }

  console.log(`Cleared ${deleted} read notification${deleted !== 1 ? 's' : ''}.`);
}
