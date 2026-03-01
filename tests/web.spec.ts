/**
 * Web UI route handler tests — exercises `handleRequest()` against a real
 * Enbox agent populated with DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded, and
 * then each test calls `handleRequest()` directly with a constructed URL.
 * No HTTP server is started.
 *
 * URL scheme: `/:did/:repo/...` — the target DID and repo name are
 * embedded in the path, allowing the web UI to view ANY DWN-enabled
 * git repo.  `/:did` shows the repo list for that DID.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';

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
import { handleRequest } from '../src/web/server.js';
import { numericId, shortId } from '../src/github-shim/helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/web-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a URL with the given path, prefixed by the agent's DID. */
let testDid: string;

function url(path: string): URL {
  return new URL(path, 'http://localhost:8080');
}

function didUrl(subPath: string): URL {
  return url(`/${testDid}${subPath}`);
}

/** Build a URL scoped to the test repo: `/:did/test-repo/<subPath>`. */
function repoUrl(subPath: string): URL {
  return url(`/${testDid}/test-repo${subPath}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('gitd web UI', () => {
  let ctx: AgentContext;
  let issueRecId: string;
  let patchRecId: string;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Web UI Test' },
      });
    }

    const enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
    const did = identity.did.uri;
    testDid = did;

    const repo = enbox.using(ForgeRepoProtocol);
    const refs = enbox.using(ForgeRefsProtocol);
    const issues = enbox.using(ForgeIssuesProtocol);
    const patches = enbox.using(ForgePatchesProtocol);
    const ci = enbox.using(ForgeCiProtocol);
    const releases = enbox.using(ForgeReleasesProtocol);
    const registry = enbox.using(ForgeRegistryProtocol);
    const social = enbox.using(ForgeSocialProtocol);
    const notifications = enbox.using(ForgeNotificationsProtocol);
    const wiki = enbox.using(ForgeWikiProtocol);
    const org = enbox.using(ForgeOrgProtocol);

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
      registry, social, notifications, wiki, org, enbox,
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
      data            : { title: 'Fix the widget', body: 'The widget is broken.' },
      tags            : { status: 'open' },
      parentContextId : repoContextId,
    });
    issueRecId = issueRec!.id;

    // 3. Create a comment on the issue.
    await ctx.issues.records.create('repo/issue/comment' as any, {
      data            : { body: 'I can reproduce this.' },
      parentContextId : issueRec!.contextId ?? '',
    } as any);

    // 4. Create a closed issue.
    const { record: _closedIssueRec } = await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Already fixed.' },
      tags            : { status: 'closed' },
      parentContextId : repoContextId,
    });

    // 5. Create an open patch.
    const { record: patchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Add feature X', body: 'Implements feature X.' },
      tags            : { status: 'open', baseBranch: 'main', headBranch: 'feat-x' },
      parentContextId : repoContextId,
    });
    patchRecId = patchRec!.id;

    // 6. Create a review on the patch.
    await ctx.patches.records.create('repo/patch/review' as any, {
      data            : { body: 'Looks good to me.' },
      tags            : { verdict: 'approve' },
      parentContextId : patchRec!.contextId ?? '',
    } as any);

    // 7. Create a release.
    await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v1.0.0', body: 'Initial release.' },
      tags            : { tagName: 'v1.0.0' },
      parentContextId : repoContextId,
    } as any);

    // 8. Create a wiki page.
    await ctx.wiki.records.create('repo/page' as any, {
      data            : '# Getting Started\n\nWelcome to the wiki.',
      dataFormat      : 'text/markdown',
      tags            : { slug: 'getting-started', title: 'Getting Started' },
      parentContextId : repoContextId,
    } as any);
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // Landing page
  // =========================================================================

  describe('GET /', () => {
    it('should return 200 with landing page', async () => {
      const res = await handleRequest(ctx, url('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('gitd');
      expect(res.body).toContain('Browse');
    });

    it('should include the local agent DID as a link', async () => {
      const res = await handleRequest(ctx, url('/'));
      expect(res.body).toContain(ctx.did);
      expect(res.body).toContain(`href="/${ctx.did}"`);
    });
  });

  // =========================================================================
  // Repo list page
  // =========================================================================

  describe('GET /:did (repo list)', () => {
    it('should return 200 with repo list', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('test-repo');
    });

    it('should return 502 for an unresolvable DID', async () => {
      const res = await handleRequest(ctx, url('/did:jwk:unknown/'));
      expect(res.status).toBe(502);
      expect(res.body).toContain('Cannot reach DWN');
      expect(res.body).toContain('did:jwk:unknown');
    });
  });

  // =========================================================================
  // Overview page
  // =========================================================================

  describe('GET /:did/:repo', () => {
    it('should return 200 with repo overview', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('test-repo');
      expect(res.body).toContain('A test repository');
      expect(res.body).toContain('main');
      expect(res.body).toContain('public');
    });

    it('should show issue, patch, and release counts', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Issues');
      expect(res.body).toContain('1 open');
      expect(res.body).toContain('Patches');
      expect(res.body).toContain('Releases');
    });

    it('should display the target DID', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.body).toContain(ctx.did);
    });
  });

  // =========================================================================
  // Issues list
  // =========================================================================

  describe('GET /:did/:repo/issues', () => {
    it('should return 200 with issues list', async () => {
      const res = await handleRequest(ctx, repoUrl('/issues'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Fix the widget');
      expect(res.body).toContain('Old bug');
    });

    it('should show issue IDs as repo-scoped links', async () => {
      const res = await handleRequest(ctx, repoUrl('/issues'));
      const issueNum = numericId(issueRecId);
      expect(res.body).toContain(`href="/${testDid}/test-repo/issues/${issueNum}"`);
      expect(res.body).toContain(shortId(issueRecId));
    });

    it('should show status badges', async () => {
      const res = await handleRequest(ctx, repoUrl('/issues'));
      expect(res.body).toContain('OPEN');
      expect(res.body).toContain('CLOSED');
    });
  });

  // =========================================================================
  // Issue detail
  // =========================================================================

  describe('GET /:did/:repo/issues/:number', () => {
    it('should return 200 with issue detail', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Fix the widget');
      expect(res.body).toContain('The widget is broken.');
    });

    it('should show comments', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(res.body).toContain('I can reproduce this.');
      expect(res.body).toContain('Comments (1)');
    });

    it('should show status badge', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(res.body).toContain('OPEN');
    });

    it('should include repo-scoped back link', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(res.body).toContain(`href="/${testDid}/test-repo/issues"`);
    });

    it('should return 404 for non-existent issue', async () => {
      const res = await handleRequest(ctx, repoUrl('/issues/999'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Issue not found');
    });
  });

  // =========================================================================
  // Patches list
  // =========================================================================

  describe('GET /:did/:repo/patches', () => {
    it('should return 200 with patches list', async () => {
      const res = await handleRequest(ctx, repoUrl('/patches'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Add feature X');
    });

    it('should show branch info', async () => {
      const res = await handleRequest(ctx, repoUrl('/patches'));
      expect(res.body).toContain('main');
      expect(res.body).toContain('feat-x');
    });

    it('should show repo-scoped patch links', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleRequest(ctx, repoUrl('/patches'));
      expect(res.body).toContain(`href="/${testDid}/test-repo/patches/${patchNum}"`);
      expect(res.body).toContain(shortId(patchRecId));
    });
  });

  // =========================================================================
  // Patch detail
  // =========================================================================

  describe('GET /:did/:repo/patches/:number', () => {
    it('should return 200 with patch detail', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleRequest(ctx, repoUrl(`/patches/${patchNum}`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Add feature X');
      expect(res.body).toContain('Implements feature X.');
    });

    it('should show reviews', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleRequest(ctx, repoUrl(`/patches/${patchNum}`));
      expect(res.body).toContain('Looks good to me.');
      expect(res.body).toContain('Reviews (1)');
      expect(res.body).toContain('APPROVE');
    });

    it('should show branch info and status', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleRequest(ctx, repoUrl(`/patches/${patchNum}`));
      expect(res.body).toContain('main');
      expect(res.body).toContain('feat-x');
      expect(res.body).toContain('OPEN');
    });

    it('should include repo-scoped back link', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleRequest(ctx, repoUrl(`/patches/${patchNum}`));
      expect(res.body).toContain(`href="/${testDid}/test-repo/patches"`);
    });

    it('should return 404 for non-existent patch', async () => {
      const res = await handleRequest(ctx, repoUrl('/patches/999'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Patch not found');
    });
  });

  // =========================================================================
  // Releases list
  // =========================================================================

  describe('GET /:did/:repo/releases', () => {
    it('should return 200 with releases list', async () => {
      const res = await handleRequest(ctx, repoUrl('/releases'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('v1.0.0');
      expect(res.body).toContain('Initial release.');
    });

    it('should show release count', async () => {
      const res = await handleRequest(ctx, repoUrl('/releases'));
      expect(res.body).toContain('Releases (1)');
    });
  });

  // =========================================================================
  // Wiki list
  // =========================================================================

  describe('GET /:did/:repo/wiki', () => {
    it('should return 200 with wiki page list', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Getting Started');
    });

    it('should link to wiki page with repo-scoped slug', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki'));
      expect(res.body).toContain(`href="/${testDid}/test-repo/wiki/getting-started"`);
    });

    it('should show page count', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki'));
      expect(res.body).toContain('Wiki (1)');
    });
  });

  // =========================================================================
  // Wiki detail
  // =========================================================================

  describe('GET /:did/:repo/wiki/:slug', () => {
    it('should return 200 with wiki page content', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki/getting-started'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Getting Started');
      expect(res.body).toContain('Welcome to the wiki.');
    });

    it('should include repo-scoped back link', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki/getting-started'));
      expect(res.body).toContain(`href="/${testDid}/test-repo/wiki"`);
    });

    it('should return 404 for non-existent wiki page', async () => {
      const res = await handleRequest(ctx, repoUrl('/wiki/nonexistent'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Wiki page not found');
    });
  });

  // =========================================================================
  // 404 handling
  // =========================================================================

  describe('unknown routes', () => {
    it('should return 404 for paths without a DID prefix', async () => {
      const res = await handleRequest(ctx, url('/nonexistent'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Page not found');
    });

    it('should return 404 for unknown sub-paths under a repo', async () => {
      const res = await handleRequest(ctx, repoUrl('/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-numeric issue IDs', async () => {
      const res = await handleRequest(ctx, repoUrl('/issues/abc'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // HTML structure
  // =========================================================================

  describe('HTML structure', () => {
    it('should include proper HTML document structure', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('<html lang="en">');
      expect(res.body).toContain('</html>');
    });

    it('should include repo-scoped navigation links', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.body).toContain(`href="/${testDid}/test-repo/"`);
      expect(res.body).toContain(`href="/${testDid}/test-repo/issues"`);
      expect(res.body).toContain(`href="/${testDid}/test-repo/patches"`);
      expect(res.body).toContain(`href="/${testDid}/test-repo/releases"`);
      expect(res.body).toContain(`href="/${testDid}/test-repo/wiki"`);
    });

    it('should set page title with repo name', async () => {
      const res = await handleRequest(ctx, repoUrl('/'));
      expect(res.body).toContain('<title>Overview');
      expect(res.body).toContain('test-repo');
      expect(res.body).toContain('gitd</title>');
    });
  });
});
