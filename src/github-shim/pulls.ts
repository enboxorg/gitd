/**
 * GitHub API shim — `/repos/:did/:repo/pulls` endpoints.
 *
 * Maps DWN patch records to GitHub REST API v3 pull request responses.
 *
 * Endpoints:
 *   GET   /repos/:did/:repo/pulls                    List pull requests
 *   GET   /repos/:did/:repo/pulls/:number            Pull request detail
 *   GET   /repos/:did/:repo/pulls/:number/commits    Pull request commits
 *   GET   /repos/:did/:repo/pulls/:number/comments   Pull request review comments
 *   GET   /repos/:did/:repo/pulls/:number/merge      Check if pull request has been merged
 *   GET   /repos/:did/:repo/pulls/:number/requested_reviewers Pull request review requests
 *   GET   /repos/:did/:repo/pulls/:number/reviews    Pull request reviews
 *   GET   /repos/:did/:repo/pulls/:number/reviews/:id Pull request review
 *   GET   /repos/:did/:repo/pulls/:number/reviews/:id/comments Pull request review comments
 *   GET   /repos/:did/:repo/pulls/comments           Pull request review comments across repository
 *   GET   /repos/:did/:repo/pulls/comments/:id       Pull request review comment
 *   PATCH /repos/:did/:repo/pulls/comments/:id       Update pull request review comment
 *   DELETE /repos/:did/:repo/pulls/comments/:id      Delete pull request review comment
 *   POST  /repos/:did/:repo/pulls                    Create pull request
 *   POST  /repos/:did/:repo/pulls/:number/comments   Create pull request review comment
 *   POST  /repos/:did/:repo/pulls/:number/comments/:id/replies Create review comment reply
 *   POST  /repos/:did/:repo/pulls/:number/requested_reviewers Request pull reviewers
 *   DELETE /repos/:did/:repo/pulls/:number/requested_reviewers Remove pull review requests
 *   PATCH /repos/:did/:repo/pulls/:number            Update pull request
 *   PUT   /repos/:did/:repo/pulls/:number/merge      Merge pull request
 *   PUT   /repos/:did/:repo/pulls/:number/update-branch Update pull request branch
 *   POST  /repos/:did/:repo/pulls/:number/reviews    Create review
 *   PUT/PATCH /repos/:did/:repo/pulls/:number/reviews/:id Update review body
 *   DELETE /repos/:did/:repo/pulls/:number/reviews/:id Delete pending review
 *   PUT   /repos/:did/:repo/pulls/:number/reviews/:id/dismissals Dismiss review
 *   POST  /repos/:did/:repo/pulls/:number/reviews/:id/events Submit pending review
 *
 * Status mapping:
 *   - `open`   -> state: "open"
 *   - `draft`  -> state: "open", draft: true
 *   - `closed` -> state: "closed", merged: false
 *   - `merged` -> state: "closed", merged: true
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { BodyMediaKind } from './body-media.js';
import type { GitObjectOptions } from './git-objects.js';
import type { JsonResponse } from './helpers.js';

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { DateSort } from '@enbox/dwn-sdk-js';

import { applyBodyMedia } from './body-media.js';
import { GitBackend } from '../git-server/git-backend.js';
import { resolveReposPath } from '../cli/flags.js';

import {
  binaryOk,
  buildApiUrl,
  buildLinkHeader,
  buildOwner,
  fromOpt,
  getRepoRecord,
  jsonAccepted,
  jsonCreated,
  jsonMethodNotAllowed,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Verdict -> GitHub review state mapping
// ---------------------------------------------------------------------------

const VERDICT_MAP: Record<string, string> = {
  approve : 'APPROVED',
  reject  : 'CHANGES_REQUESTED',
  comment : 'COMMENTED',
};

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

type PatchLookup =
  | { kind: 'found'; from: string | undefined; patch: any }
  | { kind: 'response'; response: JsonResponse };

type ReviewCommentEntry = {
  patch : any;
  review : any;
  comment : any;
  data : any;
  tags : Record<string, string>;
};

type ReviewCommentReactionEntry = {
  id : number;
  userDid : string;
  content : ReactionContent;
  createdAt : string;
};

type PullReviewEntry = {
  patch : any;
  review : any;
  data : any;
  tags : Record<string, string>;
  override? : ReviewOverride;
};

type ReviewCommentLookup =
  | { kind: 'found'; from: string | undefined; pullNumber: string; entry: ReviewCommentEntry }
  | { kind: 'response'; response: JsonResponse };

type PullReviewLookup =
  | { kind: 'found'; from: string | undefined; entry: PullReviewEntry }
  | { kind: 'response'; response: JsonResponse };

type RepoReviewCommentEntry = ReviewCommentEntry & {
  pullNumber : string;
  commitId : string;
};

type PullRevisionEntry = {
  record : any;
  data : any;
  tags : Record<string, string>;
  headCommit : string;
  baseCommit : string;
};

type GitIdentity = {
  name : string;
  email : string;
  date : string;
};

type GitCommitInfo = {
  sha : string;
  treeSha : string;
  parentShas : string[];
  author : GitIdentity;
  committer : GitIdentity;
  message : string;
};

type GitResult = {
  status : number;
  stdout : Buffer;
};

type PullTextKind = 'diff' | 'patch';

type GitHubReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';

type ReviewOverride = {
  body? : string;
  state? : GitHubReviewState;
  submittedAt? : string | null;
  deleted? : boolean;
  dismissedAt? : string;
  dismissedMessage? : string;
  commitId? : string;
};

type ReviewCommentDraft = {
  body : string;
  path : string;
  line : number | null;
  startLine? : number | null;
  side : string;
  startSide? : string | null;
  subjectType : 'line' | 'file';
  diffHunk : string;
};

type ReviewCommentDraftsResult =
  | { kind: 'ok'; drafts: ReviewCommentDraft[] }
  | { kind: 'error'; message: string };

type RepoSettingsData = Record<string, unknown> & {
  pullReviewCommentReactions? : Record<string, Record<string, ReviewCommentReactionEntry>>;
};

type RepoSettingsLookup = {
  repo : { contextId: string; name: string };
  record? : {
    update : (options: { data: RepoSettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
  };
  settings : RepoSettingsData;
};

const REACTION_CONTENTS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const;
const REACTION_CONTENT_SET = new Set<string>(REACTION_CONTENTS);
type ReactionContent = typeof REACTION_CONTENTS[number];

// ---------------------------------------------------------------------------
// Pull request object builder
// ---------------------------------------------------------------------------

async function buildPullResponse(
  ctx: AgentContext, rec: any, data: any, tags: Record<string, string>,
  targetDid: string, repoName: string, baseUrl: string,
  from?: string, bodyMediaKind?: BodyMediaKind | null,
): Promise<Record<string, unknown>> {
  const owner = buildOwner(targetDid, baseUrl);
  const sourceDid = tags.sourceDid;
  const user = sourceDid ? buildOwner(sourceDid, baseUrl) : owner;
  const number = numericId(rec.id ?? '');
  const dwnStatus = tags.status ?? 'open';
  const merged = dwnStatus === 'merged';
  const draft = dwnStatus === 'draft';
  const state = (dwnStatus === 'open' || draft) ? 'open' : 'closed';
  const baseBranch = tags.baseBranch ?? 'main';
  const headBranch = tags.headBranch ?? '';
  const requestedReviewers = storedStringArray(data.requestedReviewers);
  const requestedTeams = storedStringArray(data.requestedTeams);

  // Fetch latest revision to populate commit + diff stats.
  let headSha = '';
  let baseSha = '';
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  const { records: revisions } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from,
    filter   : { contextId: rec.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (revisions.length > 0) {
    const rev = revisions[0];
    const revTags = (rev.tags as Record<string, string> | undefined) ?? {};
    headSha = revTags.headCommit ?? '';
    baseSha = revTags.baseCommit ?? '';
    commits = parseInt(revTags.commitCount ?? '0', 10);

    try {
      const revData = await rev.data.json();
      if (revData.diffStat) {
        additions = revData.diffStat.additions ?? 0;
        deletions = revData.diffStat.deletions ?? 0;
        changedFiles = revData.diffStat.filesChanged ?? 0;
      }
    } catch { /* revision may not have parseable JSON body */ }
  }

  // Fetch merge result to populate merge_commit_sha and merged_by.
  let mergeCommitSha: string | null = null;
  let mergedByDid: string | null = null;
  if (merged) {
    const { records: mergeResults } = await ctx.patches.records.query('repo/patch/mergeResult' as any, {
      from,
      filter: { contextId: rec.contextId },
    });
    if (mergeResults.length > 0) {
      const mrTags = (mergeResults[0].tags as Record<string, string> | undefined) ?? {};
      mergeCommitSha = mrTags.mergeCommit ?? null;

      try {
        const mrData = await mergeResults[0].data.json();
        mergedByDid = mrData.mergedBy ?? mergeResults[0].author ?? null;
      } catch {
        mergedByDid = mergeResults[0].author ?? null;
      }
    }
  }

  return applyBodyMedia({
    id                  : numericId(rec.id ?? ''),
    node_id             : rec.id ?? '',
    url                 : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
    html_url            : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}`,
    diff_url            : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}.diff`,
    patch_url           : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}.patch`,
    issue_url           : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}`,
    commits_url         : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}/commits`,
    review_comments_url : `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${number}/comments`,
    comments_url        : `${baseUrl}/repos/${targetDid}/${repoName}/issues/${number}/comments`,
    number,
    title               : data.title ?? '',
    state,
    locked              : false,
    merged,
    mergeable           : state === 'open' ? true : null,
    merge_commit_sha    : mergeCommitSha,
    merged_at           : merged ? toISODate(rec.timestamp) : null,
    merged_by           : mergedByDid ? buildOwner(mergedByDid, baseUrl) : null,
    created_at          : toISODate(rec.dateCreated),
    updated_at          : toISODate(rec.timestamp),
    closed_at           : state === 'closed' ? toISODate(rec.timestamp) : null,
    user,
    author_association  : sourceDid && sourceDid !== targetDid ? 'CONTRIBUTOR' : 'OWNER',
    draft,
    head                : {
      label : `${sourceDid ?? targetDid}:${headBranch}`,
      ref   : headBranch,
      sha   : headSha,
    },
    base: {
      label : `${targetDid}:${baseBranch}`,
      ref   : baseBranch,
      sha   : baseSha,
    },
    labels              : [],
    assignees           : [],
    milestone           : null,
    requested_reviewers : requestedReviewers.map(did => buildOwner(did, baseUrl)),
    requested_teams     : requestedTeams.map(slug => buildRequestedTeam(slug, baseUrl)),
    commits,
    additions,
    deletions,
    changed_files       : changedFiles,
  }, data.body ?? null, bodyMediaKind);
}

async function findPatchForPull(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<PatchLookup> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return {
      kind     : 'response',
      response : jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`),
    };
  }

  const from = fromOpt(ctx, targetDid);
  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });
  const patch = records.find(r => numericId(r.id ?? '') === num);
  if (!patch) {
    return {
      kind     : 'response',
      response : jsonNotFound(`Pull request #${number} not found.`),
    };
  }

  return { kind: 'found', from, patch };
}

async function latestRevisionHead(ctx: AgentContext, from: string | undefined, patch: any): Promise<string> {
  const { records } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from,
    filter   : { contextId: patch.contextId },
    dateSort : DateSort.CreatedDescending,
  });
  const tags = (records[0]?.tags as Record<string, string> | undefined) ?? {};
  return tags.headCommit ?? '';
}

async function latestPullRevision(
  ctx: AgentContext, from: string | undefined, patch: any,
): Promise<PullRevisionEntry | null> {
  const { records } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from,
    filter   : { contextId: patch.contextId },
    dateSort : DateSort.CreatedDescending,
  });
  const record = records[0];
  if (!record) {
    return null;
  }

  let data: any = {};
  try {
    data = await record.data.json();
  } catch {
    data = {};
  }

  const tags = (record.tags as Record<string, string> | undefined) ?? {};
  return {
    record,
    data,
    tags,
    headCommit : tags.headCommit ?? '',
    baseCommit : tags.baseCommit ?? '',
  };
}

async function latestRevisionBundleBytes(
  ctx: AgentContext, from: string | undefined, revision: PullRevisionEntry,
): Promise<Uint8Array | null> {
  const { records } = await ctx.patches.records.query('repo/patch/revision/revisionBundle' as any, {
    from,
    filter   : { contextId: revision.record.contextId },
    dateSort : DateSort.CreatedDescending,
  });
  const record = records[0];
  if (!record) {
    return null;
  }

  try {
    const blob = await record.data.blob();
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function localRepoPath(
  ctx: AgentContext, targetDid: string, repoName: string, options: GitObjectOptions,
): string | null {
  const reposPath = options.reposPath ?? resolveReposPath([], ctx.profileName ?? null);
  const backend = new GitBackend({ basePath: reposPath });

  try {
    if (!backend.exists(targetDid, repoName)) {
      return null;
    }
    return backend.repoPath(targetDid, repoName);
  } catch {
    return null;
  }
}

async function runGit(repoPath: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      env   : process.env,
      stdio : ['ignore', 'pipe', 'ignore'],
    });

    const stdout: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({
      status : code ?? 128,
      stdout : Buffer.concat(stdout),
    }));
  });
}

async function gitOk(repoPath: string, args: string[]): Promise<Buffer | null> {
  const result = await runGit(repoPath, args);
  return result.status === 0 ? result.stdout : null;
}

function gitLines(out: Buffer | null): string[] {
  if (!out) {
    return [];
  }
  return out.toString('utf-8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function resolveCommit(repoPath: string, sha: string): Promise<string | null> {
  if (!FULL_SHA_RE.test(sha)) {
    return null;
  }

  const out = await gitOk(repoPath, ['rev-parse', '--verify', `${sha}^{commit}`]);
  const resolved = out?.toString('utf-8').trim().toLowerCase() ?? '';
  return FULL_SHA_RE.test(resolved) ? resolved : null;
}

async function readCommit(repoPath: string, rawSha: string): Promise<GitCommitInfo | null> {
  const sha = await resolveCommit(repoPath, rawSha);
  if (!sha) {
    return null;
  }

  const out = await gitOk(repoPath, [
    'show',
    '-s',
    '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
    sha,
  ]);
  if (!out) {
    return null;
  }

  const parts = out.toString('utf-8').split('\0');
  if (parts.length < 10) {
    return null;
  }

  return {
    sha        : parts[0],
    treeSha    : parts[1],
    parentShas : parts[2] ? parts[2].split(' ') : [],
    author     : { name: parts[3], email: parts[4], date: parts[5] },
    committer  : { name: parts[6], email: parts[7], date: parts[8] },
    message    : parts.slice(9).join('\0').replace(/\n+$/, ''),
  };
}

async function listPullCommitShas(repoPath: string, baseSha: string, headSha: string): Promise<string[] | null> {
  if (!FULL_SHA_RE.test(headSha)) {
    return null;
  }
  if (!FULL_SHA_RE.test(baseSha)) {
    return [headSha.toLowerCase()];
  }

  const out = await gitOk(repoPath, ['rev-list', '--reverse', '--max-count=250', `${baseSha}..${headSha}`]);
  return out ? gitLines(out) : null;
}

async function pullRevisionText(
  repoPath: string, revision: PullRevisionEntry, kind: PullTextKind,
): Promise<Buffer | null> {
  const headSha = await resolveCommit(repoPath, revision.headCommit);
  if (!headSha) {
    return null;
  }
  const baseSha = await resolveCommit(repoPath, revision.baseCommit);

  const args = kind === 'diff'
    ? (baseSha
      ? ['diff', '--patch', '--find-renames', baseSha, headSha]
      : ['show', '--format=', '--find-renames', headSha])
    : (baseSha
      ? ['format-patch', '--stdout', '--find-renames', `${baseSha}..${headSha}`]
      : ['format-patch', '--stdout', '--find-renames', '-1', headSha]);
  const result = await runGit(repoPath, args);
  return result.status === 0 ? result.stdout : null;
}

async function pullRevisionTextFromBundle(
  localPath: string | null, bundleBytes: Uint8Array, revision: PullRevisionEntry, kind: PullTextKind,
): Promise<Buffer | null> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitd-pr-text-'));
  try {
    const tempRepoPath = join(tempRoot, 'repo.git');
    const setup = localPath
      ? await runGit(tempRoot, ['clone', '--bare', '--no-hardlinks', localPath, tempRepoPath])
      : await runGit(tempRoot, ['init', '--bare', tempRepoPath]);
    if (setup.status !== 0) {
      return null;
    }

    const bundlePath = join(tempRoot, 'revision.bundle');
    writeFileSync(bundlePath, bundleBytes);
    const fetch = await runGit(tempRepoPath, ['fetch', bundlePath]);
    if (fetch.status !== 0) {
      return null;
    }

    return pullRevisionText(tempRepoPath, revision, kind);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function nodeId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf-8').toString('base64');
}

function verification(): Record<string, unknown> {
  return {
    verified    : false,
    reason      : 'unsigned',
    signature   : null,
    payload     : null,
    verified_at : null,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function storedStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === 'string')) : [];
}

function requestStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return null;
  }
  return uniqueStrings(value);
}

function buildRequestedTeam(slug: string, baseUrl: string): Record<string, unknown> {
  const id = numericId(slug);
  return {
    id,
    node_id              : nodeId('team', slug),
    url                  : `${baseUrl}/teams/${id}`,
    html_url             : `${baseUrl}/teams/${slug}`,
    name                 : slug,
    slug,
    description          : null,
    privacy              : 'closed',
    notification_setting : 'notifications_enabled',
    permission           : 'pull',
    members_url          : `${baseUrl}/teams/${id}/members{/member}`,
    repositories_url     : `${baseUrl}/teams/${id}/repos`,
    parent               : null,
  };
}

function requestedReviewersPayload(data: any, baseUrl: string): Record<string, unknown> {
  const reviewers = storedStringArray(data.requestedReviewers);
  const teams = storedStringArray(data.requestedTeams);

  return {
    users : reviewers.map(did => buildOwner(did, baseUrl)),
    teams : teams.map(slug => buildRequestedTeam(slug, baseUrl)),
  };
}

async function pullData(record: any): Promise<any> {
  try {
    return await record.data.json();
  } catch {
    return {};
  }
}

function reviewOverrides(data: any): Record<string, ReviewOverride> {
  if (!data.reviewOverrides || typeof data.reviewOverrides !== 'object' || Array.isArray(data.reviewOverrides)) {
    return {};
  }
  return data.reviewOverrides as Record<string, ReviewOverride>;
}

function reviewOverrideKey(review: any): string {
  return review.id ?? String(numericId(review.id ?? ''));
}

function reviewCommentReactionKey(entry: ReviewCommentEntry): string {
  return entry.comment.id ?? String(numericId(entry.comment.id ?? ''));
}

function reactionKey(id: number): string {
  return String(id);
}

function parseReactionContent(value: unknown): ReactionContent | JsonResponse {
  if (typeof value !== 'string' || !REACTION_CONTENT_SET.has(value)) {
    return jsonValidationError(
      `Validation Failed: content must be one of ${REACTION_CONTENTS.map(content => `'${content}'`).join(', ')}.`,
    );
  }
  return value as ReactionContent;
}

function validReviewState(value: unknown): value is GitHubReviewState {
  return value === 'APPROVED'
    || value === 'CHANGES_REQUESTED'
    || value === 'COMMENTED'
    || value === 'PENDING'
    || value === 'DISMISSED';
}

function reviewState(entry: PullReviewEntry): GitHubReviewState {
  const overrideState = entry.override?.state;
  if (validReviewState(overrideState)) {
    return overrideState;
  }

  const dataState = entry.data.githubReviewState;
  if (validReviewState(dataState)) {
    return dataState;
  }

  const verdict = entry.tags.verdict ?? 'comment';
  return (VERDICT_MAP[verdict] as GitHubReviewState | undefined) ?? 'COMMENTED';
}

function eventToReviewState(event: unknown): GitHubReviewState | null {
  const normalized = typeof event === 'string' ? event.toUpperCase() : '';
  if (normalized === 'APPROVE') {
    return 'APPROVED';
  }
  if (normalized === 'REQUEST_CHANGES') {
    return 'CHANGES_REQUESTED';
  }
  if (normalized === 'COMMENT') {
    return 'COMMENTED';
  }
  return null;
}

function stateToVerdict(state: GitHubReviewState): string {
  if (state === 'APPROVED') {
    return 'approve';
  }
  if (state === 'CHANGES_REQUESTED') {
    return 'reject';
  }
  return 'comment';
}

async function saveReviewOverride(
  patch: any, review: any, patchData: any, override: ReviewOverride,
): Promise<{ status: any; data: any; override: ReviewOverride }> {
  const overrides = reviewOverrides(patchData);
  const key = reviewOverrideKey(review);
  const nextOverride = { ...(overrides[key] ?? {}), ...override };
  const updatedData = {
    ...patchData,
    reviewOverrides: {
      ...overrides,
      [key]: nextOverride,
    },
  };
  const tags = (patch.tags as Record<string, string> | undefined) ?? {};
  const { status } = await patch.update({ data: updatedData, tags });
  return { status, data: updatedData, override: nextOverride };
}

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

function reviewCommentReactionEntries(
  settings: RepoSettingsData, entry: ReviewCommentEntry,
): ReviewCommentReactionEntry[] {
  const bucket = settings.pullReviewCommentReactions?.[reviewCommentReactionKey(entry)] ?? {};
  return Object.values(bucket)
    .filter((reaction): reaction is ReviewCommentReactionEntry => Boolean(reaction) && Number.isInteger(reaction.id))
    .sort((a, b) => a.id - b.id);
}

function nextReviewCommentReactionId(settings: RepoSettingsData): number {
  let max = 0;
  for (const bucket of Object.values(settings.pullReviewCommentReactions ?? {})) {
    for (const reaction of Object.values(bucket ?? {})) {
      if (reaction && Number.isInteger(reaction.id)) {
        max = Math.max(max, reaction.id);
      }
    }
  }
  return max + 1;
}

function settingsWithReviewCommentReaction(
  settings: RepoSettingsData, entry: ReviewCommentEntry, key: string, reaction: ReviewCommentReactionEntry | null,
): RepoSettingsData {
  const commentKey = reviewCommentReactionKey(entry);
  const allReactions = { ...(settings.pullReviewCommentReactions ?? {}) };
  const commentReactions = { ...(allReactions[commentKey] ?? {}) };
  if (reaction) {
    commentReactions[key] = reaction;
  } else {
    delete commentReactions[key];
  }

  if (Object.keys(commentReactions).length > 0) {
    allReactions[commentKey] = commentReactions;
  } else {
    delete allReactions[commentKey];
  }

  const next = { ...settings };
  if (Object.keys(allReactions).length > 0) {
    next.pullReviewCommentReactions = allReactions;
  } else {
    delete next.pullReviewCommentReactions;
  }
  return next;
}

function buildReviewCommentReactionResponse(
  entry: ReviewCommentReactionEntry, baseUrl: string,
): Record<string, unknown> {
  return {
    id         : entry.id,
    node_id    : `pull-review-comment-reaction:${entry.id}`,
    user       : buildOwner(entry.userDid, baseUrl),
    content    : entry.content,
    created_at : toISODate(entry.createdAt),
  };
}

function buildPullCommitParents(parentShas: string[], repoBase: string): Record<string, unknown>[] {
  return parentShas.map(sha => ({
    sha,
    url      : `${repoBase}/git/commits/${sha}`,
    html_url : `${repoBase}/commit/${sha}`,
  }));
}

function buildPullCommitResponse(commit: GitCommitInfo, repoBase: string): Record<string, unknown> {
  return {
    sha     : commit.sha,
    node_id : nodeId('repo-commit', commit.sha),
    commit  : {
      author        : commit.author,
      committer     : commit.committer,
      message       : commit.message,
      tree          : { sha: commit.treeSha, url: `${repoBase}/git/trees/${commit.treeSha}` },
      url           : `${repoBase}/git/commits/${commit.sha}`,
      comment_count : 0,
      verification  : verification(),
    },
    url          : `${repoBase}/commits/${commit.sha}`,
    html_url     : `${repoBase}/commit/${commit.sha}`,
    comments_url : `${repoBase}/commits/${commit.sha}/comments`,
    author       : null,
    committer    : null,
    parents      : buildPullCommitParents(commit.parentShas, repoBase),
  };
}

function buildRevisionFallbackCommitResponse(
  revision: PullRevisionEntry, targetDid: string, repoBase: string,
): Record<string, unknown> | null {
  const sha = revision.headCommit.toLowerCase();
  if (!FULL_SHA_RE.test(sha)) {
    return null;
  }

  const date = toISODate(revision.record.dateCreated);
  const message = typeof revision.data.description === 'string' && revision.data.description
    ? revision.data.description
    : `Pull request revision ${sha.slice(0, 7)}`;
  const identity = {
    name  : targetDid,
    email : `${numericId(targetDid)}@users.noreply.gitd.invalid`,
    date,
  };
  const parentShas = FULL_SHA_RE.test(revision.baseCommit) ? [revision.baseCommit.toLowerCase()] : [];
  return buildPullCommitResponse({
    sha,
    treeSha   : sha,
    parentShas,
    author    : identity,
    committer : identity,
    message,
  }, repoBase);
}

function numericTag(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function reviewCommentSide(value: unknown): string {
  const side = typeof value === 'string' ? value.toUpperCase() : 'RIGHT';
  return side === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function reviewCommentSubjectType(value: unknown): 'line' | 'file' | null {
  if (value === undefined) { return 'line'; }
  if (typeof value !== 'string') { return null; }
  const normalized = value.toLowerCase();
  return normalized === 'line' || normalized === 'file' ? normalized : null;
}

function parseReviewCommentDrafts(value: unknown): ReviewCommentDraftsResult {
  if (value === undefined) {
    return { kind: 'ok', drafts: [] };
  }
  if (!Array.isArray(value)) {
    return { kind: 'error', message: 'Validation Failed: comments must be an array.' };
  }

  const drafts: ReviewCommentDraft[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { kind: 'error', message: 'Validation Failed: comments must be objects.' };
    }

    const comment = item as Record<string, unknown>;
    const body = comment.body;
    const path = comment.path;
    const subjectType = reviewCommentSubjectType(comment.subject_type);
    if (!subjectType) {
      return { kind: 'error', message: 'Validation Failed: subject_type must be line or file.' };
    }
    const line = numericTag(comment.line ?? comment.position);
    const startLine = numericTag(comment.start_line);
    if (typeof body !== 'string' || body.length === 0 || typeof path !== 'string' || path.length === 0) {
      return { kind: 'error', message: 'Validation Failed: comments require path, body, and line or position.' };
    }
    if (subjectType !== 'file' && !line) {
      return { kind: 'error', message: 'Validation Failed: comments require path, body, and line or position.' };
    }

    drafts.push({
      body,
      path,
      line,
      startLine,
      side      : reviewCommentSide(comment.side).toLowerCase(),
      startSide : startLine ? reviewCommentSide(comment.start_side ?? comment.side).toLowerCase() : null,
      subjectType,
      diffHunk  : typeof comment.diff_hunk === 'string' ? comment.diff_hunk : '',
    });
  }

  return { kind: 'ok', drafts };
}

function buildReviewCommentResponse(
  entry: ReviewCommentEntry,
  targetDid: string, repoName: string, pullNumber: string, baseUrl: string, commitId: string,
  bodyMediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const id = numericId(entry.comment.id ?? '');
  const reviewId = numericId(entry.review.id ?? '');
  const authorDid = entry.comment.author ?? entry.review.author ?? targetDid;
  const path = entry.tags.path ?? '';
  const line = numericTag(entry.tags.line);
  const startLine = numericTag(entry.tags.startLine ?? entry.tags.start_line);
  const side = reviewCommentSide(entry.tags.side);
  const startSide = startLine ? reviewCommentSide(entry.tags.startSide ?? entry.tags.start_side ?? entry.tags.side) : null;
  const subjectType = entry.tags.subjectType ?? entry.tags.subject_type ?? (line ? 'line' : 'file');
  const commentCommit = entry.tags.commitId ?? commitId;
  const inReplyToId = numericTag(entry.tags.inReplyToId ?? entry.tags.inReplyTo);
  const htmlUrl = `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${pullNumber}#discussion_r${id}`;
  const selfUrl = `${baseUrl}/repos/${targetDid}/${repoName}/pulls/comments/${id}`;
  const pullUrl = `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${pullNumber}`;

  const body = typeof entry.data.body === 'string' ? entry.data.body : '';
  const response = applyBodyMedia({
    url                    : selfUrl,
    pull_request_review_id : reviewId,
    id                     : id,
    node_id                : entry.comment.id ?? '',
    diff_hunk              : entry.data.diffHunk ?? '',
    path                   : path,
    commit_id              : commentCommit,
    original_commit_id     : commentCommit,
    user                   : buildOwner(authorDid, baseUrl),
    created_at             : toISODate(entry.comment.dateCreated),
    updated_at             : toISODate(entry.comment.timestamp),
    html_url               : htmlUrl,
    pull_request_url       : pullUrl,
    author_association     : authorDid === targetDid ? 'OWNER' : 'CONTRIBUTOR',
    start_line             : startLine,
    original_start_line    : startLine,
    start_side             : startSide,
    line                   : line,
    original_line          : line,
    side                   : side,
    subject_type           : subjectType,
    _links                 : {
      self         : { href: selfUrl },
      html         : { href: htmlUrl },
      pull_request : { href: pullUrl },
    },
  }, body, bodyMediaKind);
  if (inReplyToId) {
    response.in_reply_to_id = inReplyToId;
  }
  return response;
}

function buildPullReviewResponse(
  entry: PullReviewEntry,
  targetDid: string, repoName: string, pullNumber: string, baseUrl: string, commitId: string,
  bodyMediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const reviewAuthor = entry.review.author ?? targetDid;
  const id = numericId(entry.review.id ?? '');
  const htmlUrl = `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${pullNumber}#pullrequestreview-${id}`;
  const pullUrl = `${baseUrl}/repos/${targetDid}/${repoName}/pulls/${pullNumber}`;
  const state = reviewState(entry);
  const body = entry.override?.body ?? entry.data.body ?? '';
  const response = applyBodyMedia({
    id,
    node_id            : entry.review.id ?? '',
    user               : buildOwner(reviewAuthor, baseUrl),
    state,
    html_url           : htmlUrl,
    pull_request_url   : pullUrl,
    commit_id          : entry.override?.commitId ?? entry.tags.commitId ?? commitId,
    author_association : reviewAuthor === targetDid ? 'OWNER' : 'CONTRIBUTOR',
    _links             : {
      html         : { href: htmlUrl },
      pull_request : { href: pullUrl },
    },
  }, body, bodyMediaKind);

  if (state !== 'PENDING') {
    response.submitted_at = entry.override?.submittedAt ?? toISODate(entry.review.dateCreated);
  }

  return response;
}

async function listPullReviewEntries(ctx: AgentContext, from: string | undefined, patch: any): Promise<PullReviewEntry[]> {
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    from,
    filter   : { contextId: patch.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: PullReviewEntry[] = [];
  const patchData = await pullData(patch);
  const overrides = reviewOverrides(patchData);
  for (const review of reviews) {
    const override = overrides[reviewOverrideKey(review)];
    if (override?.deleted) {
      continue;
    }

    entries.push({
      patch,
      review,
      data : await review.data.json(),
      tags : (review.tags as Record<string, string> | undefined) ?? {},
      override,
    });
  }

  return entries;
}

async function listReviewCommentEntries(ctx: AgentContext, from: string | undefined, patch: any): Promise<ReviewCommentEntry[]> {
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    from,
    filter   : { contextId: patch.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: ReviewCommentEntry[] = [];
  const patchData = await pullData(patch);
  const overrides = reviewOverrides(patchData);
  for (const review of reviews) {
    if (overrides[reviewOverrideKey(review)]?.deleted) {
      continue;
    }

    const { records: comments } = await ctx.patches.records.query('repo/patch/review/reviewComment' as any, {
      from,
      filter   : { contextId: review.contextId },
      dateSort : DateSort.CreatedAscending,
    });

    for (const comment of comments) {
      entries.push({
        patch,
        review,
        comment,
        data : await comment.data.json(),
        tags : (comment.tags as Record<string, string> | undefined) ?? {},
      });
    }
  }

  return entries;
}

async function findPullReview(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, reviewId: string,
): Promise<PullReviewLookup> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup;
  }

  const reviews = await listPullReviewEntries(ctx, lookup.from, lookup.patch);
  const entry = reviews.find((review) => String(numericId(review.review.id ?? '')) === reviewId);
  if (!entry) {
    return {
      kind     : 'response',
      response : jsonNotFound(`Pull request review '${reviewId}' not found for pull request #${number}.`),
    };
  }

  return { kind: 'found', from: lookup.from, entry };
}

async function findPullReviewComment(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<ReviewCommentLookup> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return {
      kind     : 'response',
      response : jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`),
    };
  }

  const from = fromOpt(ctx, targetDid);
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });

  for (const patch of patches) {
    const comments = await listReviewCommentEntries(ctx, from, patch);
    const entry = comments.find((comment) => String(numericId(comment.comment.id ?? '')) === id);
    if (entry) {
      return {
        kind       : 'found',
        from,
        pullNumber : String(numericId(patch.id ?? '')),
        entry,
      };
    }
  }

  return {
    kind     : 'response',
    response : jsonNotFound(`Pull request review comment '${id}' not found.`),
  };
}

async function listRepoReviewCommentEntries(
  ctx: AgentContext, from: string | undefined, repoContextId: string,
): Promise<RepoReviewCommentEntry[]> {
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter   : { contextId: repoContextId },
    dateSort : DateSort.CreatedAscending,
  });

  const entries: RepoReviewCommentEntry[] = [];
  for (const patch of patches) {
    const pullNumber = String(numericId(patch.id ?? ''));
    const commitId = await latestRevisionHead(ctx, from, patch);
    const comments = await listReviewCommentEntries(ctx, from, patch);
    for (const comment of comments) {
      entries.push({ ...comment, pullNumber, commitId });
    }
  }

  return entries;
}

function recordTime(rec: any, key: 'created' | 'updated'): number {
  const value = key === 'created'
    ? rec.dateCreated
    : rec.timestamp ?? rec.dateCreated;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortRepoReviewComments(entries: RepoReviewCommentEntry[], url: URL): RepoReviewCommentEntry[] {
  const sort = url.searchParams.get('sort');
  const direction = url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc';
  const sorted = [...entries];

  if (sort === 'created' || sort === 'created_at') {
    sorted.sort((left, right) => recordTime(left.comment, 'created') - recordTime(right.comment, 'created'));
    return direction === 'desc' ? sorted.reverse() : sorted;
  }

  if (sort === 'updated') {
    sorted.sort((left, right) => recordTime(left.comment, 'updated') - recordTime(right.comment, 'updated'));
    return direction === 'desc' ? sorted.reverse() : sorted;
  }

  sorted.sort((left, right) => numericId(left.comment.id ?? '') - numericId(right.comment.id ?? ''));
  return sorted;
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls
// ---------------------------------------------------------------------------

export async function handleListPulls(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const stateFilter = url.searchParams.get('state') ?? 'open';
  const headFilter = url.searchParams.get('head');
  const baseFilter = url.searchParams.get('base');
  const sort = url.searchParams.get('sort') ?? 'created';
  const directionParam = url.searchParams.get('direction');
  const direction = directionParam === 'asc' || directionParam === 'desc'
    ? directionParam
    : (sort === 'created' ? 'desc' : 'asc');
  const pagination = parsePagination(url);

  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  // Filter by state — GitHub treats `closed` as "closed or merged".
  let filtered = records;
  if (stateFilter !== 'all') {
    filtered = records.filter((r) => {
      const t = r.tags as Record<string, string> | undefined;
      const s = t?.status ?? 'open';
      if (stateFilter === 'open') { return s === 'open' || s === 'draft'; }
      // 'closed' includes both closed and merged.
      return s === 'closed' || s === 'merged';
    });
  }
  if (headFilter) {
    filtered = filtered.filter((r) => {
      const tags = (r.tags as Record<string, string> | undefined) ?? {};
      const headBranch = tags.headBranch ?? '';
      const sourceDid = tags.sourceDid ?? targetDid;
      return headFilter.includes(':') ? `${sourceDid}:${headBranch}` === headFilter : headBranch === headFilter;
    });
  }
  if (baseFilter) {
    filtered = filtered.filter((r) => {
      const tags = (r.tags as Record<string, string> | undefined) ?? {};
      return (tags.baseBranch ?? 'main') === baseFilter;
    });
  }

  const sortKey = sort === 'updated' ? 'updated' : 'created';
  const sorted = [...filtered].sort((left, right) => {
    const timeDiff = recordTime(left, sortKey) - recordTime(right, sortKey);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return numericId(left.id ?? '') - numericId(right.id ?? '');
  });
  if (direction === 'desc') {
    sorted.reverse();
  }

  const page = paginate(sorted, pagination);

  const items: Record<string, unknown>[] = [];
  for (const rec of page) {
    const data = await rec.data.json();
    const tags = (rec.tags as Record<string, string> | undefined) ?? {};
    items.push(await buildPullResponse(ctx, rec, data, tags, targetDid, repoName, baseUrl, from, bodyMediaKind));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls`,
    pagination.page, pagination.perPage, sorted.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number
// ---------------------------------------------------------------------------

export async function handleGetPull(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await pullData(rec);
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  return jsonOk(await buildPullResponse(ctx, rec, data, tags, targetDid, repoName, baseUrl, from, bodyMediaKind));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/commits
// ---------------------------------------------------------------------------

export async function handleListPullCommits(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
  options: GitObjectOptions = {},
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const revision = await latestPullRevision(ctx, lookup.from, lookup.patch);
  if (!revision) {
    return jsonOk([]);
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = `${baseUrl}/repos/${targetDid}/${repoName}`;
  const repoPath = localRepoPath(ctx, targetDid, repoName, options);
  let commits: Record<string, unknown>[] = [];

  if (repoPath) {
    const shas = await listPullCommitShas(repoPath, revision.baseCommit, revision.headCommit);
    if (shas) {
      const resolved = (await Promise.all(shas.map(sha => readCommit(repoPath, sha))))
        .filter((commit): commit is GitCommitInfo => commit !== null);
      commits = resolved.map(commit => buildPullCommitResponse(commit, repoBase));
    }
  }

  if (commits.length === 0) {
    const fallback = buildRevisionFallbackCommitResponse(revision, targetDid, repoBase);
    if (fallback) {
      commits = [fallback];
    }
  }

  const capped = commits.slice(0, 250);
  const pagination = parsePagination(url);
  const paged = paginate(capped, pagination);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/${number}/commits`,
    pagination.page, pagination.perPage, capped.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(paged, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number.{diff,patch}
// ---------------------------------------------------------------------------

export async function handleGetPullText(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, kind: PullTextKind,
  options: GitObjectOptions = {},
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const revision = await latestPullRevision(ctx, lookup.from, lookup.patch);
  if (!revision) {
    return jsonNotFound(`Pull request ${kind} for #${number} not found.`);
  }

  const repoPath = localRepoPath(ctx, targetDid, repoName, options);
  const localText = repoPath ? await pullRevisionText(repoPath, revision, kind) : null;
  if (localText) {
    return binaryOk(
      localText,
      kind === 'diff' ? 'application/vnd.github.diff; charset=utf-8' : 'application/vnd.github.patch; charset=utf-8',
    );
  }

  const bundleBytes = await latestRevisionBundleBytes(ctx, lookup.from, revision);
  const bundleText = bundleBytes ? await pullRevisionTextFromBundle(repoPath, bundleBytes, revision, kind) : null;
  if (bundleText) {
    return binaryOk(
      bundleText,
      kind === 'diff' ? 'application/vnd.github.diff; charset=utf-8' : 'application/vnd.github.patch; charset=utf-8',
    );
  }

  return jsonNotFound(`Pull request ${kind} for #${number} is not available from local git objects or revision bundles.`);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/reviews
// ---------------------------------------------------------------------------

export async function handleListPullReviews(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const reviews = await listPullReviewEntries(ctx, lookup.from, lookup.patch);
  const paged = paginate(reviews, pagination);
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.patch);
  const items = paged.map((entry) =>
    buildPullReviewResponse(entry, targetDid, repoName, number, baseUrl, commitId, bodyMediaKind));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/${number}/reviews`,
    pagination.page, pagination.perPage, reviews.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/reviews/:review_id
// ---------------------------------------------------------------------------

export async function handleGetPullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildPullReviewResponse(
    lookup.entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind,
  ));
}

// ---------------------------------------------------------------------------
// PUT/PATCH /repos/:did/:repo/pulls/:number/reviews/:review_id
// ---------------------------------------------------------------------------

export async function handleUpdatePullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const body = reqBody.body;
  if (typeof body !== 'string' || body.length === 0) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const patchData = await pullData(lookup.entry.patch);
  const saved = await saveReviewOverride(lookup.entry.patch, lookup.entry.review, patchData, { body });
  if (saved.status.code >= 300) {
    return jsonValidationError(`Failed to update pull request review: ${saved.status.detail}`);
  }

  const entry = { ...lookup.entry, override: saved.override };
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildPullReviewResponse(
    entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind,
  ));
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/pulls/:number/reviews/:review_id
// ---------------------------------------------------------------------------

export async function handleDeletePendingPullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  if (reviewState(lookup.entry) !== 'PENDING') {
    return jsonValidationError('Validation Failed: submitted reviews cannot be deleted.');
  }

  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  const response = buildPullReviewResponse(
    lookup.entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind,
  );

  const patchData = await pullData(lookup.entry.patch);
  const saved = await saveReviewOverride(lookup.entry.patch, lookup.entry.review, patchData, { deleted: true });
  if (saved.status.code >= 300) {
    return jsonValidationError(`Failed to delete pending pull request review: ${saved.status.detail}`);
  }

  return jsonOk(response);
}

// ---------------------------------------------------------------------------
// PUT /repos/:did/:repo/pulls/:number/reviews/:review_id/dismissals
// ---------------------------------------------------------------------------

export async function handleDismissPullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const message = reqBody.message;
  if (typeof message !== 'string' || message.length === 0) {
    return jsonValidationError('Validation Failed: message is required.');
  }

  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  if (reviewState(lookup.entry) === 'PENDING') {
    return jsonValidationError('Validation Failed: pending reviews cannot be dismissed.');
  }

  const patchData = await pullData(lookup.entry.patch);
  const saved = await saveReviewOverride(lookup.entry.patch, lookup.entry.review, patchData, {
    dismissedAt      : new Date().toISOString(),
    dismissedMessage : message,
    state            : 'DISMISSED',
  });
  if (saved.status.code >= 300) {
    return jsonValidationError(`Failed to dismiss pull request review: ${saved.status.detail}`);
  }

  const entry = { ...lookup.entry, override: saved.override };
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildPullReviewResponse(
    entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind,
  ));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls/:number/reviews/:review_id/events
// ---------------------------------------------------------------------------

export async function handleSubmitPullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const state = eventToReviewState(reqBody.event);
  if (!state) {
    return jsonValidationError('Validation Failed: event must be APPROVE, REQUEST_CHANGES, or COMMENT.');
  }

  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  if (reviewState(lookup.entry) !== 'PENDING') {
    return jsonValidationError('Validation Failed: only pending reviews can be submitted.');
  }

  const body = typeof reqBody.body === 'string' ? reqBody.body : undefined;
  const patchData = await pullData(lookup.entry.patch);
  const saved = await saveReviewOverride(lookup.entry.patch, lookup.entry.review, patchData, {
    ...(body !== undefined ? { body } : {}),
    state,
    submittedAt: new Date().toISOString(),
  });
  if (saved.status.code >= 300) {
    return jsonValidationError(`Failed to submit pull request review: ${saved.status.detail}`);
  }

  const entry = { ...lookup.entry, override: saved.override };
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildPullReviewResponse(
    entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind,
  ));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/reviews/:review_id/comments
// ---------------------------------------------------------------------------

export async function handleListPullReviewCommentsForReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reviewId: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPullReview(ctx, targetDid, repoName, number, reviewId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const { records: comments } = await ctx.patches.records.query('repo/patch/review/reviewComment' as any, {
    from     : lookup.from,
    filter   : { contextId: lookup.entry.review.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  const paged = paginate(comments, pagination);
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  const items: Record<string, unknown>[] = [];
  for (const comment of paged) {
    items.push(buildReviewCommentResponse({
      patch  : lookup.entry.patch,
      review : lookup.entry.review,
      comment,
      data   : await comment.data.json(),
      tags   : (comment.tags as Record<string, string> | undefined) ?? {},
    }, targetDid, repoName, number, baseUrl, commitId, bodyMediaKind));
  }

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/${number}/reviews/${reviewId}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/comments
// ---------------------------------------------------------------------------

export async function handleListRepoPullReviewComments(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const since = url.searchParams.get('since');
  const sinceTime = since ? Date.parse(since) : NaN;

  let comments = await listRepoReviewCommentEntries(ctx, from, repo.contextId);
  if (Number.isFinite(sinceTime)) {
    comments = comments.filter((entry) => recordTime(entry.comment, 'updated') > sinceTime);
  }
  const sorted = sortRepoReviewComments(comments, url);
  const paged = paginate(sorted, pagination);
  const items = paged.map((entry) => buildReviewCommentResponse(
    entry, targetDid, repoName, entry.pullNumber, baseUrl, entry.commitId, bodyMediaKind,
  ));

  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/comments`,
    pagination.page, pagination.perPage, sorted.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/comments
// ---------------------------------------------------------------------------

export async function handleListPullReviewComments(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const comments = await listReviewCommentEntries(ctx, lookup.from, lookup.patch);
  const paged = paginate(comments, pagination);
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.patch);
  const items = paged.map((entry) => buildReviewCommentResponse(
    entry, targetDid, repoName, number, baseUrl, commitId, bodyMediaKind,
  ));
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/pulls/${number}/comments`,
    pagination.page, pagination.perPage, comments.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(items, extraHeaders);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/comments/:id
// ---------------------------------------------------------------------------

export async function handleGetPullReviewComment(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const baseUrl = buildApiUrl(url);
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildReviewCommentResponse(
    lookup.entry, targetDid, repoName, lookup.pullNumber, baseUrl, commitId, bodyMediaKind,
  ));
}

export async function handleUpdatePullReviewComment(
  ctx: AgentContext, targetDid: string, repoName: string,
  id: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const data = { ...lookup.entry.data, body };
  const { status } = await lookup.entry.comment.update({ data });
  if (status.code >= 300) {
    return jsonValidationError(`Failed to update review comment: ${status.detail}`);
  }

  const entry = { ...lookup.entry, data };
  const commitId = await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  return jsonOk(buildReviewCommentResponse(
    entry, targetDid, repoName, lookup.pullNumber, buildApiUrl(url), commitId, bodyMediaKind,
  ));
}

export async function handleDeletePullReviewComment(
  ctx: AgentContext, targetDid: string, repoName: string, id: string,
): Promise<JsonResponse> {
  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const { status } = await lookup.entry.comment.delete();
  if (status.code >= 300) {
    return jsonValidationError(`Failed to delete review comment: ${status.detail}`);
  }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /repos/:did/:repo/pulls/comments/:id/reactions
// ---------------------------------------------------------------------------

export async function handleListPullReviewCommentReactions(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const contentFilter = url.searchParams.get('content');
  if (contentFilter !== null) {
    const parsed = parseReactionContent(contentFilter);
    if (typeof parsed !== 'string') { return parsed; }
  }

  const settingsLookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in settingsLookup) { return settingsLookup; }

  const pagination = parsePagination(url);
  const reactions = contentFilter === null
    ? reviewCommentReactionEntries(settingsLookup.settings, lookup.entry)
    : reviewCommentReactionEntries(settingsLookup.settings, lookup.entry).filter(reaction => reaction.content === contentFilter);
  const paged = paginate(reactions, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${settingsLookup.repo.name}/pulls/comments/${id}/reactions`,
    pagination.page, pagination.perPage, reactions.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders.Link = linkHeader; }

  return jsonOk(paged.map(reaction => buildReviewCommentReactionResponse(reaction, baseUrl)), extraHeaders);
}

export async function handleCreatePullReviewCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const content = parseReactionContent(reqBody.content);
  if (typeof content !== 'string') { return content; }

  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const settingsLookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in settingsLookup) { return settingsLookup; }

  const baseUrl = buildApiUrl(url);
  const duplicate = reviewCommentReactionEntries(settingsLookup.settings, lookup.entry).find((reaction) => {
    return reaction.userDid === ctx.did && reaction.content === content;
  });
  if (duplicate) {
    return jsonOk(buildReviewCommentReactionResponse(duplicate, baseUrl));
  }

  const reaction: ReviewCommentReactionEntry = {
    id        : nextReviewCommentReactionId(settingsLookup.settings),
    userDid   : ctx.did,
    content,
    createdAt : new Date().toISOString(),
  };
  const saveError = await saveRepoSettings(
    ctx,
    settingsLookup,
    settingsWithReviewCommentReaction(settingsLookup.settings, lookup.entry, reactionKey(reaction.id), reaction),
  );
  if (saveError) { return saveError; }

  return jsonCreated(buildReviewCommentReactionResponse(reaction, baseUrl));
}

export async function handleDeletePullReviewCommentReaction(
  ctx: AgentContext, targetDid: string, repoName: string, id: string, reactionId: string,
): Promise<JsonResponse> {
  const lookup = await findPullReviewComment(ctx, targetDid, repoName, id);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const settingsLookup = await getRepoSettings(ctx, targetDid, repoName);
  if ('status' in settingsLookup) { return settingsLookup; }

  const parsedId = parseInt(reactionId, 10);
  const reaction = reviewCommentReactionEntries(settingsLookup.settings, lookup.entry).find(entry => entry.id === parsedId);
  if (!reaction) {
    return jsonNotFound(`Reaction #${reactionId} not found on pull request review comment #${id}.`);
  }

  const saveError = await saveRepoSettings(
    ctx,
    settingsLookup,
    settingsWithReviewCommentReaction(settingsLookup.settings, lookup.entry, reactionKey(reaction.id), null),
  );
  if (saveError) { return saveError; }

  return jsonNoContent();
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls/:number/comments
// ---------------------------------------------------------------------------

export async function handleCreatePullReviewComment(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  if (reqBody.in_reply_to !== undefined) {
    return handleCreatePullReviewCommentReply(
      ctx, targetDid, repoName, number, String(reqBody.in_reply_to), reqBody, url, bodyMediaKind,
    );
  }

  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const path = reqBody.path as string | undefined;
  const subjectType = reviewCommentSubjectType(reqBody.subject_type);
  if (!subjectType) {
    return jsonValidationError('Validation Failed: subject_type must be line or file.');
  }
  const line = numericTag(reqBody.line ?? reqBody.position);
  const startLine = numericTag(reqBody.start_line);
  if (!path || (subjectType !== 'file' && !line)) {
    return jsonValidationError('Validation Failed: path and line are required.');
  }

  const side = reviewCommentSide(reqBody.side).toLowerCase();
  const startSide = startLine ? reviewCommentSide(reqBody.start_side ?? reqBody.side).toLowerCase() : null;
  const commitId = (reqBody.commit_id as string | undefined) ?? await latestRevisionHead(ctx, lookup.from, lookup.patch);

  const { status: reviewStatus, record: reviewRec } = await ctx.patches.records.create('repo/patch/review' as any, {
    data            : { body: '' },
    tags            : { verdict: 'comment' },
    parentContextId : lookup.patch.contextId,
  } as any);

  if (reviewStatus.code >= 300) {
    return jsonValidationError(`Failed to create review: ${reviewStatus.detail}`);
  }
  if (!reviewRec) {throw new Error('Failed to create review record');}

  const tags: Record<string, unknown> = {
    path,
    side,
    subjectType,
  };
  if (line) { tags.line = line; }
  if (startLine) { tags.startLine = startLine; }
  if (startSide) { tags.startSide = startSide; }
  if (commitId) {
    tags.commitId = commitId;
  }

  const { status, record: commentRec } = await ctx.patches.records.create('repo/patch/review/reviewComment' as any, {
    data            : { body, diffHunk: (reqBody.diff_hunk as string | undefined) ?? '' },
    tags,
    parentContextId : reviewRec.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create review comment: ${status.detail}`);
  }
  if (!commentRec) {throw new Error('Failed to create review comment record');}

  const entry: ReviewCommentEntry = {
    patch   : lookup.patch,
    review  : reviewRec,
    comment : commentRec,
    data    : await commentRec.data.json(),
    tags    : (commentRec.tags as Record<string, string> | undefined) ?? {},
  };

  return jsonCreated(buildReviewCommentResponse(entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind));
}

export async function handleCreatePullReviewCommentReply(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, commentId: string, reqBody: Record<string, unknown>, url: URL,
  bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const body = reqBody.body as string | undefined;
  if (!body) {
    return jsonValidationError('Validation Failed: body is required.');
  }

  const lookup = await findPullReviewComment(ctx, targetDid, repoName, commentId);
  if (lookup.kind === 'response') {
    return lookup.response;
  }
  if (lookup.pullNumber !== number) {
    return jsonNotFound(`Pull request review comment '${commentId}' not found for pull request #${number}.`);
  }

  const inReplyToId = numericTag(lookup.entry.tags.inReplyToId ?? lookup.entry.tags.inReplyTo);
  if (inReplyToId) {
    return jsonValidationError('Validation Failed: replies to replies are not supported.');
  }

  const parentId = numericId(lookup.entry.comment.id ?? '');
  const commitId = lookup.entry.tags.commitId ?? await latestRevisionHead(ctx, lookup.from, lookup.entry.patch);
  const tags: Record<string, unknown> = {
    ...lookup.entry.tags,
    inReplyToId: String(parentId),
  };
  if (commitId) {
    tags.commitId = commitId;
  }

  const { status, record: commentRec } = await ctx.patches.records.create('repo/patch/review/reviewComment' as any, {
    data            : { body, diffHunk: lookup.entry.data.diffHunk ?? '' },
    tags,
    parentContextId : lookup.entry.review.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create review comment reply: ${status.detail}`);
  }
  if (!commentRec) { throw new Error('Failed to create review comment reply record'); }

  const entry: ReviewCommentEntry = {
    patch   : lookup.entry.patch,
    review  : lookup.entry.review,
    comment : commentRec,
    data    : await commentRec.data.json(),
    tags    : (commentRec.tags as Record<string, string> | undefined) ?? {},
  };

  return jsonCreated(buildReviewCommentResponse(entry, targetDid, repoName, number, buildApiUrl(url), commitId, bodyMediaKind));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls — create pull request
// ---------------------------------------------------------------------------

export async function handleCreatePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  reqBody: Record<string, unknown>, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const title = reqBody.title as string | undefined;
  if (!title) {
    return jsonValidationError('Validation Failed: title is required.');
  }

  const body = (reqBody.body as string) ?? '';
  const baseBranch = (reqBody.base as string) ?? 'main';
  const headBranch = (reqBody.head as string) ?? '';
  const baseUrl = buildApiUrl(url);

  if (reqBody.draft !== undefined && typeof reqBody.draft !== 'boolean') {
    return jsonValidationError('Validation Failed: draft must be a boolean.');
  }

  const tags: Record<string, string> = {
    baseBranch,
    status: reqBody.draft === true ? 'draft' : 'open',
  };
  if (headBranch) { tags.headBranch = headBranch; }

  const { status, record } = await ctx.patches.records.create('repo/patch', {
    data            : { title, body },
    tags,
    parentContextId : repo.contextId,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create pull request: ${status.detail}`);
  }
  if (!record) {throw new Error('Failed to create pull request record');}

  const recTags = (record.tags as Record<string, string> | undefined) ?? {};
  const data = await record.data.json();
  const pr = await buildPullResponse(ctx, record, data, recTags, targetDid, repoName, baseUrl, undefined, bodyMediaKind);

  return jsonCreated(pr);
}

// ---------------------------------------------------------------------------
// PATCH /repos/:did/:repo/pulls/:number — update pull request
// ---------------------------------------------------------------------------

export async function handleUpdatePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseUrl = buildApiUrl(url);

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await pullData(rec);
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  // Apply updates.
  const newTitle = (reqBody.title as string | undefined) ?? data.title;
  const newBody = (reqBody.body as string | undefined) ?? data.body;
  const newBase = (reqBody.base as string | undefined) ?? tags.baseBranch;

  // GitHub API uses "state" (open/closed), DWN uses "status" tag.
  let newStatus = tags.status ?? 'open';
  if (reqBody.state === 'closed') { newStatus = 'closed'; }
  if (reqBody.state === 'open') { newStatus = 'open'; }

  const newTags: Record<string, string> = { ...tags, status: newStatus };
  if (newBase) { newTags.baseBranch = newBase; }

  const { status } = await rec.update({
    data : { ...data, title: newTitle, body: newBody },
    tags : newTags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update pull request: ${status.detail}`);
  }

  const updatedData = { ...data, title: newTitle, body: newBody };
  const pr = await buildPullResponse(ctx, rec, updatedData, newTags, targetDid, repoName, baseUrl, undefined, bodyMediaKind);

  return jsonOk(pr);
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/requested_reviewers — list review requests
// ---------------------------------------------------------------------------

export async function handleListPullRequestedReviewers(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const data = await pullData(lookup.patch);
  return jsonOk(requestedReviewersPayload(data, buildApiUrl(url)));
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls/:number/requested_reviewers — request reviewers
// ---------------------------------------------------------------------------

export async function handleRequestPullReviewers(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const reviewers = requestStringArray(reqBody.reviewers);
  const teamReviewers = requestStringArray(reqBody.team_reviewers);
  if (!reviewers || !teamReviewers) {
    return jsonValidationError('Validation Failed: reviewers and team_reviewers must be arrays of strings.');
  }
  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return jsonValidationError('Validation Failed: reviewers or team_reviewers is required.');
  }

  const data = await pullData(lookup.patch);
  const updatedData = {
    ...data,
    requestedReviewers : uniqueStrings([...storedStringArray(data.requestedReviewers), ...reviewers]),
    requestedTeams     : uniqueStrings([...storedStringArray(data.requestedTeams), ...teamReviewers]),
  };
  const tags = (lookup.patch.tags as Record<string, string> | undefined) ?? {};

  const { status } = await lookup.patch.update({
    data: updatedData,
    tags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to request pull request reviewers: ${status.detail}`);
  }

  const pr = await buildPullResponse(ctx, lookup.patch, updatedData, tags, targetDid, repoName, buildApiUrl(url), lookup.from);
  return jsonCreated(pr);
}

// ---------------------------------------------------------------------------
// DELETE /repos/:did/:repo/pulls/:number/requested_reviewers — remove requests
// ---------------------------------------------------------------------------

export async function handleRemovePullRequestedReviewers(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const reviewers = reqBody.reviewers === undefined
    ? null
    : requestStringArray(reqBody.reviewers);
  const teamReviewers = requestStringArray(reqBody.team_reviewers);
  if (!reviewers) {
    return jsonValidationError('Validation Failed: reviewers must be an array of strings.');
  }
  if (!teamReviewers) {
    return jsonValidationError('Validation Failed: team_reviewers must be an array of strings.');
  }
  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return jsonValidationError('Validation Failed: reviewers or team_reviewers is required.');
  }

  const data = await pullData(lookup.patch);
  const reviewerSet = new Set(reviewers);
  const teamSet = new Set(teamReviewers);
  const updatedData = {
    ...data,
    requestedReviewers : storedStringArray(data.requestedReviewers).filter(did => !reviewerSet.has(did)),
    requestedTeams     : storedStringArray(data.requestedTeams).filter(slug => !teamSet.has(slug)),
  };
  const tags = (lookup.patch.tags as Record<string, string> | undefined) ?? {};

  const { status } = await lookup.patch.update({
    data: updatedData,
    tags,
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to remove pull request reviewers: ${status.detail}`);
  }

  const pr = await buildPullResponse(ctx, lookup.patch, updatedData, tags, targetDid, repoName, buildApiUrl(url), lookup.from);
  return jsonOk(pr);
}

// ---------------------------------------------------------------------------
// PUT /repos/:did/:repo/pulls/:number/update-branch — update pull request branch
// ---------------------------------------------------------------------------

export async function handleUpdatePullBranch(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const tags = (lookup.patch.tags as Record<string, string> | undefined) ?? {};
  if ((tags.status ?? 'open') !== 'open') {
    return jsonValidationError('Validation Failed: pull request branch can only be updated for open pull requests.');
  }

  const expectedHeadSha = reqBody.expected_head_sha;
  if (expectedHeadSha !== undefined && typeof expectedHeadSha !== 'string') {
    return jsonValidationError('Validation Failed: expected_head_sha must be a string.');
  }

  const currentHeadSha = await latestRevisionHead(ctx, lookup.from, lookup.patch);
  if (expectedHeadSha && expectedHeadSha !== currentHeadSha) {
    return jsonValidationError('Validation Failed: expected_head_sha does not match the pull request head SHA.');
  }

  const currentStatus = tags.status ?? 'open';
  const { status } = await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data: {
      reason          : 'Update branch requested',
      baseBranch      : tags.baseBranch ?? 'main',
      headBranch      : tags.headBranch ?? null,
      currentHeadSha  : currentHeadSha || null,
      expectedHeadSha : expectedHeadSha ?? null,
    },
    tags            : { from: currentStatus, to: currentStatus },
    parentContextId : lookup.patch.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to update pull request branch: ${status.detail}`);
  }

  const pullUrl = `${buildApiUrl(url)}/repos/${targetDid}/${repoName}/pulls/${number}`;
  return jsonAccepted({
    message : 'Updating pull request branch.',
    url     : pullUrl,
  });
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/merge — check if pull request has merged
// ---------------------------------------------------------------------------

export async function handleCheckPullMerged(
  ctx: AgentContext, targetDid: string, repoName: string, number: string,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const tags = (lookup.patch.tags as Record<string, string> | undefined) ?? {};
  if (tags.status === 'merged') {
    return jsonNoContent();
  }

  const { records: mergeResults } = await ctx.patches.records.query('repo/patch/mergeResult' as any, {
    from   : lookup.from,
    filter : { contextId: lookup.patch.contextId },
  });

  if (mergeResults.length > 0) {
    return jsonNoContent();
  }

  return jsonNotFound(`Pull request #${number} has not been merged.`);
}

// ---------------------------------------------------------------------------
// PUT /repos/:did/:repo/pulls/:number/merge — merge pull request
// ---------------------------------------------------------------------------

export async function handleMergePull(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, _url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const num = parseInt(number, 10);
  const { records } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });

  const rec = records.find(r => numericId(r.id ?? '') === num);
  if (!rec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  const data = await rec.data.json();
  const tags = (rec.tags as Record<string, string> | undefined) ?? {};

  if (tags.status === 'merged') {
    return jsonMethodNotAllowed(`Pull request #${number} is already merged.`);
  }

  if (tags.status === 'closed') {
    return jsonMethodNotAllowed(`Pull request #${number} is closed. Reopen it before merging.`);
  }

  // Update the patch status to merged.
  const mergeStrategy = (reqBody.merge_method as string) ?? 'merge';

  const { status } = await rec.update({
    data : data,
    tags : { ...tags, status: 'merged' },
  });

  if (status.code >= 300) {
    return jsonValidationError(`Failed to merge pull request: ${status.detail}`);
  }

  // Create a merge result record.
  const commitSha = (reqBody.sha as string) ?? 'pending';
  await ctx.patches.records.create('repo/patch/mergeResult' as any, {
    data            : { mergedBy: ctx.did },
    tags            : { mergeCommit: commitSha, strategy: mergeStrategy },
    parentContextId : rec.contextId,
  } as any);

  // Audit trail.
  await ctx.patches.records.create('repo/patch/statusChange' as any, {
    data            : { reason: `Merged via ${mergeStrategy} strategy` },
    tags            : { from: tags.status ?? 'open', to: 'merged' },
    parentContextId : rec.contextId,
  } as any);

  // GitHub returns a merge result object.
  return jsonOk({
    sha     : commitSha,
    merged  : true,
    message : `Pull request #${number} merged successfully.`,
  });
}

// ---------------------------------------------------------------------------
// POST /repos/:did/:repo/pulls/:number/reviews — create review
// ---------------------------------------------------------------------------

export async function handleCreatePullReview(
  ctx: AgentContext, targetDid: string, repoName: string,
  number: string, reqBody: Record<string, unknown>, url: URL, bodyMediaKind?: BodyMediaKind | null,
): Promise<JsonResponse> {
  const lookup = await findPatchForPull(ctx, targetDid, repoName, number);
  if (lookup.kind === 'response') {
    return lookup.response;
  }

  const baseUrl = buildApiUrl(url);
  const reviewBody = (reqBody.body as string) ?? '';

  const hasEvent = typeof reqBody.event === 'string' && reqBody.event !== '';
  const state = hasEvent ? eventToReviewState(reqBody.event) : 'PENDING';
  if (!state) {
    return jsonValidationError('Validation Failed: event must be APPROVE, REQUEST_CHANGES, or COMMENT.');
  }
  if ((state === 'CHANGES_REQUESTED' || state === 'COMMENTED') && !reviewBody) {
    return jsonValidationError('Validation Failed: body is required for REQUEST_CHANGES or COMMENT reviews.');
  }

  const commentDrafts = parseReviewCommentDrafts(reqBody.comments);
  if (commentDrafts.kind === 'error') {
    return jsonValidationError(commentDrafts.message);
  }

  const commitId = typeof reqBody.commit_id === 'string'
    ? reqBody.commit_id
    : await latestRevisionHead(ctx, lookup.from, lookup.patch);
  const data: Record<string, unknown> = { body: reviewBody };
  if (state === 'PENDING') {
    data.githubReviewState = 'PENDING';
  }
  const tags: Record<string, string> = { verdict: stateToVerdict(state) };
  if (commitId) {
    tags.commitId = commitId;
  }

  const { status, record: reviewRec } = await ctx.patches.records.create('repo/patch/review' as any, {
    data            : data,
    tags            : tags,
    parentContextId : lookup.patch.contextId,
  } as any);

  if (status.code >= 300) {
    return jsonValidationError(`Failed to create review: ${status.detail}`);
  }
  if (!reviewRec) {throw new Error('Failed to create review record');}

  for (const comment of commentDrafts.drafts) {
    const tags: Record<string, unknown> = {
      path        : comment.path,
      side        : comment.side,
      subjectType : comment.subjectType,
    };
    if (comment.line) { tags.line = comment.line; }
    if (comment.startLine) { tags.startLine = comment.startLine; }
    if (comment.startSide) { tags.startSide = comment.startSide; }
    if (commitId) {
      tags.commitId = commitId;
    }

    const { status: commentStatus } = await ctx.patches.records.create('repo/patch/review/reviewComment' as any, {
      data            : { body: comment.body, diffHunk: comment.diffHunk },
      tags,
      parentContextId : reviewRec.contextId,
    } as any);

    if (commentStatus.code >= 300) {
      return jsonValidationError(`Failed to create review comment: ${commentStatus.detail}`);
    }
  }

  const entry: PullReviewEntry = {
    patch  : lookup.patch,
    review : reviewRec,
    data,
    tags,
  };

  return jsonCreated(buildPullReviewResponse(entry, targetDid, repoName, number, baseUrl, commitId, bodyMediaKind));
}

// ---------------------------------------------------------------------------
// GET /repos/:did/:repo/pulls/:number/files — list changed files
// ---------------------------------------------------------------------------

export async function handleListPullFiles(
  ctx: AgentContext, targetDid: string, repoName: string, number: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const from = fromOpt(ctx, targetDid);
  const baseUrl = buildApiUrl(url);

  // Find the patch.
  const num = parseInt(number, 10);
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });

  const patchRec = patches.find(r => numericId(r.id ?? '') === num);
  if (!patchRec) {
    return jsonNotFound(`Pull request #${number} not found.`);
  }

  // Fetch latest revision for diff stats.
  const { records: revisions } = await ctx.patches.records.query('repo/patch/revision' as any, {
    from,
    filter   : { contextId: patchRec.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (revisions.length === 0) {
    return jsonOk([]);
  }

  const rev = revisions[0];
  const revTags = (rev.tags as Record<string, string> | undefined) ?? {};
  const headSha = revTags.headCommit ?? '';

  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;

  try {
    const revData = await rev.data.json();
    if (revData.diffStat) {
      additions = revData.diffStat.additions ?? 0;
      deletions = revData.diffStat.deletions ?? 0;
      filesChanged = revData.diffStat.filesChanged ?? 0;
    }
  } catch { /* revision may not have parseable JSON body */ }

  // DWN revisions store only aggregate diff stats, not per-file details.
  // Return a summary entry so tools like `gh pr diff --name-only` get
  // useful output while the per-file breakdown is not yet available.
  if (filesChanged === 0 && additions === 0 && deletions === 0) {
    return jsonOk([]);
  }

  const files: Record<string, unknown>[] = [{
    sha          : headSha,
    filename     : `(${filesChanged} file${filesChanged !== 1 ? 's' : ''} changed)`,
    status       : 'modified',
    additions,
    deletions,
    changes      : additions + deletions,
    blob_url     : `${baseUrl}/repos/${targetDid}/${repoName}/blob/${headSha}`,
    raw_url      : `${baseUrl}/repos/${targetDid}/${repoName}/raw/${headSha}`,
    contents_url : `${baseUrl}/repos/${targetDid}/${repoName}/contents?ref=${headSha}`,
    patch        : '',
  }];

  return jsonOk(files);
}
