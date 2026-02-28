/**
 * `gitd migrate` — import repository data from GitHub.
 *
 * Fetches repo metadata, git content, issues, pull requests, and releases
 * from the GitHub REST API and creates corresponding DWN records.
 *
 * Git content (bare clone, bundle, refs) is included by default.
 * Pass `--no-git` to import only metadata (issues, PRs, releases).
 * The repos directory defaults to `./repos` (same as `gitd serve`);
 * override with `--repos <path>` or the `GITD_REPOS` env var.
 *
 * Authentication is resolved automatically:
 *   1. `GITHUB_TOKEN` env var (if set)
 *   2. `gh auth token` (GitHub CLI, if installed and authenticated)
 *
 * The `<owner/repo>` argument is optional — if omitted, it is detected
 * from the `origin` (or `github`) remote of the current git repository.
 *
 * Usage:
 *   gitd migrate all [owner/repo]            Import everything (default: with git content)
 *   gitd migrate repo [owner/repo]           Import repo metadata + git content
 *   gitd migrate issues [owner/repo]         Import issues + comments
 *   gitd migrate pulls [owner/repo]          Import PRs + reviews
 *   gitd migrate releases [owner/repo]       Import releases
 *
 * Flags:
 *   --repos <path>   Base path for bare repos (default: ./repos)
 *   --no-git         Skip git content (clone/bundle/refs)
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { createFullBundle } from '../../git-server/bundle-sync.js';
import { getRepoContext } from '../repo-context.js';
import { getRepoContextId } from '../repo-context.js';
import { GitBackend } from '../../git-server/git-backend.js';
import { readGitRefs } from '../../git-server/ref-sync.js';
import { hasFlag, resolveReposPath } from '../flags.js';
import { readFile, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// GitHub auth — resolve a token from env or the gh CLI
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

/** Cached token so we only resolve once per process. */
let cachedToken: string | undefined;

/** Reset the cached token (for testing). */
export function resetTokenCache(): void {
  cachedToken = undefined;
}

/**
 * Resolve a GitHub API token.
 *
 * Priority:
 *   1. `GITHUB_TOKEN` environment variable
 *   2. `gh auth token` (GitHub CLI)
 *
 * Returns `undefined` when no token is available.
 */
export function resolveGitHubToken(): string | undefined {
  if (cachedToken !== undefined) { return cachedToken; }

  // 1. Env var takes precedence.
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  // 2. Try the GitHub CLI.
  try {
    const result = spawnSync('gh', ['auth', 'token'], {
      stdio   : ['pipe', 'pipe', 'pipe'],
      timeout : 2_000,
    });
    const token = result.stdout?.toString().trim();
    if (result.status === 0 && token) {
      cachedToken = token;
      return cachedToken;
    }
  } catch {
    // gh not installed or not on PATH — fall through.
  }

  cachedToken = ''; // empty string = resolved, nothing found
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/** Headers for GitHub API requests. */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept'     : 'application/vnd.github+json',
    'User-Agent' : 'gitd-migrate/0.1',
  };
  const token = resolveGitHubToken();
  if (token) { headers['Authorization'] = `Bearer ${token}`; }
  return headers;
}

/**
 * Build a user-friendly error message for GitHub API failures.
 * For 404s without a token, hint at authentication.
 */
function ghErrorMessage(status: number, body: string): string {
  const base = `GitHub API ${status}: ${body.slice(0, 200)}`;

  if (status === 404 && !resolveGitHubToken()) {
    return (
      `${base}\n\n` +
      `  Hint: this may be a private repo.  Authenticate with one of:\n` +
      `    - gh auth login          (GitHub CLI — recommended)\n` +
      `    - export GITHUB_TOKEN=ghp_...\n`
    );
  }

  if (status === 401 || status === 403) {
    return (
      `${base}\n\n` +
      `  Hint: your token may lack the required scopes.  Ensure it has "repo" access.\n`
    );
  }

  return base;
}

/** Fetch a single page from the GitHub API.  Throws on non-2xx. */
async function ghFetch<T>(path: string): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(ghErrorMessage(res.status, body));
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch all pages of a paginated GitHub API endpoint.
 * GitHub uses Link headers for pagination.
 */
async function ghFetchAll<T>(path: string, perPage = 100): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = `${GITHUB_API}${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}`;

  while (url) {
    const res: Response = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(ghErrorMessage(res.status, body));
    }

    const items = await res.json() as T[];
    all.push(...items);

    // Parse Link header for next page.
    const link: string | null = res.headers.get('link');
    const next: string | undefined = link?.split(',').find((s: string) => s.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)?.[1] ?? null : null;
  }

  return all;
}

// ---------------------------------------------------------------------------
// GitHub API types (minimal — only fields we use)
// ---------------------------------------------------------------------------

type GhRepo = {
  name : string;
  description : string | null;
  default_branch : string;
  private : boolean;
  html_url : string;
  topics : string[];
};

type GhIssue = {
  number : number;
  title : string;
  body : string | null;
  state : string;
  user : { login: string } | null;
  created_at : string;
  pull_request?: unknown;
};

type GhComment = {
  body : string | null;
  user : { login: string } | null;
  created_at : string;
};

type GhPull = {
  number : number;
  title : string;
  body : string | null;
  state : string;
  merged : boolean;
  user : { login: string } | null;
  base : { ref: string };
  head : { ref: string };
  created_at : string;
};

type GhReview = {
  body : string | null;
  state : string;
  user : { login: string } | null;
  submitted_at : string;
};

type GhRelease = {
  tag_name : string;
  name : string | null;
  body : string | null;
  prerelease : boolean;
  draft : boolean;
  target_commitish : string;
  created_at : string;
};

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function migrateCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'all': return migrateAll(ctx, rest);
    case 'repo': return migrateRepo(ctx, rest);
    case 'issues': return migrateIssues(ctx, rest);
    case 'pulls': return migratePulls(ctx, rest);
    case 'releases': return migrateReleases(ctx, rest);
    default:
      console.error('Usage: gitd migrate <all|repo|issues|pulls|releases> [owner/repo] [--repos <path>] [--no-git]');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Resolve <owner/repo> — from argument or local git remote
// ---------------------------------------------------------------------------

/** Well-known GitHub remote URL patterns. */
const GH_SSH_RE = /^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/;
const GH_HTTPS_RE = /^https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/;

/**
 * Extract `owner/repo` from a GitHub remote URL.
 * Supports both SSH (`git@github.com:owner/repo.git`) and
 * HTTPS (`https://github.com/owner/repo.git`) forms.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const ssh = GH_SSH_RE.exec(url);
  if (ssh) { return { owner: ssh[1], repo: ssh[2] }; }

  const https = GH_HTTPS_RE.exec(url);
  if (https) { return { owner: https[1], repo: https[2] }; }

  return null;
}

/**
 * Detect the GitHub `owner/repo` from the current directory's git remotes.
 * Checks `origin` first, then `github`.
 */
function detectGhRepoFromRemotes(): { owner: string; repo: string } | null {
  for (const remoteName of ['origin', 'github']) {
    try {
      const result = spawnSync('git', ['remote', 'get-url', remoteName], {
        stdio   : ['pipe', 'pipe', 'pipe'],
        timeout : 5_000,
      });
      const url = result.stdout?.toString().trim();
      if (result.status === 0 && url) {
        const parsed = parseGitHubRemote(url);
        if (parsed) { return parsed; }
      }
    } catch {
      // git not available or not a repo — continue.
    }
  }
  return null;
}

/**
 * Resolve the GitHub `owner/repo` to migrate.
 *
 * 1. If `args[0]` contains a `/`, treat it as an explicit `owner/repo`.
 * 2. Otherwise, detect from the current directory's git remotes.
 * 3. If neither works, print an error and exit.
 */
export function resolveGhRepo(args: string[]): { owner: string; repo: string } {
  const target = args[0];

  // Explicit argument.
  if (target && target.includes('/')) {
    const [owner, ...repoParts] = target.split('/');
    const repo = repoParts.join('/');
    if (owner && repo) { return { owner, repo }; }
  }

  // Auto-detect from git remotes.
  const detected = detectGhRepoFromRemotes();
  if (detected) {
    console.log(`Detected GitHub repo: ${detected.owner}/${detected.repo}`);
    return detected;
  }

  console.error(
    'Could not determine GitHub repository.\n' +
    '  Either pass owner/repo explicitly:\n' +
    '    gitd migrate <subcommand> <owner/repo>\n' +
    '  Or run from inside a git repo with a GitHub remote.\n',
  );
  process.exit(1);
}

/**
 * Prepend a GitHub author attribution line to the body text.
 * This preserves provenance when migrating records whose protocols
 * don't have an `author` tag.
 */
function prependAuthor(body: string, ghLogin: string): string {
  return `[migrated from GitHub — @${ghLogin}]\n\n${body}`;
}

// ---------------------------------------------------------------------------
// migrate all
// ---------------------------------------------------------------------------

async function migrateAll(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = resolveGhRepo(args);
  const reposPath = resolveReposPath(args, ctx.profileName);
  const skipGit = hasFlag(args, '--no-git');
  const slug = `${owner}/${repo}`;

  const token = resolveGitHubToken();
  if (!token) {
    console.log(`Warning: no GitHub token found. Private repos will fail.`);
    console.log(`  Run "gh auth login" or set GITHUB_TOKEN to authenticate.\n`);
  }

  console.log(`Migrating ${slug} from GitHub...\n`);

  try {
    // Step 1: repo metadata.
    await migrateRepoInner(ctx, owner, repo);

    // Step 2: git content (clone, bundle, refs).
    if (skipGit) {
      console.log('  Skipping git content (--no-git).');
    } else {
      try {
        await migrateGitContent(ctx, owner, repo, reposPath);
      } catch (err) {
        console.error(`  Warning: git content migration failed: ${(err as Error).message}`);
        console.error('  Metadata, issues, PRs, and releases will still be imported.');
        console.error('  Re-run without --no-git to retry git content migration.\n');
      }
    }

    // Step 3: issues + comments.
    const issueCount = await migrateIssuesInner(ctx, owner, repo);

    // Step 4: pull requests + reviews.
    const pullCount = await migratePullsInner(ctx, owner, repo);

    // Step 5: releases.
    const releaseCount = await migrateReleasesInner(ctx, owner, repo);

    console.log(`\nMigration complete: ${slug}`);
    console.log(`  Issues:   ${issueCount}`);
    console.log(`  Patches:  ${pullCount}`);
    console.log(`  Releases: ${releaseCount}`);
  } catch (err) {
    console.error(`Migration failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// migrate repo
// ---------------------------------------------------------------------------

async function migrateRepo(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = resolveGhRepo(args);
  const reposPath = resolveReposPath(args, ctx.profileName);
  const skipGit = hasFlag(args, '--no-git');
  try {
    await migrateRepoInner(ctx, owner, repo);
    if (skipGit) {
      console.log('  Skipping git content (--no-git).');
    } else {
      await migrateGitContent(ctx, owner, repo, reposPath);
    }
  } catch (err) {
    console.error(`Failed to migrate repo: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migrateRepoInner(ctx: AgentContext, owner: string, repo: string): Promise<void> {
  const slug = `${owner}/${repo}`;
  console.log(`Importing repo metadata from ${slug}...`);

  // Check if a repo record with this name already exists.
  const { records: existing } = await ctx.repo.records.query('repo', {
    filter: { tags: { name: repo } },
  });
  if (existing.length > 0) {
    console.log(`  Repo record already exists: "${repo}" — skipping.`);
    return;
  }

  const gh = await ghFetch<GhRepo>(`/repos/${owner}/${repo}`);

  const { status, record } = await ctx.repo.records.create('repo', {
    data: {
      name          : gh.name,
      description   : gh.description ?? '',
      defaultBranch : gh.default_branch,
      dwnEndpoints  : [],
    },
    tags: {
      name       : gh.name,
      visibility : gh.private ? 'private' : 'public',
    },
  });

  if (status.code >= 300) {
    console.error(`  Failed to create repo: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`  Created repo "${gh.name}" (${gh.private ? 'private' : 'public'})`);
  console.log(`  Record ID: ${record.id}`);
  console.log(`  Source:    ${gh.html_url}`);
}

// ---------------------------------------------------------------------------
// migrate git content (clone + bundle + refs)
// ---------------------------------------------------------------------------

/**
 * Clone the GitHub repository as a bare repo, create a full git bundle,
 * upload it to DWN, and sync all refs to DWN records.
 *
 * This is the "git content" migration step that turns the metadata-only
 * repo record into a fully cloneable repo.
 */
async function migrateGitContent(
  ctx: AgentContext,
  owner: string,
  repo: string,
  reposPath: string,
): Promise<void> {
  const slug = `${owner}/${repo}`;
  console.log(`Importing git content from ${slug}...`);

  const backend = new GitBackend({ basePath: reposPath });
  const repoPath = backend.repoPath(ctx.did, repo);

  // Step 1: Clone bare repo from GitHub (or skip if already on disk).
  if (backend.exists(ctx.did, repo)) {
    console.log(`  Bare repo already exists at ${repoPath} — skipping clone.`);
  } else {
    const cloneUrl = buildCloneUrl(owner, repo);
    console.log(`  Cloning ${cloneUrl} → ${repoPath}`);
    await cloneBare(cloneUrl, repoPath);
    console.log('  Clone complete.');
  }

  // Step 2: Create full git bundle.
  console.log('  Creating git bundle...');
  const bundleInfo = await createFullBundle(repoPath);
  console.log(`  Bundle: ${bundleInfo.size} bytes, ${bundleInfo.refCount} ref(s), tip: ${bundleInfo.tipCommit.slice(0, 8)}`);

  // Step 3: Upload bundle to DWN.
  const { contextId: repoContextId, visibility } = await getRepoContext(ctx, repo);
  const encrypt = visibility === 'private';

  try {
    const bundleData = new Uint8Array(await readFile(bundleInfo.path));

    const { status } = await ctx.repo.records.create('repo/bundle', {
      data       : bundleData,
      dataFormat : 'application/x-git-bundle',
      tags       : {
        tipCommit : bundleInfo.tipCommit,
        isFull    : true,
        refCount  : bundleInfo.refCount,
        size      : bundleInfo.size,
      },
      parentContextId : repoContextId,
      encryption      : encrypt,
    } as any);

    if (status.code >= 300) {
      throw new Error(`Failed to create bundle record: ${status.code} ${status.detail}`);
    }
    console.log('  Bundle uploaded to DWN.');
  } finally {
    await unlink(bundleInfo.path).catch(() => {});
  }

  // Step 4: Sync git refs to DWN.
  console.log('  Syncing refs to DWN...');
  const gitRefs = await readGitRefs(repoPath);

  let refCount = 0;
  for (const ref of gitRefs) {
    const { status } = await ctx.refs.records.create('repo/ref', {
      data            : { name: ref.name, target: ref.target, type: ref.type },
      tags            : { name: ref.name, type: ref.type, target: ref.target },
      parentContextId : repoContextId,
    });

    if (status.code >= 300) {
      console.error(`  Failed to sync ref ${ref.name}: ${status.code} ${status.detail}`);
      continue;
    }
    refCount++;
  }

  console.log(`  Synced ${refCount} ref(s) to DWN.`);
  console.log(`  Git content migration complete.`);
}

/**
 * Build the clone URL for a GitHub repository.
 * Uses the token (if available) for authenticated HTTPS clone.
 */
function buildCloneUrl(owner: string, repo: string): string {
  const token = resolveGitHubToken();
  if (token) {
    return `https://${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Clone a git repository as a bare repo using `git clone --bare`.
 */
function cloneBare(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--bare', url, destPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`git clone --bare failed (exit ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// migrate issues
// ---------------------------------------------------------------------------

async function migrateIssues(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = resolveGhRepo(args);
  try {
    const count = await migrateIssuesInner(ctx, owner, repo);
    console.log(`\nImported ${count} issue${count !== 1 ? 's' : ''}.`);
  } catch (err) {
    console.error(`Failed to migrate issues: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migrateIssuesInner(ctx: AgentContext, owner: string, repo: string): Promise<number> {
  const slug = `${owner}/${repo}`;
  const importComments = !process.env.GITD_MIGRATE_SKIP_COMMENTS;
  console.log(`Importing issues from ${slug}...`);

  const repoContextId = await getRepoContextId(ctx, repo);

  // Fetch all issues (GitHub API returns PRs as issues too — filter them out).
  const allIssues = await ghFetchAll<GhIssue>(`/repos/${owner}/${repo}/issues?state=all&sort=created&direction=asc`);
  const issues = allIssues.filter((i) => !i.pull_request);

  if (issues.length === 0) {
    console.log('  No issues found.');
    return 0;
  }

  // Build a set of already-imported GitHub issue numbers for idempotency.
  const { records: existingIssues } = await ctx.issues.records.query('repo/issue' as any, {
    filter: { contextId: repoContextId },
  });
  const importedNumbers = new Set<number>();
  for (const rec of existingIssues) {
    const d = await rec.data.json();
    if (typeof d.number === 'number') {
      importedNumbers.add(d.number);
    }
  }

  let imported = 0;

  for (const ghIssue of issues) {
    if (importedNumbers.has(ghIssue.number)) {
      console.log(`  #${ghIssue.number} "${ghIssue.title}" — already imported, skipping.`);
      continue;
    }

    const author = ghIssue.user?.login ?? 'unknown';
    const body = prependAuthor(ghIssue.body ?? '', author);

    const { status: issueStatus, record: issueRecord } = await ctx.issues.records.create('repo/issue', {
      data            : { title: ghIssue.title, body, number: ghIssue.number },
      tags            : { status: ghIssue.state === 'open' ? 'open' : 'closed' },
      parentContextId : repoContextId,
    });

    if (issueStatus.code >= 300) {
      console.error(`  Failed to import issue #${ghIssue.number}: ${issueStatus.code} ${issueStatus.detail}`);
      continue;
    }

    imported++;

    // Import comments.
    if (importComments) {
      const comments = await ghFetchAll<GhComment>(`/repos/${owner}/${repo}/issues/${ghIssue.number}/comments`);
      let commentCount = 0;

      for (const ghComment of comments) {
        const commentAuthor = ghComment.user?.login ?? 'unknown';
        const commentBody = prependAuthor(ghComment.body ?? '', commentAuthor);

        const { status: commentStatus } = await ctx.issues.records.create('repo/issue/comment' as any, {
          data            : { body: commentBody },
          parentContextId : issueRecord.contextId,
        } as any);

        if (commentStatus.code >= 300) {
          console.error(`  Failed to import comment on issue #${ghIssue.number}: ${commentStatus.code}`);
          continue;
        }
        commentCount++;
      }

      if (commentCount > 0) {
        console.log(`  #${ghIssue.number} "${ghIssue.title}" (${ghIssue.state}, ${commentCount} comment${commentCount !== 1 ? 's' : ''})`);
      } else {
        console.log(`  #${ghIssue.number} "${ghIssue.title}" (${ghIssue.state})`);
      }
    } else {
      console.log(`  #${ghIssue.number} "${ghIssue.title}" (${ghIssue.state})`);
    }
  }

  return imported;
}

// ---------------------------------------------------------------------------
// migrate pulls
// ---------------------------------------------------------------------------

async function migratePulls(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = resolveGhRepo(args);
  try {
    const count = await migratePullsInner(ctx, owner, repo);
    console.log(`\nImported ${count} PR${count !== 1 ? 's' : ''}.`);
  } catch (err) {
    console.error(`Failed to migrate pull requests: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migratePullsInner(ctx: AgentContext, owner: string, repo: string): Promise<number> {
  const slug = `${owner}/${repo}`;
  const importReviews = !process.env.GITD_MIGRATE_SKIP_COMMENTS;
  console.log(`Importing pull requests from ${slug}...`);

  const repoContextId = await getRepoContextId(ctx, repo);

  const pulls = await ghFetchAll<GhPull>(`/repos/${owner}/${repo}/pulls?state=all&sort=created&direction=asc`);

  if (pulls.length === 0) {
    console.log('  No pull requests found.');
    return 0;
  }

  // Build a set of already-imported GitHub PR numbers for idempotency.
  const { records: existingPatches } = await ctx.patches.records.query('repo/patch' as any, {
    filter: { contextId: repoContextId },
  });
  const importedNumbers = new Set<number>();
  for (const rec of existingPatches) {
    const d = await rec.data.json();
    if (typeof d.number === 'number') {
      importedNumbers.add(d.number);
    }
  }

  let imported = 0;

  for (const ghPull of pulls) {
    if (importedNumbers.has(ghPull.number)) {
      console.log(`  #${ghPull.number} "${ghPull.title}" — already imported, skipping.`);
      continue;
    }

    const author = ghPull.user?.login ?? 'unknown';
    const body = prependAuthor(ghPull.body ?? '', author);

    // Map GitHub PR state to gitd PR status.
    let prStatus: string;
    if (ghPull.merged) {
      prStatus = 'merged';
    } else if (ghPull.state === 'closed') {
      prStatus = 'closed';
    } else {
      prStatus = 'open';
    }

    const tags: Record<string, string> = {
      status     : prStatus,
      baseBranch : ghPull.base.ref,
      headBranch : ghPull.head.ref,
    };

    const { status: prSt, record: prRecord } = await ctx.patches.records.create('repo/patch', {
      data            : { title: ghPull.title, body, number: ghPull.number },
      tags,
      parentContextId : repoContextId,
    });

    if (prSt.code >= 300) {
      console.error(`  Failed to import PR #${ghPull.number}: ${prSt.code} ${prSt.detail}`);
      continue;
    }

    imported++;

    // Import reviews.
    if (importReviews) {
      const reviews = await ghFetchAll<GhReview>(`/repos/${owner}/${repo}/pulls/${ghPull.number}/reviews`);
      let reviewCount = 0;

      for (const ghReview of reviews) {
        // Skip empty reviews (GitHub creates these for "viewed" actions).
        if (!ghReview.body && ghReview.state === 'COMMENTED') { continue; }

        const reviewer = ghReview.user?.login ?? 'unknown';
        const reviewBody = prependAuthor(ghReview.body ?? '', reviewer);

        // Map GitHub review state to a verdict.
        let verdict: string;
        switch (ghReview.state) {
          case 'APPROVED': verdict = 'approve'; break;
          case 'CHANGES_REQUESTED': verdict = 'reject'; break;
          default: verdict = 'comment'; break;
        }

        const { status: reviewSt } = await ctx.patches.records.create('repo/patch/review' as any, {
          data            : { body: reviewBody },
          tags            : { verdict },
          parentContextId : prRecord.contextId,
        } as any);

        if (reviewSt.code >= 300) {
          console.error(`  Failed to import review on PR #${ghPull.number}: ${reviewSt.code}`);
          continue;
        }
        reviewCount++;
      }

      if (reviewCount > 0) {
        console.log(`  #${ghPull.number} "${ghPull.title}" (${prStatus}, ${reviewCount} review${reviewCount !== 1 ? 's' : ''})`);
      } else {
        console.log(`  #${ghPull.number} "${ghPull.title}" (${prStatus})`);
      }
    } else {
      console.log(`  #${ghPull.number} "${ghPull.title}" (${prStatus})`);
    }
  }

  return imported;
}

// ---------------------------------------------------------------------------
// migrate releases
// ---------------------------------------------------------------------------

async function migrateReleases(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = resolveGhRepo(args);
  try {
    const count = await migrateReleasesInner(ctx, owner, repo);
    console.log(`\nImported ${count} release${count !== 1 ? 's' : ''}.`);
  } catch (err) {
    console.error(`Failed to migrate releases: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migrateReleasesInner(ctx: AgentContext, owner: string, repo: string): Promise<number> {
  const slug = `${owner}/${repo}`;
  console.log(`Importing releases from ${slug}...`);

  const repoContextId = await getRepoContextId(ctx, repo);

  const releases = await ghFetchAll<GhRelease>(`/repos/${owner}/${repo}/releases`);

  if (releases.length === 0) {
    console.log('  No releases found.');
    return 0;
  }

  let imported = 0;

  for (const ghRelease of releases) {
    const name = ghRelease.name ?? ghRelease.tag_name;
    const body = ghRelease.body ?? '';

    const tags: Record<string, unknown> = { tagName: ghRelease.tag_name };
    if (ghRelease.target_commitish) { tags.commitSha = ghRelease.target_commitish; }
    if (ghRelease.prerelease) { tags.prerelease = true; }
    if (ghRelease.draft) { tags.draft = true; }

    const { status } = await ctx.releases.records.create('repo/release' as any, {
      data            : { name, body },
      tags,
      parentContextId : repoContextId,
    } as any);

    if (status.code >= 300) {
      console.error(`  Failed to import release ${ghRelease.tag_name}: ${status.code} ${status.detail}`);
      continue;
    }

    const flags = [
      ghRelease.prerelease ? 'pre-release' : '',
      ghRelease.draft ? 'draft' : '',
    ].filter(Boolean).join(', ');

    console.log(`  ${ghRelease.tag_name} "${name}"${flags ? ` (${flags})` : ''}`);
    imported++;
  }

  return imported;
}
