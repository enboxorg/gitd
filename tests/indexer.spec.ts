/**
 * Indexer tests — exercises the IndexerStore, IndexerCrawler, and REST
 * API against a real Enbox agent with seeded DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded,
 * then the crawler indexes them and the API is verified.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { createTestIdentity } from './helpers/identity.js';
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
import { handleExploreRequest } from '../src/indexer/explore.js';
import { IndexerCrawler } from '../src/indexer/crawler.js';
import { IndexerStore } from '../src/indexer/store.js';
import { handleApiRequest, startApiServer } from '../src/indexer/api.js';

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

function fakeRecord(
  id: string,
  contextId: string,
  data: Record<string, unknown>,
  tags: Record<string, unknown>,
): any {
  return {
    id,
    contextId,
    dateCreated : '2026-06-22T00:00:00.000Z',
    tags,
    data        : {
      json: async () => data,
    },
  };
}

function createExternalSubmissionContext(
  ownerDid: string,
  submitterDid: string,
  repoRecordId: string,
  repoName: string,
): AgentContext {
  const issue = fakeRecord(
    'external-issue-1',
    'external-issue-context',
    { title: 'External bug report', body: 'Reported from another DID.' },
    {
      status  : 'open',
      repoDid : ownerDid,
      repoRecordId,
      repoName,
    },
  );
  const patch = fakeRecord(
    'external-patch-1',
    'external-patch-context',
    { title: 'External patch', body: 'Patch submitted from another DID.' },
    {
      status     : 'open',
      baseBranch : 'main',
      headBranch : 'external/fix',
      sourceDid  : submitterDid,
      repoDid    : ownerDid,
      repoRecordId,
      repoName,
    },
  );

  const emptyQuery = async (): Promise<{ records: any[] }> => ({ records: [] });

  return {
    did    : ownerDid,
    repo   : { records: { query: emptyQuery } },
    refs   : { records: { query: emptyQuery } },
    issues : {
      records: {
        query: async (_path: string, options?: { from?: string }) => ({
          records: options?.from === submitterDid ? [issue] : [],
        }),
      },
    },
    patches: {
      records: {
        query: async (_path: string, options?: { from?: string }) => ({
          records: options?.from === submitterDid ? [patch] : [],
        }),
      },
    },
    ci            : { records: { query: emptyQuery } },
    releases      : { records: { query: emptyQuery } },
    registry      : { records: { query: emptyQuery } },
    social        : { records: { query: emptyQuery } },
    notifications : { records: { query: emptyQuery } },
    wiki          : { records: { query: emptyQuery } },
    org           : { records: { query: emptyQuery } },
    enbox         : {},
  } as unknown as AgentContext;
}

function createSubmissionDecisionContext(
  ownerDid: string,
  repoRecordId: string,
  repoName: string,
): AgentContext {
  const repo = fakeRecord(
    repoRecordId,
    'owner-repo-context',
    { name: repoName, description: '', defaultBranch: 'main' },
    { name: repoName, visibility: 'public' },
  );
  const issueDecision = fakeRecord(
    'issue-decision-1',
    'issue-decision-context',
    {
      kind               : 'issue',
      decision           : 'ignored',
      submitterDid       : 'did:jwk:submitter',
      submissionRecordId : 'external-issue-1',
      reason             : 'not actionable',
      decidedBy          : ownerDid,
      decidedAt          : '2026-06-22T00:00:00.000Z',
    },
    {
      kind               : 'issue',
      decision           : 'ignored',
      submitterDid       : 'did:jwk:submitter',
      submissionRecordId : 'external-issue-1',
    },
  );
  const patchDecision = fakeRecord(
    'patch-decision-1',
    'patch-decision-context',
    {
      kind               : 'patch',
      decision           : 'ignored',
      submitterDid       : 'did:jwk:submitter',
      submissionRecordId : 'external-patch-1',
      reason             : 'out of scope',
      decidedBy          : ownerDid,
      decidedAt          : '2026-06-22T00:00:00.000Z',
    },
    {
      kind               : 'patch',
      decision           : 'ignored',
      submitterDid       : 'did:jwk:submitter',
      submissionRecordId : 'external-patch-1',
    },
  );
  const emptyQuery = async (): Promise<{ records: any[] }> => ({ records: [] });

  return {
    did  : ownerDid,
    repo : {
      records: {
        query: async (path: string) => {
          if (path === 'repo') { return { records: [repo] }; }
          if (path === 'repo/submissionDecision') { return { records: [issueDecision, patchDecision] }; }
          return { records: [] };
        },
      },
    },
    refs          : { records: { query: emptyQuery } },
    issues        : { records: { query: emptyQuery } },
    patches       : { records: { query: emptyQuery } },
    ci            : { records: { query: emptyQuery } },
    releases      : { records: { query: emptyQuery } },
    registry      : { records: { query: emptyQuery } },
    social        : { records: { query: emptyQuery } },
    notifications : { records: { query: emptyQuery } },
    wiki          : { records: { query: emptyQuery } },
    org           : { records: { query: emptyQuery } },
    enbox         : {},
  } as unknown as AgentContext;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('gitd indexer', () => {
  let ctx: AgentContext;
  let store: IndexerStore;
  let crawler: IndexerCrawler;
  let externalDid: string;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await createTestIdentity(agent, 'Indexer Test');
    }

    const enbox = new Enbox({ agent, connectedDid: identity.did.uri });
    const did = identity.did.uri;
    const externalIdentity = await createTestIdentity(agent, 'External Contributor');
    externalDid = externalIdentity.did.uri;

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
      data : { name: 'awesome-lib', description: 'A great library', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'awesome-lib', visibility: 'public', language: 'TypeScript' },
    });
    const repoContextId = repoRec!.contextId ?? '';

    // 1b. Create a second repo under the same DID to verify native
    // DID/repo addressing in the indexer.
    await ctx.repo.records.create('repo', {
      data : { name: 'cli-tool', description: 'A native CLI utility', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'cli-tool', visibility: 'public', language: 'TypeScript' },
    });

    // 2. Create open issues.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Bug report', body: 'Something broke.' },
      tags            : { status: 'open' },
      parentContextId : repoContextId,
    });
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Feature request', body: 'Add X.' },
      tags            : { status: 'open' },
      parentContextId : repoContextId,
    });
    // 3. Create a closed issue.
    await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Fixed.' },
      tags            : { status: 'closed' },
      parentContextId : repoContextId,
    });

    // 4. Create an open patch.
    await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Fix bug', body: 'Fixes #1.' },
      tags            : { status: 'open', baseBranch: 'main' },
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
  }, 30_000);

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

    it('should collect known DIDs from repos, stars, and follows', () => {
      unitStore.putRepo({
        did           : 'did:jwk:repo-owner', recordId      : 'r1', contextId     : 'c1', name          : 'repo',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putStar({
        starrerDid   : 'did:jwk:starrer', repoDid      : 'did:jwk:starred-owner',
        repoRecordId : 'r2', dateCreated  : '',
      });
      unitStore.putFollow({
        followerDid: 'did:jwk:follower', targetDid: 'did:jwk:target', dateCreated: '',
      });

      expect(unitStore.getKnownDids()).toEqual(expect.arrayContaining([
        'did:jwk:repo-owner',
        'did:jwk:starrer',
        'did:jwk:starred-owner',
        'did:jwk:follower',
        'did:jwk:target',
      ]));
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

    it('should retrieve a specific repo by DID and name', () => {
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r1', contextId     : 'c1', name          : 'alpha',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'TypeScript', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putRepo({
        did           : 'did:jwk:a', recordId      : 'r2', contextId     : 'c2', name          : 'beta',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : 'Rust', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });

      expect(unitStore.getRepoByName('did:jwk:a', 'beta')!.recordId).toBe('r2');
      expect(unitStore.getRepoByName('did:jwk:a', 'missing')).toBeUndefined();
    });

    it('should store work item summaries by repo', () => {
      unitStore.putIssue({
        did          : 'did:jwk:a',
        repoRecordId : 'r1',
        repoName     : 'repo',
        recordId     : 'i1',
        contextId    : 'ci1',
        title        : 'Bug report',
        body         : 'Broken.',
        status       : 'open',
        dateCreated  : '2026-01-01T00:00:00Z',
        indexedAt    : '',
      });
      unitStore.putPatch({
        did          : 'did:jwk:a',
        repoRecordId : 'r1',
        repoName     : 'repo',
        recordId     : 'p1',
        contextId    : 'cp1',
        title        : 'Fix bug',
        body         : 'Fix.',
        status       : 'open',
        baseBranch   : 'main',
        headBranch   : 'fix',
        dateCreated  : '2026-01-02T00:00:00Z',
        indexedAt    : '',
      });
      unitStore.putRelease({
        did          : 'did:jwk:a',
        repoRecordId : 'r1',
        repoName     : 'repo',
        recordId     : 'rel1',
        contextId    : 'cr1',
        tagName      : 'v1.0.0',
        name         : 'v1.0.0',
        body         : '',
        draft        : false,
        prerelease   : false,
        dateCreated  : '2026-01-03T00:00:00Z',
        indexedAt    : '',
      });

      expect(unitStore.getIssuesForRepo('did:jwk:a', 'r1')[0].title).toBe('Bug report');
      expect(unitStore.getPatchesForRepo('did:jwk:a', 'r1')[0].title).toBe('Fix bug');
      expect(unitStore.getReleasesForRepo('did:jwk:a', 'r1')[0].tagName).toBe('v1.0.0');
      expect(unitStore.getIssueByRecord('did:jwk:a', 'r1', 'i1')!.body).toBe('Broken.');
      expect(unitStore.getPatchByRecord('did:jwk:a', 'r1', 'p1')!.headBranch).toBe('fix');
      expect(unitStore.getReleaseByRecord('did:jwk:a', 'r1', 'rel1')!.name).toBe('v1.0.0');
    });

    it('should store external issue and patch submissions by target repo', () => {
      unitStore.putIssueSubmission({
        submitterDid       : 'did:jwk:submitter',
        targetDid          : 'did:jwk:owner',
        targetRepoRecordId : 'r1',
        targetRepoName     : 'repo',
        recordId           : 'ext-i1',
        contextId          : 'ci1',
        title              : 'External bug',
        body               : 'From another DID.',
        status             : 'open',
        dateCreated        : '2026-01-04T00:00:00Z',
        indexedAt          : '',
      });
      unitStore.putPatchSubmission({
        submitterDid       : 'did:jwk:submitter',
        targetDid          : 'did:jwk:owner',
        targetRepoRecordId : 'r1',
        targetRepoName     : 'repo',
        sourceDid          : 'did:jwk:submitter',
        recordId           : 'ext-p1',
        contextId          : 'cp1',
        title              : 'External patch',
        body               : 'From another DID.',
        status             : 'open',
        baseBranch         : 'main',
        headBranch         : 'fix',
        dateCreated        : '2026-01-05T00:00:00Z',
        indexedAt          : '',
      });

      const issues = unitStore.getIssueSubmissionsForRepo('did:jwk:owner', 'r1');
      const patches = unitStore.getPatchSubmissionsForRepo('did:jwk:owner', 'r1');
      expect(issues[0].submitterDid).toBe('did:jwk:submitter');
      expect(issues[0].title).toBe('External bug');
      expect(patches[0].sourceDid).toBe('did:jwk:submitter');
      expect(patches[0].headBranch).toBe('fix');
      expect(unitStore.getIssueSubmissionByRecord('did:jwk:owner', 'r1', 'ext-i1')!.body).toBe('From another DID.');
      expect(unitStore.getPatchSubmissionByRecord('did:jwk:owner', 'r1', 'ext-p1')!.headBranch).toBe('fix');
    });

    it('should hide external submissions with owner-side ignore decisions', () => {
      unitStore.putIssueSubmission({
        submitterDid       : 'did:jwk:submitter',
        targetDid          : 'did:jwk:owner',
        targetRepoRecordId : 'r1',
        targetRepoName     : 'repo',
        recordId           : 'ext-i1',
        contextId          : 'ci1',
        title              : 'External bug',
        body               : 'From another DID.',
        status             : 'open',
        dateCreated        : '2026-01-04T00:00:00Z',
        indexedAt          : '',
      });
      unitStore.putPatchSubmission({
        submitterDid       : 'did:jwk:submitter',
        targetDid          : 'did:jwk:owner',
        targetRepoRecordId : 'r1',
        targetRepoName     : 'repo',
        sourceDid          : 'did:jwk:submitter',
        recordId           : 'ext-p1',
        contextId          : 'cp1',
        title              : 'External patch',
        body               : 'From another DID.',
        status             : 'open',
        baseBranch         : 'main',
        headBranch         : 'fix',
        dateCreated        : '2026-01-05T00:00:00Z',
        indexedAt          : '',
      });

      unitStore.putSubmissionDecision({
        ownerDid            : 'did:jwk:owner',
        repoRecordId        : 'r1',
        repoName            : 'repo',
        kind                : 'issue',
        decision            : 'ignored',
        submitterDid        : 'did:jwk:submitter',
        submissionRecordId  : 'ext-i1',
        submissionContextId : 'ci1',
        reason              : 'not actionable',
        dateCreated         : '2026-01-06T00:00:00Z',
        indexedAt           : '',
      });
      unitStore.putSubmissionDecision({
        ownerDid            : 'did:jwk:owner',
        repoRecordId        : 'r1',
        repoName            : 'repo',
        kind                : 'patch',
        decision            : 'ignored',
        submitterDid        : 'did:jwk:submitter',
        submissionRecordId  : 'ext-p1',
        submissionContextId : 'cp1',
        reason              : 'out of scope',
        dateCreated         : '2026-01-06T00:00:00Z',
        indexedAt           : '',
      });

      expect(unitStore.getIssueSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(0);
      expect(unitStore.getPatchSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(0);
      expect(unitStore.getStats().submissionDecisions).toBe(2);
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

      expect(unitStore.getReposForDid('did:jwk:a')).toHaveLength(1);
      expect(unitStore.getStarredReposByUser('did:jwk:b')[0].repo?.name).toBe('repo1');
      expect(unitStore.getFollowersForUser('did:jwk:a')[0].followerDid).toBe('did:jwk:c');
      expect(unitStore.getFollowingForUser('did:jwk:c')[0].targetDid).toBe('did:jwk:a');
    });

    it('should search known users by DID', () => {
      unitStore.putRepo({
        did           : 'did:jwk:alice', recordId      : 'r1', contextId     : 'c1', name          : 'alice-repo',
        description   : '', defaultBranch : 'main', visibility    : 'public',
        language      : '', topics        : [], openIssues    : 0,
        openPatches   : 0, releaseCount  : 0, lastUpdated   : '', indexedAt     : '',
      });
      unitStore.putFollow({
        followerDid: 'did:jwk:bob', targetDid: 'did:jwk:alice', dateCreated: '',
      });

      const results = unitStore.searchUsers('alice');
      expect(results).toHaveLength(1);
      expect(results[0].did).toBe('did:jwk:alice');
      expect(results[0].repoCount).toBe(1);
      expect(results[0].followerCount).toBe(1);
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
      const repo = store.getRepoByName(ctx.did, 'awesome-lib');
      expect(repo).toBeDefined();
      expect(repo!.name).toBe('awesome-lib');
      expect(repo!.description).toBe('A great library');
      expect(repo!.visibility).toBe('public');
      expect(repo!.language).toBe('TypeScript');
    });

    it('should count open issues and patches', async () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib');
      expect(repo).toBeDefined();
      expect(repo!.openIssues).toBe(2);
      expect(repo!.openPatches).toBe(1);
    });

    it('should count releases', async () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib');
      expect(repo).toBeDefined();
      expect(repo!.releaseCount).toBe(1);
    });

    it('should index stars', async () => {
      expect(store.getStarCount(ctx.did, store.getRepoByName(ctx.did, 'awesome-lib')!.recordId)).toBeGreaterThanOrEqual(1);
    });

    it('should index issue, patch, and release summaries', async () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib');
      expect(repo).toBeDefined();
      expect(store.getIssuesForRepo(ctx.did, repo!.recordId).map(issue => issue.title)).toContain('Bug report');
      expect(store.getIssuesForRepo(ctx.did, repo!.recordId).map(issue => issue.status)).toContain('closed');
      expect(store.getPatchesForRepo(ctx.did, repo!.recordId).map(patch => patch.title)).toContain('Fix bug');
      expect(store.getReleasesForRepo(ctx.did, repo!.recordId).map(release => release.tagName)).toContain('v1.0.0');
    });

    it('should index external issue and patch submissions by target repo', async () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib');
      expect(repo).toBeDefined();

      const submissionCrawler = new IndexerCrawler(
        createExternalSubmissionContext(ctx.did, externalDid, repo!.recordId, repo!.name),
        store,
      );
      const result = await submissionCrawler.crawl({ dids: [externalDid] });
      expect(result.crawledDids).toBe(1);
      expect(result.newIssueSubmissions).toBe(1);
      expect(result.newPatchSubmissions).toBe(1);
      expect(result.errors).toHaveLength(0);

      const issues = store.getIssueSubmissionsForRepo(ctx.did, repo!.recordId);
      const patches = store.getPatchSubmissionsForRepo(ctx.did, repo!.recordId);
      expect(issues.map(issue => issue.title)).toContain('External bug report');
      expect(issues[0].submitterDid).toBe(externalDid);
      expect(patches.map(patch => patch.title)).toContain('External patch');
      expect(patches[0].sourceDid).toBe(externalDid);
    });

    it('should index owner-side ignore decisions and filter external submissions', async () => {
      const isolatedStore = new IndexerStore();
      const submissionCrawler = new IndexerCrawler(
        createExternalSubmissionContext('did:jwk:owner', 'did:jwk:submitter', 'r1', 'repo'),
        isolatedStore,
      );
      await submissionCrawler.crawl({ dids: ['did:jwk:submitter'] });
      expect(isolatedStore.getIssueSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(1);
      expect(isolatedStore.getPatchSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(1);

      const decisionCrawler = new IndexerCrawler(
        createSubmissionDecisionContext('did:jwk:owner', 'r1', 'repo'),
        isolatedStore,
      );
      const result = await decisionCrawler.crawl({ dids: ['did:jwk:owner'] });
      expect(result.newSubmissionDecisions).toBe(2);
      expect(isolatedStore.getIssueSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(0);
      expect(isolatedStore.getPatchSubmissionsForRepo('did:jwk:owner', 'r1')).toHaveLength(0);
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

    it('GET /api/repos/:did/:repo should return the named repo detail', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/cli-tool`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.name).toBe('cli-tool');
      expect(data.description).toBe('A native CLI utility');
      expect(data.openIssues).toBe(0);
    });

    it('GET /api/repos/:did/:repo should return 404 for unknown repo name', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/missing-repo`));
      expect(res.status).toBe(404);
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

    it('GET /api/repos/:did/:repo/stars should return stars for the named repo', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/stars`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.repo.name).toBe('awesome-lib');
      expect(data.starCount).toBeGreaterThanOrEqual(1);
      expect(data.stars.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/repos/:did/:repo/issues should return issue summaries', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/issues`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((issue: any) => issue.title)).toContain('Bug report');
      expect(data.map((issue: any) => issue.status)).toContain('closed');
    });

    it('GET /api/repos/:did/:repo/issues/:recordId should return issue detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const issue = store.getIssuesForRepo(ctx.did, repo.recordId).find(item => item.title === 'Bug report')!;
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/issues/${encodeURIComponent(issue.recordId)}`));

      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.title).toBe('Bug report');
      expect(data.body).toBe('Something broke.');
      expect(data.status).toBe('open');
    });

    it('GET /api/repos/:did/:repo/patches should return patch summaries', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/patches`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((patch: any) => patch.title)).toContain('Fix bug');
      expect(data[0].baseBranch).toBe('main');
    });

    it('GET /api/repos/:did/:repo/patches/:recordId should return patch detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const patch = store.getPatchesForRepo(ctx.did, repo.recordId).find(item => item.title === 'Fix bug')!;
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/patches/${encodeURIComponent(patch.recordId)}`));

      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.title).toBe('Fix bug');
      expect(data.body).toBe('Fixes #1.');
      expect(data.baseBranch).toBe('main');
    });

    it('GET /api/repos/:did/:repo/submissions/issues should return external issue submissions', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/submissions/issues`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((issue: any) => issue.title)).toContain('External bug report');
      expect(data[0].submitterDid).toBe(externalDid);
    });

    it('GET /api/repos/:did/:repo/submissions/issues/:recordId should return external issue submission detail', () => {
      const res = handleApiRequest(
        store,
        apiUrl(`/api/repos/${ctx.did}/awesome-lib/submissions/issues/${encodeURIComponent('external-issue-1')}`),
      );
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.title).toBe('External bug report');
      expect(data.body).toBe('Reported from another DID.');
      expect(data.recordId).toBe('external-issue-1');
      expect(data.submitterDid).toBe(externalDid);
    });

    it('GET /api/repos/:did/:repo/submissions/patches should return external patch submissions', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/submissions/patches`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((patch: any) => patch.title)).toContain('External patch');
      expect(data[0].sourceDid).toBe(externalDid);
    });

    it('GET /api/repos/:did/:repo/submissions/patches/:recordId should return external patch submission detail', () => {
      const res = handleApiRequest(
        store,
        apiUrl(`/api/repos/${ctx.did}/awesome-lib/submissions/patches/${encodeURIComponent('external-patch-1')}`),
      );
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.title).toBe('External patch');
      expect(data.body).toBe('Patch submitted from another DID.');
      expect(data.headBranch).toBe('external/fix');
      expect(data.recordId).toBe('external-patch-1');
    });

    it('GET /api/repos/:did/:repo/releases should return release summaries', () => {
      const res = handleApiRequest(store, apiUrl(`/api/repos/${ctx.did}/awesome-lib/releases`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((release: any) => release.tagName)).toContain('v1.0.0');
      expect(data[0].draft).toBe(false);
    });

    it('GET /api/repos/:did/:repo/releases/:recordId should return release detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const release = store.getReleasesForRepo(ctx.did, repo.recordId).find(item => item.tagName === 'v1.0.0')!;
      const res = handleApiRequest(
        store,
        apiUrl(`/api/repos/${ctx.did}/awesome-lib/releases/${encodeURIComponent(release.recordId)}`),
      );

      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.tagName).toBe('v1.0.0');
      expect(data.body).toBe('First release.');
      expect(data.draft).toBe(false);
    });

    it('GET /api/users/:did should return user profile', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.did).toBe(ctx.did);
      expect(data.repoCount).toBeGreaterThanOrEqual(1);
      expect(data.followerCount).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/users/:did/repos should return repos owned by the user', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}/repos`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((repo: any) => repo.name)).toContain('awesome-lib');
      expect(data.map((repo: any) => repo.name)).toContain('cli-tool');
    });

    it('GET /api/users/:did/starred should return repos starred by the user', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}/starred`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].starrerDid).toBe(ctx.did);
      expect(data[0].repo.name).toBe('awesome-lib');
    });

    it('GET /api/users/:did/followers should return user followers', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}/followers`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].targetDid).toBe(ctx.did);
    });

    it('GET /api/users/:did/following should return users followed by the user', () => {
      const res = handleApiRequest(store, apiUrl(`/api/users/${ctx.did}/following`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].followerDid).toBe(ctx.did);
    });

    it('GET /api/users/search?q=<query> should search indexed DIDs', () => {
      const suffix = ctx.did.split(':').at(-1)!.slice(0, 8);
      const res = handleApiRequest(store, apiUrl(`/api/users/search?q=${suffix}`));
      expect(res.status).toBe(200);
      const data = parseJson(res.body);
      expect(data.map((user: any) => user.did)).toContain(ctx.did);
      expect(data[0].score).toBeGreaterThan(0);
    });

    it('GET /api/users/search without q should return 400', () => {
      const res = handleApiRequest(store, apiUrl('/api/users/search'));
      expect(res.status).toBe(400);
    });

    it('GET /api/unknown should return 404', () => {
      const res = handleApiRequest(store, apiUrl('/api/unknown'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Indexer Explore UI
  // =========================================================================

  describe('Explore UI', () => {
    it('GET / should render the native explore page', () => {
      const res = handleExploreRequest(store, apiUrl('/'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('gitd indexer');
      expect(res.body).toContain('Trending');
      expect(res.body).toContain('awesome-lib');
    });

    it('GET /repos?q=awesome should render repository search results', () => {
      const res = handleExploreRequest(store, apiUrl('/repos?q=awesome'));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Repositories');
      expect(res.body).toContain('awesome-lib');
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib`);
    });

    it('GET /repos/:did/:repo should render repository detail', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('gitd clone');
      expect(res.body).toContain(`${ctx.did}/awesome-lib`);
      expect(res.body).toContain('Issues');
      expect(res.body).toContain('Patches');
      expect(res.body).toContain('Bug report');
      expect(res.body).toContain('Fix bug');
      expect(res.body).toContain('v1.0.0');
      expect(res.body).toContain('External Issues');
      expect(res.body).toContain('External Patches');
      expect(res.body).toContain('External bug report');
      expect(res.body).toContain('External patch');
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/issues/`);
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/patches/`);
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/releases/`);
    });

    it('GET /repos/:did/:repo/issues should render issue summaries', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/issues`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Issues');
      expect(res.body).toContain('Bug report');
      expect(res.body).toContain('closed');
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/issues/`);
    });

    it('GET /repos/:did/:repo/issues/:recordId should render issue detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const issue = store.getIssuesForRepo(ctx.did, repo.recordId).find(item => item.title === 'Bug report')!;
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/issues/${encodeURIComponent(issue.recordId)}`));

      expect(res.status).toBe(200);
      expect(res.body).toContain('Bug report');
      expect(res.body).toContain('Something broke.');
      expect(res.body).toContain('open');
    });

    it('GET /repos/:did/:repo/patches should render patch summaries', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/patches`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Patches');
      expect(res.body).toContain('Fix bug');
      expect(res.body).toContain('main');
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/patches/`);
    });

    it('GET /repos/:did/:repo/patches/:recordId should render patch detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const patch = store.getPatchesForRepo(ctx.did, repo.recordId).find(item => item.title === 'Fix bug')!;
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/patches/${encodeURIComponent(patch.recordId)}`));

      expect(res.status).toBe(200);
      expect(res.body).toContain('Fix bug');
      expect(res.body).toContain('Fixes #1.');
      expect(res.body).toContain('main');
    });

    it('GET /repos/:did/:repo/releases should render release summaries', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/releases`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Releases');
      expect(res.body).toContain('v1.0.0');
      expect(res.body).toContain(`/repos/${ctx.did}/awesome-lib/releases/`);
    });

    it('GET /repos/:did/:repo/releases/:recordId should render release detail', () => {
      const repo = store.getRepoByName(ctx.did, 'awesome-lib')!;
      const release = store.getReleasesForRepo(ctx.did, repo.recordId).find(item => item.tagName === 'v1.0.0')!;
      const res = handleExploreRequest(
        store,
        apiUrl(`/repos/${ctx.did}/awesome-lib/releases/${encodeURIComponent(release.recordId)}`),
      );

      expect(res.status).toBe(200);
      expect(res.body).toContain('v1.0.0');
      expect(res.body).toContain('First release.');
      expect(res.body).toContain('published');
    });

    it('GET /repos/:did/:repo/submissions/issues should render external issue submissions', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/submissions/issues`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('External Issues');
      expect(res.body).toContain('External bug report');
      expect(res.body).toContain('/submissions/issues/external-issue-1');
      expect(res.body).toContain(externalDid.slice(0, 18));
    });

    it('GET /repos/:did/:repo/submissions/issues/:recordId should render external issue submission detail', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/submissions/issues/external-issue-1`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('External bug report');
      expect(res.body).toContain('Reported from another DID.');
      expect(res.body).toContain(`gitd issue accept ${externalDid} external-issue-1`);
      expect(res.body).toContain(`gitd issue ignore ${externalDid} external-issue-1`);
    });

    it('GET /repos/:did/:repo/submissions/patches should render external patch submissions', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/submissions/patches`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('External Patches');
      expect(res.body).toContain('External patch');
      expect(res.body).toContain('/submissions/patches/external-patch-1');
      expect(res.body).toContain('external/fix');
    });

    it('GET /repos/:did/:repo/submissions/patches/:recordId should render external patch submission detail', () => {
      const res = handleExploreRequest(store, apiUrl(`/repos/${ctx.did}/awesome-lib/submissions/patches/external-patch-1`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('External patch');
      expect(res.body).toContain('Patch submitted from another DID.');
      expect(res.body).toContain('external/fix');
      expect(res.body).toContain(`gitd pr accept ${externalDid} external-patch-1`);
      expect(res.body).toContain(`gitd pr ignore ${externalDid} external-patch-1`);
    });

    it('GET /users?q=<query> should render user search results', () => {
      const suffix = ctx.did.split(':').at(-1)!.slice(0, 8);
      const res = handleExploreRequest(store, apiUrl(`/users?q=${suffix}`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Users');
      expect(res.body).toContain(ctx.did);
    });

    it('GET /users/:did should render user profile sections', () => {
      const res = handleExploreRequest(store, apiUrl(`/users/${ctx.did}`));
      expect(res.status).toBe(200);
      expect(res.body).toContain('Repositories');
      expect(res.body).toContain('Starred');
      expect(res.body).toContain('Followers');
      expect(res.body).toContain('Following');
    });

    it('GET /missing should return an HTML 404', () => {
      const res = handleExploreRequest(store, apiUrl('/missing'));
      expect(res.status).toBe(404);
      expect(res.body).toContain('Page not found');
    });

    it('startApiServer should serve Explore HTML outside /api', async () => {
      const server = startApiServer({ store, port: 0 });
      await new Promise<void>((resolve) => {
        if (server.listening) {
          resolve();
          return;
        }
        server.once('listening', () => resolve());
      });

      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected TCP server address');
        }

        const res = await fetch(`http://127.0.0.1:${address.port}/repos?q=awesome`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('awesome-lib');
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
      }
    });
  });
});
