/**
 * Web UI route handler tests — exercises `handleRequest()` against a real
 * Web5 agent populated with DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded, and
 * then each test calls `handleRequest()` directly with a constructed URL.
 * No HTTP server is started.
 *
 * URL scheme: `/:did/...` — the target DID is embedded in the path,
 * allowing the web UI to view ANY DWN-enabled git repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('dwn-git web UI', () => {
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
        metadata  : { name: 'Web UI Test' },
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

    // 4. Create a closed issue.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Already fixed.', number: 2 },
      tags            : { status: 'closed', number: '2' },
      parentContextId : repoContextId,
    });

    // 5. Create an open patch.
    const { record: patchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Add feature X', body: 'Implements feature X.', number: 1 },
      tags            : { status: 'open', baseBranch: 'main', headBranch: 'feat-x', number: '1' },
      parentContextId : repoContextId,
    });

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
      expect(res.body).toContain('dwn-git');
      expect(res.body).toContain('Browse');
    });

    it('should include the local agent DID as a link', async () => {
      const res = await handleRequest(ctx, url('/'));
      expect(res.body).toContain(ctx.did);
      expect(res.body).toContain(`href="/${ctx.did}"`);
    });
  });

  // =========================================================================
  // Overview page
  // =========================================================================

  describe('GET /:did', () => {
    it('should return 200 with repo overview', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('test-repo');
      expect(res.body).toContain('A test repository');
      expect(res.body).toContain('main');
      expect(res.body).toContain('public');
    });

    it('should show issue, patch, and release counts', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Issues');
      expect(res.body).toContain('1 open');
      expect(res.body).toContain('Patches');
      expect(res.body).toContain('Releases');
    });

    it('should display the target DID', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.body).toContain(ctx.did);
    });

    it('should return 502 for an unresolvable DID', async () => {
      const res = await handleRequest(ctx, url('/did:jwk:unknown/'));
      expect(res.status).toBe(502);
      expect(res.body).toContain('Cannot reach DWN');
      expect(res.body).toContain('did:jwk:unknown');
    });
  });

  // =========================================================================
  // Issues list
  // =========================================================================

  describe('GET /:did/issues', () => {
    it('should return 200 with issues list', async () => {
      const res = await handleRequest(ctx, didUrl('/issues'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Fix the widget');
      expect(res.body).toContain('Old bug');
    });

    it('should show issue numbers as DID-scoped links', async () => {
      const res = await handleRequest(ctx, didUrl('/issues'));
      expect(res.body).toContain(`href="/${testDid}/issues/1"`);
      expect(res.body).toContain('#1');
      expect(res.body).toContain(`href="/${testDid}/issues/2"`);
      expect(res.body).toContain('#2');
    });

    it('should show status badges', async () => {
      const res = await handleRequest(ctx, didUrl('/issues'));
      expect(res.body).toContain('OPEN');
      expect(res.body).toContain('CLOSED');
    });
  });

  // =========================================================================
  // Issue detail
  // =========================================================================

  describe('GET /:did/issues/:number', () => {
    it('should return 200 with issue detail', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/1'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Fix the widget');
      expect(res.body).toContain('The widget is broken.');
    });

    it('should show comments', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/1'));
      expect(res.body).toContain('I can reproduce this.');
      expect(res.body).toContain('Comments (1)');
    });

    it('should show status badge', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/1'));
      expect(res.body).toContain('OPEN');
    });

    it('should include DID-scoped back link', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/1'));
      expect(res.body).toContain(`href="/${testDid}/issues"`);
    });

    it('should return 404 for non-existent issue', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/999'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Issue not found');
    });
  });

  // =========================================================================
  // Patches list
  // =========================================================================

  describe('GET /:did/patches', () => {
    it('should return 200 with patches list', async () => {
      const res = await handleRequest(ctx, didUrl('/patches'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Add feature X');
    });

    it('should show branch info', async () => {
      const res = await handleRequest(ctx, didUrl('/patches'));
      expect(res.body).toContain('main');
      expect(res.body).toContain('feat-x');
    });

    it('should show DID-scoped patch links', async () => {
      const res = await handleRequest(ctx, didUrl('/patches'));
      expect(res.body).toContain(`href="/${testDid}/patches/1"`);
      expect(res.body).toContain('#1');
    });
  });

  // =========================================================================
  // Patch detail
  // =========================================================================

  describe('GET /:did/patches/:number', () => {
    it('should return 200 with patch detail', async () => {
      const res = await handleRequest(ctx, didUrl('/patches/1'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Add feature X');
      expect(res.body).toContain('Implements feature X.');
    });

    it('should show reviews', async () => {
      const res = await handleRequest(ctx, didUrl('/patches/1'));
      expect(res.body).toContain('Looks good to me.');
      expect(res.body).toContain('Reviews (1)');
      expect(res.body).toContain('APPROVE');
    });

    it('should show branch info and status', async () => {
      const res = await handleRequest(ctx, didUrl('/patches/1'));
      expect(res.body).toContain('main');
      expect(res.body).toContain('feat-x');
      expect(res.body).toContain('OPEN');
    });

    it('should include DID-scoped back link', async () => {
      const res = await handleRequest(ctx, didUrl('/patches/1'));
      expect(res.body).toContain(`href="/${testDid}/patches"`);
    });

    it('should return 404 for non-existent patch', async () => {
      const res = await handleRequest(ctx, didUrl('/patches/999'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Patch not found');
    });
  });

  // =========================================================================
  // Releases list
  // =========================================================================

  describe('GET /:did/releases', () => {
    it('should return 200 with releases list', async () => {
      const res = await handleRequest(ctx, didUrl('/releases'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('v1.0.0');
      expect(res.body).toContain('Initial release.');
    });

    it('should show release count', async () => {
      const res = await handleRequest(ctx, didUrl('/releases'));
      expect(res.body).toContain('Releases (1)');
    });
  });

  // =========================================================================
  // Wiki list
  // =========================================================================

  describe('GET /:did/wiki', () => {
    it('should return 200 with wiki page list', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Getting Started');
    });

    it('should link to wiki page with DID-scoped slug', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki'));
      expect(res.body).toContain(`href="/${testDid}/wiki/getting-started"`);
    });

    it('should show page count', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki'));
      expect(res.body).toContain('Wiki (1)');
    });
  });

  // =========================================================================
  // Wiki detail
  // =========================================================================

  describe('GET /:did/wiki/:slug', () => {
    it('should return 200 with wiki page content', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki/getting-started'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Getting Started');
      expect(res.body).toContain('Welcome to the wiki.');
    });

    it('should include DID-scoped back link', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki/getting-started'));
      expect(res.body).toContain(`href="/${testDid}/wiki"`);
    });

    it('should return 404 for non-existent wiki page', async () => {
      const res = await handleRequest(ctx, didUrl('/wiki/nonexistent'));
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

    it('should return 404 for unknown sub-paths under a DID', async () => {
      const res = await handleRequest(ctx, didUrl('/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-numeric issue IDs', async () => {
      const res = await handleRequest(ctx, didUrl('/issues/abc'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // HTML structure
  // =========================================================================

  describe('HTML structure', () => {
    it('should include proper HTML document structure', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('<html lang="en">');
      expect(res.body).toContain('</html>');
    });

    it('should include DID-scoped navigation links', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.body).toContain(`href="/${testDid}/"`);
      expect(res.body).toContain(`href="/${testDid}/issues"`);
      expect(res.body).toContain(`href="/${testDid}/patches"`);
      expect(res.body).toContain(`href="/${testDid}/releases"`);
      expect(res.body).toContain(`href="/${testDid}/wiki"`);
    });

    it('should set page title with repo name', async () => {
      const res = await handleRequest(ctx, didUrl('/'));
      expect(res.body).toContain('<title>Overview');
      expect(res.body).toContain('test-repo');
      expect(res.body).toContain('dwn-git</title>');
    });
  });
});
