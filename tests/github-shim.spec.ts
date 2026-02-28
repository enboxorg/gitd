/**
 * GitHub API compatibility shim tests — exercises `handleShimRequest()`
 * against a real Web5 agent populated with DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded, and
 * then each test calls `handleShimRequest()` directly with a constructed
 * URL.  No HTTP server is started.
 *
 * Validates that DWN records are correctly mapped to GitHub REST API v3
 * JSON response shapes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';
import type { JsonResponse } from '../src/github-shim/helpers.js';

import { ForgeCiProtocol } from '../src/ci.js';
import { ForgeIssuesProtocol } from '../src/issues.js';
import { ForgeNotificationsProtocol } from '../src/notifications.js';
import { ForgeOrgProtocol } from '../src/org.js';
import { ForgePatchesProtocol } from '../src/patches.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRegistryProtocol } from '../src/registry.js';
import { ForgeReleasesProtocol } from '../src/releases.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { ForgeSocialProtocol } from '../src/social.js';
import { ForgeWikiProtocol } from '../src/wiki.js';
import { handleShimRequest } from '../src/github-shim/server.js';
import { numericId } from '../src/github-shim/helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/github-shim-agent';
const BASE = 'http://localhost:8181';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDid: string;

function url(path: string): URL {
  return new URL(path, BASE);
}

function repoUrl(subPath: string): URL {
  return url(`/repos/${testDid}/test-repo${subPath}`);
}

function parse(res: JsonResponse): any {
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GitHub API compatibility shim', () => {
  let ctx: AgentContext;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await Web5UserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'GitHub Shim Test' },
      });
    }

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    const { web5, did } = result;
    testDid = did;

    const repo = web5.using(ForgeRepoProtocol);
    const refs = web5.using(ForgeRefsProtocol);
    const issues = web5.using(ForgeIssuesProtocol);
    const patches = web5.using(ForgePatchesProtocol);
    const ci = web5.using(ForgeCiProtocol);
    const releases = web5.using(ForgeReleasesProtocol);
    const registry = web5.using(ForgeRegistryProtocol);
    const social = web5.using(ForgeSocialProtocol);
    const notifications = web5.using(ForgeNotificationsProtocol);
    const wiki = web5.using(ForgeWikiProtocol);
    const org = web5.using(ForgeOrgProtocol);

    await repo.configure();
    await refs.configure();
    await issues.configure();
    await patches.configure();
    await ci.configure();
    await releases.configure();
    await registry.configure();
    await social.configure();
    await notifications.configure();
    await wiki.configure();
    await org.configure();

    ctx = {
      did, repo, refs, issues, patches, ci, releases,
      registry, social, notifications, wiki, org, web5,
    };

    // -----------------------------------------------------------------------
    // Seed data
    // -----------------------------------------------------------------------

    // 1. Create a repo record.
    const { record: repoRec } = await ctx.repo.records.create('repo', {
      data : { name: 'test-repo', description: 'A test repository', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'test-repo', visibility: 'public' },
    });
    const repoContextId = repoRec!.contextId ?? '';

    // 2. Create an open issue.
    const { record: issueRec } = await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Fix the widget', body: 'The widget is broken.', number: 1 },
      tags            : { status: 'open', number: '1' },
      parentContextId : repoContextId,
    });

    // 3. Create a comment on the issue.
    await ctx.issues.records.create('repo/issue/comment' as any, {
      data            : { body: 'I can reproduce this.' },
      parentContextId : issueRec!.contextId ?? '',
    } as any);

    // 4. Create a second comment on the issue.
    await ctx.issues.records.create('repo/issue/comment' as any, {
      data            : { body: 'Working on a fix.' },
      parentContextId : issueRec!.contextId ?? '',
    } as any);

    // 5. Create a closed issue.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Already fixed.', number: 2 },
      tags            : { status: 'closed', number: '2' },
      parentContextId : repoContextId,
    });

    // 6. Create an open patch with a revision.
    const { record: patchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Add feature X', body: 'Implements feature X.', number: 1 },
      tags            : { status: 'open', baseBranch: 'main', headBranch: 'feat-x', number: '1', sourceDid: testDid },
      parentContextId : repoContextId,
    });

    // 6a. Create a revision record with commit and diff stat metadata.
    await ctx.patches.records.create('repo/patch/revision' as any, {
      data: {
        description : 'v1: 3 commits',
        diffStat    : { additions: 42, deletions: 7, filesChanged: 5 },
      },
      tags: {
        headCommit  : 'abc1234567890abcdef1234567890abcdef123456',
        baseCommit  : 'def0987654321fedcba0987654321fedcba098765',
        commitCount : 3,
      },
      parentContextId: patchRec!.contextId ?? '',
    } as any);

    // 7. Create a review on the patch.
    await ctx.patches.records.create('repo/patch/review' as any, {
      data            : { body: 'Looks good to me.' },
      tags            : { verdict: 'approve' },
      parentContextId : patchRec!.contextId ?? '',
    } as any);

    // 8. Create a second review.
    await ctx.patches.records.create('repo/patch/review' as any, {
      data            : { body: 'One nit.' },
      tags            : { verdict: 'comment' },
      parentContextId : patchRec!.contextId ?? '',
    } as any);

    // 9. Create a merged patch with a merge result.
    const { record: mergedPatchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Fix typo', body: 'Fixed a typo in README.', number: 2 },
      tags            : { status: 'merged', baseBranch: 'main', headBranch: 'fix-typo', number: '2' },
      parentContextId : repoContextId,
    });

    // 9a. Create a merge result with commit SHA.
    await ctx.patches.records.create('repo/patch/mergeResult' as any, {
      data            : { mergedBy: testDid },
      tags            : { mergeCommit: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00', strategy: 'squash' },
      parentContextId : mergedPatchRec!.contextId ?? '',
    } as any);

    // 10. Create a release.
    await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v1.0.0', body: 'Initial release.' },
      tags            : { tagName: 'v1.0.0' },
      parentContextId : repoContextId,
    } as any);

    // 11. Create a pre-release.
    await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v2.0.0-beta', body: 'Beta release.' },
      tags            : { tagName: 'v2.0.0-beta', prerelease: true },
      parentContextId : repoContextId,
    } as any);
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // Helpers unit tests
  // =========================================================================

  describe('numericId()', () => {
    it('should return a positive 32-bit integer', () => {
      const id = numericId('test-record-id');
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 32);
    });

    it('should be deterministic', () => {
      expect(numericId('same-input')).toBe(numericId('same-input'));
    });

    it('should produce different values for different inputs', () => {
      expect(numericId('input-a')).not.toBe(numericId('input-b'));
    });
  });

  // =========================================================================
  // Response headers
  // =========================================================================

  describe('response headers', () => {
    it('should include GitHub API compatibility headers', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(res.headers['X-GitHub-Media-Type']).toBe('github.v3');
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['X-RateLimit-Limit']).toBe('5000');
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo
  // =========================================================================

  describe('GET /repos/:did/:repo', () => {
    it('should return 200 with repo info', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('test-repo');
      expect(data.description).toBe('A test repository');
      expect(data.default_branch).toBe('main');
    });

    it('should include owner object with DID as login', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.owner.login).toBe(testDid);
      expect(data.owner.id).toBe(numericId(testDid));
      expect(data.owner.type).toBe('User');
    });

    it('should include full_name as did/repo', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.full_name).toBe(`${testDid}/test-repo`);
    });

    it('should set private based on visibility', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.private).toBe(false);
      expect(data.visibility).toBe('public');
    });

    it('should include standard GitHub fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.fork).toBe(false);
      expect(data.has_issues).toBe(true);
      expect(data.has_wiki).toBe(true);
      expect(data.archived).toBe(false);
      expect(data.disabled).toBe(false);
    });

    it('should include date fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();
      expect(data.pushed_at).toBeDefined();
    });

    it('should return 404 for non-existent DID', async () => {
      const res = await handleShimRequest(ctx, url('/repos/did:jwk:nonexistent/repo'));
      // Depending on DID resolution it could be 404 or 502.
      expect([404, 502]).toContain(res.status);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues
  // =========================================================================

  describe('GET /repos/:did/:repo/issues', () => {
    it('should return open issues by default', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].title).toBe('Fix the widget');
      expect(data[0].state).toBe('open');
    });

    it('should filter by state=closed', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=closed'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(data[0].title).toBe('Old bug');
      expect(data[0].state).toBe('closed');
    });

    it('should return all issues with state=all', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=all'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(2);
    });

    it('should include GitHub-style issue fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=all'));
      const data = parse(res);
      const issue = data.find((i: any) => i.number === 1);
      expect(issue).toBeDefined();
      expect(issue.title).toBe('Fix the widget');
      expect(issue.body).toBe('The widget is broken.');
      expect(issue.user.login).toBe(testDid);
      expect(issue.url).toContain('/issues/1');
      expect(issue.comments_url).toContain('/issues/1/comments');
      expect(issue.labels).toEqual([]);
      expect(issue.locked).toBe(false);
    });

    it('should set closed_at for closed issues', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=closed'));
      const data = parse(res);
      expect(data[0].closed_at).toBeDefined();
      expect(data[0].closed_at).not.toBeNull();
    });

    it('should set closed_at to null for open issues', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'));
      const data = parse(res);
      expect(data[0].closed_at).toBeNull();
    });

    it('should support pagination with per_page', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=all&per_page=1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(1);
    });

    it('should include Link header for paginated results', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues?state=all&per_page=1'));
      expect(res.headers['Link']).toBeDefined();
      expect(res.headers['Link']).toContain('rel="next"');
      expect(res.headers['Link']).toContain('rel="last"');
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues/:number
  // =========================================================================

  describe('GET /repos/:did/:repo/issues/:number', () => {
    it('should return issue detail', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(1);
      expect(data.title).toBe('Fix the widget');
      expect(data.body).toBe('The widget is broken.');
      expect(data.state).toBe('open');
    });

    it('should include comment count', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1'));
      const data = parse(res);
      expect(data.comments).toBe(2);
    });

    it('should return 404 for non-existent issue', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999'));
      expect(res.status).toBe(404);
      const data = parse(res);
      expect(data.message).toContain('not found');
    });

    it('should include documentation_url in 404 response', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999'));
      const data = parse(res);
      expect(data.documentation_url).toBeDefined();
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues/:number/comments
  // =========================================================================

  describe('GET /repos/:did/:repo/issues/:number/comments', () => {
    it('should return issue comments', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1/comments'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should include GitHub-style comment fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1/comments'));
      const data = parse(res);
      expect(data[0].body).toBe('I can reproduce this.');
      expect(data[0].user.login).toBe(testDid);
      expect(data[0].created_at).toBeDefined();
      expect(data[0].author_association).toBe('OWNER');
      expect(data[0].issue_url).toContain('/issues/1');
    });

    it('should return 404 for non-existent issue comments', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999/comments'));
      expect(res.status).toBe(404);
    });

    it('should support pagination', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1/comments?per_page=1'));
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(res.headers['Link']).toBeDefined();
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/pulls
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls', () => {
    it('should return open pulls by default', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].title).toBe('Add feature X');
      expect(data[0].state).toBe('open');
      expect(data[0].merged).toBe(false);
    });

    it('should include merged pulls in state=closed filter', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls?state=closed'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(data[0].title).toBe('Fix typo');
      expect(data[0].state).toBe('closed');
      expect(data[0].merged).toBe(true);
    });

    it('should return all pulls with state=all', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls?state=all'));
      const data = parse(res);
      expect(data.length).toBe(2);
    });

    it('should include GitHub-style pull request fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'));
      const data = parse(res);
      const pr = data[0];
      expect(pr.number).toBe(1);
      expect(pr.head.ref).toBe('feat-x');
      expect(pr.base.ref).toBe('main');
      expect(pr.user.login).toBe(testDid);
      expect(pr.draft).toBe(false);
      expect(pr.diff_url).toContain('/pulls/1.diff');
      expect(pr.patch_url).toContain('/pulls/1.patch');
    });

    it('should populate commit and diff stats from revision record', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'));
      const pr = parse(res);
      expect(pr.head.sha).toBe('abc1234567890abcdef1234567890abcdef123456');
      expect(pr.base.sha).toBe('def0987654321fedcba0987654321fedcba098765');
      expect(pr.commits).toBe(3);
      expect(pr.additions).toBe(42);
      expect(pr.deletions).toBe(7);
      expect(pr.changed_files).toBe(5);
    });

    it('should set merged_at and merge_commit_sha for merged pulls', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls?state=closed'));
      const data = parse(res);
      const merged = data.find((p: any) => p.merged === true);
      expect(merged).toBeDefined();
      expect(merged.merged_at).toBeDefined();
      expect(merged.merged_at).not.toBeNull();
      expect(merged.merge_commit_sha).toBe('ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00');
    });

    it('should set merged_at to null for open pulls', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'));
      const data = parse(res);
      expect(data[0].merged_at).toBeNull();
      expect(data[0].merged).toBe(false);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/pulls/:number
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls/:number', () => {
    it('should return pull request detail', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(1);
      expect(data.title).toBe('Add feature X');
      expect(data.body).toBe('Implements feature X.');
    });

    it('should return merged pull detail with correct flags', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/2'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(2);
      expect(data.state).toBe('closed');
      expect(data.merged).toBe(true);
    });

    it('should return 404 for non-existent pull', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999'));
      expect(res.status).toBe(404);
      const data = parse(res);
      expect(data.message).toContain('not found');
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/pulls/:number/reviews
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls/:number/reviews', () => {
    it('should return pull request reviews', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/reviews'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should map verdict to GitHub review state', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/reviews'));
      const data = parse(res);
      const approved = data.find((r: any) => r.state === 'APPROVED');
      expect(approved).toBeDefined();
      expect(approved.body).toBe('Looks good to me.');

      const commented = data.find((r: any) => r.state === 'COMMENTED');
      expect(commented).toBeDefined();
      expect(commented.body).toBe('One nit.');
    });

    it('should include GitHub-style review fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/reviews'));
      const data = parse(res);
      expect(data[0].user.login).toBe(testDid);
      expect(data[0].submitted_at).toBeDefined();
      expect(data[0].author_association).toBe('OWNER');
      expect(data[0].pull_request_url).toContain('/pulls/1');
    });

    it('should return 404 for non-existent pull reviews', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/reviews'));
      expect(res.status).toBe(404);
    });

    it('should support pagination', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/reviews?per_page=1'));
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(res.headers['Link']).toBeDefined();
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/releases
  // =========================================================================

  describe('GET /repos/:did/:repo/releases', () => {
    it('should return releases', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should include GitHub-style release fields', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'));
      const data = parse(res);
      const stable = data.find((r: any) => r.tag_name === 'v1.0.0');
      expect(stable).toBeDefined();
      expect(stable.name).toBe('v1.0.0');
      expect(stable.body).toBe('Initial release.');
      expect(stable.draft).toBe(false);
      expect(stable.prerelease).toBe(false);
      expect(stable.author.login).toBe(testDid);
      expect(stable.assets).toEqual([]);
      expect(stable.tarball_url).toContain('/tarball/v1.0.0');
    });

    it('should mark pre-releases correctly', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'));
      const data = parse(res);
      const beta = data.find((r: any) => r.tag_name === 'v2.0.0-beta');
      expect(beta).toBeDefined();
      expect(beta.prerelease).toBe(true);
      expect(beta.name).toBe('v2.0.0-beta');
    });

    it('should support pagination', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases?per_page=1'));
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(res.headers['Link']).toBeDefined();
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/releases/tags/:tag
  // =========================================================================

  describe('GET /repos/:did/:repo/releases/tags/:tag', () => {
    it('should return release by tag name', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases/tags/v1.0.0'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.tag_name).toBe('v1.0.0');
      expect(data.name).toBe('v1.0.0');
      expect(data.body).toBe('Initial release.');
    });

    it('should return 404 for non-existent tag', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases/tags/v99.0.0'));
      expect(res.status).toBe(404);
      const data = parse(res);
      expect(data.message).toContain('not found');
    });
  });

  // =========================================================================
  // GET /users/:did
  // =========================================================================

  describe('GET /users/:did', () => {
    it('should return user profile', async () => {
      const res = await handleShimRequest(ctx, url(`/users/${testDid}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.login).toBe(testDid);
      expect(data.id).toBe(numericId(testDid));
      expect(data.type).toBe('User');
    });

    it('should include GitHub-style user fields', async () => {
      const res = await handleShimRequest(ctx, url(`/users/${testDid}`));
      const data = parse(res);
      expect(data.repos_url).toContain(`/users/${testDid}/repos`);
      expect(data.site_admin).toBe(false);
      expect(data.public_repos).toBe(0);
      expect(data.followers).toBe(0);
      expect(data.following).toBe(0);
    });
  });

  // =========================================================================
  // 404 handling
  // =========================================================================

  describe('unknown routes', () => {
    it('should return 404 for unknown paths', async () => {
      const res = await handleShimRequest(ctx, url('/nonexistent'));
      expect(res.status).toBe(404);
      const data = parse(res);
      expect(data.message).toBeDefined();
    });

    it('should return 404 for unknown sub-paths under a repo', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-numeric issue IDs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/abc'));
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-numeric pull IDs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/abc'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // URL building
  // =========================================================================

  describe('URL building', () => {
    it('should include base URL in all response URLs', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.url).toContain(BASE);
      expect(data.owner.url).toContain(BASE);
    });

    it('should build correct issues_url template', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.issues_url).toContain('{/number}');
    });

    it('should build correct pulls_url template', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''));
      const data = parse(res);
      expect(data.pulls_url).toContain('{/number}');
    });
  });

  // =========================================================================
  // POST /repos/:did/:repo/issues — create issue
  // =========================================================================

  describe('POST /repos/:did/:repo/issues', () => {
    it('should create an issue and return 201', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title : 'New shim issue',
        body  : 'Created via API shim.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.title).toBe('New shim issue');
      expect(data.body).toBe('Created via API shim.');
      expect(data.state).toBe('open');
      expect(data.number).toBeGreaterThanOrEqual(3);
      expect(data.user.login).toBe(testDid);
    });

    it('should auto-assign the next sequential number', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Another shim issue',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      // Should be at least 4 since we already created 2 seeded + 1 in prev test.
      expect(data.number).toBeGreaterThanOrEqual(4);
    });

    it('should return 422 when title is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        body: 'Missing title.',
      });
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('title');
    });

    it('should return 404 for non-existent repo DID', async () => {
      const res = await handleShimRequest(ctx, url('/repos/did:jwk:nonexistent/missing-repo/issues'), 'POST', {
        title: 'Should fail',
      });
      expect([404, 502]).toContain(res.status);
    });
  });

  // =========================================================================
  // PATCH /repos/:did/:repo/issues/:number — update issue
  // =========================================================================

  describe('PATCH /repos/:did/:repo/issues/:number', () => {
    it('should update the title of an issue', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1'), 'PATCH', {
        title: 'Fix the widget (updated)',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.title).toBe('Fix the widget (updated)');
      expect(data.number).toBe(1);
    });

    it('should close an issue by setting state=closed', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1'), 'PATCH', {
        state: 'closed',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('closed');
    });

    it('should reopen an issue by setting state=open', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1'), 'PATCH', {
        state: 'open',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('open');
    });

    it('should return 404 for non-existent issue number', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999'), 'PATCH', {
        title: 'Nope',
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // POST /repos/:did/:repo/issues/:number/comments — create comment
  // =========================================================================

  describe('POST /repos/:did/:repo/issues/:number/comments', () => {
    it('should create a comment and return 201', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1/comments'), 'POST', {
        body: 'New comment via shim.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('New comment via shim.');
      expect(data.user.login).toBe(testDid);
      expect(data.issue_url).toContain('/issues/1');
      expect(data.author_association).toBe('OWNER');
    });

    it('should return 422 when body is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/1/comments'), 'POST', {});
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('body');
    });

    it('should return 404 for non-existent issue', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999/comments'), 'POST', {
        body: 'Should fail.',
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // POST /repos/:did/:repo/pulls — create pull request
  // =========================================================================

  describe('POST /repos/:did/:repo/pulls', () => {
    it('should create a pull request and return 201', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'New feature PR',
        body  : 'Adds a new feature.',
        base  : 'main',
        head  : 'feat-new',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.title).toBe('New feature PR');
      expect(data.body).toBe('Adds a new feature.');
      expect(data.state).toBe('open');
      expect(data.merged).toBe(false);
      expect(data.base.ref).toBe('main');
      expect(data.head.ref).toBe('feat-new');
      expect(data.number).toBeGreaterThanOrEqual(3);
    });

    it('should default base to main when not specified', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title: 'Default base PR',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.base.ref).toBe('main');
    });

    it('should return 422 when title is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        body: 'Missing title.',
      });
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('title');
    });
  });

  // =========================================================================
  // PATCH /repos/:did/:repo/pulls/:number — update pull request
  // =========================================================================

  describe('PATCH /repos/:did/:repo/pulls/:number', () => {
    it('should update the title of a pull request', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'), 'PATCH', {
        title: 'Add feature X (updated)',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.title).toBe('Add feature X (updated)');
      expect(data.number).toBe(1);
    });

    it('should close a pull request by setting state=closed', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'), 'PATCH', {
        state: 'closed',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('closed');
      expect(data.merged).toBe(false);
    });

    it('should reopen a pull request by setting state=open', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'), 'PATCH', {
        state: 'open',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('open');
    });

    it('should return 404 for non-existent pull number', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999'), 'PATCH', {
        title: 'Nope',
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // PUT /repos/:did/:repo/pulls/:number/merge — merge pull request
  // =========================================================================

  describe('PUT /repos/:did/:repo/pulls/:number/merge', () => {
    it('should merge an open pull request', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/merge'), 'PUT', {});
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.merged).toBe(true);
      expect(data.message).toContain('merged');
    });

    it('should return 405 when trying to merge an already merged pull', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/merge'), 'PUT', {});
      expect(res.status).toBe(405);
      const data = parse(res);
      expect(data.message).toContain('already merged');
    });

    it('should verify the pull is now merged via GET', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('closed');
      expect(data.merged).toBe(true);
      expect(data.merged_at).not.toBeNull();
    });

    it('should return 404 for non-existent pull', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/merge'), 'PUT', {});
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // POST /repos/:did/:repo/pulls/:number/reviews — create review
  // =========================================================================

  describe('POST /repos/:did/:repo/pulls/:number/reviews', () => {
    // Use a pull that was created in the POST /pulls tests (number >= 3).
    // We query to find a valid open pull number first.
    it('should create a review with APPROVE event', async () => {
      // Create a fresh PR to review.
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for review test',
        head  : 'review-branch',
      });
      expect(createRes.status).toBe(201);
      const pr = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body  : 'Ship it!',
        event : 'APPROVE',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('Ship it!');
      expect(data.state).toBe('APPROVED');
      expect(data.user.login).toBe(testDid);
    });

    it('should create a review with REQUEST_CHANGES event', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for changes review',
        head  : 'changes-branch',
      });
      const pr = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body  : 'Needs work.',
        event : 'REQUEST_CHANGES',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.state).toBe('CHANGES_REQUESTED');
    });

    it('should default to COMMENTED when no event is specified', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for comment review',
        head  : 'comment-branch',
      });
      const pr = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body: 'Just a thought.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.state).toBe('COMMENTED');
    });

    it('should return 404 for non-existent pull', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/reviews'), 'POST', {
        body  : 'Should fail.',
        event : 'COMMENT',
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // POST /repos/:did/:repo/releases — create release
  // =========================================================================

  describe('POST /repos/:did/:repo/releases', () => {
    it('should create a release and return 201', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v3.0.0',
        name     : 'Version 3.0.0',
        body     : 'Major release.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.tag_name).toBe('v3.0.0');
      expect(data.name).toBe('Version 3.0.0');
      expect(data.body).toBe('Major release.');
      expect(data.draft).toBe(false);
      expect(data.prerelease).toBe(false);
      expect(data.author.login).toBe(testDid);
    });

    it('should create a prerelease', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name   : 'v4.0.0-alpha',
        name       : 'Alpha',
        body       : 'Alpha build.',
        prerelease : true,
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.tag_name).toBe('v4.0.0-alpha');
      expect(data.prerelease).toBe(true);
    });

    it('should create a draft release', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v5.0.0-draft',
        name     : 'Draft Release',
        draft    : true,
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.draft).toBe(true);
    });

    it('should use tag_name as name when name is omitted', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name: 'v6.0.0',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.name).toBe('v6.0.0');
    });

    it('should return 422 when tag_name is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        name: 'No tag',
      });
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('tag_name');
    });

    it('should be visible in the releases list after creation', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'));
      expect(res.status).toBe(200);
      const data = parse(res);
      const v3 = data.find((r: any) => r.tag_name === 'v3.0.0');
      expect(v3).toBeDefined();
      expect(v3.name).toBe('Version 3.0.0');
    });
  });

  // =========================================================================
  // Method not allowed
  // =========================================================================

  describe('method not allowed', () => {
    it('should return 405 for POST on /repos/:did/:repo', async () => {
      const res = await handleShimRequest(ctx, repoUrl(''), 'POST', {});
      expect(res.status).toBe(405);
    });

    it('should return 405 for DELETE on /repos/:did/:repo/issues', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'DELETE', {});
      expect(res.status).toBe(405);
    });

    it('should return 405 for POST on /users/:did', async () => {
      const res = await handleShimRequest(ctx, url(`/users/${testDid}`), 'POST', {});
      expect(res.status).toBe(405);
    });

    it('should return 405 for GET on /pulls/:number/merge', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/1/merge'), 'GET', {});
      expect(res.status).toBe(405);
    });
  });
});
