/**
 * `gitd issue` — create, list, show, comment on, and manage issues.
 *
 * Usage:
 *   gitd issue create <title> [--body <text>]
 *   gitd issue show <id>
 *   gitd issue comment <id> <body>
 *   gitd issue close <id> [--reason <text>]
 *   gitd issue reopen <id>
 *   gitd issue accept <submitter-did> <id>
 *   gitd issue ignore <submitter-did> <id> [--reason <text>]
 *   gitd issue list [--status <open|closed>]
 *
 * @module
 */

import type { AgentContext } from '../agent.js';
import type { RepoContext, RepoRoleName } from '../repo-context.js';

import { RecordsWrite } from '@enbox/dwn-sdk-js';

import { ForgeIssuesDefinition } from '../../issues.js';
import { recordIgnoredSubmission } from '../submission-decisions.js';
import { bodyInit, configuredDwnEndpoints, jsonBody, messageSignerForContext, processMessageOnTargetEndpoints, sendRecordToTarget } from '../record-send.js';
import { discussionIsLocked, latestActiveBlock, visibleCommentRecords } from '../moderation-state.js';
import { findByShortId, shortId } from '../../github-shim/helpers.js';
import { flagValue, resolveRepoName, resolveRepoOwner } from '../flags.js';
import { fromOpt, getRepoContext, getRepoContextForDid, resolveRepoProtocolRole } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function issueCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return issueCreate(ctx, rest);
    case 'show': return issueShow(ctx, rest);
    case 'comment': return issueComment(ctx, rest);
    case 'close': return issueClose(ctx, rest);
    case 'reopen': return issueReopen(ctx, rest);
    case 'accept': return issueAccept(ctx, rest);
    case 'ignore': return issueIgnore(ctx, rest);
    case 'list':
    case 'ls': return issueList(ctx, rest);
    default:
      console.error('Usage: gitd issue <create|show|comment|close|reopen|accept|ignore|list>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// issue create
// ---------------------------------------------------------------------------

async function issueCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const title = args[0];
  const body = flagValue(args, '--body') ?? flagValue(args, '-m') ?? '';

  if (!title) {
    console.error('Usage: gitd issue create <title> [--body <text>]');
    process.exit(1);
  }

  debugIssue('create: resolving target');
  const target = await resolveIssueTarget(ctx, args);
  debugIssue(`create: target resolved ${target.ownerDid}/${target.repo.name}`);
  debugIssue('create: checking write access');
  await ensureRepoWriteAllowed(ctx, target);
  debugIssue('create: resolving role');
  const protocolRole = await issueWriteRole(ctx, target);
  debugIssue(`create: role ${protocolRole ?? '<none>'}`);
  if (target.remote) {
    debugIssue('create: creating remote issue');
    const recordId = await createRemoteIssue(ctx, target, title, body, protocolRole);
    console.log(`Created issue ${shortId(recordId)}: "${title}"`);
    console.log(`  Record ID: ${recordId}`);
    return;
  }

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body },
    tags            : { status: 'open' },
    parentContextId : target.repo.contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create issue record');}
  const id = shortId(record.id);
  console.log(`Created issue ${id}: "${title}"`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

async function issueShow(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue show <id>');
    process.exit(1);
  }

  const target = await resolveIssueTarget(ctx, args);
  const record = await findById(ctx, target, idStr);
  if (!record) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await record.data.json();
  const tags = record.tags as Record<string, string> | undefined;
  const st = tags?.status ?? 'unknown';
  const date = record.dateCreated?.slice(0, 10) ?? '';

  console.log(`Issue ${shortId(record.id)}: ${data.title}`);
  console.log(`  Status:  ${st.toUpperCase()}`);
  console.log(`  Created: ${date}`);
  console.log(`  ID:      ${record.id}`);

  if (data.body) {
    console.log('');
    console.log(`  ${data.body}`);
  }

  // Fetch comments.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    ...(target.from ? { from: target.from } : {}),
    filter: { contextId: record.contextId },
  });

  const visibleComments = await visibleCommentRecords(ctx, target, 'issueComment', comments);
  if (visibleComments.length > 0) {
    console.log('');
    console.log(`  Comments (${visibleComments.length}):`);
    console.log('  ---');
    for (const comment of visibleComments) {
      const commentData = await comment.data.json();
      const commentDate = comment.dateCreated?.slice(0, 19)?.replace('T', ' ') ?? '';
      console.log(`  ${commentDate}`);
      console.log(`  ${commentData.body}`);
      console.log('  ---');
    }
  }
}

// ---------------------------------------------------------------------------
// issue comment
// ---------------------------------------------------------------------------

async function issueComment(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  const flagBody = flagValue(args, '--body') ?? flagValue(args, '-m');
  const positional = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
  const body = flagBody ?? (positional || undefined);

  if (!idStr || !body) {
    console.error('Usage: gitd issue comment <id> <body>');
    console.error('       gitd issue comment <id> --body <text>');
    process.exit(1);
  }

  const target = await resolveIssueTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const issue = await findById(ctx, target, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  if (await discussionIsLocked(ctx, target, 'issue', issue)) {
    console.error(`Issue ${idStr} is locked.`);
    process.exit(1);
  }

  const protocolRole = await issueWriteRole(ctx, target);
  const { status, record: commentRecord } = await ctx.issues.records.create('repo/issue/comment' as any, {
    data            : { body },
    parentContextId : issue.contextId,
    ...(target.remote ? { protocolRole, store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add comment: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (target.remote) {
    if (!commentRecord) { throw new Error('Failed to create issue comment record'); }
    await sendRecordToTarget(ctx, commentRecord, target.ownerDid, 'issue comment');
  }

  console.log(`Added comment to issue ${idStr}.`);
}

// ---------------------------------------------------------------------------
// issue close
// ---------------------------------------------------------------------------

async function issueClose(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue close <id>');
    process.exit(1);
  }
  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');

  const target = await resolveIssueTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const issue = await findById(ctx, target, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'closed') {
    console.log(`Issue ${idStr} is already closed.`);
    return;
  }

  const { status, record: updatedIssue } = await issue.update({
    data : data,
    tags : { ...tags, status: 'closed' },
    ...(target.remote ? { store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to close issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (target.remote) {
    await sendRecordToTarget(ctx, updatedIssue ?? issue, target.ownerDid, 'issue update');
  }

  const event = await ctx.issues.records.create('repo/issue/statusChange' as any, {
    data            : reason ? { reason } : {},
    tags            : { from: tags?.status ?? 'open', to: 'closed' },
    parentContextId : issue.contextId,
    ...(target.remote ? { store: false } : {}),
  } as any);
  if (event.status.code >= 300) {
    console.error(`Failed to record issue status change: ${event.status.code} ${event.status.detail}`);
    process.exit(1);
  }
  if (target.remote && event.record) {
    await sendRecordToTarget(ctx, event.record, target.ownerDid, 'issue status change');
  }

  console.log(`Closed issue ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// issue reopen
// ---------------------------------------------------------------------------

async function issueReopen(ctx: AgentContext, args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error('Usage: gitd issue reopen <id>');
    process.exit(1);
  }

  const target = await resolveIssueTarget(ctx, args);
  await ensureRepoWriteAllowed(ctx, target);
  const issue = await findById(ctx, target, idStr);
  if (!issue) {
    console.error(`Issue ${idStr} not found.`);
    process.exit(1);
  }

  const data = await issue.data.json();
  const tags = issue.tags as Record<string, string> | undefined;

  if (tags?.status === 'open') {
    console.log(`Issue ${idStr} is already open.`);
    return;
  }

  const { status, record: updatedIssue } = await issue.update({
    data : data,
    tags : { ...tags, status: 'open' },
    ...(target.remote ? { store: false } : {}),
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to reopen issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (target.remote) {
    await sendRecordToTarget(ctx, updatedIssue ?? issue, target.ownerDid, 'issue update');
  }

  const event = await ctx.issues.records.create('repo/issue/statusChange' as any, {
    data            : {},
    tags            : { from: tags?.status ?? 'closed', to: 'open' },
    parentContextId : issue.contextId,
    ...(target.remote ? { store: false } : {}),
  } as any);
  if (event.status.code >= 300) {
    console.error(`Failed to record issue status change: ${event.status.code} ${event.status.detail}`);
    process.exit(1);
  }
  if (target.remote && event.record) {
    await sendRecordToTarget(ctx, event.record, target.ownerDid, 'issue status change');
  }

  console.log(`Reopened issue ${idStr}: "${data.title}"`);
}

// ---------------------------------------------------------------------------
// issue accept
// ---------------------------------------------------------------------------

async function issueAccept(ctx: AgentContext, args: string[]): Promise<void> {
  const submitterDid = args[0];
  const idStr = args[1];

  if (!submitterDid || !idStr) {
    console.error('Usage: gitd issue accept <submitter-did> <id> [--repo <name>]');
    process.exit(1);
  }

  const repo = await getRepoContext(ctx, resolveRepoName(args));
  const { records } = await ctx.issues.records.query('repo/issue', {
    from   : submitterDid,
    filter : { tags: { repoDid: ctx.did, repoRecordId: repo.recordId } },
  });

  const externalIssue = findExternalRecord(records, idStr);
  if (!externalIssue) {
    console.error(`External issue ${idStr} from ${submitterDid} not found for ${repo.name}.`);
    process.exit(1);
  }

  const externalTags = externalIssue.tags as Record<string, string> | undefined;
  if (externalTags?.repoDid !== ctx.did || externalTags?.repoRecordId !== repo.recordId) {
    console.error(`External issue ${idStr} does not target ${ctx.did}/${repo.name}.`);
    process.exit(1);
  }

  const data = await externalIssue.data.json();
  const title = typeof data.title === 'string' ? data.title : 'Untitled issue';
  const body = typeof data.body === 'string' ? data.body : '';
  const statusTag = externalTags?.status === 'closed' ? 'closed' : 'open';
  const tags: Record<string, string> = {
    status              : statusTag,
    submitterDid,
    submissionRecordId  : externalIssue.id,
    submissionContextId : externalIssue.contextId ?? '',
  };

  const { status, record } = await ctx.issues.records.create('repo/issue', {
    data            : { title, body },
    tags,
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    console.error(`Failed to accept issue: ${status.code} ${status.detail}`);
    process.exit(1);
  }
  if (!record) {throw new Error('Failed to create accepted issue record');}

  const copied = await copyExternalIssueThread(ctx, submitterDid, externalIssue, record);

  console.log(`Accepted external issue ${shortId(externalIssue.id)} as ${shortId(record.id)}: "${title}"`);
  console.log(`  Submitter: ${submitterDid}`);
  console.log(`  Source record: ${externalIssue.id}`);
  console.log(`  Record ID: ${record.id}`);
  const copiedParts = [
    copied.comments > 0 ? `${copied.comments} comment${copied.comments !== 1 ? 's' : ''}` : '',
    copied.statusChanges > 0 ? `${copied.statusChanges} status change${copied.statusChanges !== 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  if (copiedParts.length > 0) {
    console.log(`  Copied: ${copiedParts.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// issue ignore
// ---------------------------------------------------------------------------

async function issueIgnore(ctx: AgentContext, args: string[]): Promise<void> {
  const submitterDid = args[0];
  const idStr = args[1];
  const reason = flagValue(args, '--reason') ?? flagValue(args, '-m');

  if (!submitterDid || !idStr) {
    console.error('Usage: gitd issue ignore <submitter-did> <id> [--repo <name>] [--reason <text>]');
    process.exit(1);
  }

  const repo = await getRepoContext(ctx, resolveRepoName(args));
  const { records } = await ctx.issues.records.query('repo/issue', {
    from   : submitterDid,
    filter : { tags: { repoDid: ctx.did, repoRecordId: repo.recordId } },
  });

  const externalIssue = findExternalRecord(records, idStr);
  if (!externalIssue) {
    console.error(`External issue ${idStr} from ${submitterDid} not found for ${repo.name}.`);
    process.exit(1);
  }

  const externalTags = externalIssue.tags as Record<string, string> | undefined;
  if (externalTags?.repoDid !== ctx.did || externalTags?.repoRecordId !== repo.recordId) {
    console.error(`External issue ${idStr} does not target ${ctx.did}/${repo.name}.`);
    process.exit(1);
  }

  const decision = await recordIgnoredSubmission(ctx, repo, 'issue', submitterDid, externalIssue, reason);
  if (decision.status && decision.status.code >= 300) {
    console.error(`Failed to ignore issue: ${decision.status.code} ${decision.status.detail}`);
    process.exit(1);
  }

  if (!decision.created) {
    console.log(`External issue ${shortId(externalIssue.id)} is already ignored.`);
    return;
  }

  console.log(`Ignored external issue ${shortId(externalIssue.id)} from ${submitterDid}.`);
  console.log(`  Decision record: ${decision.record?.id ?? 'unknown'}`);
}

// ---------------------------------------------------------------------------
// issue list
// ---------------------------------------------------------------------------

async function issueList(ctx: AgentContext, args: string[]): Promise<void> {
  const statusFilter = flagValue(args, '--status') ?? flagValue(args, '-s');

  const target = await resolveIssueTarget(ctx, args);

  const filter: Record<string, unknown> = {};
  if (target.repo.contextId) {
    filter.contextId = target.repo.contextId;
  }

  const tags: Record<string, string> = {};
  if (statusFilter) {
    tags.status = statusFilter;
  }
  if (Object.keys(tags).length > 0) {
    filter.tags = tags;
  }

  const { records } = await ctx.issues.records.query('repo/issue', {
    ...(target.from ? { from: target.from } : {}),
    filter,
  });

  if (records.length === 0) {
    console.log('No issues found.');
    return;
  }

  console.log(`Issues (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    const recTags = rec.tags as Record<string, string> | undefined;
    const st = recTags?.status ?? 'unknown';
    const date = rec.dateCreated?.slice(0, 10) ?? '';
    const id = shortId(rec.id);
    console.log(`  ${id} [${st.toUpperCase().padEnd(6)}] ${data.title}`);
    console.log(`        created: ${date}  id: ${rec.id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find an issue record by its short hash ID (or unambiguous prefix).
 */
async function findById(
  ctx: AgentContext,
  target: IssueTarget,
  idStr: string,
): Promise<any | undefined> {
  const { records } = await ctx.issues.records.query('repo/issue', {
    ...(target.from ? { from: target.from } : {}),
    filter: { contextId: target.repo.contextId },
  });

  return findByShortId(records, idStr);
}

type IssueTarget = {
  ownerDid : string;
  repo : RepoContext;
  from? : string;
  remote : boolean;
};

async function createRemoteIssue(
  ctx: AgentContext,
  target: IssueTarget,
  title: string,
  body: string,
  protocolRole?: string,
): Promise<string> {
  if (configuredDwnEndpoints(ctx).length === 0) {
    const { status, record } = await ctx.issues.records.create('repo/issue', {
      data            : { title, body },
      tags            : { status: 'open' },
      parentContextId : target.repo.contextId,
      protocolRole,
      store           : false,
    } as any);

    if (status.code >= 300) {
      console.error(`Failed to create issue: ${status.code} ${status.detail}`);
      process.exit(1);
    }

    if (!record) { throw new Error('Failed to create issue record'); }
    await sendRecordToTarget(ctx, record, target.ownerDid, 'issue');
    return record.id;
  }

  const data = jsonBody({ title, body });
  debugIssue('remote: loading signer');
  const signer = await messageSignerForContext(ctx);
  debugIssue('remote: composing write');
  const write = await RecordsWrite.create({
    protocol        : ForgeIssuesDefinition.protocol,
    protocolPath    : 'repo/issue',
    schema          : ForgeIssuesDefinition.types.issue.schema,
    dataFormat      : 'application/json',
    data,
    tags            : { status: 'open' },
    parentContextId : target.repo.contextId,
    protocolRole,
    published       : true,
    recipient       : target.ownerDid,
    signer,
  });

  debugIssue('remote: processing write');
  await processMessageOnTargetEndpoints(ctx, target.ownerDid, write.message, 'issue', bodyInit(data));
  debugIssue('remote: write processed');
  return write.message.recordId;
}

async function resolveIssueTarget(ctx: AgentContext, args: string[]): Promise<IssueTarget> {
  const ownerDid = resolveRepoOwner(args) ?? ctx.did;
  const repo = await getRepoContextForDid(ctx, ownerDid, resolveRepoName(args));
  const from = fromOpt(ctx, ownerDid);
  return { ownerDid, repo, from, remote: ownerDid !== ctx.did };
}

async function issueWriteRole(ctx: AgentContext, target: IssueTarget): Promise<string | undefined> {
  return resolveTargetRole(ctx, target, ['contributor', 'moderator', 'maintainer', 'triager'], 'contributor');
}

async function ensureRepoWriteAllowed(ctx: AgentContext, target: IssueTarget): Promise<void> {
  const block = await latestActiveBlock(ctx, target);
  if (!block) {
    return;
  }

  const reason = block.data.reason ? ` Reason: ${block.data.reason}` : '';
  console.error(`You are blocked from writing to ${target.ownerDid}/${target.repo.name}.${reason}`);
  process.exit(1);
}

async function resolveTargetRole(
  ctx: AgentContext,
  target: IssueTarget,
  candidates: readonly RepoRoleName[],
  fallback: RepoRoleName,
): Promise<string | undefined> {
  if (target.remote) {
    return `repo:repo/${fallback}`;
  }
  return resolveRepoProtocolRole(ctx, target.ownerDid, target.repo.contextId, candidates, fallback);
}

function findExternalRecord(records: any[], idStr: string): any | undefined {
  return records.find(record => record.id === idStr || shortId(record.id).startsWith(idStr.toLowerCase()));
}

async function copyExternalIssueThread(
  ctx: AgentContext,
  submitterDid: string,
  externalIssue: any,
  acceptedIssue: any,
): Promise<{ comments: number; statusChanges: number }> {
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    from   : submitterDid,
    filter : { contextId: externalIssue.contextId },
  });

  let copiedComments = 0;
  for (const comment of comments) {
    const commentData = await comment.data.json();
    const { status } = await ctx.issues.records.create('repo/issue/comment' as any, {
      data            : commentData,
      parentContextId : acceptedIssue.contextId,
    } as any);
    if (status.code >= 300) {
      console.error(`  Warning: failed to copy issue comment ${comment.id}: ${status.code} ${status.detail}`);
      continue;
    }
    copiedComments++;
  }

  const { records: statusChanges } = await ctx.issues.records.query('repo/issue/statusChange' as any, {
    from   : submitterDid,
    filter : { contextId: externalIssue.contextId },
  });

  let copiedStatusChanges = 0;
  for (const statusChange of statusChanges) {
    const statusData = await statusChange.data.json();
    const statusTags = (statusChange.tags ?? {}) as Record<string, unknown>;
    const { status } = await ctx.issues.records.create('repo/issue/statusChange' as any, {
      data            : statusData,
      tags            : statusTags,
      parentContextId : acceptedIssue.contextId,
    } as any);
    if (status.code >= 300) {
      console.error(`  Warning: failed to copy issue status change ${statusChange.id}: ${status.code} ${status.detail}`);
      continue;
    }
    copiedStatusChanges++;
  }

  return { comments: copiedComments, statusChanges: copiedStatusChanges };
}

function debugIssue(message: string): void {
  if (process.env.GITD_DEBUG === '1') {
    console.error(`[issue] ${message}`);
  }
}
