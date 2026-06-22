/**
 * GitHub API shim — commit comment endpoints.
 *
 * Stores GitHub-compatible commit comment metadata in the repo settings record.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { BodyMediaKind } from './body-media.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { applyBodyMedia } from './body-media.js';
import {
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

type CommitCommentEntry = {
  id : number;
  body : string;
  commitId : string;
  path? : string | null;
  position? : number | null;
  line? : number | null;
  userDid : string;
  createdAt : string;
  updatedAt : string;
  reactions? : Record<string, CommitCommentReactionEntry>;
};

type CommitCommentReactionEntry = {
  id : number;
  userDid : string;
  content : ReactionContent;
  createdAt : string;
};

type RepoSettingsData = {
  branchProtection? : Record<string, unknown>;
  labels? : Record<string, unknown>;
  milestones? : Record<string, unknown>;
  deployments? : Record<string, unknown>;
  commitComments? : Record<string, CommitCommentEntry>;
  mergeStrategies? : string[];
  autoDeleteBranch? : boolean;
};

type RepoSettingsLookup = {
  repo : RepoInfo;
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

type CommitCommentLookup = {
  repo : RepoInfo;
  settingsLookup : RepoSettingsLookup;
  comment : CommitCommentEntry;
  key : string;
};

const REACTION_CONTENTS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const;
const REACTION_CONTENT_SET = new Set<string>(REACTION_CONTENTS);
type ReactionContent = typeof REACTION_CONTENTS[number];

async function getRepoSettings(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoSettingsLookup | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo/settings' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  if (records.length === 0) {
    return { repo, settings: {} };
  }

  const record = records[0] as RepoSettingsLookup['record'] & { data: { json: () => Promise<RepoSettingsData> } };
  const settings = await record.data.json();
  return { repo, record, settings: settings ?? {} };
}

async function saveRepoSettings(
  ctx: AgentContext, lookup: RepoSettingsLookup, settings: RepoSettingsData,
): Promise<JsonResponse | undefined> {
  if (lookup.record) {
    const { status } = await lookup.record.update({ data: settings });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update repository settings: ${status.detail}`);
    }
    return undefined;
  }

  const { status } = await ctx.repo.records.create('repo/settings' as any, {
    data            : settings,
    parentContextId : lookup.repo.contextId,
  });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to create repository settings: ${status.detail}`);
  }
  return undefined;
}

function commentEntries(settings: RepoSettingsData): CommitCommentEntry[] {
  return Object.values(settings.commitComments ?? {})
    .filter((entry): entry is CommitCommentEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function commentKey(id: number): string {
  return String(id);
}

function nextCommitCommentId(settings: RepoSettingsData): number {
  return commentEntries(settings).reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function reactionEntries(comment: CommitCommentEntry): CommitCommentReactionEntry[] {
  return Object.values(comment.reactions ?? {})
    .filter((entry): entry is CommitCommentReactionEntry => Boolean(entry) && Number.isInteger(entry.id))
    .sort((a, b) => a.id - b.id);
}

function nextCommitCommentReactionId(settings: RepoSettingsData): number {
  let max = 0;
  for (const comment of commentEntries(settings)) {
    for (const reaction of reactionEntries(comment)) {
      max = Math.max(max, reaction.id);
    }
  }
  return max + 1;
}

function reactionKey(id: number): string {
  return String(id);
}

function stringParam(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberParam(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function bodyParam(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value;
}

function parseReactionContent(value: unknown): ReactionContent | JsonResponse {
  if (typeof value !== 'string' || !REACTION_CONTENT_SET.has(value)) {
    return jsonValidationError(
      `Validation Failed: content must be one of ${REACTION_CONTENTS.map(content => `'${content}'`).join(', ')}.`,
    );
  }
  return value as ReactionContent;
}

function buildCommitCommentResponse(
  entry: CommitCommentEntry, targetDid: string, repoName: string, baseUrl: string,
  bodyMediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const base = `${baseUrl}/repos/${targetDid}/${repoName}`;
  return applyBodyMedia({
    html_url           : `${base}/commit/${entry.commitId}#commitcomment-${entry.id}`,
    url                : `${base}/comments/${entry.id}`,
    id                 : entry.id,
    node_id            : `commit-comment:${entry.id}`,
    path               : entry.path ?? null,
    position           : entry.position ?? null,
    line               : entry.line ?? null,
    commit_id          : entry.commitId,
    user               : buildOwner(entry.userDid, baseUrl),
    created_at         : toISODate(entry.createdAt),
    updated_at         : toISODate(entry.updatedAt),
    author_association : entry.userDid === targetDid ? 'OWNER' : 'CONTRIBUTOR',
  }, entry.body, bodyMediaKind);
}

function buildCommitCommentReactionResponse(
  entry: CommitCommentReactionEntry, baseUrl: string,
): Record<string, unknown> {
  return {
    id         : entry.id,
    node_id    : `commit-comment-reaction:${entry.id}`,
    user       : buildOwner(entry.userDid, baseUrl),
    content    : entry.content,
    created_at : toISODate(entry.createdAt),
  };
}

async function findComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string,
): Promise<CommitCommentLookup | JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const id = parseInt(commentId, 10);
  const key = commentKey(id);
  const comment = lookup.settings.commitComments?.[key];
  if (!comment) {
    return jsonNotFound(`Commit comment ${commentId} not found.`);
  }

  return {
    repo           : lookup.repo,
    settingsLookup : lookup,
    comment,
    key,
  };
}

function settingsWithComment(
  settings: RepoSettingsData, key: string, comment: CommitCommentEntry | null,
): RepoSettingsData {
  const commitComments = { ...(settings.commitComments ?? {}) };
  if (comment) {
    commitComments[key] = comment;
  } else {
    delete commitComments[key];
  }

  const next: RepoSettingsData = { ...settings };
  if (Object.keys(commitComments).length > 0) {
    next.commitComments = commitComments;
  } else {
    delete next.commitComments;
  }
  return next;
}

function commentWithReaction(
  comment: CommitCommentEntry, key: string, reaction: CommitCommentReactionEntry | null,
): CommitCommentEntry {
  const reactions = { ...(comment.reactions ?? {}) };
  if (reaction) {
    reactions[key] = reaction;
  } else {
    delete reactions[key];
  }

  const next: CommitCommentEntry = { ...comment };
  if (Object.keys(reactions).length > 0) {
    next.reactions = reactions;
  } else {
    delete next.reactions;
  }
  return next;
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/comments
// ---------------------------------------------------------------------------

export async function handleListCommitComments(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const comments = commentEntries(lookup.settings);
  const paged = paginate(comments, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(comment => buildCommitCommentResponse(comment, targetDid, lookup.repo.name, baseUrl, bodyMediaKind)),
    extraHeaders,
  );
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/comments/:comment_id
// ---------------------------------------------------------------------------

export async function handleGetCommitComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }
  return jsonOk(buildCommitCommentResponse(result.comment, targetDid, result.repo.name, buildApiUrl(url), bodyMediaKind));
}

export async function handleUpdateCommitComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const body = bodyParam(reqBody.body);
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }

  const updated: CommitCommentEntry = {
    ...result.comment,
    body,
    updatedAt: new Date().toISOString(),
  };

  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    settingsWithComment(result.settingsLookup.settings, result.key, updated),
  );
  if (saveError) { return saveError; }

  return jsonOk(buildCommitCommentResponse(updated, targetDid, result.repo.name, buildApiUrl(url), bodyMediaKind));
}

export async function handleDeleteCommitComment(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string,
): Promise<JsonResponse> {
  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }

  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    settingsWithComment(result.settingsLookup.settings, result.key, null),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/comments/:comment_id/reactions
// ---------------------------------------------------------------------------

export async function handleListCommitCommentReactions(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, url: URL,
): Promise<JsonResponse> {
  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }

  const contentFilter = url.searchParams.get('content');
  if (contentFilter !== null) {
    const parsed = parseReactionContent(contentFilter);
    if (typeof parsed !== 'string') { return parsed; }
  }

  const pagination = parsePagination(url);
  const reactions = contentFilter === null
    ? reactionEntries(result.comment)
    : reactionEntries(result.comment).filter(reaction => reaction.content === contentFilter);
  const paged = paginate(reactions, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${result.repo.name}/comments/${commentId}/reactions`,
    pagination.page, pagination.perPage, reactions.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(reaction => buildCommitCommentReactionResponse(reaction, baseUrl)), extraHeaders);
}

export async function handleCreateCommitCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const content = parseReactionContent(reqBody.content);
  if (typeof content !== 'string') { return content; }

  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }

  const baseUrl = buildApiUrl(url);
  const duplicate = reactionEntries(result.comment).find((reaction) => {
    return reaction.userDid === ctx.did && reaction.content === content;
  });
  if (duplicate) {
    return jsonOk(buildCommitCommentReactionResponse(duplicate, baseUrl));
  }

  const reaction: CommitCommentReactionEntry = {
    id        : nextCommitCommentReactionId(result.settingsLookup.settings),
    userDid   : ctx.did,
    content,
    createdAt : new Date().toISOString(),
  };
  const updatedComment = commentWithReaction(result.comment, reactionKey(reaction.id), reaction);
  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    settingsWithComment(result.settingsLookup.settings, result.key, updatedComment),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildCommitCommentReactionResponse(reaction, baseUrl));
}

export async function handleDeleteCommitCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string, commentId: string, reactionId: string,
): Promise<JsonResponse> {
  const result = await findComment(ctx, targetDid, repoName, commentId);
  if ('status' in result) { return result; }

  const id = parseInt(reactionId, 10);
  const reaction = reactionEntries(result.comment).find(entry => entry.id === id);
  if (!reaction) {
    return jsonNotFound(`Reaction #${reactionId} not found on commit comment #${commentId}.`);
  }

  const updatedComment = commentWithReaction(result.comment, reactionKey(reaction.id), null);
  const saveError = await saveRepoSettings(
    ctx,
    result.settingsLookup,
    settingsWithComment(result.settingsLookup.settings, result.key, updatedComment),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// /repos/:did/:repo/commits/:commit_sha/comments
// ---------------------------------------------------------------------------

export async function handleListCommitCommentsForSha(
  ctx: AgentContext, targetDid: string, repoName: string, sha: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const comments = commentEntries(lookup.settings).filter(comment => comment.commitId === sha);
  const paged = paginate(comments, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${lookup.repo.name}/commits/${sha}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(
    paged.map(comment => buildCommitCommentResponse(comment, targetDid, lookup.repo.name, baseUrl, bodyMediaKind)),
    extraHeaders,
  );
}

export async function handleCreateCommitComment(
  ctx: AgentContext, targetDid: string, repoName: string, sha: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in lookup) { return lookup; }

  const body = bodyParam(reqBody.body);
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const now = new Date().toISOString();
  const id = nextCommitCommentId(lookup.settings);
  const comment: CommitCommentEntry = {
    id,
    body,
    commitId  : sha,
    path      : stringParam(reqBody.path),
    position  : numberParam(reqBody.position),
    line      : numberParam(reqBody.line),
    userDid   : ctx.did,
    createdAt : now,
    updatedAt : now,
  };

  const saveError = await saveRepoSettings(
    ctx,
    lookup,
    settingsWithComment(lookup.settings, commentKey(id), comment),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildCommitCommentResponse(comment, targetDid, lookup.repo.name, buildApiUrl(url), bodyMediaKind));
}
