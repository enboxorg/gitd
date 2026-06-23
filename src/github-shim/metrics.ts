/**
 * GitHub API shim - repository metrics endpoints.
 *
 * Provides GitHub-compatible community profile, repository statistics, and
 * traffic responses. Statistics are derived from local bare git history when
 * repo storage is available; traffic currently returns valid empty aggregates.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse, RepoInfo } from './helpers.js';

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

import { GitBackend } from '../git-server/git-backend.js';
import { resolveReposPath } from '../cli/flags.js';
import {
  buildApiUrl,
  fromOpt,
  getRepoRecord,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricsOptions = {
  reposPath? : string;
};

type GitResult = {
  status : number;
  stdout : Buffer;
  stderr : Buffer;
};

type LocalRepoLookup = {
  repoPath : string;
} | null;

type CommitMetric = {
  sha : string;
  name : string;
  email : string;
  timestamp : number;
  additions : number;
  deletions : number;
};

type WeekBucket = {
  additions : number;
  deletions : number;
  commits : number;
  days : number[];
};

type CommunityFiles = {
  code_of_conduct : Record<string, unknown> | null;
  code_of_conduct_file : Record<string, unknown> | null;
  contributing : Record<string, unknown> | null;
  issue_template : Record<string, unknown> | null;
  pull_request_template : Record<string, unknown> | null;
  license : Record<string, unknown> | null;
  readme : Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// Local git helpers
// ---------------------------------------------------------------------------

function localRepo(ctx: AgentContext, targetDid: string, repoName: string, options: MetricsOptions): LocalRepoLookup {
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

async function runGit(repoPath: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      env   : process.env,
      stdio : ['ignore', 'pipe', 'pipe'],
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
  });
}

async function gitText(repoPath: string, args: string[]): Promise<string | null> {
  const result = await runGit(repoPath, args);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.toString('utf-8').trim();
}

function branchRef(repo: RepoInfo): string {
  return `refs/heads/${repo.defaultBranch || 'main'}`;
}

async function treePaths(repoPath: string, repo: RepoInfo): Promise<Set<string>> {
  const out = await gitText(repoPath, ['ls-tree', '-r', '--name-only', branchRef(repo)]);
  if (!out) {
    return new Set();
  }
  return new Set(out.split('\n').map(path => path.trim()).filter(Boolean));
}

async function readCommitMetrics(repoPath: string, repo: RepoInfo): Promise<CommitMetric[]> {
  const out = await gitText(repoPath, [
    'log',
    '--no-merges',
    '--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%at',
    '--numstat',
    branchRef(repo),
  ]);
  if (!out) {
    return [];
  }

  const commits: CommitMetric[] = [];
  for (const chunk of out.split('\x1e')) {
    const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
    const header = lines.shift();
    if (!header) {
      continue;
    }

    const [sha, name, email, timestampRaw] = header.split('\x1f');
    const timestamp = parseInt(timestampRaw ?? '', 10);
    if (!sha || !name || !Number.isFinite(timestamp)) {
      continue;
    }

    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      const [addedRaw, deletedRaw] = line.split('\t');
      additions += statNumber(addedRaw);
      deletions += statNumber(deletedRaw);
    }

    commits.push({
      sha,
      name,
      email: email ?? '',
      timestamp,
      additions,
      deletions,
    });
  }

  return commits;
}

function statNumber(value: string | undefined): number {
  if (!value || value === '-') {
    return 0;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Time buckets
// ---------------------------------------------------------------------------

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

function startOfStatsWeek(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  const dayStart = startOfUtcDay(date);
  return dayStart - (date.getUTCDay() * 86_400);
}

function last52WeekStarts(): number[] {
  const currentWeek = startOfStatsWeek(Math.floor(Date.now() / 1000));
  const starts: number[] = [];
  for (let i = 51; i >= 0; i--) {
    starts.push(currentWeek - (i * 7 * 86_400));
  }
  return starts;
}

function buildWeekBuckets(commits: CommitMetric[]): Map<number, WeekBucket> {
  const buckets = new Map<number, WeekBucket>();
  for (const commit of commits) {
    const week = startOfStatsWeek(commit.timestamp);
    const day = new Date(commit.timestamp * 1000).getUTCDay();
    const bucket = buckets.get(week) ?? {
      additions : 0,
      deletions : 0,
      commits   : 0,
      days      : [0, 0, 0, 0, 0, 0, 0],
    };
    bucket.additions += commit.additions;
    bucket.deletions += commit.deletions;
    bucket.commits += 1;
    bucket.days[day] += 1;
    buckets.set(week, bucket);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

async function getRepoOr404(ctx: AgentContext, targetDid: string, repoName: string): Promise<RepoInfo | JsonResponse> {
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) {
    return jsonNotFound(`Repository '${repoName}' not found for DID '${targetDid}'.`);
  }
  return repo;
}

async function commitMetricsForRepo(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, options: MetricsOptions,
): Promise<CommitMetric[]> {
  const local = localRepo(ctx, targetDid, repo.name, options);
  if (!local) {
    return [];
  }
  return readCommitMetrics(local.repoPath, repo);
}

function isResponse(value: RepoInfo | JsonResponse): value is JsonResponse {
  return typeof (value as JsonResponse).status === 'number';
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'user';
}

function authorLogin(commit: CommitMetric): string {
  const basis = commit.name || commit.email.split('@')[0] || commit.sha;
  return `${slug(basis)}-${numericId(commit.email || commit.name || commit.sha).toString(16)}`;
}

function buildAuthor(commit: CommitMetric, baseUrl: string): Record<string, unknown> {
  const login = authorLogin(commit);
  const encoded = encodeURIComponent(login);
  return {
    login,
    id                  : numericId(`author:${commit.email || commit.name}`),
    node_id             : Buffer.from(`author:${commit.email || commit.name}`, 'utf-8').toString('base64'),
    avatar_url          : '',
    gravatar_id         : '',
    url                 : `${baseUrl}/users/${encoded}`,
    html_url            : `${baseUrl}/users/${encoded}`,
    followers_url       : `${baseUrl}/users/${encoded}/followers`,
    following_url       : `${baseUrl}/users/${encoded}/following{/other_user}`,
    gists_url           : `${baseUrl}/users/${encoded}/gists{/gist_id}`,
    starred_url         : `${baseUrl}/users/${encoded}/starred{/owner}{/repo}`,
    subscriptions_url   : `${baseUrl}/users/${encoded}/subscriptions`,
    organizations_url   : `${baseUrl}/users/${encoded}/orgs`,
    repos_url           : `${baseUrl}/users/${encoded}/repos`,
    events_url          : `${baseUrl}/users/${encoded}/events{/privacy}`,
    received_events_url : `${baseUrl}/users/${encoded}/received_events`,
    type                : 'User',
    site_admin          : false,
  };
}

// ---------------------------------------------------------------------------
// Community profile
// ---------------------------------------------------------------------------

async function hasTextRecord(
  ctx: AgentContext, targetDid: string, repo: RepoInfo, protocolPath: 'repo/readme' | 'repo/license',
): Promise<boolean> {
  const { records } = await ctx.repo.records.query(protocolPath as any, {
    from   : fromOpt(ctx, targetDid),
    filter : { contextId: repo.contextId },
  });
  return records.length > 0;
}

function matchPath(paths: Set<string>, candidates: string[]): string | null {
  const byLower = new Map<string, string>();
  for (const path of paths) {
    byLower.set(path.toLowerCase(), path);
  }
  for (const candidate of candidates) {
    const found = byLower.get(candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return null;
}

function contentFile(targetDid: string, repoName: string, baseUrl: string, path: string): Record<string, unknown> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const fullName = `${targetDid}/${repoName}`;
  return {
    url      : `${baseUrl}/repos/${fullName}/contents/${encodedPath}`,
    html_url : `${baseUrl}/repos/${fullName}/blob/HEAD/${encodedPath}`,
  };
}

function licenseFile(targetDid: string, repoName: string, baseUrl: string, path: string): Record<string, unknown> {
  return {
    name     : 'License',
    key      : 'other',
    spdx_id  : 'NOASSERTION',
    url      : `${baseUrl}/licenses/other`,
    html_url : contentFile(targetDid, repoName, baseUrl, path).html_url,
    node_id  : Buffer.from(`license:${targetDid}/${repoName}`, 'utf-8').toString('base64'),
  };
}

function codeOfConduct(path: string, targetDid: string, repoName: string, baseUrl: string): Record<string, unknown> {
  return {
    name     : 'Code of Conduct',
    key      : 'other',
    url      : `${baseUrl}/codes_of_conduct/other`,
    html_url : contentFile(targetDid, repoName, baseUrl, path).html_url,
  };
}

function healthPercentage(repo: RepoInfo, files: CommunityFiles): number {
  const checks = [
    Boolean(repo.description),
    Boolean(files.readme),
    Boolean(files.license),
    Boolean(files.code_of_conduct_file),
    Boolean(files.contributing),
    Boolean(files.issue_template),
    Boolean(files.pull_request_template),
  ];
  const present = checks.filter(Boolean).length;
  return Math.round((present / checks.length) * 100);
}

export async function handleGetCommunityProfile(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const local = localRepo(ctx, targetDid, repo.name, options);
  const paths = local ? await treePaths(local.repoPath, repo) : new Set<string>();
  const baseUrl = buildApiUrl(url);
  const readmePath = matchPath(paths, ['README.md', 'README', 'README.txt', 'README.markdown'])
    ?? (await hasTextRecord(ctx, targetDid, repo, 'repo/readme') ? 'README.md' : null);
  const licensePath = matchPath(paths, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'])
    ?? (await hasTextRecord(ctx, targetDid, repo, 'repo/license') ? 'LICENSE' : null);
  const codePath = matchPath(paths, ['CODE_OF_CONDUCT.md', 'CODE_OF_CONDUCT', '.github/CODE_OF_CONDUCT.md']);
  const contributingPath = matchPath(paths, ['CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md']);
  const issueTemplatePath = matchPath(paths, ['ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE.md']);
  const prTemplatePath = matchPath(paths, ['PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE', '.github/PULL_REQUEST_TEMPLATE.md']);

  const files: CommunityFiles = {
    code_of_conduct       : codePath ? codeOfConduct(codePath, targetDid, repo.name, baseUrl) : null,
    code_of_conduct_file  : codePath ? contentFile(targetDid, repo.name, baseUrl, codePath) : null,
    contributing          : contributingPath ? contentFile(targetDid, repo.name, baseUrl, contributingPath) : null,
    issue_template        : issueTemplatePath ? contentFile(targetDid, repo.name, baseUrl, issueTemplatePath) : null,
    pull_request_template : prTemplatePath ? contentFile(targetDid, repo.name, baseUrl, prTemplatePath) : null,
    license               : licensePath ? licenseFile(targetDid, repo.name, baseUrl, licensePath) : null,
    readme                : readmePath ? contentFile(targetDid, repo.name, baseUrl, readmePath) : null,
  };

  return jsonOk({
    health_percentage : healthPercentage(repo, files),
    description       : repo.description || null,
    documentation     : null,
    files,
    updated_at        : repo.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Repository traffic
// ---------------------------------------------------------------------------

function validateTrafficPeriod(url: URL): JsonResponse | 'day' | 'week' {
  const per = url.searchParams.get('per') ?? 'day';
  if (per !== 'day' && per !== 'week') {
    return jsonValidationError('Validation Failed: per must be day or week.');
  }
  return per;
}

export async function handleGetTrafficClones(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }
  const period = validateTrafficPeriod(url);
  if (typeof period !== 'string') {
    return period;
  }
  return jsonOk({ count: 0, uniques: 0, clones: [] });
}

export async function handleGetTrafficViews(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }
  const period = validateTrafficPeriod(url);
  if (typeof period !== 'string') {
    return period;
  }
  return jsonOk({ count: 0, uniques: 0, views: [] });
}

export async function handleGetTrafficPopularPaths(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }
  return jsonOk([]);
}

export async function handleGetTrafficPopularReferrers(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }
  return jsonOk([]);
}

// ---------------------------------------------------------------------------
// Repository statistics
// ---------------------------------------------------------------------------

export async function handleGetStatsCodeFrequency(
  ctx: AgentContext, targetDid: string, repoName: string, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const commits = await commitMetricsForRepo(ctx, targetDid, repo, options);
  const weeks = [...buildWeekBuckets(commits).entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => [week, bucket.additions, -bucket.deletions]);
  return jsonOk(weeks);
}

export async function handleGetStatsCommitActivity(
  ctx: AgentContext, targetDid: string, repoName: string, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const commits = await commitMetricsForRepo(ctx, targetDid, repo, options);
  const weeks = [...buildWeekBuckets(commits).entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => ({
      days  : bucket.days,
      total : bucket.commits,
      week,
    }));
  return jsonOk(weeks);
}

export async function handleGetStatsContributors(
  ctx: AgentContext, targetDid: string, repoName: string, url: URL, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const commits = await commitMetricsForRepo(ctx, targetDid, repo, options);
  const byAuthor = new Map<string, { author: CommitMetric; total: number; weeks: Map<number, WeekBucket> }>();
  for (const commit of commits) {
    const key = commit.email || commit.name;
    const entry = byAuthor.get(key) ?? { author: commit, total: 0, weeks: new Map<number, WeekBucket>() };
    entry.total += 1;
    const week = startOfStatsWeek(commit.timestamp);
    const bucket = entry.weeks.get(week) ?? {
      additions : 0,
      deletions : 0,
      commits   : 0,
      days      : [0, 0, 0, 0, 0, 0, 0],
    };
    bucket.additions += commit.additions;
    bucket.deletions += commit.deletions;
    bucket.commits += 1;
    entry.weeks.set(week, bucket);
    byAuthor.set(key, entry);
  }

  const baseUrl = buildApiUrl(url);
  const contributors = [...byAuthor.values()]
    .sort((a, b) => b.total - a.total || a.author.name.localeCompare(b.author.name))
    .map(entry => ({
      author : buildAuthor(entry.author, baseUrl),
      total  : entry.total,
      weeks  : [...entry.weeks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([week, bucket]) => ({
          w : week,
          a : bucket.additions,
          d : bucket.deletions,
          c : bucket.commits,
        })),
    }));
  return jsonOk(contributors);
}

export async function handleGetStatsParticipation(
  ctx: AgentContext, targetDid: string, repoName: string, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const commits = await commitMetricsForRepo(ctx, targetDid, repo, options);
  const weeks = last52WeekStarts();
  const indexByWeek = new Map(weeks.map((week, index) => [week, index]));
  const all = Array(52).fill(0);
  const owner = Array(52).fill(0);
  for (const commit of commits) {
    const index = indexByWeek.get(startOfStatsWeek(commit.timestamp));
    if (index === undefined) {
      continue;
    }
    all[index] += 1;
    if (commit.email === targetDid || commit.name === targetDid) {
      owner[index] += 1;
    }
  }
  return jsonOk({ all, owner });
}

export async function handleGetStatsPunchCard(
  ctx: AgentContext, targetDid: string, repoName: string, options: MetricsOptions,
): Promise<JsonResponse> {
  const repo = await getRepoOr404(ctx, targetDid, repoName);
  if (isResponse(repo)) {
    return repo;
  }

  const commits = await commitMetricsForRepo(ctx, targetDid, repo, options);
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const date = new Date(commit.timestamp * 1000);
    const key = `${date.getUTCDay()}:${date.getUTCHours()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const data: number[][] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      data.push([day, hour, counts.get(`${day}:${hour}`) ?? 0]);
    }
  }
  return jsonOk(data);
}
