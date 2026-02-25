/**
 * `gitd migrate` — import repository data from GitHub.
 *
 * Fetches repo metadata, issues, pull requests, and releases from the
 * GitHub REST API and creates corresponding DWN records.  A `GITHUB_TOKEN`
 * env var is recommended for authenticated requests (higher rate limits).
 *
 * Usage:
 *   gitd migrate all <owner/repo>            Import everything
 *   gitd migrate repo <owner/repo>           Import repo metadata only
 *   gitd migrate issues <owner/repo>         Import issues + comments
 *   gitd migrate pulls <owner/repo>          Import PRs as patches + reviews
 *   gitd migrate releases <owner/repo>       Import releases
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

/** Headers for GitHub API requests. */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept'     : 'application/vnd.github+json',
    'User-Agent' : 'gitd-migrate/0.1',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) { headers['Authorization'] = `Bearer ${token}`; }
  return headers;
}

/** Fetch a single page from the GitHub API.  Throws on non-2xx. */
async function ghFetch<T>(path: string): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
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
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
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
      console.error('Usage: gitd migrate <all|repo|issues|pulls|releases> <owner/repo>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Parse <owner/repo> argument
// ---------------------------------------------------------------------------

function parseGhRepo(args: string[]): { owner: string; repo: string } {
  const target = args[0];
  if (!target || !target.includes('/')) {
    console.error('Usage: gitd migrate <subcommand> <owner/repo>');
    process.exit(1);
  }

  const [owner, ...repoParts] = target.split('/');
  const repo = repoParts.join('/');

  if (!owner || !repo) {
    console.error('Invalid repository format. Use: owner/repo');
    process.exit(1);
  }

  return { owner, repo };
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
  const { owner, repo } = parseGhRepo(args);
  const slug = `${owner}/${repo}`;

  console.log(`Migrating ${slug} from GitHub...\n`);

  try {
    // Step 1: repo metadata.
    await migrateRepoInner(ctx, owner, repo);

    // Step 2: issues + comments.
    const issueCount = await migrateIssuesInner(ctx, owner, repo);

    // Step 3: pull requests + reviews.
    const pullCount = await migratePullsInner(ctx, owner, repo);

    // Step 4: releases.
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
  const { owner, repo } = parseGhRepo(args);
  try {
    await migrateRepoInner(ctx, owner, repo);
  } catch (err) {
    console.error(`Failed to migrate repo: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migrateRepoInner(ctx: AgentContext, owner: string, repo: string): Promise<void> {
  const slug = `${owner}/${repo}`;
  console.log(`Importing repo metadata from ${slug}...`);

  // Check if a repo record already exists.
  const { records: existing } = await ctx.repo.records.query('repo');
  if (existing.length > 0) {
    const data = await existing[0].data.json();
    console.log(`  Repo record already exists: "${data.name}" — skipping.`);
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
// migrate issues
// ---------------------------------------------------------------------------

async function migrateIssues(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = parseGhRepo(args);
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

  const repoContextId = await getRepoContextId(ctx);

  // Fetch all issues (GitHub API returns PRs as issues too — filter them out).
  const allIssues = await ghFetchAll<GhIssue>(`/repos/${owner}/${repo}/issues?state=all&sort=created&direction=asc`);
  const issues = allIssues.filter((i) => !i.pull_request);

  if (issues.length === 0) {
    console.log('  No issues found.');
    return 0;
  }

  let imported = 0;

  for (const ghIssue of issues) {
    const author = ghIssue.user?.login ?? 'unknown';
    const body = prependAuthor(ghIssue.body ?? '', author);

    const { status: issueStatus, record: issueRecord } = await ctx.issues.records.create('repo/issue', {
      data            : { title: ghIssue.title, body, number: ghIssue.number },
      tags            : { status: ghIssue.state === 'open' ? 'open' : 'closed', number: String(ghIssue.number) },
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
  const { owner, repo } = parseGhRepo(args);
  try {
    const count = await migratePullsInner(ctx, owner, repo);
    console.log(`\nImported ${count} patch${count !== 1 ? 'es' : ''}.`);
  } catch (err) {
    console.error(`Failed to migrate pull requests: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function migratePullsInner(ctx: AgentContext, owner: string, repo: string): Promise<number> {
  const slug = `${owner}/${repo}`;
  const importReviews = !process.env.GITD_MIGRATE_SKIP_COMMENTS;
  console.log(`Importing pull requests from ${slug}...`);

  const repoContextId = await getRepoContextId(ctx);

  const pulls = await ghFetchAll<GhPull>(`/repos/${owner}/${repo}/pulls?state=all&sort=created&direction=asc`);

  if (pulls.length === 0) {
    console.log('  No pull requests found.');
    return 0;
  }

  let imported = 0;

  for (const ghPull of pulls) {
    const author = ghPull.user?.login ?? 'unknown';
    const body = prependAuthor(ghPull.body ?? '', author);

    // Map GitHub PR state to gitd patch status.
    let patchStatus: string;
    if (ghPull.merged) {
      patchStatus = 'merged';
    } else if (ghPull.state === 'closed') {
      patchStatus = 'closed';
    } else {
      patchStatus = 'open';
    }

    const tags: Record<string, string> = {
      status     : patchStatus,
      baseBranch : ghPull.base.ref,
      headBranch : ghPull.head.ref,
      number     : String(ghPull.number),
    };

    const { status: patchSt, record: patchRecord } = await ctx.patches.records.create('repo/patch', {
      data            : { title: ghPull.title, body, number: ghPull.number },
      tags,
      parentContextId : repoContextId,
    });

    if (patchSt.code >= 300) {
      console.error(`  Failed to import PR #${ghPull.number}: ${patchSt.code} ${patchSt.detail}`);
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
          case 'CHANGES_REQUESTED': verdict = 'request_changes'; break;
          default: verdict = 'comment'; break;
        }

        const { status: reviewSt } = await ctx.patches.records.create('repo/patch/review' as any, {
          data            : { body: reviewBody },
          tags            : { verdict },
          parentContextId : patchRecord.contextId,
        } as any);

        if (reviewSt.code >= 300) {
          console.error(`  Failed to import review on PR #${ghPull.number}: ${reviewSt.code}`);
          continue;
        }
        reviewCount++;
      }

      if (reviewCount > 0) {
        console.log(`  #${ghPull.number} "${ghPull.title}" (${patchStatus}, ${reviewCount} review${reviewCount !== 1 ? 's' : ''})`);
      } else {
        console.log(`  #${ghPull.number} "${ghPull.title}" (${patchStatus})`);
      }
    } else {
      console.log(`  #${ghPull.number} "${ghPull.title}" (${patchStatus})`);
    }
  }

  return imported;
}

// ---------------------------------------------------------------------------
// migrate releases
// ---------------------------------------------------------------------------

async function migrateReleases(ctx: AgentContext, args: string[]): Promise<void> {
  const { owner, repo } = parseGhRepo(args);
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

  const repoContextId = await getRepoContextId(ctx);

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
