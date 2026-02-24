/**
 * Indexer tests — exercises the IndexerStore, IndexerCrawler, and REST
 * API against a real Web5 agent with seeded DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded,
 * then the crawler indexes them and the API is verified.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

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
import { handleApiRequest } from '../src/indexer/api.js';
import { IndexerCrawler } from '../src/indexer/crawler.js';
import { IndexerStore } from '../src/indexer/store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/indexer-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(path: string): URL {
  return new URL(path, 'http://localhost:8090');
}

function parseJson(body: string): any {
  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('dwn-git indexer', () => {
  let ctx: AgentContext;
  let store: IndexerStore;
  let crawler: IndexerCrawler;

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
        metadata  : { name: 'Indexer Test' },
      });
    }

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    const { web5, did } = result;

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
      data : { name: 'awesome-lib', description: 'A great library', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'awesome-lib', visibility: 'public', language: 'TypeScript' },
    });
    const repoContextId = repoRec!.contextId ?? '';

    // 2. Create open issues.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Bug report', body: 'Something broke.', number: 1 },
      tags            : { status: 'open', number: '1' },
      parentContextId : repoContextId,
    });
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Feature request', body: 'Add X.', number: 2 },
      tags            : { status: 'open', number: '2' },
      parentContextId : repoContextId,
    });
    // 3. Create a closed issue.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Fixed.', number: 3 },
      tags            : { status: 'closed', number: '3' },
      parentContextId : repoContextId,
    });

    // 4. Create an open patch.
    await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Fix bug', body: 'Fixes #1.', number: 1 },
      tags            : { status: 'open', baseBranch: 'main', number: '1' },
      parentContextId : repoContextId,
    });

    // 5. Create a release.
    await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v1.0.0', body: 'First release.' },
      tags            : { tagName: 'v1.0.0' },
      parentContextId : repoContextId,
    } as any);

    // 6. Create a star (starring own repo for testing).
    await ctx.social.records.create('star', {
      data : { repoDid: did, repoRecordId: repoRec!.id },
      tags : { repoDid: did, repoRecordId: repoRec!.id },
    });

    // 7. Create a follow (following self for testing).
    await ctx.social.records.create('follow', {
      data : { targetDid: did },
      tags : { targetDid: did },
    });

    store = new IndexerStore();
    crawler = new IndexerCrawler(ctx, store);
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // IndexerStore (unit tests)
  // =========================================================================

  describe('IndexerStore', () => {
    let unitStore: IndexerStore;

    beforeEach(() => {
      unitStore = new IndexerStore();
    });

    it('should manage DIDs', () => {
      unitStore.addDid('did:jwk:a');
      unitStore.addDid('did:jwk:b');
      expect(unitStore.getDids()).toHaveLength(2);
      unitStore.removeDid('did:jwk:a');
      expect(unitStore.getDids()).toHaveLength(1);
    });

    it('should store and retrieve repos', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'test',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'TypeScript', topics        : ['web'], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      expect(unitStore.getRepo('did:jwk:a')).toBeDefined();
      expect(unitStore.getRepo('did:jwk:a')!.name).toBe('test');
      expect(unitStore.getAllRepos()).toHaveLength(1);
    });

    it('should compute star counts', () => {
      unitStore.putStar({
        starrerDid   : 'did:jwk:b', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : new Date().toISOString(),
      });
      unitStore.putStar({
        starrerDid   : 'did:jwk:c', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : new Date().toISOString(),
      });
      expect(unitStore.getStarCount('did:jwk:a', 'r1')).toBe(2);
      expect(unitStore.getStarsForRepo('did:jwk:a', 'r1')).toHaveLength(2);
      expect(unitStore.getStarredByUser('did:jwk:b')).toHaveLength(1);
    });

    it('should remove stars', () => {
      unitStore.putStar({
        starrerDid   : 'did:jwk:b', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : '',
      });
      unitStore.removeStar('did:jwk:b', 'did:jwk:a', 'r1');
      expect(unitStore.getStarCount('did:jwk:a', 'r1')).toBe(0);
    });

    it('should compute follower and following counts', () => {
      unitStore.putFollow({ followerDid: 'did:jwk:a', targetDid: 'did:jwk:b', dateCreated: '' });
      unitStore.putFollow({ followerDid: 'did:jwk:c', targetDid: 'did:jwk:b', dateCreated: '' });
      expect(unitStore.getFollowerCount('did:jwk:b')).toBe(2);
      expect(unitStore.getFollowingCount('did:jwk:a')).toBe(1);
    });

    it('should remove follows', () => {
      unitStore.putFollow({ followerDid: 'did:jwk:a', targetDid: 'did:jwk:b', dateCreated: '' });
      unitStore.removeFollow('did:jwk:a', 'did:jwk:b');
      expect(unitStore.getFollowerCount('did:jwk:b')).toBe(0);
    });

    it('should search repos by name', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'awesome-lib',
        description   : 'A great library', defaultBranch : 'main', visibility    : 'public',
        language      : 'TypeScript', topics        : ['web'], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putRepo({
        did           : 'did:jwk:b', recordId      : 'r2', contextId     : 'c2', name          : 'other-thing',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'Rust', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      const results = unitStore.search('awesome');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('awesome-lib');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should search repos by topic', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'lib',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : ['web', 'framework'], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      const results = unitStore.search('web');
      expect(results).toHaveLength(1);
    });

    it('should search repos by language', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'lib',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'TypeScript', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      const results = unitStore.search('typescript');
      expect(results).toHaveLength(1);
    });

    it('should compute trending repos', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'trending-repo',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      // Add recent stars.
      unitStore.putStar({
        starrerDid   : 'did:jwk:b', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : new Date().toISOString(),
      });
      unitStore.putStar({
        starrerDid   : 'did:jwk:c', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : new Date().toISOString(),
      });

      const trending = unitStore.getTrending(10);
      expect(trending).toHaveLength(1);
      expect(trending[0].name).toBe('trending-repo');
      expect(trending[0].starCount).toBe(2);
    });

    it('should filter repos by language', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'ts-lib',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'TypeScript', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putRepo({
        did           : 'did:jwk:b', recordId      : 'r2', contextId     : 'c2', name          : 'rust-lib',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'Rust', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      expect(unitStore.getReposByLanguage('TypeScript')).toHaveLength(1);
      expect(unitStore.getReposByLanguage('Rust')).toHaveLength(1);
      expect(unitStore.getReposByLanguage('Go')).toHaveLength(0);
    });

    it('should filter repos by topic', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'web-lib',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : ['web', 'http'], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      expect(unitStore.getReposByTopic('web')).toHaveLength(1);
      expect(unitStore.getReposByTopic('cli')).toHaveLength(0);
    });

    it('should build user profiles', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'repo1',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putStar({
        starrerDid   : 'did:jwk:b', repoDid      : 'did:jwk:a',
        repoRecordId : 'r1', dateCreated  : '',
      });
      unitStore.putFollow({
        followerDid: 'did:jwk:c', targetDid: 'did:jwk:a', dateCreated: '',
      });

      const profile = unitStore.getUserProfile('did:jwk:a');
      expect(profile.repoCount).toBe(1);
      expect(profile.starCount).toBe(1);
      expect(profile.followerCount).toBe(1);
    });

    it('should return stats', () => {
      unitStore.addDid('did:jwk:a');
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'x',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      const stats = unitStore.getStats();
      expect(stats.dids).toBeGreaterThanOrEqual(1);
      expect(stats.repos).toBe(1);
    });

    it('should clear all data', () => {
      unitStore.addDid('did:jwk:a');
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'x',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.clear();
      expect(unitStore.getStats().dids).toBe(0);
      expect(unitStore.getStats().repos).toBe(0);
    });

    it('should manage crawl cursors', () => {
      unitStore.setCursor('did:jwk:a', '2025-01-01T00:00:00Z');
      const cursor = unitStore.getCursor('did:jwk:a');
      expect(cursor).toBeDefined();
      expect(cursor!.lastCrawled).toBe('2025-01-01T00:00:00Z');
    });
  });

  // =========================================================================
  // IndexerCrawler (integration with real DWN)
  // =========================================================================

  describe('IndexerCrawler', () => {
    it('should crawl the local DID and index repos', async () => {
      store.clear();
      store.addDid(ctx.did);
      const result = await crawler.crawl();

      expect(result.crawledDids).toBe(1);
      expect(result.newRepos).toBeGreaterThanOrEqual(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should index repo metadata correctly', async () => {
      const repo = store.getRepo(ctx.did);
      expect(repo).toBeDefined();
      expect(repo!.name).toBe('awesome-lib');
      expect(repo!.description).toBe('A great library');
      expect(repo!.visibility).toBe('public');
      expect(repo!.language).toBe('TypeScript');
    });

    it('should count open issues and patches', async () => {
      const repo = store.getRepo(ctx.did);
      expect(repo).toBeDefined();
      expect(repo!.openIssues).toBe(2);
      expect(repo!.openPatches).toBe(1);
    });

    it('should count releases', async () => {
      const repo = store.getRepo(ctx.did);
      expect(repo).toBeDefined();
      expect(repo!.releaseCount).toBe(1);
    });

    it('should index stars', async () => {
      expect(store.getStarCount(ctx.did, store.getRepo(ctx.did)!.recordId)).toBeGreaterThanOrEqual(1);
    });

    it('should index follows', async () => {
      expect(store.getFollowerCount(ctx.did)).toBeGreaterThanOrEqual(1);
    });

    it('should set crawl cursor after crawling', async () => {
      const cursor = store.getCursor(ctx.did);
      expect(cursor).toBeDefined();
      expect(cursor!.lastCrawled).toBeTruthy();
    });

    it('should handle errors gracefully for unreachable DIDs', async () => {
      store.addDid('did:jwk:unreachable');
      const result = await crawler.crawl({ dids: ['did:jwk:unreachable'] });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].did).toBe('did:jwk:unreachable');
    });

    it('should crawl a single DID directly', async () => {
      const counts = await crawler.crawlDid(ctx.did);
      expect(counts.repos).toBeGreaterThanOrEqual(1);
      expect(counts.stars).toBeGreaterThanOrEqual(1);
      expect(counts.follows).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Indexer REST API
  // =========================================================================

  describe('REST API', () => {
    it('GET /api/stats should return indexer statistics', () => {
      const res = handleApiRequest(store, apiUrl('/api/stats'));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.dids).toBeGreaterThanOrEqual(1);
      expect(data.repos).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/repos should list all repos with star counts', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos'));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].name).toBe('awesome-lib');
      expect(data[0].starCount).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/repos?language=TypeScript should filter by language', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos?language=TypeScript'));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].language).toBe('TypeScript');
    });

    it('GET /api/repos/search?q=awesome should search repos', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos/search?q=awesome'));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].name).toContain('awesome');
    });

    it('GET /api/repos/search without q should return 400', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos/search'));
      expect(res.status).toBe(400);
    });

    it('GET /api/repos/trending should return trending repos', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos/trending'));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(Array.isArray(data)).toBe(true);
    });

    it('GET /api/repos/:did should return repo detail', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.name).toBe('awesome-lib');
      expect(data.starCount).toBeGreaterThanOrEqual(1);
      expect(data.openIssues).toBe(2);
    });

    it('GET /api/repos/:did should return 404 for unknown DID', () => {
      const res = handleApiRequest(store, apiUrl('/api/repos/did:jwk:nonexistent'));
      expect(res.status).toBe(404);
    });

    it('GET /api/repos/:did/stars should return star list', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/stars`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.starCount).toBeGreaterThanOrEqual(1);
      expect(data.stars.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/users/:did should return user profile', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.did).toBe(ctx.did);
      expect(data.repoCount).toBeGreaterThanOrEqual(1);
      expect(data.followerCount).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/unknown should return 404', () => {
      const res = handleApiRequest(store, apiUrl('/api/unknown'));
      expect(res.status).toBe(404);
    });
  });
});
