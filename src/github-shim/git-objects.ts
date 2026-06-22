/**
 * GitHub API shim — git object and tree-backed content endpoints.
 *
 * Reads objects from the local bare git repository store and maps them to
 * GitHub REST API v3 responses.  This complements the DWN-backed social and
 * metadata records with the actual git object graph exposed through familiar
 * `/git/blobs`, `/git/trees`, `/git/commits`, `/commits`, and `/contents`
 * shapes, plus history comparison.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { ContentMediaKind } from './contents.js';
import type { JsonResponse } from './helpers.js';

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createRefSyncer } from '../git-server/ref-sync.js';
import { GitBackend } from '../git-server/git-backend.js';
import { renderMarkdownText } from './meta.js';
import { resolveReposPath } from '../cli/flags.js';

import {
  baseHeaders,
  binaryOk,
  buildApiUrl,
  buildLinkHeader,
  getRepoRecord,
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  paginate,
  parsePagination,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitObjectOptions = {
  /** Base directory where gitd stores bare repositories. */
  reposPath? : string;
};

type GitResult = {
  status : number;
  stdout : Buffer;
  stderr : Buffer;
};

type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
type GitTagTargetType = 'blob' | 'tree' | 'commit';

type GitIdentity = {
  name : string;
  email : string;
  date : string;
};

type GitIdentityInput = {
  name : string;
  email : string;
  date? : string;
};

type GitCommitInfo = {
  sha : string;
  treeSha : string;
  parentShas : string[];
  author : GitIdentity;
  committer : GitIdentity;
  message : string;
};

type GitTagInfo = {
  sha : string;
  tag : string;
  message : string;
  object : {
    sha : string;
    type : GitTagTargetType;
  };
  tagger : GitIdentity;
};

type TreeEntry = {
  path : string;
  mode : string;
  type : GitTagTargetType;
  sha : string;
  size? : number;
};

type LocalRepoLookup = {
  repoPath : string;
} | null;

type ContentLookup =
  | { kind: 'missing-local-repo' }
  | { kind: 'response'; response: JsonResponse };

type RequestedRef = {
  ref : string;
  explicit : boolean;
};

type DiffNameStatus = {
  filename : string;
  status : string;
  previousFilename? : string;
};

type DiffStats = {
  additions : number;
  deletions : number;
};

type GitContributor = {
  name : string;
  email : string;
  contributions : number;
};

type ArchiveKind = 'tarball' | 'zipball';
type CompareTextKind = 'diff' | 'patch';
type CommitMediaKind = 'diff' | 'patch' | 'sha';

const README_CANDIDATES = ['README.md', 'README', 'README.txt', 'README.rst'];

type TreeWriteEntry = {
  path : string;
  mode : string;
  type : GitTagTargetType;
  sha? : string | null;
  content? : string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TREE_MODES = new Set(['100644', '100755', '040000', '160000', '120000']);
const DEFAULT_GIT_IDENTITY: GitIdentityInput = {
  name  : 'gitd',
  email : 'gitd@example.invalid',
};

// ---------------------------------------------------------------------------
// Local repo lookup
// ---------------------------------------------------------------------------

function localRepo(ctx: AgentContext, targetDid: string, repoName: string, options: GitObjectOptions): LocalRepoLookup {
  const reposPath = options.reposPath ?? resolveReposPath([], ctx.profileName ?? null);
  const backend = new GitBackend({ basePath: reposPath });

  try {
    if (!backend.exists(targetDid, repoName)) {
      return null;
    }
    return { repoPath: backend.repoPath(targetDid, repoName) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git process helpers
// ---------------------------------------------------------------------------

async function runGit(
  repoPath: string,
  args: string[],
  env?: Record<string, string>,
  input?: Uint8Array | string,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      env   : env ? { ...process.env, ...env } : process.env,
      stdio : input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status : code ?? 128,
        stdout : Buffer.concat(stdout),
        stderr : Buffer.concat(stderr),
      });
    });

    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}

async function gitOk(repoPath: string, args: string[]): Promise<Buffer | null> {
  const result = await runGit(repoPath, args);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

async function gitText(repoPath: string, args: string[]): Promise<string | null> {
  const out = await gitOk(repoPath, args);
  return out ? out.toString('utf-8').trim() : null;
}

function gitError(result: GitResult): string {
  return result.stderr.toString('utf-8').trim() || result.stdout.toString('utf-8').trim() || `git exited with status ${result.status}`;
}

function jsonConflict(message: string): JsonResponse {
  return {
    status  : 409,
    headers : baseHeaders(),
    body    : JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest' }),
  };
}

function redirectFound(location: string): JsonResponse {
  return {
    status  : 302,
    headers : {
      ...baseHeaders(),
      'Content-Type' : 'text/plain; charset=utf-8',
      Location       : location,
    },
    body: '',
  };
}

// ---------------------------------------------------------------------------
// Revision/object resolution
// ---------------------------------------------------------------------------

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSafeRef(value: string): boolean {
  if (FULL_SHA_RE.test(value)) {
    return true;
  }
  if (!SAFE_REF_RE.test(value)) {
    return false;
  }
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.lock')) {
    return false;
  }
  return !value.split('/').some((part) => part === '.' || part === '..' || part.startsWith('-'));
}

function refCandidates(rawRef: string): string[] {
  const ref = decodeRouteParam(rawRef).replace(/^\/+/, '');
  if (!isSafeRef(ref)) {
    return [];
  }
  if (FULL_SHA_RE.test(ref)) {
    return [ref.toLowerCase()];
  }
  if (ref.startsWith('refs/')) {
    return [ref];
  }
  return [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
}

async function resolveObject(repoPath: string, rawRef: string, peel: 'commit' | 'tree' | 'object'): Promise<string | null> {
  for (const candidate of refCandidates(rawRef)) {
    const suffix = peel === 'object' ? '' : `^{${peel}}`;
    const resolved = await gitText(repoPath, ['rev-parse', '--verify', '--end-of-options', `${candidate}${suffix}`]);
    if (resolved && FULL_SHA_RE.test(resolved)) {
      return resolved.toLowerCase();
    }
  }
  return null;
}

async function objectType(repoPath: string, sha: string): Promise<GitObjectType | null> {
  if (!FULL_SHA_RE.test(sha)) {
    return null;
  }
  const type = await gitText(repoPath, ['cat-file', '-t', sha.toLowerCase()]);
  if (type === 'blob' || type === 'tree' || type === 'commit' || type === 'tag') {
    return type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git object parsing
// ---------------------------------------------------------------------------

async function readCommit(repoPath: string, rawRef: string): Promise<GitCommitInfo | null> {
  const sha = await resolveObject(repoPath, rawRef, 'commit');
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

  const message = parts.slice(9).join('\0').replace(/\n+$/, '');
  return {
    sha        : parts[0],
    treeSha    : parts[1],
    parentShas : parts[2] ? parts[2].split(' ') : [],
    author     : { name: parts[3], email: parts[4], date: parts[5] },
    committer  : { name: parts[6], email: parts[7], date: parts[8] },
    message,
  };
}

function parseGitIdentity(raw: string): GitIdentity | null {
  const match = raw.match(/^(.+) <([^<>]*)> (\d+) ([+-]\d{4})$/);
  if (!match) {
    return null;
  }

  const seconds = Number.parseInt(match[3], 10);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return {
    name  : match[1],
    email : match[2],
    date  : new Date(seconds * 1000).toISOString(),
  };
}

async function readTag(repoPath: string, rawRef: string): Promise<GitTagInfo | null> {
  const sha = await resolveObject(repoPath, rawRef, 'object');
  if (!sha || await objectType(repoPath, sha) !== 'tag') {
    return null;
  }

  const out = await gitOk(repoPath, ['cat-file', 'tag', sha]);
  if (!out) {
    return null;
  }

  const raw = out.toString('utf-8');
  const split = raw.indexOf('\n\n');
  if (split < 0) {
    return null;
  }

  const headerLines = raw.slice(0, split).split('\n');
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const space = line.indexOf(' ');
    if (space <= 0) {
      continue;
    }
    headers.set(line.slice(0, space), line.slice(space + 1));
  }

  const type = headers.get('type');
  const objectSha = headers.get('object');
  const tag = headers.get('tag');
  const tagger = headers.get('tagger');
  if (
    (type !== 'blob' && type !== 'tree' && type !== 'commit') ||
    !objectSha ||
    !FULL_SHA_RE.test(objectSha) ||
    !tag ||
    !tagger
  ) {
    return null;
  }

  const identity = parseGitIdentity(tagger);
  if (!identity) {
    return null;
  }

  return {
    sha,
    tag,
    message : raw.slice(split + 2).replace(/\n+$/, ''),
    object  : { sha: objectSha.toLowerCase(), type },
    tagger  : identity,
  };
}

function parseTreeEntries(raw: Buffer, prefix = ''): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const records = raw.toString('utf-8').split('\0');

  for (const record of records) {
    if (!record) {
      continue;
    }

    const match = record.match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})(?: +(-|\d+))?\t(.+)$/);
    if (!match) {
      continue;
    }

    const size = match[4] && match[4] !== '-' ? parseInt(match[4], 10) : undefined;
    const entryPath = prefix ? `${prefix}/${match[5]}` : match[5];
    entries.push({
      path : entryPath,
      mode : match[1],
      type : match[2] as 'blob' | 'tree' | 'commit',
      sha  : match[3],
      ...(size !== undefined ? { size } : {}),
    });
  }

  return entries;
}

async function listTree(repoPath: string, treeSha: string, recursive: boolean): Promise<TreeEntry[] | null> {
  const args = recursive
    ? ['ls-tree', '-l', '-z', '-r', '-t', treeSha]
    : ['ls-tree', '-l', '-z', treeSha];
  const out = await gitOk(repoPath, args);
  return out ? parseTreeEntries(out) : null;
}

function normalizeContentPath(path: string | null): string | null {
  if (!path) {
    return '';
  }

  const decoded = decodeRouteParam(path).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!decoded) {
    return '';
  }
  if (decoded.includes('\0') || decoded.includes('//')) {
    return null;
  }
  if (decoded.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return decoded;
}

function normalizeWriteBranch(branch: string): string | null {
  const decoded = decodeRouteParam(branch).replace(/^\/+/, '');
  const shortName = decoded.startsWith('refs/heads/') ? decoded.slice('refs/heads/'.length) : decoded;
  if (!shortName || shortName === 'HEAD' || shortName === '@' || FULL_SHA_RE.test(shortName) || shortName.startsWith('refs/')) {
    return null;
  }
  return isSafeRef(shortName) ? shortName : null;
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

async function requestedWriteBranch(
  ctx: AgentContext, targetDid: string, repoName: string, repoPath: string, body: Record<string, unknown>,
): Promise<string | JsonResponse> {
  if (body.branch !== undefined && body.branch !== null) {
    if (typeof body.branch !== 'string') {
      return jsonValidationError('Validation Failed: branch must be a string.');
    }
    const branch = normalizeWriteBranch(body.branch);
    return branch ?? jsonValidationError('Validation Failed: branch is invalid.');
  }

  try {
    const repo = await getRepoRecord(ctx, targetDid, repoName);
    const branch = repo?.defaultBranch ? normalizeWriteBranch(repo.defaultBranch) : null;
    if (branch) {
      return branch;
    }
  } catch {
    // A local git repository can still be written when the caller supplies a branch.
  }

  const symbolicHead = await gitText(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const headBranch = symbolicHead ? normalizeWriteBranch(symbolicHead) : null;
  return headBranch ?? 'main';
}

function requiredString(body: Record<string, unknown>, key: string): string | JsonResponse {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonValidationError(`Validation Failed: ${key} is required.`);
  }
  return value.trim();
}

function optionalBlobSha(body: Record<string, unknown>): string | JsonResponse | null {
  const value = body.sha;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !FULL_SHA_RE.test(value)) {
    return jsonValidationError('Validation Failed: sha must be a git blob SHA.');
  }
  return value.toLowerCase();
}

function decodeBase64Content(body: Record<string, unknown>): Buffer | JsonResponse {
  const value = body.content;
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: content is required.');
  }

  const compact = value.replace(/\s+/g, '');
  if (!BASE64_RE.test(compact)) {
    return jsonValidationError('Validation Failed: content must be Base64 encoded.');
  }
  return Buffer.from(compact, 'base64');
}

function optionalIdentity(value: unknown, field: string, fallback: GitIdentityInput): GitIdentityInput | JsonResponse {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'object') {
    return jsonValidationError(`Validation Failed: ${field} must be an object.`);
  }

  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return jsonValidationError(`Validation Failed: ${field}.name is required.`);
  }
  if (typeof input.email !== 'string' || input.email.trim().length === 0) {
    return jsonValidationError(`Validation Failed: ${field}.email is required.`);
  }
  if (input.date !== undefined && (typeof input.date !== 'string' || Number.isNaN(Date.parse(input.date)))) {
    return jsonValidationError(`Validation Failed: ${field}.date must be an ISO 8601 timestamp.`);
  }

  return {
    name  : input.name.trim(),
    email : input.email.trim(),
    ...(typeof input.date === 'string' ? { date: input.date } : {}),
  };
}

function commitEnv(author: GitIdentityInput, committer: GitIdentityInput): Record<string, string> {
  return {
    GIT_AUTHOR_NAME     : author.name,
    GIT_AUTHOR_EMAIL    : author.email,
    GIT_COMMITTER_NAME  : committer.name,
    GIT_COMMITTER_EMAIL : committer.email,
    ...(author.date ? { GIT_AUTHOR_DATE: author.date } : {}),
    ...(committer.date ? { GIT_COMMITTER_DATE: committer.date } : {}),
  };
}

async function syncRefsAfterContentWrite(ctx: AgentContext, targetDid: string, repoName: string, repoPath: string): Promise<void> {
  if (targetDid !== ctx.did) {
    return;
  }

  try {
    const repo = await getRepoRecord(ctx, targetDid, repoName);
    if (!repo?.contextId) {
      return;
    }
    await createRefSyncer({ refs: ctx.refs, repoContextId: repo.contextId })(targetDid, repoName, repoPath);
  } catch (err) {
    console.warn(`ref-sync: failed after contents write for ${targetDid}/${repoName}: ${(err as Error).message}`);
  }
}

async function commitViaWorktree(
  repoPath: string,
  branch: string,
  message: string,
  author: GitIdentityInput,
  committer: GitIdentityInput,
  mutate: (workDir: string) => Promise<JsonResponse | undefined>,
): Promise<string | JsonResponse> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gitd-content-write-'));
  const workDir = join(tmpRoot, 'work');

  try {
    const clone = await runGit(process.cwd(), ['clone', '--quiet', repoPath, workDir]);
    if (clone.status !== 0) {
      return jsonValidationError(`Failed to clone repository storage: ${gitError(clone)}`);
    }

    const checkout = await runGit(workDir, ['checkout', '--quiet', branch]);
    if (checkout.status !== 0) {
      return jsonNotFound(`Branch '${branch}' not found.`);
    }

    const mutationError = await mutate(workDir);
    if (mutationError) {
      return mutationError;
    }

    const status = await gitText(workDir, ['status', '--porcelain']);
    if (!status) {
      return jsonConflict('No changes to commit.');
    }

    const commit = await runGit(workDir, ['commit', '-m', message], commitEnv(author, committer));
    if (commit.status !== 0) {
      return jsonValidationError(`Failed to commit contents change: ${gitError(commit)}`);
    }

    const commitSha = await gitText(workDir, ['rev-parse', '--verify', 'HEAD']);
    if (!commitSha) {
      return jsonValidationError('Failed to resolve committed contents change.');
    }

    const push = await runGit(workDir, ['push', '--quiet', 'origin', `HEAD:${branchRef(branch)}`]);
    if (push.status !== 0) {
      return jsonValidationError(`Failed to update branch '${branch}': ${gitError(push)}`);
    }

    return commitSha;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function gitObjectUrlKind(type: GitObjectType): string {
  return type === 'blob' ? 'blobs' : type === 'tree' ? 'trees' : type === 'tag' ? 'tags' : 'commits';
}

function buildGitRefObjectResponse(ref: string, sha: string, type: GitObjectType, repoBase: string): Record<string, unknown> {
  const refPath = ref.replace(/^refs\//, '');
  return {
    ref,
    node_id : nodeId('ref', ref),
    url     : `${repoBase}/git/refs/${refPath}`,
    object  : {
      type,
      sha,
      url: `${repoBase}/git/${gitObjectUrlKind(type)}/${sha}`,
    },
  };
}

function buildGitTagResponse(tag: GitTagInfo, repoBase: string): Record<string, unknown> {
  return {
    node_id : nodeId('tag', tag.sha),
    tag     : tag.tag,
    sha     : tag.sha,
    url     : `${repoBase}/git/tags/${tag.sha}`,
    message : tag.message,
    tagger  : tag.tagger,
    object  : {
      type : tag.object.type,
      sha  : tag.object.sha,
      url  : `${repoBase}/git/${gitObjectUrlKind(tag.object.type)}/${tag.object.sha}`,
    },
    verification: verification(),
  };
}

function decodeGitBlobContent(body: Record<string, unknown>): Buffer | JsonResponse {
  const value = body.content;
  if (typeof value !== 'string') {
    return jsonValidationError('Validation Failed: content is required.');
  }

  const encoding = typeof body.encoding === 'string' ? body.encoding.toLowerCase() : 'utf-8';
  if (encoding === 'utf-8' || encoding === 'utf8') {
    return Buffer.from(value, 'utf-8');
  }
  if (encoding === 'base64') {
    const compact = value.replace(/\s+/g, '');
    if (!BASE64_RE.test(compact)) {
      return jsonValidationError('Validation Failed: content must be Base64 encoded.');
    }
    return Buffer.from(compact, 'base64');
  }
  return jsonValidationError('Validation Failed: encoding must be utf-8 or base64.');
}

function cleanTagName(value: unknown): string | JsonResponse {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonValidationError('Validation Failed: tag is required.');
  }
  const tag = value.trim();
  if (tag.includes('\0') || tag.includes('\n') || tag.includes('\r')) {
    return jsonValidationError('Validation Failed: tag is invalid.');
  }
  return tag;
}

function gitTimestamp(identity: GitIdentityInput): string {
  const millis = identity.date ? Date.parse(identity.date) : Date.now();
  const seconds = Math.floor((Number.isFinite(millis) ? millis : Date.now()) / 1000);
  return `${seconds} +0000`;
}

function taggerLine(identity: GitIdentityInput): string {
  return `${identity.name} <${identity.email}> ${gitTimestamp(identity)}`;
}

async function writeGitBlob(repoPath: string, content: Buffer): Promise<string | JsonResponse> {
  const result = await runGit(repoPath, ['hash-object', '-w', '--stdin'], undefined, content);
  const sha = result.stdout.toString('utf-8').trim();
  if (result.status !== 0 || !FULL_SHA_RE.test(sha)) {
    return jsonValidationError(`Failed to create git blob: ${gitError(result)}`);
  }
  return sha.toLowerCase();
}

function normalizedObjectPath(value: unknown, fieldName = 'path'): string | JsonResponse {
  if (typeof value !== 'string') {
    return jsonValidationError(`Validation Failed: ${fieldName} is required.`);
  }
  const path = normalizeContentPath(value);
  if (!path) {
    return jsonValidationError(`Validation Failed: ${fieldName} is invalid.`);
  }
  return path;
}

function requiredSha(value: unknown, fieldName: string): string | JsonResponse {
  if (typeof value !== 'string' || !FULL_SHA_RE.test(value)) {
    return jsonValidationError(`Validation Failed: ${fieldName} must be a SHA.`);
  }
  return value.toLowerCase();
}

function modeMatchesType(mode: string, type: GitObjectType): boolean {
  if ((mode === '100644' || mode === '100755' || mode === '120000') && type === 'blob') {
    return true;
  }
  if (mode === '040000' && type === 'tree') {
    return true;
  }
  return mode === '160000' && type === 'commit';
}

function parseTreeEntry(value: unknown, index: number): TreeWriteEntry | JsonResponse {
  if (typeof value !== 'object' || value === null) {
    return jsonValidationError(`Validation Failed: tree[${index}] must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const path = normalizedObjectPath(raw.path, `tree[${index}].path`);
  if (typeof path !== 'string') {
    return path;
  }

  if (typeof raw.mode !== 'string' || !TREE_MODES.has(raw.mode)) {
    return jsonValidationError(`Validation Failed: tree[${index}].mode is invalid.`);
  }
  if (raw.type !== 'blob' && raw.type !== 'tree' && raw.type !== 'commit') {
    return jsonValidationError(`Validation Failed: tree[${index}].type is invalid.`);
  }
  if (!modeMatchesType(raw.mode, raw.type)) {
    return jsonValidationError(`Validation Failed: tree[${index}].mode does not match type.`);
  }
  if (raw.sha !== undefined && raw.sha !== null && typeof raw.sha !== 'string') {
    return jsonValidationError(`Validation Failed: tree[${index}].sha must be a SHA or null.`);
  }
  if (raw.sha !== undefined && raw.sha !== null && !FULL_SHA_RE.test(raw.sha)) {
    return jsonValidationError(`Validation Failed: tree[${index}].sha must be a SHA or null.`);
  }
  if (raw.content !== undefined && typeof raw.content !== 'string') {
    return jsonValidationError(`Validation Failed: tree[${index}].content must be a string.`);
  }
  if (raw.content !== undefined && raw.sha !== undefined) {
    return jsonValidationError(`Validation Failed: tree[${index}] cannot specify both sha and content.`);
  }
  if (raw.content !== undefined && raw.type !== 'blob') {
    return jsonValidationError(`Validation Failed: tree[${index}].content is only supported for blobs.`);
  }
  if (raw.content === undefined && raw.sha === undefined) {
    return jsonValidationError(`Validation Failed: tree[${index}] must specify sha, null sha, or content.`);
  }

  return {
    path,
    mode    : raw.mode,
    type    : raw.type,
    sha     : raw.sha === null ? null : typeof raw.sha === 'string' ? raw.sha.toLowerCase() : undefined,
    content : typeof raw.content === 'string' ? raw.content : undefined,
  };
}

async function removeIndexPath(repoPath: string, path: string, env: Record<string, string>): Promise<boolean | JsonResponse> {
  const listed = await runGit(repoPath, ['ls-files', '-z', '--', path], env);
  if (listed.status !== 0) {
    return jsonValidationError(`Failed to inspect tree path '${path}': ${gitError(listed)}`);
  }
  if (listed.stdout.byteLength === 0) {
    return false;
  }

  const removed = await runGit(repoPath, ['update-index', '--force-remove', '-z', '--stdin'], env, listed.stdout);
  if (removed.status !== 0) {
    return jsonValidationError(`Failed to remove tree path '${path}': ${gitError(removed)}`);
  }
  return true;
}

async function applyTreeEntry(repoPath: string, entry: TreeWriteEntry, env: Record<string, string>): Promise<JsonResponse | undefined> {
  if (entry.sha === null) {
    const removed = await removeIndexPath(repoPath, entry.path, env);
    if (typeof removed !== 'boolean') {
      return removed;
    }
    if (!removed) {
      return jsonConflict(`Tree path '${entry.path}' does not exist.`);
    }
    return undefined;
  }

  let sha = entry.sha;
  if (entry.content !== undefined) {
    const blobSha = await writeGitBlob(repoPath, Buffer.from(entry.content, 'utf-8'));
    if (typeof blobSha !== 'string') {
      return blobSha;
    }
    sha = blobSha;
  }
  if (!sha) {
    return jsonValidationError(`Validation Failed: tree entry '${entry.path}' is missing a SHA.`);
  }

  const type = await objectType(repoPath, sha);
  if (type !== entry.type) {
    return jsonValidationError(`Validation Failed: tree entry '${entry.path}' points to a missing or incompatible object.`);
  }

  const removed = await removeIndexPath(repoPath, entry.path, env);
  if (typeof removed !== 'boolean') {
    return removed;
  }

  if (entry.type === 'tree') {
    const imported = await runGit(repoPath, ['read-tree', `--prefix=${entry.path}/`, '-i', sha], env);
    if (imported.status !== 0) {
      return jsonValidationError(`Failed to import tree '${entry.path}': ${gitError(imported)}`);
    }
    return undefined;
  }

  const added = await runGit(repoPath, ['update-index', '--add', '--cacheinfo', `${entry.mode},${sha},${entry.path}`], env);
  if (added.status !== 0) {
    return jsonValidationError(`Failed to stage tree entry '${entry.path}': ${gitError(added)}`);
  }
  return undefined;
}

async function createGitTreeObject(repoPath: string, body: Record<string, unknown>): Promise<string | JsonResponse> {
  if (!Array.isArray(body.tree)) {
    return jsonValidationError('Validation Failed: tree is required.');
  }

  const entries: TreeWriteEntry[] = [];
  for (let i = 0; i < body.tree.length; i++) {
    const entry = parseTreeEntry(body.tree[i], i);
    if ('status' in entry) {
      return entry;
    }
    entries.push(entry);
  }

  let baseTree: string | null = null;
  if (body.base_tree !== undefined && body.base_tree !== null) {
    if (typeof body.base_tree !== 'string') {
      return jsonValidationError('Validation Failed: base_tree must be a tree SHA or ref.');
    }
    baseTree = await resolveObject(repoPath, body.base_tree, 'tree');
    if (!baseTree) {
      return jsonNotFound(`Base tree '${body.base_tree}' not found.`);
    }
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'gitd-tree-index-'));
  const env = { GIT_INDEX_FILE: join(tmpRoot, 'index') };
  try {
    const reset = await runGit(repoPath, ['read-tree', '--empty'], env);
    if (reset.status !== 0) {
      return jsonValidationError(`Failed to initialize temporary tree index: ${gitError(reset)}`);
    }
    if (baseTree) {
      const base = await runGit(repoPath, ['read-tree', baseTree], env);
      if (base.status !== 0) {
        return jsonValidationError(`Failed to read base tree: ${gitError(base)}`);
      }
    }

    for (const entry of entries) {
      const error = await applyTreeEntry(repoPath, entry, env);
      if (error) {
        return error;
      }
    }

    const write = await runGit(repoPath, ['write-tree'], env);
    const sha = write.stdout.toString('utf-8').trim();
    if (write.status !== 0 || !FULL_SHA_RE.test(sha)) {
      return jsonValidationError(`Failed to create git tree: ${gitError(write)}`);
    }
    return sha.toLowerCase();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function parseCommitParents(repoPath: string, value: unknown): Promise<string[] | JsonResponse> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return jsonValidationError('Validation Failed: parents must be an array.');
  }

  const parents: string[] = [];
  for (const [index, parent] of value.entries()) {
    const sha = requiredSha(parent, `parents[${index}]`);
    if (typeof sha !== 'string') {
      return sha;
    }
    const type = await objectType(repoPath, sha);
    if (type !== 'commit') {
      return jsonNotFound(`Parent commit '${sha}' not found.`);
    }
    parents.push(sha);
  }
  return parents;
}

function normalizeGitReference(value: string): string | null {
  const ref = decodeRouteParam(value).replace(/^\/+/, '');
  if (!ref.startsWith('refs/') || ref.split('/').length < 3 || !isSafeRef(ref)) {
    return null;
  }
  return ref;
}

function normalizeRouteGitReference(value: string): string | null {
  const ref = decodeRouteParam(value).replace(/^\/+/, '');
  return normalizeGitReference(ref.startsWith('refs/') ? ref : `refs/${ref}`);
}

async function localRefExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await runGit(repoPath, ['show-ref', '--verify', '--quiet', ref]);
  return result.status === 0;
}

async function localRefSha(repoPath: string, ref: string): Promise<string | null> {
  const sha = await gitText(repoPath, ['rev-parse', '--verify', '--end-of-options', ref]);
  return sha && FULL_SHA_RE.test(sha) ? sha.toLowerCase() : null;
}

async function hasLocalHead(repoPath: string): Promise<boolean> {
  const result = await runGit(repoPath, ['show-ref', '--heads', '--verify']);
  if (result.status === 0 && result.stdout.byteLength > 0) {
    return true;
  }
  const heads = await runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
  return heads.status === 0 && heads.stdout.toString('utf-8').trim().length > 0;
}

async function updateLocalRef(repoPath: string, ref: string, sha: string): Promise<JsonResponse | undefined> {
  const result = await runGit(repoPath, ['update-ref', ref, sha]);
  if (result.status !== 0) {
    return jsonValidationError(`Failed to update reference '${ref}': ${gitError(result)}`);
  }
  return undefined;
}

async function treeEntryAtPath(repoPath: string, commitSha: string, path: string): Promise<TreeEntry | null> {
  const out = await gitOk(repoPath, ['ls-tree', '-l', '-z', commitSha, '--', path]);
  const entries = out ? parseTreeEntries(out) : [];
  return entries.find((entry) => entry.path === path) ?? null;
}

async function listDirectory(repoPath: string, commitSha: string, path: string): Promise<TreeEntry[] | null> {
  if (!path) {
    const out = await gitOk(repoPath, ['ls-tree', '-l', '-z', commitSha]);
    return out ? parseTreeEntries(out) : null;
  }

  const entry = await treeEntryAtPath(repoPath, commitSha, path);
  if (!entry || entry.type !== 'tree') {
    return null;
  }

  const out = await gitOk(repoPath, ['ls-tree', '-l', '-z', entry.sha]);
  return out ? parseTreeEntries(out, path) : null;
}

async function readBlob(repoPath: string, sha: string): Promise<Buffer | null> {
  if (!FULL_SHA_RE.test(sha)) {
    return null;
  }
  const type = await objectType(repoPath, sha);
  if (type !== 'blob') {
    return null;
  }
  return gitOk(repoPath, ['cat-file', 'blob', sha.toLowerCase()]);
}

async function requestedContentRef(ctx: AgentContext, targetDid: string, repoName: string, url: URL): Promise<RequestedRef> {
  const explicitRef = url.searchParams.get('ref');
  if (explicitRef) {
    return { ref: explicitRef, explicit: true };
  }

  try {
    const repo = await getRepoRecord(ctx, targetDid, repoName);
    if (repo?.defaultBranch) {
      return { ref: repo.defaultBranch, explicit: false };
    }
  } catch {
    // A local git repo can still serve content if the DWN repo record is unavailable.
  }

  return { ref: 'HEAD', explicit: false };
}

async function defaultCommitRef(ctx: AgentContext, targetDid: string, repoName: string): Promise<string> {
  try {
    const repo = await getRepoRecord(ctx, targetDid, repoName);
    if (repo?.defaultBranch) {
      return repo.defaultBranch;
    }
  } catch {
    // A local git repo can still serve history if the DWN repo record is unavailable.
  }

  return 'HEAD';
}

function gitLines(out: Buffer | null): string[] {
  if (!out) {
    return [];
  }
  return out.toString('utf-8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function contributorKey(contributor: GitContributor): string {
  return (contributor.email || contributor.name).trim().toLowerCase();
}

function contributorLogin(contributor: GitContributor): string {
  const base = contributor.name || contributor.email.split('@')[0] || 'contributor';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = numericId(contributorKey(contributor)).toString(36);
  return `${slug || 'contributor'}-${suffix}`;
}

function parseShortlogContributors(raw: Buffer | null): GitContributor[] {
  const byKey = new Map<string, GitContributor>();

  for (const line of gitLines(raw)) {
    const match = line.match(/^(\d+)\s+(.+?)(?:\s+<([^<>]*)>)?$/);
    if (!match) {
      continue;
    }

    const contributions = parseInt(match[1], 10);
    if (!Number.isFinite(contributions) || contributions <= 0) {
      continue;
    }

    const name = (match[2] ?? '').trim();
    const email = (match[3] ?? '').trim();
    const key = (email || name).toLowerCase();
    if (!key) {
      continue;
    }

    const existing = byKey.get(key);
    if (existing) {
      existing.contributions += contributions;
      if (!existing.name && name) {
        existing.name = name;
      }
      if (!existing.email && email) {
        existing.email = email;
      }
      continue;
    }

    byKey.set(key, { name, email, contributions });
  }

  return [...byKey.values()].sort((a, b) => {
    if (b.contributions !== a.contributions) {
      return b.contributions - a.contributions;
    }
    return contributorKey(a).localeCompare(contributorKey(b));
  });
}

async function listCommitShas(
  repoPath: string, commitSha: string, url: URL, path: string | null,
): Promise<string[] | null> {
  const { page, perPage } = parsePagination(url);
  const args = [
    'rev-list',
    `--max-count=${perPage}`,
    `--skip=${(page - 1) * perPage}`,
  ];

  const since = url.searchParams.get('since');
  if (since) {
    args.push(`--since=${since}`);
  }

  const until = url.searchParams.get('until');
  if (until) {
    args.push(`--until=${until}`);
  }

  args.push(commitSha);
  if (path) {
    args.push('--', path);
  }

  const out = await gitOk(repoPath, args);
  return out ? gitLines(out) : null;
}

async function revListCount(repoPath: string, range: string): Promise<number> {
  const out = await gitText(repoPath, ['rev-list', '--count', range]);
  if (!out) {
    return 0;
  }
  const count = parseInt(out, 10);
  return Number.isFinite(count) ? count : 0;
}

async function compareCommitShas(repoPath: string, baseSha: string, headSha: string): Promise<string[] | null> {
  const out = await gitOk(repoPath, ['rev-list', '--reverse', '--max-count=250', `${baseSha}..${headSha}`]);
  return out ? gitLines(out) : null;
}

async function mergeBase(repoPath: string, baseSha: string, headSha: string): Promise<string | null> {
  const out = await gitText(repoPath, ['merge-base', baseSha, headSha]);
  return out && FULL_SHA_RE.test(out) ? out.toLowerCase() : null;
}

function compareStatus(aheadBy: number, behindBy: number): string {
  if (aheadBy === 0 && behindBy === 0) {
    return 'identical';
  }
  if (aheadBy > 0 && behindBy > 0) {
    return 'diverged';
  }
  return aheadBy > 0 ? 'ahead' : 'behind';
}

function statusFromDiffCode(code: string): string {
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'modified';
  }
}

function parseNameStatus(raw: Buffer | null): DiffNameStatus[] {
  const files: DiffNameStatus[] = [];
  for (const line of gitLines(raw)) {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (!code) {
      continue;
    }

    if ((code.startsWith('R') || code.startsWith('C')) && parts.length >= 3) {
      files.push({
        filename         : parts[2],
        previousFilename : parts[1],
        status           : statusFromDiffCode(code),
      });
      continue;
    }

    const filename = parts.slice(1).join('\t');
    if (filename) {
      files.push({ filename, status: statusFromDiffCode(code) });
    }
  }
  return files;
}

function parseNumStatValue(value: string): number {
  if (value === '-') {
    return 0;
  }
  const count = parseInt(value, 10);
  return Number.isFinite(count) ? count : 0;
}

function parseNumStats(raw: Buffer | null): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  for (const line of gitLines(raw)) {
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }

    const filename = parts[parts.length - 1];
    stats.set(filename, {
      additions : parseNumStatValue(parts[0]),
      deletions : parseNumStatValue(parts[1]),
    });
  }
  return stats;
}

async function blobShaAtPath(repoPath: string, commitSha: string, path: string): Promise<string | null> {
  const out = await gitText(repoPath, ['rev-parse', '--verify', '--end-of-options', `${commitSha}:${path}`]);
  return out && FULL_SHA_RE.test(out) ? out.toLowerCase() : null;
}

async function filePatch(repoPath: string, baseSha: string, headSha: string, path: string): Promise<string | undefined> {
  const out = await gitOk(repoPath, ['diff', '--patch', '--find-renames', '--unified=3', baseSha, headSha, '--', path]);
  if (!out || out.byteLength === 0) {
    return undefined;
  }

  const patch = out.toString('utf-8');
  return patch.length > 120_000 ? patch.slice(0, 120_000) : patch;
}

async function compareFiles(repoPath: string, baseSha: string, headSha: string, repoBase: string): Promise<Record<string, unknown>[]> {
  const names = parseNameStatus(await gitOk(repoPath, ['diff', '--name-status', '--find-renames', baseSha, headSha]));
  const stats = parseNumStats(await gitOk(repoPath, ['diff', '--numstat', '--find-renames', baseSha, headSha]));
  const files: Record<string, unknown>[] = [];

  for (const file of names) {
    const pathForBlob = file.status === 'removed' ? file.previousFilename ?? file.filename : file.filename;
    const blobRef = file.status === 'removed' ? baseSha : headSha;
    const sha = await blobShaAtPath(repoPath, blobRef, pathForBlob);
    const fileStats = stats.get(file.filename) ?? (file.previousFilename ? stats.get(file.previousFilename) : undefined) ?? {
      additions : 0,
      deletions : 0,
    };
    const encodedPath = encodePath(file.filename);
    const encodedRef = encodeURIComponent(blobRef);
    const patch = await filePatch(repoPath, baseSha, headSha, file.filename);

    files.push({
      sha,
      filename     : file.filename,
      status       : file.status,
      additions    : fileStats.additions,
      deletions    : fileStats.deletions,
      changes      : fileStats.additions + fileStats.deletions,
      blob_url     : `${repoBase}/blob/${encodedRef}/${encodedPath}`,
      raw_url      : `${repoBase}/raw/${encodedRef}/${encodedPath}`,
      contents_url : `${repoBase}/contents/${encodedPath}?ref=${encodedRef}`,
      ...(patch ? { patch } : {}),
      ...(file.previousFilename ? { previous_filename: file.previousFilename } : {}),
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// URL/response builders
// ---------------------------------------------------------------------------

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function repoApiBase(baseUrl: string, targetDid: string, repoName: string): string {
  return `${baseUrl}/repos/${targetDid}/${repoName}`;
}

function nodeId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf-8').toString('base64');
}

function archivePrefix(repoName: string, commitSha: string): string {
  const safeRepo = repoName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${safeRepo}-${commitSha.slice(0, 7)}`;
}

function archiveFilename(repoName: string, commitSha: string, kind: ArchiveKind): string {
  const ext = kind === 'tarball' ? 'tar.gz' : 'zip';
  return `${archivePrefix(repoName, commitSha)}.${ext}`;
}

function buildContributorResponse(contributor: GitContributor, baseUrl: string): Record<string, unknown> {
  const login = contributorLogin(contributor);
  const encodedLogin = encodeURIComponent(login);
  const idSource = contributorKey(contributor);

  return {
    login,
    id                  : numericId(idSource),
    node_id             : nodeId('contributor', idSource),
    avatar_url          : '',
    gravatar_id         : '',
    url                 : `${baseUrl}/users/${encodedLogin}`,
    html_url            : `${baseUrl}/users/${encodedLogin}`,
    followers_url       : `${baseUrl}/users/${encodedLogin}/followers`,
    following_url       : `${baseUrl}/users/${encodedLogin}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${encodedLogin}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${encodedLogin}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${encodedLogin}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${encodedLogin}/orgs`,
    repos_url           : `${baseUrl}/users/${encodedLogin}/repos`,
    events_url          : `${baseUrl}/users/${encodedLogin}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${encodedLogin}/received_events`,
    type                : 'User',
    site_admin          : false,
    contributions       : contributor.contributions,
    name                : contributor.name,
    email               : contributor.email || null,
  };
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

function buildGitTreeEntry(entry: TreeEntry, repoBase: string): Record<string, unknown> {
  const kind = entry.type === 'tree' ? 'trees' : entry.type === 'commit' ? 'commits' : 'blobs';
  return {
    path : entry.path,
    mode : entry.mode,
    type : entry.type,
    sha  : entry.sha,
    ...(entry.size !== undefined && entry.type === 'blob' ? { size: entry.size } : {}),
    url  : `${repoBase}/git/${kind}/${entry.sha}`,
  };
}

function buildCommitParents(parentShas: string[], repoBase: string): Record<string, unknown>[] {
  return parentShas.map((sha) => ({
    sha,
    url      : `${repoBase}/git/commits/${sha}`,
    html_url : `${repoBase}/commit/${sha}`,
  }));
}

function buildGitCommitResponse(commit: GitCommitInfo, repoBase: string): Record<string, unknown> {
  return {
    sha       : commit.sha,
    node_id   : nodeId('commit', commit.sha),
    url       : `${repoBase}/git/commits/${commit.sha}`,
    html_url  : `${repoBase}/commit/${commit.sha}`,
    author    : commit.author,
    committer : commit.committer,
    message   : commit.message,
    tree      : {
      sha : commit.treeSha,
      url : `${repoBase}/git/trees/${commit.treeSha}`,
    },
    parents      : buildCommitParents(commit.parentShas, repoBase),
    verification : verification(),
  };
}

function buildRepoCommitResponse(commit: GitCommitInfo, repoBase: string): Record<string, unknown> {
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
    parents      : buildCommitParents(commit.parentShas, repoBase),
  };
}

function contentType(entry: TreeEntry): 'file' | 'dir' | 'submodule' {
  if (entry.type === 'tree') {
    return 'dir';
  }
  if (entry.type === 'commit') {
    return 'submodule';
  }
  return 'file';
}

function rawBlobContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) { return 'text/markdown; charset=utf-8'; }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) { return 'text/html; charset=utf-8'; }
  if (lower.endsWith('.css')) { return 'text/css; charset=utf-8'; }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { return 'application/javascript; charset=utf-8'; }
  if (lower.endsWith('.json')) { return 'application/json; charset=utf-8'; }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) { return 'application/typescript; charset=utf-8'; }
  if (lower.endsWith('.txt') || lower === 'license') { return 'text/plain; charset=utf-8'; }
  return 'application/octet-stream';
}

function renderBlobHtml(path: string, content: Buffer): string {
  const text = content.toString('utf-8');
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return renderMarkdownText(text);
  }
  return `<pre>${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</pre>`;
}

function buildContentUrls(repoBase: string, path: string, ref: string, entry: TreeEntry): Record<string, unknown> {
  const encodedPath = encodePath(path);
  const encodedRef = encodeURIComponent(ref);
  const gitKind = entry.type === 'tree' ? 'trees' : entry.type === 'commit' ? 'commits' : 'blobs';
  const urls = {
    url          : `${repoBase}/contents/${encodedPath}`,
    html_url     : `${repoBase}/blob/${encodedRef}/${encodedPath}`,
    git_url      : `${repoBase}/git/${gitKind}/${entry.sha}`,
    download_url : entry.type === 'blob' ? `${repoBase}/raw/${encodedRef}/${encodedPath}` : null,
  };

  return {
    ...urls,
    _links: {
      self : urls.url,
      git  : urls.git_url,
      html : urls.html_url,
    },
  };
}

function buildContentEntry(repoBase: string, ref: string, entry: TreeEntry): Record<string, unknown> {
  return {
    name : basename(entry.path),
    path : entry.path,
    sha  : entry.sha,
    size : entry.type === 'blob' ? entry.size ?? 0 : 0,
    type : contentType(entry),
    ...buildContentUrls(repoBase, entry.path, ref, entry),
  };
}

function buildFileContent(repoBase: string, ref: string, entry: TreeEntry, content: Buffer): Record<string, unknown> {
  return {
    ...buildContentEntry(repoBase, ref, entry),
    content  : content.toString('base64'),
    encoding : 'base64',
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleGetGitBlob(
  ctx: AgentContext, targetDid: string, repoName: string, sha: string, url: URL, options: GitObjectOptions,
  mediaKind?: 'raw' | null,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const blob = await readBlob(repo.repoPath, sha);
  if (!blob) {
    return jsonNotFound(`Git blob '${sha}' not found.`);
  }

  if (mediaKind === 'raw') {
    return binaryOk(blob, 'application/octet-stream');
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  return jsonOk({
    sha      : sha.toLowerCase(),
    node_id  : nodeId('blob', sha.toLowerCase()),
    size     : blob.byteLength,
    url      : `${repoBase}/git/blobs/${sha.toLowerCase()}`,
    content  : blob.toString('base64'),
    encoding : 'base64',
  });
}

export async function handleGetGitTree(
  ctx: AgentContext, targetDid: string, repoName: string, rawTree: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const treeSha = await resolveObject(repo.repoPath, rawTree, 'tree');
  if (!treeSha) {
    return jsonNotFound(`Git tree '${decodeRouteParam(rawTree)}' not found.`);
  }

  const recursive = url.searchParams.get('recursive');
  const entries = await listTree(repo.repoPath, treeSha, recursive === '1' || recursive === 'true');
  if (!entries) {
    return jsonNotFound(`Git tree '${decodeRouteParam(rawTree)}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  return jsonOk({
    sha       : treeSha,
    url       : `${repoBase}/git/trees/${treeSha}`,
    tree      : entries.map((entry) => buildGitTreeEntry(entry, repoBase)),
    truncated : false,
  });
}

export async function handleGetGitCommit(
  ctx: AgentContext, targetDid: string, repoName: string, rawCommit: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const commit = await readCommit(repo.repoPath, rawCommit);
  if (!commit) {
    return jsonNotFound(`Git commit '${decodeRouteParam(rawCommit)}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(buildGitCommitResponse(commit, repoApiBase(baseUrl, targetDid, repoName)));
}

export async function tryGetGitRawContent(
  ctx: AgentContext, targetDid: string, repoName: string, rawRef: string, rawPath: string, options: GitObjectOptions,
): Promise<ContentLookup> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return { kind: 'missing-local-repo' };
  }

  const normalizedPath = normalizeContentPath(rawPath);
  if (!normalizedPath) {
    return { kind: 'response', response: jsonNotFound('Content path not found.') };
  }

  const commitSha = await resolveObject(repo.repoPath, rawRef, 'commit');
  if (!commitSha) {
    return { kind: 'response', response: jsonNotFound(`Git ref '${decodeRouteParam(rawRef)}' not found.`) };
  }

  const entry = await treeEntryAtPath(repo.repoPath, commitSha, normalizedPath);
  if (!entry || entry.type !== 'blob') {
    return { kind: 'response', response: jsonNotFound(`Content '${normalizedPath}' not found.`) };
  }

  const blob = await readBlob(repo.repoPath, entry.sha);
  if (!blob) {
    return { kind: 'response', response: jsonNotFound(`Content '${normalizedPath}' not found.`) };
  }

  return { kind: 'response', response: binaryOk(blob, rawBlobContentType(normalizedPath)) };
}

export async function handleCreateGitBlob(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const content = decodeGitBlobContent(body);
  if (!Buffer.isBuffer(content)) {
    return content;
  }

  const sha = await writeGitBlob(repo.repoPath, content);
  if (typeof sha !== 'string') {
    return sha;
  }

  const repoBase = repoApiBase(buildApiUrl(url), targetDid, repoName);
  return jsonCreated({
    sha,
    url: `${repoBase}/git/blobs/${sha}`,
  });
}

export async function handleCreateGitTree(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const sha = await createGitTreeObject(repo.repoPath, body);
  if (typeof sha !== 'string') {
    return sha;
  }

  const entries = await listTree(repo.repoPath, sha, false);
  if (!entries) {
    return jsonValidationError('Failed to read created git tree.');
  }

  const repoBase = repoApiBase(buildApiUrl(url), targetDid, repoName);
  return jsonCreated({
    sha,
    url       : `${repoBase}/git/trees/${sha}`,
    tree      : entries.map((entry) => buildGitTreeEntry(entry, repoBase)),
    truncated : false,
  });
}

export async function handleCreateGitCommit(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const message = requiredString(body, 'message');
  if (typeof message !== 'string') {
    return message;
  }

  if (typeof body.tree !== 'string') {
    return jsonValidationError('Validation Failed: tree is required.');
  }
  const treeSha = await resolveObject(repo.repoPath, body.tree, 'tree');
  if (!treeSha) {
    return jsonNotFound(`Tree '${body.tree}' not found.`);
  }

  const parents = await parseCommitParents(repo.repoPath, body.parents);
  if (!Array.isArray(parents)) {
    return parents;
  }

  const author = optionalIdentity(body.author, 'author', DEFAULT_GIT_IDENTITY);
  if ('status' in author) {
    return author;
  }
  const committer = optionalIdentity(body.committer, 'committer', author);
  if ('status' in committer) {
    return committer;
  }

  if (body.signature !== undefined) {
    return jsonValidationError('Validation Failed: signature is not supported by this shim.');
  }

  const args = ['commit-tree', treeSha];
  for (const parent of parents) {
    args.push('-p', parent);
  }
  args.push('-F', '-');

  const result = await runGit(repo.repoPath, args, commitEnv(author, committer), message);
  const sha = result.stdout.toString('utf-8').trim();
  if (result.status !== 0 || !FULL_SHA_RE.test(sha)) {
    return jsonValidationError(`Failed to create git commit: ${gitError(result)}`);
  }

  const commit = await readCommit(repo.repoPath, sha);
  if (!commit) {
    return jsonValidationError('Failed to read created git commit.');
  }

  return jsonCreated(buildGitCommitResponse(commit, repoApiBase(buildApiUrl(url), targetDid, repoName)));
}

export async function handleCreateGitTag(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const tagName = cleanTagName(body.tag);
  if (typeof tagName !== 'string') {
    return tagName;
  }

  const message = requiredString(body, 'message');
  if (typeof message !== 'string') {
    return message;
  }

  const targetSha = requiredSha(body.object, 'object');
  if (typeof targetSha !== 'string') {
    return targetSha;
  }
  if (body.type !== 'blob' && body.type !== 'tree' && body.type !== 'commit') {
    return jsonValidationError('Validation Failed: type must be blob, tree, or commit.');
  }
  const requestedType: GitTagTargetType = body.type;

  const actualType = await objectType(repo.repoPath, targetSha);
  if (actualType !== requestedType) {
    return jsonNotFound(`Git object '${targetSha}' not found.`);
  }

  const tagger = optionalIdentity(body.tagger, 'tagger', DEFAULT_GIT_IDENTITY);
  if ('status' in tagger) {
    return tagger;
  }

  const rawTag = [
    `object ${targetSha}`,
    `type ${requestedType}`,
    `tag ${tagName}`,
    `tagger ${taggerLine(tagger)}`,
    '',
    message,
    '',
  ].join('\n');
  const result = await runGit(repo.repoPath, ['mktag'], undefined, rawTag);
  const tagSha = result.stdout.toString('utf-8').trim();
  if (result.status !== 0 || !FULL_SHA_RE.test(tagSha)) {
    return jsonValidationError(`Failed to create git tag object: ${gitError(result)}`);
  }

  const tag = await readTag(repo.repoPath, tagSha);
  if (!tag) {
    return jsonValidationError('Failed to read created git tag object.');
  }

  return jsonCreated(buildGitTagResponse(tag, repoApiBase(buildApiUrl(url), targetDid, repoName)));
}

export async function handleGetGitTag(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawTag: string,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const tag = await readTag(repo.repoPath, rawTag);
  if (!tag) {
    return jsonNotFound(`Git tag '${decodeRouteParam(rawTag)}' not found.`);
  }

  return jsonOk(buildGitTagResponse(tag, repoApiBase(buildApiUrl(url), targetDid, repoName)));
}

export async function handleCreateGitRef(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const rawRef = requiredString(body, 'ref');
  if (typeof rawRef !== 'string') {
    return rawRef;
  }
  const ref = normalizeGitReference(rawRef);
  if (!ref) {
    return jsonValidationError('Validation Failed: ref must be a fully qualified git reference.');
  }

  const sha = requiredSha(body.sha, 'sha');
  if (typeof sha !== 'string') {
    return sha;
  }
  const type = await objectType(repo.repoPath, sha);
  if (!type) {
    return jsonNotFound(`Git object '${sha}' not found.`);
  }
  if (ref.startsWith('refs/heads/') && type !== 'commit') {
    return jsonValidationError('Validation Failed: branch references must point to commits.');
  }
  if (!await hasLocalHead(repo.repoPath)) {
    return jsonConflict('Git repository is empty.');
  }
  if (await localRefExists(repo.repoPath, ref)) {
    return jsonConflict(`Reference '${ref}' already exists.`);
  }

  const updateError = await updateLocalRef(repo.repoPath, ref, sha);
  if (updateError) {
    return updateError;
  }
  await syncRefsAfterContentWrite(ctx, targetDid, repoName, repo.repoPath);

  return jsonCreated(buildGitRefObjectResponse(ref, sha, type, repoApiBase(buildApiUrl(url), targetDid, repoName)));
}

export async function handleUpdateGitRef(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawRef: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const ref = normalizeRouteGitReference(rawRef);
  if (!ref) {
    return jsonValidationError('Validation Failed: ref is invalid.');
  }

  const sha = requiredSha(body.sha, 'sha');
  if (typeof sha !== 'string') {
    return sha;
  }
  const type = await objectType(repo.repoPath, sha);
  if (!type) {
    return jsonNotFound(`Git object '${sha}' not found.`);
  }
  if (ref.startsWith('refs/heads/') && type !== 'commit') {
    return jsonValidationError('Validation Failed: branch references must point to commits.');
  }

  const currentSha = await localRefSha(repo.repoPath, ref);
  if (!currentSha) {
    return jsonNotFound(`Reference '${ref}' not found.`);
  }

  const force = body.force === true;
  if (!force && currentSha !== sha) {
    const currentType = await objectType(repo.repoPath, currentSha);
    if (currentType !== 'commit' || type !== 'commit') {
      return jsonConflict('Reference update is not a fast-forward.');
    }
    const ancestor = await runGit(repo.repoPath, ['merge-base', '--is-ancestor', currentSha, sha]);
    if (ancestor.status !== 0) {
      return jsonConflict('Reference update is not a fast-forward.');
    }
  }

  const updateError = await updateLocalRef(repo.repoPath, ref, sha);
  if (updateError) {
    return updateError;
  }
  await syncRefsAfterContentWrite(ctx, targetDid, repoName, repo.repoPath);

  return jsonOk(buildGitRefObjectResponse(ref, sha, type, repoApiBase(buildApiUrl(url), targetDid, repoName)));
}

export async function handleDeleteGitRef(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawRef: string,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const ref = normalizeRouteGitReference(rawRef);
  if (!ref) {
    return jsonValidationError('Validation Failed: ref is invalid.');
  }

  if (!await localRefExists(repo.repoPath, ref)) {
    return jsonNotFound(`Reference '${ref}' not found.`);
  }

  try {
    const repoRecord = await getRepoRecord(ctx, targetDid, repoName);
    if (repoRecord?.defaultBranch && ref === branchRef(repoRecord.defaultBranch)) {
      return jsonValidationError('Validation Failed: cannot delete the default branch.');
    }
  } catch {
    // A local git repository can still delete non-default refs if metadata is unavailable.
  }

  const result = await runGit(repo.repoPath, ['update-ref', '-d', ref]);
  if (result.status !== 0) {
    return jsonValidationError(`Failed to delete reference '${ref}': ${gitError(result)}`);
  }
  await syncRefsAfterContentWrite(ctx, targetDid, repoName, repo.repoPath);

  return jsonNoContent();
}

export async function handleListRepoCommits(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const rawRef = url.searchParams.get('sha') ?? await defaultCommitRef(ctx, targetDid, repoName);
  const commitSha = await resolveObject(repo.repoPath, rawRef, 'commit');
  if (!commitSha) {
    return jsonNotFound(`Commit ref '${decodeRouteParam(rawRef)}' not found.`);
  }

  const normalizedPath = normalizeContentPath(url.searchParams.get('path'));
  if (normalizedPath === null) {
    return jsonNotFound('Commit path not found.');
  }

  const shas = await listCommitShas(repo.repoPath, commitSha, url, normalizedPath || null);
  if (!shas) {
    return jsonNotFound(`Commit ref '${decodeRouteParam(rawRef)}' not found.`);
  }

  const commits = (await Promise.all(shas.map((sha) => readCommit(repo.repoPath, sha))))
    .filter((commit): commit is GitCommitInfo => commit !== null);
  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  return jsonOk(commits.map((commit) => buildRepoCommitResponse(commit, repoBase)));
}

export async function handleListContributors(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const raw = await gitOk(repo.repoPath, ['shortlog', '-sne', '--all']);
  if (raw === null) {
    return jsonNotFound(`Contributors for repository '${repoName}' not found.`);
  }

  const anon = url.searchParams.get('anon')?.toLowerCase();
  const includeAnonymous = anon === '1' || anon === 'true';
  const contributors = parseShortlogContributors(raw)
    .filter((contributor) => includeAnonymous || contributor.email);
  if (contributors.length === 0) {
    return jsonNoContent();
  }

  const pagination = parsePagination(url);
  const paged = paginate(contributors, pagination);
  const baseUrl = buildApiUrl(url);
  const linkHeader = buildLinkHeader(
    baseUrl, `/repos/${targetDid}/${repoName}/contributors`,
    pagination.page, pagination.perPage, contributors.length,
  );
  const extraHeaders: Record<string, string> = {};
  if (linkHeader) { extraHeaders['Link'] = linkHeader; }

  return jsonOk(paged.map((contributor) => buildContributorResponse(contributor, baseUrl)), extraHeaders);
}

export async function handleDownloadArchive(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  kind: ArchiveKind,
  rawRef: string | null,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const ref = rawRef ? decodeRouteParam(rawRef) : await defaultCommitRef(ctx, targetDid, repoName);
  const commitSha = await resolveObject(repo.repoPath, ref, 'commit');
  if (!commitSha) {
    return jsonNotFound(`Archive ref '${ref}' not found.`);
  }

  const download = url.searchParams.get('download');
  if (download !== '1' && download !== 'true') {
    const location = new URL(url.href);
    location.searchParams.set('download', '1');
    return redirectFound(location.toString());
  }

  const gitFormat = kind === 'tarball' ? 'tar.gz' : 'zip';
  const result = await runGit(repo.repoPath, [
    'archive',
    `--format=${gitFormat}`,
    `--prefix=${archivePrefix(repoName, commitSha)}/`,
    commitSha,
  ]);
  if (result.status !== 0 || result.stdout.byteLength === 0) {
    return jsonNotFound(`Archive for ref '${ref}' not found.`);
  }

  return binaryOk(
    result.stdout,
    kind === 'tarball' ? 'application/gzip' : 'application/zip',
    { 'Content-Disposition': `attachment; filename="${archiveFilename(repoName, commitSha, kind)}"` },
  );
}

export async function handleGetRepoCommit(
  ctx: AgentContext, targetDid: string, repoName: string, rawCommit: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const commit = await readCommit(repo.repoPath, rawCommit);
  if (!commit) {
    return jsonNotFound(`Commit '${decodeRouteParam(rawCommit)}' not found.`);
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk(buildRepoCommitResponse(commit, repoApiBase(baseUrl, targetDid, repoName)));
}

export async function handleGetRepoCommitMedia(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawCommit: string,
  kind: CommitMediaKind,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const commitSha = await resolveObject(repo.repoPath, rawCommit, 'commit');
  if (!commitSha) {
    return jsonNotFound(`Commit '${decodeRouteParam(rawCommit)}' not found.`);
  }

  if (kind === 'sha') {
    return binaryOk(Buffer.from(`${commitSha}\n`, 'utf-8'), 'application/vnd.github.sha; charset=utf-8');
  }

  const args = kind === 'diff'
    ? ['show', '--format=', '--patch', '--find-renames', commitSha]
    : ['format-patch', '--stdout', '--find-renames', '-1', commitSha];
  const result = await runGit(repo.repoPath, args);
  if (result.status !== 0) {
    return jsonNotFound(`Commit ${kind} for '${decodeRouteParam(rawCommit)}' not found.`);
  }

  return binaryOk(
    result.stdout,
    kind === 'diff' ? 'application/vnd.github.diff; charset=utf-8' : 'application/vnd.github.patch; charset=utf-8',
  );
}

export async function handleCompareCommits(
  ctx: AgentContext, targetDid: string, repoName: string, rawBase: string, rawHead: string, url: URL, options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseSha = await resolveObject(repo.repoPath, rawBase, 'commit');
  const headSha = await resolveObject(repo.repoPath, rawHead, 'commit');
  if (!baseSha) {
    return jsonNotFound(`Base commit '${decodeRouteParam(rawBase)}' not found.`);
  }
  if (!headSha) {
    return jsonNotFound(`Head commit '${decodeRouteParam(rawHead)}' not found.`);
  }

  const baseCommit = await readCommit(repo.repoPath, baseSha);
  const headCommit = await readCommit(repo.repoPath, headSha);
  if (!baseCommit || !headCommit) {
    return jsonNotFound('Compare commits not found.');
  }

  const aheadBy = await revListCount(repo.repoPath, `${baseSha}..${headSha}`);
  const behindBy = await revListCount(repo.repoPath, `${headSha}..${baseSha}`);
  const comparedShas = await compareCommitShas(repo.repoPath, baseSha, headSha);
  if (!comparedShas) {
    return jsonNotFound('Compare commits not found.');
  }

  const commits = (await Promise.all(comparedShas.map((sha) => readCommit(repo.repoPath, sha))))
    .filter((commit): commit is GitCommitInfo => commit !== null);
  const mergeBaseSha = await mergeBase(repo.repoPath, baseSha, headSha);
  const mergeBaseCommit = mergeBaseSha ? await readCommit(repo.repoPath, mergeBaseSha) : null;
  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  const encodedBase = encodeURIComponent(decodeRouteParam(rawBase));
  const encodedHead = encodeURIComponent(decodeRouteParam(rawHead));

  return jsonOk({
    url               : `${repoBase}/compare/${encodedBase}...${encodedHead}`,
    html_url          : `${repoBase}/compare/${encodedBase}...${encodedHead}`,
    permalink_url     : `${repoBase}/compare/${baseSha}...${headSha}`,
    diff_url          : `${repoBase}/compare/${baseSha}...${headSha}.diff`,
    patch_url         : `${repoBase}/compare/${baseSha}...${headSha}.patch`,
    base_commit       : buildRepoCommitResponse(baseCommit, repoBase),
    merge_base_commit : buildRepoCommitResponse(mergeBaseCommit ?? baseCommit, repoBase),
    status            : compareStatus(aheadBy, behindBy),
    ahead_by          : aheadBy,
    behind_by         : behindBy,
    total_commits     : aheadBy,
    commits           : commits.map((commit) => buildRepoCommitResponse(commit, repoBase)),
    files             : await compareFiles(repo.repoPath, baseSha, headSha, repoBase),
    head_commit       : buildRepoCommitResponse(headCommit, repoBase),
  });
}

export async function handleCompareCommitText(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawBase: string,
  rawHead: string,
  kind: CompareTextKind,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const baseSha = await resolveObject(repo.repoPath, rawBase, 'commit');
  const headSha = await resolveObject(repo.repoPath, rawHead, 'commit');
  if (!baseSha) {
    return jsonNotFound(`Base commit '${decodeRouteParam(rawBase)}' not found.`);
  }
  if (!headSha) {
    return jsonNotFound(`Head commit '${decodeRouteParam(rawHead)}' not found.`);
  }

  const args = kind === 'diff'
    ? ['diff', '--patch', '--find-renames', baseSha, headSha]
    : ['format-patch', '--stdout', '--find-renames', `${baseSha}..${headSha}`];
  const result = await runGit(repo.repoPath, args);
  if (result.status !== 0) {
    return jsonNotFound(`Compare ${kind} for '${decodeRouteParam(rawBase)}...${decodeRouteParam(rawHead)}' not found.`);
  }

  return binaryOk(
    result.stdout,
    kind === 'diff' ? 'application/vnd.github.diff; charset=utf-8' : 'application/vnd.github.patch; charset=utf-8',
  );
}

export async function handlePutGitContents(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawPath: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const normalizedPath = normalizeContentPath(rawPath);
  if (!normalizedPath) {
    return jsonNotFound('Content path not found.');
  }

  const message = requiredString(body, 'message');
  if (typeof message !== 'string') {
    return message;
  }

  const content = decodeBase64Content(body);
  if (!Buffer.isBuffer(content)) {
    return content;
  }

  const requestSha = optionalBlobSha(body);
  if (requestSha && typeof requestSha !== 'string') {
    return requestSha;
  }

  const author = optionalIdentity(body.author, 'author', DEFAULT_GIT_IDENTITY);
  if ('status' in author) {
    return author;
  }
  const committer = optionalIdentity(body.committer, 'committer', DEFAULT_GIT_IDENTITY);
  if ('status' in committer) {
    return committer;
  }

  const branch = await requestedWriteBranch(ctx, targetDid, repoName, repo.repoPath, body);
  if (typeof branch !== 'string') {
    return branch;
  }

  const currentCommitSha = await resolveObject(repo.repoPath, branchRef(branch), 'commit');
  if (!currentCommitSha) {
    return jsonNotFound(`Branch '${branch}' not found.`);
  }

  const currentEntry = await treeEntryAtPath(repo.repoPath, currentCommitSha, normalizedPath);
  if (currentEntry && currentEntry.type !== 'blob') {
    return jsonConflict(`Content '${normalizedPath}' is not a file.`);
  }

  const currentSha = currentEntry?.sha ?? null;
  if (currentSha && !requestSha) {
    return jsonConflict(`Content '${normalizedPath}' already exists. The sha field is required for updates.`);
  }
  if (!currentSha && requestSha) {
    return jsonConflict(`Content '${normalizedPath}' does not exist.`);
  }
  if (currentSha && requestSha !== currentSha) {
    return jsonConflict(`sha does not match Content '${normalizedPath}'.`);
  }

  const commitSha = await commitViaWorktree(
    repo.repoPath,
    branch,
    message,
    author,
    committer,
    async (workDir) => {
      const filePath = join(workDir, ...normalizedPath.split('/'));
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      const add = await runGit(workDir, ['add', '--', normalizedPath]);
      if (add.status !== 0) {
        return jsonValidationError(`Failed to stage content '${normalizedPath}': ${gitError(add)}`);
      }
      return undefined;
    },
  );
  if (typeof commitSha !== 'string') {
    return commitSha;
  }

  await syncRefsAfterContentWrite(ctx, targetDid, repoName, repo.repoPath);

  const commit = await readCommit(repo.repoPath, commitSha);
  const entry = await treeEntryAtPath(repo.repoPath, commitSha, normalizedPath);
  if (!commit || !entry || entry.type !== 'blob') {
    return jsonValidationError('Failed to read committed contents change.');
  }

  const blob = await readBlob(repo.repoPath, entry.sha);
  if (!blob) {
    return jsonValidationError('Failed to read committed content blob.');
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  const response = {
    content : buildFileContent(repoBase, branch, entry, blob),
    commit  : buildRepoCommitResponse(commit, repoBase),
  };
  return currentSha ? jsonOk(response) : jsonCreated(response);
}

export async function handleDeleteGitContents(
  ctx: AgentContext,
  targetDid: string,
  repoName: string,
  rawPath: string,
  body: Record<string, unknown>,
  url: URL,
  options: GitObjectOptions,
): Promise<JsonResponse> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return jsonNotFound(`Local git repository '${repoName}' not found for DID '${targetDid}'.`);
  }

  const normalizedPath = normalizeContentPath(rawPath);
  if (!normalizedPath) {
    return jsonNotFound('Content path not found.');
  }

  const message = requiredString(body, 'message');
  if (typeof message !== 'string') {
    return message;
  }

  const requestSha = optionalBlobSha(body);
  if (!requestSha) {
    return jsonValidationError('Validation Failed: sha is required.');
  }
  if (typeof requestSha !== 'string') {
    return requestSha;
  }

  const author = optionalIdentity(body.author, 'author', DEFAULT_GIT_IDENTITY);
  if ('status' in author) {
    return author;
  }
  const committer = optionalIdentity(body.committer, 'committer', DEFAULT_GIT_IDENTITY);
  if ('status' in committer) {
    return committer;
  }

  const branch = await requestedWriteBranch(ctx, targetDid, repoName, repo.repoPath, body);
  if (typeof branch !== 'string') {
    return branch;
  }

  const currentCommitSha = await resolveObject(repo.repoPath, branchRef(branch), 'commit');
  if (!currentCommitSha) {
    return jsonNotFound(`Branch '${branch}' not found.`);
  }

  const currentEntry = await treeEntryAtPath(repo.repoPath, currentCommitSha, normalizedPath);
  if (!currentEntry) {
    return jsonNotFound(`Content '${normalizedPath}' not found.`);
  }
  if (currentEntry.type !== 'blob') {
    return jsonConflict(`Content '${normalizedPath}' is not a file.`);
  }
  if (currentEntry.sha !== requestSha) {
    return jsonConflict(`sha does not match Content '${normalizedPath}'.`);
  }

  const commitSha = await commitViaWorktree(
    repo.repoPath,
    branch,
    message,
    author,
    committer,
    async (workDir) => {
      const remove = await runGit(workDir, ['rm', '--quiet', '--', normalizedPath]);
      if (remove.status !== 0) {
        return jsonValidationError(`Failed to stage content removal '${normalizedPath}': ${gitError(remove)}`);
      }
      return undefined;
    },
  );
  if (typeof commitSha !== 'string') {
    return commitSha;
  }

  await syncRefsAfterContentWrite(ctx, targetDid, repoName, repo.repoPath);

  const commit = await readCommit(repo.repoPath, commitSha);
  if (!commit) {
    return jsonValidationError('Failed to read committed contents deletion.');
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);
  return jsonOk({
    content : null,
    commit  : buildRepoCommitResponse(commit, repoBase),
  });
}

export async function tryGetGitContents(
  ctx: AgentContext, targetDid: string, repoName: string, path: string | null, url: URL, options: GitObjectOptions,
  mediaKind?: ContentMediaKind | null,
): Promise<ContentLookup> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return { kind: 'missing-local-repo' };
  }

  const normalizedPath = normalizeContentPath(path);
  if (normalizedPath === null) {
    return { kind: 'response', response: jsonNotFound('Content path not found.') };
  }

  const { ref, explicit } = await requestedContentRef(ctx, targetDid, repoName, url);
  const commitSha = await resolveObject(repo.repoPath, ref, 'commit');
  if (!commitSha) {
    if (!explicit) {
      return { kind: 'missing-local-repo' };
    }
    return { kind: 'response', response: jsonNotFound(`Git ref '${ref}' not found.`) };
  }

  const baseUrl = buildApiUrl(url);
  const repoBase = repoApiBase(baseUrl, targetDid, repoName);

  if (!normalizedPath) {
    const rootEntries = await listDirectory(repo.repoPath, commitSha, '');
    if (!rootEntries) {
      return { kind: 'response', response: jsonNotFound('Repository contents not found.') };
    }
    const entries = rootEntries.map((entry) => buildContentEntry(repoBase, ref, entry));
    return {
      kind     : 'response',
      response : jsonOk(mediaKind === 'object' ? { entries } : entries),
    };
  }

  const entry = await treeEntryAtPath(repo.repoPath, commitSha, normalizedPath);
  if (!entry) {
    return { kind: 'response', response: jsonNotFound(`Content '${normalizedPath}' not found.`) };
  }

  if (entry.type === 'tree') {
    const entries = await listDirectory(repo.repoPath, commitSha, normalizedPath);
    if (!entries) {
      return { kind: 'response', response: jsonNotFound(`Content '${normalizedPath}' not found.`) };
    }
    const childEntries = entries.map((child) => buildContentEntry(repoBase, ref, child));
    return {
      kind     : 'response',
      response : jsonOk(mediaKind === 'object' ? { entries: childEntries } : childEntries),
    };
  }

  if (entry.type === 'commit') {
    return {
      kind     : 'response',
      response : jsonOk(buildContentEntry(repoBase, ref, entry)),
    };
  }

  const blob = await readBlob(repo.repoPath, entry.sha);
  if (!blob) {
    return { kind: 'response', response: jsonNotFound(`Content '${normalizedPath}' not found.`) };
  }

  if (mediaKind === 'raw') {
    return { kind: 'response', response: binaryOk(blob, rawBlobContentType(normalizedPath)) };
  }

  if (mediaKind === 'html') {
    return {
      kind     : 'response',
      response : binaryOk(Buffer.from(renderBlobHtml(normalizedPath, blob), 'utf-8'), 'text/html; charset=utf-8'),
    };
  }

  return {
    kind     : 'response',
    response : jsonOk(buildFileContent(repoBase, ref, entry, blob)),
  };
}

export async function tryGetGitReadme(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: GitObjectOptions,
  mediaKind?: ContentMediaKind | null,
): Promise<ContentLookup> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return { kind: 'missing-local-repo' };
  }

  const { ref } = await requestedContentRef(ctx, targetDid, repoName, url);
  const commitSha = await resolveObject(repo.repoPath, ref, 'commit');
  if (!commitSha) {
    return { kind: 'missing-local-repo' };
  }

  for (const candidate of README_CANDIDATES) {
    const entry = await treeEntryAtPath(repo.repoPath, commitSha, candidate);
    if (entry?.type === 'blob') {
      const blob = await readBlob(repo.repoPath, entry.sha);
      if (!blob) {
        continue;
      }
      const baseUrl = buildApiUrl(url);
      const repoBase = repoApiBase(baseUrl, targetDid, repoName);
      if (mediaKind === 'raw') {
        return { kind: 'response', response: binaryOk(blob, rawBlobContentType(entry.path)) };
      }
      if (mediaKind === 'html') {
        return {
          kind     : 'response',
          response : binaryOk(Buffer.from(renderBlobHtml(entry.path, blob), 'utf-8'), 'text/html; charset=utf-8'),
        };
      }
      return {
        kind     : 'response',
        response : jsonOk(buildFileContent(repoBase, ref, entry, blob)),
      };
    }
  }

  return { kind: 'response', response: jsonNotFound('README not found.') };
}

export async function tryGetGitReadmeInDirectory(
  ctx: AgentContext, targetDid: string, repoName: string, dir: string, url: URL, options: GitObjectOptions,
  mediaKind?: ContentMediaKind | null,
): Promise<ContentLookup> {
  const repo = localRepo(ctx, targetDid, repoName, options);
  if (!repo) {
    return { kind: 'missing-local-repo' };
  }

  const normalizedDir = normalizeContentPath(dir);
  if (!normalizedDir) {
    return { kind: 'response', response: jsonNotFound('README not found.') };
  }

  const { ref } = await requestedContentRef(ctx, targetDid, repoName, url);
  const commitSha = await resolveObject(repo.repoPath, ref, 'commit');
  if (!commitSha) {
    return { kind: 'missing-local-repo' };
  }

  for (const candidate of README_CANDIDATES) {
    const entry = await treeEntryAtPath(repo.repoPath, commitSha, `${normalizedDir}/${candidate}`);
    if (entry?.type === 'blob') {
      const blob = await readBlob(repo.repoPath, entry.sha);
      if (!blob) {
        continue;
      }
      const baseUrl = buildApiUrl(url);
      const repoBase = repoApiBase(baseUrl, targetDid, repoName);
      if (mediaKind === 'raw') {
        return { kind: 'response', response: binaryOk(blob, rawBlobContentType(entry.path)) };
      }
      if (mediaKind === 'html') {
        return {
          kind     : 'response',
          response : binaryOk(Buffer.from(renderBlobHtml(entry.path, blob), 'utf-8'), 'text/html; charset=utf-8'),
        };
      }
      return {
        kind     : 'response',
        response : jsonOk(buildFileContent(repoBase, ref, entry, blob)),
      };
    }
  }

  return { kind: 'response', response: jsonNotFound('README not found.') };
}

export async function tryGetGitLicense(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: GitObjectOptions,
  mediaKind?: ContentMediaKind | null,
): Promise<ContentLookup> {
  const contents = await tryGetGitContents(ctx, targetDid, repoName, 'LICENSE', url, options, mediaKind);
  if (contents.kind !== 'response' || contents.response.status !== 200) {
    return contents;
  }
  if (mediaKind === 'raw' || mediaKind === 'html') {
    return contents;
  }

  return {
    kind     : 'response',
    response : {
      ...contents.response,
      body: JSON.stringify({
        ...JSON.parse(contents.response.body as string) as Record<string, unknown>,
        license: null,
      }),
    },
  };
}
