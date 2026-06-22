/**
 * GitHub API compatibility shim tests — exercises `handleShimRequest()`
 * against a real Enbox agent populated with DWN records.
 *
 * The test agent is created once in `beforeAll`, records are seeded, and
 * then each test calls `handleShimRequest()` directly with a constructed
 * URL.  No HTTP server is started.
 *
 * Validates that DWN records are correctly mapped to GitHub REST API v3
 * JSON response shapes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';
import type { JsonResponse } from '../src/github-shim/helpers.js';

import { canMutateIssueMetadata } from '../src/github-shim/issues.js';
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
import { GitBackend } from '../src/git-server/git-backend.js';
import { handleShimRequest } from '../src/github-shim/server.js';
import { numericId } from '../src/github-shim/helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/github-shim-agent';
const REPOS_PATH = '__TESTDATA__/github-shim-repos';
const WORK_PATH = '__TESTDATA__/github-shim-work';
const BASE = 'http://localhost:8181';
const API_CREATED_REPO_NAME = 'api-created-repo';
const CONTRIBUTORS_REPO_NAME = 'contributors-repo';
const EMPTY_REPO_NAME = 'empty-repo';
const CONTENT_WRITE_REPO_NAME = 'zz-content-write-repo';
const FORKED_REPO_NAME = 'forked-test-repo';
const GENERATED_TEMPLATE_REPO_NAME = 'generated-template-repo';
const REPO_DELETE_REPO_NAME = 'repo-delete-target';
const REPO_LIFECYCLE_REPO_NAME = 'repo-lifecycle-target';
const REPO_LIFECYCLE_RENAMED_REPO_NAME = 'repo-lifecycle-renamed';
const TRANSFERRED_REPO_NAME = 'transferred-test-repo';
const MAIN_SHA = '1111111111111111111111111111111111111111';
const FEATURE_SHA = '2222222222222222222222222222222222222222';
const TAG_SHA = '3333333333333333333333333333333333333333';
const MAINTAINER_DID = 'did:jwk:maintainer123';
const TRIAGER_DID = 'did:jwk:triager123';
const NEW_COLLABORATOR_DID = 'did:jwk:newcollab123';
const FOLLOW_TARGET_DID = 'did:jwk:followtarget123';
const FOLLOW_TARGET_TWO_DID = 'did:jwk:followtarget456';
const ORG_MEMBER_DID = 'did:jwk:orgmember123';
const ORG_NAME = 'enbox';
const ORG_API_REPO_NAME = 'org-api-repo';
const ORG_REMOVED_MEMBER_DID = 'did:jwk:orgremoved123';
const ORG_TEAM_MEMBER_DID = 'did:jwk:orgteammember123';
const RELEASE_ASSET_NAME = 'gitd-linux-amd64.tar.gz';
const RELEASE_ASSET_BYTES = Buffer.from('release asset bytes\n', 'utf-8');
const RELEASE_ASSET_DIGEST = `sha256:${createHash('sha256').update(RELEASE_ASSET_BYTES).digest('hex')}`;
const MILESTONE_TITLE = 'v1.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDid: string;
let gitBaseSha: string;
let gitMainSha: string;
let gitTreeSha: string;
let gitReadmeSha: string;

function url(path: string): URL {
  return new URL(path, BASE);
}

function repoUrl(subPath: string): URL {
  return url(`/repos/${testDid}/test-repo${subPath}`);
}

function contentWriteRepoUrl(subPath: string): URL {
  return url(`/repos/${testDid}/${CONTENT_WRITE_REPO_NAME}${subPath}`);
}

function orgUrl(subPath: string): URL {
  return url(`/orgs/${ORG_NAME}${subPath}`);
}

function parse(res: JsonResponse): any {
  const body = typeof res.body === 'string'
    ? res.body
    : Buffer.from(res.body).toString('utf-8');
  return JSON.parse(body);
}

function bodyBuffer(res: JsonResponse): Buffer {
  return typeof res.body === 'string'
    ? Buffer.from(res.body, 'utf-8')
    : Buffer.from(res.body);
}

function shimOptions(): { reposPath: string } {
  return { reposPath: REPOS_PATH };
}

function githubMilestoneNumber(title: string): number {
  return numericId(`milestone:${title.toLocaleLowerCase()}`) || 1;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function seedLocalGitRepo(did: string): Promise<void> {
  const backend = new GitBackend({ basePath: REPOS_PATH });
  const barePath = await backend.initRepo(did, 'test-repo');

  rmSync(WORK_PATH, { recursive: true, force: true });
  git(['clone', barePath, WORK_PATH]);
  git(['config', 'user.email', 'gitd@example.test'], WORK_PATH);
  git(['config', 'user.name', 'Gitd Test'], WORK_PATH);
  git(['checkout', '-b', 'main'], WORK_PATH);

  mkdirSync(`${WORK_PATH}/src`, { recursive: true });
  writeFileSync(`${WORK_PATH}/README.md`, '# Local Git Repo\n\nReadme from local git objects.\n', 'utf-8');
  writeFileSync(`${WORK_PATH}/LICENSE`, 'MIT\n', 'utf-8');
  writeFileSync(`${WORK_PATH}/src/index.ts`, 'export const answer = 42;\n', 'utf-8');

  git(['add', '.'], WORK_PATH);
  git(['commit', '-m', 'Add local git contents'], WORK_PATH);
  gitBaseSha = git(['rev-parse', 'HEAD'], WORK_PATH);

  writeFileSync(`${WORK_PATH}/src/feature.ts`, 'export const feature = "compare";\n', 'utf-8');
  git(['add', 'src/feature.ts'], WORK_PATH);
  git(['commit', '-m', 'Add feature file'], WORK_PATH);
  git(['push', '-u', 'origin', 'main'], WORK_PATH);

  gitMainSha = git(['rev-parse', 'HEAD'], WORK_PATH);
  gitTreeSha = git(['rev-parse', 'HEAD^{tree}'], WORK_PATH);
  gitReadmeSha = git(['rev-parse', 'HEAD:README.md'], WORK_PATH);
}

async function seedContributorGitRepo(did: string): Promise<void> {
  const backend = new GitBackend({ basePath: REPOS_PATH });
  const barePath = await backend.initRepo(did, CONTRIBUTORS_REPO_NAME);

  rmSync(WORK_PATH, { recursive: true, force: true });
  git(['clone', barePath, WORK_PATH]);
  git(['checkout', '-b', 'main'], WORK_PATH);

  git(['config', 'user.email', 'alice@example.test'], WORK_PATH);
  git(['config', 'user.name', 'Alice Author'], WORK_PATH);
  writeFileSync(`${WORK_PATH}/alpha.txt`, 'alpha\n', 'utf-8');
  git(['add', 'alpha.txt'], WORK_PATH);
  git(['commit', '-m', 'Alice first contribution'], WORK_PATH);

  writeFileSync(`${WORK_PATH}/alpha.txt`, 'alpha\nsecond\n', 'utf-8');
  git(['add', 'alpha.txt'], WORK_PATH);
  git(['commit', '-m', 'Alice second contribution'], WORK_PATH);

  git(['config', 'user.email', 'bob@example.test'], WORK_PATH);
  git(['config', 'user.name', 'Bob Builder'], WORK_PATH);
  writeFileSync(`${WORK_PATH}/bob.txt`, 'bob\n', 'utf-8');
  git(['add', 'bob.txt'], WORK_PATH);
  git(['commit', '-m', 'Bob contribution'], WORK_PATH);

  git(['push', '-u', 'origin', 'main'], WORK_PATH);
}

async function seedEmptyGitRepo(did: string): Promise<void> {
  const backend = new GitBackend({ basePath: REPOS_PATH });
  await backend.initRepo(did, EMPTY_REPO_NAME);
}

async function seedContentWriteGitRepo(did: string): Promise<void> {
  const backend = new GitBackend({ basePath: REPOS_PATH });
  const barePath = await backend.initRepo(did, CONTENT_WRITE_REPO_NAME);

  rmSync(WORK_PATH, { recursive: true, force: true });
  git(['clone', barePath, WORK_PATH]);
  git(['config', 'user.email', 'gitd@example.test'], WORK_PATH);
  git(['config', 'user.name', 'Gitd Test'], WORK_PATH);
  git(['checkout', '-b', 'main'], WORK_PATH);

  mkdirSync(`${WORK_PATH}/docs`, { recursive: true });
  writeFileSync(`${WORK_PATH}/README.md`, '# Content Write Fixture\n', 'utf-8');
  writeFileSync(`${WORK_PATH}/docs/README.md`, '# Docs README\n\nDirectory-specific documentation.\n', 'utf-8');
  git(['add', 'README.md'], WORK_PATH);
  git(['add', 'docs/README.md'], WORK_PATH);
  git(['commit', '-m', 'Seed content write fixture'], WORK_PATH);
  git(['push', '-u', 'origin', 'main'], WORK_PATH);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GitHub API compatibility shim', () => {
  let ctx: AgentContext;
  let issueRecId: string;
  let closedIssueRecId: string;
  let issueEventRecId: string;
  let patchRecId: string;
  let mergedPatchRecId: string;
  let reviewRecId: string;
  let reviewCommentRecId: string;
  let releaseRecId: string;
  let releaseAssetRecId: string;
  let checkSuiteRecId: string;
  let checkRunRecId: string;
  let repoRecordId: string;
  let repoContextId: string;

  async function mergeRepoSettings(settings: Record<string, unknown>): Promise<void> {
    const { records } = await ctx.repo.records.query('repo/settings' as any, {
      filter: { contextId: repoContextId },
    });
    if (records.length > 0) {
      const record = records[0] as any;
      const existing = await record.data.json();
      const { status } = await record.update({ data: { ...existing, ...settings } });
      expect(status.code).toBeLessThan(300);
      return;
    }

    const { status } = await ctx.repo.records.create('repo/settings' as any, {
      data            : settings,
      parentContextId : repoContextId,
    } as any);
    expect(status.code).toBeLessThan(300);
  }

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });

    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const did = agent.agentDid.uri;
    const enbox = new Enbox({ agent, connectedDid: did });
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

    await repo.configure({ encryption: true });
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
      tags : { name: 'test-repo', visibility: 'public', language: 'TypeScript' },
    });
    repoRecordId = repoRec!.id;
    repoContextId = repoRec!.contextId ?? '';

    await seedLocalGitRepo(testDid);

    await ctx.repo.records.create('repo', {
      data : { name: CONTRIBUTORS_REPO_NAME, description: 'Contributor fixture repository', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: CONTRIBUTORS_REPO_NAME, visibility: 'public', language: 'Text' },
    });
    await seedContributorGitRepo(testDid);

    await ctx.repo.records.create('repo', {
      data : { name: EMPTY_REPO_NAME, description: 'Empty fixture repository', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: EMPTY_REPO_NAME, visibility: 'public' },
    });
    await seedEmptyGitRepo(testDid);

    await ctx.repo.records.create('repo', {
      data : { name: CONTENT_WRITE_REPO_NAME, description: 'Contents write fixture repository', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: CONTENT_WRITE_REPO_NAME, visibility: 'public', language: 'Markdown' },
    });
    await seedContentWriteGitRepo(testDid);

    // 1a. Create repo metadata files and topics exposed via GitHub metadata endpoints.
    await ctx.repo.records.create('repo/readme' as any, {
      data            : '# Test Repo\n\nReadme from DWN metadata.\n',
      parentContextId : repoContextId,
    } as any);

    await ctx.repo.records.create('repo/license' as any, {
      data            : 'Apache-2.0\n',
      parentContextId : repoContextId,
    } as any);

    await ctx.repo.records.create('repo/topic' as any, {
      data            : { name: 'decentralized' },
      tags            : { name: 'decentralized' },
      parentContextId : repoContextId,
    } as any);

    await ctx.repo.records.create('repo/topic' as any, {
      data            : { name: 'git' },
      tags            : { name: 'git' },
      parentContextId : repoContextId,
    } as any);

    await ctx.repo.records.create('repo/maintainer' as any, {
      data            : { did: MAINTAINER_DID, alias: 'Alice' },
      tags            : { did: MAINTAINER_DID },
      parentContextId : repoContextId,
      recipient       : MAINTAINER_DID,
    } as any);

    await ctx.repo.records.create('repo/triager' as any, {
      data            : { did: TRIAGER_DID, alias: 'Triage Bot' },
      tags            : { did: TRIAGER_DID },
      parentContextId : repoContextId,
      recipient       : TRIAGER_DID,
    } as any);

    // 1b. Create mirrored git refs.
    await ctx.refs.records.create('repo/ref' as any, {
      data            : { name: 'refs/heads/main', target: MAIN_SHA, type: 'branch' },
      tags            : { name: 'refs/heads/main', target: MAIN_SHA, type: 'branch' },
      parentContextId : repoContextId,
    } as any);

    await ctx.refs.records.create('repo/ref' as any, {
      data            : { name: 'refs/heads/feature/demo', target: FEATURE_SHA, type: 'branch' },
      tags            : { name: 'refs/heads/feature/demo', target: FEATURE_SHA, type: 'branch' },
      parentContextId : repoContextId,
    } as any);

    await ctx.refs.records.create('repo/ref' as any, {
      data            : { name: 'refs/tags/v1.0.0', target: TAG_SHA, type: 'tag' },
      tags            : { name: 'refs/tags/v1.0.0', target: TAG_SHA, type: 'tag' },
      parentContextId : repoContextId,
    } as any);

    // 1c. Create social activity records exposed through GitHub activity events.
    await ctx.social.records.create('activity' as any, {
      data: {
        type     : 'push',
        summary  : 'Pushed to main',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
        ref      : 'refs/heads/main',
        head     : MAIN_SHA,
        before   : FEATURE_SHA,
      },
      tags: {
        type     : 'push',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
      },
    } as any);

    await ctx.social.records.create('activity' as any, {
      data: {
        type     : 'star',
        summary  : 'Starred test-repo',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
      },
      tags: {
        type     : 'star',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
      },
    } as any);

    await ctx.social.records.create('activity' as any, {
      data: {
        type     : 'release',
        summary  : 'Private release activity',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
        public   : false,
        tagName  : 'v-private',
      },
      tags: {
        type     : 'release',
        repoDid  : testDid,
        repoRecordId,
        repoName : 'test-repo',
      },
    } as any);

    await ctx.social.records.create('activity' as any, {
      data: {
        type         : 'fork',
        summary      : 'Forked empty-repo',
        repoDid      : testDid,
        repoName     : EMPTY_REPO_NAME,
        repoRecordId : 'empty-repo-record',
      },
      tags: {
        type     : 'fork',
        repoDid  : testDid,
        repoName : EMPTY_REPO_NAME,
      },
    } as any);

    // 1d. Create CI records exposed through status/check endpoints.
    const { record: checkSuiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
      data            : { app: 'gitd-ci', headBranch: 'main' },
      tags            : { commitSha: MAIN_SHA, status: 'completed', conclusion: 'success', branch: 'main' },
      parentContextId : repoContextId,
    } as any);
    checkSuiteRecId = checkSuiteRec!.id;

    const { record: checkRunRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
      data            : { output: { title: 'Lint', summary: 'All clean.' } },
      tags            : { name: 'lint', status: 'completed', conclusion: 'success' },
      parentContextId : checkSuiteRec!.contextId ?? '',
    } as any);
    checkRunRecId = checkRunRec!.id;

    // 2. Create an open issue.
    const { record: issueRec } = await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Fix the widget', body: 'The widget is broken.' },
      tags            : { status: 'open', milestone: MILESTONE_TITLE },
      parentContextId : repoContextId,
    });
    issueRecId = issueRec!.id;

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

    // 5. Create a closed issue with stable repository label fixtures.
    const { record: closedIssueRec } = await ctx.issues.records.create('repo/issue', {
      data            : { title: 'Old bug', body: 'Already fixed.' },
      tags            : { status: 'closed', milestone: MILESTONE_TITLE },
      parentContextId : repoContextId,
    });
    closedIssueRecId = closedIssueRec!.id;

    await ctx.issues.records.create('repo/issue/label' as any, {
      data            : { name: 'bug', color: 'd73a4a', description: 'Bug reports' },
      tags            : { name: 'bug', color: 'd73a4a' },
      parentContextId : closedIssueRec!.contextId ?? '',
    } as any);

    await ctx.issues.records.create('repo/issue/label' as any, {
      data            : { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
      tags            : { name: 'enhancement', color: 'a2eeef' },
      parentContextId : closedIssueRec!.contextId ?? '',
    } as any);

    const { record: closedEventRec } = await ctx.issues.records.create('repo/issue/statusChange' as any, {
      data            : { reason: 'Fixed before import' },
      tags            : { from: 'open', to: 'closed' },
      parentContextId : closedIssueRec!.contextId ?? '',
    } as any);
    issueEventRecId = closedEventRec!.id;

    await ctx.issues.records.create('repo/issue/statusChange' as any, {
      data            : { reason: 'Regression reproduced' },
      tags            : { from: 'closed', to: 'open' },
      parentContextId : closedIssueRec!.contextId ?? '',
    } as any);

    await ctx.issues.records.create('repo/issue/statusChange' as any, {
      data            : { reason: 'Fixed again' },
      tags            : { from: 'open', to: 'closed' },
      parentContextId : closedIssueRec!.contextId ?? '',
    } as any);

    // 6. Create an open patch with a revision.
    const { record: patchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Add feature X', body: 'Implements feature X.' },
      tags            : { status: 'open', baseBranch: 'main', headBranch: 'feat-x', sourceDid: testDid },
      parentContextId : repoContextId,
    });
    patchRecId = patchRec!.id;

    // 6a. Create a revision record with commit and diff stat metadata.
    await ctx.patches.records.create('repo/patch/revision' as any, {
      data: {
        description : 'v1: 3 commits',
        diffStat    : { additions: 42, deletions: 7, filesChanged: 5 },
      },
      tags: {
        headCommit  : 'abc1234567890abcdef1234567890abcdef12345',
        baseCommit  : 'def0987654321fedcba0987654321fedcba09876',
        commitCount : 3,
      },
      parentContextId: patchRec!.contextId ?? '',
    } as any);

    // 7. Create a review on the patch.
    const { record: approveReviewRec } = await ctx.patches.records.create('repo/patch/review' as any, {
      data            : { body: 'Looks good to me.' },
      tags            : { verdict: 'approve' },
      parentContextId : patchRec!.contextId ?? '',
    } as any);
    reviewRecId = approveReviewRec!.id;

    // 7a. Create an inline review comment.
    const { record: reviewCommentRec } = await ctx.patches.records.create('repo/patch/review/reviewComment' as any, {
      data            : { body: 'Please keep this helper small.', diffHunk: '@@ -1 +1 @@' },
      tags            : { path: 'src/widget.ts', line: 12, side: 'right', commitId: 'abc1234567890abcdef1234567890abcdef12345' },
      parentContextId : approveReviewRec!.contextId ?? '',
    } as any);
    reviewCommentRecId = reviewCommentRec!.id;

    // 8. Create a second review.
    await ctx.patches.records.create('repo/patch/review' as any, {
      data            : { body: 'One nit.' },
      tags            : { verdict: 'comment' },
      parentContextId : patchRec!.contextId ?? '',
    } as any);

    // 9. Create a merged patch with a merge result.
    const { record: mergedPatchRec } = await ctx.patches.records.create('repo/patch', {
      data            : { title: 'Fix typo', body: 'Fixed a typo in README.' },
      tags            : { status: 'merged', baseBranch: 'main', headBranch: 'fix-typo' },
      parentContextId : repoContextId,
    });
    mergedPatchRecId = mergedPatchRec!.id;

    // 9a. Create a merge result with commit SHA.
    await ctx.patches.records.create('repo/patch/mergeResult' as any, {
      data            : { mergedBy: testDid },
      tags            : { mergeCommit: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00', strategy: 'squash' },
      parentContextId : mergedPatchRec!.contextId ?? '',
    } as any);

    // 10. Create a release.
    const { record: stableReleaseRec } = await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v1.0.0', body: 'Initial release.' },
      tags            : { tagName: 'v1.0.0' },
      parentContextId : repoContextId,
    } as any);
    releaseRecId = stableReleaseRec!.id;

    // 10a. Create an immutable release asset.
    const { record: stableAssetRec } = await ctx.releases.records.create('repo/release/asset' as any, {
      data            : new Uint8Array(RELEASE_ASSET_BYTES),
      dataFormat      : 'application/gzip',
      tags            : { filename: RELEASE_ASSET_NAME, contentType: 'application/gzip', size: RELEASE_ASSET_BYTES.byteLength },
      parentContextId : stableReleaseRec!.contextId,
    } as any);
    releaseAssetRecId = stableAssetRec!.id;

    // 11. Create a pre-release.
    await ctx.releases.records.create('repo/release' as any, {
      data            : { name: 'v2.0.0-beta', body: 'Beta release.' },
      tags            : { tagName: 'v2.0.0-beta', prerelease: true },
      parentContextId : repoContextId,
    } as any);

    // 12. Create organization, membership, and team fixtures.
    const { record: orgRec } = await ctx.org.records.create('org', {
      data: {
        name        : ORG_NAME,
        description : 'Decentralized forge organization',
        homepage    : 'https://enbox.org',
        avatar      : 'https://enbox.org/avatar.png',
      },
    });
    const orgContextId = orgRec!.contextId ?? '';

    await ctx.org.records.create('org/owner' as any, {
      data            : { did: testDid, alias: 'Local Owner' },
      tags            : { did: testDid },
      parentContextId : orgContextId,
      recipient       : testDid,
    } as any);

    await ctx.org.records.create('org/member' as any, {
      data            : { did: ORG_MEMBER_DID, alias: 'Org Member' },
      tags            : { did: ORG_MEMBER_DID },
      parentContextId : orgContextId,
      recipient       : ORG_MEMBER_DID,
    } as any);

    await ctx.org.records.create('org/member' as any, {
      data            : { did: ORG_REMOVED_MEMBER_DID, alias: 'Removed Member' },
      tags            : { did: ORG_REMOVED_MEMBER_DID },
      parentContextId : orgContextId,
      recipient       : ORG_REMOVED_MEMBER_DID,
    } as any);

    const { record: teamRec } = await ctx.org.records.create('org/team' as any, {
      data            : { name: 'Core Team', description: 'Core maintainers', privacy: 'visible' },
      parentContextId : orgContextId,
    } as any);
    const teamContextId = teamRec!.contextId ?? '';

    await ctx.org.records.create('org/team/teamMember' as any, {
      data            : { did: ORG_MEMBER_DID, alias: 'Org Member' },
      tags            : { did: ORG_MEMBER_DID },
      parentContextId : teamContextId,
      recipient       : ORG_MEMBER_DID,
    } as any);
  }, 30_000);

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
    rmSync(WORK_PATH, { recursive: true, force: true });
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
  // Global GitHub utility endpoints
  // =========================================================================

  describe('global utility endpoints', () => {
    it('should expose GitHub API root links, metadata, versions, zen, and rate limits', async () => {
      const rootRes = await handleShimRequest(ctx, url('/'));
      expect(rootRes.status).toBe(200);
      const root = parse(rootRes);
      expect(root.current_user_url).toBe(`${BASE}/user`);
      expect(root.repository_url).toBe(`${BASE}/repos/{owner}/{repo}`);
      expect(root.rate_limit_url).toBe(`${BASE}/rate_limit`);

      const metaRes = await handleShimRequest(ctx, url('/meta'));
      expect(metaRes.status).toBe(200);
      const meta = parse(metaRes);
      expect(meta.verifiable_password_authentication).toBe(false);
      expect(meta.domains.api).toEqual(['localhost:8181']);

      const versionsRes = await handleShimRequest(ctx, url('/versions'));
      expect(versionsRes.status).toBe(200);
      expect(parse(versionsRes)).toContain('2026-03-10');

      const zenRes = await handleShimRequest(ctx, url('/zen'));
      expect(zenRes.status).toBe(200);
      expect(zenRes.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(zenRes.body).toContain('decentralization');

      const rateRes = await handleShimRequest(ctx, url('/rate_limit'));
      expect(rateRes.status).toBe(200);
      const rate = parse(rateRes);
      expect(rate.resources.core.limit).toBe(5000);
      expect(rate.rate).toEqual(rate.resources.core);
    });

    it('should return a GitHub-compatible emoji map', async () => {
      const res = await handleShimRequest(ctx, url('/emojis'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data['+1']).toContain('/1f44d.png');
      expect(data.rocket).toContain('/1f680.png');
    });

    it('should list and return gitignore templates', async () => {
      const listRes = await handleShimRequest(ctx, url('/gitignore/templates'));
      expect(listRes.status).toBe(200);
      expect(parse(listRes)).toContain('Node');

      const templateRes = await handleShimRequest(ctx, url('/gitignore/templates/Node'));
      expect(templateRes.status).toBe(200);
      const template = parse(templateRes);
      expect(template.name).toBe('Node');
      expect(template.source).toContain('node_modules/');

      const missingRes = await handleShimRequest(ctx, url('/gitignore/templates/Missing'));
      expect(missingRes.status).toBe(404);
    });

    it('should list and return license templates', async () => {
      const listRes = await handleShimRequest(ctx, url('/licenses'));
      expect(listRes.status).toBe(200);
      const licenses = parse(listRes);
      expect(licenses.some((license: any) => license.key === 'mit')).toBe(true);

      const licenseRes = await handleShimRequest(ctx, url('/licenses/mit'));
      expect(licenseRes.status).toBe(200);
      const license = parse(licenseRes);
      expect(license.key).toBe('mit');
      expect(license.spdx_id).toBe('MIT');
      expect(license.body).toContain('Permission is hereby granted');

      const missingRes = await handleShimRequest(ctx, url('/licenses/missing'));
      expect(missingRes.status).toBe(404);
    });

    it('should render Markdown JSON requests as HTML', async () => {
      const res = await handleShimRequest(ctx, url('/markdown'), 'POST', {
        text : 'Hello **world**',
        mode : 'gfm',
      });
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(res.body).toBe('<p>Hello <strong>world</strong></p>');

      const invalidRes = await handleShimRequest(ctx, url('/markdown'), 'POST', {
        mode: 'gfm',
      });
      expect(invalidRes.status).toBe(422);
    });

    it('should render raw Markdown body requests as HTML', async () => {
      const raw = Buffer.from('# Release Notes\n\n- Add **asset** upload\n', 'utf-8');
      const res = await handleShimRequest(ctx, url('/markdown/raw'), 'POST', {}, null, {
        rawBody     : raw,
        contentType : 'text/plain',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('<h1>Release Notes</h1>');
      expect(res.body).toContain('<li>Add <strong>asset</strong> upload</li>');
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
      expect(data.language).toBe('TypeScript');
      expect(data.topics).toEqual(['decentralized', 'git']);
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
  // Repository listing and creation endpoints
  // =========================================================================

  describe('repository listing and creation endpoints', () => {
    it('should list repositories for the authenticated user with pagination', async () => {
      const res = await handleShimRequest(ctx, url('/user/repos?sort=full_name&per_page=2'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((repo: any) => repo.name)).toEqual([CONTRIBUTORS_REPO_NAME, EMPTY_REPO_NAME]);
      expect(res.headers.Link).toContain('rel="next"');
      expect(data[0].owner.login).toBe(testDid);
    });

    it('should list repositories for a user DID', async () => {
      const res = await handleShimRequest(ctx, url(`/users/${testDid}/repos?type=owner`));
      expect(res.status).toBe(200);
      const names = parse(res).map((repo: any) => repo.name);
      expect(names).toContain('test-repo');
      expect(names).toContain(CONTRIBUTORS_REPO_NAME);
      expect(names).toContain(EMPTY_REPO_NAME);
    });

    it('should list repositories for an organization route', async () => {
      const res = await handleShimRequest(ctx, orgUrl('/repos?type=public&sort=created&direction=asc'));
      expect(res.status).toBe(200);
      const names = parse(res).map((repo: any) => repo.name);
      expect(names).toContain('test-repo');
      expect(names).toContain(CONTRIBUTORS_REPO_NAME);

      const missing = await handleShimRequest(ctx, url('/orgs/missing-org/repos'));
      expect(missing.status).toBe(404);
    });

    it('should list public repositories through the global repository feed', async () => {
      const firstPage = await handleShimRequest(ctx, url('/repositories?per_page=2'));
      expect(firstPage.status).toBe(200);
      const pageRepos = parse(firstPage);
      expect(pageRepos.map((repo: any) => repo.name)).toEqual(['test-repo', CONTRIBUTORS_REPO_NAME]);
      expect(pageRepos.every((repo: any) => repo.private === false)).toBe(true);
      expect(firstPage.headers.Link).toContain('/repositories?per_page=2&since=');
      expect(firstPage.headers.Link).toContain('rel="next"');

      const allRepos = parse(await handleShimRequest(ctx, url('/repositories?per_page=100')));
      expect(allRepos.map((repo: any) => repo.name)).toContain(EMPTY_REPO_NAME);
      expect(allRepos.map((repo: any) => repo.name)).toContain(CONTENT_WRITE_REPO_NAME);

      const maxRepoId = Math.max(...allRepos.map((repo: any) => repo.id));
      const afterMax = await handleShimRequest(ctx, url(`/repositories?since=${maxRepoId}`));
      expect(afterMax.status).toBe(200);
      expect(parse(afterMax)).toEqual([]);

      const invalidSince = await handleShimRequest(ctx, url('/repositories?since=not-a-number'));
      expect(invalidSince.status).toBe(422);
    });

    it('should create a repository for the authenticated user', async () => {
      const res = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name           : API_CREATED_REPO_NAME,
        description    : 'Created through the GitHub API shim',
        private        : true,
        default_branch : 'develop',
      }, null, shimOptions());
      expect(res.status).toBe(201);
      const created = parse(res);
      expect(created.name).toBe(API_CREATED_REPO_NAME);
      expect(created.private).toBe(true);
      expect(created.visibility).toBe('private');
      expect(created.default_branch).toBe('develop');

      const fetched = await handleShimRequest(ctx, url(`/repos/${testDid}/${API_CREATED_REPO_NAME}`));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).description).toBe('Created through the GitHub API shim');
    });

    it('should create a repository through an organization route', async () => {
      const res = await handleShimRequest(ctx, orgUrl('/repos'), 'POST', {
        name        : ORG_API_REPO_NAME,
        description : 'Organization route repository',
        homepage    : 'https://enbox.org/repos/org-api-repo',
        visibility  : 'public',
      }, null, shimOptions());
      expect(res.status).toBe(201);
      const created = parse(res);
      expect(created.name).toBe(ORG_API_REPO_NAME);
      expect(created.homepage).toBe('https://enbox.org/repos/org-api-repo');
      expect(created.visibility).toBe('public');

      const list = parse(await handleShimRequest(ctx, orgUrl('/repos?type=public')));
      expect(list.map((repo: any) => repo.name)).toContain(ORG_API_REPO_NAME);
    });

    it('should generate a repository from a template repository', async () => {
      const markTemplate = await handleShimRequest(ctx, repoUrl(''), 'PATCH', {
        is_template: true,
      }, null, shimOptions());
      expect(markTemplate.status).toBe(200);
      expect(parse(markTemplate).is_template).toBe(true);

      const generate = await handleShimRequest(ctx, repoUrl('/generate'), 'POST', {
        name                 : GENERATED_TEMPLATE_REPO_NAME,
        description          : 'Generated from test-repo template',
        include_all_branches : false,
        private              : true,
      }, null, shimOptions());
      expect(generate.status).toBe(201);
      const generated = parse(generate);
      expect(generated.name).toBe(GENERATED_TEMPLATE_REPO_NAME);
      expect(generated.full_name).toBe(`${testDid}/${GENERATED_TEMPLATE_REPO_NAME}`);
      expect(generated.private).toBe(true);
      expect(generated.description).toBe('Generated from test-repo template');
      expect(generated.is_template).toBe(false);
      expect(generated.template_repository.name).toBe('test-repo');
      expect(generated.template_repository.is_template).toBe(true);

      const backend = new GitBackend({ basePath: REPOS_PATH });
      expect(backend.exists(testDid, GENERATED_TEMPLATE_REPO_NAME)).toBe(true);

      const readme = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${GENERATED_TEMPLATE_REPO_NAME}/contents/README.md`),
        'GET',
        {},
        null,
        shimOptions(),
      );
      expect(readme.status).toBe(200);
      expect(Buffer.from(parse(readme).content, 'base64').toString('utf-8')).toContain('Local Git Repo');

      const duplicate = await handleShimRequest(ctx, repoUrl('/generate'), 'POST', {
        name: GENERATED_TEMPLATE_REPO_NAME,
      }, null, shimOptions());
      expect(duplicate.status).toBe(422);

      const missingName = await handleShimRequest(ctx, repoUrl('/generate'), 'POST', {}, null, shimOptions());
      expect(missingName.status).toBe(422);

      const remoteOwner = await handleShimRequest(ctx, repoUrl('/generate'), 'POST', {
        name  : 'remote-template-target',
        owner : 'did:jwk:remoteowner',
      }, null, shimOptions());
      expect(remoteOwner.status).toBe(422);

      const nonTemplate = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}/generate`), 'POST', {
        name: 'from-non-template',
      }, null, shimOptions());
      expect(nonTemplate.status).toBe(422);
    });

    it('should reject invalid or duplicate repository create payloads', async () => {
      const invalidName = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name: '../bad',
      });
      expect(invalidName.status).toBe(422);

      const invalidVisibility = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name       : 'invalid-visibility-repo',
        visibility : 'internal',
      });
      expect(invalidVisibility.status).toBe(422);

      const duplicate = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name: API_CREATED_REPO_NAME,
      });
      expect(duplicate.status).toBe(422);
    });
  });

  // =========================================================================
  // Repository lifecycle endpoints
  // =========================================================================

  describe('repository lifecycle endpoints', () => {
    it('should update repository metadata and rename local storage', async () => {
      const create = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name        : REPO_LIFECYCLE_REPO_NAME,
        description : 'Lifecycle target',
      }, null, shimOptions());
      expect(create.status).toBe(201);

      const update = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_LIFECYCLE_REPO_NAME}`), 'PATCH', {
        allow_auto_merge             : true,
        allow_forking                : false,
        allow_merge_commit           : false,
        allow_rebase_merge           : false,
        allow_squash_merge           : false,
        archived                     : true,
        default_branch               : 'trunk',
        delete_branch_on_merge       : true,
        description                  : 'Updated through PATCH /repos',
        has_downloads                : false,
        has_issues                   : false,
        has_projects                 : true,
        has_pull_requests            : false,
        has_wiki                     : false,
        homepage                     : 'https://enbox.org/repos/repo-lifecycle-renamed',
        is_template                  : true,
        name                         : REPO_LIFECYCLE_RENAMED_REPO_NAME,
        private                      : false,
        pull_request_creation_policy : 'collaborators_only',
        web_commit_signoff_required  : true,
      }, null, shimOptions());
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.name).toBe(REPO_LIFECYCLE_RENAMED_REPO_NAME);
      expect(updated.full_name).toBe(`${testDid}/${REPO_LIFECYCLE_RENAMED_REPO_NAME}`);
      expect(updated.description).toBe('Updated through PATCH /repos');
      expect(updated.homepage).toBe('https://enbox.org/repos/repo-lifecycle-renamed');
      expect(updated.private).toBe(false);
      expect(updated.visibility).toBe('public');
      expect(updated.default_branch).toBe('trunk');
      expect(updated.archived).toBe(true);
      expect(updated.has_issues).toBe(false);
      expect(updated.has_projects).toBe(true);
      expect(updated.has_wiki).toBe(false);
      expect(updated.has_downloads).toBe(false);
      expect(updated.has_pull_requests).toBe(false);
      expect(updated.is_template).toBe(true);
      expect(updated.allow_squash_merge).toBe(false);
      expect(updated.allow_merge_commit).toBe(false);
      expect(updated.allow_rebase_merge).toBe(false);
      expect(updated.allow_auto_merge).toBe(true);
      expect(updated.allow_forking).toBe(false);
      expect(updated.delete_branch_on_merge).toBe(true);
      expect(updated.pull_request_creation_policy).toBe('collaborators_only');
      expect(updated.web_commit_signoff_required).toBe(true);

      const oldRoute = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_LIFECYCLE_REPO_NAME}`));
      expect(oldRoute.status).toBe(404);

      const fetched = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_LIFECYCLE_RENAMED_REPO_NAME}`));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).description).toBe('Updated through PATCH /repos');

      const backend = new GitBackend({ basePath: REPOS_PATH });
      expect(backend.exists(testDid, REPO_LIFECYCLE_REPO_NAME)).toBe(false);
      expect(backend.exists(testDid, REPO_LIFECYCLE_RENAMED_REPO_NAME)).toBe(true);
    });

    it('should reject invalid repository update requests', async () => {
      const invalidName = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}`), 'PATCH', {
        name: '../bad',
      });
      expect(invalidName.status).toBe(422);

      const invalidVisibility = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}`), 'PATCH', {
        visibility: 'internal',
      });
      expect(invalidVisibility.status).toBe(422);

      const invalidBoolean = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}`), 'PATCH', {
        has_issues: 'yes',
      });
      expect(invalidBoolean.status).toBe(422);

      const invalidPolicy = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}`), 'PATCH', {
        pull_request_creation_policy: 'owners_only',
      });
      expect(invalidPolicy.status).toBe(422);

      const duplicateName = await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}`), 'PATCH', {
        name: 'test-repo',
      });
      expect(duplicateName.status).toBe(422);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo`), 'PATCH', {
        description: 'Missing',
      });
      expect(missingRepo.status).toBe(404);
    });

    it('should request repository transfer asynchronously', async () => {
      const transfer = await handleShimRequest(ctx, repoUrl('/transfer'), 'POST', {
        new_owner : ORG_NAME,
        new_name  : TRANSFERRED_REPO_NAME,
        team_ids  : [12, 345],
      });
      expect(transfer.status).toBe(202);
      const transferred = parse(transfer);
      expect(transferred.name).toBe('test-repo');
      expect(transferred.full_name).toBe(`${testDid}/test-repo`);
      expect(transferred.owner.login).toBe(testDid);
      expect(transferred.transfer_request.new_owner).toBe(ORG_NAME);
      expect(transferred.transfer_request.new_name).toBe(TRANSFERRED_REPO_NAME);
      expect(transferred.transfer_request.team_ids).toEqual([12, 345]);
      expect(transferred.transfer_request.requested_by).toBe(testDid);

      const fetched = await handleShimRequest(ctx, repoUrl(''));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).full_name).toBe(`${testDid}/test-repo`);

      const { records } = await ctx.repo.records.query('repo/settings' as any, {
        filter: { contextId: repoContextId },
      });
      const settings = await (records[0] as any).data.json();
      expect(settings.transferRequest.newOwner).toBe(ORG_NAME);
      expect(settings.transferRequest.newName).toBe(TRANSFERRED_REPO_NAME);
      expect(settings.transferRequest.teamIds).toEqual([12, 345]);

      const missingOwner = await handleShimRequest(ctx, repoUrl('/transfer'), 'POST', {});
      expect(missingOwner.status).toBe(422);

      const invalidName = await handleShimRequest(ctx, repoUrl('/transfer'), 'POST', {
        new_owner : ORG_NAME,
        new_name  : '../bad',
      });
      expect(invalidName.status).toBe(422);

      const invalidTeamIds = await handleShimRequest(ctx, repoUrl('/transfer'), 'POST', {
        new_owner : ORG_NAME,
        team_ids  : [0],
      });
      expect(invalidTeamIds.status).toBe(422);

      const personalTeamIds = await handleShimRequest(ctx, repoUrl('/transfer'), 'POST', {
        new_owner : FOLLOW_TARGET_DID,
        team_ids  : [12],
      });
      expect(personalTeamIds.status).toBe(422);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/transfer`), 'POST', {
        new_owner: ORG_NAME,
      });
      expect(missingRepo.status).toBe(404);
    });

    it('should delete repository metadata and local storage', async () => {
      const create = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name: REPO_DELETE_REPO_NAME,
      }, null, shimOptions());
      expect(create.status).toBe(201);

      const backend = new GitBackend({ basePath: REPOS_PATH });
      expect(backend.exists(testDid, REPO_DELETE_REPO_NAME)).toBe(true);

      const deleted = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_DELETE_REPO_NAME}`), 'DELETE', {}, null, shimOptions());
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');
      expect(backend.exists(testDid, REPO_DELETE_REPO_NAME)).toBe(false);

      const fetched = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_DELETE_REPO_NAME}`));
      expect(fetched.status).toBe(404);

      const duplicateDelete = await handleShimRequest(ctx, url(`/repos/${testDid}/${REPO_DELETE_REPO_NAME}`), 'DELETE', {}, null, shimOptions());
      expect(duplicateDelete.status).toBe(404);
    });
  });

  // =========================================================================
  // Repository fork endpoints
  // =========================================================================

  describe('repository fork endpoints', () => {
    it('should create and list repository forks', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/forks'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const create = await handleShimRequest(ctx, repoUrl('/forks'), 'POST', {
        default_branch_only : true,
        name                : FORKED_REPO_NAME,
      }, null, shimOptions());
      expect(create.status).toBe(202);
      const fork = parse(create);
      expect(fork.name).toBe(FORKED_REPO_NAME);
      expect(fork.fork).toBe(true);
      expect(fork.parent.full_name).toBe(`${testDid}/test-repo`);
      expect(fork.source.full_name).toBe(`${testDid}/test-repo`);

      const list = await handleShimRequest(ctx, repoUrl('/forks?sort=oldest'));
      expect(list.status).toBe(200);
      const forks = parse(list);
      expect(forks.map((repo: any) => repo.name)).toContain(FORKED_REPO_NAME);

      const fetched = await handleShimRequest(ctx, url(`/repos/${testDid}/${FORKED_REPO_NAME}`));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).fork).toBe(true);

      const forkRepos = parse(await handleShimRequest(ctx, url('/user/repos?type=forks')));
      expect(forkRepos.map((repo: any) => repo.name)).toContain(FORKED_REPO_NAME);

      const sourceRepos = parse(await handleShimRequest(ctx, url('/user/repos?type=sources')));
      expect(sourceRepos.map((repo: any) => repo.name)).not.toContain(FORKED_REPO_NAME);

      const copiedReadme = await handleShimRequest(
        ctx, url(`/repos/${testDid}/${FORKED_REPO_NAME}/contents/README.md?ref=main`), 'GET', {}, null, shimOptions(),
      );
      expect(copiedReadme.status).toBe(200);
      expect(parse(copiedReadme).name).toBe('README.md');
    });

    it('should reject invalid repository fork requests', async () => {
      const invalidName = await handleShimRequest(ctx, repoUrl('/forks'), 'POST', {
        name: '../bad',
      });
      expect(invalidName.status).toBe(422);

      const invalidDefaultBranchOnly = await handleShimRequest(ctx, repoUrl('/forks'), 'POST', {
        default_branch_only : 'yes',
        name                : 'fork-invalid-default-branch-only',
      });
      expect(invalidDefaultBranchOnly.status).toBe(422);

      const unsupportedOrg = await handleShimRequest(ctx, repoUrl('/forks'), 'POST', {
        organization : ORG_NAME,
        name         : 'org-fork',
      });
      expect(unsupportedOrg.status).toBe(422);

      const duplicate = await handleShimRequest(ctx, repoUrl('/forks'), 'POST', {
        name: FORKED_REPO_NAME,
      });
      expect(duplicate.status).toBe(422);

      const invalidSort = await handleShimRequest(ctx, repoUrl('/forks?sort=random'));
      expect(invalidSort.status).toBe(422);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/forks`));
      expect(missingRepo.status).toBe(404);
    });
  });

  // =========================================================================
  // Starring endpoints
  // =========================================================================

  describe('starring endpoints', () => {
    it('should list no authenticated user stars initially', async () => {
      const res = await handleShimRequest(ctx, url('/user/starred'));
      expect(res.status).toBe(200);
      expect(parse(res)).toEqual([]);
    });

    it('should star a repository idempotently and report star status', async () => {
      const starPath = `/user/starred/${testDid}/test-repo`;
      const starRes = await handleShimRequest(ctx, url(starPath), 'PUT');
      expect(starRes.status).toBe(204);
      expect(starRes.body).toBe('');

      const duplicateRes = await handleShimRequest(ctx, url(starPath), 'PUT');
      expect(duplicateRes.status).toBe(204);

      const checkRes = await handleShimRequest(ctx, url(starPath));
      expect(checkRes.status).toBe(204);
    });

    it('should list repositories starred by the authenticated user', async () => {
      const res = await handleShimRequest(ctx, url('/user/starred'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('test-repo');
      expect(data[0].full_name).toBe(`${testDid}/test-repo`);
    });

    it('should list repositories starred by a user DID', async () => {
      const res = await handleShimRequest(ctx, url(`/users/${testDid}/starred`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('test-repo');
    });

    it('should list stargazers visible to the local actor', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/stargazers'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].login).toBe(testDid);
      expect(data[0].starred_url).toContain('/starred');
    });

    it('should unstar a repository and return 404 when checking it', async () => {
      const starPath = `/user/starred/${testDid}/test-repo`;
      const unstarRes = await handleShimRequest(ctx, url(starPath), 'DELETE');
      expect(unstarRes.status).toBe(204);

      const checkRes = await handleShimRequest(ctx, url(starPath));
      expect(checkRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(ctx, url(`/user/starred/${testDid}/missing-repo`), 'PUT');
      expect(missingRepoRes.status).toBe(404);
    });
  });

  // =========================================================================
  // Watching endpoints
  // =========================================================================

  describe('watching endpoints', () => {
    it('should set, list, update, and delete repository subscriptions', async () => {
      const subscriptionPath = `/repos/${testDid}/${EMPTY_REPO_NAME}/subscription`;
      const initial = await handleShimRequest(ctx, url('/user/subscriptions'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const setRes = await handleShimRequest(ctx, url(subscriptionPath), 'PUT', {
        ignored    : false,
        subscribed : true,
      });
      expect(setRes.status).toBe(200);
      const setData = parse(setRes);
      expect(setData.subscribed).toBe(true);
      expect(setData.ignored).toBe(false);
      expect(setData.url).toContain('/subscription');
      expect(setData.repository_url).toContain(`/repos/${testDid}/${EMPTY_REPO_NAME}`);

      const getRes = await handleShimRequest(ctx, url(subscriptionPath));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).subscribed).toBe(true);

      const subscribers = parse(await handleShimRequest(ctx, url(`/repos/${testDid}/${EMPTY_REPO_NAME}/subscribers`)));
      expect(subscribers.map((item: any) => item.login)).toContain(testDid);

      const watched = parse(await handleShimRequest(ctx, url('/user/subscriptions')));
      expect(watched.map((repo: any) => repo.name)).toContain(EMPTY_REPO_NAME);

      const watchedByUser = parse(await handleShimRequest(ctx, url(`/users/${testDid}/subscriptions`)));
      expect(watchedByUser.map((repo: any) => repo.name)).toContain(EMPTY_REPO_NAME);

      const ignored = await handleShimRequest(ctx, url(subscriptionPath), 'PUT', { ignored: true });
      expect(ignored.status).toBe(200);
      expect(parse(ignored).subscribed).toBe(false);
      expect(parse(ignored).ignored).toBe(true);

      const deleteRes = await handleShimRequest(ctx, url(subscriptionPath), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, url(subscriptionPath));
      expect(afterDelete.status).toBe(404);
      expect(parse(await handleShimRequest(ctx, url('/user/subscriptions')))).toEqual([]);
    });

    it('should reject invalid repository subscription requests', async () => {
      const invalidSubscribed = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${EMPTY_REPO_NAME}/subscription`),
        'PUT',
        { subscribed: 'yes' },
      );
      expect(invalidSubscribed.status).toBe(422);

      const invalidIgnored = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${EMPTY_REPO_NAME}/subscription`),
        'PUT',
        { ignored: 'yes' },
      );
      expect(invalidIgnored.status).toBe(422);

      const missingRepo = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/missing-repo/subscription`),
        'PUT',
        { subscribed: true },
      );
      expect(missingRepo.status).toBe(404);
    });
  });

  // =========================================================================
  // Following endpoints
  // =========================================================================

  describe('following endpoints', () => {
    it('should list no authenticated following or followers initially', async () => {
      const following = await handleShimRequest(ctx, url('/user/following'));
      expect(following.status).toBe(200);
      expect(parse(following)).toEqual([]);

      const followers = await handleShimRequest(ctx, url('/user/followers'));
      expect(followers.status).toBe(200);
      expect(parse(followers)).toEqual([]);
    });

    it('should follow a user idempotently and expose public following checks', async () => {
      const followPath = `/user/following/${FOLLOW_TARGET_DID}`;
      const followRes = await handleShimRequest(ctx, url(followPath), 'PUT');
      expect(followRes.status).toBe(204);

      const duplicateRes = await handleShimRequest(ctx, url(followPath), 'PUT');
      expect(duplicateRes.status).toBe(204);

      const checkRes = await handleShimRequest(ctx, url(followPath));
      expect(checkRes.status).toBe(204);

      const publicCheck = await handleShimRequest(ctx, url(`/users/${testDid}/following/${FOLLOW_TARGET_DID}`));
      expect(publicCheck.status).toBe(204);

      const following = parse(await handleShimRequest(ctx, url('/user/following')));
      expect(following.map((item: any) => item.login)).toContain(FOLLOW_TARGET_DID);

      const publicFollowing = parse(await handleShimRequest(ctx, url(`/users/${testDid}/following`)));
      expect(publicFollowing.map((item: any) => item.login)).toContain(FOLLOW_TARGET_DID);

      const targetFollowers = parse(await handleShimRequest(ctx, url(`/users/${FOLLOW_TARGET_DID}/followers`)));
      expect(targetFollowers.map((item: any) => item.login)).toContain(testDid);
    });

    it('should paginate following lists and reject self-follows', async () => {
      const secondFollow = await handleShimRequest(ctx, url(`/user/following/${FOLLOW_TARGET_TWO_DID}`), 'PUT');
      expect(secondFollow.status).toBe(204);

      const paged = await handleShimRequest(ctx, url('/user/following?per_page=1'));
      expect(paged.status).toBe(200);
      expect(parse(paged)).toHaveLength(1);
      expect(paged.headers.Link).toContain('rel="next"');

      const selfFollow = await handleShimRequest(ctx, url(`/user/following/${testDid}`), 'PUT');
      expect(selfFollow.status).toBe(422);
    });

    it('should list, check, block, and unblock users for the authenticated user', async () => {
      const blockedDid = 'did:jwk:userblocked123';
      const blockPath = `/user/blocks/${encodeURIComponent(blockedDid)}`;

      const initial = await handleShimRequest(ctx, url('/user/blocks'));
      expect(initial.status).toBe(200);
      expect(parse(initial).map((item: any) => item.login)).not.toContain(blockedDid);

      const missingCheck = await handleShimRequest(ctx, url(blockPath));
      expect(missingCheck.status).toBe(404);

      const block = await handleShimRequest(ctx, url(blockPath), 'PUT');
      expect(block.status).toBe(204);
      expect(block.body).toBe('');

      const duplicateBlock = await handleShimRequest(ctx, url(blockPath), 'PUT');
      expect(duplicateBlock.status).toBe(204);

      const blocked = parse(await handleShimRequest(ctx, url('/user/blocks')));
      const blockedUser = blocked.find((item: any) => item.login === blockedDid);
      expect(blockedUser.id).toBe(numericId(blockedDid));
      expect(blockedUser.following_url).toContain(`/users/${blockedDid}/following{/other_user}`);

      const check = await handleShimRequest(ctx, url(blockPath));
      expect(check.status).toBe(204);

      const selfBlock = await handleShimRequest(ctx, url(`/user/blocks/${encodeURIComponent(testDid)}`), 'PUT');
      expect(selfBlock.status).toBe(422);

      const unblock = await handleShimRequest(ctx, url(blockPath), 'DELETE');
      expect(unblock.status).toBe(204);
      expect(unblock.body).toBe('');

      const checkAfterUnblock = await handleShimRequest(ctx, url(blockPath));
      expect(checkAfterUnblock.status).toBe(404);

      const duplicateUnblock = await handleShimRequest(ctx, url(blockPath), 'DELETE');
      expect(duplicateUnblock.status).toBe(204);
    });

    it('should unfollow a user and return 404 for follow checks afterward', async () => {
      const unfollow = await handleShimRequest(ctx, url(`/user/following/${FOLLOW_TARGET_DID}`), 'DELETE');
      expect(unfollow.status).toBe(204);

      const check = await handleShimRequest(ctx, url(`/user/following/${FOLLOW_TARGET_DID}`));
      expect(check.status).toBe(404);

      const publicCheck = await handleShimRequest(ctx, url(`/users/${testDid}/following/${FOLLOW_TARGET_DID}`));
      expect(publicCheck.status).toBe(404);

      const targetFollowers = parse(await handleShimRequest(ctx, url(`/users/${FOLLOW_TARGET_DID}/followers`)));
      expect(targetFollowers.map((item: any) => item.login)).not.toContain(testDid);

      const secondUnfollow = await handleShimRequest(ctx, url(`/user/following/${FOLLOW_TARGET_TWO_DID}`), 'DELETE');
      expect(secondUnfollow.status).toBe(204);
    });
  });

  // =========================================================================
  // User email endpoints
  // =========================================================================

  describe('user email endpoints', () => {
    it('should add, list, publish, and delete authenticated user emails', async () => {
      const initial = await handleShimRequest(ctx, url('/user/emails'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const add = await handleShimRequest(ctx, url('/user/emails'), 'POST', {
        emails: ['primary@example.test', 'secondary@example.test'],
      });
      expect(add.status).toBe(201);
      const added = parse(add);
      expect(added).toContainEqual({
        email      : 'primary@example.test',
        verified   : false,
        primary    : true,
        visibility : 'private',
      });
      expect(added).toContainEqual({
        email      : 'secondary@example.test',
        verified   : false,
        primary    : false,
        visibility : null,
      });

      const duplicate = await handleShimRequest(ctx, url('/user/emails'), 'POST', { emails: ['primary@example.test'] });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, url('/user/emails')));
      expect(list.map((item: any) => item.email)).toEqual(['primary@example.test', 'secondary@example.test']);

      const initialPublic = parse(await handleShimRequest(ctx, url('/user/public_emails')));
      expect(initialPublic).toEqual([]);

      const visibility = await handleShimRequest(ctx, url('/user/email/visibility'), 'PATCH', { visibility: 'public' });
      expect(visibility.status).toBe(200);
      const visibleEmails = parse(visibility);
      expect(visibleEmails.find((item: any) => item.email === 'primary@example.test').visibility).toBe('public');

      const publicEmails = parse(await handleShimRequest(ctx, url('/user/public_emails')));
      expect(publicEmails).toEqual([{
        email      : 'primary@example.test',
        verified   : false,
        primary    : true,
        visibility : 'public',
      }]);

      const invalidVisibility = await handleShimRequest(ctx, url('/user/email/visibility'), 'PATCH', { visibility: 'friends' });
      expect(invalidVisibility.status).toBe(422);

      const invalidAdd = await handleShimRequest(ctx, url('/user/emails'), 'POST', { emails: ['not-an-email'] });
      expect(invalidAdd.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url('/user/emails'), 'DELETE', { emails: ['secondary@example.test'] });
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const afterDelete = parse(await handleShimRequest(ctx, url('/user/emails')));
      expect(afterDelete.map((item: any) => item.email)).toEqual(['primary@example.test']);

      const missingDelete = await handleShimRequest(ctx, url('/user/emails'), 'DELETE', { emails: ['missing@example.test'] });
      expect(missingDelete.status).toBe(422);
    });
  });

  // =========================================================================
  // User social account endpoints
  // =========================================================================

  describe('user social account endpoints', () => {
    it('should add, list, publicly list, and delete authenticated user social accounts', async () => {
      const initial = await handleShimRequest(ctx, url('/user/social_accounts'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const add = await handleShimRequest(ctx, url('/user/social_accounts'), 'POST', {
        account_urls: ['https://twitter.com/gitd', 'https://www.youtube.com/@gitd'],
      });
      expect(add.status).toBe(201);
      expect(parse(add)).toEqual([
        {
          provider : 'twitter',
          url      : 'https://twitter.com/gitd',
        },
        {
          provider : 'youtube',
          url      : 'https://www.youtube.com/@gitd',
        },
      ]);

      const duplicate = await handleShimRequest(ctx, url('/user/social_accounts'), 'POST', {
        account_urls: ['https://twitter.com/gitd/'],
      });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, url('/user/social_accounts')));
      expect(list).toEqual([
        {
          provider : 'twitter',
          url      : 'https://twitter.com/gitd',
        },
        {
          provider : 'youtube',
          url      : 'https://www.youtube.com/@gitd',
        },
      ]);

      const publicList = parse(await handleShimRequest(ctx, url(`/users/${testDid}/social_accounts`)));
      expect(publicList).toEqual(list);

      const invalidAdd = await handleShimRequest(ctx, url('/user/social_accounts'), 'POST', {
        account_urls: ['not-a-url'],
      });
      expect(invalidAdd.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url('/user/social_accounts'), 'DELETE', {
        account_urls: ['https://twitter.com/gitd'],
      });
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const afterDelete = parse(await handleShimRequest(ctx, url('/user/social_accounts')));
      expect(afterDelete).toEqual([
        {
          provider : 'youtube',
          url      : 'https://www.youtube.com/@gitd',
        },
      ]);

      const missingDelete = await handleShimRequest(ctx, url('/user/social_accounts'), 'DELETE', {
        account_urls: ['https://twitter.com/gitd'],
      });
      expect(missingDelete.status).toBe(422);
    });
  });

  // =========================================================================
  // Gist endpoints
  // =========================================================================

  describe('gist endpoints', () => {
    it('should create, list, update, publicly list, and delete gists', async () => {
      const invalidCreate = await handleShimRequest(ctx, url('/gists'), 'POST', { description: 'missing files' });
      expect(invalidCreate.status).toBe(422);

      const secretCreate = await handleShimRequest(ctx, url('/gists'), 'POST', {
        description : 'private scratch note',
        public      : false,
        files       : {
          'secret.txt': { content: 'not listed publicly' },
        },
      });
      expect(secretCreate.status).toBe(201);
      const secret = parse(secretCreate);
      expect(secret.public).toBe(false);

      const create = await handleShimRequest(ctx, url('/gists'), 'POST', {
        description : 'public gist',
        public      : true,
        files       : {
          'README.md'     : { content: '# GitD\n' },
          'delete.txt'    : { content: 'remove me' },
          'docs/info.txt' : { content: 'nested file' },
        },
      });
      expect(create.status).toBe(201);
      const created = parse(create);
      expect(created.description).toBe('public gist');
      expect(created.public).toBe(true);
      expect(created.owner.login).toBe(testDid);
      expect(created.files['README.md'].content).toBe('# GitD\n');
      expect(created.files['README.md'].language).toBe('Markdown');

      const authenticatedList = parse(await handleShimRequest(ctx, url('/gists')));
      expect(authenticatedList.map((item: any) => item.id)).toContain(secret.id);
      expect(authenticatedList.map((item: any) => item.id)).toContain(created.id);

      const publicList = parse(await handleShimRequest(ctx, url('/gists/public')));
      expect(publicList.map((item: any) => item.id)).toContain(created.id);
      expect(publicList.map((item: any) => item.id)).not.toContain(secret.id);

      const userList = parse(await handleShimRequest(ctx, url(`/users/${testDid}/gists`)));
      expect(userList.map((item: any) => item.id)).toContain(created.id);
      expect(userList.map((item: any) => item.id)).not.toContain(secret.id);

      const emptyForks = parse(await handleShimRequest(ctx, url(`/gists/${created.id}/forks`)));
      expect(emptyForks).toEqual([]);

      const forkRes = await handleShimRequest(ctx, url(`/gists/${created.id}/forks`), 'POST');
      expect(forkRes.status).toBe(201);
      const fork = parse(forkRes);
      expect(fork.id).not.toBe(created.id);
      expect(fork.owner.login).toBe(testDid);
      expect(fork.fork_of.id).toBe(created.id);
      expect(fork.fork_of.owner.login).toBe(testDid);
      expect(fork.files['README.md'].content).toBe('# GitD\n');

      const forks = parse(await handleShimRequest(ctx, url(`/gists/${created.id}/forks`)));
      expect(forks.map((item: any) => item.id)).toContain(fork.id);

      const duplicateFork = await handleShimRequest(ctx, url(`/gists/${created.id}/forks`), 'POST');
      expect(duplicateFork.status).toBe(422);

      const starredInitially = parse(await handleShimRequest(ctx, url('/gists/starred')));
      expect(starredInitially.map((item: any) => item.id)).not.toContain(created.id);

      const checkUnstarred = await handleShimRequest(ctx, url(`/gists/${created.id}/star`));
      expect(checkUnstarred.status).toBe(404);

      const star = await handleShimRequest(ctx, url(`/gists/${created.id}/star`), 'PUT');
      expect(star.status).toBe(204);
      expect(star.body).toBe('');

      const checkStarred = await handleShimRequest(ctx, url(`/gists/${created.id}/star`));
      expect(checkStarred.status).toBe(204);
      expect(checkStarred.body).toBe('');

      const starredList = parse(await handleShimRequest(ctx, url('/gists/starred')));
      expect(starredList.map((item: any) => item.id)).toContain(created.id);

      const duplicateStar = await handleShimRequest(ctx, url(`/gists/${created.id}/star`), 'PUT');
      expect(duplicateStar.status).toBe(204);

      const unstar = await handleShimRequest(ctx, url(`/gists/${created.id}/star`), 'DELETE');
      expect(unstar.status).toBe(204);
      expect(unstar.body).toBe('');

      const checkAfterUnstar = await handleShimRequest(ctx, url(`/gists/${created.id}/star`));
      expect(checkAfterUnstar.status).toBe(404);

      const get = await handleShimRequest(ctx, url(`/gists/${created.id}`));
      expect(get.status).toBe(200);
      const fetched = parse(get);
      expect(fetched.files['README.md'].content).toBe('# GitD\n');
      expect(fetched.history[0].version).toMatch(/^[0-9a-f]{40}$/);

      const commits = parse(await handleShimRequest(ctx, new URL(fetched.commits_url)));
      expect(commits).toHaveLength(1);
      expect(commits[0].version).toBe(fetched.history[0].version);
      expect(commits[0].url).toContain(`/gists/${created.id}/${commits[0].version}`);
      expect(commits[0].user.login).toBe(testDid);
      expect(commits[0].change_status).toEqual({ additions: 3, deletions: 0, total: 3 });

      const commitsPage2Url = new URL(fetched.commits_url);
      commitsPage2Url.searchParams.set('per_page', '1');
      commitsPage2Url.searchParams.set('page', '2');
      expect(parse(await handleShimRequest(ctx, commitsPage2Url))).toEqual([]);

      const revision = parse(await handleShimRequest(ctx, new URL(commits[0].url)));
      expect(revision.id).toBe(created.id);
      expect(revision.files['README.md'].content).toBe('# GitD\n');
      expect(revision.history[0].version).toBe(commits[0].version);

      const missingRevision = await handleShimRequest(ctx, url(`/gists/${created.id}/deadbeef`));
      expect(missingRevision.status).toBe(404);

      const raw = await handleShimRequest(ctx, new URL(fetched.files['README.md'].raw_url));
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
      expect(bodyBuffer(raw).toString('utf-8')).toBe('# GitD\n');

      const nestedRaw = await handleShimRequest(ctx, new URL(fetched.files['docs/info.txt'].raw_url));
      expect(nestedRaw.status).toBe(200);
      expect(nestedRaw.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(bodyBuffer(nestedRaw).toString('utf-8')).toBe('nested file');

      const missingRaw = await handleShimRequest(ctx, url(`/gists/${created.id}/raw/missing.txt`));
      expect(missingRaw.status).toBe(404);

      const update = await handleShimRequest(ctx, url(`/gists/${created.id}`), 'PATCH', {
        description : 'updated gist',
        files       : {
          'README.md'     : { filename: 'NOTES.md', content: 'updated note' },
          'delete.txt'    : null,
          'docs/info.txt' : null,
        },
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.description).toBe('updated gist');
      expect(updated.files['NOTES.md'].content).toBe('updated note');
      expect(updated.files['README.md']).toBeUndefined();
      expect(updated.files['delete.txt']).toBeUndefined();
      expect(updated.files['docs/info.txt']).toBeUndefined();

      const invalidUpdate = await handleShimRequest(ctx, url(`/gists/${created.id}`), 'PATCH', {
        files: { 'NOTES.md': null },
      });
      expect(invalidUpdate.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url(`/gists/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, url(`/gists/${created.id}`));
      expect(missing.status).toBe(404);
    }, 10_000);

    it('should create, list, get, update, and delete gist comments', async () => {
      const createGist = await handleShimRequest(ctx, url('/gists'), 'POST', {
        description : 'commented gist',
        public      : true,
        files       : {
          'README.md': { content: 'comment target' },
        },
      });
      expect(createGist.status).toBe(201);
      const gist = parse(createGist);

      const emptyList = parse(await handleShimRequest(ctx, url(`/gists/${gist.id}/comments`)));
      expect(emptyList).toEqual([]);

      const invalidCreate = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments`), 'POST', {});
      expect(invalidCreate.status).toBe(422);

      const createComment = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments`), 'POST', {
        body: 'First comment.',
      });
      expect(createComment.status).toBe(201);
      const comment = parse(createComment);
      expect(comment.body).toBe('First comment.');
      expect(comment.user.login).toBe(testDid);
      expect(comment.url).toContain(`/gists/${gist.id}/comments/${comment.id}`);
      expect(comment.author_association).toBe('OWNER');

      const detailWithComment = parse(await handleShimRequest(ctx, url(`/gists/${gist.id}`)));
      expect(detailWithComment.comments).toBe(1);
      expect(detailWithComment.comments_enabled).toBe(true);

      const list = parse(await handleShimRequest(ctx, url(`/gists/${gist.id}/comments`)));
      expect(list.map((item: any) => item.id)).toContain(comment.id);

      const get = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments/${comment.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).body).toBe('First comment.');

      const update = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments/${comment.id}`), 'PATCH', {
        body: 'Updated comment.',
      });
      expect(update.status).toBe(200);
      expect(parse(update).body).toBe('Updated comment.');

      const invalidUpdate = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments/${comment.id}`), 'PATCH', {});
      expect(invalidUpdate.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments/${comment.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missingComment = await handleShimRequest(ctx, url(`/gists/${gist.id}/comments/${comment.id}`));
      expect(missingComment.status).toBe(404);

      const detailAfterDelete = parse(await handleShimRequest(ctx, url(`/gists/${gist.id}`)));
      expect(detailAfterDelete.comments).toBe(0);
    });
  });

  // =========================================================================
  // User account key endpoints
  // =========================================================================

  describe('user account key endpoints', () => {
    it('should create, list, get, publicly list, and delete authenticated GPG keys', async () => {
      const initial = await handleShimRequest(ctx, url('/user/gpg_keys'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const armoredPublicKey = [
        '-----BEGIN PGP PUBLIC KEY BLOCK-----',
        'Version: gitd-test',
        '',
        'mQENBGitdGpgTest alice@example.test',
        '=test',
        '-----END PGP PUBLIC KEY BLOCK-----',
      ].join('\n');
      const create = await handleShimRequest(ctx, url('/user/gpg_keys'), 'POST', {
        name               : 'work signing key',
        armored_public_key : armoredPublicKey,
      });
      expect(create.status).toBe(201);
      const created = parse(create);
      expect(created.name).toBe('work signing key');
      expect(created.id).toBeGreaterThan(0);
      expect(created.primary_key_id).toBe(created.id);
      expect(created.key_id).toMatch(/^[A-F0-9]{16}$/);
      expect(created.public_key).toBe(armoredPublicKey);
      expect(created.raw_key).toBe(armoredPublicKey);
      expect(created.emails).toContainEqual({ email: 'alice@example.test', verified: false });
      expect(created.subkeys).toEqual([]);
      expect(created.can_sign).toBe(true);
      expect(created.can_certify).toBe(true);
      expect(created.can_encrypt_comms).toBe(false);
      expect(created.revoked).toBe(false);

      const duplicate = await handleShimRequest(ctx, url('/user/gpg_keys'), 'POST', {
        name               : 'duplicate',
        armored_public_key : armoredPublicKey,
      });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, url('/user/gpg_keys')));
      expect(list.some((item: any) => item.id === created.id)).toBe(true);

      const publicList = parse(await handleShimRequest(ctx, url(`/users/${testDid}/gpg_keys`)));
      const publicKey = publicList.find((item: any) => item.id === created.id);
      expect(publicKey.key_id).toBe(created.key_id);
      expect(publicKey.raw_key).toBe(armoredPublicKey);

      const get = await handleShimRequest(ctx, url(`/user/gpg_keys/${created.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).key_id).toBe(created.key_id);

      const invalid = await handleShimRequest(ctx, url('/user/gpg_keys'), 'POST', { name: 'bad' });
      expect(invalid.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url(`/user/gpg_keys/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, url(`/user/gpg_keys/${created.id}`));
      expect(missing.status).toBe(404);
    });

    it('should create, list, get, publicly list, and delete authenticated user SSH keys', async () => {
      const initial = await handleShimRequest(ctx, url('/user/keys'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIuserkey1234567890 gitd@example.test';
      const create = await handleShimRequest(ctx, url('/user/keys'), 'POST', { title: 'work laptop', key });
      expect(create.status).toBe(201);
      const created = parse(create);
      expect(created.key).toBe(key);
      expect(created.title).toBe('work laptop');
      expect(created.id).toBeGreaterThan(0);
      expect(created.url).toContain(`/user/keys/${created.id}`);
      expect(created.verified).toBe(false);
      expect(created.read_only).toBe(false);

      const duplicate = await handleShimRequest(ctx, url('/user/keys'), 'POST', { title: 'duplicate', key });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, url('/user/keys')));
      expect(list.some((item: any) => item.id === created.id)).toBe(true);

      const publicList = parse(await handleShimRequest(ctx, url(`/users/${testDid}/keys`)));
      expect(publicList).toContainEqual({ id: created.id, key });

      const get = await handleShimRequest(ctx, url(`/user/keys/${created.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).key).toBe(key);

      const invalid = await handleShimRequest(ctx, url('/user/keys'), 'POST', { title: 'bad' });
      expect(invalid.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url(`/user/keys/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, url(`/user/keys/${created.id}`));
      expect(missing.status).toBe(404);
    });

    it('should create, list, get, publicly list, and delete authenticated SSH signing keys', async () => {
      const initial = await handleShimRequest(ctx, url('/user/ssh_signing_keys'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsigningkey1234567890 gitd-sign@example.test';
      const create = await handleShimRequest(ctx, url('/user/ssh_signing_keys'), 'POST', { title: 'signing laptop', key });
      expect(create.status).toBe(201);
      const created = parse(create);
      expect(created.key).toBe(key);
      expect(created.title).toBe('signing laptop');
      expect(created.id).toBeGreaterThan(0);
      expect(typeof created.created_at).toBe('string');
      expect(created.verified).toBeUndefined();
      expect(created.read_only).toBeUndefined();

      const duplicate = await handleShimRequest(ctx, url('/user/ssh_signing_keys'), 'POST', { title: 'duplicate', key });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, url('/user/ssh_signing_keys')));
      expect(list.some((item: any) => item.id === created.id)).toBe(true);

      const publicList = parse(await handleShimRequest(ctx, url(`/users/${testDid}/ssh_signing_keys`)));
      const publicKey = publicList.find((item: any) => item.id === created.id);
      expect(publicKey.key).toBe(key);
      expect(publicKey.title).toBe('signing laptop');

      const get = await handleShimRequest(ctx, url(`/user/ssh_signing_keys/${created.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).key).toBe(key);

      const invalid = await handleShimRequest(ctx, url('/user/ssh_signing_keys'), 'POST', { title: 'bad' });
      expect(invalid.status).toBe(422);

      const deleted = await handleShimRequest(ctx, url(`/user/ssh_signing_keys/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, url(`/user/ssh_signing_keys/${created.id}`));
      expect(missing.status).toBe(404);
    });
  });

  // =========================================================================
  // Activity event endpoints
  // =========================================================================

  describe('activity event endpoints', () => {
    it('should list global and user activity events with GitHub event shapes', async () => {
      const global = await handleShimRequest(ctx, url('/events?per_page=2'));
      expect(global.status).toBe(200);
      expect(global.headers['X-Poll-Interval']).toBe('60');
      expect(global.headers.Link).toContain('/events');
      const globalEvents = parse(global);
      expect(globalEvents.length).toBe(2);
      expect(globalEvents[0].actor.login).toBe(testDid);
      expect(globalEvents[0].repo.name).toContain(`${testDid}/`);
      expect(globalEvents[0].payload).toBeDefined();
      expect(globalEvents.some((event: any) => event.repo.name === `${testDid}/test-repo`)).toBe(true);

      const userEvents = await handleShimRequest(ctx, url(`/users/${testDid}/events`));
      expect(userEvents.status).toBe(200);
      const events = parse(userEvents);
      expect(events.map((event: any) => event.type)).toContain('PushEvent');
      expect(events.map((event: any) => event.type)).toContain('WatchEvent');
      expect(events.map((event: any) => event.type)).toContain('ReleaseEvent');

      const push = events.find((event: any) => event.type === 'PushEvent');
      expect(push.payload.ref).toBe('refs/heads/main');
      expect(push.payload.head).toBe(MAIN_SHA);
      expect(push.public).toBe(true);
    });

    it('should filter public and received activity event feeds', async () => {
      const publicEvents = await handleShimRequest(ctx, url(`/users/${testDid}/events/public`));
      expect(publicEvents.status).toBe(200);
      expect(parse(publicEvents).map((event: any) => event.payload.release?.tag_name)).not.toContain('v-private');

      const received = await handleShimRequest(ctx, url(`/users/${testDid}/received_events`));
      expect(received.status).toBe(200);
      expect(parse(received).map((event: any) => event.type)).toContain('ReleaseEvent');

      const receivedPublic = await handleShimRequest(ctx, url(`/users/${testDid}/received_events/public`));
      expect(receivedPublic.status).toBe(200);
      expect(parse(receivedPublic).map((event: any) => event.payload.release?.tag_name)).not.toContain('v-private');
    });

    it('should list repository and network activity events', async () => {
      const repoEvents = await handleShimRequest(ctx, repoUrl('/events'));
      expect(repoEvents.status).toBe(200);
      const events = parse(repoEvents);
      expect(events.map((event: any) => event.type)).toContain('PushEvent');
      expect(events.map((event: any) => event.type)).toContain('WatchEvent');
      expect(events.every((event: any) => event.repo.name === `${testDid}/test-repo`)).toBe(true);

      const networkEvents = await handleShimRequest(ctx, url(`/networks/${testDid}/test-repo/events`));
      expect(networkEvents.status).toBe(200);
      expect(parse(networkEvents).map((event: any) => event.id)).toEqual(events.map((event: any) => event.id));

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/events`));
      expect(missingRepo.status).toBe(404);
    });

    it('should list repository activity history with GitHub activity filters', async () => {
      const repoActivity = await handleShimRequest(ctx, repoUrl('/activity?activity_type=push&ref=main&direction=asc'));
      expect(repoActivity.status).toBe(200);
      const activity = parse(repoActivity);
      expect(activity.length).toBe(1);
      expect(activity[0].activity_type).toBe('push');
      expect(activity[0].ref).toBe('refs/heads/main');
      expect(activity[0].before).toBe(FEATURE_SHA);
      expect(activity[0].after).toBe(MAIN_SHA);
      expect(activity[0].actor.login).toBe(testDid);
      expect(activity[0].timestamp).toBeDefined();

      const wrongActor = parse(await handleShimRequest(ctx, repoUrl('/activity?actor=did:example:other')));
      expect(wrongActor).toEqual([]);

      const invalidType = await handleShimRequest(ctx, repoUrl('/activity?activity_type=release'));
      expect(invalidType.status).toBe(422);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/activity`));
      expect(missingRepo.status).toBe(404);
    });
  });

  // =========================================================================
  // User and organization discovery endpoints
  // =========================================================================

  describe('user and organization discovery endpoints', () => {
    it('should return the authenticated GitHub user profile', async () => {
      const res = await handleShimRequest(ctx, url('/user'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.login).toBe(testDid);
      expect(data.type).toBe('User');
      expect(data.url).toBe(`${BASE}/users/${testDid}`);
      expect(data.repos_url).toBe(`${BASE}/users/${testDid}/repos`);
      expect(data.public_repos).toBeGreaterThanOrEqual(3);
      expect(data.total_private_repos).toBeGreaterThanOrEqual(1);
      expect(data.plan.name).toBe('DWN');
    });

    it('should update authenticated user profile metadata and expose it publicly', async () => {
      const update = await handleShimRequest(ctx, url('/user'), 'PATCH', {
        name             : 'GitD Tester',
        email            : 'profile@example.test',
        blog             : 'https://gitd.example',
        twitter_username : '@gitd',
        company          : 'Enbox',
        location         : 'Distributed Web',
        hireable         : true,
        bio              : 'Replacing GitHub-compatible workflows.',
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.name).toBe('GitD Tester');
      expect(updated.email).toBe('profile@example.test');
      expect(updated.blog).toBe('https://gitd.example');
      expect(updated.twitter_username).toBe('gitd');
      expect(updated.company).toBe('Enbox');
      expect(updated.location).toBe('Distributed Web');
      expect(updated.hireable).toBe(true);
      expect(updated.bio).toBe('Replacing GitHub-compatible workflows.');
      expect(updated.updated_at).toBeDefined();

      const authenticated = parse(await handleShimRequest(ctx, url('/user')));
      expect(authenticated.name).toBe('GitD Tester');
      expect(authenticated.plan.name).toBe('DWN');

      const publicProfile = parse(await handleShimRequest(ctx, url(`/users/${testDid}`)));
      expect(publicProfile.name).toBe('GitD Tester');
      expect(publicProfile.email).toBe('profile@example.test');
      expect(publicProfile.twitter_username).toBe('gitd');
      expect(publicProfile.plan).toBeUndefined();

      const clear = await handleShimRequest(ctx, url('/user'), 'PATCH', {
        blog             : null,
        twitter_username : null,
        hireable         : null,
      });
      expect(clear.status).toBe(200);
      const cleared = parse(clear);
      expect(cleared.blog).toBe('');
      expect(cleared.twitter_username).toBeNull();
      expect(cleared.hireable).toBeNull();

      const invalidHireable = await handleShimRequest(ctx, url('/user'), 'PATCH', { hireable: 'yes' });
      expect(invalidHireable.status).toBe(422);

      const invalidEmail = await handleShimRequest(ctx, url('/user'), 'PATCH', { email: 'not-an-email' });
      expect(invalidEmail.status).toBe(422);
    });

    it('should list visible users with since pagination', async () => {
      const all = await handleShimRequest(ctx, url('/users?per_page=100'));
      expect(all.status).toBe(200);
      const users = parse(all);
      const logins = users.map((item: any) => item.login);
      expect(logins).toContain(testDid);
      expect(logins).toContain(MAINTAINER_DID);
      expect(logins).toContain(TRIAGER_DID);
      expect(logins).toContain(ORG_MEMBER_DID);

      const ids = users.map((item: any) => item.id);
      expect(ids).toEqual([...ids].sort((left, right) => left - right));

      const firstPage = await handleShimRequest(ctx, url('/users?per_page=1'));
      expect(firstPage.status).toBe(200);
      expect(firstPage.headers.Link).toContain('/users?since=');
      expect(firstPage.headers.Link).toContain('per_page=1');
      const firstUser = parse(firstPage)[0];

      const afterFirst = parse(await handleShimRequest(ctx, url(`/users?since=${firstUser.id}&per_page=100`)));
      expect(afterFirst.every((item: any) => item.id > firstUser.id)).toBe(true);
      expect(afterFirst.map((item: any) => item.login)).not.toContain(firstUser.login);

      const afterAll = parse(await handleShimRequest(ctx, url(`/users?since=${Math.max(...ids)}&per_page=100`)));
      expect(afterAll).toEqual([]);
    });

    it('should get visible users by numeric account ID and return hovercard contexts', async () => {
      const users = parse(await handleShimRequest(ctx, url('/users?per_page=100')));
      const localUser = users.find((item: any) => item.login === testDid);
      expect(localUser).toBeDefined();

      const byId = await handleShimRequest(ctx, url(`/user/${localUser.id}`));
      expect(byId.status).toBe(200);
      expect(parse(byId).login).toBe(testDid);

      const missing = await handleShimRequest(ctx, url('/user/999999999999'));
      expect(missing.status).toBe(404);

      const hover = await handleShimRequest(
        ctx,
        url(`/users/${testDid}/hovercard?subject_type=repository&subject_id=${numericId(repoRecordId)}`),
      );
      expect(hover.status).toBe(200);
      const contexts = parse(hover).contexts;
      expect(contexts).toContainEqual({ message: 'Owns this repository', octicon: 'repo' });
      expect(contexts.some((item: any) => item.octicon === 'person')).toBe(true);

      const invalidSubject = await handleShimRequest(
        ctx,
        url(`/users/${testDid}/hovercard?subject_type=discussion&subject_id=1`),
      );
      expect(invalidSubject.status).toBe(422);

      const missingSubjectType = await handleShimRequest(ctx, url(`/users/${testDid}/hovercard?subject_id=1`));
      expect(missingSubjectType.status).toBe(422);

      const missingUserHovercard = await handleShimRequest(ctx, url('/users/did:jwk:missingvisible/hovercard'));
      expect(missingUserHovercard.status).toBe(404);
    });

    it('should list public organizations using GitHub since pagination', async () => {
      const res = await handleShimRequest(ctx, url('/organizations?per_page=1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].login).toBe(ORG_NAME);
      expect(data[0].members_url).toContain('/members{/member}');

      const afterAll = await handleShimRequest(ctx, url('/organizations?since=9999999999'));
      expect(afterAll.status).toBe(200);
      expect(parse(afterAll)).toEqual([]);
    });

    it('should list organizations for the authenticated user', async () => {
      const res = await handleShimRequest(ctx, url('/user/orgs'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((item: any) => item.login)).toContain(ORG_NAME);
      expect(data[0].repos_url).toBe(`${BASE}/orgs/${ORG_NAME}/repos`);
    });

    it('should list public organizations for a user DID', async () => {
      const ownerOrgs = await handleShimRequest(ctx, url(`/users/${testDid}/orgs`));
      expect(ownerOrgs.status).toBe(200);
      expect(parse(ownerOrgs).map((item: any) => item.login)).toContain(ORG_NAME);

      const memberOrgs = await handleShimRequest(ctx, url(`/users/${ORG_MEMBER_DID}/orgs`));
      expect(memberOrgs.status).toBe(200);
      expect(parse(memberOrgs).map((item: any) => item.login)).toContain(ORG_NAME);

      const empty = await handleShimRequest(ctx, url(`/users/${FOLLOW_TARGET_DID}/orgs`));
      expect(empty.status).toBe(200);
      expect(parse(empty)).toEqual([]);
    });
  });

  // =========================================================================
  // Search endpoints
  // =========================================================================

  describe('search endpoints', () => {
    it('should search repositories with GitHub search envelopes and pagination', async () => {
      const res = await handleShimRequest(ctx, url('/search/repositories?q=repo&per_page=2'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBeGreaterThanOrEqual(4);
      expect(data.incomplete_results).toBe(false);
      expect(data.items).toHaveLength(2);
      expect(data.items[0].full_name).toContain('/');
      expect(data.items[0].score).toBeGreaterThan(0);
      expect(res.headers.Link).toContain('/search/repositories');

      const topicRes = await handleShimRequest(ctx, url('/search/repositories?q=topic:git+decentralized'));
      expect(topicRes.status).toBe(200);
      expect(parse(topicRes).items.map((repo: any) => repo.name)).toContain('test-repo');
    });

    it('should search local git code with repository and filename qualifiers', async () => {
      const search = url('/search/code');
      search.searchParams.set('q', `answer repo:${testDid}/test-repo filename:index.ts`);
      const res = await handleShimRequest(ctx, search, 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.incomplete_results).toBe(false);
      expect(data.items[0].name).toBe('index.ts');
      expect(data.items[0].path).toBe('src/index.ts');
      expect(data.items[0].repository.full_name).toBe(`${testDid}/test-repo`);
      expect(data.items[0].git_url).toContain('/git/blobs/');
      expect(data.items[0].score).toBeGreaterThan(0);
    });

    it('should search local git commit messages', async () => {
      const search = url('/search/commits');
      search.searchParams.set('q', `feature repo:${testDid}/test-repo author-email:gitd@example.test`);
      const res = await handleShimRequest(ctx, search, 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.items[0].sha).toBe(gitMainSha);
      expect(data.items[0].commit.message).toBe('Add feature file');
      expect(data.items[0].repository.name).toBe('test-repo');
    });

    it('should search repository labels by repository id', async () => {
      const repo = parse(await handleShimRequest(ctx, repoUrl('')));
      const search = url('/search/labels');
      search.searchParams.set('repository_id', String(repo.id));
      search.searchParams.set('q', 'bug request');
      const res = await handleShimRequest(ctx, search);
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(2);
      expect(data.items.map((label: any) => label.name)).toEqual(['bug', 'enhancement']);
      expect(data.items[0].score).toBeGreaterThan(0);

      const missingRepoId = await handleShimRequest(ctx, url('/search/labels?q=bug'));
      expect(missingRepoId.status).toBe(422);
      expect(parse(missingRepoId).message).toContain('repository_id');
    });

    it('should search local repository topics', async () => {
      const res = await handleShimRequest(ctx, url('/search/topics?q=decentralized'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.items[0].name).toBe('decentralized');
      expect(data.items[0].display_name).toBe('Decentralized');
      expect(data.items[0].featured).toBe(false);

      const featured = await handleShimRequest(ctx, url('/search/topics?q=is:featured'));
      expect(featured.status).toBe(200);
      expect(parse(featured).total_count).toBe(0);
    });

    it('should search issues within a repository qualifier', async () => {
      const search = url('/search/issues');
      search.searchParams.set('q', `widget repo:${testDid}/test-repo is:issue`);
      const res = await handleShimRequest(ctx, search);
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBeGreaterThanOrEqual(1);
      expect(data.items[0].title).toBe('Fix the widget');
      expect(data.items[0].repository_url).toBe(`${BASE}/repos/${testDid}/test-repo`);
      expect(data.items[0].pull_request).toBeUndefined();
    });

    it('should search pull requests through the issues search route', async () => {
      const search = url('/search/issues');
      search.searchParams.set('q', 'feature is:pr state:open');
      const res = await handleShimRequest(ctx, search);
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.items.map((item: any) => item.title)).toContain('Add feature X');
      const pull = data.items.find((item: any) => item.title === 'Add feature X');
      expect(pull.pull_request.url).toContain('/pulls/');
    });

    it('should search visible users and reject missing search queries', async () => {
      const res = await handleShimRequest(ctx, url(`/search/users?q=${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBeGreaterThanOrEqual(1);
      expect(data.items.map((item: any) => item.login)).toContain(ORG_MEMBER_DID);

      const missing = await handleShimRequest(ctx, url('/search/repositories'));
      expect(missing.status).toBe(422);
      expect(parse(missing).message).toContain('q');
    });
  });

  // =========================================================================
  // Organization and team endpoints
  // =========================================================================

  describe('organization endpoints', () => {
    it('should get and update an organization profile', async () => {
      const initial = await handleShimRequest(ctx, orgUrl(''));
      expect(initial.status).toBe(200);
      const initialData = parse(initial);
      expect(initialData.login).toBe(ORG_NAME);
      expect(initialData.type).toBe('Organization');
      expect(initialData.members_url).toContain('/members{/member}');
      expect(initialData.blog).toBe('https://enbox.org');

      const updated = await handleShimRequest(ctx, orgUrl(''), 'PATCH', {
        description : 'Updated decentralized forge organization',
        blog        : 'https://forge.enbox.org',
      });
      expect(updated.status).toBe(200);
      const updatedData = parse(updated);
      expect(updatedData.description).toBe('Updated decentralized forge organization');
      expect(updatedData.blog).toBe('https://forge.enbox.org');

      const missing = await handleShimRequest(ctx, url('/orgs/missing-org'));
      expect(missing.status).toBe(404);
    });

    it('should list, check, block, and unblock organization users', async () => {
      const blockedDid = 'did:jwk:blockeduser123';
      const blockedPath = `/blocks/${encodeURIComponent(blockedDid)}`;

      const initial = await handleShimRequest(ctx, orgUrl('/blocks'));
      expect(initial.status).toBe(200);
      expect(parse(initial).map((user: any) => user.login)).not.toContain(blockedDid);

      const missingCheck = await handleShimRequest(ctx, orgUrl(blockedPath));
      expect(missingCheck.status).toBe(404);

      const block = await handleShimRequest(ctx, orgUrl(blockedPath), 'PUT');
      expect(block.status).toBe(204);
      expect(block.body).toBe('');

      const duplicateBlock = await handleShimRequest(ctx, orgUrl(blockedPath), 'PUT');
      expect(duplicateBlock.status).toBe(204);

      const list = await handleShimRequest(ctx, orgUrl('/blocks'));
      expect(list.status).toBe(200);
      const blockedUser = parse(list).find((user: any) => user.login === blockedDid);
      expect(blockedUser.id).toBe(numericId(blockedDid));
      expect(blockedUser.type).toBe('User');
      expect(blockedUser.followers_url).toContain(`/users/${blockedDid}/followers`);

      const check = await handleShimRequest(ctx, orgUrl(blockedPath));
      expect(check.status).toBe(204);

      const memberBlock = await handleShimRequest(ctx, orgUrl(`/blocks/${encodeURIComponent(ORG_MEMBER_DID)}`), 'PUT');
      expect(memberBlock.status).toBe(422);

      const missingOrg = await handleShimRequest(ctx, url(`/orgs/missing-org/blocks/${encodeURIComponent(blockedDid)}`), 'PUT');
      expect(missingOrg.status).toBe(404);

      const unblock = await handleShimRequest(ctx, orgUrl(blockedPath), 'DELETE');
      expect(unblock.status).toBe(204);
      expect(unblock.body).toBe('');

      const checkAfterUnblock = await handleShimRequest(ctx, orgUrl(blockedPath));
      expect(checkAfterUnblock.status).toBe(404);

      const duplicateUnblock = await handleShimRequest(ctx, orgUrl(blockedPath), 'DELETE');
      expect(duplicateUnblock.status).toBe(204);
    });

    it('should create, list, update, and delete organization issue fields', async () => {
      const initial = await handleShimRequest(ctx, orgUrl('/issue-fields'));
      expect(initial.status).toBe(200);
      expect(Array.isArray(parse(initial))).toBe(true);

      const createdRes = await handleShimRequest(ctx, orgUrl('/issue-fields'), 'POST', {
        name        : 'Lifecycle Priority Field',
        description : 'Level of importance',
        data_type   : 'single_select',
        visibility  : 'all',
        options     : [
          { name: 'High', description: 'High priority', color: 'red', priority: 1 },
          { name: 'Low', color: 'green', priority: 2 },
        ],
      });
      expect(createdRes.status).toBe(200);
      const created = parse(createdRes);
      expect(created.name).toBe('Lifecycle Priority Field');
      expect(created.description).toBe('Level of importance');
      expect(created.data_type).toBe('single_select');
      expect(created.visibility).toBe('all');
      expect(created.options.map((option: any) => option.name)).toEqual(['High', 'Low']);
      expect(created.options[0].id).toBeGreaterThan(0);
      expect(created.options[0].created_at).toBeDefined();

      const list = parse(await handleShimRequest(ctx, orgUrl('/issue-fields')));
      expect(list.some((field: any) => field.id === created.id)).toBe(true);

      const updatedRes = await handleShimRequest(ctx, orgUrl(`/issue-fields/${created.id}`), 'PATCH', {
        name    : 'Lifecycle Priority',
        options : [
          { id: created.options[0].id, name: 'Urgent', description: 'Needs attention', color: 'orange', priority: 1 },
          { name: 'Low', color: 'green', priority: 2 },
        ],
      });
      expect(updatedRes.status).toBe(200);
      const updated = parse(updatedRes);
      expect(updated.name).toBe('Lifecycle Priority');
      expect(updated.options[0].id).toBe(created.options[0].id);
      expect(updated.options[0].name).toBe('Urgent');
      expect(updated.options[0].color).toBe('orange');
      expect(updated.options[1].id).toBeGreaterThan(created.options[1].id);

      const invalidCreate = await handleShimRequest(ctx, orgUrl('/issue-fields'), 'POST', {
        name      : 'Invalid Select Field',
        data_type : 'single_select',
      });
      expect(invalidCreate.status).toBe(422);

      const invalidUpdate = await handleShimRequest(ctx, orgUrl(`/issue-fields/${created.id}`), 'PATCH', {
        visibility: 'private',
      });
      expect(invalidUpdate.status).toBe(422);

      const missingOrg = await handleShimRequest(ctx, url('/orgs/missing-org/issue-fields'));
      expect(missingOrg.status).toBe(404);

      const deleted = await handleShimRequest(ctx, orgUrl(`/issue-fields/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, orgUrl(`/issue-fields/${created.id}`), 'PATCH', {
        name: 'Missing Field',
      });
      expect(missing.status).toBe(404);
    });

    it('should create, list, update, and delete organization issue types', async () => {
      const initial = await handleShimRequest(ctx, orgUrl('/issue-types'));
      expect(initial.status).toBe(200);
      expect(Array.isArray(parse(initial))).toBe(true);

      const createdRes = await handleShimRequest(ctx, orgUrl('/issue-types'), 'POST', {
        name        : 'Lifecycle Epic',
        description : 'Multi-week tracking of work',
        is_enabled  : true,
        color       : 'green',
      });
      expect(createdRes.status).toBe(200);
      const created = parse(createdRes);
      expect(created.name).toBe('Lifecycle Epic');
      expect(created.description).toBe('Multi-week tracking of work');
      expect(created.is_enabled).toBe(true);
      expect(created.color).toBe('green');
      expect(created.id).toBeGreaterThan(0);
      expect(created.created_at).toBeDefined();

      const list = parse(await handleShimRequest(ctx, orgUrl('/issue-types')));
      expect(list.some((issueType: any) => issueType.id === created.id)).toBe(true);

      const duplicate = await handleShimRequest(ctx, orgUrl('/issue-types'), 'POST', {
        name       : 'Lifecycle Epic',
        is_enabled : true,
      });
      expect(duplicate.status).toBe(422);

      const updatedRes = await handleShimRequest(ctx, orgUrl(`/issue-types/${created.id}`), 'PUT', {
        name        : 'Lifecycle Initiative',
        description : null,
        is_enabled  : false,
        color       : 'orange',
      });
      expect(updatedRes.status).toBe(200);
      const updated = parse(updatedRes);
      expect(updated.name).toBe('Lifecycle Initiative');
      expect(updated.description).toBeNull();
      expect(updated.is_enabled).toBe(false);
      expect(updated.color).toBe('orange');

      const invalid = await handleShimRequest(ctx, orgUrl(`/issue-types/${created.id}`), 'PUT', {
        name       : 'Bad',
        is_enabled : true,
        color      : 'teal',
      });
      expect(invalid.status).toBe(422);

      const missingOrg = await handleShimRequest(ctx, url('/orgs/missing-org/issue-types'));
      expect(missingOrg.status).toBe(404);

      const deleted = await handleShimRequest(ctx, orgUrl(`/issue-types/${created.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, orgUrl(`/issue-types/${created.id}`), 'PUT', {
        name       : 'Missing',
        is_enabled : true,
      });
      expect(missing.status).toBe(404);
    });

    it('should manage organization custom property schemas and repository values', async () => {
      const initial = await handleShimRequest(ctx, orgUrl('/properties/schema'));
      expect(initial.status).toBe(200);
      expect(Array.isArray(parse(initial))).toBe(true);

      const batch = await handleShimRequest(ctx, orgUrl('/properties/schema'), 'PATCH', {
        properties: [
          {
            property_name           : 'environment',
            value_type              : 'single_select',
            required                : true,
            default_value           : 'production',
            description             : 'Deployment environment',
            allowed_values          : ['production', 'development'],
            values_editable_by      : 'org_and_repo_actors',
            require_explicit_values : true,
          },
          {
            property_name : 'service',
            value_type    : 'string',
            description   : 'Service owner',
          },
        ],
      });
      expect(batch.status).toBe(200);
      const created = parse(batch);
      const environment = created.find((property: any) => property.property_name === 'environment');
      expect(environment.value_type).toBe('single_select');
      expect(environment.source_type).toBe('organization');
      expect(environment.url).toContain(`/orgs/${ORG_NAME}/properties/schema/environment`);
      expect(environment.allowed_values).toEqual(['production', 'development']);
      expect(environment.values_editable_by).toBe('org_and_repo_actors');
      expect(environment.require_explicit_values).toBe(true);

      const fetched = await handleShimRequest(ctx, orgUrl('/properties/schema/environment'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).default_value).toBe('production');

      const urlProperty = await handleShimRequest(ctx, orgUrl('/properties/schema/docs_url'), 'PUT', {
        value_type         : 'url',
        description        : 'Documentation URL',
        default_value      : 'https://docs.example.com',
        values_editable_by : null,
      });
      expect(urlProperty.status).toBe(200);
      expect(parse(urlProperty).value_type).toBe('url');
      expect(parse(urlProperty).values_editable_by).toBeNull();

      const invalidDefinition = await handleShimRequest(ctx, orgUrl('/properties/schema/bad'), 'PUT', {
        value_type: 'integer',
      });
      expect(invalidDefinition.status).toBe(422);

      const updateValues = await handleShimRequest(ctx, orgUrl('/properties/values'), 'PATCH', {
        repository_names : ['test-repo', CONTRIBUTORS_REPO_NAME],
        properties       : [
          { property_name: 'environment', value: 'production' },
          { property_name: 'docs_url', value: 'https://docs.example.com/test-repo' },
        ],
      });
      expect(updateValues.status).toBe(204);

      const listValues = await handleShimRequest(ctx, orgUrl('/properties/values'));
      expect(listValues.status).toBe(200);
      const testRepoValues = parse(listValues).find((item: any) => item.repository_name === 'test-repo');
      expect(testRepoValues.repository_full_name).toBe(`${testDid}/test-repo`);
      expect(testRepoValues.properties).toContainEqual({ property_name: 'environment', value: 'production' });
      expect(testRepoValues.properties).toContainEqual({ property_name: 'docs_url', value: 'https://docs.example.com/test-repo' });

      const filteredValues = parse(await handleShimRequest(ctx, orgUrl(`/properties/values?repository_query=${CONTRIBUTORS_REPO_NAME}`)));
      expect(filteredValues.map((item: any) => item.repository_name)).toEqual([CONTRIBUTORS_REPO_NAME]);

      const invalidValue = await handleShimRequest(ctx, orgUrl('/properties/values'), 'PATCH', {
        repository_names : ['test-repo'],
        properties       : [{ property_name: 'environment', value: 'staging' }],
      });
      expect(invalidValue.status).toBe(422);

      const clearValues = await handleShimRequest(ctx, orgUrl('/properties/values'), 'PATCH', {
        repository_names : ['test-repo', CONTRIBUTORS_REPO_NAME],
        properties       : [
          { property_name: 'environment', value: null },
          { property_name: 'docs_url', value: null },
        ],
      });
      expect(clearValues.status).toBe(204);

      const afterClear = parse(await handleShimRequest(ctx, orgUrl('/properties/values')))
        .find((item: any) => item.repository_name === 'test-repo');
      expect(afterClear.properties).not.toContainEqual({ property_name: 'environment', value: 'production' });
      expect(afterClear.properties).not.toContainEqual({ property_name: 'docs_url', value: 'https://docs.example.com/test-repo' });

      const deleteUrl = await handleShimRequest(ctx, orgUrl('/properties/schema/docs_url'), 'DELETE');
      expect(deleteUrl.status).toBe(204);
      const missingUrl = await handleShimRequest(ctx, orgUrl('/properties/schema/docs_url'));
      expect(missingUrl.status).toBe(404);

      const deleteEnvironment = await handleShimRequest(ctx, orgUrl('/properties/schema/environment'), 'DELETE');
      expect(deleteEnvironment.status).toBe(204);
      const deleteService = await handleShimRequest(ctx, orgUrl('/properties/schema/service'), 'DELETE');
      expect(deleteService.status).toBe(204);

      const missingOrg = await handleShimRequest(ctx, url('/orgs/missing-org/properties/schema'));
      expect(missingOrg.status).toBe(404);
    });

    it('should list repository security advisories for an organization', async () => {
      await mergeRepoSettings({
        securityAdvisories: {
          'GHSA-ORG1-0001-0002': {
            ghsaId          : 'GHSA-ORG1-0001-0002',
            cveId           : 'CVE-2026-1001',
            summary         : 'Organization advisory fixture',
            description     : 'A published advisory visible through the organization route.',
            severity        : 'medium',
            state           : 'published',
            authorDid       : testDid,
            publisherDid    : testDid,
            createdAt       : '2026-01-01T00:00:00.000Z',
            updatedAt       : '2026-01-02T00:00:00.000Z',
            publishedAt     : '2026-01-02T00:00:00.000Z',
            vulnerabilities : [
              {
                package                  : { ecosystem: 'npm', name: 'org-package' },
                vulnerable_version_range : '< 2.0.0',
                patched_versions         : '2.0.0',
              },
            ],
          },
          'GHSA-ORG1-0003-0004': {
            ghsaId      : 'GHSA-ORG1-0003-0004',
            summary     : 'Draft organization advisory fixture',
            description : 'A draft advisory used to verify state filters.',
            severity    : 'low',
            state       : 'draft',
            authorDid   : testDid,
            createdAt   : '2026-01-03T00:00:00.000Z',
            updatedAt   : '2026-01-03T00:00:00.000Z',
          },
        },
      });

      const listRes = await handleShimRequest(
        ctx,
        orgUrl('/security-advisories?state=published,draft&sort=created&direction=asc&per_page=1'),
      );
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const firstPage = parse(listRes);
      expect(firstPage).toHaveLength(1);
      expect(firstPage[0].ghsa_id).toBe('GHSA-ORG1-0001-0002');
      expect(firstPage[0].url).toContain(`/repos/${testDid}/test-repo/security-advisories/GHSA-ORG1-0001-0002`);
      expect(firstPage[0].publisher.login).toBe(testDid);
      expect(firstPage[0].vulnerabilities[0].package.name).toBe('org-package');

      const publishedRes = await handleShimRequest(ctx, orgUrl('/security-advisories?state=published'));
      expect(publishedRes.status).toBe(200);
      expect(parse(publishedRes).map((advisory: any) => advisory.ghsa_id)).toEqual(['GHSA-ORG1-0001-0002']);

      const invalidStateRes = await handleShimRequest(ctx, orgUrl('/security-advisories?state=invalid'));
      expect(invalidStateRes.status).toBe(422);

      const missingOrgRes = await handleShimRequest(ctx, url('/orgs/missing-org/security-advisories'));
      expect(missingOrgRes.status).toBe(404);
    });

    it('should list code scanning alerts for an organization', async () => {
      await mergeRepoSettings({
        codeScanningAlerts: {
          '11': {
            number : 11,
            state  : 'open',
            rule   : {
              id                      : 'js/path-traversal',
              severity                : 'error',
              security_severity_level : 'high',
              description             : 'Path traversal from user input',
              name                    : 'js/path-traversal',
              tags                    : ['security', 'external/cwe/cwe-022'],
            },
            tool: {
              name    : 'CodeQL',
              guid    : null,
              version : '2.17.0',
            },
            mostRecentInstance: {
              ref             : 'refs/heads/main',
              analysisKey     : 'codeql',
              category        : 'codeql',
              environment     : '{}',
              state           : 'open',
              commitSha       : MAIN_SHA,
              message         : { text: 'User-controlled path reaches the filesystem.' },
              location        : { path: 'src/archive.ts', start_line: 12, end_line: 12 },
              classifications : ['source'],
            },
            assignees : [TRIAGER_DID],
            createdAt : '2026-05-01T00:00:00.000Z',
            updatedAt : '2026-05-02T00:00:00.000Z',
          },
          '12': {
            number : 12,
            state  : 'fixed',
            rule   : {
              id                      : 'ts/hardcoded-secret',
              severity                : 'warning',
              security_severity_level : 'medium',
              description             : 'Hardcoded secret in configuration',
              name                    : 'ts/hardcoded-secret',
            },
            tool: {
              name    : 'Semgrep',
              guid    : 'semgrep-guid',
              version : '1.70.0',
            },
            mostRecentInstance: {
              ref         : 'refs/heads/main',
              analysisKey : 'semgrep',
              category    : 'semgrep',
              environment : '{}',
              state       : 'fixed',
              commitSha   : TAG_SHA,
              message     : { text: 'The secret was removed.' },
              location    : { path: 'src/config.ts', start_line: 4, end_line: 4 },
            },
            createdAt : '2026-05-03T00:00:00.000Z',
            updatedAt : '2026-05-04T00:00:00.000Z',
            fixedAt   : '2026-05-04T00:00:00.000Z',
          },
          '13': {
            number : 13,
            state  : 'open',
            rule   : {
              id                      : 'js/non-default-branch',
              severity                : 'error',
              security_severity_level : 'high',
              description             : 'Alert from a non-default branch',
              name                    : 'js/non-default-branch',
            },
            tool: {
              name    : 'CodeQL',
              guid    : null,
              version : '2.17.0',
            },
            mostRecentInstance: {
              ref         : 'refs/heads/feature',
              analysisKey : 'codeql',
              category    : 'codeql',
              environment : '{}',
              state       : 'open',
              commitSha   : FEATURE_SHA,
              message     : { text: 'Only default branch alerts are listed.' },
              location    : { path: 'src/feature.ts', start_line: 2, end_line: 2 },
            },
            assignees : [TRIAGER_DID],
            createdAt : '2026-05-05T00:00:00.000Z',
            updatedAt : '2026-05-05T00:00:00.000Z',
          },
        },
      });

      const listRes = await handleShimRequest(
        ctx,
        orgUrl('/code-scanning/alerts?state=open&severity=high&tool_name=CodeQL&assignees=*&per_page=1'),
      );
      expect(listRes.status).toBe(200);
      const list = parse(listRes);
      expect(list).toHaveLength(1);
      expect(list[0].number).toBe(11);
      expect(list[0].repository.full_name).toBe(`${testDid}/test-repo`);
      expect(list[0].instances_url).toContain(`/repos/${testDid}/test-repo/code-scanning/alerts/11/instances`);
      expect(list[0].assignees[0].login).toBe(TRIAGER_DID);

      const pagedRes = await handleShimRequest(
        ctx,
        orgUrl('/code-scanning/alerts?state=open,fixed&sort=created&direction=asc&per_page=1'),
      );
      expect(pagedRes.status).toBe(200);
      expect(pagedRes.headers.Link).toContain('rel="next"');
      expect(parse(pagedRes).map((alert: any) => alert.number)).toEqual([11]);

      const fixedRes = await handleShimRequest(ctx, orgUrl('/code-scanning/alerts?state=fixed&tool_guid=semgrep-guid'));
      expect(fixedRes.status).toBe(200);
      expect(parse(fixedRes).map((alert: any) => alert.number)).toEqual([12]);

      const invalidFilterRes = await handleShimRequest(ctx, orgUrl('/code-scanning/alerts?tool_name=CodeQL&tool_guid=guid'));
      expect(invalidFilterRes.status).toBe(422);

      const missingOrgRes = await handleShimRequest(ctx, url('/orgs/missing-org/code-scanning/alerts'));
      expect(missingOrgRes.status).toBe(404);
    });

    it('should list secret scanning alerts for an organization', async () => {
      await mergeRepoSettings({
        secretScanningAlerts: {
          '21': {
            number                : 21,
            state                 : 'open',
            secretType            : 'github_personal_access_token',
            secretTypeDisplayName : 'GitHub Personal Access Token',
            secret                : 'ghp_orgsecret',
            provider              : 'GitHub',
            providerSlug          : 'github_secret_scanning',
            createdAt             : '2026-06-01T00:00:00.000Z',
            updatedAt             : '2026-06-02T00:00:00.000Z',
            validity              : 'active',
            publiclyLeaked        : true,
            multiRepo             : false,
            assignedTo            : TRIAGER_DID,
            locations             : [
              {
                type    : 'commit',
                details : {
                  path       : 'src/secrets.ts',
                  start_line : 1,
                  end_line   : 1,
                  blob_sha   : MAIN_SHA,
                  commit_sha : MAIN_SHA,
                },
              },
            ],
          },
          '22': {
            number                   : 22,
            state                    : 'resolved',
            secretType               : 'adafruit_io_key',
            secretTypeDisplayName    : 'Adafruit IO Key',
            secret                   : 'aio_orgsecret',
            provider                 : 'Adafruit',
            providerSlug             : 'adafruit',
            createdAt                : '2026-06-03T00:00:00.000Z',
            updatedAt                : '2026-06-04T00:00:00.000Z',
            resolution               : 'false_positive',
            resolvedAt               : '2026-06-04T00:00:00.000Z',
            resolvedBy               : testDid,
            validity                 : 'inactive',
            publiclyLeaked           : false,
            multiRepo                : true,
            pushProtectionBypassed   : true,
            pushProtectionBypassedBy : TRIAGER_DID,
            pushProtectionBypassedAt : '2026-06-03T01:00:00.000Z',
          },
        },
      });

      const listRes = await handleShimRequest(
        ctx,
        orgUrl('/secret-scanning/alerts?state=open&secret_type=github_personal_access_token&providers=github_secret_scanning&validity=active&is_publicly_leaked=true&assignee=*&hide_secret=true'),
      );
      expect(listRes.status).toBe(200);
      const list = parse(listRes);
      expect(list).toHaveLength(1);
      expect(list[0].number).toBe(21);
      expect(list[0].secret).toBe('********');
      expect(list[0].repository.full_name).toBe(`${testDid}/test-repo`);
      expect(list[0].locations_url).toContain(`/repos/${testDid}/test-repo/secret-scanning/alerts/21/locations`);
      expect(list[0].assigned_to.login).toBe(TRIAGER_DID);

      const pagedRes = await handleShimRequest(
        ctx,
        orgUrl('/secret-scanning/alerts?state=open,resolved&sort=created&direction=asc&per_page=1'),
      );
      expect(pagedRes.status).toBe(200);
      expect(pagedRes.headers.Link).toContain('rel="next"');
      expect(parse(pagedRes).map((alert: any) => alert.number)).toEqual([21]);

      const bypassedRes = await handleShimRequest(ctx, orgUrl('/secret-scanning/alerts?state=resolved&resolution=false_positive&is_bypassed=true'));
      expect(bypassedRes.status).toBe(200);
      expect(parse(bypassedRes).map((alert: any) => alert.number)).toEqual([22]);

      const invalidFilterRes = await handleShimRequest(ctx, orgUrl('/secret-scanning/alerts?secret_type=a&exclude_secret_types=b'));
      expect(invalidFilterRes.status).toBe(422);

      const invalidHideSecretRes = await handleShimRequest(ctx, orgUrl('/secret-scanning/alerts?hide_secret=maybe'));
      expect(invalidHideSecretRes.status).toBe(422);

      const missingOrgRes = await handleShimRequest(ctx, url('/orgs/missing-org/secret-scanning/alerts'));
      expect(missingOrgRes.status).toBe(404);
    });

    it('should list Dependabot alerts for an organization', async () => {
      await mergeRepoSettings({
        dependabotAlerts: {
          '31': {
            number     : 31,
            state      : 'open',
            dependency : {
              package      : { ecosystem: 'npm', name: 'lodash' },
              manifestPath : 'package-lock.json',
              scope        : 'runtime',
            },
            securityAdvisory: {
              ghsa_id        : 'GHSA-org-lodash',
              cve_id         : 'CVE-2026-2001',
              summary        : 'Prototype pollution in lodash',
              description    : 'A crafted payload can modify object prototypes.',
              severity       : 'high',
              classification : 'general',
              epss           : { percentage: 0.82, percentile: '0.97' },
            },
            securityVulnerability: {
              package                  : { ecosystem: 'npm', name: 'lodash' },
              severity                 : 'high',
              vulnerable_version_range : '< 4.17.21',
              first_patched_version    : { identifier: '4.17.21' },
            },
            assignees : [TRIAGER_DID],
            createdAt : '2026-06-05T00:00:00.000Z',
            updatedAt : '2026-06-06T00:00:00.000Z',
          },
          '32': {
            number     : 32,
            state      : 'fixed',
            dependency : {
              package      : { ecosystem: 'pip', name: 'django' },
              manifestPath : 'requirements.txt',
              scope        : 'development',
            },
            securityAdvisory: {
              ghsa_id        : 'GHSA-org-django',
              summary        : 'Information exposure in django',
              description    : 'A diagnostic endpoint leaks metadata.',
              severity       : 'medium',
              classification : 'general',
              epss           : { percentage: 0.05, percentile: '0.20' },
            },
            securityVulnerability: {
              package                  : { ecosystem: 'pip', name: 'django' },
              severity                 : 'medium',
              vulnerable_version_range : '< 4.2.1',
              first_patched_version    : null,
            },
            createdAt : '2026-06-07T00:00:00.000Z',
            updatedAt : '2026-06-08T00:00:00.000Z',
            fixedAt   : '2026-06-08T00:00:00.000Z',
          },
        },
      });

      const filteredRes = await handleShimRequest(
        ctx,
        orgUrl('/dependabot/alerts?state=open&severity=high&ecosystem=npm&package=lodash&manifest=package-lock.json&has=patch&assignee=*&epss_percentage=%3E%3D0.8'),
      );
      expect(filteredRes.status).toBe(200);
      const filtered = parse(filteredRes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].number).toBe(31);
      expect(filtered[0].repository.full_name).toBe(`${testDid}/test-repo`);
      expect(filtered[0].security_advisory.epss.percentage).toBe(0.82);
      expect(filtered[0].assignees[0].login).toBe(TRIAGER_DID);

      const pagedRes = await handleShimRequest(
        ctx,
        orgUrl('/dependabot/alerts?state=open,fixed&sort=created&direction=asc&per_page=1'),
      );
      expect(pagedRes.status).toBe(200);
      expect(pagedRes.headers.Link).toContain('rel="next"');
      expect(parse(pagedRes).map((alert: any) => alert.number)).toEqual([31]);

      const fixedRes = await handleShimRequest(ctx, orgUrl('/dependabot/alerts?state=fixed&scope=development&epss_percentage=0..0.1'));
      expect(fixedRes.status).toBe(200);
      expect(parse(fixedRes).map((alert: any) => alert.number)).toEqual([32]);

      const invalidFilterRes = await handleShimRequest(ctx, orgUrl('/dependabot/alerts?epss_percentage=2'));
      expect(invalidFilterRes.status).toBe(422);

      const missingOrgRes = await handleShimRequest(ctx, url('/orgs/missing-org/dependabot/alerts'));
      expect(missingOrgRes.status).toBe(404);
    });

    it('should create, list, get, ping, and delete organization webhooks', async () => {
      const initial = await handleShimRequest(ctx, orgUrl('/hooks'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const create = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        name   : 'web',
        active : true,
        events : ['push', 'repository'],
        config : {
          url          : 'https://example.com/org-hook',
          content_type : 'json',
          insecure_ssl : '0',
          secret       : 'org-secret',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);
      expect(hook.type).toBe('Organization');
      expect(hook.name).toBe('web');
      expect(hook.active).toBe(true);
      expect(hook.events).toEqual(['push', 'repository']);
      expect(hook.config.url).toBe('https://example.com/org-hook');
      expect(hook.config.secret).toBeUndefined();
      expect(hook.url).toContain(`/orgs/${ORG_NAME}/hooks/`);
      expect(hook.ping_url).toBe(`${hook.url}/pings`);
      expect(hook.deliveries_url).toBe(`${hook.url}/deliveries`);

      const list = await handleShimRequest(ctx, orgUrl('/hooks'));
      expect(parse(list).map((item: any) => item.id)).toContain(hook.id);

      const fetched = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).id).toBe(hook.id);

      const config = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/config`));
      expect(config.status).toBe(200);
      expect(parse(config).secret).toBe('********');

      const ping = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/pings`), 'POST');
      expect(ping.status).toBe(204);

      const deleted = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`));
      expect(missing.status).toBe(404);
    });

    it('should list, get, and redeliver organization webhook deliveries', async () => {
      const create = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        active : true,
        events : ['push'],
        config : {
          url    : 'https://example.com/org-deliveries',
          secret : 'org-delivery-secret',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);

      const initial = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries`));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const ping = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/pings`), 'POST');
      expect(ping.status).toBe(204);

      const list = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries`));
      expect(list.status).toBe(200);
      const deliveries = parse(list);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].event).toBe('ping');
      expect(deliveries[0].status).toBe('OK');

      const detail = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries/${deliveries[0].id}`));
      expect(detail.status).toBe(200);
      const detailed = parse(detail);
      expect(detailed.url).toBe('https://example.com/org-deliveries');
      expect(detailed.request.headers['X-GitHub-Hook-Installation-Target-Type']).toBe('organization');
      expect(detailed.request.payload.organization.login).toBe(ORG_NAME);

      const redeliver = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries/${deliveries[0].id}/attempts`), 'POST');
      expect(redeliver.status).toBe(202);

      const afterRedelivery = parse(await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries`)));
      expect(afterRedelivery).toHaveLength(2);
      expect(afterRedelivery.find((delivery: any) => delivery.redelivery === true).guid).toBe(deliveries[0].guid);

      const missing = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/deliveries/999999/attempts`), 'POST');
      expect(missing.status).toBe(404);

      const deleted = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
    });

    it('should update organization webhooks and webhook configuration', async () => {
      const create = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        active : true,
        events : ['push'],
        config : {
          url    : 'https://example.com/org-original',
          secret : 'alpha',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);

      const update = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`), 'PATCH', {
        active        : false,
        add_events    : ['membership'],
        remove_events : ['push'],
        config        : {
          url          : 'https://example.com/org-updated',
          content_type : 'json',
          secret       : 'beta',
        },
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.active).toBe(false);
      expect(updated.events).toEqual(['membership']);
      expect(updated.config.url).toBe('https://example.com/org-updated');

      const config = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}/config`), 'PATCH', {
        url    : 'https://example.com/org-config',
        secret : 'gamma',
      });
      expect(config.status).toBe(200);
      expect(parse(config).url).toBe('https://example.com/org-config');
      expect(parse(config).secret).toBe('********');

      const fetched = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`));
      expect(parse(fetched).config.url).toBe('https://example.com/org-config');

      const deleted = await handleShimRequest(ctx, orgUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
    });

    it('should reject invalid organization webhook payloads and missing hooks', async () => {
      const missingConfig = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        events: ['push'],
      });
      expect(missingConfig.status).toBe(422);

      const invalidName = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        name   : 'email',
        config : { url: 'https://example.com/org-hook' },
      });
      expect(invalidName.status).toBe(422);

      const invalidUrl = await handleShimRequest(ctx, orgUrl('/hooks'), 'POST', {
        config: { url: 'not-a-url' },
      });
      expect(invalidUrl.status).toBe(422);

      const missingOrg = await handleShimRequest(ctx, url('/orgs/missing-org/hooks'));
      expect(missingOrg.status).toBe(404);

      const get = await handleShimRequest(ctx, orgUrl('/hooks/999999'));
      expect(get.status).toBe(404);

      const config = await handleShimRequest(ctx, orgUrl('/hooks/999999/config'));
      expect(config.status).toBe(404);

      const ping = await handleShimRequest(ctx, orgUrl('/hooks/999999/pings'), 'POST');
      expect(ping.status).toBe(404);
    });

    it('should list organization members with role filters and pagination', async () => {
      const paged = await handleShimRequest(ctx, orgUrl('/members?per_page=2'));
      expect(paged.status).toBe(200);
      expect(parse(paged)).toHaveLength(2);
      expect(paged.headers.Link).toContain('rel="next"');

      const admins = parse(await handleShimRequest(ctx, orgUrl('/members?role=admin')));
      expect(admins.map((item: any) => item.login)).toEqual([testDid]);

      const members = parse(await handleShimRequest(ctx, orgUrl('/members?role=member')));
      expect(members.map((item: any) => item.login)).toContain(ORG_MEMBER_DID);
      expect(members.map((item: any) => item.login)).toContain(ORG_REMOVED_MEMBER_DID);
    });

    it('should expose public members and membership checks', async () => {
      const publicMembers = await handleShimRequest(ctx, orgUrl('/public_members'));
      expect(publicMembers.status).toBe(200);
      expect(parse(publicMembers).map((item: any) => item.login)).toContain(ORG_MEMBER_DID);

      const publicMember = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(publicMember.status).toBe(204);

      const conceal = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(ORG_MEMBER_DID)}`), 'DELETE');
      expect(conceal.status).toBe(204);

      const concealedPublicMember = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(concealedPublicMember.status).toBe(404);

      const afterConceal = parse(await handleShimRequest(ctx, orgUrl('/public_members')));
      expect(afterConceal.map((item: any) => item.login)).not.toContain(ORG_MEMBER_DID);

      const stillMember = await handleShimRequest(ctx, orgUrl(`/members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(stillMember.status).toBe(204);

      const publicize = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(ORG_MEMBER_DID)}`), 'PUT');
      expect(publicize.status).toBe(204);

      const afterPublicize = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(afterPublicize.status).toBe(204);

      const existing = await handleShimRequest(ctx, orgUrl(`/members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(existing.status).toBe(204);

      const missing = await handleShimRequest(ctx, orgUrl('/members/did%3Ajwk%3Aunknownmember'));
      expect(missing.status).toBe(404);

      const missingPublic = await handleShimRequest(ctx, orgUrl('/public_members/did%3Ajwk%3Aunknownmember'));
      expect(missingPublic.status).toBe(404);
    });

    it('should list, convert, and remove outside collaborators', async () => {
      const initial = parse(await handleShimRequest(ctx, orgUrl('/outside_collaborators')));
      expect(initial.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(initial.map((item: any) => item.login)).toContain(TRIAGER_DID);
      expect(initial.map((item: any) => item.login)).not.toContain(ORG_MEMBER_DID);
      expect(initial.find((item: any) => item.login === MAINTAINER_DID).name).toBe('Alice');

      const twoFactorFiltered = parse(await handleShimRequest(ctx, orgUrl('/outside_collaborators?filter=2fa_disabled')));
      expect(twoFactorFiltered).toEqual([]);

      const invalidFilter = await handleShimRequest(ctx, orgUrl('/outside_collaborators?filter=unknown'));
      expect(invalidFilter.status).toBe(422);

      const directDid = 'did:jwk:outside-direct';
      const encodedDirectDid = encodeURIComponent(directDid);
      const addDirect = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDirectDid}`), 'PUT', {
        permission : 'triage',
        alias      : 'Outside Direct',
      });
      expect(addDirect.status).toBe(201);

      const withDirect = parse(await handleShimRequest(ctx, orgUrl('/outside_collaborators')));
      expect(withDirect.map((item: any) => item.login)).toContain(directDid);

      const removeDirect = await handleShimRequest(ctx, orgUrl(`/outside_collaborators/${encodedDirectDid}`), 'DELETE');
      expect(removeDirect.status).toBe(204);

      const directPermission = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDirectDid}/permission`));
      expect(directPermission.status).toBe(404);

      const convertDid = 'did:jwk:outside-convert';
      const encodedConvertDid = encodeURIComponent(convertDid);
      const createMember = await handleShimRequest(ctx, orgUrl(`/memberships/${encodedConvertDid}`), 'PUT', {
        role  : 'member',
        alias : 'Outside Convert',
      });
      expect(createMember.status).toBe(200);

      const createTeam = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name        : 'Outside Collaborator Team',
        description : 'Repo access for conversion coverage',
        privacy     : 'closed',
      });
      expect(createTeam.status).toBe(201);
      const team = parse(createTeam);

      const grantRepo = await handleShimRequest(
        ctx,
        orgUrl(`/teams/${team.slug}/repos/${encodeURIComponent(testDid)}/test-repo`),
        'PUT',
        { permission: 'push' },
      );
      expect(grantRepo.status).toBe(204);

      const addTeamMember = await handleShimRequest(
        ctx,
        orgUrl(`/teams/${team.slug}/memberships/${encodedConvertDid}`),
        'PUT',
        { role: 'member' },
      );
      expect(addTeamMember.status).toBe(200);
      expect(parse(addTeamMember).state).toBe('active');

      const convert = await handleShimRequest(ctx, orgUrl(`/outside_collaborators/${encodedConvertDid}`), 'PUT');
      expect(convert.status).toBe(204);

      const memberCheck = await handleShimRequest(ctx, orgUrl(`/members/${encodedConvertDid}`));
      expect(memberCheck.status).toBe(404);

      const preservedTeamAccess = await handleShimRequest(ctx, orgUrl(`/teams/${team.slug}/members/${encodedConvertDid}`));
      expect(preservedTeamAccess.status).toBe(204);

      const afterConvert = parse(await handleShimRequest(ctx, orgUrl('/outside_collaborators')));
      expect(afterConvert.map((item: any) => item.login)).toContain(convertDid);

      const removeConverted = await handleShimRequest(ctx, orgUrl(`/outside_collaborators/${encodedConvertDid}`), 'DELETE');
      expect(removeConverted.status).toBe(204);

      const removedTeamAccess = await handleShimRequest(ctx, orgUrl(`/teams/${team.slug}/members/${encodedConvertDid}`));
      expect(removedTeamAccess.status).toBe(404);

      const convertLastOwner = await handleShimRequest(ctx, orgUrl(`/outside_collaborators/${encodeURIComponent(testDid)}`), 'PUT');
      expect(convertLastOwner.status).toBe(403);

      const removeMember = await handleShimRequest(ctx, orgUrl(`/outside_collaborators/${encodeURIComponent(ORG_MEMBER_DID)}`), 'DELETE');
      expect(removeMember.status).toBe(422);

      const missingOrg = await handleShimRequest(ctx, url('/orgs/missing-org/outside_collaborators'));
      expect(missingOrg.status).toBe(404);

      const deleteTeam = await handleShimRequest(ctx, orgUrl(`/teams/${team.slug}`), 'DELETE');
      expect(deleteTeam.status).toBe(204);
    });

    it('should get and set organization membership details', async () => {
      const ownerMembership = await handleShimRequest(ctx, orgUrl(`/memberships/${encodeURIComponent(testDid)}`));
      expect(ownerMembership.status).toBe(200);
      const ownerData = parse(ownerMembership);
      expect(ownerData.state).toBe('active');
      expect(ownerData.role).toBe('admin');
      expect(ownerData.direct_membership).toBe(true);
      expect(ownerData.enterprise_teams_providing_indirect_membership).toEqual([]);
      expect(ownerData.organization.login).toBe(ORG_NAME);
      expect(ownerData.user.login).toBe(testDid);

      const missing = await handleShimRequest(ctx, orgUrl('/memberships/did%3Ajwk%3Aunknownmember'));
      expect(missing.status).toBe(404);

      const invalidRole = await handleShimRequest(ctx, orgUrl('/memberships/did%3Ajwk%3Ainvalidrole'), 'PUT', {
        role: 'owner',
      });
      expect(invalidRole.status).toBe(422);

      const memberDid = 'did:jwk:orgmembershipwriter';
      const memberPath = `/memberships/${encodeURIComponent(memberDid)}`;
      const created = await handleShimRequest(ctx, orgUrl(memberPath), 'PUT', {
        role  : 'member',
        alias : 'Writable Member',
      });
      expect(created.status).toBe(200);
      expect(parse(created).role).toBe('member');

      const concealCreated = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(memberDid)}`), 'DELETE');
      expect(concealCreated.status).toBe(204);

      const memberCheck = await handleShimRequest(ctx, orgUrl(`/members/${encodeURIComponent(memberDid)}`));
      expect(memberCheck.status).toBe(204);

      const promoted = await handleShimRequest(ctx, orgUrl(memberPath), 'PUT', { role: 'admin' });
      expect(promoted.status).toBe(200);
      expect(parse(promoted).role).toBe('admin');

      const promotedPublicCheck = await handleShimRequest(ctx, orgUrl(`/public_members/${encodeURIComponent(memberDid)}`));
      expect(promotedPublicCheck.status).toBe(404);

      const admins = parse(await handleShimRequest(ctx, orgUrl('/members?role=admin')));
      expect(admins.map((item: any) => item.login)).toContain(memberDid);

      const removed = await handleShimRequest(ctx, orgUrl(memberPath), 'DELETE');
      expect(removed.status).toBe(204);

      const afterRemove = await handleShimRequest(ctx, orgUrl(memberPath));
      expect(afterRemove.status).toBe(404);
    });

    it('should list and update authenticated user organization memberships', async () => {
      const list = await handleShimRequest(ctx, url('/user/memberships/orgs'));
      expect(list.status).toBe(200);
      const membership = parse(list).find((item: any) => item.organization.login === ORG_NAME);
      expect(membership.state).toBe('active');
      expect(membership.role).toBe('admin');
      expect(membership.user.login).toBe(testDid);

      const active = await handleShimRequest(ctx, url('/user/memberships/orgs?state=active'));
      expect(active.status).toBe(200);
      expect(parse(active).some((item: any) => item.organization.login === ORG_NAME)).toBe(true);

      const pending = await handleShimRequest(ctx, url('/user/memberships/orgs?state=pending'));
      expect(pending.status).toBe(200);
      expect(parse(pending)).toEqual([]);

      const invalidState = await handleShimRequest(ctx, url('/user/memberships/orgs?state=suspended'));
      expect(invalidState.status).toBe(422);

      const detail = await handleShimRequest(ctx, url(`/user/memberships/orgs/${encodeURIComponent(ORG_NAME)}`));
      expect(detail.status).toBe(200);
      expect(parse(detail).organization.login).toBe(ORG_NAME);

      const updated = await handleShimRequest(ctx, url(`/user/memberships/orgs/${encodeURIComponent(ORG_NAME)}`), 'PATCH', {
        state: 'active',
      });
      expect(updated.status).toBe(200);
      expect(parse(updated).state).toBe('active');

      const invalidUpdate = await handleShimRequest(ctx, url(`/user/memberships/orgs/${encodeURIComponent(ORG_NAME)}`), 'PATCH', {
        state: 'pending',
      });
      expect(invalidUpdate.status).toBe(422);

      const missing = await handleShimRequest(ctx, url('/user/memberships/orgs/missing-org'));
      expect(missing.status).toBe(404);
    });

    it('should remove organization membership records', async () => {
      const transientDid = 'did:jwk:orgmemberdeleteroute';
      const transientMembershipPath = `/memberships/${encodeURIComponent(transientDid)}`;
      const transientCreate = await handleShimRequest(ctx, orgUrl(transientMembershipPath), 'PUT', { role: 'member' });
      expect(transientCreate.status).toBe(200);

      const memberDelete = await handleShimRequest(ctx, orgUrl(`/members/${encodeURIComponent(transientDid)}`), 'DELETE');
      expect(memberDelete.status).toBe(204);

      const memberDeleteCheck = await handleShimRequest(ctx, orgUrl(transientMembershipPath));
      expect(memberDeleteCheck.status).toBe(404);

      const memberPath = `/members/${encodeURIComponent(ORG_REMOVED_MEMBER_DID)}`;
      const membershipPath = `/memberships/${encodeURIComponent(ORG_REMOVED_MEMBER_DID)}`;

      const removed = await handleShimRequest(ctx, orgUrl(membershipPath), 'DELETE');
      expect(removed.status).toBe(204);

      const check = await handleShimRequest(ctx, orgUrl(memberPath));
      expect(check.status).toBe(404);
    });

    it('should list, create, and get organization teams', async () => {
      const list = await handleShimRequest(ctx, orgUrl('/teams'));
      expect(list.status).toBe(200);
      const teams = parse(list);
      const core = teams.find((item: any) => item.slug === 'core-team');
      expect(core.name).toBe('Core Team');
      expect(core.privacy).toBe('closed');

      const created = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name        : 'Ops Team',
        description : 'Operations automation',
        privacy     : 'secret',
      });
      expect(created.status).toBe(201);
      const createdTeam = parse(created);
      expect(createdTeam.slug).toBe('ops-team');
      expect(createdTeam.privacy).toBe('secret');

      const fetched = await handleShimRequest(ctx, orgUrl('/teams/ops-team'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).name).toBe('Ops Team');

      const invalid = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name    : 'Invalid Privacy Team',
        privacy : 'private',
      });
      expect(invalid.status).toBe(422);
    });

    it('should support numeric organization team routes', async () => {
      const orgInfo = parse(await handleShimRequest(ctx, orgUrl('')));
      const create = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name        : 'ID Alias Team',
        description : 'Numeric route coverage',
        privacy     : 'closed',
      });
      expect(create.status).toBe(201);
      let team = parse(create);
      const orgId = orgInfo.id;
      const teamId = team.id;

      const legacyGet = await handleShimRequest(ctx, url(`/teams/${teamId}`));
      expect(legacyGet.status).toBe(200);
      expect(parse(legacyGet).slug).toBe(team.slug);

      const orgIdGet = await handleShimRequest(ctx, url(`/organizations/${orgId}/team/${teamId}`));
      expect(orgIdGet.status).toBe(200);
      expect(parse(orgIdGet).slug).toBe(team.slug);

      const legacyUpdate = await handleShimRequest(ctx, url(`/teams/${teamId}`), 'PATCH', {
        description: 'Updated through numeric route',
      });
      expect(legacyUpdate.status).toBe(200);
      expect(parse(legacyUpdate).description).toBe('Updated through numeric route');

      const orgIdUpdate = await handleShimRequest(ctx, url(`/organizations/${orgId}/team/${teamId}`), 'PATCH', {
        name: 'ID Alias Team Renamed',
      });
      expect(orgIdUpdate.status).toBe(200);
      team = parse(orgIdUpdate);
      expect(team.slug).toBe('id-alias-team-renamed');

      expect(parse(await handleShimRequest(ctx, url(`/teams/${teamId}/teams`)))).toEqual([]);
      expect(parse(await handleShimRequest(ctx, url(`/organizations/${orgId}/team/${teamId}/teams`)))).toEqual([]);
      expect(parse(await handleShimRequest(ctx, url(`/teams/${teamId}/invitations`)))).toEqual([]);
      expect(parse(await handleShimRequest(ctx, url(`/organizations/${orgId}/team/${teamId}/invitations`)))).toEqual([]);

      const memberDid = 'did:jwk:numericteamroute';
      const encodedMemberDid = encodeURIComponent(memberDid);
      const createMember = await handleShimRequest(ctx, orgUrl(`/memberships/${encodedMemberDid}`), 'PUT', {
        role: 'member',
      });
      expect(createMember.status).toBe(200);

      const legacyAddMember = await handleShimRequest(ctx, url(`/teams/${teamId}/members/${encodedMemberDid}`), 'PUT', {
        role: 'maintainer',
      });
      expect(legacyAddMember.status).toBe(200);
      expect(parse(legacyAddMember).state).toBe('active');

      const legacyMembers = parse(await handleShimRequest(ctx, url(`/teams/${teamId}/members`)));
      expect(legacyMembers.map((item: any) => item.login)).toContain(memberDid);

      const legacyMemberCheck = await handleShimRequest(ctx, url(`/teams/${teamId}/members/${encodedMemberDid}`));
      expect(legacyMemberCheck.status).toBe(204);

      const orgIdMembership = await handleShimRequest(
        ctx,
        url(`/organizations/${orgId}/team/${teamId}/memberships/${encodedMemberDid}`),
      );
      expect(orgIdMembership.status).toBe(200);
      expect(parse(orgIdMembership).role).toBe('maintainer');

      const orgIdRemoveMembership = await handleShimRequest(
        ctx,
        url(`/organizations/${orgId}/team/${teamId}/memberships/${encodedMemberDid}`),
        'DELETE',
      );
      expect(orgIdRemoveMembership.status).toBe(204);
      const afterMembershipRemove = await handleShimRequest(ctx, url(`/teams/${teamId}/members/${encodedMemberDid}`));
      expect(afterMembershipRemove.status).toBe(404);

      const orgIdAddMembership = await handleShimRequest(
        ctx,
        url(`/organizations/${orgId}/team/${teamId}/memberships/${encodedMemberDid}`),
        'PUT',
        { role: 'member' },
      );
      expect(orgIdAddMembership.status).toBe(200);
      expect(parse(orgIdAddMembership).role).toBe('member');

      const legacyRemoveMember = await handleShimRequest(ctx, url(`/teams/${teamId}/members/${encodedMemberDid}`), 'DELETE');
      expect(legacyRemoveMember.status).toBe(204);

      const owner = encodeURIComponent(testDid);
      const legacyRepoGrant = await handleShimRequest(ctx, url(`/teams/${teamId}/repos/${owner}/test-repo`), 'PUT', {
        permission: 'push',
      });
      expect(legacyRepoGrant.status).toBe(204);

      const orgIdRepos = parse(await handleShimRequest(ctx, url(`/organizations/${orgId}/team/${teamId}/repos`)));
      expect(orgIdRepos.map((item: any) => item.name)).toContain('test-repo');

      const legacyRepoCheck = await handleShimRequest(ctx, url(`/teams/${teamId}/repos/${owner}/test-repo`));
      expect(legacyRepoCheck.status).toBe(200);
      expect(parse(legacyRepoCheck).role_name).toBe('write');

      const orgIdRemoveRepo = await handleShimRequest(
        ctx,
        url(`/organizations/${orgId}/team/${teamId}/repos/${owner}/test-repo`),
        'DELETE',
      );
      expect(orgIdRemoveRepo.status).toBe(204);

      const repoAfterRemove = await handleShimRequest(ctx, url(`/teams/${teamId}/repos/${owner}/test-repo`));
      expect(repoAfterRemove.status).toBe(404);

      const missingTeam = await handleShimRequest(ctx, url('/teams/999'));
      expect(missingTeam.status).toBe(404);
      const missingOrgTeam = await handleShimRequest(ctx, url(`/organizations/999/team/${teamId}`));
      expect(missingOrgTeam.status).toBe(404);

      const deleteTeam = await handleShimRequest(ctx, url(`/teams/${teamId}`), 'DELETE');
      expect(deleteTeam.status).toBe(204);

      const deleteMember = await handleShimRequest(ctx, orgUrl(`/memberships/${encodedMemberDid}`), 'DELETE');
      expect(deleteMember.status).toBe(204);
    });

    it('should update and delete organization teams', async () => {
      const created = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name        : 'Lifecycle Team',
        description : 'Temporary team',
        privacy     : 'closed',
      });
      expect(created.status).toBe(201);

      const invalid = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-team'), 'PATCH', {
        privacy: 'private',
      });
      expect(invalid.status).toBe(422);

      const updated = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-team'), 'PATCH', {
        name                 : 'Lifecycle Automation',
        description          : 'Automation maintainers',
        privacy              : 'secret',
        notification_setting : 'notifications_disabled',
        permission           : 'push',
      });
      expect(updated.status).toBe(200);
      const updatedTeam = parse(updated);
      expect(updatedTeam.name).toBe('Lifecycle Automation');
      expect(updatedTeam.slug).toBe('lifecycle-automation');
      expect(updatedTeam.description).toBe('Automation maintainers');
      expect(updatedTeam.privacy).toBe('secret');

      const oldSlug = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-team'));
      expect(oldSlug.status).toBe(404);

      const fetched = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-automation'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).name).toBe('Lifecycle Automation');

      const removed = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-automation'), 'DELETE');
      expect(removed.status).toBe(204);
      expect(removed.body).toBe('');

      const missing = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-automation'));
      expect(missing.status).toBe(404);

      const missingDelete = await handleShimRequest(ctx, orgUrl('/teams/lifecycle-automation'), 'DELETE');
      expect(missingDelete.status).toBe(404);
    });

    it('should manage team repository permissions', async () => {
      const owner = encodeURIComponent(testDid);
      const teamRepoPath = `/teams/core-team/repos/${owner}/test-repo`;

      const add = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'PUT', {
        permission: 'triage',
      });
      expect(add.status).toBe(204);
      expect(add.body).toBe('');

      const check = await handleShimRequest(ctx, orgUrl(teamRepoPath));
      expect(check.status).toBe(200);
      const checked = parse(check);
      expect(checked.full_name).toBe(`${testDid}/test-repo`);
      expect(checked.role_name).toBe('triage');
      expect(checked.permissions.pull).toBe(true);
      expect(checked.permissions.triage).toBe(true);
      expect(checked.permissions.push).toBe(false);

      const list = await handleShimRequest(ctx, orgUrl('/teams/core-team/repos'));
      expect(list.status).toBe(200);
      expect(parse(list).some((repo: any) => repo.full_name === `${testDid}/test-repo`)).toBe(true);

      const update = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'PUT', {
        permission: 'admin',
      });
      expect(update.status).toBe(204);
      const updated = parse(await handleShimRequest(ctx, orgUrl(teamRepoPath)));
      expect(updated.role_name).toBe('admin');
      expect(updated.permissions.admin).toBe(true);
      expect(updated.permissions.maintain).toBe(true);

      const invalidPermission = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'PUT', {
        permission: 'banana',
      });
      expect(invalidPermission.status).toBe(422);

      const wrongOwner = await handleShimRequest(
        ctx,
        orgUrl(`/teams/core-team/repos/${encodeURIComponent('did:jwk:not-org')}/test-repo`),
        'PUT',
        { permission: 'pull' },
      );
      expect(wrongOwner.status).toBe(422);

      const missingRepo = await handleShimRequest(ctx, orgUrl(`/teams/core-team/repos/${owner}/missing-repo`), 'PUT', {
        permission: 'pull',
      });
      expect(missingRepo.status).toBe(404);

      const remove = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'DELETE');
      expect(remove.status).toBe(204);
      expect(remove.body).toBe('');

      const missingCheck = await handleShimRequest(ctx, orgUrl(teamRepoPath));
      expect(missingCheck.status).toBe(404);

      const missingRemove = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'DELETE');
      expect(missingRemove.status).toBe(404);
    });

    it('should list teams with repository access', async () => {
      const created = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name    : 'Repository Access Team',
        privacy : 'closed',
      });
      expect(created.status).toBe(201);
      const createdTeam = parse(created);

      const owner = encodeURIComponent(testDid);
      const teamRepoPath = `/teams/${createdTeam.slug}/repos/${owner}/test-repo`;
      const add = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'PUT', {
        permission: 'maintain',
      });
      expect(add.status).toBe(204);

      const list = await handleShimRequest(ctx, url(`/repos/${testDid}/test-repo/teams`));
      expect(list.status).toBe(200);
      const team = parse(list).find((item: any) => item.slug === createdTeam.slug);
      expect(team.name).toBe('Repository Access Team');
      expect(team.permission).toBe('maintain');
      expect(team.repositories_url).toContain(`/orgs/${ORG_NAME}/teams/${createdTeam.slug}/repos`);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/teams`));
      expect(missingRepo.status).toBe(404);

      const remove = await handleShimRequest(ctx, orgUrl(teamRepoPath), 'DELETE');
      expect(remove.status).toBe(204);

      const afterRemove = parse(await handleShimRequest(ctx, url(`/repos/${testDid}/test-repo/teams`)));
      expect(afterRemove.some((item: any) => item.slug === createdTeam.slug)).toBe(false);

      const deleteTeam = await handleShimRequest(ctx, orgUrl(`/teams/${createdTeam.slug}`), 'DELETE');
      expect(deleteTeam.status).toBe(204);
    });

    it('should list child teams for an organization team', async () => {
      const list = await handleShimRequest(ctx, orgUrl('/teams/core-team/teams'));
      expect(list.status).toBe(200);
      expect(parse(list)).toEqual([]);

      const missingTeam = await handleShimRequest(ctx, orgUrl('/teams/missing-team/teams'));
      expect(missingTeam.status).toBe(404);
    });

    it('should list teams for the authenticated user', async () => {
      const created = await handleShimRequest(ctx, orgUrl('/teams'), 'POST', {
        name        : 'Authenticated User Team',
        description : 'Team visible through /user/teams',
        privacy     : 'closed',
      });
      expect(created.status).toBe(201);
      const createdTeam = parse(created);

      const membership = await handleShimRequest(
        ctx,
        orgUrl(`/teams/${createdTeam.slug}/memberships/${encodeURIComponent(testDid)}`),
        'PUT',
        { alias: 'Local Owner' },
      );
      expect(membership.status).toBe(200);
      expect(parse(membership).role).toBe('maintainer');

      const repoGrant = await handleShimRequest(
        ctx,
        orgUrl(`/teams/${createdTeam.slug}/repos/${encodeURIComponent(testDid)}/test-repo`),
        'PUT',
        { permission: 'push' },
      );
      expect(repoGrant.status).toBe(204);

      const list = await handleShimRequest(ctx, url('/user/teams'));
      expect(list.status).toBe(200);
      const team = parse(list).find((item: any) => item.slug === createdTeam.slug);
      expect(team.name).toBe('Authenticated User Team');
      expect(team.description).toBe('Team visible through /user/teams');
      expect(team.members_count).toBe(1);
      expect(team.repos_count).toBe(1);
      expect(team.organization.login).toBe(ORG_NAME);
      expect(team.created_at).toBeDefined();
      expect(team.updated_at).toBeDefined();

      const removed = await handleShimRequest(ctx, orgUrl(`/teams/${createdTeam.slug}`), 'DELETE');
      expect(removed.status).toBe(204);
    });

    it('should get team membership details', async () => {
      const existing = await handleShimRequest(ctx, orgUrl(`/teams/core-team/memberships/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(existing.status).toBe(200);
      const membership = parse(existing);
      expect(membership.state).toBe('active');
      expect(membership.role).toBe('member');
      expect(membership.team.slug).toBe('core-team');
      expect(membership.user.login).toBe(ORG_MEMBER_DID);
      expect(membership.organization.login).toBe(ORG_NAME);

      const missing = await handleShimRequest(ctx, orgUrl('/teams/core-team/memberships/did%3Ajwk%3Aunknownmember'));
      expect(missing.status).toBe(404);
    });

    it('should list, check, add, and remove team memberships', async () => {
      const teamPath = '/teams/core-team';
      const members = await handleShimRequest(ctx, orgUrl(`${teamPath}/members`));
      expect(members.status).toBe(200);
      expect(parse(members).map((item: any) => item.login)).toContain(ORG_MEMBER_DID);

      const existing = await handleShimRequest(ctx, orgUrl(`${teamPath}/members/${encodeURIComponent(ORG_MEMBER_DID)}`));
      expect(existing.status).toBe(204);

      const add = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'PUT', {
        alias : 'Team Member',
        role  : 'maintainer',
      });
      expect(add.status).toBe(200);
      const membership = parse(add);
      expect(membership.state).toBe('pending');
      expect(membership.role).toBe('maintainer');
      expect(membership.user.login).toBe(ORG_TEAM_MEMBER_DID);
      expect(membership.team.slug).toBe('core-team');

      const pendingDetail = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`)));
      expect(pendingDetail.state).toBe('pending');

      const pendingMemberCheck = await handleShimRequest(ctx, orgUrl(`${teamPath}/members/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`));
      expect(pendingMemberCheck.status).toBe(404);

      const invitations = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/invitations`)));
      const invitation = invitations.find((item: any) => item.login === ORG_TEAM_MEMBER_DID);
      expect(invitation.role).toBe('direct_member');
      expect(invitation.team.slug).toBe('core-team');

      const orgInvitations = parse(await handleShimRequest(ctx, orgUrl('/invitations')));
      const orgInvitation = orgInvitations.find((item: any) => item.login === ORG_TEAM_MEMBER_DID);
      expect(orgInvitation.role).toBe('direct_member');
      expect(orgInvitation.team_count).toBe(1);
      expect(orgInvitation.invitation_source).toBe('member');

      const orgInvitationTeams = parse(await handleShimRequest(ctx, orgUrl(`/invitations/${orgInvitation.id}/teams`)));
      expect(orgInvitationTeams.map((item: any) => item.slug)).toContain('core-team');

      const directInvitations = parse(await handleShimRequest(ctx, orgUrl('/invitations?role=direct_member')));
      expect(directInvitations.map((item: any) => item.login)).toContain(ORG_TEAM_MEMBER_DID);

      const adminInvitations = parse(await handleShimRequest(ctx, orgUrl('/invitations?role=admin')));
      expect(adminInvitations.map((item: any) => item.login)).not.toContain(ORG_TEAM_MEMBER_DID);

      const memberSourceInvitations = parse(await handleShimRequest(ctx, orgUrl('/invitations?invitation_source=member')));
      expect(memberSourceInvitations.map((item: any) => item.login)).toContain(ORG_TEAM_MEMBER_DID);

      const scimInvitations = parse(await handleShimRequest(ctx, orgUrl('/invitations?invitation_source=scim')));
      expect(scimInvitations.map((item: any) => item.login)).not.toContain(ORG_TEAM_MEMBER_DID);

      const invalidInvitationRole = await handleShimRequest(ctx, orgUrl('/invitations?role=owner'));
      expect(invalidInvitationRole.status).toBe(422);

      const invalidInvitationSource = await handleShimRequest(ctx, orgUrl('/invitations?invitation_source=email'));
      expect(invalidInvitationSource.status).toBe(422);

      const failedInvitations = parse(await handleShimRequest(ctx, orgUrl('/failed_invitations')));
      expect(failedInvitations).toEqual([]);

      const missingFailedInvitations = await handleShimRequest(ctx, url('/orgs/missing-org/failed_invitations'));
      expect(missingFailedInvitations.status).toBe(404);

      const pendingMembers = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/members`)));
      expect(pendingMembers.map((item: any) => item.login)).not.toContain(ORG_TEAM_MEMBER_DID);

      const cancelOrgInvitation = await handleShimRequest(ctx, orgUrl(`/invitations/${orgInvitation.id}`), 'DELETE');
      expect(cancelOrgInvitation.status).toBe(204);

      const canceledPendingDetail = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`));
      expect(canceledPendingDetail.status).toBe(404);

      const canceledInvitationTeams = await handleShimRequest(ctx, orgUrl(`/invitations/${orgInvitation.id}/teams`));
      expect(canceledInvitationTeams.status).toBe(404);

      const readd = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'PUT', {
        alias : 'Team Member',
        role  : 'maintainer',
      });
      expect(readd.status).toBe(200);
      expect(parse(readd).state).toBe('pending');

      const orgMembership = await handleShimRequest(ctx, orgUrl(`/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'PUT', {
        role: 'member',
      });
      expect(orgMembership.status).toBe(200);

      const activate = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'PUT', {
        role: 'maintainer',
      });
      expect(activate.status).toBe(200);
      expect(parse(activate).state).toBe('active');

      const afterAdd = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/members`)));
      expect(afterAdd.map((item: any) => item.login)).toContain(ORG_TEAM_MEMBER_DID);

      const invitationsAfterActivate = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/invitations`)));
      expect(invitationsAfterActivate.map((item: any) => item.login)).not.toContain(ORG_TEAM_MEMBER_DID);

      const maintainers = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/members?role=maintainer`)));
      expect(maintainers.map((item: any) => item.login)).toContain(ORG_TEAM_MEMBER_DID);
      expect(maintainers.map((item: any) => item.login)).not.toContain(ORG_MEMBER_DID);

      const memberRoleMembers = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/members?role=member`)));
      expect(memberRoleMembers.map((item: any) => item.login)).toContain(ORG_MEMBER_DID);
      expect(memberRoleMembers.map((item: any) => item.login)).not.toContain(ORG_TEAM_MEMBER_DID);

      const update = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'PUT', {
        role: 'member',
      });
      expect(update.status).toBe(200);
      expect(parse(update).role).toBe('member');

      const afterUpdateMembers = parse(await handleShimRequest(ctx, orgUrl(`${teamPath}/members?role=member`)));
      expect(afterUpdateMembers.map((item: any) => item.login)).toContain(ORG_TEAM_MEMBER_DID);

      const invalidRole = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/did%3Ajwk%3Ainvalidteamrole`), 'PUT', {
        role: 'admin',
      });
      expect(invalidRole.status).toBe(422);

      const invalidFilter = await handleShimRequest(ctx, orgUrl(`${teamPath}/members?role=admin`));
      expect(invalidFilter.status).toBe(422);

      const removed = await handleShimRequest(ctx, orgUrl(`${teamPath}/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'DELETE');
      expect(removed.status).toBe(204);

      const removeOrgMembership = await handleShimRequest(ctx, orgUrl(`/memberships/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`), 'DELETE');
      expect(removeOrgMembership.status).toBe(204);

      const missing = await handleShimRequest(ctx, orgUrl(`${teamPath}/members/${encodeURIComponent(ORG_TEAM_MEMBER_DID)}`));
      expect(missing.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/PUT /topics, GET /languages, /collaborators
  // =========================================================================

  describe('repository metadata endpoints', () => {
    it('should return repository topics', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/topics'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.names).toEqual(['decentralized', 'git']);
    });

    it('should replace repository topics', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/topics'), 'PUT', {
        names: ['Forge', 'p2p'],
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.names).toEqual(['forge', 'p2p']);

      const getRes = await handleShimRequest(ctx, repoUrl('/topics'));
      expect(parse(getRes).names).toEqual(['forge', 'p2p']);
    });

    it('should reject invalid topic replacement payloads', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/topics'), 'PUT', {
        names: ['not valid topic'],
      });
      expect(res.status).toBe(422);
    });

    it('should return repository languages from repo tags', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/languages'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toEqual({ TypeScript: 0 });
    });

    it('should list repository issue types', async () => {
      const defaults = await handleShimRequest(ctx, repoUrl('/issue-types'));
      expect(defaults.status).toBe(200);
      const defaultTypes = parse(defaults);
      expect(defaultTypes.map((item: any) => item.name)).toEqual(['Bug', 'Task', 'Feature']);
      expect(defaultTypes[0].node_id).toContain('IT_');
      expect(defaultTypes[0].created_at).toBeDefined();

      await mergeRepoSettings({
        issueTypes: {
          bug: {
            id          : 901,
            name        : 'Bug',
            description : 'Confirmed defect',
            createdAt   : '2026-01-01T00:00:00.000Z',
            updatedAt   : '2026-01-02T00:00:00.000Z',
          },
          disabled: {
            id          : 902,
            name        : 'Disabled',
            description : 'Hidden type',
            isEnabled   : false,
            createdAt   : '2026-01-01T00:00:00.000Z',
            updatedAt   : '2026-01-02T00:00:00.000Z',
          },
          initiative: {
            id          : 903,
            name        : 'Initiative',
            description : 'Long-running work',
            color       : 'orange',
            isEnabled   : true,
            createdAt   : '2026-01-03T00:00:00.000Z',
            updatedAt   : '2026-01-04T00:00:00.000Z',
          },
        },
      });

      const configured = await handleShimRequest(ctx, repoUrl('/issue-types'));
      expect(configured.status).toBe(200);
      expect(parse(configured)).toEqual([
        {
          id          : 901,
          node_id     : 'IT_901',
          name        : 'Bug',
          description : 'Confirmed defect',
          created_at  : '2026-01-01T00:00:00.000Z',
          updated_at  : '2026-01-02T00:00:00.000Z',
        },
        {
          id          : 903,
          node_id     : 'IT_903',
          name        : 'Initiative',
          description : 'Long-running work',
          created_at  : '2026-01-03T00:00:00.000Z',
          updated_at  : '2026-01-04T00:00:00.000Z',
        },
      ]);

      const missing = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/issue-types`));
      expect(missing.status).toBe(404);
    });

    it('should create, list, get, and delete repository deploy keys', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/keys'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const create = await handleShimRequest(ctx, repoUrl('/keys'), 'POST', {
        title     : 'CI deploy key',
        key       : 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGitdDeployKeyExample gitd@example',
        read_only : false,
      });
      expect(create.status).toBe(201);
      const deployKey = parse(create);
      expect(deployKey.title).toBe('CI deploy key');
      expect(deployKey.read_only).toBe(false);
      expect(deployKey.verified).toBe(true);
      expect(deployKey.added_by).toBe(testDid);
      expect(deployKey.enabled).toBe(true);
      expect(deployKey.last_used).toBeNull();
      expect(deployKey.url).toContain(`/repos/${testDid}/test-repo/keys/${deployKey.id}`);

      const duplicate = await handleShimRequest(ctx, repoUrl('/keys'), 'POST', {
        key: deployKey.key,
      });
      expect(duplicate.status).toBe(422);

      const list = await handleShimRequest(ctx, repoUrl('/keys'));
      expect(list.status).toBe(200);
      expect(parse(list).map((item: any) => item.id)).toContain(deployKey.id);

      const get = await handleShimRequest(ctx, repoUrl(`/keys/${deployKey.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).key).toBe(deployKey.key);

      const invalid = await handleShimRequest(ctx, repoUrl('/keys'), 'POST', {
        read_only: 'yes',
      });
      expect(invalid.status).toBe(422);

      const deleted = await handleShimRequest(ctx, repoUrl(`/keys/${deployKey.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBe('');

      const missing = await handleShimRequest(ctx, repoUrl(`/keys/${deployKey.id}`));
      expect(missing.status).toBe(404);
    });

    it('should create, list, get, and delete repository autolinks', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/autolinks'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const invalidMissingToken = await handleShimRequest(ctx, repoUrl('/autolinks'), 'POST', {
        key_prefix   : 'TICKET-',
        url_template : 'https://tracker.example.test/browse/TICKET',
      });
      expect(invalidMissingToken.status).toBe(422);

      const create = await handleShimRequest(ctx, repoUrl('/autolinks'), 'POST', {
        key_prefix      : 'TICKET-',
        url_template    : 'https://tracker.example.test/browse/TICKET-<num>',
        is_alphanumeric : true,
      });
      expect(create.status).toBe(201);
      const autolink = parse(create);
      expect(autolink.key_prefix).toBe('TICKET-');
      expect(autolink.url_template).toBe('https://tracker.example.test/browse/TICKET-<num>');
      expect(autolink.is_alphanumeric).toBe(true);

      const duplicate = await handleShimRequest(ctx, repoUrl('/autolinks'), 'POST', {
        key_prefix   : 'ticket-',
        url_template : 'https://tracker.example.test/other/<num>',
      });
      expect(duplicate.status).toBe(422);

      const list = parse(await handleShimRequest(ctx, repoUrl('/autolinks')));
      expect(list).toEqual([autolink]);

      const get = await handleShimRequest(ctx, repoUrl(`/autolinks/${autolink.id}`));
      expect(get.status).toBe(200);
      expect(parse(get)).toEqual(autolink);

      const deleted = await handleShimRequest(ctx, repoUrl(`/autolinks/${autolink.id}`), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl(`/autolinks/${autolink.id}`));
      expect(missing.status).toBe(404);
    });

    it('should get, set, validate, and remove repository interaction limits', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/interaction-limits'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual({});

      const invalidLimit = await handleShimRequest(ctx, repoUrl('/interaction-limits'), 'PUT', {
        limit: 'everyone',
      });
      expect(invalidLimit.status).toBe(422);

      const invalidExpiry = await handleShimRequest(ctx, repoUrl('/interaction-limits'), 'PUT', {
        limit  : 'contributors_only',
        expiry : 'forever',
      });
      expect(invalidExpiry.status).toBe(422);

      const set = await handleShimRequest(ctx, repoUrl('/interaction-limits'), 'PUT', {
        limit  : 'collaborators_only',
        expiry : 'three_days',
      });
      expect(set.status).toBe(200);
      const limit = parse(set);
      expect(limit.limit).toBe('collaborators_only');
      expect(limit.origin).toBe('repository');
      expect(Date.parse(limit.expires_at)).toBeGreaterThan(Date.now());

      const get = parse(await handleShimRequest(ctx, repoUrl('/interaction-limits')));
      expect(get.limit).toBe('collaborators_only');
      expect(get.origin).toBe('repository');

      const deleted = await handleShimRequest(ctx, repoUrl('/interaction-limits'), 'DELETE');
      expect(deleted.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, repoUrl('/interaction-limits'));
      expect(parse(afterDelete)).toEqual({});
    });

    it('should enable, check, and disable repository security toggles', async () => {
      const initialAlerts = await handleShimRequest(ctx, repoUrl('/vulnerability-alerts'));
      expect(initialAlerts.status).toBe(404);

      const enableAlerts = await handleShimRequest(ctx, repoUrl('/vulnerability-alerts'), 'PUT');
      expect(enableAlerts.status).toBe(204);

      const checkAlerts = await handleShimRequest(ctx, repoUrl('/vulnerability-alerts'));
      expect(checkAlerts.status).toBe(204);
      expect(checkAlerts.body).toBe('');

      const disableAlerts = await handleShimRequest(ctx, repoUrl('/vulnerability-alerts'), 'DELETE');
      expect(disableAlerts.status).toBe(204);

      const alertsAfterDisable = await handleShimRequest(ctx, repoUrl('/vulnerability-alerts'));
      expect(alertsAfterDisable.status).toBe(404);

      const initialFixes = await handleShimRequest(ctx, repoUrl('/automated-security-fixes'));
      expect(initialFixes.status).toBe(404);

      const enableFixes = await handleShimRequest(ctx, repoUrl('/automated-security-fixes'), 'PUT');
      expect(enableFixes.status).toBe(204);

      const checkFixes = await handleShimRequest(ctx, repoUrl('/automated-security-fixes'));
      expect(checkFixes.status).toBe(200);
      expect(parse(checkFixes)).toEqual({ enabled: true, paused: false });

      const disableFixes = await handleShimRequest(ctx, repoUrl('/automated-security-fixes'), 'DELETE');
      expect(disableFixes.status).toBe(204);

      const fixesAfterDisable = await handleShimRequest(ctx, repoUrl('/automated-security-fixes'));
      expect(fixesAfterDisable.status).toBe(404);
    });

    it('should create, report, list, update, request CVEs for, and fork repository security advisories', async () => {
      await mergeRepoSettings({
        securityAdvisories: {
          'GHSA-SEED-0001-0002': {
            ghsaId          : 'GHSA-SEED-0001-0002',
            cveId           : 'CVE-2026-0002',
            summary         : 'Seed advisory',
            description     : 'Seed advisory description.',
            severity        : 'high',
            state           : 'published',
            authorDid       : MAINTAINER_DID,
            publisherDid    : MAINTAINER_DID,
            createdAt       : '2026-04-01T00:00:00.000Z',
            updatedAt       : '2026-04-02T00:00:00.000Z',
            publishedAt     : '2026-04-02T00:00:00.000Z',
            vulnerabilities : [
              {
                package                  : { ecosystem: 'npm', name: 'left-pad' },
                vulnerable_version_range : '< 1.3.0',
                patched_versions         : '1.3.0',
                vulnerable_functions     : ['pad'],
              },
            ],
            cweIds             : ['CWE-79'],
            credits            : [{ login: TRIAGER_DID, type: 'analyst' }],
            collaboratingUsers : [TRIAGER_DID],
          },
        },
      });

      const listRes = await handleShimRequest(ctx, repoUrl('/security-advisories?state=published&sort=published&direction=asc'));
      expect(listRes.status).toBe(200);
      const listed = parse(listRes);
      expect(listed).toHaveLength(1);
      expect(listed[0].ghsa_id).toBe('GHSA-SEED-0001-0002');
      expect(listed[0].cve_id).toBe('CVE-2026-0002');
      expect(listed[0].author.login).toBe(MAINTAINER_DID);
      expect(listed[0].vulnerabilities[0].package.name).toBe('left-pad');
      expect(listed[0].credits_detailed[0].user.login).toBe(TRIAGER_DID);

      const invalidListRes = await handleShimRequest(ctx, repoUrl('/security-advisories?state=bad'));
      expect(invalidListRes.status).toBe(422);

      const getSeedRes = await handleShimRequest(ctx, repoUrl('/security-advisories/GHSA-SEED-0001-0002'));
      expect(getSeedRes.status).toBe(200);
      expect(parse(getSeedRes).state).toBe('published');

      const createRes = await handleShimRequest(ctx, repoUrl('/security-advisories'), 'POST', {
        summary            : 'Unsafe archive extraction',
        description        : 'An archive entry can write outside the intended extraction directory.',
        severity           : 'low',
        cwe_ids            : ['CWE-22'],
        credits            : [{ login: TRIAGER_DID, type: 'reporter' }],
        start_private_fork : true,
        vulnerabilities    : [
          {
            package                  : { ecosystem: 'npm', name: 'tar-stream' },
            vulnerable_version_range : '< 3.1.0',
            patched_versions         : '3.1.0',
          },
        ],
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.ghsa_id).toMatch(/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(created.state).toBe('draft');
      expect(created.private_fork.full_name).toContain(`${testDid}/test-repo-${created.ghsa_id.toLowerCase()}`);

      const invalidCreateRes = await handleShimRequest(ctx, repoUrl('/security-advisories'), 'POST', {
        summary            : 'Invalid advisory',
        description        : 'Invalid advisory description.',
        severity           : 'low',
        cvss_vector_string : 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N',
        vulnerabilities    : [],
      });
      expect(invalidCreateRes.status).toBe(422);

      const reportRes = await handleShimRequest(ctx, repoUrl('/security-advisories/reports'), 'POST', {
        summary     : 'Privately reported issue',
        description : 'A reporter found a vulnerability before public disclosure.',
        severity    : 'medium',
      });
      expect(reportRes.status).toBe(201);
      const reported = parse(reportRes);
      expect(reported.state).toBe('triage');
      expect(reported.submission.accepted).toBe(false);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/security-advisories/${created.ghsa_id}`), 'PATCH', {
        severity            : 'critical',
        state               : 'published',
        cve_id              : null,
        collaborating_users : [TRIAGER_DID],
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.severity).toBe('critical');
      expect(updated.state).toBe('published');
      expect(updated.publisher.login).toBe(testDid);
      expect(updated.cve_id).toBeNull();
      expect(updated.collaborating_users[0].login).toBe(TRIAGER_DID);

      const cveRes = await handleShimRequest(ctx, repoUrl(`/security-advisories/${created.ghsa_id}/cve`), 'POST');
      expect(cveRes.status).toBe(202);

      const forkRes = await handleShimRequest(ctx, repoUrl(`/security-advisories/${reported.ghsa_id}/forks`), 'POST');
      expect(forkRes.status).toBe(202);

      const getReportedRes = await handleShimRequest(ctx, repoUrl(`/security-advisories/${reported.ghsa_id}`));
      expect(getReportedRes.status).toBe(200);
      expect(parse(getReportedRes).private_fork.full_name).toContain(`${testDid}/test-repo-${reported.ghsa_id.toLowerCase()}`);

      const missingAdvisoryRes = await handleShimRequest(ctx, repoUrl('/security-advisories/GHSA-MISS-0000-0000'));
      expect(missingAdvisoryRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/security-advisories`));
      expect(missingRepoRes.status).toBe(404);
    });

    it('should list, filter, get, update, and list repository code scanning alert instances', async () => {
      await mergeRepoSettings({
        codeScanningAlerts: {
          '1': {
            number : 1,
            state  : 'open',
            rule   : {
              id                      : 'js/zipslip',
              severity                : 'error',
              security_severity_level : 'high',
              description             : 'Arbitrary file write during zip extraction',
              name                    : 'js/zipslip',
              tags                    : ['security', 'external/cwe/cwe-022'],
            },
            tool: {
              name    : 'CodeQL',
              guid    : null,
              version : '2.17.0',
            },
            mostRecentInstance: {
              ref             : 'refs/heads/main',
              analysisKey     : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
              category        : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
              environment     : '{}',
              state           : 'open',
              commitSha       : MAIN_SHA,
              message         : { text: 'This path depends on a user-provided value.' },
              location        : { path: 'src/archive.ts', start_line: 42, end_line: 42 },
              classifications : ['source'],
            },
            instances: [
              {
                ref             : 'refs/heads/main',
                analysisKey     : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
                category        : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
                environment     : '{}',
                state           : 'open',
                commitSha       : MAIN_SHA,
                message         : { text: 'This path depends on a user-provided value.' },
                location        : { path: 'src/archive.ts', start_line: 42, end_line: 42 },
                classifications : ['source'],
              },
              {
                ref             : 'refs/pull/17/merge',
                analysisKey     : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
                category        : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
                environment     : '{}',
                state           : 'fixed',
                commitSha       : FEATURE_SHA,
                message         : { text: 'The pull request path is sanitized.' },
                location        : { path: 'src/archive.ts', start_line: 50, end_line: 50 },
                classifications : ['test'],
              },
            ],
            createdAt : '2026-02-01T00:00:00.000Z',
            updatedAt : '2026-02-02T00:00:00.000Z',
          },
          '2': {
            number : 2,
            state  : 'fixed',
            rule   : {
              id                      : 'ts/hardcoded-token',
              severity                : 'warning',
              security_severity_level : 'medium',
              description             : 'Hardcoded token in source',
              name                    : 'ts/hardcoded-token',
            },
            tool: {
              name    : 'Semgrep',
              guid    : 'semgrep-guid',
              version : '1.70.0',
            },
            mostRecentInstance: {
              ref         : 'refs/heads/main',
              analysisKey : 'semgrep',
              category    : 'semgrep',
              environment : '{}',
              state       : 'fixed',
              commitSha   : TAG_SHA,
              message     : { text: 'The token was removed.' },
              location    : { path: 'src/config.ts', start_line: 8, end_line: 8 },
            },
            createdAt : '2026-02-03T00:00:00.000Z',
            updatedAt : '2026-02-04T00:00:00.000Z',
            fixedAt   : '2026-02-04T00:00:00.000Z',
          },
        },
      });

      const filteredRes = await handleShimRequest(
        ctx,
        repoUrl('/code-scanning/alerts?state=open&severity=high&tool_name=CodeQL&ref=main&assignees=none'),
      );
      expect(filteredRes.status).toBe(200);
      const filtered = parse(filteredRes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].number).toBe(1);
      expect(filtered[0].rule.id).toBe('js/zipslip');
      expect(filtered[0].tool.name).toBe('CodeQL');
      expect(filtered[0].most_recent_instance).toMatchObject({
        ref          : 'refs/heads/main',
        analysis_key : '.github/workflows/codeql-analysis.yml:CodeQL-Build',
        commit_sha   : MAIN_SHA,
      });
      expect(filtered[0].instances_url).toContain(`/repos/${testDid}/test-repo/code-scanning/alerts/1/instances`);

      const invalidFilterRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts?tool_name=CodeQL&tool_guid=guid'));
      expect(invalidFilterRes.status).toBe(422);

      const getRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/2'));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).fixed_at).toBe('2026-02-04T00:00:00.000Z');

      const mainInstancesRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/1/instances?ref=main'));
      expect(mainInstancesRes.status).toBe(200);
      expect(parse(mainInstancesRes).map((instance: any) => instance.ref)).toEqual(['refs/heads/main']);

      const pullInstancesRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/1/instances?pr=17'));
      expect(pullInstancesRes.status).toBe(200);
      expect(parse(pullInstancesRes).map((instance: any) => instance.ref)).toEqual(['refs/pull/17/merge']);

      const invalidDismissRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/1'), 'PATCH', {
        state: 'dismissed',
      });
      expect(invalidDismissRes.status).toBe(422);

      const dismissedRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/1'), 'PATCH', {
        state             : 'dismissed',
        dismissed_reason  : 'false positive',
        dismissed_comment : 'Sanitized before extraction.',
        create_request    : true,
        assignees         : [TRIAGER_DID],
      });
      expect(dismissedRes.status).toBe(200);
      const dismissed = parse(dismissedRes);
      expect(dismissed.state).toBe('dismissed');
      expect(dismissed.dismissed_by.login).toBe(testDid);
      expect(dismissed.dismissed_reason).toBe('false positive');
      expect(dismissed.dismissed_comment).toBe('Sanitized before extraction.');
      expect(dismissed.most_recent_instance.state).toBe('dismissed');
      expect(dismissed.assignees.map((assignee: any) => assignee.login)).toEqual([TRIAGER_DID]);

      const assigned = parse(await handleShimRequest(ctx, repoUrl(`/code-scanning/alerts?state=dismissed&assignees=${TRIAGER_DID}`)));
      expect(assigned.map((alert: any) => alert.number)).toEqual([1]);

      const reopenedRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/1'), 'PATCH', {
        state     : 'open',
        assignees : [],
      });
      expect(reopenedRes.status).toBe(200);
      const reopened = parse(reopenedRes);
      expect(reopened.state).toBe('open');
      expect(reopened.dismissed_by).toBeNull();
      expect(reopened.dismissed_reason).toBeNull();
      expect(reopened.assignees).toEqual([]);

      const missingAlertRes = await handleShimRequest(ctx, repoUrl('/code-scanning/alerts/999'));
      expect(missingAlertRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/code-scanning/alerts`));
      expect(missingRepoRes.status).toBe(404);
    });

    it('should list, filter, get, update, locate, and report repository secret scanning alerts', async () => {
      await mergeRepoSettings({
        secretScanningAlerts: {
          '1': {
            number                : 1,
            state                 : 'open',
            secretType            : 'github_personal_access_token',
            secretTypeDisplayName : 'GitHub Personal Access Token',
            secret                : 'ghp_secret',
            provider              : 'GitHub',
            providerSlug          : 'github_secret_scanning',
            createdAt             : '2026-03-01T00:00:00.000Z',
            updatedAt             : '2026-03-02T00:00:00.000Z',
            validity              : 'active',
            publiclyLeaked        : true,
            multiRepo             : false,
            isBase64Encoded       : false,
            firstLocationDetected : {
              path         : '/src/config.ts',
              start_line   : 1,
              end_line     : 1,
              start_column : 7,
              end_column   : 17,
              blob_sha     : MAIN_SHA,
              commit_sha   : MAIN_SHA,
            },
            hasMoreLocations : true,
            assignedTo       : null,
            locations        : [
              {
                type    : 'commit',
                details : {
                  path         : '/src/config.ts',
                  start_line   : 1,
                  end_line     : 1,
                  start_column : 7,
                  end_column   : 17,
                  blob_sha     : MAIN_SHA,
                  commit_sha   : MAIN_SHA,
                },
              },
              {
                type    : 'issue_title',
                details : { issue_number: 1, title: 'leaked token' },
              },
            ],
          },
          '2': {
            number                   : 2,
            state                    : 'resolved',
            secretType               : 'slack_webhook_url',
            secretTypeDisplayName    : 'Slack Webhook URL',
            secret                   : 'https://hooks.slack.test/secret',
            provider                 : 'Slack',
            providerSlug             : 'slack',
            createdAt                : '2026-03-03T00:00:00.000Z',
            updatedAt                : '2026-03-04T00:00:00.000Z',
            resolution               : 'revoked',
            resolvedAt               : '2026-03-04T01:00:00.000Z',
            resolvedBy               : TRIAGER_DID,
            validity                 : 'inactive',
            publiclyLeaked           : false,
            multiRepo                : true,
            pushProtectionBypassed   : true,
            pushProtectionBypassedBy : MAINTAINER_DID,
            pushProtectionBypassedAt : '2026-03-03T05:00:00.000Z',
            assignedTo               : TRIAGER_DID,
            locations                : [
              {
                type    : 'pull_request_body',
                details : { pull_request_body_url: `${BASE}/repos/${testDid}/test-repo/pulls/7` },
              },
            ],
          },
        },
        secretScanningScanHistory: {
          incrementalScans: [
            { type: 'git', status: 'completed', completedAt: '2026-03-05T00:00:00.000Z' },
          ],
          backfillScans: [
            {
              type        : 'git',
              status      : 'completed',
              startedAt   : '2026-03-01T00:00:00.000Z',
              completedAt : '2026-03-01T00:05:00.000Z',
            },
          ],
          patternUpdateScans          : [],
          customPatternBackfillScans  : [],
          genericSecretsBackfillScans : [],
        },
      });

      const filteredRes = await handleShimRequest(
        ctx,
        repoUrl('/secret-scanning/alerts?state=open&secret_type=github_personal_access_token&providers=github_secret_scanning&validity=active&is_publicly_leaked=true&assignee=none&hide_secret=true'),
      );
      expect(filteredRes.status).toBe(200);
      const filtered = parse(filteredRes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].number).toBe(1);
      expect(filtered[0].secret).toBe('********');
      expect(filtered[0].locations_url).toContain(`/repos/${testDid}/test-repo/secret-scanning/alerts/1/locations`);
      expect(filtered[0].first_location_detected.path).toBe('/src/config.ts');

      const invalidSecretTypeFilterRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts?secret_type=a&exclude_secret_types=b'));
      expect(invalidSecretTypeFilterRes.status).toBe(422);

      const invalidProviderFilterRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts?providers=a&exclude_providers=b'));
      expect(invalidProviderFilterRes.status).toBe(422);

      const getRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/2'));
      expect(getRes.status).toBe(200);
      const resolved = parse(getRes);
      expect(resolved.resolution).toBe('revoked');
      expect(resolved.resolved_by.login).toBe(TRIAGER_DID);
      expect(resolved.push_protection_bypassed_by.login).toBe(MAINTAINER_DID);

      const locationsRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/1/locations?per_page=1'));
      expect(locationsRes.status).toBe(200);
      expect(locationsRes.headers.Link).toContain('rel="next"');
      expect(parse(locationsRes)[0].type).toBe('commit');

      const historyRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/scan-history'));
      expect(historyRes.status).toBe(200);
      expect(parse(historyRes).incremental_scans[0].completed_at).toBe('2026-03-05T00:00:00.000Z');

      const invalidResolveRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/1'), 'PATCH', {
        state: 'resolved',
      });
      expect(invalidResolveRes.status).toBe(422);

      const resolvedRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/1'), 'PATCH', {
        state              : 'resolved',
        resolution         : 'false_positive',
        resolution_comment : 'Token was generated for fixture coverage.',
        validity           : 'inactive',
        assignee           : TRIAGER_DID,
      });
      expect(resolvedRes.status).toBe(200);
      const updated = parse(resolvedRes);
      expect(updated.state).toBe('resolved');
      expect(updated.resolution).toBe('false_positive');
      expect(updated.resolved_by.login).toBe(testDid);
      expect(updated.resolution_comment).toBe('Token was generated for fixture coverage.');
      expect(updated.validity).toBe('inactive');
      expect(updated.assigned_to.login).toBe(TRIAGER_DID);

      const assigned = parse(await handleShimRequest(ctx, repoUrl(`/secret-scanning/alerts?resolution=false_positive&assignee=${TRIAGER_DID}`)));
      expect(assigned.map((alert: any) => alert.number)).toEqual([1]);

      const reopenedRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/1'), 'PATCH', {
        state    : 'open',
        assignee : null,
      });
      expect(reopenedRes.status).toBe(200);
      const reopened = parse(reopenedRes);
      expect(reopened.state).toBe('open');
      expect(reopened.resolution).toBeNull();
      expect(reopened.resolved_by).toBeNull();
      expect(reopened.assigned_to).toBeNull();

      const missingAlertRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/999'));
      expect(missingAlertRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/secret-scanning/alerts`));
      expect(missingRepoRes.status).toBe(404);
    });

    it('should create repository secret scanning push protection bypasses', async () => {
      await mergeRepoSettings({
        secretScanningAlerts: {
          '7': {
            number                : 7,
            state                 : 'open',
            secretType            : 'github_personal_access_token',
            secretTypeDisplayName : 'GitHub Personal Access Token',
            secret                : 'ghp_push_protected',
            provider              : 'GitHub',
            providerSlug          : 'github_secret_scanning',
            createdAt             : '2026-03-07T00:00:00.000Z',
            updatedAt             : '2026-03-07T00:00:00.000Z',
          },
        },
        secretScanningPushProtectionBypasses: {
          'placeholder-123': {
            placeholderId : 'placeholder-123',
            tokenType     : 'github_personal_access_token',
            expireAt      : '2026-03-07T03:00:00.000Z',
            alertNumber   : 7,
          },
        },
      });

      const createRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/push-protection-bypasses'), 'POST', {
        reason         : 'will_fix_later',
        placeholder_id : 'placeholder-123',
      });
      expect(createRes.status).toBe(200);
      expect(parse(createRes)).toEqual({
        reason     : 'will_fix_later',
        expire_at  : '2026-03-07T03:00:00.000Z',
        token_type : 'github_personal_access_token',
      });

      const alertRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/alerts/7'));
      expect(alertRes.status).toBe(200);
      const alert = parse(alertRes);
      expect(alert.push_protection_bypassed).toBe(true);
      expect(alert.push_protection_bypassed_by.login).toBe(testDid);
      expect(alert.push_protection_bypassed_at).toBeDefined();

      const invalidReasonRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/push-protection-bypasses'), 'POST', {
        reason         : 'bad_reason',
        placeholder_id : 'placeholder-123',
      });
      expect(invalidReasonRes.status).toBe(422);

      const missingPlaceholderRes = await handleShimRequest(ctx, repoUrl('/secret-scanning/push-protection-bypasses'), 'POST', {
        reason         : 'false_positive',
        placeholder_id : 'missing-placeholder',
      });
      expect(missingPlaceholderRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/missing-repo/secret-scanning/push-protection-bypasses`),
        'POST',
        { reason: 'used_in_tests', placeholder_id: 'placeholder-123' },
      );
      expect(missingRepoRes.status).toBe(404);
    });

    it('should list, filter, get, and update repository Dependabot alerts', async () => {
      await mergeRepoSettings({
        dependabotAlerts: {
          '1': {
            number     : 1,
            state      : 'open',
            dependency : {
              package      : { ecosystem: 'npm', name: 'lodash' },
              manifestPath : 'package-lock.json',
              scope        : 'runtime',
            },
            securityAdvisory: {
              ghsa_id        : 'GHSA-test-lodash',
              cve_id         : 'CVE-2026-0001',
              summary        : 'Prototype pollution in lodash',
              description    : 'A crafted payload can modify object prototypes.',
              severity       : 'high',
              classification : 'general',
              epss           : { percentage: 0.42, percentile: '0.90' },
            },
            securityVulnerability: {
              package                  : { ecosystem: 'npm', name: 'lodash' },
              severity                 : 'high',
              vulnerable_version_range : '< 4.17.21',
              first_patched_version    : { identifier: '4.17.21' },
            },
            createdAt : '2026-01-01T00:00:00.000Z',
            updatedAt : '2026-01-02T00:00:00.000Z',
          },
          '2': {
            number     : 2,
            state      : 'fixed',
            dependency : {
              package      : { ecosystem: 'pip', name: 'django' },
              manifestPath : 'requirements.txt',
              scope        : 'development',
            },
            securityAdvisory: {
              ghsa_id        : 'GHSA-test-django',
              summary        : 'Information exposure in django',
              description    : 'A diagnostic endpoint leaks metadata.',
              severity       : 'medium',
              classification : 'general',
            },
            securityVulnerability: {
              package                  : { ecosystem: 'pip', name: 'django' },
              severity                 : 'medium',
              vulnerable_version_range : '< 4.2.1',
              first_patched_version    : null,
            },
            createdAt : '2026-01-03T00:00:00.000Z',
            updatedAt : '2026-01-04T00:00:00.000Z',
            fixedAt   : '2026-01-04T00:00:00.000Z',
          },
        },
      });

      const filteredRes = await handleShimRequest(
        ctx,
        repoUrl('/dependabot/alerts?state=open&severity=high&ecosystem=npm&package=lodash&manifest=package-lock.json&has=patch'),
      );
      expect(filteredRes.status).toBe(200);
      const filtered = parse(filteredRes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].number).toBe(1);
      expect(filtered[0].dependency).toEqual({
        package       : { ecosystem: 'npm', name: 'lodash' },
        manifest_path : 'package-lock.json',
        scope         : 'runtime',
      });
      expect(filtered[0].security_advisory.ghsa_id).toBe('GHSA-test-lodash');
      expect(filtered[0].security_vulnerability.first_patched_version.identifier).toBe('4.17.21');
      expect(filtered[0].url).toContain(`/repos/${testDid}/test-repo/dependabot/alerts/1`);
      expect(filtered[0].repository.full_name).toBe(`${testDid}/test-repo`);

      const pagedRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts?per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(pagedRes.headers.Link).toContain('rel="next"');

      const getRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts/2'));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).fixed_at).toBe('2026-01-04T00:00:00.000Z');

      const invalidFilterRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts?sort=bad'));
      expect(invalidFilterRes.status).toBe(422);

      const invalidDismissRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts/1'), 'PATCH', {
        state: 'dismissed',
      });
      expect(invalidDismissRes.status).toBe(422);

      const dismissedRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts/1'), 'PATCH', {
        state             : 'dismissed',
        dismissed_reason  : 'tolerable_risk',
        dismissed_comment : 'Accepted until the next dependency sweep.',
        assignees         : [TRIAGER_DID],
      });
      expect(dismissedRes.status).toBe(200);
      const dismissed = parse(dismissedRes);
      expect(dismissed.state).toBe('dismissed');
      expect(dismissed.dismissed_by.login).toBe(testDid);
      expect(dismissed.dismissed_reason).toBe('tolerable_risk');
      expect(dismissed.dismissed_comment).toBe('Accepted until the next dependency sweep.');
      expect(dismissed.assignees.map((assignee: any) => assignee.login)).toEqual([TRIAGER_DID]);

      const assigned = parse(await handleShimRequest(ctx, repoUrl(`/dependabot/alerts?state=dismissed&assignee=${TRIAGER_DID}`)));
      expect(assigned.map((alert: any) => alert.number)).toEqual([1]);

      const reopenedRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts/1'), 'PATCH', {
        state     : 'open',
        assignees : [],
      });
      expect(reopenedRes.status).toBe(200);
      const reopened = parse(reopenedRes);
      expect(reopened.state).toBe('open');
      expect(reopened.dismissed_by).toBeNull();
      expect(reopened.dismissed_reason).toBeNull();
      expect(reopened.assignees).toEqual([]);

      const missingAlertRes = await handleShimRequest(ctx, repoUrl('/dependabot/alerts/999'));
      expect(missingAlertRes.status).toBe(404);

      const missingRepoRes = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/dependabot/alerts`));
      expect(missingRepoRes.status).toBe(404);
    });

    it('should export and fetch repository dependency graph SBOM reports', async () => {
      const exported = await handleShimRequest(ctx, repoUrl('/dependency-graph/sbom'));
      expect(exported.status).toBe(200);
      const body = parse(exported);
      expect(body.sbom.SPDXID).toBe('SPDXRef-DOCUMENT');
      expect(body.sbom.spdxVersion).toBe('SPDX-2.3');
      expect(body.sbom.name).toBe(`${testDid}/test-repo`);
      expect(body.sbom.dataLicense).toBe('CC0-1.0');
      expect(body.sbom.documentNamespace).toContain(`/repos/${testDid}/test-repo/dependency-graph/sbom/`);
      expect(body.sbom.packages).toHaveLength(1);
      expect(body.sbom.packages[0]).toMatchObject({
        name             : `${testDid}/test-repo`,
        SPDXID           : 'SPDXRef-Repository',
        versionInfo      : 'main',
        downloadLocation : `${BASE}/repos/${testDid}/test-repo`,
        filesAnalyzed    : false,
      });
      expect(body.sbom.packages[0].externalRefs[0]).toEqual({
        referenceCategory : 'PACKAGE-MANAGER',
        referenceType     : 'purl',
        referenceLocator  : `pkg:generic/${encodeURIComponent(testDid)}/test-repo@main`,
      });
      expect(body.sbom.relationships).toEqual([{
        spdxElementId      : 'SPDXRef-DOCUMENT',
        relationshipType   : 'DESCRIBES',
        relatedSpdxElement : 'SPDXRef-Repository',
      }]);

      const generate = await handleShimRequest(ctx, repoUrl('/dependency-graph/sbom/generate-report'));
      expect(generate.status).toBe(201);
      const report = parse(generate);
      expect(report.sbom_url).toContain(`/repos/${testDid}/test-repo/dependency-graph/sbom/fetch-report/`);
      expect(generate.headers.Location).toBe(report.sbom_url);

      const fetch = await handleShimRequest(ctx, new URL(report.sbom_url));
      expect(fetch.status).toBe(302);
      expect(fetch.body).toBe('');
      expect(fetch.headers.Location).toBe(`${BASE}/repos/${testDid}/test-repo/dependency-graph/sbom?download=1`);

      const downloaded = await handleShimRequest(ctx, new URL(fetch.headers.Location));
      expect(downloaded.status).toBe(200);
      expect(parse(downloaded)).toEqual(body);

      const missingReport = await handleShimRequest(ctx, repoUrl('/dependency-graph/sbom/fetch-report/00000000-0000-4000-8000-000000000000'));
      expect(missingReport.status).toBe(404);

      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/dependency-graph/sbom`));
      expect(missingRepo.status).toBe(404);
    });

    it('should manage repository custom properties, dispatches, and policy metadata', async () => {
      const initialProperties = await handleShimRequest(ctx, repoUrl('/properties/values'));
      expect(initialProperties.status).toBe(200);
      expect(parse(initialProperties)).toEqual([]);

      const invalidProperties = await handleShimRequest(ctx, repoUrl('/properties/values'), 'PATCH', {
        properties: [{ property_name: 'tier', value: 3 }],
      });
      expect(invalidProperties.status).toBe(422);

      const updateProperties = await handleShimRequest(ctx, repoUrl('/properties/values'), 'PATCH', {
        properties: [
          { property_name: 'runtime', value: 'bun' },
          { property_name: 'labels', value: ['dwn', 'forge'] },
        ],
      });
      expect(updateProperties.status).toBe(204);

      const properties = parse(await handleShimRequest(ctx, repoUrl('/properties/values')));
      expect(properties).toEqual([
        { property_name: 'labels', value: ['dwn', 'forge'] },
        { property_name: 'runtime', value: 'bun' },
      ]);

      const removeProperty = await handleShimRequest(ctx, repoUrl('/properties/values'), 'PATCH', {
        properties: [{ property_name: 'runtime', value: null }],
      });
      expect(removeProperty.status).toBe(204);
      expect(parse(await handleShimRequest(ctx, repoUrl('/properties/values')))).toEqual([
        { property_name: 'labels', value: ['dwn', 'forge'] },
      ]);

      const dispatch = await handleShimRequest(ctx, repoUrl('/dispatches'), 'POST', {
        event_type     : 'sync-requested',
        client_payload : { ref: 'main' },
      });
      expect(dispatch.status).toBe(204);

      const missingDispatchType = await handleShimRequest(ctx, repoUrl('/dispatches'), 'POST', {});
      expect(missingDispatchType.status).toBe(422);

      const tooManyPayloadKeys = await handleShimRequest(ctx, repoUrl('/dispatches'), 'POST', {
        event_type     : 'too-many',
        client_payload : Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key${index}`, index])),
      });
      expect(tooManyPayloadKeys.status).toBe(422);

      const codeowners = parse(await handleShimRequest(ctx, repoUrl('/codeowners/errors')));
      expect(codeowners.errors).toEqual([]);

      const hashAlgorithm = parse(await handleShimRequest(ctx, repoUrl('/hash-algorithm')));
      expect(hashAlgorithm.hash_algorithm).toBe('sha1');

      const initialImmutable = await handleShimRequest(ctx, repoUrl('/immutable-releases'));
      expect(initialImmutable.status).toBe(404);

      const enableImmutable = await handleShimRequest(ctx, repoUrl('/immutable-releases'), 'PUT');
      expect(enableImmutable.status).toBe(204);
      expect(parse(await handleShimRequest(ctx, repoUrl('/immutable-releases')))).toEqual({
        enabled           : true,
        enforced_by_owner : false,
      });

      const disableImmutable = await handleShimRequest(ctx, repoUrl('/immutable-releases'), 'DELETE');
      expect(disableImmutable.status).toBe(204);
      expect((await handleShimRequest(ctx, repoUrl('/immutable-releases'))).status).toBe(404);

      const privateVulnerabilityInitial = parse(await handleShimRequest(ctx, repoUrl('/private-vulnerability-reporting')));
      expect(privateVulnerabilityInitial.enabled).toBe(false);

      const enablePrivateVulnerability = await handleShimRequest(ctx, repoUrl('/private-vulnerability-reporting'), 'PUT');
      expect(enablePrivateVulnerability.status).toBe(204);
      expect(parse(await handleShimRequest(ctx, repoUrl('/private-vulnerability-reporting'))).enabled).toBe(true);

      const disablePrivateVulnerability = await handleShimRequest(ctx, repoUrl('/private-vulnerability-reporting'), 'DELETE');
      expect(disablePrivateVulnerability.status).toBe(204);
      expect(parse(await handleShimRequest(ctx, repoUrl('/private-vulnerability-reporting'))).enabled).toBe(false);
    });

    it('should create and list repository artifact attestations', async () => {
      const digest = `sha256:${'a'.repeat(64)}`;
      const statement = {
        _type         : 'https://in-toto.io/Statement/v1',
        subject       : [{ name: 'dist/test-repo.tgz', digest: { sha256: 'a'.repeat(64) } }],
        predicateType : 'https://slsa.dev/provenance/v1',
        predicate     : { buildType: 'gitd' },
      };
      const bundle = {
        mediaType            : 'application/vnd.dev.sigstore.bundle.v0.3+json',
        verificationMaterial : {},
        dsseEnvelope         : {
          payload     : Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
          payloadType : 'application/vnd.in-toto+json',
          signatures  : [],
        },
      };

      const initiallyEmpty = parse(await handleShimRequest(ctx, repoUrl(`/attestations/${digest}`)));
      expect(initiallyEmpty).toEqual({ attestations: [] });

      const invalid = await handleShimRequest(ctx, repoUrl('/attestations'), 'POST', {});
      expect(invalid.status).toBe(422);

      const create = await handleShimRequest(ctx, repoUrl('/attestations'), 'POST', { bundle });
      expect(create.status).toBe(201);
      const created = parse(create);
      expect(created.subject_digest).toBe(digest);
      expect(created.predicate_type).toBe('https://slsa.dev/provenance/v1');
      expect(created.bundle).toEqual(bundle);

      const list = parse(await handleShimRequest(ctx, repoUrl(`/attestations/${digest}`)));
      expect(list.attestations).toHaveLength(1);
      expect(list.attestations[0].id).toBe(created.id);
      expect(list.attestations[0].bundle.dsseEnvelope.payload).toBe(bundle.dsseEnvelope.payload);

      const filtered = parse(await handleShimRequest(ctx, repoUrl(`/attestations/${digest}?predicate_type=https://slsa.dev/provenance/v1`)));
      expect(filtered.attestations).toHaveLength(1);

      const filteredOut = parse(await handleShimRequest(ctx, repoUrl(`/attestations/${digest}?predicate_type=https://spdx.dev/Document`)));
      expect(filteredOut.attestations).toEqual([]);

      const invalidDigest = await handleShimRequest(ctx, repoUrl('/attestations/sha1:bad'));
      expect(invalidDigest.status).toBe(422);
    });

    it('should list and delete user-scoped artifact attestations', async () => {
      const makeBundle = (hex: string, predicateType: string): Record<string, unknown> => {
        const statement = {
          _type     : 'https://in-toto.io/Statement/v1',
          subject   : [{ name: `dist/${hex}.tgz`, digest: { sha256: hex.repeat(64) } }],
          predicateType,
          predicate : { buildType: 'gitd' },
        };
        return {
          mediaType            : 'application/vnd.dev.sigstore.bundle.v0.3+json',
          verificationMaterial : {},
          dsseEnvelope         : {
            payload     : Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
            payloadType : 'application/vnd.in-toto+json',
            signatures  : [],
          },
        };
      };
      const createAttestation = async (
        hex: string, predicateType: string,
      ): Promise<{ digest: string; attestation: any }> => {
        const digest = `sha256:${hex.repeat(64)}`;
        const create = await handleShimRequest(ctx, repoUrl('/attestations'), 'POST', {
          bundle: makeBundle(hex, predicateType),
        });
        expect(create.status).toBe(201);
        return { digest, attestation: parse(create) };
      };

      const first = await createAttestation('b', 'https://slsa.dev/provenance/v1');
      const second = await createAttestation('c', 'https://spdx.dev/Document');

      const list = await handleShimRequest(
        ctx,
        url(`/users/${testDid}/attestations/${first.digest}?predicate_type=https://slsa.dev/provenance/v1`),
      );
      expect(list.status).toBe(200);
      const listed = parse(list);
      expect(listed.attestations).toHaveLength(1);
      expect(listed.attestations[0].id).toBe(first.attestation.id);
      expect(listed.attestations[0].repository_url).toBe(`${BASE}/repos/${testDid}/test-repo`);

      const bulkList = await handleShimRequest(ctx, url(`/users/${testDid}/attestations/bulk-list`), 'POST', {
        subject_digests : [first.digest, second.digest],
        predicate_type  : 'https://spdx.dev/Document',
      });
      expect(bulkList.status).toBe(200);
      const bulkListed = parse(bulkList);
      expect(bulkListed.attestations).toHaveLength(1);
      expect(bulkListed.attestations[0].subject_digest).toBe(second.digest);

      const invalidList = await handleShimRequest(ctx, url(`/users/${testDid}/attestations/sha1:bad`));
      expect(invalidList.status).toBe(422);

      const invalidBulk = await handleShimRequest(ctx, url(`/users/${testDid}/attestations/bulk-list`), 'POST', {
        subject_digests: ['sha1:bad'],
      });
      expect(invalidBulk.status).toBe(422);

      const deleteById = await handleShimRequest(
        ctx, url(`/users/${testDid}/attestations/${first.attestation.id}`), 'DELETE',
      );
      expect(deleteById.status).toBe(200);
      expect(parse(deleteById).attestations[0].subject_digest).toBe(first.digest);
      const afterDeleteById = parse(await handleShimRequest(ctx, url(`/users/${testDid}/attestations/${first.digest}`)));
      expect(afterDeleteById.attestations).toEqual([]);

      const deleteByDigest = await handleShimRequest(
        ctx, url(`/users/${testDid}/attestations/digest/${second.digest}`), 'DELETE',
      );
      expect(deleteByDigest.status).toBe(200);
      expect(parse(deleteByDigest).attestations[0].subject_digest).toBe(second.digest);

      const third = await createAttestation('d', 'https://slsa.dev/provenance/v1');
      const bulkDelete = await handleShimRequest(ctx, url(`/users/${testDid}/attestations`), 'DELETE', {
        subject_digests: [third.digest],
      });
      expect(bulkDelete.status).toBe(200);
      expect(parse(bulkDelete).attestations[0].subject_digest).toBe(third.digest);

      const missingDelete = await handleShimRequest(ctx, url(`/users/${testDid}/attestations/99999999`), 'DELETE');
      expect(missingDelete.status).toBe(404);
    });

    it('should create, list, update, version, and delete repository rulesets', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/rulesets'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const invalidTarget = await handleShimRequest(ctx, repoUrl('/rulesets'), 'POST', {
        name        : 'bad target',
        target      : 'repository',
        enforcement : 'active',
      });
      expect(invalidTarget.status).toBe(422);

      const invalidRules = await handleShimRequest(ctx, repoUrl('/rulesets'), 'POST', {
        name        : 'bad rules',
        enforcement : 'active',
        rules       : [{ parameters: {} }],
      });
      expect(invalidRules.status).toBe(422);

      const create = await handleShimRequest(ctx, repoUrl('/rulesets'), 'POST', {
        name        : 'main branch rules',
        target      : 'branch',
        enforcement : 'active',
        conditions  : {
          ref_name: {
            include : ['refs/heads/main'],
            exclude : ['refs/heads/dev*'],
          },
        },
        rules: [{
          type       : 'commit_author_email_pattern',
          parameters : {
            operator : 'contains',
            pattern  : '@example.test',
          },
        }],
      });
      expect(create.status).toBe(201);
      const ruleset = parse(create);
      expect(ruleset.name).toBe('main branch rules');
      expect(ruleset.target).toBe('branch');
      expect(ruleset.source_type).toBe('Repository');
      expect(ruleset.source).toBe(`${testDid}/test-repo`);
      expect(ruleset.enforcement).toBe('active');
      expect(ruleset.rules).toHaveLength(1);
      expect(ruleset._links.self.href).toContain(`/rulesets/${ruleset.id}`);

      const list = parse(await handleShimRequest(ctx, repoUrl('/rulesets?targets=branch')));
      expect(list.map((item: any) => item.id)).toContain(ruleset.id);

      const filteredOut = parse(await handleShimRequest(ctx, repoUrl('/rulesets?targets=tag')));
      expect(filteredOut.map((item: any) => item.id)).not.toContain(ruleset.id);

      const invalidFilter = await handleShimRequest(ctx, repoUrl('/rulesets?targets=repository'));
      expect(invalidFilter.status).toBe(422);

      const get = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`));
      expect(get.status).toBe(200);
      expect(parse(get).conditions.ref_name.include).toEqual(['refs/heads/main']);

      const branchRules = parse(await handleShimRequest(ctx, repoUrl('/rules/branches/main')));
      expect(branchRules).toHaveLength(1);
      expect(branchRules[0].type).toBe('commit_author_email_pattern');
      expect(branchRules[0].ruleset_id).toBe(ruleset.id);
      expect(branchRules[0].ruleset_source_type).toBe('Repository');

      const excludedBranchRules = parse(await handleShimRequest(ctx, repoUrl('/rules/branches/dev-demo')));
      expect(excludedBranchRules).toEqual([]);

      const wildcardBranch = await handleShimRequest(ctx, repoUrl('/rules/branches/main*'));
      expect(wildcardBranch.status).toBe(422);

      const update = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`), 'PUT', {
        name        : 'main branch rules v2',
        enforcement : 'evaluate',
        rules       : [{ type: 'required_signatures' }],
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.name).toBe('main branch rules v2');
      expect(updated.enforcement).toBe('evaluate');
      expect(updated.rules).toEqual([{ type: 'required_signatures' }]);

      const evaluatedBranchRules = parse(await handleShimRequest(ctx, repoUrl('/rules/branches/main')));
      expect(evaluatedBranchRules).toEqual([]);

      const history = parse(await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}/history`)));
      expect(history.map((entry: any) => entry.version_id)).toEqual([2, 1]);
      expect(history[0].actor.type).toBe('User');

      const version = parse(await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}/history/1`)));
      expect(version.version_id).toBe(1);
      expect(version.state.name).toBe('main branch rules');
      expect(version.state.enforcement).toBe('active');

      const missingVersion = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}/history/99`));
      expect(missingVersion.status).toBe(404);

      const deleted = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`));
      expect(missing.status).toBe(404);
    });

    it('should list, filter, and get repository rule suites', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const nowMs = Date.now();
      await mergeRepoSettings({
        ruleSuites: {
          '42': {
            id               : 42,
            actorId          : 12,
            actorName        : MAINTAINER_DID,
            beforeSha        : MAIN_SHA,
            afterSha         : FEATURE_SHA,
            ref              : 'refs/heads/main',
            repositoryId     : 404,
            repositoryName   : 'test-repo',
            pushedAt         : new Date(nowMs).toISOString(),
            result           : 'pass',
            evaluationResult : 'fail',
            ruleEvaluations  : [{
              ruleSource  : { type: 'ruleset', id: 7, name: 'main branch rules' },
              enforcement : 'evaluate',
              result      : 'fail',
              ruleType    : 'required_status_checks',
              details     : 'Required check failed.',
            }],
          },
          '43': {
            id              : 43,
            actorName       : TRIAGER_DID,
            beforeSha       : FEATURE_SHA,
            afterSha        : TAG_SHA,
            ref             : 'refs/tags/v1.0',
            pushedAt        : new Date(nowMs - 1000).toISOString(),
            result          : 'bypass',
            ruleEvaluations : [{
              ruleSource  : { type: 'protected_branch' },
              enforcement : 'active',
              result      : 'pass',
              ruleType    : 'pull_request',
            }],
          },
        },
      });

      const list = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?per_page=1'));
      expect(list.status).toBe(200);
      expect(list.headers.Link).toContain('rel="next"');
      const suites = parse(list);
      expect(suites).toHaveLength(1);
      expect(suites[0]).toMatchObject({
        id                : 42,
        actor_id          : 12,
        actor_name        : MAINTAINER_DID,
        before_sha        : MAIN_SHA,
        after_sha         : FEATURE_SHA,
        ref               : 'refs/heads/main',
        repository_id     : 404,
        repository_name   : 'test-repo',
        result            : 'pass',
        evaluation_result : 'fail',
      });
      expect(suites[0].rule_evaluations).toBeUndefined();

      const filterPath = `/rulesets/rule-suites?ref=main&actor_name=${encodeURIComponent(MAINTAINER_DID)}`
        + '&rule_suite_result=pass&evaluate_status=evaluate';
      const filtered = parse(await handleShimRequest(
        ctx,
        repoUrl(filterPath),
      ));
      expect(filtered.map((suite: any) => suite.id)).toEqual([42]);

      const activeOnly = parse(await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?evaluate_status=active')));
      expect(activeOnly.map((suite: any) => suite.id)).toEqual([43]);

      const detail = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites/42'));
      expect(detail.status).toBe(200);
      const suite = parse(detail);
      expect(suite.rule_evaluations).toHaveLength(1);
      expect(suite.rule_evaluations[0].rule_source.name).toBe('main branch rules');
      expect(suite.rule_evaluations[0].rule_type).toBe('required_status_checks');
      expect(suite.pushed_at).toBe(new Date(nowMs).toISOString());

      const invalidRef = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?ref=main*'));
      expect(invalidRef.status).toBe(422);
      const invalidResult = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?rule_suite_result=skipped'));
      expect(invalidResult.status).toBe(422);
      const invalidEvaluateStatus = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?evaluate_status=disabled'));
      expect(invalidEvaluateStatus.status).toBe(422);
      const invalidTimePeriod = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites?time_period=year'));
      expect(invalidTimePeriod.status).toBe(422);

      const missingSuite = await handleShimRequest(ctx, repoUrl('/rulesets/rule-suites/999'));
      expect(missingSuite.status).toBe(404);
      const missingRepo = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/rulesets/rule-suites`));
      expect(missingRepo.status).toBe(404);
    });

    it('should list assignable users from repo collaborators', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/assignees'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(data.map((item: any) => item.login)).toContain(TRIAGER_DID);
      expect(data.find((item: any) => item.login === MAINTAINER_DID).name).toBe('Alice');
    });

    it('should check whether a user can be assigned', async () => {
      const assignableRes = await handleShimRequest(ctx, repoUrl(`/assignees/${encodeURIComponent(MAINTAINER_DID)}`));
      expect(assignableRes.status).toBe(204);
      expect(assignableRes.body).toBe('');

      const missingRes = await handleShimRequest(ctx, repoUrl(`/assignees/${encodeURIComponent(NEW_COLLABORATOR_DID)}`));
      expect(missingRes.status).toBe(404);
    });

    it('should list collaborators with GitHub permission metadata', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/collaborators'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(data.map((item: any) => item.login)).toContain(TRIAGER_DID);

      const maintainer = data.find((item: any) => item.login === MAINTAINER_DID);
      expect(maintainer.role_name).toBe('maintainer');
      expect(maintainer.permissions.admin).toBe(true);

      const triager = data.find((item: any) => item.login === TRIAGER_DID);
      expect(triager.role_name).toBe('triager');
      expect(triager.permissions.triage).toBe(true);
      expect(triager.permissions.push).toBe(false);
    });

    it('should filter collaborators by repository permission', async () => {
      const adminRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=admin'));
      expect(adminRes.status).toBe(200);
      const admins = parse(adminRes);
      expect(admins.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(admins.map((item: any) => item.login)).not.toContain(TRIAGER_DID);
      expect(admins.every((item: any) => item.permissions.admin === true)).toBe(true);

      const pushRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=push'));
      expect(pushRes.status).toBe(200);
      const pushCollaborators = parse(pushRes);
      expect(pushCollaborators.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(pushCollaborators.map((item: any) => item.login)).not.toContain(TRIAGER_DID);
      expect(pushCollaborators.every((item: any) => item.permissions.push === true)).toBe(true);

      const triageRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=triage'));
      expect(triageRes.status).toBe(200);
      const triageCollaborators = parse(triageRes);
      expect(triageCollaborators.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(triageCollaborators.map((item: any) => item.login)).toContain(TRIAGER_DID);
      expect(triageCollaborators.every((item: any) => item.permissions.triage === true)).toBe(true);

      const pullRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=pull'));
      expect(pullRes.status).toBe(200);
      const pullCollaborators = parse(pullRes);
      expect(pullCollaborators.length).toBeGreaterThanOrEqual(triageCollaborators.length);
      expect(pullCollaborators.every((item: any) => item.permissions.pull === true)).toBe(true);

      const invalidRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=owner'));
      expect(invalidRes.status).toBe(422);
      expect(parse(invalidRes).message).toContain('permission');
    });

    it('should filter collaborators by affiliation', async () => {
      const outsideRes = await handleShimRequest(ctx, repoUrl('/collaborators?affiliation=outside'));
      expect(outsideRes.status).toBe(200);
      const outside = parse(outsideRes);
      expect(outside.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(outside.map((item: any) => item.login)).toContain(TRIAGER_DID);
      expect(outside.map((item: any) => item.login)).not.toContain(testDid);

      const directRes = await handleShimRequest(ctx, repoUrl('/collaborators?affiliation=direct'));
      expect(directRes.status).toBe(200);
      const direct = parse(directRes);
      expect(direct.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(direct.map((item: any) => item.login)).toContain(TRIAGER_DID);

      const allRes = await handleShimRequest(ctx, repoUrl('/collaborators?affiliation=all'));
      expect(allRes.status).toBe(200);
      expect(parse(allRes).map((item: any) => item.login).sort()).toEqual(direct.map((item: any) => item.login).sort());

      const combinedRes = await handleShimRequest(ctx, repoUrl('/collaborators?affiliation=outside&permission=admin'));
      expect(combinedRes.status).toBe(200);
      const combined = parse(combinedRes);
      expect(combined.map((item: any) => item.login)).toContain(MAINTAINER_DID);
      expect(combined.map((item: any) => item.login)).not.toContain(TRIAGER_DID);

      const invalidRes = await handleShimRequest(ctx, repoUrl('/collaborators?affiliation=members'));
      expect(invalidRes.status).toBe(422);
      expect(parse(invalidRes).message).toContain('affiliation');
    });

    it('should return 204 when checking an existing collaborator', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodeURIComponent(MAINTAINER_DID)}`));
      expect(res.status).toBe(204);
      expect(res.body).toBe('');
    });

    it('should return collaborator permissions', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodeURIComponent(MAINTAINER_DID)}/permission`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.permission).toBe('admin');
      expect(data.role_name).toBe('maintainer');
      expect(data.user.login).toBe(MAINTAINER_DID);
    });

    it('should add and remove collaborators', async () => {
      const encodedDid = encodeURIComponent(NEW_COLLABORATOR_DID);
      const addRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`), 'PUT', {
        permission : 'triage',
        alias      : 'New Triage',
      });
      expect(addRes.status).toBe(201);
      const invite = parse(addRes);
      expect(invite.invitee.login).toBe(NEW_COLLABORATOR_DID);
      expect(invite.role_name).toBe('triager');

      const permissionRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}/permission`));
      expect(permissionRes.status).toBe(200);
      expect(parse(permissionRes).permission).toBe('triage');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`), 'PUT', {
        permission : 'push',
        alias      : 'New Write',
      });
      expect(updateRes.status).toBe(204);
      expect(updateRes.body).toBe('');

      const updatedPermissionRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}/permission`));
      expect(updatedPermissionRes.status).toBe(200);
      const updatedPermission = parse(updatedPermissionRes);
      expect(updatedPermission.permission).toBe('write');
      expect(updatedPermission.role_name).toBe('contributor');

      const removeRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`), 'DELETE');
      expect(removeRes.status).toBe(204);

      const checkRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`));
      expect(checkRes.status).toBe(404);
    });

    it('should add and remove pull-only collaborators', async () => {
      const viewerDid = 'did:jwk:viewer123';
      const encodedDid = encodeURIComponent(viewerDid);
      const addRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`), 'PUT', {
        permission : 'pull',
        alias      : 'Read Only',
      });
      expect(addRes.status).toBe(201);
      const invite = parse(addRes);
      expect(invite.invitee.login).toBe(viewerDid);
      expect(invite.role_name).toBe('viewer');
      expect(invite.permissions).toBe('pull');

      const permissionRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}/permission`));
      expect(permissionRes.status).toBe(200);
      const permission = parse(permissionRes);
      expect(permission.permission).toBe('pull');
      expect(permission.role_name).toBe('viewer');

      const pullRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=pull'));
      expect(parse(pullRes).map((item: any) => item.login)).toContain(viewerDid);

      const triageRes = await handleShimRequest(ctx, repoUrl('/collaborators?permission=triage'));
      expect(parse(triageRes).map((item: any) => item.login)).not.toContain(viewerDid);

      const removeRes = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodedDid}`), 'DELETE');
      expect(removeRes.status).toBe(204);
    });

    it('should reject unsupported collaborator permissions', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/collaborators/${encodeURIComponent(NEW_COLLABORATOR_DID)}`), 'PUT', {
        permission: 'owner',
      });
      expect(res.status).toBe(422);
    });

    it('should create, list, get, ping, test, and delete repository webhooks', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/hooks'));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const create = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        name   : 'web',
        active : true,
        events : ['push', 'pull_request'],
        config : {
          url          : 'https://example.com/webhook',
          content_type : 'json',
          insecure_ssl : '0',
          secret       : 'top-secret',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);
      expect(hook.name).toBe('web');
      expect(hook.active).toBe(true);
      expect(hook.events).toEqual(['push', 'pull_request']);
      expect(hook.config.url).toBe('https://example.com/webhook');
      expect(hook.config.secret).toBeUndefined();

      const list = await handleShimRequest(ctx, repoUrl('/hooks'));
      expect(parse(list).map((item: any) => item.id)).toContain(hook.id);

      const fetched = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).id).toBe(hook.id);

      const config = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/config`));
      expect(config.status).toBe(200);
      expect(parse(config).secret).toBe('********');

      const ping = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/pings`), 'POST');
      expect(ping.status).toBe(204);

      const test = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/tests`), 'POST');
      expect(test.status).toBe(204);

      const deleted = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`));
      expect(missing.status).toBe(404);
    });

    it('should list, get, filter, and redeliver repository webhook deliveries', async () => {
      const create = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        active : true,
        events : ['push'],
        config : {
          url    : 'https://example.com/deliveries',
          secret : 'delivery-secret',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);

      const initial = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries`));
      expect(initial.status).toBe(200);
      expect(parse(initial)).toEqual([]);

      const ping = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/pings`), 'POST');
      expect(ping.status).toBe(204);
      const test = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/tests`), 'POST');
      expect(test.status).toBe(204);

      const onePage = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries?per_page=1`));
      expect(onePage.status).toBe(200);
      expect(parse(onePage)).toHaveLength(1);
      expect(onePage.headers.Link).toContain('cursor=');

      const list = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries`));
      expect(list.status).toBe(200);
      const deliveries = parse(list);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((delivery: any) => delivery.event).sort()).toEqual(['ping', 'push']);
      expect(deliveries.every((delivery: any) => delivery.status_code === 200)).toBe(true);

      const success = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries?status=success`));
      expect(success.status).toBe(200);
      expect(parse(success)).toHaveLength(2);

      const failure = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries?status=failure`));
      expect(failure.status).toBe(200);
      expect(parse(failure)).toHaveLength(0);

      const invalidStatus = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries?status=unknown`));
      expect(invalidStatus.status).toBe(422);

      const pushDelivery = deliveries.find((delivery: any) => delivery.event === 'push');
      const detail = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries/${pushDelivery.id}`));
      expect(detail.status).toBe(200);
      const detailed = parse(detail);
      expect(detailed.url).toBe('https://example.com/deliveries');
      expect(detailed.request.headers['X-GitHub-Event']).toBe('push');
      expect(detailed.request.payload.repository.full_name).toBe(`${testDid}/test-repo`);
      expect(detailed.response.payload).toBe('ok');

      const redeliver = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries/${pushDelivery.id}/attempts`), 'POST');
      expect(redeliver.status).toBe(202);

      const afterRedelivery = parse(await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries`)));
      const redelivered = afterRedelivery.find((delivery: any) => delivery.redelivery === true);
      expect(afterRedelivery).toHaveLength(3);
      expect(redelivered.guid).toBe(pushDelivery.guid);

      const missing = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/deliveries/999999`));
      expect(missing.status).toBe(404);

      const deleted = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
    });

    it('should update repository webhooks and webhook configuration', async () => {
      const create = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        active : true,
        events : ['push'],
        config : {
          url    : 'https://example.com/original',
          secret : 'alpha',
        },
      });
      expect(create.status).toBe(201);
      const hook = parse(create);

      const update = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`), 'PATCH', {
        active        : false,
        add_events    : ['issues'],
        remove_events : ['push'],
        config        : {
          url          : 'https://example.com/updated',
          content_type : 'json',
          secret       : 'beta',
        },
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.active).toBe(false);
      expect(updated.events).toEqual(['issues']);
      expect(updated.config.url).toBe('https://example.com/updated');

      const config = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}/config`), 'PATCH', {
        url    : 'https://example.com/config',
        secret : 'gamma',
      });
      expect(config.status).toBe(200);
      expect(parse(config).url).toBe('https://example.com/config');
      expect(parse(config).secret).toBe('********');

      const fetched = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`));
      expect(parse(fetched).config.url).toBe('https://example.com/config');

      const deleted = await handleShimRequest(ctx, repoUrl(`/hooks/${hook.id}`), 'DELETE');
      expect(deleted.status).toBe(204);
    });

    it('should reject invalid repository webhook payloads', async () => {
      const missingConfig = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        events: ['push'],
      });
      expect(missingConfig.status).toBe(422);

      const invalidName = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        name   : 'email',
        config : { url: 'https://example.com/webhook' },
      });
      expect(invalidName.status).toBe(422);

      const invalidUrl = await handleShimRequest(ctx, repoUrl('/hooks'), 'POST', {
        config: { url: 'not-a-url' },
      });
      expect(invalidUrl.status).toBe(422);
    });

    it('should return 404 for missing repository webhooks', async () => {
      const get = await handleShimRequest(ctx, repoUrl('/hooks/999999'));
      expect(get.status).toBe(404);

      const config = await handleShimRequest(ctx, repoUrl('/hooks/999999/config'));
      expect(config.status).toBe(404);

      const ping = await handleShimRequest(ctx, repoUrl('/hooks/999999/pings'), 'POST');
      expect(ping.status).toBe(404);
    });

    it('should list, get, mark read, and delete notification threads', async () => {
      const { record } = await ctx.notifications.records.create('notification', {
        data: {
          title : 'Fix the widget was mentioned',
          body  : 'You were mentioned on the widget issue.',
          url   : `${BASE}/repos/${testDid}/test-repo/issues/${issueRecId}`,
        },
        tags: {
          type           : 'mention',
          read           : false,
          repoDid        : testDid,
          repoRecordId   : repoRecordId,
          sourceRecordId : issueRecId,
          subjectType    : 'Issue',
        },
      });
      const threadId = String(numericId(record!.id));

      const list = await handleShimRequest(ctx, url('/notifications'));
      expect(list.status).toBe(200);
      const listData = parse(list);
      const listed = listData.find((item: any) => item.id === threadId);
      expect(listed.unread).toBe(true);
      expect(listed.reason).toBe('mention');
      expect(listed.repository.name).toBe('test-repo');
      expect(listed.subject.type).toBe('Issue');

      const repoList = await handleShimRequest(ctx, repoUrl('/notifications'));
      expect(repoList.status).toBe(200);
      expect(parse(repoList).map((item: any) => item.id)).toContain(threadId);

      const thread = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`));
      expect(thread.status).toBe(200);
      expect(parse(thread).subject.title).toBe('Fix the widget was mentioned');

      const markRead = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`), 'PATCH');
      expect(markRead.status).toBe(205);

      const unreadList = await handleShimRequest(ctx, url('/notifications'));
      expect(parse(unreadList).map((item: any) => item.id)).not.toContain(threadId);

      const allList = await handleShimRequest(ctx, url('/notifications?all=true'));
      expect(parse(allList).find((item: any) => item.id === threadId).unread).toBe(false);

      const deleted = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`));
      expect(missing.status).toBe(404);
    });

    it('should mark repository notifications as read without touching unrelated threads', async () => {
      const { record: repoNotification } = await ctx.notifications.records.create('notification', {
        data: {
          title : 'Repository issue comment',
          body  : 'A new issue comment arrived.',
          url   : `${BASE}/repos/${testDid}/test-repo/issues/${issueRecId}`,
        },
        tags: {
          type           : 'issue_comment',
          read           : false,
          repoDid        : testDid,
          repoRecordId   : repoRecordId,
          sourceRecordId : issueRecId,
          subjectType    : 'Issue',
        },
      });
      const { record: unrelatedNotification } = await ctx.notifications.records.create('notification', {
        data : { title: 'Standalone mention', body: 'No repository attached.' },
        tags : { type: 'mention', read: false },
      });
      const repoThreadId = String(numericId(repoNotification!.id));
      const unrelatedThreadId = String(numericId(unrelatedNotification!.id));

      const markRepoRead = await handleShimRequest(ctx, repoUrl('/notifications'), 'PUT');
      expect(markRepoRead.status).toBe(205);

      const repoThread = parse(await handleShimRequest(ctx, url(`/notifications/threads/${repoThreadId}`)));
      expect(repoThread.unread).toBe(false);

      const unrelatedThread = parse(await handleShimRequest(ctx, url(`/notifications/threads/${unrelatedThreadId}`)));
      expect(unrelatedThread.unread).toBe(true);

      expect((await handleShimRequest(ctx, url(`/notifications/threads/${repoThreadId}`), 'DELETE')).status).toBe(204);
      expect((await handleShimRequest(ctx, url(`/notifications/threads/${unrelatedThreadId}`), 'DELETE')).status).toBe(204);
    });

    it('should get, set, and delete notification thread subscriptions', async () => {
      const { record } = await ctx.notifications.records.create('notification', {
        data: {
          title : 'Review requested',
          body  : 'Please review a pull request.',
          url   : `${BASE}/repos/${testDid}/test-repo/pulls/${patchRecId}`,
        },
        tags: {
          type           : 'review_request',
          read           : false,
          repoDid        : testDid,
          repoRecordId   : repoRecordId,
          sourceRecordId : patchRecId,
          subjectType    : 'PullRequest',
        },
      });
      const threadId = String(numericId(record!.id));

      const initial = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}/subscription`));
      expect(initial.status).toBe(200);
      expect(parse(initial).subscribed).toBe(true);
      expect(parse(initial).ignored).toBe(false);

      const ignored = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}/subscription`), 'PUT', {
        ignored: true,
      });
      expect(ignored.status).toBe(200);
      expect(parse(ignored).subscribed).toBe(false);
      expect(parse(ignored).ignored).toBe(true);

      const deleted = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}/subscription`), 'DELETE');
      expect(deleted.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, url(`/notifications/threads/${threadId}/subscription`));
      expect(parse(afterDelete).subscribed).toBe(false);
      expect(parse(afterDelete).ignored).toBe(false);

      expect((await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`), 'DELETE')).status).toBe(204);
    });

    it('should validate notification filters and missing threads', async () => {
      const invalidSince = await handleShimRequest(ctx, url('/notifications?since=not-a-date'));
      expect(invalidSince.status).toBe(422);

      const missingThread = await handleShimRequest(ctx, url('/notifications/threads/999999'));
      expect(missingThread.status).toBe(404);

      const missingSubscription = await handleShimRequest(ctx, url('/notifications/threads/999999/subscription'));
      expect(missingSubscription.status).toBe(404);

      const { record } = await ctx.notifications.records.create('notification', {
        data : { title: 'Invalid subscription payload' },
        tags : { type: 'mention', read: false },
      });
      const threadId = String(numericId(record!.id));

      const invalidSubscription = await handleShimRequest(
        ctx,
        url(`/notifications/threads/${threadId}/subscription`),
        'PUT',
        { ignored: 'yes' },
      );
      expect(invalidSubscription.status).toBe(422);

      expect((await handleShimRequest(ctx, url(`/notifications/threads/${threadId}`), 'DELETE')).status).toBe(204);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/readme, /license, /contents
  // =========================================================================

  describe('repository contents endpoints', () => {
    it('should return README content as a GitHub content object', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/readme'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('README.md');
      expect(data.path).toBe('README.md');
      expect(data.type).toBe('file');
      expect(data.encoding).toBe('base64');

      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      expect(decoded).toContain('Readme from DWN metadata');

      const raw = await handleShimRequest(ctx, repoUrl('/readme'), 'GET', {}, null, {
        accept: 'application/vnd.github.raw+json',
      });
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
      expect(bodyBuffer(raw).toString('utf-8')).toContain('Readme from DWN metadata');

      const html = await handleShimRequest(ctx, repoUrl('/readme'), 'GET', {}, null, {
        accept: 'application/vnd.github.html',
      });
      expect(html.status).toBe(200);
      expect(html.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(bodyBuffer(html).toString('utf-8')).toContain('<h1>Test Repo</h1>');
    });

    it('should return license content with a license metadata field', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/license'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('LICENSE');
      expect(data.license).toBeNull();
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('Apache-2.0');

      const raw = await handleShimRequest(ctx, repoUrl('/license'), 'GET', {}, null, {
        accept: 'application/vnd.github.raw+json',
      });
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(bodyBuffer(raw).toString('utf-8')).toContain('Apache-2.0');

      const html = await handleShimRequest(ctx, repoUrl('/license'), 'GET', {}, null, {
        accept: 'application/vnd.github.html+json',
      });
      expect(html.status).toBe(200);
      expect(html.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(bodyBuffer(html).toString('utf-8')).toContain('<pre>Apache-2.0');
    });

    it('should list DWN-backed metadata files at contents root', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/contents'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.map((item: any) => item.name)).toContain('README.md');
      expect(data.map((item: any) => item.name)).toContain('LICENSE');

      const objectRes = await handleShimRequest(ctx, repoUrl('/contents'), 'GET', {}, null, {
        accept: 'application/vnd.github.object+json',
      });
      expect(objectRes.status).toBe(200);
      const objectData = parse(objectRes);
      expect(Array.isArray(objectData.entries)).toBe(true);
      expect(objectData.entries.map((item: any) => item.name)).toContain('README.md');
    });

    it('should return README through contents path lookup', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/contents/README.md'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.path).toBe('README.md');
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('Test Repo');

      const raw = await handleShimRequest(ctx, new URL(data.download_url));
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
      expect(bodyBuffer(raw).toString('utf-8')).toContain('Test Repo');
    });

    it('should return local git README when repo storage is provided', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/readme'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.path).toBe('README.md');
      expect(data.sha).toBe(gitReadmeSha);
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('Readme from local git objects');

      const rawLicense = await handleShimRequest(ctx, repoUrl('/license?ref=main'), 'GET', {}, null, {
        ...shimOptions(),
        accept: 'application/vnd.github.v3.raw+json',
      });
      expect(rawLicense.status).toBe(200);
      expect(rawLicense.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(bodyBuffer(rawLicense).toString('utf-8')).toBe('MIT\n');
    });

    it('should return local git README for a directory', async () => {
      const res = await handleShimRequest(ctx, contentWriteRepoUrl('/readme/docs?ref=main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('README.md');
      expect(data.path).toBe('docs/README.md');
      expect(data.type).toBe('file');
      expect(data.url).toContain('/contents/docs/README.md');
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('Directory-specific documentation');

      const missing = await handleShimRequest(ctx, contentWriteRepoUrl('/readme/missing?ref=main'), 'GET', {}, null, shimOptions());
      expect(missing.status).toBe(404);

      const metadataOnly = await handleShimRequest(ctx, repoUrl('/readme/docs'));
      expect(metadataOnly.status).toBe(404);
    });

    it('should list local git contents root when repo storage is provided', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/contents?ref=main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((item: any) => item.path)).toEqual(['LICENSE', 'README.md', 'src']);
      expect(data.find((item: any) => item.path === 'src').type).toBe('dir');
    });

    it('should return local git file contents by path when repo storage is provided', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/contents/src/index.ts?ref=main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.path).toBe('src/index.ts');
      expect(data.type).toBe('file');
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('answer = 42');

      const raw = await handleShimRequest(ctx, new URL(data.download_url), 'GET', {}, null, shimOptions());
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('application/typescript; charset=utf-8');
      expect(bodyBuffer(raw).toString('utf-8')).toContain('answer = 42');

      const acceptRaw = await handleShimRequest(
        ctx,
        repoUrl('/contents/src/index.ts?ref=main'),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.v3.raw' },
      );
      expect(acceptRaw.status).toBe(200);
      expect(acceptRaw.headers['Content-Type']).toBe('application/typescript; charset=utf-8');
      expect(bodyBuffer(acceptRaw).toString('utf-8')).toContain('answer = 42');
    });

    it('should create and update local git file contents', async () => {
      const createRes = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/guide.md'), 'PUT', {
        branch  : 'main',
        message : 'Create guide',
        content : Buffer.from('hello from contents api\n', 'utf-8').toString('base64'),
      }, null, shimOptions());
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.content.path).toBe('docs/guide.md');
      expect(Buffer.from(created.content.content, 'base64').toString('utf-8')).toBe('hello from contents api\n');

      const updateRes = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/guide.md'), 'PUT', {
        branch  : 'main',
        message : 'Update guide',
        sha     : created.content.sha,
        content : Buffer.from('updated through contents api\n', 'utf-8').toString('base64'),
      }, null, shimOptions());
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.content.path).toBe('docs/guide.md');
      expect(updated.content.sha).not.toBe(created.content.sha);

      const fetched = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/guide.md?ref=main'), 'GET', {}, null, shimOptions());
      expect(fetched.status).toBe(200);
      expect(Buffer.from(parse(fetched).content, 'base64').toString('utf-8')).toBe('updated through contents api\n');

      const branch = await handleShimRequest(ctx, contentWriteRepoUrl('/branches/main'));
      expect(branch.status).toBe(200);
      expect(parse(branch).commit.sha).toBe(updated.commit.sha);
    });

    it('should delete local git file contents', async () => {
      const createRes = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/remove.md'), 'PUT', {
        branch  : 'main',
        message : 'Create removable file',
        content : Buffer.from('remove me\n', 'utf-8').toString('base64'),
      }, null, shimOptions());
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const deleteRes = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/remove.md'), 'DELETE', {
        branch  : 'main',
        message : 'Delete removable file',
        sha     : created.content.sha,
      }, null, shimOptions());
      expect(deleteRes.status).toBe(200);
      const deleted = parse(deleteRes);
      expect(deleted.content).toBeNull();
      expect(deleted.commit.sha).not.toBe(created.commit.sha);

      const fetched = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/docs/remove.md?ref=main'), 'GET', {}, null, shimOptions());
      expect(fetched.status).toBe(404);
    });

    it('should return 404 for unsupported contents paths', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/contents/src/index.ts'));
      expect(res.status).toBe(404);
      const data = parse(res);
      expect(data.message).toContain('not found');

      const missingRaw = await handleShimRequest(ctx, repoUrl('/raw/main/missing.txt'), 'GET', {}, null, shimOptions());
      expect(missingRaw.status).toBe(404);
    });

    it('should redirect archive requests to generated download URLs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/tarball/main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(302);
      expect(res.headers.Location).toContain('/tarball/main');
      expect(res.headers.Location).toContain('download=1');
    });

    it('should download tar archives from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/tarball?download=1'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/gzip');
      expect(res.headers['Content-Disposition']).toContain('.tar.gz');

      const bytes = bodyBuffer(res);
      expect(bytes[0]).toBe(0x1f);
      expect(bytes[1]).toBe(0x8b);
    });

    it('should download zip archives from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/zipball/main?download=1'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/zip');
      expect(res.headers['Content-Disposition']).toContain('.zip');

      const bytes = bodyBuffer(res);
      expect(bytes.subarray(0, 4).toString('utf-8')).toBe('PK\u0003\u0004');
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/branches, /tags, /git/ref
  // =========================================================================

  describe('repository ref endpoints', () => {
    it('should list mirrored branches', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/branches'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((branch: any) => branch.name)).toContain('main');
      expect(data.map((branch: any) => branch.name)).toContain('feature/demo');

      const main = data.find((branch: any) => branch.name === 'main');
      expect(main.commit.sha).toBe(MAIN_SHA);
      expect(main.protected).toBe(false);
    });

    it('should filter mirrored branches by protected status', async () => {
      const initialProtected = await handleShimRequest(ctx, repoUrl('/branches?protected=true'));
      expect(initialProtected.status).toBe(200);
      expect(parse(initialProtected)).toEqual([]);

      const protectMain = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
      });
      expect(protectMain.status).toBe(200);

      const protectFeature = await handleShimRequest(ctx, repoUrl('/branches/feature/demo/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
      });
      expect(protectFeature.status).toBe(200);

      const protectedBranches = await handleShimRequest(ctx, repoUrl('/branches?protected=true'));
      expect(protectedBranches.status).toBe(200);
      expect(parse(protectedBranches).map((branch: any) => branch.name)).toEqual(['feature/demo', 'main']);

      const firstProtectedPage = await handleShimRequest(ctx, repoUrl('/branches?protected=true&per_page=1'));
      expect(firstProtectedPage.status).toBe(200);
      expect(parse(firstProtectedPage).map((branch: any) => branch.name)).toEqual(['feature/demo']);
      expect(firstProtectedPage.headers.Link).toContain('/branches?protected=true&page=2&per_page=1');

      const unprotectedBranches = await handleShimRequest(ctx, repoUrl('/branches?protected=false'));
      expect(unprotectedBranches.status).toBe(200);
      expect(parse(unprotectedBranches)).toEqual([]);

      const invalid = await handleShimRequest(ctx, repoUrl('/branches?protected=maybe'));
      expect(invalid.status).toBe(422);

      const deleteMain = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(deleteMain.status).toBe(204);
      const deleteFeature = await handleShimRequest(ctx, repoUrl('/branches/feature/demo/protection'), 'DELETE');
      expect(deleteFeature.status).toBe(204);
    });

    it('should treat active branch rulesets as protected branches', async () => {
      const createRuleset = await handleShimRequest(ctx, repoUrl('/rulesets'), 'POST', {
        name        : 'default branch required signatures',
        target      : 'branch',
        enforcement : 'active',
        conditions  : {
          ref_name: {
            include : ['~DEFAULT_BRANCH'],
            exclude : [],
          },
        },
        rules: [{ type: 'required_signatures' }],
      });
      expect(createRuleset.status).toBe(201);
      const ruleset = parse(createRuleset);

      const mainBranch = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(mainBranch.status).toBe(200);
      const main = parse(mainBranch);
      expect(main.protected).toBe(true);
      expect(main.protection.enabled).toBe(true);
      expect(main.protection.required_status_checks.contexts).toEqual([]);

      const protectedBranches = await handleShimRequest(ctx, repoUrl('/branches?protected=true'));
      expect(protectedBranches.status).toBe(200);
      expect(parse(protectedBranches).map((branch: any) => branch.name)).toEqual(['main']);

      const unprotectedBranches = await handleShimRequest(ctx, repoUrl('/branches?protected=false'));
      expect(unprotectedBranches.status).toBe(200);
      expect(parse(unprotectedBranches).map((branch: any) => branch.name)).toEqual(['feature/demo']);

      const evaluateRuleset = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`), 'PUT', {
        enforcement: 'evaluate',
      });
      expect(evaluateRuleset.status).toBe(200);

      const evaluatedProtectedBranches = await handleShimRequest(ctx, repoUrl('/branches?protected=true'));
      expect(evaluatedProtectedBranches.status).toBe(200);
      expect(parse(evaluatedProtectedBranches)).toEqual([]);

      const deleteRuleset = await handleShimRequest(ctx, repoUrl(`/rulesets/${ruleset.id}`), 'DELETE');
      expect(deleteRuleset.status).toBe(204);
    });

    it('should return branch detail', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('main');
      expect(data.commit.sha).toBe(MAIN_SHA);
    });

    it('should return branch detail for slash-containing branch names', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/branches/feature%2Fdemo'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('feature/demo');
      expect(data.commit.sha).toBe(FEATURE_SHA);
    });

    it('should create, read, reflect, and delete branch protection', async () => {
      const initial = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(initial.status).toBe(404);

      const update = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          strict   : true,
          contexts : ['lint'],
          checks   : [
            { context: 'test', app_id: 12345 },
            { context: 'deploy', app_id: -1 },
          ],
        },
        required_pull_request_reviews: {
          bypass_pull_request_allowances: {
            users : ['release-manager'],
            teams : ['ops'],
            apps  : ['merge-bot'],
          },
          dismissal_restrictions: {
            users : ['alice'],
            teams : ['core'],
            apps  : ['review-bot'],
          },
          dismiss_stale_reviews           : true,
          require_code_owner_reviews      : true,
          required_approving_review_count : 2,
          require_last_push_approval      : true,
        },
        enforce_admins : null,
        restrictions   : null,
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.required_status_checks.contexts).toEqual(['lint', 'test', 'deploy']);
      expect(updated.required_status_checks.checks).toEqual([
        { app_id: null, context: 'lint' },
        { app_id: 12345, context: 'test' },
        { app_id: -1, context: 'deploy' },
      ]);
      expect(updated.required_status_checks.strict).toBe(true);
      expect(updated.enforce_admins.enabled).toBe(false);
      expect(updated.required_pull_request_reviews.required_approving_review_count).toBe(2);
      expect(updated.required_pull_request_reviews.bypass_pull_request_allowances.users.map((user: any) => user.login)).toEqual(['release-manager']);
      expect(updated.required_pull_request_reviews.bypass_pull_request_allowances.teams.map((team: any) => team.slug)).toEqual(['ops']);
      expect(updated.required_pull_request_reviews.bypass_pull_request_allowances.apps.map((app: any) => app.slug)).toEqual(['merge-bot']);
      expect(updated.required_pull_request_reviews.dismissal_restrictions.users.map((user: any) => user.login)).toEqual(['alice']);
      expect(updated.required_pull_request_reviews.dismissal_restrictions.teams.map((team: any) => team.slug)).toEqual(['core']);
      expect(updated.required_pull_request_reviews.dismissal_restrictions.apps.map((app: any) => app.slug)).toEqual(['review-bot']);
      expect(updated.required_pull_request_reviews.dismiss_stale_reviews).toBe(true);
      expect(updated.required_pull_request_reviews.require_code_owner_reviews).toBe(true);
      expect(updated.required_pull_request_reviews.require_last_push_approval).toBe(true);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(fetched.status).toBe(200);
      const fetchedData = parse(fetched);
      expect(fetchedData.required_status_checks.contexts).toEqual(['lint', 'test', 'deploy']);
      expect(fetchedData.required_status_checks.checks).toEqual([
        { app_id: null, context: 'lint' },
        { app_id: 12345, context: 'test' },
        { app_id: -1, context: 'deploy' },
      ]);
      expect(fetchedData.required_status_checks.strict).toBe(true);
      expect(fetchedData.required_pull_request_reviews.bypass_pull_request_allowances.users.map((user: any) => user.login)).toEqual(['release-manager']);
      expect(fetchedData.required_pull_request_reviews.dismissal_restrictions.users.map((user: any) => user.login)).toEqual(['alice']);
      expect(fetchedData.required_pull_request_reviews.dismiss_stale_reviews).toBe(true);
      expect(fetchedData.required_pull_request_reviews.require_code_owner_reviews).toBe(true);
      expect(fetchedData.required_pull_request_reviews.require_last_push_approval).toBe(true);

      const branch = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(branch.status).toBe(200);
      const branchData = parse(branch);
      expect(branchData.protected).toBe(true);
      expect(branchData.protection.enabled).toBe(true);
      expect(branchData.protection.required_status_checks.contexts).toEqual(['lint', 'test', 'deploy']);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(missing.status).toBe(404);

      const unprotectedBranch = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(parse(unprotectedBranch).protected).toBe(false);
    });

    it('should reflect branch protection boolean options', async () => {
      const update = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
        enforce_admins                   : true,
        required_linear_history          : true,
        allow_force_pushes               : true,
        allow_deletions                  : true,
        block_creations                  : true,
        required_conversation_resolution : true,
        lock_branch                      : true,
        allow_fork_syncing               : true,
      });
      expect(update.status).toBe(200);

      const booleanFields = [
        'enforce_admins',
        'required_linear_history',
        'allow_force_pushes',
        'allow_deletions',
        'block_creations',
        'required_conversation_resolution',
        'lock_branch',
        'allow_fork_syncing',
      ];
      const updated = parse(update);
      for (const field of booleanFields) {
        expect(updated[field].enabled).toBe(true);
      }
      expect(updated.required_signatures.enabled).toBe(false);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(fetched.status).toBe(200);
      const fetchedData = parse(fetched);
      for (const field of booleanFields) {
        expect(fetchedData[field].enabled).toBe(true);
      }

      const reset = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
        enforce_admins                   : false,
        required_linear_history          : null,
        allow_force_pushes               : false,
        allow_deletions                  : null,
        block_creations                  : false,
        required_conversation_resolution : null,
        lock_branch                      : false,
        allow_fork_syncing               : null,
      });
      expect(reset.status).toBe(200);
      const resetData = parse(reset);
      for (const field of booleanFields) {
        expect(resetData[field].enabled).toBe(false);
      }

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should manage branch protection access restrictions', async () => {
      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions'));
      expect(missing.status).toBe(404);

      const update = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
        restrictions: {
          users : ['alice', 'bob'],
          teams : ['core'],
          apps  : ['gitd-ci'],
        },
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.restrictions.users.map((user: any) => user.login)).toEqual(['alice', 'bob']);
      expect(updated.restrictions.teams.map((team: any) => team.slug)).toEqual(['core']);
      expect(updated.restrictions.apps.map((app: any) => app.slug)).toEqual(['gitd-ci']);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).users.map((user: any) => user.login)).toEqual(['alice', 'bob']);

      const users = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions/users'));
      expect(users.status).toBe(200);
      expect(parse(users).map((user: any) => user.login)).toEqual(['alice', 'bob']);

      const addUsers = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions/users'), 'POST', {
        users: ['bob', 'carol'],
      });
      expect(addUsers.status).toBe(200);
      expect(parse(addUsers).map((user: any) => user.login)).toEqual(['alice', 'bob', 'carol']);

      const setTeams = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions/teams'), 'PUT', {
        teams: ['release'],
      });
      expect(setTeams.status).toBe(200);
      expect(parse(setTeams).map((team: any) => team.slug)).toEqual(['release']);

      const removeApps = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions/apps'), 'DELETE', {
        apps: ['gitd-ci'],
      });
      expect(removeApps.status).toBe(200);
      expect(parse(removeApps)).toEqual([]);

      const afterActorUpdates = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(afterActorUpdates.status).toBe(200);
      const actorUpdatesData = parse(afterActorUpdates);
      expect(actorUpdatesData.restrictions.users.map((user: any) => user.login)).toEqual(['alice', 'bob', 'carol']);
      expect(actorUpdatesData.restrictions.teams.map((team: any) => team.slug)).toEqual(['release']);
      expect(actorUpdatesData.restrictions.apps).toEqual([]);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection/restrictions'), 'DELETE');
      expect(deleted.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(afterDelete.status).toBe(200);
      expect(parse(afterDelete).restrictions).toBeNull();

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should reject invalid branch protection payloads', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: { contexts: ['lint', 42] },
      });
      expect(res.status).toBe(422);

      const booleanRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_linear_history: 'yes',
      });
      expect(booleanRes.status).toBe(422);

      const restrictionsRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        restrictions: {
          users : ['alice'],
          teams : 42,
          apps  : [],
        },
      });
      expect(restrictionsRes.status).toBe(422);

      const strictRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: { contexts: ['lint'], strict: 'yes' },
      });
      expect(strictRes.status).toBe(422);

      const statusCheckAppRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          checks: [{ context: 'lint', app_id: 'github-actions' }],
        },
      });
      expect(statusCheckAppRes.status).toBe(422);

      const reviewsRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_pull_request_reviews: {
          dismiss_stale_reviews: 'yes',
        },
      });
      expect(reviewsRes.status).toBe(422);

      const dismissalRestrictionsRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_pull_request_reviews: {
          dismissal_restrictions: {
            users: 'alice',
          },
        },
      });
      expect(dismissalRestrictionsRes.status).toBe(422);

      const bypassAllowancesRes = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_pull_request_reviews: {
          bypass_pull_request_allowances: {
            users: 'release-manager',
          },
        },
      });
      expect(bypassAllowancesRes.status).toBe(422);
    });

    it('should return 404 for branch protection on missing branches', async () => {
      const getRes = await handleShimRequest(ctx, repoUrl('/branches/missing/protection'));
      expect(getRes.status).toBe(404);

      const putRes = await handleShimRequest(ctx, repoUrl('/branches/missing/protection'), 'PUT', {
        required_status_checks: { contexts: ['lint'] },
      });
      expect(putRes.status).toBe(404);

      const deleteRes = await handleShimRequest(ctx, repoUrl('/branches/missing/protection'), 'DELETE');
      expect(deleteRes.status).toBe(404);

      const restrictionsRes = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/restrictions/users'), 'POST', {
        users: ['alice'],
      });
      expect(restrictionsRes.status).toBe(404);
    });

    it('should manage required status check protection subresource', async () => {
      const update = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'), 'PATCH', {
        strict   : true,
        contexts : ['build'],
        checks   : [{ context: 'lint', app_id: 42 }],
      });
      expect(update.status).toBe(200);
      expect(parse(update).contexts).toEqual(['build', 'lint']);
      expect(parse(update).checks).toEqual([
        { app_id: null, context: 'build' },
        { app_id: 42, context: 'lint' },
      ]);
      expect(parse(update).strict).toBe(true);

      const strictOnly = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'), 'PATCH', {
        strict: false,
      });
      expect(strictOnly.status).toBe(200);
      expect(parse(strictOnly).contexts).toEqual(['build', 'lint']);
      expect(parse(strictOnly).checks).toEqual([
        { app_id: null, context: 'build' },
        { app_id: 42, context: 'lint' },
      ]);
      expect(parse(strictOnly).strict).toBe(false);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).contexts).toEqual(['build', 'lint']);
      expect(parse(fetched).checks).toEqual([
        { app_id: null, context: 'build' },
        { app_id: 42, context: 'lint' },
      ]);
      expect(parse(fetched).strict).toBe(false);

      const branch = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(parse(branch).protection.required_status_checks.contexts).toEqual(['build', 'lint']);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'));
      expect(missing.status).toBe(404);

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should add, set, list, and remove required status check contexts', async () => {
      const created = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks'), 'PATCH', {
        contexts: ['lint'],
      });
      expect(created.status).toBe(200);

      const added = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks/contexts'), 'POST', {
        contexts: ['test', 'lint'],
      });
      expect(added.status).toBe(200);
      expect(parse(added)).toEqual(['lint', 'test']);

      const listed = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks/contexts'));
      expect(parse(listed)).toEqual(['lint', 'test']);

      const set = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks/contexts'), 'PUT', {
        contexts: ['deploy'],
      });
      expect(set.status).toBe(200);
      expect(parse(set)).toEqual(['deploy']);

      const removed = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks/contexts'), 'DELETE', {
        contexts: ['deploy'],
      });
      expect(removed.status).toBe(200);
      expect(parse(removed)).toEqual([]);

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should manage pull request review protection subresource', async () => {
      const update = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'), 'PATCH', {
        bypass_pull_request_allowances: {
          users : ['release-manager'],
          teams : ['ops'],
          apps  : ['merge-bot'],
        },
        dismissal_restrictions: {
          users : ['alice'],
          teams : ['core'],
          apps  : ['review-bot'],
        },
        dismiss_stale_reviews           : true,
        require_code_owner_reviews      : true,
        required_approving_review_count : 3,
        require_last_push_approval      : true,
      });
      expect(update.status).toBe(200);
      const updated = parse(update);
      expect(updated.required_approving_review_count).toBe(3);
      expect(updated.bypass_pull_request_allowances.users.map((user: any) => user.login)).toEqual(['release-manager']);
      expect(updated.bypass_pull_request_allowances.teams.map((team: any) => team.slug)).toEqual(['ops']);
      expect(updated.bypass_pull_request_allowances.apps.map((app: any) => app.slug)).toEqual(['merge-bot']);
      expect(updated.dismissal_restrictions.users.map((user: any) => user.login)).toEqual(['alice']);
      expect(updated.dismissal_restrictions.teams.map((team: any) => team.slug)).toEqual(['core']);
      expect(updated.dismissal_restrictions.apps.map((app: any) => app.slug)).toEqual(['review-bot']);
      expect(updated.dismiss_stale_reviews).toBe(true);
      expect(updated.require_code_owner_reviews).toBe(true);
      expect(updated.require_last_push_approval).toBe(true);

      const clearBooleans = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'), 'PATCH', {
        bypass_pull_request_allowances : {},
        dismissal_restrictions         : {},
        dismiss_stale_reviews          : false,
        require_code_owner_reviews     : false,
        require_last_push_approval     : false,
      });
      expect(clearBooleans.status).toBe(200);
      const cleared = parse(clearBooleans);
      expect(cleared.required_approving_review_count).toBe(3);
      expect(cleared.dismissal_restrictions.users).toEqual([]);
      expect(cleared.dismissal_restrictions.teams).toEqual([]);
      expect(cleared.dismissal_restrictions.apps).toEqual([]);
      expect(cleared.bypass_pull_request_allowances.users).toEqual([]);
      expect(cleared.bypass_pull_request_allowances.teams).toEqual([]);
      expect(cleared.bypass_pull_request_allowances.apps).toEqual([]);
      expect(cleared.dismiss_stale_reviews).toBe(false);
      expect(cleared.require_code_owner_reviews).toBe(false);
      expect(cleared.require_last_push_approval).toBe(false);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).required_approving_review_count).toBe(3);
      expect(parse(fetched).dismiss_stale_reviews).toBe(false);

      const branch = await handleShimRequest(ctx, repoUrl('/branches/main'));
      expect(parse(branch).protected).toBe(true);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'), 'DELETE');
      expect(deleted.status).toBe(204);

      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'));
      expect(missing.status).toBe(404);

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should manage admin branch protection enforcement', async () => {
      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection/enforce_admins'));
      expect(missing.status).toBe(404);

      const createProtection = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
        enforce_admins: null,
      });
      expect(createProtection.status).toBe(200);

      const initial = await handleShimRequest(ctx, repoUrl('/branches/main/protection/enforce_admins'));
      expect(initial.status).toBe(200);
      expect(parse(initial).enabled).toBe(false);

      const set = await handleShimRequest(ctx, repoUrl('/branches/main/protection/enforce_admins'), 'POST');
      expect(set.status).toBe(200);
      expect(parse(set).enabled).toBe(true);

      const protectedBranch = await handleShimRequest(ctx, repoUrl('/branches/main/protection'));
      expect(parse(protectedBranch).enforce_admins.enabled).toBe(true);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection/enforce_admins'), 'DELETE');
      expect(deleted.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, repoUrl('/branches/main/protection/enforce_admins'));
      expect(afterDelete.status).toBe(200);
      expect(parse(afterDelete).enabled).toBe(false);

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should manage commit signature protection', async () => {
      const missing = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'));
      expect(missing.status).toBe(404);

      const createProtection = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'PUT', {
        required_status_checks: {
          contexts: ['lint'],
        },
      });
      expect(createProtection.status).toBe(200);

      const initial = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'));
      expect(initial.status).toBe(200);
      expect(parse(initial).enabled).toBe(false);

      const createSignatures = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'), 'POST');
      expect(createSignatures.status).toBe(200);
      expect(parse(createSignatures).enabled).toBe(true);

      const fetched = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'));
      expect(fetched.status).toBe(200);
      expect(parse(fetched).enabled).toBe(true);

      const deleted = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'), 'DELETE');
      expect(deleted.status).toBe(204);

      const afterDelete = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_signatures'));
      expect(afterDelete.status).toBe(200);
      expect(parse(afterDelete).enabled).toBe(false);

      const cleanup = await handleShimRequest(ctx, repoUrl('/branches/main/protection'), 'DELETE');
      expect(cleanup.status).toBe(204);
    });

    it('should reject invalid branch protection subresource payloads', async () => {
      const contexts = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_status_checks/contexts'), 'POST', {
        contexts: ['lint', 42],
      });
      expect(contexts.status).toBe(422);

      const reviews = await handleShimRequest(ctx, repoUrl('/branches/main/protection/required_pull_request_reviews'), 'PATCH', {
        required_approving_review_count: 9,
      });
      expect(reviews.status).toBe(422);
    });

    it('should return 404 for branch protection subresources on missing branches', async () => {
      const statusChecks = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/required_status_checks'));
      expect(statusChecks.status).toBe(404);

      const contexts = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/required_status_checks/contexts'), 'POST', {
        contexts: ['lint'],
      });
      expect(contexts.status).toBe(404);

      const reviews = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/required_pull_request_reviews'), 'PATCH', {
        required_approving_review_count: 1,
      });
      expect(reviews.status).toBe(404);

      const enforceAdmins = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/enforce_admins'), 'POST');
      expect(enforceAdmins.status).toBe(404);

      const signatures = await handleShimRequest(ctx, repoUrl('/branches/missing/protection/required_signatures'), 'POST');
      expect(signatures.status).toBe(404);
    });

    it('should list mirrored tags', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/tags'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(data[0].name).toBe('v1.0.0');
      expect(data[0].commit.sha).toBe(TAG_SHA);
    });

    it('should return a git ref object', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/git/ref/heads/main'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.ref).toBe('refs/heads/main');
      expect(data.object.type).toBe('commit');
      expect(data.object.sha).toBe(MAIN_SHA);
    });

    it('should list matching git refs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/git/matching-refs/heads'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((ref: any) => ref.ref)).toContain('refs/heads/main');
      expect(data.map((ref: any) => ref.ref)).toContain('refs/heads/feature/demo');
    });

    it('should return 404 for missing branches', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/branches/missing'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/git/blobs, /git/trees, /git/commits, /commits
  // =========================================================================

  describe('git object endpoints', () => {
    it('should return a git blob object from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/git/blobs/${gitReadmeSha}`), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.sha).toBe(gitReadmeSha);
      expect(data.encoding).toBe('base64');
      expect(Buffer.from(data.content, 'base64').toString('utf-8')).toContain('Local Git Repo');

      const raw = await handleShimRequest(ctx, repoUrl(`/git/blobs/${gitReadmeSha}`), 'GET', {}, null, {
        ...shimOptions(),
        accept: 'application/vnd.github.raw+json',
      });
      expect(raw.status).toBe(200);
      expect(raw.headers['Content-Type']).toBe('application/octet-stream');
      expect(bodyBuffer(raw).toString('utf-8')).toContain('Local Git Repo');
    });

    it('should return a git tree object from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/git/trees/${gitTreeSha}`), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.sha).toBe(gitTreeSha);
      expect(data.truncated).toBe(false);
      expect(data.tree.map((entry: any) => entry.path)).toEqual(['LICENSE', 'README.md', 'src']);
    });

    it('should return a recursive git tree object from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/git/trees/${gitTreeSha}?recursive=1`), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.tree.map((entry: any) => entry.path)).toContain('src/index.ts');
    });

    it('should return a low-level git commit object from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/git/commits/${gitMainSha}`), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.sha).toBe(gitMainSha);
      expect(data.message).toBe('Add feature file');
      expect(data.tree.sha).toBe(gitTreeSha);
    });

    it('should return a repository commit object for a branch ref', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/commits/main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.sha).toBe(gitMainSha);
      expect(data.commit.message).toBe('Add feature file');
      expect(data.commit.tree.sha).toBe(gitTreeSha);

      const diffRes = await handleShimRequest(
        ctx,
        repoUrl('/commits/main'),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.diff' },
      );
      expect(diffRes.status).toBe(200);
      expect(diffRes.headers['Content-Type']).toBe('application/vnd.github.diff; charset=utf-8');
      expect(bodyBuffer(diffRes).toString('utf-8')).toContain('diff --git a/src/feature.ts b/src/feature.ts');

      const patchRes = await handleShimRequest(
        ctx,
        repoUrl('/commits/main'),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.v3.patch' },
      );
      expect(patchRes.status).toBe(200);
      expect(patchRes.headers['Content-Type']).toBe('application/vnd.github.patch; charset=utf-8');
      expect(bodyBuffer(patchRes).toString('utf-8')).toContain('Add feature file');

      const shaRes = await handleShimRequest(
        ctx,
        repoUrl('/commits/main'),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.sha' },
      );
      expect(shaRes.status).toBe(200);
      expect(shaRes.headers['Content-Type']).toBe('application/vnd.github.sha; charset=utf-8');
      expect(bodyBuffer(shaRes).toString('utf-8').trim()).toBe(gitMainSha);
    });

    it('should list repository commits from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/commits?sha=main'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data[0].sha).toBe(gitMainSha);
      expect(data[0].commit.message).toBe('Add feature file');
      expect(data.map((commit: any) => commit.sha)).toContain(gitBaseSha);
    });

    it('should paginate repository commit lists', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/commits?sha=main&per_page=1'), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].sha).toBe(gitMainSha);
    });

    it('should create git blobs, trees, commits, and references', async () => {
      const headRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/heads/main'));
      expect(headRes.status).toBe(200);
      const headSha = parse(headRes).object.sha;

      const headCommitRes = await handleShimRequest(ctx, contentWriteRepoUrl(`/git/commits/${headSha}`), 'GET', {}, null, shimOptions());
      expect(headCommitRes.status).toBe(200);
      const headCommit = parse(headCommitRes);

      const blobRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/blobs'), 'POST', {
        content  : 'raw git database file\n',
        encoding : 'utf-8',
      }, null, shimOptions());
      expect(blobRes.status).toBe(201);
      const blob = parse(blobRes);
      expect(blob.sha).toMatch(/^[0-9a-f]{40}$/);

      const treeRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/trees'), 'POST', {
        base_tree : headCommit.tree.sha,
        tree      : [{
          path : 'api/raw.txt',
          mode : '100644',
          type : 'blob',
          sha  : blob.sha,
        }],
      }, null, shimOptions());
      expect(treeRes.status).toBe(201);
      const tree = parse(treeRes);
      expect(tree.sha).toMatch(/^[0-9a-f]{40}$/);

      const commitRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/commits'), 'POST', {
        message : 'Create raw git API commit',
        tree    : tree.sha,
        parents : [headSha],
        author  : { name: 'API Author', email: 'api@example.test' },
      }, null, shimOptions());
      expect(commitRes.status).toBe(201);
      const commit = parse(commitRes);
      expect(commit.message).toBe('Create raw git API commit');
      expect(commit.parents[0].sha).toBe(headSha);

      const createRefRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs'), 'POST', {
        ref : 'refs/heads/api-branch',
        sha : commit.sha,
      }, null, shimOptions());
      expect(createRefRes.status).toBe(201);
      expect(parse(createRefRes).object.sha).toBe(commit.sha);

      const updateMainRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs/heads/main'), 'PATCH', {
        sha: commit.sha,
      }, null, shimOptions());
      expect(updateMainRes.status).toBe(200);
      expect(parse(updateMainRes).object.sha).toBe(commit.sha);

      const fetched = await handleShimRequest(ctx, contentWriteRepoUrl('/contents/api/raw.txt?ref=main'), 'GET', {}, null, shimOptions());
      expect(fetched.status).toBe(200);
      expect(Buffer.from(parse(fetched).content, 'base64').toString('utf-8')).toBe('raw git database file\n');

      const branch = await handleShimRequest(ctx, contentWriteRepoUrl('/branches/main'));
      expect(branch.status).toBe(200);
      expect(parse(branch).commit.sha).toBe(commit.sha);

      const deleteRefRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs/heads/api-branch'), 'DELETE', {}, null, shimOptions());
      expect(deleteRefRes.status).toBe(204);

      const missingBranch = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/heads/api-branch'));
      expect(missingBranch.status).toBe(404);
    });

    it('should create and read annotated git tag objects', async () => {
      const headRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/heads/main'));
      expect(headRes.status).toBe(200);
      const headSha = parse(headRes).object.sha;

      const tagRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/tags'), 'POST', {
        tag     : 'v-api-tag',
        message : 'Annotated tag from API',
        object  : headSha,
        type    : 'commit',
        tagger  : {
          name  : 'Tag Author',
          email : 'tag@example.test',
          date  : '2026-06-22T00:00:00Z',
        },
      }, null, shimOptions());
      expect(tagRes.status).toBe(201);
      const tag = parse(tagRes);
      expect(tag.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(tag.tag).toBe('v-api-tag');
      expect(tag.message).toBe('Annotated tag from API');
      expect(tag.object.type).toBe('commit');
      expect(tag.object.sha).toBe(headSha);
      expect(tag.tagger.name).toBe('Tag Author');
      expect(tag.tagger.email).toBe('tag@example.test');
      expect(tag.verification.reason).toBe('unsigned');

      const fetchedTagRes = await handleShimRequest(ctx, contentWriteRepoUrl(`/git/tags/${tag.sha}`), 'GET', {}, null, shimOptions());
      expect(fetchedTagRes.status).toBe(200);
      const fetchedTag = parse(fetchedTagRes);
      expect(fetchedTag.sha).toBe(tag.sha);
      expect(fetchedTag.object.sha).toBe(headSha);

      const createRefRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs'), 'POST', {
        ref : 'refs/tags/v-api-tag',
        sha : tag.sha,
      }, null, shimOptions());
      expect(createRefRes.status).toBe(201);
      expect(parse(createRefRes).object.type).toBe('tag');

      const fetchedRefRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/tags/v-api-tag'));
      expect(fetchedRefRes.status).toBe(200);
      const fetchedRef = parse(fetchedRefRes);
      expect(fetchedRef.ref).toBe('refs/tags/v-api-tag');
      expect(fetchedRef.object.type).toBe('tag');
      expect(fetchedRef.object.sha).toBe(tag.sha);

      const listTagsRes = await handleShimRequest(ctx, contentWriteRepoUrl('/tags'), 'GET', {}, null, shimOptions());
      expect(listTagsRes.status).toBe(200);
      const listedTag = parse(listTagsRes).find((item: any) => item.name === 'v-api-tag');
      expect(listedTag.commit.sha).toBe(headSha);
      expect(listedTag.commit.url).toContain(`/commits/${headSha}`);
    });

    it('should reject unsupported git tag object target types', async () => {
      const headRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/heads/main'));
      expect(headRes.status).toBe(200);
      const headSha = parse(headRes).object.sha;

      const tagRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/tags'), 'POST', {
        tag     : 'v-invalid-target',
        message : 'Invalid tag target',
        object  : headSha,
        type    : 'tag',
      }, null, shimOptions());
      expect(tagRes.status).toBe(422);
    });

    it('should protect git reference updates from non-fast-forwards and default branch deletes', async () => {
      const headRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/ref/heads/main'));
      expect(headRes.status).toBe(200);
      const headSha = parse(headRes).object.sha;

      const headCommitRes = await handleShimRequest(ctx, contentWriteRepoUrl(`/git/commits/${headSha}`), 'GET', {}, null, shimOptions());
      expect(headCommitRes.status).toBe(200);
      const parentSha = parse(headCommitRes).parents[0].sha;

      const rewindRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs/heads/main'), 'PATCH', {
        sha: parentSha,
      }, null, shimOptions());
      expect(rewindRes.status).toBe(409);

      const deleteDefaultRes = await handleShimRequest(ctx, contentWriteRepoUrl('/git/refs/heads/main'), 'DELETE', {}, null, shimOptions());
      expect(deleteDefaultRes.status).toBe(422);
    });

    it('should list repository contributors from local git history', async () => {
      const res = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${CONTRIBUTORS_REPO_NAME}/contributors?per_page=1`),
        'GET',
        {},
        null,
        shimOptions(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.Link).toContain('rel="next"');

      const pageOne = parse(res);
      expect(pageOne).toHaveLength(1);
      expect(pageOne[0].name).toBe('Alice Author');
      expect(pageOne[0].email).toBe('alice@example.test');
      expect(pageOne[0].contributions).toBe(2);
      expect(pageOne[0].login.startsWith('alice-author-')).toBe(true);

      const pageTwoRes = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${CONTRIBUTORS_REPO_NAME}/contributors?per_page=1&page=2`),
        'GET',
        {},
        null,
        shimOptions(),
      );
      expect(pageTwoRes.status).toBe(200);
      const pageTwo = parse(pageTwoRes);
      expect(pageTwo).toHaveLength(1);
      expect(pageTwo[0].name).toBe('Bob Builder');
      expect(pageTwo[0].contributions).toBe(1);
    });

    it('should return 204 for empty repository contributors', async () => {
      const res = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/${EMPTY_REPO_NAME}/contributors`),
        'GET',
        {},
        null,
        shimOptions(),
      );
      expect(res.status).toBe(204);
      expect(res.body).toBe('');
    });

    it('should return GitHub-compatible community, traffic, and statistics metrics', async () => {
      const communityRes = await handleShimRequest(ctx, repoUrl('/community/profile'), 'GET', {}, null, shimOptions());
      expect(communityRes.status).toBe(200);
      const community = parse(communityRes);
      expect(community.description).toBe('A test repository');
      expect(community.health_percentage).toBeGreaterThan(0);
      expect(community.files.readme.url).toContain('/contents/README.md');
      expect(community.files.license.html_url).toContain('/blob/HEAD/LICENSE');

      const clonesRes = await handleShimRequest(ctx, repoUrl('/traffic/clones?per=week'));
      expect(clonesRes.status).toBe(200);
      expect(parse(clonesRes)).toEqual({ count: 0, uniques: 0, clones: [] });

      const viewsRes = await handleShimRequest(ctx, repoUrl('/traffic/views'));
      expect(viewsRes.status).toBe(200);
      expect(parse(viewsRes)).toEqual({ count: 0, uniques: 0, views: [] });

      const pathsRes = await handleShimRequest(ctx, repoUrl('/traffic/popular/paths'));
      expect(pathsRes.status).toBe(200);
      expect(parse(pathsRes)).toEqual([]);

      const referrersRes = await handleShimRequest(ctx, repoUrl('/traffic/popular/referrers'));
      expect(referrersRes.status).toBe(200);
      expect(parse(referrersRes)).toEqual([]);

      const metricsBase = `/repos/${testDid}/${CONTRIBUTORS_REPO_NAME}`;
      const codeFrequencyRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/code_frequency`), 'GET', {}, null, shimOptions());
      expect(codeFrequencyRes.status).toBe(200);
      const codeFrequency = parse(codeFrequencyRes);
      expect(codeFrequency.length).toBeGreaterThan(0);
      expect(codeFrequency[0][1]).toBeGreaterThan(0);

      const activityRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/commit_activity`), 'GET', {}, null, shimOptions());
      expect(activityRes.status).toBe(200);
      const activity = parse(activityRes);
      expect(activity.reduce((sum: number, week: any) => sum + week.total, 0)).toBe(3);
      expect(activity[0].days).toHaveLength(7);

      const statsContributorsRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/contributors`), 'GET', {}, null, shimOptions());
      expect(statsContributorsRes.status).toBe(200);
      const statsContributors = parse(statsContributorsRes);
      expect(statsContributors).toHaveLength(2);
      expect(statsContributors[0].author.login.startsWith('alice-author-')).toBe(true);
      expect(statsContributors[0].total).toBe(2);
      expect(statsContributors[0].weeks[0].c).toBe(2);

      const participationRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/participation`), 'GET', {}, null, shimOptions());
      expect(participationRes.status).toBe(200);
      const participation = parse(participationRes);
      expect(participation.all).toHaveLength(52);
      expect(participation.owner).toHaveLength(52);
      expect(participation.all.reduce((sum: number, count: number) => sum + count, 0)).toBe(3);

      const punchCardRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/punch_card`), 'GET', {}, null, shimOptions());
      expect(punchCardRes.status).toBe(200);
      const punchCard = parse(punchCardRes);
      expect(punchCard).toHaveLength(168);
      expect(punchCard.reduce((sum: number, entry: number[]) => sum + entry[2], 0)).toBe(3);
    });

    it('should return empty metrics for empty repositories and validate traffic periods', async () => {
      const metricsBase = `/repos/${testDid}/${EMPTY_REPO_NAME}`;
      const codeFrequencyRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/code_frequency`), 'GET', {}, null, shimOptions());
      expect(codeFrequencyRes.status).toBe(200);
      expect(parse(codeFrequencyRes)).toEqual([]);

      const participationRes = await handleShimRequest(ctx, url(`${metricsBase}/stats/participation`), 'GET', {}, null, shimOptions());
      expect(participationRes.status).toBe(200);
      const participation = parse(participationRes);
      expect(participation.all).toHaveLength(52);
      expect(participation.all.every((count: number) => count === 0)).toBe(true);

      const invalidTrafficRes = await handleShimRequest(ctx, repoUrl('/traffic/clones?per=month'));
      expect(invalidTrafficRes.status).toBe(422);

      const missingRepoRes = await handleShimRequest(ctx, url(`/repos/${testDid}/missing-repo/stats/punch_card`), 'GET', {}, null, shimOptions());
      expect(missingRepoRes.status).toBe(404);
    });

    it('should compare commits from local repo storage', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/compare/${gitBaseSha}...main`), 'GET', {}, null, shimOptions());
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.status).toBe('ahead');
      expect(data.ahead_by).toBe(1);
      expect(data.behind_by).toBe(0);
      expect(data.total_commits).toBe(1);
      expect(data.base_commit.sha).toBe(gitBaseSha);
      expect(data.commits[0].sha).toBe(gitMainSha);

      const feature = data.files.find((file: any) => file.filename === 'src/feature.ts');
      expect(feature.status).toBe('added');
      expect(feature.additions).toBe(1);
      expect(feature.deletions).toBe(0);

      const diffRes = await handleShimRequest(ctx, new URL(data.diff_url), 'GET', {}, null, shimOptions());
      expect(diffRes.status).toBe(200);
      expect(diffRes.headers['Content-Type']).toBe('application/vnd.github.diff; charset=utf-8');
      expect(bodyBuffer(diffRes).toString('utf-8')).toContain('diff --git a/src/feature.ts b/src/feature.ts');

      const patchRes = await handleShimRequest(ctx, new URL(data.patch_url), 'GET', {}, null, shimOptions());
      expect(patchRes.status).toBe(200);
      expect(patchRes.headers['Content-Type']).toBe('application/vnd.github.patch; charset=utf-8');
      expect(bodyBuffer(patchRes).toString('utf-8')).toContain('Add feature file');

      const acceptDiffRes = await handleShimRequest(
        ctx,
        repoUrl(`/compare/${gitBaseSha}...main`),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.diff' },
      );
      expect(acceptDiffRes.status).toBe(200);
      expect(acceptDiffRes.headers['Content-Type']).toBe('application/vnd.github.diff; charset=utf-8');
      expect(bodyBuffer(acceptDiffRes).toString('utf-8')).toContain('diff --git a/src/feature.ts b/src/feature.ts');

      const acceptPatchRes = await handleShimRequest(
        ctx,
        repoUrl(`/compare/${gitBaseSha}...main`),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.v3.patch' },
      );
      expect(acceptPatchRes.status).toBe(200);
      expect(acceptPatchRes.headers['Content-Type']).toBe('application/vnd.github.patch; charset=utf-8');
      expect(bodyBuffer(acceptPatchRes).toString('utf-8')).toContain('Add feature file');
    });
  });

  // =========================================================================
  // GET/POST /statuses and /check-runs
  // =========================================================================

  describe('repository status and check endpoints', () => {
    it('should return a combined commit status from CI runs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/commits/main/status'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.sha).toBe(MAIN_SHA);
      expect(data.state).toBe('success');
      expect(data.total_count).toBe(1);
      expect(data.statuses[0].context).toBe('lint');
      expect(data.statuses[0].state).toBe('success');
    });

    it('should list commit statuses from CI runs', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/statuses`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].context).toBe('lint');
      expect(data[0].description).toBe('All clean.');
    });

    it('should list check suites for a commit ref', async () => {
      const res = await handleShimRequest(
        ctx,
        repoUrl(`/commits/main/check-suites?app_id=${numericId('gitd-ci')}&check_name=lint&per_page=1`),
      );
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.check_suites[0].id).toBe(numericId(checkSuiteRecId));
      expect(data.check_suites[0].head_sha).toBe(MAIN_SHA);
      expect(data.check_suites[0].status).toBe('completed');
      expect(data.check_suites[0].conclusion).toBe('success');

      const invalid = await handleShimRequest(ctx, repoUrl('/commits/main/check-suites?app_id=not-a-number'));
      expect(invalid.status).toBe(422);
    });

    it('should list check runs for a commit ref with GitHub filters', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/commits/main/check-runs?check_name=lint&status=completed&per_page=1'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.check_runs).toHaveLength(1);
      expect(data.check_runs[0].id).toBe(numericId(checkRunRecId));
      expect(data.check_runs[0].name).toBe('lint');
      expect(data.check_runs[0].output.annotations_url).toContain(`/check-runs/${numericId(checkRunRecId)}/annotations`);

      const filtered = await handleShimRequest(ctx, repoUrl('/commits/main/check-runs?check_name=build'));
      expect(parse(filtered).total_count).toBe(0);

      const invalid = await handleShimRequest(ctx, repoUrl('/commits/main/check-runs?status=waiting'));
      expect(invalid.status).toBe(422);
    });

    it('should return check suite detail', async () => {
      const suiteId = numericId(checkSuiteRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/check-suites/${suiteId}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(suiteId);
      expect(data.latest_check_runs_count).toBe(1);
      expect(data.app.name).toBe('gitd-ci');
    });

    it('should create check suites and return existing suites for the same app and SHA', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/check-suites'), 'POST', {
        head_sha: MAIN_SHA,
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.head_sha).toBe(MAIN_SHA);
      expect(created.head_branch).toBe('main');
      expect(created.status).toBe('queued');
      expect(created.conclusion).toBeNull();
      expect(created.app.name).toBe('github-checks');

      const duplicateRes = await handleShimRequest(ctx, repoUrl('/check-suites'), 'POST', {
        head_sha: MAIN_SHA,
      });
      expect(duplicateRes.status).toBe(200);
      expect(parse(duplicateRes).id).toBe(created.id);

      const missingHead = await handleShimRequest(ctx, repoUrl('/check-suites'), 'POST', {});
      expect(missingHead.status).toBe(422);
    });

    it('should list check runs for a suite', async () => {
      const suiteId = numericId(checkSuiteRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/check-suites/${suiteId}/check-runs`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.check_runs[0].id).toBe(numericId(checkRunRecId));
      expect(data.check_runs[0].name).toBe('lint');
      expect(data.check_runs[0].output.summary).toBe('All clean.');
    });

    it('should return check run detail', async () => {
      const runId = numericId(checkRunRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/check-runs/${runId}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(runId);
      expect(data.name).toBe('lint');
      expect(data.status).toBe('completed');
      expect(data.conclusion).toBe('success');
    });

    it('should rerequest a check suite by resetting suite status', async () => {
      const suiteId = numericId(checkSuiteRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/check-suites/${suiteId}/rerequest`), 'POST');
      expect(res.status).toBe(201);
      expect(res.body).toBe('');

      const detail = await handleShimRequest(ctx, repoUrl(`/check-suites/${suiteId}`));
      expect(parse(detail).status).toBe('queued');
      expect(parse(detail).conclusion).toBeNull();

      const missing = await handleShimRequest(ctx, repoUrl('/check-suites/999/rerequest'), 'POST');
      expect(missing.status).toBe(404);
    });

    it('should append and list check run annotations', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/check-runs'), 'POST', {
        name     : 'annotated-build',
        head_sha : FEATURE_SHA,
        status   : 'in_progress',
        output   : {
          title       : 'Annotated build',
          summary     : 'Started.',
          annotations : [{
            path             : 'README.md',
            start_line       : 1,
            end_line         : 1,
            annotation_level : 'warning',
            title            : 'Style',
            message          : 'Use a shorter heading.',
            raw_details      : 'Heading is long.',
          }],
        },
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.output.annotations_count).toBe(1);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/check-runs/${created.id}`), 'PATCH', {
        status     : 'completed',
        conclusion : 'success',
        output     : {
          title       : 'Annotated build',
          summary     : 'Passed with notes.',
          annotations : [{
            path             : 'src/feature.ts',
            start_line       : 2,
            end_line         : 2,
            annotation_level : 'notice',
            message          : 'Generated file touched.',
          }],
        },
      });
      expect(updateRes.status).toBe(200);
      expect(parse(updateRes).output.annotations_count).toBe(2);

      const annotationsRes = await handleShimRequest(ctx, repoUrl(`/check-runs/${created.id}/annotations?per_page=1`));
      expect(annotationsRes.status).toBe(200);
      expect(annotationsRes.headers.Link).toContain('rel="next"');
      const annotations = parse(annotationsRes);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].path).toBe('README.md');
      expect(annotations[0].annotation_level).toBe('warning');
      expect(annotations[0].blob_href).toContain('/contents/README.md');
    });

    it('should create a commit status backed by forge-ci', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/statuses/${FEATURE_SHA}`), 'POST', {
        state       : 'failure',
        context     : 'deploy',
        description : 'Deployment failed.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.context).toBe('deploy');
      expect(data.state).toBe('failure');

      const combined = await handleShimRequest(ctx, repoUrl(`/commits/${FEATURE_SHA}/status`));
      const combinedData = parse(combined);
      expect(combinedData.state).toBe('failure');
      expect(combinedData.statuses.find((s: any) => s.context === 'deploy')).toBeDefined();
    });

    it('should create and update a check run', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/check-runs'), 'POST', {
        name     : 'build',
        head_sha : FEATURE_SHA,
        status   : 'queued',
        output   : { title: 'Build', summary: 'Queued.' },
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.name).toBe('build');
      expect(created.status).toBe('queued');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/check-runs/${created.id}`), 'PATCH', {
        status     : 'completed',
        conclusion : 'success',
        output     : { title: 'Build', summary: 'Passed.' },
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.status).toBe('completed');
      expect(updated.conclusion).toBe('success');
      expect(updated.output.summary).toBe('Passed.');
    });

    it('should rerequest a check run without mutating the run result', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/check-runs'), 'POST', {
        name       : 'rerun-target',
        head_sha   : FEATURE_SHA,
        status     : 'completed',
        conclusion : 'failure',
        output     : { title: 'Rerun target', summary: 'Failed.' },
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const rerequestRes = await handleShimRequest(ctx, repoUrl(`/check-runs/${created.id}/rerequest`), 'POST');
      expect(rerequestRes.status).toBe(201);
      expect(rerequestRes.body).toBe('');

      const runDetail = parse(await handleShimRequest(ctx, repoUrl(`/check-runs/${created.id}`)));
      expect(runDetail.status).toBe('completed');
      expect(runDetail.conclusion).toBe('failure');

      const suiteDetail = parse(await handleShimRequest(ctx, repoUrl(`/check-suites/${created.check_suite.id}`)));
      expect(suiteDetail.status).toBe('queued');
      expect(suiteDetail.conclusion).toBeNull();
    });

    it('should return 404 for missing check runs', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/check-runs/999'));
      expect(res.status).toBe(404);

      const annotationsRes = await handleShimRequest(ctx, repoUrl('/check-runs/999/annotations'));
      expect(annotationsRes.status).toBe(404);

      const rerequestRes = await handleShimRequest(ctx, repoUrl('/check-runs/999/rerequest'), 'POST');
      expect(rerequestRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST /repos/:did/:repo/actions/runs and jobs
  // =========================================================================

  describe('GitHub Actions workflow endpoints', () => {
    it('should create, list, update, and delete repository Actions variables', async () => {
      const initialRes = await handleShimRequest(ctx, repoUrl('/actions/variables'));
      expect(initialRes.status).toBe(200);
      expect(parse(initialRes).variables).toEqual([]);

      const createRes = await handleShimRequest(ctx, repoUrl('/actions/variables'), 'POST', {
        name  : 'ACTIONS_COLOR',
        value : 'blue',
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body).toBe('');

      const duplicateRes = await handleShimRequest(ctx, repoUrl('/actions/variables'), 'POST', {
        name  : 'actions_color',
        value : 'red',
      });
      expect(duplicateRes.status).toBe(409);

      const emptyValueRes = await handleShimRequest(ctx, repoUrl('/actions/variables'), 'POST', {
        name  : 'ACTIONS_EMPTY',
        value : '',
      });
      expect(emptyValueRes.status).toBe(201);

      const invalidRes = await handleShimRequest(ctx, repoUrl('/actions/variables'), 'POST', {
        name  : 'ACTIONS_INVALID',
        value : 42,
      });
      expect(invalidRes.status).toBe(422);

      const listRes = await handleShimRequest(ctx, repoUrl('/actions/variables?per_page=1'));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const list = parse(listRes);
      expect(list.total_count).toBe(2);
      expect(list.variables).toHaveLength(1);

      const getRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_COLOR'));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).value).toBe('blue');

      const updateRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_COLOR'), 'PATCH', {
        name  : 'ACTIONS_SHADE',
        value : 'green with spaces ',
      });
      expect(updateRes.status).toBe(204);

      const oldNameRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_COLOR'));
      expect(oldNameRes.status).toBe(404);

      const updatedRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_SHADE'));
      expect(updatedRes.status).toBe(200);
      expect(parse(updatedRes).value).toBe('green with spaces ');

      const emptyGetRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_EMPTY'));
      expect(emptyGetRes.status).toBe(200);
      expect(parse(emptyGetRes).value).toBe('');

      const emptyPatchRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_SHADE'), 'PATCH', {});
      expect(emptyPatchRes.status).toBe(422);

      const deleteRenamedRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_SHADE'), 'DELETE');
      expect(deleteRenamedRes.status).toBe(204);

      const deleteEmptyRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_EMPTY'), 'DELETE');
      expect(deleteEmptyRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl('/actions/variables/ACTIONS_SHADE'));
      expect(missingRes.status).toBe(404);
    });

    it('should create, list, update, and delete repository Actions secrets', async () => {
      const publicKeyRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/public-key'));
      expect(publicKeyRes.status).toBe(200);
      const publicKey = parse(publicKeyRes);
      expect(typeof publicKey.key_id).toBe('string');
      expect(typeof publicKey.key).toBe('string');

      const initialRes = await handleShimRequest(ctx, repoUrl('/actions/secrets'));
      expect(initialRes.status).toBe(200);
      expect(parse(initialRes)).toEqual({ total_count: 0, secrets: [] });

      const createRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/DEPLOY_TOKEN'), 'PUT', {
        encrypted_value : 'c2VjcmV0',
        key_id          : publicKey.key_id,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body).toBe('');

      const updateRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/DEPLOY_TOKEN'), 'PUT', {
        encrypted_value : 'bmV3LXNlY3JldA==',
        key_id          : publicKey.key_id,
      });
      expect(updateRes.status).toBe(204);

      const secondRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/API_KEY'), 'PUT', {
        encrypted_value : 'YXBpLWtleQ==',
        key_id          : publicKey.key_id,
      });
      expect(secondRes.status).toBe(201);

      const invalidRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/INVALID_SECRET'), 'PUT', {
        encrypted_value: 'bWlzc2luZy1rZXk=',
      });
      expect(invalidRes.status).toBe(422);

      const listRes = await handleShimRequest(ctx, repoUrl('/actions/secrets?per_page=1'));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const list = parse(listRes);
      expect(list.total_count).toBe(2);
      expect(list.secrets).toHaveLength(1);
      expect(list.secrets[0].encrypted_value).toBeUndefined();

      const getRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/DEPLOY_TOKEN'));
      expect(getRes.status).toBe(200);
      const secret = parse(getRes);
      expect(secret.name).toBe('DEPLOY_TOKEN');
      expect(secret.encrypted_value).toBeUndefined();
      expect(secret.created_at).toBeDefined();
      expect(secret.updated_at).toBeDefined();

      const deleteFirstRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/DEPLOY_TOKEN'), 'DELETE');
      expect(deleteFirstRes.status).toBe(204);

      const deleteSecondRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/API_KEY'), 'DELETE');
      expect(deleteSecondRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl('/actions/secrets/DEPLOY_TOKEN'));
      expect(missingRes.status).toBe(404);
    });

    it('should get and update repository Actions permissions', async () => {
      const defaultPermissionsRes = await handleShimRequest(ctx, repoUrl('/actions/permissions'));
      expect(defaultPermissionsRes.status).toBe(200);
      const defaultPermissions = parse(defaultPermissionsRes);
      expect(defaultPermissions.enabled).toBe(true);
      expect(defaultPermissions.allowed_actions).toBe('all');
      expect(defaultPermissions.sha_pinning_required).toBe(false);
      expect(defaultPermissions.selected_actions_url).toContain('/actions/permissions/selected-actions');

      const defaultSelectedRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/selected-actions'));
      expect(defaultSelectedRes.status).toBe(200);
      expect(parse(defaultSelectedRes)).toEqual({
        github_owned_allowed : true,
        verified_allowed     : true,
        patterns_allowed     : [],
      });

      const defaultWorkflowRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/workflow'));
      expect(defaultWorkflowRes.status).toBe(200);
      expect(parse(defaultWorkflowRes)).toEqual({
        default_workflow_permissions     : 'read',
        can_approve_pull_request_reviews : false,
      });

      const missingEnabledRes = await handleShimRequest(ctx, repoUrl('/actions/permissions'), 'PUT', {
        allowed_actions: 'selected',
      });
      expect(missingEnabledRes.status).toBe(422);

      const updatePermissionsRes = await handleShimRequest(ctx, repoUrl('/actions/permissions'), 'PUT', {
        enabled              : false,
        allowed_actions      : 'selected',
        sha_pinning_required : true,
      });
      expect(updatePermissionsRes.status).toBe(204);

      const updatedPermissionsRes = await handleShimRequest(ctx, repoUrl('/actions/permissions'));
      expect(updatedPermissionsRes.status).toBe(200);
      const updatedPermissions = parse(updatedPermissionsRes);
      expect(updatedPermissions.enabled).toBe(false);
      expect(updatedPermissions.allowed_actions).toBe('selected');
      expect(updatedPermissions.sha_pinning_required).toBe(true);

      const invalidPermissionsRes = await handleShimRequest(ctx, repoUrl('/actions/permissions'), 'PUT', {
        enabled         : true,
        allowed_actions : 'external_only',
      });
      expect(invalidPermissionsRes.status).toBe(422);

      const selectedActionsRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/selected-actions'), 'PUT', {
        github_owned_allowed : false,
        verified_allowed     : false,
        patterns_allowed     : ['actions/*', 'did:jwk:*/workflow@*', 'actions/*'],
      });
      expect(selectedActionsRes.status).toBe(204);

      const selectedActionsGetRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/selected-actions'));
      expect(parse(selectedActionsGetRes)).toEqual({
        github_owned_allowed : false,
        verified_allowed     : false,
        patterns_allowed     : ['actions/*', 'did:jwk:*/workflow@*'],
      });

      const invalidSelectedActionsRes = await handleShimRequest(
        ctx,
        repoUrl('/actions/permissions/selected-actions'),
        'PUT',
        { patterns_allowed: ['actions/*', 42] },
      );
      expect(invalidSelectedActionsRes.status).toBe(422);

      const workflowRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/workflow'), 'PUT', {
        default_workflow_permissions     : 'write',
        can_approve_pull_request_reviews : true,
      });
      expect(workflowRes.status).toBe(204);

      const workflowGetRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/workflow'));
      expect(parse(workflowGetRes)).toEqual({
        default_workflow_permissions     : 'write',
        can_approve_pull_request_reviews : true,
      });

      const invalidWorkflowRes = await handleShimRequest(ctx, repoUrl('/actions/permissions/workflow'), 'PUT', {
        default_workflow_permissions: 'admin',
      });
      expect(invalidWorkflowRes.status).toBe(422);
    });

    it('should list usage, limits, filters, and deletes for repository Actions caches', async () => {
      const defaultRetentionRes = await handleShimRequest(ctx, repoUrl('/actions/cache/retention-limit'));
      expect(defaultRetentionRes.status).toBe(200);
      expect(parse(defaultRetentionRes).max_cache_retention_days).toBe(7);

      const setRetentionRes = await handleShimRequest(ctx, repoUrl('/actions/cache/retention-limit'), 'PUT', {
        max_cache_retention_days: 21,
      });
      expect(setRetentionRes.status).toBe(204);

      const retentionRes = await handleShimRequest(ctx, repoUrl('/actions/cache/retention-limit'));
      expect(parse(retentionRes).max_cache_retention_days).toBe(21);

      const invalidRetentionRes = await handleShimRequest(ctx, repoUrl('/actions/cache/retention-limit'), 'PUT', {
        max_cache_retention_days: 0,
      });
      expect(invalidRetentionRes.status).toBe(422);

      const defaultStorageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/storage-limit'));
      expect(defaultStorageRes.status).toBe(200);
      expect(parse(defaultStorageRes).max_cache_size_gb).toBe(10);

      const setStorageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/storage-limit'), 'PUT', {
        max_cache_size_gb: 150,
      });
      expect(setStorageRes.status).toBe(204);

      const storageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/storage-limit'));
      expect(parse(storageRes).max_cache_size_gb).toBe(150);

      const invalidStorageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/storage-limit'), 'PUT', {
        max_cache_size_gb: 'large',
      });
      expect(invalidStorageRes.status).toBe(422);

      await mergeRepoSettings({
        actionsCaches: {
          '505': {
            id             : 505,
            ref            : 'refs/heads/main',
            key            : 'Linux-node-main',
            version        : 'cache-version-1',
            lastAccessedAt : '2024-01-04T00:00:00.000Z',
            createdAt      : '2024-01-01T00:00:00.000Z',
            sizeInBytes    : 1024,
          },
          '506': {
            id             : 506,
            ref            : 'refs/heads/main',
            key            : 'Linux-node-feature',
            version        : 'cache-version-2',
            lastAccessedAt : '2024-01-03T00:00:00.000Z',
            createdAt      : '2024-01-02T00:00:00.000Z',
            sizeInBytes    : 2048,
          },
          '507': {
            id             : 507,
            ref            : 'refs/heads/feature/cache',
            key            : 'macOS-node-feature',
            version        : 'cache-version-3',
            lastAccessedAt : '2024-01-05T00:00:00.000Z',
            createdAt      : '2024-01-03T00:00:00.000Z',
            sizeInBytes    : 512,
          },
        },
      });

      const usageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/usage'));
      expect(usageRes.status).toBe(200);
      const usage = parse(usageRes);
      expect(usage.full_name).toBe(`${testDid}/test-repo`);
      expect(usage.active_caches_count).toBe(3);
      expect(usage.active_caches_size_in_bytes).toBe(3584);

      const listRes = await handleShimRequest(ctx, repoUrl('/actions/caches?sort=size_in_bytes&direction=asc&per_page=2'));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const list = parse(listRes);
      expect(list.total_count).toBe(3);
      expect(list.actions_caches.map((cache: any) => cache.id)).toEqual([507, 505]);
      expect(list.actions_caches[0].size_in_bytes).toBe(512);

      const filteredRes = await handleShimRequest(ctx, repoUrl('/actions/caches?ref=refs/heads/main&key=Linux-node'));
      expect(filteredRes.status).toBe(200);
      const filtered = parse(filteredRes);
      expect(filtered.total_count).toBe(2);
      expect(filtered.actions_caches.map((cache: any) => cache.id)).toEqual([505, 506]);

      const invalidSortRes = await handleShimRequest(ctx, repoUrl('/actions/caches?sort=name'));
      expect(invalidSortRes.status).toBe(422);

      const invalidDirectionRes = await handleShimRequest(ctx, repoUrl('/actions/caches?direction=sideways'));
      expect(invalidDirectionRes.status).toBe(422);

      const missingKeyRes = await handleShimRequest(ctx, repoUrl('/actions/caches'), 'DELETE');
      expect(missingKeyRes.status).toBe(422);

      const deleteByKeyRes = await handleShimRequest(ctx, repoUrl('/actions/caches?key=Linux-node-main'), 'DELETE');
      expect(deleteByKeyRes.status).toBe(200);
      const deletedByKey = parse(deleteByKeyRes);
      expect(deletedByKey.total_count).toBe(1);
      expect(deletedByKey.actions_caches[0].id).toBe(505);

      const deleteByIdRes = await handleShimRequest(ctx, repoUrl('/actions/caches/506'), 'DELETE');
      expect(deleteByIdRes.status).toBe(204);

      const missingIdRes = await handleShimRequest(ctx, repoUrl('/actions/caches/506'), 'DELETE');
      expect(missingIdRes.status).toBe(404);

      const wrongRefDeleteRes = await handleShimRequest(
        ctx,
        repoUrl('/actions/caches?key=macOS-node-feature&ref=refs/heads/main'),
        'DELETE',
      );
      expect(wrongRefDeleteRes.status).toBe(200);
      expect(parse(wrongRefDeleteRes).total_count).toBe(0);

      const finalDeleteRes = await handleShimRequest(
        ctx,
        repoUrl('/actions/caches?key=macOS-node-feature&ref=refs/heads/feature/cache'),
        'DELETE',
      );
      expect(finalDeleteRes.status).toBe(200);
      expect(parse(finalDeleteRes).total_count).toBe(1);

      const finalUsageRes = await handleShimRequest(ctx, repoUrl('/actions/cache/usage'));
      expect(parse(finalUsageRes).active_caches_count).toBe(0);

      const finalListRes = await handleShimRequest(ctx, repoUrl('/actions/caches'));
      expect(parse(finalListRes)).toEqual({ total_count: 0, actions_caches: [] });
    });

    it('should list, get, and download workflow artifacts from CI artifact records', async () => {
      const artifactBytes = Buffer.from('artifact archive bytes\n', 'utf-8');
      const digest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'artifact-ci', headBranch: 'artifact-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'success', branch: 'artifact-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const { record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data            : { output: { title: 'Package', summary: 'Created artifact.' } },
        tags            : { name: 'package', status: 'completed', conclusion: 'success' },
        parentContextId : suiteRec!.contextId ?? '',
      } as any);
      expect(runRec).toBeDefined();

      const { record: artifactRec } = await ctx.ci.records.create('repo/checkSuite/checkRun/artifact' as any, {
        data            : new Uint8Array(artifactBytes),
        dataFormat      : 'application/zip',
        tags            : { name: 'build-output', size: artifactBytes.byteLength, contentType: 'application/zip', digest },
        parentContextId : runRec!.contextId ?? '',
      } as any);
      expect(artifactRec).toBeDefined();

      const artifactId = numericId(artifactRec!.id);
      const suiteId = numericId(suiteRec!.id);
      const listRes = await handleShimRequest(ctx, repoUrl('/actions/artifacts?name=build-output'));
      expect(listRes.status).toBe(200);
      const list = parse(listRes);
      expect(list.total_count).toBe(1);
      expect(list.artifacts[0].id).toBe(artifactId);
      expect(list.artifacts[0].name).toBe('build-output');
      expect(list.artifacts[0].size_in_bytes).toBe(artifactBytes.byteLength);
      expect(list.artifacts[0].digest).toBe(digest);
      expect(list.artifacts[0].workflow_run.id).toBe(suiteId);
      expect(list.artifacts[0].archive_download_url).toContain(`/actions/artifacts/${artifactId}/zip`);

      const runArtifactsRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/artifacts?direction=asc`));
      expect(runArtifactsRes.status).toBe(200);
      const runArtifacts = parse(runArtifactsRes);
      expect(runArtifacts.total_count).toBe(1);
      expect(runArtifacts.artifacts[0].id).toBe(artifactId);

      const detailRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${artifactId}`));
      expect(detailRes.status).toBe(200);
      expect(parse(detailRes).url).toContain(`/actions/artifacts/${artifactId}`);

      const redirectRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${artifactId}/zip`));
      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.Location).toContain(`/actions/artifacts/${artifactId}/zip?download=1`);

      const downloadRes = await handleShimRequest(ctx, new URL(redirectRes.headers.Location));
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['Content-Type']).toBe('application/zip');
      expect(Buffer.from(downloadRes.body as Uint8Array).toString('utf-8')).toBe(artifactBytes.toString('utf-8'));
    });

    it('should delete artifacts and reject expired or invalid artifact downloads', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'artifact-delete-ci', headBranch: 'artifact-delete-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'failure', branch: 'artifact-delete-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const { record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data            : { output: { title: 'Package', summary: 'Failed artifact.' } },
        tags            : { name: 'package', status: 'completed', conclusion: 'failure' },
        parentContextId : suiteRec!.contextId ?? '',
      } as any);
      expect(runRec).toBeDefined();

      const { record: expiredArtifactRec } = await ctx.ci.records.create('repo/checkSuite/checkRun/artifact' as any, {
        data            : new Uint8Array(Buffer.from('expired archive\n', 'utf-8')),
        dataFormat      : 'application/zip',
        tags            : { name: 'expired-output', size: 16, contentType: 'application/zip', expired: true },
        parentContextId : runRec!.contextId ?? '',
      } as any);
      expect(expiredArtifactRec).toBeDefined();

      const { record: deleteArtifactRec } = await ctx.ci.records.create('repo/checkSuite/checkRun/artifact' as any, {
        data            : new Uint8Array(Buffer.from('delete archive\n', 'utf-8')),
        dataFormat      : 'application/zip',
        tags            : { name: 'delete-output', size: 15, contentType: 'application/zip' },
        parentContextId : runRec!.contextId ?? '',
      } as any);
      expect(deleteArtifactRec).toBeDefined();

      const expiredId = numericId(expiredArtifactRec!.id);
      const deleteId = numericId(deleteArtifactRec!.id);

      const expiredDownloadRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${expiredId}/zip`));
      expect(expiredDownloadRes.status).toBe(410);

      const invalidFormatRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${deleteId}/tar`));
      expect(invalidFormatRes.status).toBe(422);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${deleteId}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const missingDetailRes = await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${deleteId}`));
      expect(missingDetailRes.status).toBe(404);

      const missingRunArtifactsRes = await handleShimRequest(ctx, repoUrl('/actions/runs/999999/artifacts'));
      expect(missingRunArtifactsRes.status).toBe(404);
    });

    it('should download workflow run and job logs from CI check run output', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'logs-ci', headBranch: 'logs-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'success', branch: 'logs-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const { record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data: {
          output: {
            title   : 'Build',
            summary : 'Build log summary.',
            text    : 'checkout\nbun install\nbun test',
            steps   : [
              { name: 'Install', status: 'completed', conclusion: 'success', logs: 'bun install --frozen-lockfile' },
              { name: 'Test', status: 'completed', conclusion: 'success', logs: 'bun test tests/github-shim.spec.ts' },
            ],
          },
        },
        tags            : { name: 'build', status: 'completed', conclusion: 'success' },
        parentContextId : suiteRec!.contextId ?? '',
      } as any);
      expect(runRec).toBeDefined();

      const suiteId = numericId(suiteRec!.id);
      const jobId = numericId(runRec!.id);

      const jobRes = await handleShimRequest(ctx, repoUrl(`/actions/jobs/${jobId}`));
      expect(jobRes.status).toBe(200);
      expect(parse(jobRes).logs_url).toContain(`/actions/jobs/${jobId}/logs`);

      const runRedirectRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/logs`));
      expect(runRedirectRes.status).toBe(302);
      expect(runRedirectRes.headers.Location).toContain(`/actions/runs/${suiteId}/logs?download=1`);

      const runDownloadRes = await handleShimRequest(ctx, new URL(runRedirectRes.headers.Location));
      expect(runDownloadRes.status).toBe(200);
      expect(runDownloadRes.headers['Content-Type']).toBe('application/zip');
      const runLogBytes = Buffer.from(runDownloadRes.body as Uint8Array);
      expect(runLogBytes.subarray(0, 2).toString('utf-8')).toBe('PK');
      expect(runLogBytes.toString('utf-8')).toContain('bun test tests/github-shim.spec.ts');

      const jobRedirectRes = await handleShimRequest(ctx, repoUrl(`/actions/jobs/${jobId}/logs`));
      expect(jobRedirectRes.status).toBe(302);
      expect(jobRedirectRes.headers.Location).toContain(`/actions/jobs/${jobId}/logs?download=1`);

      const jobDownloadRes = await handleShimRequest(ctx, new URL(jobRedirectRes.headers.Location));
      expect(jobDownloadRes.status).toBe(200);
      expect(jobDownloadRes.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(Buffer.from(jobDownloadRes.body as Uint8Array).toString('utf-8')).toContain('bun install');
    });

    it('should delete workflow run logs and return 404 for missing log targets', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'delete-logs-ci', headBranch: 'delete-logs-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'failure', branch: 'delete-logs-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const { record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data            : { output: { title: 'Failing job', text: 'secret failure log line' } },
        tags            : { name: 'failure', status: 'completed', conclusion: 'failure' },
        parentContextId : suiteRec!.contextId ?? '',
      } as any);
      expect(runRec).toBeDefined();

      const suiteId = numericId(suiteRec!.id);
      const jobId = numericId(runRec!.id);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/logs`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const jobDownloadRes = await handleShimRequest(ctx, repoUrl(`/actions/jobs/${jobId}/logs?download=1`));
      expect(jobDownloadRes.status).toBe(200);
      expect(Buffer.from(jobDownloadRes.body as Uint8Array).toString('utf-8')).toBe('');

      const missingRunRes = await handleShimRequest(ctx, repoUrl('/actions/runs/999999/logs'));
      expect(missingRunRes.status).toBe(404);

      const missingJobRes = await handleShimRequest(ctx, repoUrl('/actions/jobs/999999/logs'));
      expect(missingJobRes.status).toBe(404);
    });

    it('should return workflow run attempts, attempt logs, and run usage timing', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data: {
          app         : 'attempt-ci',
          headBranch  : 'attempt-branch',
          startedAt   : '2026-01-01T00:00:00.000Z',
          completedAt : '2026-01-01T00:05:00.000Z',
        },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'success', branch: 'attempt-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const { record: runRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data: {
          startedAt   : '2026-01-01T00:01:00.000Z',
          completedAt : '2026-01-01T00:04:00.000Z',
          output      : { title: 'Attempt job', summary: 'Attempt summary.', text: 'attempt log line' },
        },
        tags            : { name: 'attempt-job', status: 'completed', conclusion: 'success' },
        parentContextId : suiteRec!.contextId ?? '',
      } as any);
      expect(runRec).toBeDefined();

      const suiteId = numericId(suiteRec!.id);
      const jobId = numericId(runRec!.id);

      const attemptRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/attempts/1`));
      expect(attemptRes.status).toBe(200);
      expect(parse(attemptRes).run_attempt).toBe(1);

      const missingAttemptRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/attempts/2`));
      expect(missingAttemptRes.status).toBe(404);

      const attemptLogsRedirect = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/attempts/1/logs`));
      expect(attemptLogsRedirect.status).toBe(302);
      expect(attemptLogsRedirect.headers.Location).toContain(`/actions/runs/${suiteId}/attempts/1/logs?download=1`);

      const attemptLogsDownload = await handleShimRequest(ctx, new URL(attemptLogsRedirect.headers.Location));
      expect(attemptLogsDownload.status).toBe(200);
      expect(attemptLogsDownload.headers['Content-Type']).toBe('application/zip');
      expect(Buffer.from(attemptLogsDownload.body as Uint8Array).toString('utf-8')).toContain('attempt log line');

      const timingRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/timing`));
      expect(timingRes.status).toBe(200);
      const timing = parse(timingRes);
      expect(timing.run_duration_ms).toBe(300000);
      expect(timing.billable.UBUNTU.total_ms).toBe(180000);
      expect(timing.billable.UBUNTU.job_runs).toEqual([{ job_id: jobId, duration_ms: 180000 }]);

      const missingTimingRes = await handleShimRequest(ctx, repoUrl('/actions/runs/999999/timing'));
      expect(missingTimingRes.status).toBe(404);
    });

    it('should cancel, force-cancel, and delete workflow runs', async () => {
      const { record: cancelSuiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'cancel-ci', headBranch: 'cancel-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'in_progress', branch: 'cancel-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(cancelSuiteRec).toBeDefined();

      const { record: cancelRunRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data            : { output: { title: 'Cancel job', summary: 'Running.' } },
        tags            : { name: 'cancel-job', status: 'in_progress' },
        parentContextId : cancelSuiteRec!.contextId ?? '',
      } as any);
      expect(cancelRunRec).toBeDefined();

      const cancelSuiteId = numericId(cancelSuiteRec!.id);
      const cancelJobId = numericId(cancelRunRec!.id);
      const cancelRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${cancelSuiteId}/cancel`), 'POST');
      expect(cancelRes.status).toBe(202);
      expect(cancelRes.body).toBe('');

      const cancelledRun = parse(await handleShimRequest(ctx, repoUrl(`/actions/runs/${cancelSuiteId}`)));
      expect(cancelledRun.status).toBe('completed');
      expect(cancelledRun.conclusion).toBe('cancelled');
      const cancelledJob = parse(await handleShimRequest(ctx, repoUrl(`/actions/jobs/${cancelJobId}`)));
      expect(cancelledJob.status).toBe('completed');
      expect(cancelledJob.conclusion).toBe('cancelled');

      const repeatedCancelRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${cancelSuiteId}/cancel`), 'POST');
      expect(repeatedCancelRes.status).toBe(409);

      const { record: forceSuiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'force-cancel-ci', headBranch: 'force-cancel-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'failure', branch: 'force-cancel-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(forceSuiteRec).toBeDefined();

      const forceSuiteId = numericId(forceSuiteRec!.id);
      const forceCancelRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${forceSuiteId}/force-cancel`), 'POST');
      expect(forceCancelRes.status).toBe(202);
      expect(parse(await handleShimRequest(ctx, repoUrl(`/actions/runs/${forceSuiteId}`))).conclusion).toBe('cancelled');

      const { record: deleteSuiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'delete-run-ci', headBranch: 'delete-run-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'completed', conclusion: 'success', branch: 'delete-run-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(deleteSuiteRec).toBeDefined();

      const { record: deleteRunRec } = await ctx.ci.records.create('repo/checkSuite/checkRun' as any, {
        data            : { output: { title: 'Delete job', summary: 'Complete.' } },
        tags            : { name: 'delete-job', status: 'completed', conclusion: 'success' },
        parentContextId : deleteSuiteRec!.contextId ?? '',
      } as any);
      expect(deleteRunRec).toBeDefined();

      const { record: deleteArtifactRec } = await ctx.ci.records.create('repo/checkSuite/checkRun/artifact' as any, {
        data            : new Uint8Array(Buffer.from('delete-run artifact\n', 'utf-8')),
        dataFormat      : 'application/zip',
        tags            : { name: 'delete-run-artifact', size: 20, contentType: 'application/zip' },
        parentContextId : deleteRunRec!.contextId ?? '',
      } as any);
      expect(deleteArtifactRec).toBeDefined();

      const deleteSuiteId = numericId(deleteSuiteRec!.id);
      const deleteArtifactId = numericId(deleteArtifactRec!.id);
      const deleteRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${deleteSuiteId}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');
      expect((await handleShimRequest(ctx, repoUrl(`/actions/runs/${deleteSuiteId}`))).status).toBe(404);
      expect((await handleShimRequest(ctx, repoUrl(`/actions/artifacts/${deleteArtifactId}`))).status).toBe(404);
      expect((await handleShimRequest(ctx, repoUrl('/actions/runs/999999/cancel'), 'POST')).status).toBe(404);
      expect((await handleShimRequest(ctx, repoUrl('/actions/runs/999999'), 'DELETE')).status).toBe(404);
    });

    it('should list, get, and list runs for workflow definitions from CI check suites', async () => {
      const workflowSha = '5555555555555555555555555555555555555555';
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'workflow-ci', headBranch: 'workflow-branch' },
        tags            : { commitSha: workflowSha, status: 'completed', conclusion: 'success', branch: 'workflow-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const workflowId = numericId('workflow:workflow-ci');
      const listRes = await handleShimRequest(ctx, repoUrl('/actions/workflows?per_page=100'));
      expect(listRes.status).toBe(200);
      const list = parse(listRes);
      const workflow = list.workflows.find((entry: any) => entry.id === workflowId);
      expect(workflow).toBeDefined();
      expect(workflow.name).toBe('workflow-ci');
      expect(workflow.path).toBe('.github/workflows/workflow-ci.yml');
      expect(workflow.state).toBe('active');
      expect(workflow.url).toContain(`/actions/workflows/${workflowId}`);

      const detailRes = await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}`));
      expect(detailRes.status).toBe(200);
      expect(parse(detailRes).name).toBe('workflow-ci');

      const fileDetailRes = await handleShimRequest(ctx, repoUrl('/actions/workflows/workflow-ci.yml'));
      expect(fileDetailRes.status).toBe(200);
      expect(parse(fileDetailRes).id).toBe(workflowId);

      const runsRes = await handleShimRequest(
        ctx,
        repoUrl(`/actions/workflows/${workflowId}/runs?branch=workflow-branch&status=success&head_sha=${workflowSha}`),
      );
      expect(runsRes.status).toBe(200);
      const runs = parse(runsRes);
      expect(runs.total_count).toBe(1);
      expect(runs.workflow_runs[0].workflow_id).toBe(workflowId);
      expect(runs.workflow_runs[0].head_sha).toBe(workflowSha);

      const timingRes = await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}/timing`));
      expect(timingRes.status).toBe(200);
      expect(parse(timingRes)).toEqual({ billable: {} });

      const missingRes = await handleShimRequest(ctx, repoUrl('/actions/workflows/999999'));
      expect(missingRes.status).toBe(404);
    });

    it('should enable and disable workflow definitions', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'toggle-ci', headBranch: 'toggle-branch' },
        tags            : { commitSha: FEATURE_SHA, status: 'queued', branch: 'toggle-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const workflowId = numericId('workflow:toggle-ci');
      const disableRes = await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}/disable`), 'PUT');
      expect(disableRes.status).toBe(204);
      expect(disableRes.body).toBe('');

      const disabled = parse(await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}`)));
      expect(disabled.state).toBe('disabled_manually');

      const disabledDispatch = await handleShimRequest(
        ctx,
        repoUrl(`/actions/workflows/${workflowId}/dispatches`),
        'POST',
        { ref: 'main' },
      );
      expect(disabledDispatch.status).toBe(422);

      const enableRes = await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}/enable`), 'PUT');
      expect(enableRes.status).toBe(204);
      expect(enableRes.body).toBe('');

      const enabled = parse(await handleShimRequest(ctx, repoUrl(`/actions/workflows/${workflowId}`)));
      expect(enabled.state).toBe('active');
    });

    it('should dispatch a workflow by creating a queued CI check suite', async () => {
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'dispatch-ci', headBranch: 'main' },
        tags            : { commitSha: MAIN_SHA, status: 'completed', conclusion: 'success', branch: 'main' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();

      const workflowId = numericId('workflow:dispatch-ci');
      const dispatchRes = await handleShimRequest(
        ctx,
        repoUrl(`/actions/workflows/${workflowId}/dispatches`),
        'POST',
        { ref: 'feature/demo', inputs: { target: 'staging' } },
      );
      expect(dispatchRes.status).toBe(200);
      const dispatch = parse(dispatchRes);
      expect(dispatch.workflow_run_id).toBeGreaterThan(0);
      expect(dispatch.run_url).toContain(`/actions/runs/${dispatch.workflow_run_id}`);

      const runRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${dispatch.workflow_run_id}`));
      expect(runRes.status).toBe(200);
      const run = parse(runRes);
      expect(run.workflow_id).toBe(workflowId);
      expect(run.event).toBe('workflow_dispatch');
      expect(run.status).toBe('queued');
      expect(run.conclusion).toBeNull();
      expect(run.head_branch).toBe('feature/demo');
      expect(run.head_sha).toBe(FEATURE_SHA);

      const missingRefRes = await handleShimRequest(
        ctx,
        repoUrl(`/actions/workflows/${workflowId}/dispatches`),
        'POST',
        { inputs: { target: 'staging' } },
      );
      expect(missingRefRes.status).toBe(422);

      const missingWorkflowRes = await handleShimRequest(
        ctx,
        repoUrl('/actions/workflows/999999/dispatches'),
        'POST',
        { ref: 'main' },
      );
      expect(missingWorkflowRes.status).toBe(404);
    });

    it('should list, filter, and get workflow runs from CI check suites', async () => {
      const actionSha = '4444444444444444444444444444444444444444';
      const { record: suiteRec } = await ctx.ci.records.create('repo/checkSuite' as any, {
        data            : { app: 'actions-ci', headBranch: 'actions-branch' },
        tags            : { commitSha: actionSha, status: 'completed', conclusion: 'success', branch: 'actions-branch' },
        parentContextId : repoContextId,
      } as any);
      expect(suiteRec).toBeDefined();
      const suiteId = numericId(suiteRec!.id);

      const res = await handleShimRequest(
        ctx,
        repoUrl(`/actions/runs?branch=actions-branch&status=success&head_sha=${actionSha}&per_page=1`),
      );
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.total_count).toBe(1);
      expect(data.workflow_runs[0].id).toBe(suiteId);
      expect(data.workflow_runs[0].check_suite_id).toBe(suiteId);
      expect(data.workflow_runs[0].head_sha).toBe(actionSha);
      expect(data.workflow_runs[0].status).toBe('completed');
      expect(data.workflow_runs[0].conclusion).toBe('success');
      expect(data.workflow_runs[0].jobs_url).toContain(`/actions/runs/${suiteId}/jobs`);
      expect(data.workflow_runs[0].repository.full_name).toBe(`${testDid}/test-repo`);

      const detailRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}`));
      expect(detailRes.status).toBe(200);
      const detail = parse(detailRes);
      expect(detail.id).toBe(suiteId);
      expect(detail.workflow_id).toBe(numericId('workflow:actions-ci'));
      expect(detail.check_suite_url).toContain(`/check-suites/${suiteId}`);

      const emptyRes = await handleShimRequest(
        ctx,
        repoUrl('/actions/runs?status=cancelled&head_sha=0000000000000000000000000000000000000000'),
      );
      expect(parse(emptyRes).total_count).toBe(0);

      const invalidSuiteRes = await handleShimRequest(ctx, repoUrl('/actions/runs?check_suite_id=not-a-number'));
      expect(invalidSuiteRes.status).toBe(422);

      const invalidStatusRes = await handleShimRequest(ctx, repoUrl('/actions/runs?status=banana'));
      expect(invalidStatusRes.status).toBe(422);
    });

    it('should list and get workflow jobs from CI check runs', async () => {
      const suiteId = numericId(checkSuiteRecId);
      const runId = numericId(checkRunRecId);

      const listRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${suiteId}/jobs?per_page=1`));
      expect(listRes.status).toBe(200);
      const data = parse(listRes);
      expect(data.total_count).toBe(1);
      expect(data.jobs[0].id).toBe(runId);
      expect(data.jobs[0].run_id).toBe(suiteId);
      expect(data.jobs[0].name).toBe('lint');
      expect(data.jobs[0].status).toBe('completed');
      expect(data.jobs[0].conclusion).toBe('success');
      expect(data.jobs[0].check_run_url).toContain(`/check-runs/${runId}`);
      expect(data.jobs[0].steps[0].name).toBe('Lint');

      const detailRes = await handleShimRequest(ctx, repoUrl(`/actions/jobs/${runId}`));
      expect(detailRes.status).toBe(200);
      const detail = parse(detailRes);
      expect(detail.id).toBe(runId);
      expect(detail.workflow_name).toBe('gitd-ci');
      expect(detail.head_branch).toBe('main');

      const missingRunRes = await handleShimRequest(ctx, repoUrl('/actions/runs/999/jobs'));
      expect(missingRunRes.status).toBe(404);

      const missingJobRes = await handleShimRequest(ctx, repoUrl('/actions/jobs/999'));
      expect(missingJobRes.status).toBe(404);
    });

    it('should rerun workflow runs, failed jobs, and individual workflow jobs', async () => {
      const failedRunRes = await handleShimRequest(ctx, repoUrl('/check-runs'), 'POST', {
        name       : 'actions-failed-jobs',
        head_sha   : FEATURE_SHA,
        status     : 'completed',
        conclusion : 'failure',
        output     : { title: 'Actions failed jobs', summary: 'Failed before rerun.' },
      });
      expect(failedRunRes.status).toBe(201);
      const failedRun = parse(failedRunRes);

      const rerunFailedRes = await handleShimRequest(
        ctx,
        repoUrl(`/actions/runs/${failedRun.check_suite.id}/rerun-failed-jobs`),
        'POST',
      );
      expect(rerunFailedRes.status).toBe(201);
      expect(rerunFailedRes.body).toBe('');

      const rerunFailedJob = parse(await handleShimRequest(ctx, repoUrl(`/actions/jobs/${failedRun.id}`)));
      expect(rerunFailedJob.status).toBe('queued');
      expect(rerunFailedJob.conclusion).toBeNull();

      const failedJobRes = await handleShimRequest(ctx, repoUrl('/check-runs'), 'POST', {
        name       : 'actions-job-rerun',
        head_sha   : FEATURE_SHA,
        status     : 'completed',
        conclusion : 'failure',
        output     : { title: 'Actions job rerun', summary: 'Failed before job rerun.' },
      });
      expect(failedJobRes.status).toBe(201);
      const failedJob = parse(failedJobRes);

      const jobRerunRes = await handleShimRequest(ctx, repoUrl(`/actions/jobs/${failedJob.id}/rerun`), 'POST');
      expect(jobRerunRes.status).toBe(201);
      expect(jobRerunRes.body).toBe('');

      const jobAfterRerun = parse(await handleShimRequest(ctx, repoUrl(`/actions/jobs/${failedJob.id}`)));
      expect(jobAfterRerun.status).toBe('queued');
      expect(jobAfterRerun.conclusion).toBeNull();

      const workflowRerunRes = await handleShimRequest(ctx, repoUrl(`/actions/runs/${failedJob.check_suite.id}/rerun`), 'POST');
      expect(workflowRerunRes.status).toBe(201);
      expect(workflowRerunRes.body).toBe('');

      const workflowAfterRerun = parse(await handleShimRequest(ctx, repoUrl(`/actions/runs/${failedJob.check_suite.id}`)));
      expect(workflowAfterRerun.status).toBe('queued');
      expect(workflowAfterRerun.conclusion).toBeNull();

      const missingRunRerunRes = await handleShimRequest(ctx, repoUrl('/actions/runs/999/rerun'), 'POST');
      expect(missingRunRerunRes.status).toBe(404);

      const missingJobRerunRes = await handleShimRequest(ctx, repoUrl('/actions/jobs/999/rerun'), 'POST');
      expect(missingJobRerunRes.status).toBe(404);
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
      const issueNum = numericId(issueRecId);
      const issue = data.find((i: any) => i.number === issueNum);
      expect(issue).toBeDefined();
      expect(issue.title).toBe('Fix the widget');
      expect(issue.body).toBe('The widget is broken.');
      expect(issue.user.login).toBe(testDid);
      expect(issue.url).toContain(`/issues/${issueNum}`);
      expect(issue.comments_url).toContain(`/issues/${issueNum}/comments`);
      expect(issue.labels).toEqual([]);
      expect(issue.assignee).toBeNull();
      expect(issue.assignees).toEqual([]);
      expect(issue.milestone.title).toBe(MILESTONE_TITLE);
      expect(issue.milestone.number).toBe(githubMilestoneNumber(MILESTONE_TITLE));
      expect(issue.locked).toBe(false);
      expect(issue.active_lock_reason).toBeNull();
    });

    it('should honor GitHub issue body media types', async () => {
      const issueNum = numericId(issueRecId);
      const htmlRes = await handleShimRequest(ctx, repoUrl('/issues?state=all'), 'GET', {}, null, {
        accept: 'application/vnd.github.html+json',
      });
      expect(htmlRes.status).toBe(200);
      const htmlIssue = parse(htmlRes).find((issue: any) => issue.number === issueNum);
      expect(htmlIssue.body).toBeUndefined();
      expect(htmlIssue.body_text).toBeUndefined();
      expect(htmlIssue.body_html).toBe('<p>The widget is broken.</p>');

      const fullRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`), 'GET', {}, null, {
        accept: 'application/vnd.github.full+json',
      });
      expect(fullRes.status).toBe(200);
      const fullIssue = parse(fullRes);
      expect(fullIssue.body).toBe('The widget is broken.');
      expect(fullIssue.body_text).toBe('The widget is broken.');
      expect(fullIssue.body_html).toBe('<p>The widget is broken.</p>');
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
  // GET /issues, /user/issues, and /orgs/:org/issues
  // =========================================================================

  describe('top-level issue inbox endpoints', () => {
    it('should list assigned and user account issues across visible repositories', async () => {
      const inboxRepoName = 'inbox-issues-repo';
      const createRepoRes = await handleShimRequest(ctx, url('/user/repos'), 'POST', {
        name        : inboxRepoName,
        description : 'Issue inbox fixture repository',
        visibility  : 'public',
      }, null, shimOptions());
      expect(createRepoRes.status).toBe(201);

      const inboxRepoUrl = (subPath: string): URL => url(`/repos/${testDid}/${inboxRepoName}${subPath}`);
      const createRes = await handleShimRequest(ctx, inboxRepoUrl('/issues'), 'POST', {
        title     : 'Inbox assigned issue',
        body      : `Mentioning ${testDid} for inbox filters.`,
        labels    : [{ name: 'inbox-label', color: '5319e7' }],
        assignees : [testDid],
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const assignedRes = await handleShimRequest(ctx, url('/issues?labels=inbox-label'));
      expect(assignedRes.status).toBe(200);
      const assigned = parse(assignedRes);
      expect(assigned.map((issue: any) => issue.number)).toContain(created.number);
      expect(assigned[0].repository.full_name).toBe(`${testDid}/${inboxRepoName}`);
      expect(assigned[0].assignees.map((user: any) => user.login)).toContain(testDid);

      const userCreatedRes = await handleShimRequest(
        ctx,
        url('/user/issues?filter=created&state=all&labels=inbox-label'),
      );
      expect(userCreatedRes.status).toBe(200);
      expect(parse(userCreatedRes).map((issue: any) => issue.number)).toEqual([created.number]);

      const mentionedRes = await handleShimRequest(
        ctx,
        url('/user/issues?filter=mentioned&state=all&labels=inbox-label'),
      );
      expect(mentionedRes.status).toBe(200);
      expect(parse(mentionedRes).map((issue: any) => issue.number)).toEqual([created.number]);

      const pagedRes = await handleShimRequest(ctx, url('/user/issues?filter=all&state=all&per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(pagedRes.headers.Link).toContain('rel="next"');

      const invalidFilterRes = await handleShimRequest(ctx, url('/issues?filter=banana'));
      expect(invalidFilterRes.status).toBe(422);
    });

    it('should list organization issues for existing organization routes', async () => {
      const orgRes = await handleShimRequest(ctx, orgUrl('/issues?filter=all&state=all&labels=inbox-label'));
      expect(orgRes.status).toBe(200);
      const data = parse(orgRes);
      expect(data.length).toBe(1);
      expect(data[0].title).toBe('Inbox assigned issue');
      expect(data[0].repository.full_name).toBe(`${testDid}/inbox-issues-repo`);

      const missingOrgRes = await handleShimRequest(ctx, url('/orgs/missing-org/issues'));
      expect(missingOrgRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues/:number
  // =========================================================================

  describe('GET /repos/:did/:repo/issues/:number', () => {
    it('should return issue detail', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(issueNum);
      expect(data.title).toBe('Fix the widget');
      expect(data.body).toBe('The widget is broken.');
      expect(data.state).toBe('open');
    });

    it('should include comment count', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`));
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
  // PUT/DELETE /repos/:did/:repo/issues/:number/lock
  // =========================================================================

  describe('issue lock endpoints', () => {
    it('should lock and unlock issue conversations', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Lockable issue',
      });
      expect(createRes.status).toBe(201);
      const issue = parse(createRes);

      const lockRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/lock`), 'PUT', {
        lock_reason: 'too heated',
      });
      expect(lockRes.status).toBe(204);

      const lockedRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`));
      expect(lockedRes.status).toBe(200);
      const locked = parse(lockedRes);
      expect(locked.locked).toBe(true);
      expect(locked.active_lock_reason).toBe('too heated');

      const unlockRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/lock`), 'DELETE');
      expect(unlockRes.status).toBe(204);

      const unlockedRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`));
      expect(unlockedRes.status).toBe(200);
      const unlocked = parse(unlockedRes);
      expect(unlocked.locked).toBe(false);
      expect(unlocked.active_lock_reason).toBeNull();
    });

    it('should reject invalid issue lock reasons and missing issues', async () => {
      const issueNum = numericId(issueRecId);
      const invalidRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/lock`), 'PUT', {
        lock_reason: 'duplicate',
      });
      expect(invalidRes.status).toBe(422);
      expect(parse(invalidRes).message).toContain('lock_reason');

      const missingLockRes = await handleShimRequest(ctx, repoUrl('/issues/999/lock'), 'PUT', {
        lock_reason: 'spam',
      });
      expect(missingLockRes.status).toBe(404);

      const missingUnlockRes = await handleShimRequest(ctx, repoUrl('/issues/999/lock'), 'DELETE');
      expect(missingUnlockRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/milestones
  // =========================================================================

  describe('milestone endpoints', () => {
    it('should list repository milestones with issue counts and pagination', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/milestones'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe(MILESTONE_TITLE);
      expect(data[0].number).toBe(githubMilestoneNumber(MILESTONE_TITLE));
      expect(data[0].state).toBe('open');
      expect(data[0].open_issues).toBe(1);
      expect(data[0].closed_issues).toBe(1);
      expect(data[0].labels_url).toContain(`/milestones/${githubMilestoneNumber(MILESTONE_TITLE)}/labels`);

      const pagedRes = await handleShimRequest(ctx, repoUrl('/milestones?state=all&per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes)).toHaveLength(1);
    });

    it('should return a single milestone by number', async () => {
      const number = githubMilestoneNumber(MILESTONE_TITLE);
      const res = await handleShimRequest(ctx, repoUrl(`/milestones/${number}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.title).toBe(MILESTONE_TITLE);
      expect(data.url).toContain(`/milestones/${number}`);
      expect(data.creator.login).toBe(testDid);
      expect(data.due_on).toBeNull();
    });

    it('should list labels for issues in a milestone', async () => {
      const number = githubMilestoneNumber(MILESTONE_TITLE);
      const res = await handleShimRequest(ctx, repoUrl(`/milestones/${number}/labels`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((label: any) => label.name)).toEqual(['bug', 'enhancement']);
    });

    it('should create, update, and delete repository milestones', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/milestones'), 'POST', {
        title       : 'v2.0',
        description : 'Tracking milestone for version 2.0',
        due_on      : '2012-10-09T23:39:01Z',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.title).toBe('v2.0');
      expect(created.state).toBe('open');
      expect(created.description).toBe('Tracking milestone for version 2.0');
      expect(created.due_on).toBe('2012-10-09T23:39:01.000Z');
      expect(created.open_issues).toBe(0);
      expect(created.closed_issues).toBe(0);

      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title     : 'Issue with managed milestone',
        milestone : created.number,
      });
      expect(issueRes.status).toBe(201);
      const issue = parse(issueRes);
      expect(issue.milestone.title).toBe('v2.0');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/milestones/${created.number}`), 'PATCH', {
        title       : 'v2.1',
        state       : 'closed',
        description : null,
        due_on      : null,
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.number).toBe(created.number);
      expect(updated.title).toBe('v2.1');
      expect(updated.state).toBe('closed');
      expect(updated.description).toBeNull();
      expect(updated.due_on).toBeNull();
      expect(updated.closed_at).not.toBeNull();
      expect(updated.open_issues).toBe(1);

      const issueAfterRenameRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`));
      expect(issueAfterRenameRes.status).toBe(200);
      const issueAfterRename = parse(issueAfterRenameRes);
      expect(issueAfterRename.milestone.number).toBe(created.number);
      expect(issueAfterRename.milestone.title).toBe('v2.1');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/milestones/${created.number}`), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl(`/milestones/${created.number}`));
      expect(missingRes.status).toBe(404);

      const issueAfterDeleteRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`));
      expect(issueAfterDeleteRes.status).toBe(200);
      expect(parse(issueAfterDeleteRes).milestone).toBeNull();
    });

    it('should reject duplicate or invalid milestone payloads', async () => {
      const duplicateRes = await handleShimRequest(ctx, repoUrl('/milestones'), 'POST', {
        title: MILESTONE_TITLE,
      });
      expect(duplicateRes.status).toBe(422);

      const invalidDueDateRes = await handleShimRequest(ctx, repoUrl('/milestones'), 'POST', {
        title  : 'Bad due date',
        due_on : 'not a date',
      });
      expect(invalidDueDateRes.status).toBe(422);

      const invalidStateRes = await handleShimRequest(
        ctx, repoUrl(`/milestones/${githubMilestoneNumber(MILESTONE_TITLE)}`), 'PATCH', { state: 'done' },
      );
      expect(invalidStateRes.status).toBe(422);

      const missingUpdateRes = await handleShimRequest(ctx, repoUrl('/milestones/999'), 'PATCH', {
        title: 'Still missing',
      });
      expect(missingUpdateRes.status).toBe(404);
    });

    it('should return 404 for missing milestones', async () => {
      const detailRes = await handleShimRequest(ctx, repoUrl('/milestones/999'));
      expect(detailRes.status).toBe(404);

      const labelsRes = await handleShimRequest(ctx, repoUrl('/milestones/999/labels'));
      expect(labelsRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/DELETE /repos/:did/:repo/issues/:number/reactions
  // =========================================================================

  describe('issue reaction endpoints', () => {
    it('should create, list, filter, and delete issue reactions', async () => {
      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Issue that will receive reactions',
      });
      expect(issueRes.status).toBe(201);
      const issue = parse(issueRes);
      expect(issue.reactions.url).toContain(`/issues/${issue.number}/reactions`);

      const emptyRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`));
      expect(emptyRes.status).toBe(200);
      expect(parse(emptyRes)).toEqual([]);

      const createHeartRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(createHeartRes.status).toBe(201);
      const heart = parse(createHeartRes);
      expect(heart.content).toBe('heart');
      expect(heart.user.login).toBe(testDid);

      const createRocketRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`), 'POST', {
        content: 'rocket',
      });
      expect(createRocketRes.status).toBe(201);

      const filteredRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions?content=heart`));
      expect(filteredRes.status).toBe(200);
      expect(parse(filteredRes).map((reaction: any) => reaction.content)).toEqual(['heart']);

      const detailRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`));
      const detail = parse(detailRes);
      expect(detail.reactions.total_count).toBe(2);
      expect(detail.reactions.heart).toBe(1);
      expect(detail.reactions.rocket).toBe(1);

      const deleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${issue.number}/reactions/${heart.id}`),
        'DELETE',
      );
      expect(deleteRes.status).toBe(204);

      const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions?content=heart`));
      expect(parse(afterDeleteRes)).toEqual([]);
    });

    it('should return existing issue reactions on duplicate creates', async () => {
      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Duplicate issue reaction target',
      });
      const issue = parse(issueRes);

      const firstRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`), 'POST', {
        content: '+1',
      });
      expect(firstRes.status).toBe(201);
      const first = parse(firstRes);

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`), 'POST', {
        content: '+1',
      });
      expect(duplicateRes.status).toBe(200);
      const duplicate = parse(duplicateRes);
      expect(duplicate.id).toBe(first.id);

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`));
      expect(parse(listRes).length).toBe(1);
    });

    it('should reject invalid issue reaction content', async () => {
      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Invalid issue reaction target',
      });
      const issue = parse(issueRes);

      const createRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions`), 'POST', {
        content: 'shipit',
      });
      expect(createRes.status).toBe(422);
      expect(parse(createRes).message).toContain('content');

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/reactions?content=shipit`));
      expect(listRes.status).toBe(422);
      expect(parse(listRes).message).toContain('content');
    });

    it('should return 404 for missing issue reactions', async () => {
      const missingIssueRes = await handleShimRequest(ctx, repoUrl('/issues/999/reactions'));
      expect(missingIssueRes.status).toBe(404);

      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Missing issue reaction target',
      });
      const issue = parse(issueRes);

      const missingReactionRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${issue.number}/reactions/999`),
        'DELETE',
      );
      expect(missingReactionRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues/:number/comments
  // =========================================================================

  describe('GET /repos/:did/:repo/issues/:number/comments', () => {
    it('should return issue comments', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should include GitHub-style comment fields', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`));
      const data = parse(res);
      expect(data[0].body).toBe('I can reproduce this.');
      expect(data[0].user.login).toBe(testDid);
      expect(data[0].created_at).toBeDefined();
      expect(data[0].author_association).toBe('OWNER');
      expect(data[0].issue_url).toContain(`/issues/${issueNum}`);
    });

    it('should honor GitHub issue comment body media types', async () => {
      const issueNum = numericId(issueRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: '**Bold** and `code`.',
      }, null, {
        accept: 'application/vnd.github.full+json',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.body).toBe('**Bold** and `code`.');
      expect(created.body_text).toBe('Bold and code.');
      expect(created.body_html).toBe('<p><strong>Bold</strong> and <code>code</code>.</p>');

      const listTextRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'GET', {}, null, {
        accept: 'application/vnd.github.text+json',
      });
      expect(listTextRes.status).toBe(200);
      const listed = parse(listTextRes).find((comment: any) => comment.id === created.id);
      expect(listed.body).toBeUndefined();
      expect(listed.body_text).toBe('Bold and code.');
      expect(listed.body_html).toBeUndefined();

      const getHtmlRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'GET', {}, null, {
        accept: 'application/vnd.github.v3.html+json',
      });
      expect(getHtmlRes.status).toBe(200);
      const html = parse(getHtmlRes);
      expect(html.body).toBeUndefined();
      expect(html.body_html).toBe('<p><strong>Bold</strong> and <code>code</code>.</p>');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'PATCH', {
        body: 'Updated **comment**.',
      }, null, {
        accept: 'application/vnd.github.full+json',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBe('Updated **comment**.');
      expect(updated.body_text).toBe('Updated comment.');
      expect(updated.body_html).toBe('<p>Updated <strong>comment</strong>.</p>');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
    });

    it('should return 404 for non-existent issue comments', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999/comments'));
      expect(res.status).toBe(404);
    });

    it('should support pagination', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments?per_page=1`));
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(res.headers['Link']).toBeDefined();
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/issues/:number/timeline
  // =========================================================================

  describe('GET /repos/:did/:repo/issues/:number/timeline', () => {
    it('should return commented timeline entries with pagination', async () => {
      const issueNum = numericId(issueRecId);
      const pagedRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/timeline?per_page=1`));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes)).toHaveLength(1);
      expect(pagedRes.headers['Link']).toContain('rel="next"');

      const issueRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`));
      expect(parse(issueRes).timeline_url).toContain(`/issues/${issueNum}/timeline`);

      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/timeline`));
      expect(res.status).toBe(200);
      const data = parse(res);
      const comment = data.find((entry: any) => entry.body === 'I can reproduce this.');
      expect(comment).toBeDefined();
      expect(comment.event).toBe('commented');
      expect(comment.actor.login).toBe(testDid);
      expect(comment.user.login).toBe(testDid);
      expect(comment.issue_url).toContain(`/issues/${issueNum}`);
      expect(comment.performed_via_github_app).toBeNull();
      expect(comment.reactions.total_count).toBe(0);
    });

    it('should include issue status events and return 404 for missing issues', async () => {
      const issueNum = numericId(closedIssueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/timeline`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((entry: any) => entry.event)).toEqual(['closed', 'reopened', 'closed']);

      const seeded = data.find((entry: any) => entry.id === numericId(issueEventRecId));
      expect(seeded).toBeDefined();
      expect(seeded.reason).toBe('Fixed before import');
      expect(seeded.actor.login).toBe(testDid);
      expect(seeded.issue).toBeUndefined();
      expect(seeded.performed_via_github_app).toBeNull();

      const missingRes = await handleShimRequest(ctx, repoUrl('/issues/999/timeline'));
      expect(missingRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/PATCH/DELETE /repos/:did/:repo/issues/comments{/:id}
  // =========================================================================

  describe('repository issue comment endpoints', () => {
    it('should list issue comments across the repository', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/comments'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBeGreaterThanOrEqual(2);
      expect(data.map((comment: any) => comment.body)).toContain('I can reproduce this.');
      expect(data[0].url).toContain('/issues/comments/');
    });

    it('should get, update, and delete an issue comment by ID', async () => {
      const issueNum = numericId(issueRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Temporary comment for ID routes.',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const getRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).body).toBe('Temporary comment for ID routes.');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'PATCH', {
        body: 'Updated temporary comment.',
      });
      expect(updateRes.status).toBe(200);
      expect(parse(updateRes).body).toBe('Updated temporary comment.');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`));
      expect(missingRes.status).toBe(404);
    });

    it('should pin and unpin an issue comment', async () => {
      const issueNum = numericId(issueRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Pinned comment fixture.',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.pin).toBeNull();

      const pinRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}/pin`), 'PUT');
      expect(pinRes.status).toBe(200);
      const pinned = parse(pinRes);
      expect(pinned.pin.pinned_at).toBeDefined();
      expect(pinned.pin.pinned_by.login).toBe(testDid);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`), 'PATCH', {
        body: 'Pinned comment fixture, edited.',
      });
      expect(updateRes.status).toBe(200);
      expect(parse(updateRes).pin.pinned_by.login).toBe(testDid);

      const unpinRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}/pin`), 'DELETE');
      expect(unpinRes.status).toBe(204);
      expect(unpinRes.body).toBe('');

      const getRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${created.id}`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).pin).toBeNull();

      const missingRes = await handleShimRequest(ctx, repoUrl('/issues/comments/999999/pin'), 'PUT');
      expect(missingRes.status).toBe(404);
    });

    it('should reject issue comment updates without a body', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/comments/123'), 'PATCH', {});
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('body');
    });

    it('should return 404 for missing issue comments', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/comments/999'));
      expect(res.status).toBe(404);
    });

    it('should create, list, filter, and delete issue comment reactions', async () => {
      const issueNum = numericId(issueRecId);
      const commentRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Comment that will receive reactions.',
      });
      expect(commentRes.status).toBe(201);
      const comment = parse(commentRes);
      expect(comment.reactions.url).toContain(`/issues/comments/${comment.id}/reactions`);

      const emptyRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`));
      expect(emptyRes.status).toBe(200);
      expect(parse(emptyRes)).toEqual([]);

      const createHeartRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(createHeartRes.status).toBe(201);
      const heart = parse(createHeartRes);
      expect(heart.content).toBe('heart');
      expect(heart.user.login).toBe(testDid);

      const createEyesRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`), 'POST', {
        content: 'eyes',
      });
      expect(createEyesRes.status).toBe(201);

      const filteredRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions?content=heart`));
      expect(filteredRes.status).toBe(200);
      expect(parse(filteredRes).map((reaction: any) => reaction.content)).toEqual(['heart']);

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`));
      expect(listRes.status).toBe(200);
      expect(parse(listRes).map((reaction: any) => reaction.content).sort()).toEqual(['eyes', 'heart']);

      const deleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/comments/${comment.id}/reactions/${heart.id}`),
        'DELETE',
      );
      expect(deleteRes.status).toBe(204);

      const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions?content=heart`));
      expect(parse(afterDeleteRes)).toEqual([]);
    });

    it('should return existing issue comment reactions on duplicate creates', async () => {
      const issueNum = numericId(issueRecId);
      const commentRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Duplicate reaction target.',
      });
      const comment = parse(commentRes);

      const firstRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`), 'POST', {
        content: '+1',
      });
      expect(firstRes.status).toBe(201);
      const first = parse(firstRes);

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`), 'POST', {
        content: '+1',
      });
      expect(duplicateRes.status).toBe(200);
      const duplicate = parse(duplicateRes);
      expect(duplicate.id).toBe(first.id);

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`));
      expect(parse(listRes).length).toBe(1);
    });

    it('should reject invalid issue comment reaction content', async () => {
      const issueNum = numericId(issueRecId);
      const commentRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Invalid reaction target.',
      });
      const comment = parse(commentRes);

      const createRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions`), 'POST', {
        content: 'shipit',
      });
      expect(createRes.status).toBe(422);
      expect(parse(createRes).message).toContain('content');

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/comments/${comment.id}/reactions?content=shipit`));
      expect(listRes.status).toBe(422);
      expect(parse(listRes).message).toContain('content');
    });

    it('should return 404 for missing issue comment reactions', async () => {
      const issueNum = numericId(issueRecId);
      const commentRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'Missing reaction target.',
      });
      const comment = parse(commentRes);

      const missingCommentRes = await handleShimRequest(ctx, repoUrl('/issues/comments/999/reactions'));
      expect(missingCommentRes.status).toBe(404);

      const missingReactionRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/comments/${comment.id}/reactions/999`),
        'DELETE',
      );
      expect(missingReactionRes.status).toBe(404);
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
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl('/pulls'));
      const data = parse(res);
      const pr = data[0];
      expect(pr.number).toBe(patchNum);
      expect(pr.head.ref).toBe('feat-x');
      expect(pr.base.ref).toBe('main');
      expect(pr.user.login).toBe(testDid);
      expect(pr.draft).toBe(false);
      expect(pr.diff_url).toContain(`/pulls/${patchNum}.diff`);
      expect(pr.patch_url).toContain(`/pulls/${patchNum}.patch`);
    });

    it('should filter pull requests by head and base branches', async () => {
      const { record } = await ctx.patches.records.create('repo/patch', {
        data            : { title: 'Filtered branch PR', body: 'Uses list filters.' },
        tags            : { status: 'open', baseBranch: 'release/v1', headBranch: 'filter-head', sourceDid: MAINTAINER_DID },
        parentContextId : repoContextId,
      });
      expect(record).toBeDefined();
      const pullNumber = numericId(record!.id);

      const encodedHead = encodeURIComponent(`${MAINTAINER_DID}:filter-head`);
      const encodedBase = encodeURIComponent('release/v1');

      const headRes = await handleShimRequest(ctx, repoUrl(`/pulls?head=${encodedHead}`));
      expect(headRes.status).toBe(200);
      const headMatches = parse(headRes);
      expect(headMatches.some((pull: any) => pull.number === pullNumber)).toBe(true);
      expect(headMatches.every((pull: any) => pull.head.label === `${MAINTAINER_DID}:filter-head`)).toBe(true);

      const bareHeadRes = await handleShimRequest(ctx, repoUrl('/pulls?head=filter-head'));
      expect(bareHeadRes.status).toBe(200);
      expect(parse(bareHeadRes).some((pull: any) => pull.number === pullNumber)).toBe(true);

      const baseRes = await handleShimRequest(ctx, repoUrl(`/pulls?base=${encodedBase}`));
      expect(baseRes.status).toBe(200);
      const baseMatches = parse(baseRes);
      expect(baseMatches.some((pull: any) => pull.number === pullNumber)).toBe(true);
      expect(baseMatches.every((pull: any) => pull.base.ref === 'release/v1')).toBe(true);

      const combinedRes = await handleShimRequest(ctx, repoUrl(`/pulls?head=${encodedHead}&base=${encodedBase}`));
      expect(combinedRes.status).toBe(200);
      expect(parse(combinedRes).map((pull: any) => pull.number)).toEqual([pullNumber]);

      const missRes = await handleShimRequest(ctx, repoUrl(`/pulls?head=${encodeURIComponent(`${MAINTAINER_DID}:other`)}`));
      expect(missRes.status).toBe(200);
      expect(parse(missRes)).toEqual([]);
    });

    it('should sort pull requests by created and updated time', async () => {
      const firstRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'Sort PR one',
        base  : 'sort-target',
        head  : 'sort-one',
      });
      expect(firstRes.status).toBe(201);
      const first = parse(firstRes);

      await new Promise(resolve => setTimeout(resolve, 10));

      const secondRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'Sort PR two',
        base  : 'sort-target',
        head  : 'sort-two',
      });
      expect(secondRes.status).toBe(201);
      const second = parse(secondRes);

      await new Promise(resolve => setTimeout(resolve, 10));

      const updateRes = await handleShimRequest(ctx, repoUrl(`/pulls/${first.number}`), 'PATCH', {
        title: 'Sort PR one updated',
      });
      expect(updateRes.status).toBe(200);

      const createdAscRes = await handleShimRequest(ctx, repoUrl('/pulls?base=sort-target&sort=created&direction=asc'));
      expect(createdAscRes.status).toBe(200);
      expect(parse(createdAscRes).map((pull: any) => pull.number)).toEqual([first.number, second.number]);

      const createdDescRes = await handleShimRequest(ctx, repoUrl('/pulls?base=sort-target&sort=created&direction=desc'));
      expect(createdDescRes.status).toBe(200);
      expect(parse(createdDescRes).map((pull: any) => pull.number)).toEqual([second.number, first.number]);

      const updatedDescRes = await handleShimRequest(ctx, repoUrl('/pulls?base=sort-target&sort=updated&direction=desc'));
      expect(updatedDescRes.status).toBe(200);
      expect(parse(updatedDescRes).map((pull: any) => pull.number)).toEqual([first.number, second.number]);
    });

    it('should honor GitHub pull request body media types', async () => {
      const patchNum = numericId(patchRecId);
      const htmlRes = await handleShimRequest(ctx, repoUrl('/pulls?state=all'), 'GET', {}, null, {
        accept: 'application/vnd.github.html+json',
      });
      expect(htmlRes.status).toBe(200);
      const htmlPull = parse(htmlRes).find((pull: any) => pull.number === patchNum);
      expect(htmlPull.body).toBeUndefined();
      expect(htmlPull.body_text).toBeUndefined();
      expect(htmlPull.body_html).toBe('<p>Implements feature X.</p>');

      const fullRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`), 'GET', {}, null, {
        accept: 'application/vnd.github.full+json',
      });
      expect(fullRes.status).toBe(200);
      const fullPull = parse(fullRes);
      expect(fullPull.body).toBe('Implements feature X.');
      expect(fullPull.body_text).toBe('Implements feature X.');
      expect(fullPull.body_html).toBe('<p>Implements feature X.</p>');
    });

    it('should populate commit and diff stats from revision record', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`));
      const pr = parse(res);
      expect(pr.head.sha).toBe('abc1234567890abcdef1234567890abcdef12345');
      expect(pr.base.sha).toBe('def0987654321fedcba0987654321fedcba09876');
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
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(patchNum);
      expect(data.title).toBe('Add feature X');
      expect(data.body).toBe('Implements feature X.');
    });

    it('should return merged pull detail with correct flags', async () => {
      const mergedNum = numericId(mergedPatchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${mergedNum}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.number).toBe(mergedNum);
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
  // GET /repos/:did/:repo/pulls/:number/commits
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls/:number/commits', () => {
    it('should return revision-backed commit metadata for imported pulls', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/commits`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].sha).toBe('abc1234567890abcdef1234567890abcdef12345');
      expect(data[0].commit.message).toBe('v1: 3 commits');
      expect(data[0].commit.verification.reason).toBe('unsigned');
      expect(data[0].parents[0].sha).toBe('def0987654321fedcba0987654321fedcba09876');
      expect(data[0].url).toContain(`/commits/${data[0].sha}`);
    });

    it('should list real local git commits for pulls with stored commit ranges', async () => {
      const { record: localPatch } = await ctx.patches.records.create('repo/patch', {
        data            : { title: 'Local git PR', body: 'Uses local git commit history.' },
        tags            : { status: 'open', baseBranch: 'main', headBranch: 'local-git-pr', sourceDid: testDid },
        parentContextId : repoContextId,
      });
      expect(localPatch).toBeDefined();

      await ctx.patches.records.create('repo/patch/revision' as any, {
        data: {
          description : 'local git commit range',
          diffStat    : { additions: 1, deletions: 0, filesChanged: 1 },
        },
        tags: {
          headCommit  : gitMainSha,
          baseCommit  : gitBaseSha,
          commitCount : 1,
        },
        parentContextId: localPatch!.contextId ?? '',
      } as any);

      const pullNum = numericId(localPatch!.id);
      const res = await handleShimRequest(
        ctx, repoUrl(`/pulls/${pullNum}/commits?per_page=1`), 'GET', {}, null, shimOptions(),
      );
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].sha).toBe(gitMainSha);
      expect(data[0].commit.message).toBe('Add feature file');
      expect(data[0].commit.tree.sha).toBe(gitTreeSha);
      expect(data[0].parents.map((parent: any) => parent.sha)).toContain(gitBaseSha);

      const pullRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pullNum}`), 'GET', {}, null, shimOptions());
      const pull = parse(pullRes);

      const diffRes = await handleShimRequest(ctx, new URL(pull.diff_url), 'GET', {}, null, shimOptions());
      expect(diffRes.status).toBe(200);
      expect(diffRes.headers['Content-Type']).toBe('application/vnd.github.diff; charset=utf-8');
      expect(bodyBuffer(diffRes).toString('utf-8')).toContain('diff --git a/src/feature.ts b/src/feature.ts');

      const patchRes = await handleShimRequest(ctx, new URL(pull.patch_url), 'GET', {}, null, shimOptions());
      expect(patchRes.status).toBe(200);
      expect(patchRes.headers['Content-Type']).toBe('application/vnd.github.patch; charset=utf-8');
      expect(bodyBuffer(patchRes).toString('utf-8')).toContain('Add feature file');

      const acceptDiffRes = await handleShimRequest(
        ctx,
        repoUrl(`/pulls/${pullNum}`),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.diff' },
      );
      expect(acceptDiffRes.status).toBe(200);
      expect(acceptDiffRes.headers['Content-Type']).toBe('application/vnd.github.diff; charset=utf-8');
      expect(bodyBuffer(acceptDiffRes).toString('utf-8')).toContain('diff --git a/src/feature.ts b/src/feature.ts');

      const acceptPatchRes = await handleShimRequest(
        ctx,
        repoUrl(`/pulls/${pullNum}`),
        'GET',
        {},
        null,
        { ...shimOptions(), accept: 'application/vnd.github.v3.patch' },
      );
      expect(acceptPatchRes.status).toBe(200);
      expect(acceptPatchRes.headers['Content-Type']).toBe('application/vnd.github.patch; charset=utf-8');
      expect(bodyBuffer(acceptPatchRes).toString('utf-8')).toContain('Add feature file');
    });

    it('should return 404 for missing pull request commits', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/commits'));
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/pulls/:number/reviews
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls/:number/reviews', () => {
    it('should return pull request reviews', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should map verdict to GitHub review state', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews`));
      const data = parse(res);
      const approved = data.find((r: any) => r.state === 'APPROVED');
      expect(approved).toBeDefined();
      expect(approved.body).toBe('Looks good to me.');

      const commented = data.find((r: any) => r.state === 'COMMENTED');
      expect(commented).toBeDefined();
      expect(commented.body).toBe('One nit.');
    });

    it('should include GitHub-style review fields', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews`));
      const data = parse(res);
      expect(data[0].user.login).toBe(testDid);
      expect(data[0].submitted_at).toBeDefined();
      expect(data[0].author_association).toBe('OWNER');
      expect(data[0].pull_request_url).toContain(`/pulls/${patchNum}`);
    });

    it('should honor GitHub pull request review body media types', async () => {
      const patchNum = numericId(patchRecId);
      const reviewId = numericId(reviewRecId);
      const listHtmlRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.html+json',
      });
      expect(listHtmlRes.status).toBe(200);
      const approved = parse(listHtmlRes).find((review: any) => review.id === reviewId);
      expect(approved.body).toBeUndefined();
      expect(approved.body_text).toBeUndefined();
      expect(approved.body_html).toBe('<p>Looks good to me.</p>');

      const getFullRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(getFullRes.status).toBe(200);
      const full = parse(getFullRes);
      expect(full.body).toBe('Looks good to me.');
      expect(full.body_text).toBe('Looks good to me.');
      expect(full.body_html).toBe('<p>Looks good to me.</p>');
    });

    it('should return a pull request review by ID', async () => {
      const patchNum = numericId(patchRecId);
      const reviewId = numericId(reviewRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(reviewId);
      expect(data.body).toBe('Looks good to me.');
      expect(data.state).toBe('APPROVED');
      expect(data.commit_id).toBe('abc1234567890abcdef1234567890abcdef12345');
      expect(data._links.pull_request.href).toContain(`/pulls/${patchNum}`);
    });

    it('should update a pull request review body', async () => {
      const patchNum = numericId(patchRecId);
      const reviewId = numericId(reviewRecId);
      const updateRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}`), 'PATCH', {
        body: 'Updated review summary.',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.id).toBe(reviewId);
      expect(updated.body).toBe('Updated review summary.');
      expect(updated.state).toBe('APPROVED');

      const getRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}`));
      expect(parse(getRes).body).toBe('Updated review summary.');

      const invalidRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}`), 'PATCH', {});
      expect(invalidRes.status).toBe(422);
    });

    it('should update a pull request review with the documented PUT method', async () => {
      const createPullRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for PUT review update',
        head  : 'put-review-update',
      });
      expect(createPullRes.status).toBe(201);
      const pr = parse(createPullRes);

      const createReviewRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body  : 'Initial review body.',
        event : 'COMMENT',
      });
      expect(createReviewRes.status).toBe(201);
      const review = parse(createReviewRes);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${review.id}`), 'PUT', {
        body: 'Updated **review**.',
      }, null, {
        accept: 'application/vnd.github-commitcomment.text+json',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBeUndefined();
      expect(updated.body_text).toBe('Updated review.');
      expect(updated.body_html).toBeUndefined();
    });

    it('should list comments for a pull request review', async () => {
      const patchNum = numericId(patchRecId);
      const reviewId = numericId(reviewRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/${reviewId}/comments`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(data[0].id).toBe(numericId(reviewCommentRecId));
      expect(data[0].pull_request_review_id).toBe(reviewId);
      expect(data[0].body).toBe('Please keep this helper small.');
      expect(data[0].path).toBe('src/widget.ts');
      expect(data[0].line).toBe(12);
    });

    it('should return 404 for non-existent pull review detail routes', async () => {
      const patchNum = numericId(patchRecId);
      const detailRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/999`));
      expect(detailRes.status).toBe(404);

      const commentsRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews/999/comments`));
      expect(commentsRes.status).toBe(404);
    });

    it('should return 404 for non-existent pull reviews', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/reviews'));
      expect(res.status).toBe(404);
    });

    it('should support pagination', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/reviews?per_page=1`));
      const data = parse(res);
      expect(data.length).toBe(1);
      expect(res.headers['Link']).toBeDefined();
    });
  });

  // =========================================================================
  // GET/POST /repos/:did/:repo/pulls/:number/comments
  // =========================================================================

  describe('pull request review comment endpoints', () => {
    it('should list pull request review comments across the repository', async () => {
      const patchNum = numericId(patchRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : 'Repository-level review comment.',
        path      : 'src/repo-list.ts',
        line      : 8,
        side      : 'RIGHT',
        diff_hunk : '@@ -4 +8 @@',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const pagedRes = await handleShimRequest(ctx, repoUrl('/pulls/comments?per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes).length).toBe(1);
      expect(pagedRes.headers['Link']).toBeDefined();

      const res = await handleShimRequest(ctx, repoUrl('/pulls/comments'));
      expect(res.status).toBe(200);
      const data = parse(res);
      const seeded = data.find((comment: any) => comment.id === numericId(reviewCommentRecId));
      const extra = data.find((comment: any) => comment.id === created.id);
      expect(seeded).toBeDefined();
      expect(seeded.pull_request_url).toContain(`/pulls/${patchNum}`);
      expect(extra).toBeDefined();
      expect(extra.path).toBe('src/repo-list.ts');
      expect(extra.pull_request_review_id).toBe(created.pull_request_review_id);
    });

    it('should sort and filter repository pull request review comments', async () => {
      const sortedRes = await handleShimRequest(ctx, repoUrl('/pulls/comments?sort=created&direction=desc'));
      expect(sortedRes.status).toBe(200);
      const sorted = parse(sortedRes);
      expect(sorted.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < sorted.length; i++) {
        expect(Date.parse(sorted[i - 1].created_at)).toBeGreaterThanOrEqual(Date.parse(sorted[i].created_at));
      }

      const futureRes = await handleShimRequest(ctx, repoUrl('/pulls/comments?since=2999-01-01T00:00:00Z'));
      expect(futureRes.status).toBe(200);
      expect(parse(futureRes)).toEqual([]);
    });

    it('should list pull request review comments', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.length).toBeGreaterThanOrEqual(1);
      const seeded = data.find((comment: any) => comment.id === numericId(reviewCommentRecId));
      expect(seeded.pull_request_review_id).toBe(numericId(reviewRecId));
      expect(seeded.path).toBe('src/widget.ts');
      expect(seeded.line).toBe(12);
      expect(seeded.side).toBe('RIGHT');
      expect(seeded.body).toBe('Please keep this helper small.');
    });

    it('should return a pull request review comment by ID', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${numericId(reviewCommentRecId)}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(numericId(reviewCommentRecId));
      expect(data.diff_hunk).toBe('@@ -1 +1 @@');
      expect(data.pull_request_url).toContain(`/pulls/${numericId(patchRecId)}`);
      expect(data._links.pull_request.href).toContain(`/pulls/${numericId(patchRecId)}`);
    });

    it('should update and delete a pull request review comment by ID', async () => {
      const patchNum = numericId(patchRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : 'Temporary review comment.',
        path      : 'src/widget.ts',
        line      : 20,
        side      : 'RIGHT',
        diff_hunk : '@@ -18 +20 @@',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`), 'PATCH', {
        body: 'Updated temporary review comment.',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBe('Updated temporary review comment.');
      expect(updated.path).toBe('src/widget.ts');
      expect(updated.line).toBe(20);
      expect(updated.diff_hunk).toBe('@@ -18 +20 @@');

      const getRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`));
      expect(parse(getRes).body).toBe('Updated temporary review comment.');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`));
      expect(missingRes.status).toBe(404);
    });

    it('should honor GitHub pull review comment body media types', async () => {
      const patchNum = numericId(patchRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : '**Review** and `code`.',
        path      : 'src/widget.ts',
        line      : 22,
        side      : 'RIGHT',
        diff_hunk : '@@ -20 +22 @@',
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.body).toBe('**Review** and `code`.');
      expect(created.body_text).toBe('Review and code.');
      expect(created.body_html).toBe('<p><strong>Review</strong> and <code>code</code>.</p>');

      const listTextRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.text+json',
      });
      expect(listTextRes.status).toBe(200);
      const listed = parse(listTextRes).find((comment: any) => comment.id === created.id);
      expect(listed.body).toBeUndefined();
      expect(listed.body_text).toBe('Review and code.');

      const getHtmlRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.v3.html+json',
      });
      expect(getHtmlRes.status).toBe(200);
      const html = parse(getHtmlRes);
      expect(html.body).toBeUndefined();
      expect(html.body_html).toBe('<p><strong>Review</strong> and <code>code</code>.</p>');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`), 'PATCH', {
        body: 'Updated **review**.',
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBe('Updated **review**.');
      expect(updated.body_text).toBe('Updated review.');
      expect(updated.body_html).toBe('<p>Updated <strong>review</strong>.</p>');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
    });

    it('should create, list, filter, de-duplicate, and delete pull request review comment reactions', async () => {
      const patchNum = numericId(patchRecId);
      const createCommentRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : 'Review comment that will receive reactions.',
        path      : 'src/widget.ts',
        line      : 24,
        side      : 'RIGHT',
        diff_hunk : '@@ -22 +24 @@',
      });
      expect(createCommentRes.status).toBe(201);
      const comment = parse(createCommentRes);

      const emptyRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`));
      expect(emptyRes.status).toBe(200);
      expect(parse(emptyRes)).toEqual([]);

      const createHeartRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(createHeartRes.status).toBe(201);
      const heart = parse(createHeartRes);
      expect(heart.content).toBe('heart');
      expect(heart.user.login).toBe(testDid);
      expect(typeof heart.created_at).toBe('string');

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(duplicateRes.status).toBe(200);
      expect(parse(duplicateRes).id).toBe(heart.id);

      const createRocketRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`), 'POST', {
        content: 'rocket',
      });
      expect(createRocketRes.status).toBe(201);

      const filteredRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions?content=heart`));
      expect(filteredRes.status).toBe(200);
      expect(parse(filteredRes).map((reaction: any) => reaction.content)).toEqual(['heart']);

      const listRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`));
      expect(listRes.status).toBe(200);
      expect(parse(listRes).map((reaction: any) => reaction.content).sort()).toEqual(['heart', 'rocket']);

      const deleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/pulls/comments/${comment.id}/reactions/${heart.id}`),
        'DELETE',
      );
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions?content=heart`));
      expect(afterDeleteRes.status).toBe(200);
      expect(parse(afterDeleteRes)).toEqual([]);
    });

    it('should create a pull request review comment', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body       : 'Please add a regression test.',
        path       : 'src/widget.ts',
        start_line : 16,
        start_side : 'RIGHT',
        line       : 18,
        side       : 'RIGHT',
        diff_hunk  : '@@ -10 +18 @@',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('Please add a regression test.');
      expect(data.path).toBe('src/widget.ts');
      expect(data.start_line).toBe(16);
      expect(data.original_start_line).toBe(16);
      expect(data.start_side).toBe('RIGHT');
      expect(data.line).toBe(18);
      expect(data.side).toBe('RIGHT');
      expect(data.subject_type).toBe('line');

      const listRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`));
      const comments = parse(listRes);
      expect(comments.find((comment: any) => comment.body === 'Please add a regression test.')).toBeDefined();
    });

    it('should create file-level pull request review comments', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body         : 'This whole file should be simpler.',
        path         : 'src/widget.ts',
        subject_type : 'file',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('This whole file should be simpler.');
      expect(data.path).toBe('src/widget.ts');
      expect(data.subject_type).toBe('file');
      expect(data.line).toBeNull();
      expect(data.original_line).toBeNull();
      expect(data.start_line).toBeNull();
      expect(data.start_side).toBeNull();

      const getRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${data.id}`));
      expect(parse(getRes).subject_type).toBe('file');
    });

    it('should create pull request review comment replies', async () => {
      const patchNum = numericId(patchRecId);
      const createCommentRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : 'Top-level review thread.',
        path      : 'src/widget.ts',
        line      : 28,
        side      : 'RIGHT',
        diff_hunk : '@@ -26 +28 @@',
      });
      expect(createCommentRes.status).toBe(201);
      const parent = parse(createCommentRes);

      const replyRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments/${parent.id}/replies`), 'POST', {
        body: 'Reply through the replies endpoint.',
      });
      expect(replyRes.status).toBe(201);
      const reply = parse(replyRes);
      expect(reply.body).toBe('Reply through the replies endpoint.');
      expect(reply.in_reply_to_id).toBe(parent.id);
      expect(reply.path).toBe('src/widget.ts');
      expect(reply.line).toBe(28);
      expect(reply.pull_request_review_id).toBe(parent.pull_request_review_id);

      const inlineReplyRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body        : 'Reply through in_reply_to.',
        in_reply_to : parent.id,
      }, null, {
        accept: 'application/vnd.github-commitcomment.text+json',
      });
      expect(inlineReplyRes.status).toBe(201);
      const inlineReply = parse(inlineReplyRes);
      expect(inlineReply.body).toBeUndefined();
      expect(inlineReply.body_text).toBe('Reply through in_reply_to.');
      expect(inlineReply.in_reply_to_id).toBe(parent.id);

      const listRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`));
      const listedReply = parse(listRes).find((comment: any) => comment.id === reply.id);
      expect(listedReply.in_reply_to_id).toBe(parent.id);

      const getReplyRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${reply.id}`));
      expect(parse(getReplyRes).in_reply_to_id).toBe(parent.id);

      const nestedReplyRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments/${reply.id}/replies`), 'POST', {
        body: 'Nested reply.',
      });
      expect(nestedReplyRes.status).toBe(422);

      const missingBodyRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments/${parent.id}/replies`), 'POST', {});
      expect(missingBodyRes.status).toBe(422);

      const wrongPullRes = await handleShimRequest(ctx, repoUrl(`/pulls/999/comments/${parent.id}/replies`), 'POST', {
        body: 'Wrong pull.',
      });
      expect(wrongPullRes.status).toBe(404);

      const missingParentRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments/999/replies`), 'POST', {
        body: 'Missing parent.',
      });
      expect(missingParentRes.status).toBe(404);
    });

    it('should reject review comments without required fields', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body: 'Missing location.',
      });
      expect(res.status).toBe(422);
    });

    it('should reject review comment updates without a body', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${numericId(reviewCommentRecId)}`), 'PATCH', {});
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('body');
    });

    it('should return 404 for non-existent pull request review comments', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/comments'));
      expect(res.status).toBe(404);
    });

    it('should validate pull request review comment reactions and missing reaction targets', async () => {
      const patchNum = numericId(patchRecId);
      const createCommentRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/comments`), 'POST', {
        body      : 'Invalid review reaction target.',
        path      : 'src/widget.ts',
        line      : 26,
        side      : 'RIGHT',
        diff_hunk : '@@ -24 +26 @@',
      });
      expect(createCommentRes.status).toBe(201);
      const comment = parse(createCommentRes);

      const invalidCreateRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions`), 'POST', {
        content: 'shipit',
      });
      expect(invalidCreateRes.status).toBe(422);
      expect(parse(invalidCreateRes).message).toContain('content');

      const invalidFilterRes = await handleShimRequest(ctx, repoUrl(`/pulls/comments/${comment.id}/reactions?content=shipit`));
      expect(invalidFilterRes.status).toBe(422);
      expect(parse(invalidFilterRes).message).toContain('content');

      const missingCommentRes = await handleShimRequest(ctx, repoUrl('/pulls/comments/999/reactions'));
      expect(missingCommentRes.status).toBe(404);

      const missingReactionRes = await handleShimRequest(
        ctx,
        repoUrl(`/pulls/comments/${comment.id}/reactions/999`),
        'DELETE',
      );
      expect(missingReactionRes.status).toBe(404);
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
      expect(stable.immutable).toBe(false);
      expect(stable.author.login).toBe(testDid);
      expect(stable.assets).toHaveLength(1);
      expect(stable.assets[0].name).toBe(RELEASE_ASSET_NAME);
      expect(stable.assets[0].digest).toBe(RELEASE_ASSET_DIGEST);
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
  // GET /repos/:did/:repo/releases/latest
  // =========================================================================

  describe('GET /repos/:did/:repo/releases/latest', () => {
    it('should return the latest published full release', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases/latest'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.tag_name).toBe('v1.0.0');
      expect(data.prerelease).toBe(false);
      expect(data.draft).toBe(false);
      expect(data.assets).toHaveLength(1);
      expect(data.assets[0].name).toBe(RELEASE_ASSET_NAME);
    });

    it('should return 404 when no published full release exists', async () => {
      const { record: repoRec } = await ctx.repo.records.create('repo', {
        data : { name: 'preonly-repo', description: 'Only prereleases', defaultBranch: 'main', dwnEndpoints: [] },
        tags : { name: 'preonly-repo', visibility: 'public' },
      });

      await ctx.releases.records.create('repo/release' as any, {
        data            : { name: 'v0.1.0-beta', body: 'Beta only.' },
        tags            : { tagName: 'v0.1.0-beta', prerelease: true },
        parentContextId : repoRec!.contextId ?? '',
      } as any);

      const res = await handleShimRequest(ctx, url(`/repos/${testDid}/preonly-repo/releases/latest`));
      expect(res.status).toBe(404);
      expect(parse(res).message).toContain('Latest release not found');
    });

    it('should honor explicit make_latest settings', async () => {
      let releaseId: number | undefined;

      try {
        const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : 'v-make-latest-false',
          name        : 'Make Latest False',
          make_latest : 'false',
        });
        expect(createRes.status).toBe(201);
        const created = parse(createRes);
        releaseId = created.id;

        const initialLatest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
        expect(initialLatest.tag_name).toBe('v1.0.0');

        const pinRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          make_latest: 'true',
        });
        expect(pinRes.status).toBe(200);

        const pinnedLatest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
        expect(pinnedLatest.tag_name).toBe('v-make-latest-false');

        const unpinRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          make_latest: 'false',
        });
        expect(unpinRes.status).toBe(200);

        const restoredLatest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
        expect(restoredLatest.tag_name).toBe('v1.0.0');
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should use semantic version ordering for legacy latest releases', async () => {
      const releaseIds: number[] = [];

      try {
        const highRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : 'v20.0.0',
          name        : 'Legacy High Semver',
          make_latest : 'legacy',
        });
        expect(highRes.status).toBe(201);
        releaseIds.push(parse(highRes).id);

        const lowRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : 'v19.0.0',
          name        : 'Legacy Low Semver',
          make_latest : 'legacy',
        });
        expect(lowRes.status).toBe(201);
        releaseIds.push(parse(lowRes).id);

        const latest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
        expect(latest.tag_name).toBe('v20.0.0');
      } finally {
        for (const releaseId of releaseIds) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should reject invalid make_latest values and draft or prerelease latest pins', async () => {
      const invalidValue = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name    : 'v-make-latest-invalid',
        make_latest : 'newest',
      });
      expect(invalidValue.status).toBe(422);
      expect(parse(invalidValue).message).toContain('make_latest');

      const draftPin = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name    : 'v-draft-latest',
        draft       : true,
        make_latest : 'true',
      });
      expect(draftPin.status).toBe(422);
      expect(parse(draftPin).message).toContain('latest');

      const prereleasePin = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name    : 'v-prerelease-latest',
        prerelease  : true,
        make_latest : 'true',
      });
      expect(prereleasePin.status).toBe(422);

      const invalidPatch = await handleShimRequest(ctx, repoUrl(`/releases/${numericId(releaseRecId)}`), 'PATCH', {
        make_latest: 'newest',
      });
      expect(invalidPatch.status).toBe(422);
      expect(parse(invalidPatch).message).toContain('make_latest');
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/releases/:id and release assets
  // =========================================================================

  describe('GET /repos/:did/:repo/releases/:id and assets', () => {
    it('should return release detail by numeric ID', async () => {
      const releaseId = numericId(releaseRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(releaseId);
      expect(data.tag_name).toBe('v1.0.0');
      expect(data.assets).toHaveLength(1);
      expect(data.assets[0].id).toBe(numericId(releaseAssetRecId));
    });

    it('should create, list, filter, de-duplicate, and delete release reactions', async () => {
      let releaseId: number | undefined;

      try {
        const createReleaseRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : 'v-release-reactions',
          name        : 'Release Reactions',
          make_latest : 'false',
        });
        expect(createReleaseRes.status).toBe(201);
        const release = parse(createReleaseRes);
        releaseId = release.id;

        const emptyRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`));
        expect(emptyRes.status).toBe(200);
        expect(parse(emptyRes)).toEqual([]);

        const createHeartRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`), 'POST', {
          content: 'heart',
        });
        expect(createHeartRes.status).toBe(201);
        const heart = parse(createHeartRes);
        expect(heart.content).toBe('heart');
        expect(heart.user.login).toBe(testDid);
        expect(typeof heart.created_at).toBe('string');

        const duplicateRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`), 'POST', {
          content: 'heart',
        });
        expect(duplicateRes.status).toBe(200);
        expect(parse(duplicateRes).id).toBe(heart.id);

        const createRocketRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`), 'POST', {
          content: 'rocket',
        });
        expect(createRocketRes.status).toBe(201);

        const filteredRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions?content=heart`));
        expect(filteredRes.status).toBe(200);
        expect(parse(filteredRes).map((reaction: any) => reaction.content)).toEqual(['heart']);

        const listRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`));
        expect(listRes.status).toBe(200);
        expect(parse(listRes).map((reaction: any) => reaction.content).sort()).toEqual(['heart', 'rocket']);

        const deleteRes = await handleShimRequest(
          ctx,
          repoUrl(`/releases/${release.id}/reactions/${heart.id}`),
          'DELETE',
        );
        expect(deleteRes.status).toBe(204);
        expect(deleteRes.body).toBe('');

        const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions?content=heart`));
        expect(afterDeleteRes.status).toBe(200);
        expect(parse(afterDeleteRes)).toEqual([]);
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should validate release reactions and missing reaction targets', async () => {
      let releaseId: number | undefined;

      try {
        const createReleaseRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : 'v-invalid-release-reactions',
          name        : 'Invalid Release Reactions',
          make_latest : 'false',
        });
        expect(createReleaseRes.status).toBe(201);
        const release = parse(createReleaseRes);
        releaseId = release.id;

        const invalidCreateRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions`), 'POST', {
          content: '-1',
        });
        expect(invalidCreateRes.status).toBe(422);
        expect(parse(invalidCreateRes).message).toContain('content');

        const invalidFilterRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/reactions?content=confused`));
        expect(invalidFilterRes.status).toBe(422);
        expect(parse(invalidFilterRes).message).toContain('content');

        const missingReleaseRes = await handleShimRequest(ctx, repoUrl('/releases/999/reactions'));
        expect(missingReleaseRes.status).toBe(404);

        const missingReactionRes = await handleShimRequest(
          ctx,
          repoUrl(`/releases/${release.id}/reactions/999`),
          'DELETE',
        );
        expect(missingReactionRes.status).toBe(404);
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should reflect repository immutable release settings in release responses', async () => {
      const releaseId = numericId(releaseRecId);
      let createdReleaseId: number | undefined;

      try {
        const enableRes = await handleShimRequest(ctx, repoUrl('/immutable-releases'), 'PUT');
        expect(enableRes.status).toBe(204);

        const releases = parse(await handleShimRequest(ctx, repoUrl('/releases')));
        const listed = releases.find((release: any) => release.tag_name === 'v1.0.0');
        expect(listed.immutable).toBe(true);

        const latest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
        expect(latest.tag_name).toBe('v1.0.0');
        expect(latest.immutable).toBe(true);

        const detail = parse(await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`)));
        expect(detail.immutable).toBe(true);

        const byTag = parse(await handleShimRequest(ctx, repoUrl('/releases/tags/v1.0.0')));
        expect(byTag.immutable).toBe(true);

        const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name : 'v-immutable-setting-test',
          name     : 'Immutable Setting Test',
          draft    : true,
        });
        expect(createRes.status).toBe(201);
        const created = parse(createRes);
        createdReleaseId = created.id;
        expect(created.immutable).toBe(true);

        const updateRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          name: 'Immutable Setting Test Updated',
        });
        expect(updateRes.status).toBe(200);
        expect(parse(updateRes).immutable).toBe(true);
      } finally {
        await handleShimRequest(ctx, repoUrl('/immutable-releases'), 'DELETE');
        if (createdReleaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${createdReleaseId}`), 'DELETE');
        }
      }

      const afterDisable = parse(await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`)));
      expect(afterDisable.immutable).toBe(false);
    });

    it('should list release assets', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/releases/${numericId(releaseRecId)}/assets`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(numericId(releaseAssetRecId));
      expect(data[0].name).toBe(RELEASE_ASSET_NAME);
      expect(data[0].content_type).toBe('application/gzip');
      expect(data[0].size).toBe(RELEASE_ASSET_BYTES.byteLength);
      expect(data[0].digest).toBe(RELEASE_ASSET_DIGEST);
      expect(data[0].browser_download_url).toContain(`/releases/download/v1.0.0/${RELEASE_ASSET_NAME}`);
    });

    it('should paginate release assets', async () => {
      const releaseId = numericId(releaseRecId);
      const createdAssetIds: number[] = [];
      const assetBytes = Buffer.from('pagination asset bytes\n', 'utf-8');
      const firstName = `paged-${releaseId}-1.zip`;
      const secondName = `paged-${releaseId}-2.zip`;

      try {
        for (const name of [firstName, secondName]) {
          const uploadRes = await handleShimRequest(
            ctx,
            repoUrl(`/releases/${releaseId}/assets?name=${name}`),
            'POST',
            {},
            null,
            { rawBody: assetBytes, contentType: 'application/zip' },
          );
          expect(uploadRes.status).toBe(201);
          createdAssetIds.push(parse(uploadRes).id);
        }

        const firstPageRes = await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}/assets?per_page=1`));
        expect(firstPageRes.status).toBe(200);
        expect(parse(firstPageRes)).toHaveLength(1);
        expect(firstPageRes.headers.Link).toContain('rel="next"');
        expect(firstPageRes.headers.Link).toContain('page=3&per_page=1');

        const secondPageRes = await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}/assets?page=2&per_page=1`));
        expect(secondPageRes.status).toBe(200);
        const secondPage = parse(secondPageRes);
        expect(secondPage).toHaveLength(1);
        expect(secondPage[0].name).toBe(firstName);
        expect(secondPageRes.headers.Link).toContain('rel="prev"');
        expect(secondPageRes.headers.Link).toContain('rel="next"');

        const thirdPageRes = await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}/assets?page=3&per_page=1`));
        expect(thirdPageRes.status).toBe(200);
        const thirdPage = parse(thirdPageRes);
        expect(thirdPage).toHaveLength(1);
        expect(thirdPage[0].name).toBe(secondName);
        expect(thirdPageRes.headers.Link).toContain('rel="first"');
        expect(thirdPageRes.headers.Link).toContain('rel="prev"');
      } finally {
        for (const assetId of createdAssetIds) {
          await handleShimRequest(ctx, repoUrl(`/releases/assets/${assetId}`), 'DELETE');
        }
      }
    });

    it('should return release asset metadata by asset ID', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/releases/assets/${numericId(releaseAssetRecId)}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe(RELEASE_ASSET_NAME);
      expect(data.state).toBe('uploaded');
      expect(data.digest).toBe(RELEASE_ASSET_DIGEST);
      expect(data.uploader.login).toBe(testDid);
    });

    it('should download release asset bytes from the asset endpoint with octet-stream accept', async () => {
      const res = await handleShimRequest(
        ctx,
        repoUrl(`/releases/assets/${numericId(releaseAssetRecId)}`),
        'GET',
        {},
        null,
        { accept: 'application/octet-stream' },
      );
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/gzip');
      expect(res.headers['Content-Length']).toBe(String(RELEASE_ASSET_BYTES.byteLength));
      expect(res.headers['Content-Disposition']).toBe(`attachment; filename="${RELEASE_ASSET_NAME}"`);
      expect(res.headers['X-GitHub-Asset-Url']).toContain(`/releases/assets/${numericId(releaseAssetRecId)}`);
      expect(bodyBuffer(res).toString('utf-8')).toBe(RELEASE_ASSET_BYTES.toString('utf-8'));
    });

    it('should download release asset bytes by asset ID', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/releases/assets/${numericId(releaseAssetRecId)}/download`));
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/gzip');
      expect(Buffer.from(res.body as Uint8Array).toString('utf-8')).toBe(RELEASE_ASSET_BYTES.toString('utf-8'));
    });

    it('should download release asset bytes by tag and filename', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/releases/download/v1.0.0/${RELEASE_ASSET_NAME}`));
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/gzip');
      expect(Buffer.from(res.body as Uint8Array).toString('utf-8')).toBe(RELEASE_ASSET_BYTES.toString('utf-8'));
    });

    it('should return 404 for missing release assets', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases/assets/999/download'));
      expect(res.status).toBe(404);
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

    it('should return release by URL-encoded tag name', async () => {
      const tagName = 'release/channel/v1';
      let releaseId: number | undefined;

      try {
        const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name    : tagName,
          name        : 'Encoded Tag Release',
          make_latest : 'false',
        });
        expect(createRes.status).toBe(201);
        releaseId = parse(createRes).id;

        const res = await handleShimRequest(ctx, repoUrl(`/releases/tags/${encodeURIComponent(tagName)}`));
        expect(res.status).toBe(200);
        const data = parse(res);
        expect(data.tag_name).toBe(tagName);
        expect(data.name).toBe('Encoded Tag Release');
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
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
      expect(typeof data.number).toBe('number');
      expect(data.number).toBeGreaterThan(0);
      expect(data.user.login).toBe(testDid);
    });

    it('should assign a numericId derived from record ID', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Another shim issue',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(typeof data.number).toBe('number');
      expect(data.number).toBeGreaterThan(0);
    });

    it('should create an issue with assignees', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title     : 'Assigned shim issue',
        assignees : [MAINTAINER_DID],
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.assignee.login).toBe(MAINTAINER_DID);
      expect(data.assignees.map((user: any) => user.login)).toEqual([MAINTAINER_DID]);
    });

    it('should reject issue creation with more than ten assignees', async () => {
      const assignees = Array.from({ length: 11 }, (_, index) => `did:jwk:create-assignee-${index}`);
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Too many assignees',
        assignees,
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('10 assignees');
    });

    it('should create an issue with labels', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title  : 'Labeled shim issue',
        labels : [{ name: 'bug', color: 'd73a4a', description: 'Bug reports' }],
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.labels.map((label: any) => label.name)).toEqual(['bug']);
    });

    it('should create an issue with a milestone number', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title     : 'Milestoned shim issue',
        milestone : githubMilestoneNumber(MILESTONE_TITLE),
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.milestone.title).toBe(MILESTONE_TITLE);
      expect(data.milestone.number).toBe(githubMilestoneNumber(MILESTONE_TITLE));
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
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`), 'PATCH', {
        title: 'Fix the widget (updated)',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.title).toBe('Fix the widget (updated)');
      expect(data.number).toBe(issueNum);
    });

    it('should close an issue by setting state=closed', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`), 'PATCH', {
        state: 'closed',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('closed');
    });

    it('should reopen an issue by setting state=open', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`), 'PATCH', {
        state: 'open',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('open');
    });

    it('should replace issue assignees', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title     : 'Assignment replacement target',
        assignees : [MAINTAINER_DID],
      });
      const created = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/issues/${created.number}`), 'PATCH', {
        assignees: [TRIAGER_DID],
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.assignee.login).toBe(TRIAGER_DID);
      expect(data.assignees.map((user: any) => user.login)).toEqual([TRIAGER_DID]);
    });

    it('should reject issue updates with more than ten assignees', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Assignee overflow update target',
      });
      const created = parse(createRes);
      const assignees = Array.from({ length: 11 }, (_, index) => `did:jwk:update-assignee-${index}`);

      const res = await handleShimRequest(ctx, repoUrl(`/issues/${created.number}`), 'PATCH', {
        title: 'Should not update over limit',
        assignees,
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('10 assignees');

      const afterRes = await handleShimRequest(ctx, repoUrl(`/issues/${created.number}`));
      const after = parse(afterRes);
      expect(after.title).toBe('Assignee overflow update target');
      expect(after.assignees).toEqual([]);
    });

    it('should set and clear issue milestones', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Milestone update target',
      });
      const created = parse(createRes);
      expect(created.milestone).toBeNull();

      const setRes = await handleShimRequest(ctx, repoUrl(`/issues/${created.number}`), 'PATCH', {
        milestone: githubMilestoneNumber(MILESTONE_TITLE),
      });
      expect(setRes.status).toBe(200);
      const setData = parse(setRes);
      expect(setData.milestone.title).toBe(MILESTONE_TITLE);

      const clearRes = await handleShimRequest(ctx, repoUrl(`/issues/${created.number}`), 'PATCH', {
        milestone: null,
      });
      expect(clearRes.status).toBe(200);
      expect(parse(clearRes).milestone).toBeNull();
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
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {
        body: 'New comment via shim.',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('New comment via shim.');
      expect(data.user.login).toBe(testDid);
      expect(data.issue_url).toContain(`/issues/${issueNum}`);
      expect(data.author_association).toBe('OWNER');
    });

    it('should return 422 when body is missing', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/comments`), 'POST', {});
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
  // GET /repos/:did/:repo/issues/events
  // =========================================================================

  describe('issue event endpoints', () => {
    it('should list issue events across the repository with pagination', async () => {
      const pagedRes = await handleShimRequest(ctx, repoUrl('/issues/events?per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes)).toHaveLength(1);
      expect(pagedRes.headers['Link']).toContain('rel="next"');

      const res = await handleShimRequest(ctx, repoUrl('/issues/events'));
      expect(res.status).toBe(200);
      const data = parse(res);
      const seeded = data.find((event: any) => event.id === numericId(issueEventRecId));
      expect(seeded).toBeDefined();
      expect(seeded.event).toBe('closed');
      expect(seeded.reason).toBe('Fixed before import');
      expect(seeded.actor.login).toBe(testDid);
      expect(seeded.issue.number).toBe(numericId(closedIssueRecId));
      expect(seeded.issue.events_url).toContain(`/issues/${numericId(closedIssueRecId)}/events`);
    });

    it('should return a single issue event by ID', async () => {
      const res = await handleShimRequest(ctx, repoUrl(`/issues/events/${numericId(issueEventRecId)}`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.id).toBe(numericId(issueEventRecId));
      expect(data.url).toContain(`/issues/events/${numericId(issueEventRecId)}`);
      expect(data.event).toBe('closed');
      expect(data.commit_id).toBeNull();
      expect(data.commit_url).toBeNull();
    });

    it('should list events for a single issue', async () => {
      const issueNum = numericId(closedIssueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/events`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((event: any) => event.event)).toEqual(['closed', 'reopened', 'closed']);
      expect(data.every((event: any) => event.issue.number === issueNum)).toBe(true);
    });

    it('should record issue state changes made through the shim', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Eventful issue',
      });
      expect(createRes.status).toBe(201);
      const issue = parse(createRes);

      const closeRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`), 'PATCH', {
        state        : 'closed',
        state_reason : 'completed',
      });
      expect(closeRes.status).toBe(200);

      const reopenRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}`), 'PATCH', {
        state: 'open',
      });
      expect(reopenRes.status).toBe(200);

      const eventsRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/events`));
      expect(eventsRes.status).toBe(200);
      const events = parse(eventsRes);
      expect(events.map((event: any) => event.event)).toEqual(['closed', 'reopened']);
      expect(events[0].reason).toBe('completed');
    });

    it('should return 404 for missing issue events and missing issue routes', async () => {
      const missingEventRes = await handleShimRequest(ctx, repoUrl('/issues/events/999'));
      expect(missingEventRes.status).toBe(404);

      const missingIssueRes = await handleShimRequest(ctx, repoUrl('/issues/999/events'));
      expect(missingIssueRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/labels
  // =========================================================================

  describe('repository label endpoints', () => {
    it('should list repository labels with pagination', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/labels'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.map((label: any) => label.name)).toEqual(['bug', 'enhancement']);
      expect(data[0].color).toBe('d73a4a');
      expect(data[0].description).toBe('Bug reports');
      expect(data[0].url).toContain('/labels/bug');

      const pagedRes = await handleShimRequest(ctx, repoUrl('/labels?per_page=1'));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes)).toHaveLength(1);
      expect(pagedRes.headers['Link']).toContain('rel="next"');
    });

    it('should return a repository label by name', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/labels/enhancement'));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.name).toBe('enhancement');
      expect(data.color).toBe('a2eeef');
      expect(data.description).toBe('New feature or request');
    });

    it('should create, update, and delete repository labels', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/labels'), 'POST', {
        name        : 'ops',
        color       : '#5319e7',
        description : 'Operations work',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.name).toBe('ops');
      expect(created.color).toBe('5319e7');
      expect(created.description).toBe('Operations work');

      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Issue with managed repo label',
      });
      expect(issueRes.status).toBe(201);
      const issue = parse(issueRes);

      const addLabelRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/labels`), 'POST', {
        labels: [{ name: 'ops', color: '5319e7', description: 'Operations work' }],
      });
      expect(addLabelRes.status).toBe(200);
      expect(parse(addLabelRes).map((label: any) => label.name)).toEqual(['ops']);

      const updateRes = await handleShimRequest(ctx, repoUrl('/labels/ops'), 'PATCH', {
        new_name    : 'operations',
        color       : '0052cc',
        description : null,
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.name).toBe('operations');
      expect(updated.color).toBe('0052cc');
      expect(updated.description).toBeNull();

      const issueLabelsRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/labels`));
      expect(issueLabelsRes.status).toBe(200);
      const issueLabels = parse(issueLabelsRes);
      expect(issueLabels.map((label: any) => label.name)).toEqual(['operations']);
      expect(issueLabels[0].color).toBe('0052cc');

      const oldLabelRes = await handleShimRequest(ctx, repoUrl('/labels/ops'));
      expect(oldLabelRes.status).toBe(404);

      const deleteRes = await handleShimRequest(ctx, repoUrl('/labels/operations'), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const deletedLabelRes = await handleShimRequest(ctx, repoUrl('/labels/operations'));
      expect(deletedLabelRes.status).toBe(404);

      const finalIssueLabelsRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/labels`));
      expect(finalIssueLabelsRes.status).toBe(200);
      expect(parse(finalIssueLabelsRes)).toEqual([]);
    });

    it('should reject duplicate or invalid repository label payloads', async () => {
      const duplicateRes = await handleShimRequest(ctx, repoUrl('/labels'), 'POST', {
        name  : 'bug',
        color : 'd73a4a',
      });
      expect(duplicateRes.status).toBe(422);

      const invalidColorRes = await handleShimRequest(ctx, repoUrl('/labels'), 'POST', {
        name  : 'bad-color',
        color : 'nope',
      });
      expect(invalidColorRes.status).toBe(422);

      const missingUpdateRes = await handleShimRequest(ctx, repoUrl('/labels/missing'), 'PATCH', {
        new_name: 'still-missing',
      });
      expect(missingUpdateRes.status).toBe(404);
    });

    it('should return 404 for missing repository labels', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/labels/missing'));
      expect(res.status).toBe(404);
      expect(parse(res).message).toContain('Label \'missing\' not found');
    });
  });

  // =========================================================================
  // GET/POST/PUT/DELETE /repos/:did/:repo/issues/:number/labels
  // =========================================================================

  describe('issue label endpoints', () => {
    it('should list labels for an issue', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(0);
    });

    it('should add, replace, and remove issue labels', async () => {
      const issueNum = numericId(issueRecId);

      const addRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`), 'POST', {
        labels: [
          { name: 'bug', color: 'd73a4a' },
          'help wanted',
        ],
      });
      expect(addRes.status).toBe(200);
      const added = parse(addRes);
      expect(added.map((label: any) => label.name).sort()).toEqual(['bug', 'help wanted']);
      expect(added.find((label: any) => label.name === 'bug').color).toBe('d73a4a');

      const issueRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`));
      const issue = parse(issueRes);
      expect(issue.labels.map((label: any) => label.name).sort()).toEqual(['bug', 'help wanted']);

      const replaceRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`), 'PUT', {
        labels: [{ name: 'triaged', color: '#0e8a16' }],
      });
      expect(replaceRes.status).toBe(200);
      const replaced = parse(replaceRes);
      expect(replaced).toHaveLength(1);
      expect(replaced[0].name).toBe('triaged');
      expect(replaced[0].color).toBe('0e8a16');

      const removeOneRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels/triaged`), 'DELETE');
      expect(removeOneRes.status).toBe(200);
      expect(parse(removeOneRes)).toHaveLength(0);

      await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`), 'POST', {
        labels: ['cleanup', 'docs'],
      });
      const removeAllRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`), 'DELETE');
      expect(removeAllRes.status).toBe(204);

      const finalRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`));
      expect(parse(finalRes)).toHaveLength(0);
    });

    it('should reject invalid labels payloads', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/labels`), 'POST', {
        labels: 'bug',
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('labels');
    });

    it('should return 404 for label routes on missing issues', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999/labels'), 'POST', {
        labels: ['bug'],
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/DELETE /repos/:did/:repo/issues/:number/assignees
  // =========================================================================

  describe('issue assignee endpoints', () => {
    it('should identify actors allowed to mutate issue metadata', async () => {
      const repo = { contextId: 'assignee-permission-repo' } as any;
      const makeCtx = (
        did: string,
        grants: Array<{ role: string; did: string }> = [],
      ): AgentContext => ({
        did,
        repo: {
          records: {
            query: async (role: string, options: any) => {
              const hasGrant = grants.some((grant) => (
                grant.role === role
                && grant.did === options.filter.tags.did
                && options.filter.contextId === repo.contextId
              ));
              return { records: hasGrant ? [{ id: `${role}:${did}` }] : [] };
            },
          },
        },
      } as unknown as AgentContext);

      const contributorDid = 'did:jwk:assignee-contributor';
      const viewerDid = 'did:jwk:assignee-viewer';
      expect(await canMutateIssueMetadata(makeCtx(testDid), testDid, repo)).toBe(true);
      expect(await canMutateIssueMetadata(
        makeCtx(MAINTAINER_DID, [{ role: 'repo/maintainer', did: MAINTAINER_DID }]),
        testDid,
        repo,
      )).toBe(true);
      expect(await canMutateIssueMetadata(
        makeCtx(contributorDid, [{ role: 'repo/contributor', did: contributorDid }]),
        testDid,
        repo,
      )).toBe(true);
      expect(await canMutateIssueMetadata(
        makeCtx(TRIAGER_DID, [{ role: 'repo/triager', did: TRIAGER_DID }]),
        testDid,
        repo,
      )).toBe(false);
      expect(await canMutateIssueMetadata(
        makeCtx(viewerDid, [{ role: 'repo/viewer', did: viewerDid }]),
        testDid,
        repo,
      )).toBe(false);
    });

    it('should check whether a user can be assigned to a specific issue', async () => {
      const issueNum = numericId(issueRecId);

      const assignableRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${issueNum}/assignees/${encodeURIComponent(MAINTAINER_DID)}`),
      );
      expect(assignableRes.status).toBe(204);
      expect(assignableRes.body).toBe('');

      const missingAssigneeRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${issueNum}/assignees/${encodeURIComponent(NEW_COLLABORATOR_DID)}`),
      );
      expect(missingAssigneeRes.status).toBe(404);

      const missingIssueRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/999/assignees/${encodeURIComponent(MAINTAINER_DID)}`),
      );
      expect(missingIssueRes.status).toBe(404);
    });

    it('should add and remove issue assignees', async () => {
      const issueNum = numericId(issueRecId);

      const addRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/assignees`), 'POST', {
        assignees: [MAINTAINER_DID, TRIAGER_DID],
      });
      expect(addRes.status).toBe(201);
      const added = parse(addRes);
      expect(added.assignees.map((user: any) => user.login).sort()).toEqual([MAINTAINER_DID, TRIAGER_DID].sort());
      expect(added.assignee.login).toBe(MAINTAINER_DID);

      const issueRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}`));
      const issue = parse(issueRes);
      expect(issue.assignees.map((user: any) => user.login).sort()).toEqual([MAINTAINER_DID, TRIAGER_DID].sort());

      const removeRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/assignees`), 'DELETE', {
        assignees: [MAINTAINER_DID],
      });
      expect(removeRes.status).toBe(200);
      const remaining = parse(removeRes);
      expect(remaining.assignees.map((user: any) => user.login)).toEqual([TRIAGER_DID]);
      expect(remaining.assignee.login).toBe(TRIAGER_DID);

      const cleanupRes = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/assignees`), 'DELETE', {
        assignees: [TRIAGER_DID],
      });
      expect(cleanupRes.status).toBe(200);
      expect(parse(cleanupRes).assignees).toEqual([]);
    });

    it('should reject adding assignees when the issue would exceed ten assignees', async () => {
      const existingAssignees = Array.from({ length: 10 }, (_, index) => `did:jwk:existing-assignee-${index}`);
      const createRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title     : 'Assignee overflow add target',
        assignees : existingAssignees,
      });
      expect(createRes.status).toBe(201);
      const issue = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/assignees`), 'POST', {
        assignees: ['did:jwk:overflow-assignee'],
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('10 assignees');
    });

    it('should reject invalid assignees payloads', async () => {
      const issueNum = numericId(issueRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/issues/${issueNum}/assignees`), 'POST', {
        assignees: 'not-an-array',
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('assignees');
    });

    it('should return 404 for assignee routes on missing issues', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/issues/999/assignees'), 'POST', {
        assignees: [MAINTAINER_DID],
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/DELETE /repos/:did/:repo/issues/:number/dependencies
  // =========================================================================

  describe('issue dependency endpoints', () => {
    it('should add, list, and remove blocked-by issue dependencies', async () => {
      const blockerRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Blocking issue',
      });
      expect(blockerRes.status).toBe(201);
      const blocker = parse(blockerRes);

      const blockedRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Blocked issue',
      });
      expect(blockedRes.status).toBe(201);
      const blocked = parse(blockedRes);

      const addRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`),
        'POST',
        { issue_id: blocker.id },
      );
      expect(addRes.status).toBe(201);
      expect(parse(addRes).number).toBe(blocked.number);

      const blockedByRes = await handleShimRequest(ctx, repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`));
      expect(blockedByRes.status).toBe(200);
      expect(parse(blockedByRes).map((issue: any) => issue.id)).toEqual([blocker.id]);

      const blockingRes = await handleShimRequest(ctx, repoUrl(`/issues/${blocker.number}/dependencies/blocking`));
      expect(blockingRes.status).toBe(200);
      expect(parse(blockingRes).map((issue: any) => issue.number)).toEqual([blocked.number]);

      const duplicateRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`),
        'POST',
        { issue_id: blocker.id },
      );
      expect(duplicateRes.status).toBe(422);

      const selfRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`),
        'POST',
        { issue_id: blocked.id },
      );
      expect(selfRes.status).toBe(422);

      const invalidRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`),
        'POST',
        { issue_id: 'not-an-id' },
      );
      expect(invalidRes.status).toBe(422);

      const missingBlockerRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`),
        'POST',
        { issue_id: 999999 },
      );
      expect(missingBlockerRes.status).toBe(404);

      const missingIssueRes = await handleShimRequest(ctx, repoUrl('/issues/999/dependencies/blocked_by'));
      expect(missingIssueRes.status).toBe(404);

      const deleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`),
        'DELETE',
      );
      expect(deleteRes.status).toBe(200);
      expect(parse(deleteRes).number).toBe(blocked.number);

      const afterDeleteBlockedByRes = await handleShimRequest(ctx, repoUrl(`/issues/${blocked.number}/dependencies/blocked_by`));
      expect(parse(afterDeleteBlockedByRes)).toEqual([]);

      const afterDeleteBlockingRes = await handleShimRequest(ctx, repoUrl(`/issues/${blocker.number}/dependencies/blocking`));
      expect(parse(afterDeleteBlockingRes)).toEqual([]);

      const missingDeleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`),
        'DELETE',
      );
      expect(missingDeleteRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/PATCH/DELETE /repos/:did/:repo/issues/:number/sub-issues
  // =========================================================================

  describe('issue sub-issue endpoints', () => {
    it('should add, list, reprioritize, reparent, and remove sub-issues', async () => {
      const parentRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Parent issue',
      });
      expect(parentRes.status).toBe(201);
      const parent = parse(parentRes);

      const newParentRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Replacement parent issue',
      });
      expect(newParentRes.status).toBe(201);
      const newParent = parse(newParentRes);

      const firstChildRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'First child issue',
      });
      expect(firstChildRes.status).toBe(201);
      const firstChild = parse(firstChildRes);

      const secondChildRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Second child issue',
      });
      expect(secondChildRes.status).toBe(201);
      const secondChild = parse(secondChildRes);

      const addFirstRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`), 'POST', {
        sub_issue_id: firstChild.id,
      });
      expect(addFirstRes.status).toBe(201);
      expect(parse(addFirstRes).number).toBe(parent.number);

      const addSecondRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`), 'POST', {
        sub_issue_id: secondChild.id,
      });
      expect(addSecondRes.status).toBe(201);

      const listRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`));
      expect(listRes.status).toBe(200);
      expect(parse(listRes).map((issue: any) => issue.id)).toEqual([firstChild.id, secondChild.id]);

      const parentLookupRes = await handleShimRequest(ctx, repoUrl(`/issues/${firstChild.number}/parent`));
      expect(parentLookupRes.status).toBe(200);
      expect(parse(parentLookupRes).id).toBe(parent.id);

      const reprioritizeRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${parent.number}/sub_issues/priority`),
        'PATCH',
        { sub_issue_id: secondChild.id, before_id: firstChild.id },
      );
      expect(reprioritizeRes.status).toBe(200);

      const reorderedRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`));
      expect(parse(reorderedRes).map((issue: any) => issue.id)).toEqual([secondChild.id, firstChild.id]);

      const invalidPriorityRes = await handleShimRequest(
        ctx,
        repoUrl(`/issues/${parent.number}/sub_issues/priority`),
        'PATCH',
        { sub_issue_id: firstChild.id, before_id: secondChild.id, after_id: secondChild.id },
      );
      expect(invalidPriorityRes.status).toBe(422);

      const reparentBlockedRes = await handleShimRequest(ctx, repoUrl(`/issues/${newParent.number}/sub_issues`), 'POST', {
        sub_issue_id: firstChild.id,
      });
      expect(reparentBlockedRes.status).toBe(422);

      const reparentRes = await handleShimRequest(ctx, repoUrl(`/issues/${newParent.number}/sub_issues`), 'POST', {
        replace_parent : true,
        sub_issue_id   : firstChild.id,
      });
      expect(reparentRes.status).toBe(201);

      const oldParentListRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`));
      expect(parse(oldParentListRes).map((issue: any) => issue.id)).toEqual([secondChild.id]);

      const newParentListRes = await handleShimRequest(ctx, repoUrl(`/issues/${newParent.number}/sub_issues`));
      expect(parse(newParentListRes).map((issue: any) => issue.id)).toEqual([firstChild.id]);

      const parentAfterReplaceRes = await handleShimRequest(ctx, repoUrl(`/issues/${firstChild.number}/parent`));
      expect(parse(parentAfterReplaceRes).id).toBe(newParent.id);

      const removeRes = await handleShimRequest(ctx, repoUrl(`/issues/${newParent.number}/sub_issue`), 'DELETE', {
        sub_issue_id: firstChild.id,
      });
      expect(removeRes.status).toBe(200);
      expect(parse(removeRes).number).toBe(newParent.number);

      const afterRemoveListRes = await handleShimRequest(ctx, repoUrl(`/issues/${newParent.number}/sub_issues`));
      expect(parse(afterRemoveListRes)).toEqual([]);

      const parentAfterRemoveRes = await handleShimRequest(ctx, repoUrl(`/issues/${firstChild.number}/parent`));
      expect(parentAfterRemoveRes.status).toBe(404);

      const invalidAddRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`), 'POST', {
        sub_issue_id: 'not-an-id',
      });
      expect(invalidAddRes.status).toBe(422);

      const selfRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`), 'POST', {
        sub_issue_id: parent.id,
      });
      expect(selfRes.status).toBe(422);

      const missingChildRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issues`), 'POST', {
        sub_issue_id: 999999,
      });
      expect(missingChildRes.status).toBe(404);

      const missingRemoveRes = await handleShimRequest(ctx, repoUrl(`/issues/${parent.number}/sub_issue`), 'DELETE', {
        sub_issue_id: firstChild.id,
      });
      expect(missingRemoveRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/PUT/DELETE /repos/:did/:repo/issues/:number/issue-field-values
  // =========================================================================

  describe('issue field value endpoints', () => {
    it('should list, add, replace, delete, and clear issue field values', async () => {
      const issueRes = await handleShimRequest(ctx, repoUrl('/issues'), 'POST', {
        title: 'Issue with field values',
      });
      expect(issueRes.status).toBe(201);
      const issue = parse(issueRes);

      const emptyRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`));
      expect(emptyRes.status).toBe(200);
      expect(parse(emptyRes)).toEqual([]);

      const addRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: [
          { field_id: 101, value: 'DRI' },
          { field_id: 102, value: 8 },
          { field_id: 103, value: '2026-07-01' },
          { field_id: 104, value: ['Frontend', 'Backend'] },
        ],
      });
      expect(addRes.status).toBe(200);
      const added = parse(addRes);
      expect(added.map((field: any) => field.issue_field_id)).toEqual([101, 102, 103, 104]);
      expect(added.map((field: any) => field.data_type)).toEqual(['text', 'number', 'date', 'multi_select']);
      expect(added[3].value).toBe('Frontend,Backend');
      expect(added[3].multi_select_options.map((option: any) => option.name)).toEqual(['Frontend', 'Backend']);

      const pagedRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values?per_page=1`));
      expect(pagedRes.status).toBe(200);
      expect(parse(pagedRes)).toHaveLength(1);
      expect(pagedRes.headers.Link).toContain('rel="next"');

      const upsertRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: [
          { field_id: 101, value: 'New DRI' },
          { field_id: 105, value: 'Added later' },
        ],
      });
      expect(upsertRes.status).toBe(200);
      const upserted = parse(upsertRes);
      expect(upserted.find((field: any) => field.issue_field_id === 101).value).toBe('New DRI');
      expect(upserted.find((field: any) => field.issue_field_id === 105).value).toBe('Added later');

      const replaceRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'PUT', {
        issue_field_values: [
          { field_id: 201, value: 'Only field' },
        ],
      });
      expect(replaceRes.status).toBe(200);
      expect(parse(replaceRes).map((field: any) => field.issue_field_id)).toEqual([201]);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values/201`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`));
      expect(parse(afterDeleteRes)).toEqual([]);

      await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: [{ field_id: 301, value: 'Temporary' }],
      });
      const clearRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: [],
      });
      expect(clearRes.status).toBe(200);
      expect(parse(clearRes)).toEqual([]);

      const invalidValuesRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: 'not-an-array',
      });
      expect(invalidValuesRes.status).toBe(422);

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values`), 'POST', {
        issue_field_values: [
          { field_id: 401, value: 'a' },
          { field_id: 401, value: 'b' },
        ],
      });
      expect(duplicateRes.status).toBe(422);

      const missingIssueRes = await handleShimRequest(ctx, repoUrl('/issues/999/issue-field-values'));
      expect(missingIssueRes.status).toBe(404);

      const missingDeleteRes = await handleShimRequest(ctx, repoUrl(`/issues/${issue.number}/issue-field-values/999`), 'DELETE');
      expect(missingDeleteRes.status).toBe(404);
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
      expect(data.draft).toBe(false);
      expect(data.base.ref).toBe('main');
      expect(data.head.ref).toBe('feat-new');
      expect(typeof data.number).toBe('number');
      expect(data.number).toBeGreaterThan(0);
    });

    it('should default base to main when not specified', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title: 'Default base PR',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.base.ref).toBe('main');
    });

    it('should create draft pull requests and list them as open', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'Draft pull request',
        body  : 'Still being prepared.',
        base  : 'main',
        head  : 'draft-pr',
        draft : true,
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.title).toBe('Draft pull request');
      expect(data.state).toBe('open');
      expect(data.draft).toBe(true);
      expect(data.merged).toBe(false);

      const detailRes = await handleShimRequest(ctx, repoUrl(`/pulls/${data.number}`));
      expect(detailRes.status).toBe(200);
      const detail = parse(detailRes);
      expect(detail.draft).toBe(true);
      expect(detail.state).toBe('open');

      const openRes = await handleShimRequest(ctx, repoUrl('/pulls'));
      expect(openRes.status).toBe(200);
      expect(parse(openRes).some((pull: any) => pull.number === data.number && pull.draft === true)).toBe(true);

      const closedRes = await handleShimRequest(ctx, repoUrl('/pulls?state=closed'));
      expect(closedRes.status).toBe(200);
      expect(parse(closedRes).some((pull: any) => pull.number === data.number)).toBe(false);
    });

    it('should return 422 when title is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        body: 'Missing title.',
      });
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('title');
    });

    it('should return 422 when draft is not a boolean', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'Invalid draft PR',
        draft : 'yes',
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('draft');
    });

    it('should honor GitHub pull request body media types on create', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'Create media PR',
        body  : '**Pull** and `code`.',
        base  : 'main',
        head  : 'media-create',
      }, null, {
        accept: 'application/vnd.github.full+json',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('**Pull** and `code`.');
      expect(data.body_text).toBe('Pull and code.');
      expect(data.body_html).toBe('<p><strong>Pull</strong> and <code>code</code>.</p>');
    });
  });

  // =========================================================================
  // GET/POST/DELETE /repos/:did/:repo/pulls/:number/requested_reviewers
  // =========================================================================

  describe('pull request review request endpoints', () => {
    it('should list empty requested reviewers by default', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`));
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.users).toEqual([]);
      expect(data.teams).toEqual([]);
    });

    it('should request, list, and remove pull request reviewers', async () => {
      const patchNum = numericId(patchRecId);
      const createRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`), 'POST', {
        reviewers      : [MAINTAINER_DID, TRIAGER_DID],
        team_reviewers : ['core-reviewers'],
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.requested_reviewers.map((user: any) => user.login).sort()).toEqual([MAINTAINER_DID, TRIAGER_DID].sort());
      expect(created.requested_teams.map((team: any) => team.slug)).toEqual(['core-reviewers']);

      const listRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`));
      expect(listRes.status).toBe(200);
      const listed = parse(listRes);
      expect(listed.users.map((user: any) => user.login).sort()).toEqual([MAINTAINER_DID, TRIAGER_DID].sort());
      expect(listed.teams.map((team: any) => team.slug)).toEqual(['core-reviewers']);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`), 'DELETE', {
        reviewers      : [MAINTAINER_DID],
        team_reviewers : ['core-reviewers'],
      });
      expect(deleteRes.status).toBe(200);
      const updated = parse(deleteRes);
      expect(updated.requested_reviewers.map((user: any) => user.login)).toEqual([TRIAGER_DID]);
      expect(updated.requested_teams).toEqual([]);

      const teamOnlyCreateRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`), 'POST', {
        reviewers      : [],
        team_reviewers : ['ops-reviewers'],
      });
      expect(teamOnlyCreateRes.status).toBe(201);

      const teamOnlyDeleteRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`), 'DELETE', {
        reviewers      : [],
        team_reviewers : ['ops-reviewers'],
      });
      expect(teamOnlyDeleteRes.status).toBe(200);
      const teamOnlyUpdated = parse(teamOnlyDeleteRes);
      expect(teamOnlyUpdated.requested_reviewers.map((user: any) => user.login)).toEqual([TRIAGER_DID]);
      expect(teamOnlyUpdated.requested_teams).toEqual([]);
    });

    it('should reject invalid review request payloads and missing pulls', async () => {
      const patchNum = numericId(patchRecId);
      const invalidRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/requested_reviewers`), 'POST', {
        reviewers: 'not-an-array',
      });
      expect(invalidRes.status).toBe(422);

      const missingReviewersDeleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/pulls/${patchNum}/requested_reviewers`),
        'DELETE',
        { team_reviewers: ['core-reviewers'] },
      );
      expect(missingReviewersDeleteRes.status).toBe(422);
      expect(parse(missingReviewersDeleteRes).message).toContain('reviewers');

      const missingRes = await handleShimRequest(ctx, repoUrl('/pulls/999/requested_reviewers'));
      expect(missingRes.status).toBe(404);
    });
  });

  // =========================================================================
  // PUT /repos/:did/:repo/pulls/:number/update-branch
  // =========================================================================

  describe('PUT /repos/:did/:repo/pulls/:number/update-branch', () => {
    it('should accept branch update requests with a matching expected head SHA', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/update-branch`), 'PUT', {
        expected_head_sha: 'abc1234567890abcdef1234567890abcdef12345',
      });
      expect(res.status).toBe(202);
      const data = parse(res);
      expect(data.message).toBe('Updating pull request branch.');
      expect(data.url).toContain(`/pulls/${patchNum}`);
    });

    it('should reject branch update requests when expected_head_sha does not match', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/update-branch`), 'PUT', {
        expected_head_sha: '0000000000000000000000000000000000000000',
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('expected_head_sha');
    });

    it('should return 404 for missing pull request branch updates', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/pulls/999/update-branch'), 'PUT', {});
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /repos/:did/:repo/pulls/:number/merge — check if merged
  // =========================================================================

  describe('GET /repos/:did/:repo/pulls/:number/merge', () => {
    it('should return 204 with an empty body for merged pull requests', async () => {
      const mergedNum = numericId(mergedPatchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${mergedNum}/merge`));
      expect(res.status).toBe(204);
      expect(res.body).toBe('');
    });

    it('should return 404 for unmerged or missing pull requests', async () => {
      const patchNum = numericId(patchRecId);
      const unmergedRes = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/merge`));
      expect(unmergedRes.status).toBe(404);

      const missingRes = await handleShimRequest(ctx, repoUrl('/pulls/999/merge'));
      expect(missingRes.status).toBe(404);
    });
  });

  // =========================================================================
  // PATCH /repos/:did/:repo/pulls/:number — update pull request
  // =========================================================================

  describe('PATCH /repos/:did/:repo/pulls/:number', () => {
    it('should update the title of a pull request', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`), 'PATCH', {
        title: 'Add feature X (updated)',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.title).toBe('Add feature X (updated)');
      expect(data.number).toBe(patchNum);
    });

    it('should close a pull request by setting state=closed', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`), 'PATCH', {
        state: 'closed',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.state).toBe('closed');
      expect(data.merged).toBe(false);
    });

    it('should reopen a pull request by setting state=open', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`), 'PATCH', {
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

    it('should honor GitHub pull request body media types on update', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`), 'PATCH', {
        body: 'Updated **pull**.',
      }, null, {
        accept: 'application/vnd.github.text+json',
      });
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.body).toBeUndefined();
      expect(data.body_text).toBe('Updated pull.');
      expect(data.body_html).toBeUndefined();
    });
  });

  // =========================================================================
  // PUT /repos/:did/:repo/pulls/:number/merge — merge pull request
  // =========================================================================

  describe('PUT /repos/:did/:repo/pulls/:number/merge', () => {
    it('should merge an open pull request', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/merge`), 'PUT', {});
      expect(res.status).toBe(200);
      const data = parse(res);
      expect(data.merged).toBe(true);
      expect(data.message).toContain('merged');
    });

    it('should return 405 when trying to merge an already merged pull', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/merge`), 'PUT', {});
      expect(res.status).toBe(405);
      const data = parse(res);
      expect(data.message).toContain('already merged');
    });

    it('should verify the pull is now merged via GET', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}`));
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
    // Create a fresh PR per test — the numericId is derived from the record ID.
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

    it('should create inline comments from the review comments array', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for review comments array',
        head  : 'review-comments-array',
      });
      expect(createRes.status).toBe(201);
      const pr = parse(createRes);

      const reviewRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body     : 'Summary comment.',
        event    : 'COMMENT',
        comments : [
          {
            body       : 'Inline **comment**.',
            path       : 'src/widget.ts',
            start_line : 29,
            start_side : 'RIGHT',
            line       : 31,
            side       : 'RIGHT',
            diff_hunk  : '@@ -30 +31 @@',
          },
        ],
      });
      expect(reviewRes.status).toBe(201);
      const review = parse(reviewRes);
      expect(review.body).toBe('Summary comment.');

      const commentsRes = await handleShimRequest(
        ctx, repoUrl(`/pulls/${pr.number}/reviews/${review.id}/comments`), 'GET', {}, null,
        { accept: 'application/vnd.github-commitcomment.full+json' },
      );
      expect(commentsRes.status).toBe(200);
      const comments = parse(commentsRes);
      expect(comments).toHaveLength(1);
      expect(comments[0].pull_request_review_id).toBe(review.id);
      expect(comments[0].body).toBe('Inline **comment**.');
      expect(comments[0].body_text).toBe('Inline comment.');
      expect(comments[0].body_html).toBe('<p>Inline <strong>comment</strong>.</p>');
      expect(comments[0].path).toBe('src/widget.ts');
      expect(comments[0].start_line).toBe(29);
      expect(comments[0].original_start_line).toBe(29);
      expect(comments[0].start_side).toBe('RIGHT');
      expect(comments[0].line).toBe(31);
      expect(comments[0].side).toBe('RIGHT');
      expect(comments[0].subject_type).toBe('line');
    });

    it('should honor GitHub pull request review body media types on create', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for review media',
        head  : 'review-media',
      });
      expect(createRes.status).toBe(201);
      const pr = parse(createRes);

      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body  : '**Review** and `code`.',
        event : 'COMMENT',
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.body).toBe('**Review** and `code`.');
      expect(data.body_text).toBe('Review and code.');
      expect(data.body_html).toBe('<p><strong>Review</strong> and <code>code</code>.</p>');
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

    it('should create a pending review when no event is specified', async () => {
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
      expect(data.state).toBe('PENDING');
      expect(data.submitted_at).toBeUndefined();
    });

    it('should submit a pending review through the events endpoint', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for pending review submission',
        head  : 'pending-submit-branch',
      });
      const pr = parse(createRes);

      const pendingRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body: 'Draft review body.',
      });
      expect(pendingRes.status).toBe(201);
      const pending = parse(pendingRes);
      expect(pending.state).toBe('PENDING');

      const invalidRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${pending.id}/events`), 'POST', {
        event: 'NOPE',
      });
      expect(invalidRes.status).toBe(422);

      const submitRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${pending.id}/events`), 'POST', {
        body  : 'Final review body.',
        event : 'REQUEST_CHANGES',
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(submitRes.status).toBe(200);
      const submitted = parse(submitRes);
      expect(submitted.id).toBe(pending.id);
      expect(submitted.body).toBe('Final review body.');
      expect(submitted.body_text).toBe('Final review body.');
      expect(submitted.body_html).toBe('<p>Final review body.</p>');
      expect(submitted.state).toBe('CHANGES_REQUESTED');
      expect(submitted.submitted_at).toBeDefined();

      const getRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${pending.id}`));
      expect(parse(getRes).state).toBe('CHANGES_REQUESTED');
    });

    it('should delete pending reviews and reject deleting submitted reviews', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for pending review deletion',
        head  : 'pending-delete-branch',
      });
      const pr = parse(createRes);

      const pendingRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body: 'Delete this draft.',
      });
      const pending = parse(pendingRes);

      const deleteRes = await handleShimRequest(
        ctx, repoUrl(`/pulls/${pr.number}/reviews/${pending.id}`), 'DELETE', {}, null,
        { accept: 'application/vnd.github-commitcomment.html+json' },
      );
      expect(deleteRes.status).toBe(200);
      const deleted = parse(deleteRes);
      expect(deleted.state).toBe('PENDING');
      expect(deleted.body).toBeUndefined();
      expect(deleted.body_html).toBe('<p>Delete this draft.</p>');

      const missingRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${pending.id}`));
      expect(missingRes.status).toBe(404);

      const submittedDeleteRes = await handleShimRequest(
        ctx, repoUrl(`/pulls/${numericId(patchRecId)}/reviews/${numericId(reviewRecId)}`), 'DELETE',
      );
      expect(submittedDeleteRes.status).toBe(422);
    });

    it('should dismiss submitted pull request reviews', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pulls'), 'POST', {
        title : 'PR for review dismissal',
        head  : 'dismiss-review-branch',
      });
      const pr = parse(createRes);

      const reviewRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews`), 'POST', {
        body  : 'Approved before new context.',
        event : 'APPROVE',
      });
      const review = parse(reviewRes);

      const invalidRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${review.id}/dismissals`), 'PUT', {});
      expect(invalidRes.status).toBe(422);

      const dismissRes = await handleShimRequest(
        ctx, repoUrl(`/pulls/${pr.number}/reviews/${review.id}/dismissals`), 'PUT', {
          message: 'No longer applies after force-push.',
        }, null, {
          accept: 'application/vnd.github-commitcomment.text+json',
        },
      );
      expect(dismissRes.status).toBe(200);
      const dismissed = parse(dismissRes);
      expect(dismissed.id).toBe(review.id);
      expect(dismissed.body).toBeUndefined();
      expect(dismissed.body_text).toBe('Approved before new context.');
      expect(dismissed.state).toBe('DISMISSED');

      const getRes = await handleShimRequest(ctx, repoUrl(`/pulls/${pr.number}/reviews/${review.id}`));
      expect(parse(getRes).state).toBe('DISMISSED');
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

      const latest = parse(await handleShimRequest(ctx, repoUrl('/releases/latest')));
      expect(latest.tag_name).toBe('v3.0.0');
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
      expect(data.published_at).toBeNull();
    });

    it('should use tag_name as name when name is omitted', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name: 'v6.0.0',
      });
      expect(res.status).toBe(201);
      const data = parse(res);
      expect(data.name).toBe('v6.0.0');
    });

    it('should default target_commitish to the repository default branch', async () => {
      const repoName = 'release-default-target-repo';
      const { record: repoRec } = await ctx.repo.records.create('repo', {
        data : { name: repoName, description: 'Release default target fixture', defaultBranch: 'trunk', dwnEndpoints: [] },
        tags : { name: repoName, visibility: 'public' },
      });
      let releaseId: number | undefined;

      try {
        const createRes = await handleShimRequest(ctx, url(`/repos/${testDid}/${repoName}/releases`), 'POST', {
          tag_name    : 'v-default-target',
          name        : 'Default Target Release',
          make_latest : 'false',
        });
        expect(createRes.status).toBe(201);
        const created = parse(createRes);
        releaseId = created.id;
        expect(created.target_commitish).toBe('trunk');

        const detailRes = await handleShimRequest(ctx, url(`/repos/${testDid}/${repoName}/releases/${created.id}`));
        expect(parse(detailRes).target_commitish).toBe('trunk');

        const byTagRes = await handleShimRequest(ctx, url(`/repos/${testDid}/${repoName}/releases/tags/v-default-target`));
        expect(parse(byTagRes).target_commitish).toBe('trunk');
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, url(`/repos/${testDid}/${repoName}/releases/${releaseId}`), 'DELETE');
        }
        if (repoRec) {
          await repoRec.delete();
        }
      }
    });

    it('should generate release notes during release creation', async () => {
      let releaseId: number | undefined;

      try {
        const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name               : 'v-create-generated-notes',
          target_commitish       : 'release-notes-branch',
          body                   : 'Manual intro.',
          generate_release_notes : true,
        });
        expect(res.status).toBe(201);
        const data = parse(res);
        releaseId = data.id;
        expect(data.name).toBe('Release v-create-generated-notes');
        expect(data.body).toContain('Manual intro.\n\n## Changes in v-create-generated-notes');
        expect(data.body).toContain('Target: release-notes-branch');

        const byTagRes = await handleShimRequest(ctx, repoUrl('/releases/tags/v-create-generated-notes'));
        expect(byTagRes.status).toBe(200);
        expect(parse(byTagRes).body).toBe(data.body);
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should create release discussion links when a discussion category is provided', async () => {
      let releaseId: number | undefined;

      try {
        const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
          tag_name                 : 'v-discussion-release',
          name                     : 'Discussion Release',
          discussion_category_name : 'Announcements',
          make_latest              : 'false',
        });
        expect(res.status).toBe(201);
        const data = parse(res);
        releaseId = data.id;
        expect(data.discussion_url).toContain(`/repos/${testDid}/test-repo/discussions/`);

        const byTagRes = await handleShimRequest(ctx, repoUrl('/releases/tags/v-discussion-release'));
        expect(byTagRes.status).toBe(200);
        expect(parse(byTagRes).discussion_url).toBe(data.discussion_url);
      } finally {
        if (releaseId !== undefined) {
          await handleShimRequest(ctx, repoUrl(`/releases/${releaseId}`), 'DELETE');
        }
      }
    });

    it('should return 422 when tag_name is missing', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        name: 'No tag',
      });
      expect(res.status).toBe(422);
      const data = parse(res);
      expect(data.message).toContain('tag_name');
    });

    it('should reject duplicate release tag names', async () => {
      const res = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v1.0.0',
        name     : 'Duplicate v1',
      });
      expect(res.status).toBe(422);
      expect(parse(res).message).toContain('tag_name');
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
  // PATCH/DELETE /repos/:did/:repo/releases/:id and assets
  // =========================================================================

  describe('release update and delete endpoints', () => {
    it('should update release metadata', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v7.0.0',
        name     : 'Version 7.0.0',
        body     : 'Initial v7 notes.',
        draft    : true,
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
        tag_name         : 'v7.1.0',
        target_commitish : 'release-branch',
        name             : 'Version 7.1.0',
        body             : 'Updated v7 notes.',
        draft            : false,
        prerelease       : true,
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.id).toBe(created.id);
      expect(updated.tag_name).toBe('v7.1.0');
      expect(updated.target_commitish).toBe('release-branch');
      expect(updated.name).toBe('Version 7.1.0');
      expect(updated.body).toBe('Updated v7 notes.');
      expect(updated.draft).toBe(false);
      expect(updated.prerelease).toBe(true);
      expect(typeof updated.published_at).toBe('string');

      const byTagRes = await handleShimRequest(ctx, repoUrl('/releases/tags/v7.1.0'));
      expect(byTagRes.status).toBe(200);
      const byTag = parse(byTagRes);
      expect(byTag.name).toBe('Version 7.1.0');
      expect(byTag.published_at).toBe(updated.published_at);
    });

    it('should reject release updates that reuse another release tag', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name    : 'v-update-duplicate-tag',
        name        : 'Update Duplicate Tag',
        make_latest : 'false',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      try {
        const updateRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          tag_name: 'v1.0.0',
        });
        expect(updateRes.status).toBe(422);
        expect(parse(updateRes).message).toContain('tag_name');
      } finally {
        await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'DELETE');
      }
    });

    it('should add release discussion links on update', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name    : 'v-update-discussion',
        name        : 'Update Discussion Release',
        make_latest : 'false',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      try {
        const updateRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          discussion_category_name: 'Announcements',
        });
        expect(updateRes.status).toBe(200);
        const updated = parse(updateRes);
        expect(updated.discussion_url).toContain(`/repos/${testDid}/test-repo/discussions/`);

        const ignoredRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'PATCH', {
          discussion_category_name: '',
        });
        expect(ignoredRes.status).toBe(200);
        expect(parse(ignoredRes).discussion_url).toBe(updated.discussion_url);
      } finally {
        await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'DELETE');
      }
    });

    it('should delete releases', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v8.0.0',
        name     : 'Delete Me',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const missingRes = await handleShimRequest(ctx, repoUrl(`/releases/${created.id}`));
      expect(missingRes.status).toBe(404);
    });

    it('should update and delete release asset metadata without rewriting bytes', async () => {
      const { record: releaseRec } = await ctx.releases.records.create('repo/release' as any, {
        data            : { name: 'Asset Metadata Release', body: 'Asset write fixture.' },
        tags            : { tagName: 'v-assets-write' },
        parentContextId : repoContextId,
      } as any);
      expect(releaseRec).toBeDefined();

      const assetBytes = Buffer.from('asset metadata bytes\n', 'utf-8');
      const { record: assetRec } = await ctx.releases.records.create('repo/release/asset' as any, {
        data            : assetBytes,
        dataFormat      : 'application/zip',
        tags            : { filename: 'old-name.zip', contentType: 'application/zip', size: assetBytes.byteLength },
        parentContextId : releaseRec!.contextId ?? '',
      } as any);
      expect(assetRec).toBeDefined();

      const assetId = numericId(assetRec!.id);
      const updateRes = await handleShimRequest(ctx, repoUrl(`/releases/assets/${assetId}`), 'PATCH', {
        name  : 'new-name.zip',
        label : 'Mac binary',
        state : 'uploaded',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.id).toBe(assetId);
      expect(updated.name).toBe('new-name.zip');
      expect(updated.label).toBe('Mac binary');
      expect(updated.content_type).toBe('application/zip');
      expect(updated.size).toBe(assetBytes.byteLength);
      expect(updated.browser_download_url).toContain('/releases/download/v-assets-write/new-name.zip');

      const getRes = await handleShimRequest(ctx, repoUrl(`/releases/assets/${assetId}`));
      expect(parse(getRes).name).toBe('new-name.zip');

      const downloadRes = await handleShimRequest(ctx, repoUrl('/releases/download/v-assets-write/new-name.zip'));
      expect(downloadRes.status).toBe(200);
      expect(Buffer.from(downloadRes.body as Uint8Array).toString('utf-8')).toBe(assetBytes.toString('utf-8'));

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/releases/assets/${assetId}`), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const missingRes = await handleShimRequest(ctx, repoUrl(`/releases/assets/${assetId}`));
      expect(missingRes.status).toBe(404);
    });

    it('should upload release assets from raw bytes', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v-upload-asset',
        name     : 'Upload Asset Release',
      });
      expect(createRes.status).toBe(201);
      const release = parse(createRes);

      const assetBytes = Buffer.from('raw upload asset bytes\n', 'utf-8');
      const assetDigest = `sha256:${createHash('sha256').update(assetBytes).digest('hex')}`;
      const assetName = `uploaded-${release.id}.zip`;
      const uploadRes = await handleShimRequest(
        ctx,
        repoUrl(`/releases/${release.id}/assets?name=${assetName}&label=Linux%20binary`),
        'POST',
        {},
        null,
        { rawBody: assetBytes, contentType: 'application/zip' },
      );
      expect(uploadRes.status).toBe(201);
      const uploaded = parse(uploadRes);
      expect(uploaded.name).toBe(assetName);
      expect(uploaded.label).toBe('Linux binary');
      expect(uploaded.content_type).toBe('application/zip');
      expect(uploaded.size).toBe(assetBytes.byteLength);
      expect(uploaded.digest).toBe(assetDigest);
      expect(uploaded.browser_download_url).toContain(`/releases/download/v-upload-asset/${assetName}`);

      const listRes = await handleShimRequest(ctx, repoUrl(`/releases/${release.id}/assets`));
      expect(listRes.status).toBe(200);
      const listed = parse(listRes);
      expect(listed.some((asset: any) =>
        asset.name === assetName && asset.label === 'Linux binary' && asset.digest === assetDigest)).toBe(true);

      const downloadRes = await handleShimRequest(ctx, repoUrl(`/releases/download/v-upload-asset/${assetName}`));
      expect(downloadRes.status).toBe(200);
      expect(bodyBuffer(downloadRes).equals(assetBytes)).toBe(true);
    });

    it('should reject duplicate release asset uploads and missing upload names', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/releases'), 'POST', {
        tag_name : 'v-upload-dupe',
        name     : 'Upload Duplicate Release',
      });
      expect(createRes.status).toBe(201);
      const release = parse(createRes);
      const assetBytes = Buffer.from('duplicate asset bytes\n', 'utf-8');
      const assetName = `duplicate-${release.id}.zip`;

      const firstUploadRes = await handleShimRequest(
        ctx,
        repoUrl(`/releases/${release.id}/assets?name=${assetName}`),
        'POST',
        {},
        null,
        { rawBody: assetBytes, contentType: 'application/zip' },
      );
      expect(firstUploadRes.status).toBe(201);

      const duplicateRes = await handleShimRequest(
        ctx,
        repoUrl(`/releases/${release.id}/assets?name=${assetName}`),
        'POST',
        {},
        null,
        { rawBody: assetBytes, contentType: 'application/zip' },
      );
      expect(duplicateRes.status).toBe(422);
      expect(parse(duplicateRes).message).toContain('same filename');

      const missingNameRes = await handleShimRequest(
        ctx,
        repoUrl(`/releases/${release.id}/assets`),
        'POST',
        {},
        null,
        { rawBody: assetBytes, contentType: 'application/zip' },
      );
      expect(missingNameRes.status).toBe(422);
      expect(parse(missingNameRes).message).toContain('name');
    });

    it('should generate release notes without creating a release', async () => {
      const notesRes = await handleShimRequest(ctx, repoUrl('/releases/generate-notes'), 'POST', {
        tag_name          : 'v-generated-notes',
        target_commitish  : 'main',
        previous_tag_name : 'v1.0.0',
      });
      expect(notesRes.status).toBe(200);
      const notes = parse(notesRes);
      expect(notes.name).toBe('Release v-generated-notes');
      expect(notes.body).toContain('## Changes in v-generated-notes');
      expect(notes.body).toContain('Target: main');
      expect(notes.body).toContain('Previous tag: v1.0.0');

      const byTagRes = await handleShimRequest(ctx, repoUrl('/releases/tags/v-generated-notes'));
      expect(byTagRes.status).toBe(404);
    });

    it('should reject invalid generated release notes requests', async () => {
      const missingTagRes = await handleShimRequest(ctx, repoUrl('/releases/generate-notes'), 'POST', {
        target_commitish: 'main',
      });
      expect(missingTagRes.status).toBe(422);
      expect(parse(missingTagRes).message).toContain('tag_name');

      const missingRepoRes = await handleShimRequest(
        ctx,
        url(`/repos/${testDid}/missing-repo/releases/generate-notes`),
        'POST',
        { tag_name: 'v-missing' },
      );
      expect(missingRepoRes.status).toBe(404);
    });

    it('should return 404 for missing release write targets', async () => {
      const updateReleaseRes = await handleShimRequest(ctx, repoUrl('/releases/999'), 'PATCH', {
        name: 'Missing',
      });
      expect(updateReleaseRes.status).toBe(404);

      const deleteReleaseRes = await handleShimRequest(ctx, repoUrl('/releases/999'), 'DELETE');
      expect(deleteReleaseRes.status).toBe(404);

      const updateAssetRes = await handleShimRequest(ctx, repoUrl('/releases/assets/999'), 'PATCH', {
        name: 'missing.zip',
      });
      expect(updateAssetRes.status).toBe(404);

      const deleteAssetRes = await handleShimRequest(ctx, repoUrl('/releases/assets/999'), 'DELETE');
      expect(deleteAssetRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GitHub Pages endpoints
  // =========================================================================

  describe('GitHub Pages endpoints', () => {
    it('should create, update, build, deploy, health-check, cancel, and delete a Pages site', async () => {
      const missingRes = await handleShimRequest(ctx, repoUrl('/pages'));
      expect(missingRes.status).toBe(404);

      const invalidCreateRes = await handleShimRequest(ctx, repoUrl('/pages'), 'POST', {
        build_type: 'legacy',
      });
      expect(invalidCreateRes.status).toBe(422);

      const createRes = await handleShimRequest(ctx, repoUrl('/pages'), 'POST', {
        source: { branch: 'main', path: '/docs' },
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.status).toBe('built');
      expect(created.source).toEqual({ branch: 'main', path: '/docs' });
      expect(created.https_enforced).toBe(true);
      expect(created.url).toContain('/pages');

      const duplicateRes = await handleShimRequest(ctx, repoUrl('/pages'), 'POST', {
        source: { branch: 'main', path: '/' },
      });
      expect(duplicateRes.status).toBe(409);

      const invalidUpdateRes = await handleShimRequest(ctx, repoUrl('/pages'), 'PUT', {
        source: { branch: 'main', path: '/site' },
      });
      expect(invalidUpdateRes.status).toBe(422);

      const updateRes = await handleShimRequest(ctx, repoUrl('/pages'), 'PUT', {
        cname          : 'docs.example.com',
        https_enforced : false,
        source         : { branch: 'gh-pages', path: '/' },
      });
      expect(updateRes.status).toBe(204);

      const updatedRes = await handleShimRequest(ctx, repoUrl('/pages'));
      expect(updatedRes.status).toBe(200);
      const updated = parse(updatedRes);
      expect(updated.cname).toBe('docs.example.com');
      expect(updated.source).toEqual({ branch: 'gh-pages', path: '/' });
      expect(updated.https_enforced).toBe(false);

      const healthRes = await handleShimRequest(ctx, repoUrl('/pages/health'));
      expect(healthRes.status).toBe(200);
      const health = parse(healthRes);
      expect(health.domain.host).toBe('docs.example.com');
      expect(health.alt_domain.host).toBe('www.docs.example.com');
      expect(health.domain.enforces_https).toBe(false);

      const requestBuildRes = await handleShimRequest(ctx, repoUrl('/pages/builds'), 'POST');
      expect(requestBuildRes.status).toBe(201);
      expect(parse(requestBuildRes).status).toBe('queued');

      const latestBuildRes = await handleShimRequest(ctx, repoUrl('/pages/builds/latest'));
      expect(latestBuildRes.status).toBe(200);
      const latestBuild = parse(latestBuildRes);
      expect(latestBuild.status).toBe('queued');
      expect(latestBuild.commit).toMatch(/^[0-9a-f]{40}$/);
      const buildId = latestBuild.url.split('/').pop();

      const listBuildsRes = await handleShimRequest(ctx, repoUrl('/pages/builds?per_page=1'));
      expect(listBuildsRes.status).toBe(200);
      expect(parse(listBuildsRes)).toHaveLength(1);

      const buildRes = await handleShimRequest(ctx, repoUrl(`/pages/builds/${buildId}`));
      expect(buildRes.status).toBe(200);
      expect(parse(buildRes).url).toBe(latestBuild.url);

      const invalidDeploymentRes = await handleShimRequest(ctx, repoUrl('/pages/deployments'), 'POST', {
        pages_build_version : 'pages-sha-1',
        oidc_token          : 'token',
      });
      expect(invalidDeploymentRes.status).toBe(422);

      const deploymentRes = await handleShimRequest(ctx, repoUrl('/pages/deployments'), 'POST', {
        artifact_url        : 'https://example.com/pages.zip',
        environment         : 'github-pages',
        pages_build_version : 'pages-sha-1',
        oidc_token          : 'token',
      });
      expect(deploymentRes.status).toBe(200);
      const deployment = parse(deploymentRes);
      expect(deployment.id).toBe('pages-sha-1');
      expect(deployment.status_url).toContain('/pages/deployments/pages-sha-1/status');
      expect(deployment.page_url).toBe('https://docs.example.com');

      const deploymentStatusRes = await handleShimRequest(ctx, repoUrl('/pages/deployments/pages-sha-1'));
      expect(deploymentStatusRes.status).toBe(200);
      expect(parse(deploymentStatusRes).status).toBe('succeed');

      const deploymentStatusUrlRes = await handleShimRequest(ctx, repoUrl('/pages/deployments/pages-sha-1/status'));
      expect(deploymentStatusUrlRes.status).toBe(200);
      expect(parse(deploymentStatusUrlRes).status).toBe('succeed');

      const cancelRes = await handleShimRequest(ctx, repoUrl('/pages/deployments/pages-sha-1/cancel'), 'POST');
      expect(cancelRes.status).toBe(204);

      const cancelledStatusRes = await handleShimRequest(ctx, repoUrl('/pages/deployments/pages-sha-1'));
      expect(parse(cancelledStatusRes).status).toBe('cancelled');

      const deleteRes = await handleShimRequest(ctx, repoUrl('/pages'), 'DELETE');
      expect(deleteRes.status).toBe(204);

      const deletedRes = await handleShimRequest(ctx, repoUrl('/pages'));
      expect(deletedRes.status).toBe(404);
    });

    it('should support workflow Pages sites without a legacy source branch', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/pages'), 'POST', {
        build_type: 'workflow',
      });
      expect(createRes.status).toBe(201);
      expect(parse(createRes).source).toBeNull();

      const healthRes = await handleShimRequest(ctx, repoUrl('/pages/health'));
      expect(healthRes.status).toBe(422);

      const updateRes = await handleShimRequest(ctx, repoUrl('/pages'), 'PUT', {
        source: { branch: 'site', path: '/docs' },
      });
      expect(updateRes.status).toBe(204);

      const updated = parse(await handleShimRequest(ctx, repoUrl('/pages')));
      expect(updated.source).toEqual({ branch: 'site', path: '/docs' });

      const deleteRes = await handleShimRequest(ctx, repoUrl('/pages'), 'DELETE');
      expect(deleteRes.status).toBe(204);
    });
  });

  // =========================================================================
  // GET/POST/DELETE /repos/:did/:repo/deployments and statuses
  // =========================================================================

  describe('deployment endpoints', () => {
    it('should create, list, update, and delete deployment environments', async () => {
      const environmentName = 'review/apps';
      const encodedName = encodeURIComponent(environmentName);
      const createRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        wait_timer               : 30,
        prevent_self_review      : true,
        reviewers                : [{ type: 'User', id: 1 }, { type: 'Team', id: 2 }],
        deployment_branch_policy : { protected_branches: false, custom_branch_policies: true },
      });
      expect(createRes.status).toBe(200);
      const created = parse(createRes);
      expect(created.name).toBe(environmentName);
      expect(created.url).toContain(`/environments/${encodedName}`);
      expect(created.deployment_branch_policy).toEqual({ protected_branches: false, custom_branch_policies: true });
      expect(created.protection_rules.map((rule: any) => rule.type).sort()).toEqual(['branch_policy', 'required_reviewers', 'wait_timer']);
      const requiredReviewers = created.protection_rules.find((rule: any) => rule.type === 'required_reviewers');
      expect(requiredReviewers.prevent_self_review).toBe(true);
      expect(requiredReviewers.reviewers.map((reviewer: any) => reviewer.type)).toEqual(['User', 'Team']);

      const listRes = await handleShimRequest(ctx, repoUrl('/environments?per_page=1'));
      expect(listRes.status).toBe(200);
      const list = parse(listRes);
      expect(list.total_count).toBeGreaterThanOrEqual(1);
      expect(list.environments).toHaveLength(1);
      expect(list.environments[0].name).toBe(environmentName);

      const getRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).id).toBe(created.id);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        wait_timer               : 5,
        prevent_self_review      : false,
        reviewers                : [{ type: 'Team', id: 3 }],
        deployment_branch_policy : { protected_branches: true, custom_branch_policies: false },
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.id).toBe(created.id);
      expect(updated.deployment_branch_policy).toEqual({ protected_branches: true, custom_branch_policies: false });
      const waitRule = updated.protection_rules.find((rule: any) => rule.type === 'wait_timer');
      expect(waitRule.wait_timer).toBe(5);

      const invalidPolicyRes = await handleShimRequest(ctx, repoUrl('/environments/bad-policy'), 'PUT', {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: true },
      });
      expect(invalidPolicyRes.status).toBe(422);
      expect(parse(invalidPolicyRes).message).toContain('protected_branches');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const missingRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`));
      expect(missingRes.status).toBe(404);
    });

    it('should create, list, update, and delete deployment environment Actions variables', async () => {
      const environmentName = 'actions/staging';
      const encodedName = encodeURIComponent(environmentName);
      const createEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        deployment_branch_policy: null,
      });
      expect(createEnvironmentRes.status).toBe(200);

      const missingEnvironmentRes = await handleShimRequest(ctx, repoUrl('/environments/missing-env/variables'));
      expect(missingEnvironmentRes.status).toBe(404);

      const initialRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables`));
      expect(initialRes.status).toBe(200);
      expect(parse(initialRes)).toEqual({ total_count: 0, variables: [] });

      const createRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables`), 'POST', {
        name  : 'TARGET_URL',
        value : 'https://staging.example.test',
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body).toBe('');

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables`), 'POST', {
        name  : 'target_url',
        value : 'https://duplicate.example.test',
      });
      expect(duplicateRes.status).toBe(409);

      const emptyValueRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables`), 'POST', {
        name  : 'TARGET_EMPTY',
        value : '',
      });
      expect(emptyValueRes.status).toBe(201);

      const listRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables?per_page=1`));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const list = parse(listRes);
      expect(list.total_count).toBe(2);
      expect(list.variables).toHaveLength(1);

      const getRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_URL`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).value).toBe('https://staging.example.test');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_URL`), 'PATCH', {
        name  : 'TARGET_HOST',
        value : 'staging.example.test',
      });
      expect(updateRes.status).toBe(204);

      const oldNameRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_URL`));
      expect(oldNameRes.status).toBe(404);

      const updateEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        wait_timer: 1,
      });
      expect(updateEnvironmentRes.status).toBe(200);

      const updatedRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_HOST`));
      expect(updatedRes.status).toBe(200);
      expect(parse(updatedRes).value).toBe('staging.example.test');

      const emptyPatchRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_HOST`), 'PATCH', {});
      expect(emptyPatchRes.status).toBe(422);

      const deleteRenamedRes = await handleShimRequest(
        ctx,
        repoUrl(`/environments/${encodedName}/variables/TARGET_HOST`),
        'DELETE',
      );
      expect(deleteRenamedRes.status).toBe(204);

      const deleteEmptyRes = await handleShimRequest(
        ctx,
        repoUrl(`/environments/${encodedName}/variables/TARGET_EMPTY`),
        'DELETE',
      );
      expect(deleteEmptyRes.status).toBe(204);

      const missingVariableRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/variables/TARGET_HOST`));
      expect(missingVariableRes.status).toBe(404);

      const deleteEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'DELETE');
      expect(deleteEnvironmentRes.status).toBe(204);
    });

    it('should create, list, update, and delete deployment environment Actions secrets', async () => {
      const environmentName = 'actions/secrets';
      const encodedName = encodeURIComponent(environmentName);
      const createEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        deployment_branch_policy: null,
      });
      expect(createEnvironmentRes.status).toBe(200);

      const missingPublicKeyRes = await handleShimRequest(ctx, repoUrl('/environments/missing-env/secrets/public-key'));
      expect(missingPublicKeyRes.status).toBe(404);

      const publicKeyRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/public-key`));
      expect(publicKeyRes.status).toBe(200);
      const publicKey = parse(publicKeyRes);
      expect(typeof publicKey.key_id).toBe('string');
      expect(typeof publicKey.key).toBe('string');

      const initialRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets`));
      expect(initialRes.status).toBe(200);
      expect(parse(initialRes)).toEqual({ total_count: 0, secrets: [] });

      const createRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/DEPLOY_TOKEN`), 'PUT', {
        encrypted_value : 'c2VjcmV0',
        key_id          : publicKey.key_id,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body).toBe('');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/DEPLOY_TOKEN`), 'PUT', {
        encrypted_value : 'bmV3LXNlY3JldA==',
        key_id          : publicKey.key_id,
      });
      expect(updateRes.status).toBe(204);

      const secondRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/API_KEY`), 'PUT', {
        encrypted_value : 'YXBpLWtleQ==',
        key_id          : publicKey.key_id,
      });
      expect(secondRes.status).toBe(201);

      const listRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets?per_page=1`));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const list = parse(listRes);
      expect(list.total_count).toBe(2);
      expect(list.secrets).toHaveLength(1);
      expect(list.secrets[0].encrypted_value).toBeUndefined();

      const updateEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'PUT', {
        wait_timer: 2,
      });
      expect(updateEnvironmentRes.status).toBe(200);

      const getRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/DEPLOY_TOKEN`));
      expect(getRes.status).toBe(200);
      const secret = parse(getRes);
      expect(secret.name).toBe('DEPLOY_TOKEN');
      expect(secret.encrypted_value).toBeUndefined();

      const invalidRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/INVALID_SECRET`), 'PUT', {
        key_id: publicKey.key_id,
      });
      expect(invalidRes.status).toBe(422);

      const deleteFirstRes = await handleShimRequest(
        ctx,
        repoUrl(`/environments/${encodedName}/secrets/DEPLOY_TOKEN`),
        'DELETE',
      );
      expect(deleteFirstRes.status).toBe(204);

      const deleteSecondRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/API_KEY`), 'DELETE');
      expect(deleteSecondRes.status).toBe(204);

      const missingSecretRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}/secrets/DEPLOY_TOKEN`));
      expect(missingSecretRes.status).toBe(404);

      const deleteEnvironmentRes = await handleShimRequest(ctx, repoUrl(`/environments/${encodedName}`), 'DELETE');
      expect(deleteEnvironmentRes.status).toBe(204);
    });

    it('should create, list, filter, and get deployments', async () => {
      const firstRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        ref                    : 'main',
        sha                    : MAIN_SHA,
        task                   : 'deploy:migrations',
        payload                : { deploy: 'migrate' },
        environment            : 'staging',
        description            : 'Deploy request from gitd tests.',
        transient_environment  : true,
        production_environment : false,
      });
      expect(firstRes.status).toBe(201);
      const first = parse(firstRes);
      expect(first.ref).toBe('main');
      expect(first.sha).toBe(MAIN_SHA);
      expect(first.task).toBe('deploy:migrations');
      expect(first.payload.deploy).toBe('migrate');
      expect(first.environment).toBe('staging');
      expect(first.original_environment).toBe('staging');
      expect(first.creator.login).toBe(testDid);
      expect(first.transient_environment).toBe(true);
      expect(first.production_environment).toBe(false);
      expect(first.statuses_url).toContain(`/deployments/${first.id}/statuses`);

      const secondRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        ref         : FEATURE_SHA,
        environment : 'staging',
        task        : 'deploy:migrations',
      });
      expect(secondRes.status).toBe(201);

      const listRes = await handleShimRequest(ctx, repoUrl('/deployments?environment=staging&task=deploy:migrations&per_page=1'));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const listed = parse(listRes);
      expect(listed).toHaveLength(1);
      expect(listed[0].environment).toBe('staging');

      const getRes = await handleShimRequest(ctx, repoUrl(`/deployments/${first.id}`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).id).toBe(first.id);
    });

    it('should create, list, and get deployment statuses', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        ref         : 'release-branch',
        environment : 'qa',
        description : 'Deploy QA build.',
      });
      expect(createRes.status).toBe(201);
      const deployment = parse(createRes);

      const statusRes = await handleShimRequest(ctx, repoUrl(`/deployments/${deployment.id}/statuses`), 'POST', {
        state           : 'success',
        log_url         : 'https://example.com/deploy/42/output',
        description     : 'Deployment finished successfully.',
        environment     : 'production',
        environment_url : 'https://app.example.com',
      });
      expect(statusRes.status).toBe(201);
      const status = parse(statusRes);
      expect(status.state).toBe('success');
      expect(status.target_url).toBe('https://example.com/deploy/42/output');
      expect(status.log_url).toBe('https://example.com/deploy/42/output');
      expect(status.environment).toBe('production');
      expect(status.deployment_url).toContain(`/deployments/${deployment.id}`);

      const listRes = await handleShimRequest(ctx, repoUrl(`/deployments/${deployment.id}/statuses`));
      expect(listRes.status).toBe(200);
      const statuses = parse(listRes);
      expect(statuses.map((entry: any) => entry.id)).toContain(status.id);

      const getStatusRes = await handleShimRequest(ctx, repoUrl(`/deployments/${deployment.id}/statuses/${status.id}`));
      expect(getStatusRes.status).toBe(200);
      expect(parse(getStatusRes).environment_url).toBe('https://app.example.com');

      const getDeploymentRes = await handleShimRequest(ctx, repoUrl(`/deployments/${deployment.id}`));
      expect(parse(getDeploymentRes).environment).toBe('production');
    });

    it('should validate deployment inputs and deletion rules', async () => {
      const invalidCreateRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        environment: 'production',
      });
      expect(invalidCreateRes.status).toBe(422);
      expect(parse(invalidCreateRes).message).toContain('ref');

      const activeRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        ref         : 'active-delete-test',
        environment : 'review',
      });
      expect(activeRes.status).toBe(201);
      const active = parse(activeRes);

      const otherRes = await handleShimRequest(ctx, repoUrl('/deployments'), 'POST', {
        ref         : 'current-delete-test',
        environment : 'review',
      });
      expect(otherRes.status).toBe(201);

      const invalidStatusRes = await handleShimRequest(ctx, repoUrl(`/deployments/${active.id}/statuses`), 'POST', {
        state: 'finished',
      });
      expect(invalidStatusRes.status).toBe(422);
      expect(parse(invalidStatusRes).message).toContain('state');

      const activeDeleteRes = await handleShimRequest(ctx, repoUrl(`/deployments/${active.id}`), 'DELETE');
      expect(activeDeleteRes.status).toBe(422);

      const inactiveRes = await handleShimRequest(ctx, repoUrl(`/deployments/${active.id}/statuses`), 'POST', {
        state       : 'inactive',
        description : 'Review app destroyed.',
      });
      expect(inactiveRes.status).toBe(201);

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/deployments/${active.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const missingDeploymentRes = await handleShimRequest(ctx, repoUrl(`/deployments/${active.id}`));
      expect(missingDeploymentRes.status).toBe(404);

      const missingStatusRes = await handleShimRequest(ctx, repoUrl(`/deployments/${parse(otherRes).id}/statuses/999`));
      expect(missingStatusRes.status).toBe(404);
    });
  });

  // =========================================================================
  // GET/POST/PATCH/DELETE /repos/:did/:repo/commit comments
  // =========================================================================

  describe('commit comment endpoints', () => {
    it('should create, list, filter, and get commit comments', async () => {
      const firstRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {
        body     : 'Great stuff',
        path     : 'src/index.ts',
        position : 4,
        line     : 14,
      });
      expect(firstRes.status).toBe(201);
      const first = parse(firstRes);
      expect(first.body).toBe('Great stuff');
      expect(first.commit_id).toBe(MAIN_SHA);
      expect(first.path).toBe('src/index.ts');
      expect(first.position).toBe(4);
      expect(first.line).toBe(14);
      expect(first.user.login).toBe(testDid);
      expect(first.author_association).toBe('OWNER');
      expect(first.html_url).toContain(`#commitcomment-${first.id}`);

      const secondRes = await handleShimRequest(ctx, repoUrl(`/commits/${FEATURE_SHA}/comments`), 'POST', {
        body: 'Feature branch note',
      });
      expect(secondRes.status).toBe(201);
      const second = parse(secondRes);

      const listRes = await handleShimRequest(ctx, repoUrl('/comments?per_page=1'));
      expect(listRes.status).toBe(200);
      expect(listRes.headers.Link).toContain('rel="next"');
      const listed = parse(listRes);
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(first.id);

      const commitListRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`));
      expect(commitListRes.status).toBe(200);
      const commitComments = parse(commitListRes);
      expect(commitComments.map((comment: any) => comment.id)).toContain(first.id);
      expect(commitComments.map((comment: any) => comment.id)).not.toContain(second.id);

      const getRes = await handleShimRequest(ctx, repoUrl(`/comments/${first.id}`));
      expect(getRes.status).toBe(200);
      expect(parse(getRes).commit_id).toBe(MAIN_SHA);
    });

    it('should update and delete commit comments', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl(`/commits/${FEATURE_SHA}/comments`), 'POST', {
        body: 'Needs another look.',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const updateRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'PATCH', {
        body: 'Looks good after follow-up.',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBe('Looks good after follow-up.');
      expect(updated.commit_id).toBe(FEATURE_SHA);
      expect(updated.updated_at).toBeDefined();

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const missingRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`));
      expect(missingRes.status).toBe(404);
    });

    it('should honor GitHub commit comment body media types', async () => {
      const createRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {
        body     : '**Commit** and `code`.',
        path     : 'src/index.ts',
        position : 6,
        line     : 16,
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);
      expect(created.body).toBe('**Commit** and `code`.');
      expect(created.body_text).toBe('Commit and code.');
      expect(created.body_html).toBe('<p><strong>Commit</strong> and <code>code</code>.</p>');

      const listTextRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.text+json',
      });
      expect(listTextRes.status).toBe(200);
      const listed = parse(listTextRes).find((comment: any) => comment.id === created.id);
      expect(listed.body).toBeUndefined();
      expect(listed.body_text).toBe('Commit and code.');

      const getHtmlRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'GET', {}, null, {
        accept: 'application/vnd.github-commitcomment.html+json',
      });
      expect(getHtmlRes.status).toBe(200);
      const html = parse(getHtmlRes);
      expect(html.body).toBeUndefined();
      expect(html.body_html).toBe('<p><strong>Commit</strong> and <code>code</code>.</p>');

      const updateRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'PATCH', {
        body: 'Updated **commit**.',
      }, null, {
        accept: 'application/vnd.github-commitcomment.full+json',
      });
      expect(updateRes.status).toBe(200);
      const updated = parse(updateRes);
      expect(updated.body).toBe('Updated **commit**.');
      expect(updated.body_text).toBe('Updated commit.');
      expect(updated.body_html).toBe('<p>Updated <strong>commit</strong>.</p>');

      const deleteRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'DELETE');
      expect(deleteRes.status).toBe(204);
    });

    it('should create, list, filter, de-duplicate, and delete commit comment reactions', async () => {
      const createCommentRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {
        body: 'Comment that will receive commit reactions.',
      });
      expect(createCommentRes.status).toBe(201);
      const comment = parse(createCommentRes);

      const emptyRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`));
      expect(emptyRes.status).toBe(200);
      expect(parse(emptyRes)).toEqual([]);

      const createHeartRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(createHeartRes.status).toBe(201);
      const heart = parse(createHeartRes);
      expect(heart.content).toBe('heart');
      expect(heart.user.login).toBe(testDid);
      expect(typeof heart.created_at).toBe('string');

      const duplicateRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`), 'POST', {
        content: 'heart',
      });
      expect(duplicateRes.status).toBe(200);
      expect(parse(duplicateRes).id).toBe(heart.id);

      const createRocketRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`), 'POST', {
        content: 'rocket',
      });
      expect(createRocketRes.status).toBe(201);

      const filteredRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions?content=heart`));
      expect(filteredRes.status).toBe(200);
      expect(parse(filteredRes).map((reaction: any) => reaction.content)).toEqual(['heart']);

      const listRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`));
      expect(listRes.status).toBe(200);
      expect(parse(listRes).map((reaction: any) => reaction.content).sort()).toEqual(['heart', 'rocket']);

      const deleteRes = await handleShimRequest(
        ctx,
        repoUrl(`/comments/${comment.id}/reactions/${heart.id}`),
        'DELETE',
      );
      expect(deleteRes.status).toBe(204);
      expect(deleteRes.body).toBe('');

      const afterDeleteRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions?content=heart`));
      expect(afterDeleteRes.status).toBe(200);
      expect(parse(afterDeleteRes)).toEqual([]);
    });

    it('should validate commit comment requests and missing comments', async () => {
      const invalidCreateRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {});
      expect(invalidCreateRes.status).toBe(422);
      expect(parse(invalidCreateRes).message).toContain('body');

      const createRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {
        body: 'Validation target',
      });
      expect(createRes.status).toBe(201);
      const created = parse(createRes);

      const invalidUpdateRes = await handleShimRequest(ctx, repoUrl(`/comments/${created.id}`), 'PATCH', {});
      expect(invalidUpdateRes.status).toBe(422);
      expect(parse(invalidUpdateRes).message).toContain('body');

      const missingGetRes = await handleShimRequest(ctx, repoUrl('/comments/999'));
      expect(missingGetRes.status).toBe(404);

      const missingPatchRes = await handleShimRequest(ctx, repoUrl('/comments/999'), 'PATCH', {
        body: 'No target.',
      });
      expect(missingPatchRes.status).toBe(404);

      const missingDeleteRes = await handleShimRequest(ctx, repoUrl('/comments/999'), 'DELETE');
      expect(missingDeleteRes.status).toBe(404);
    });

    it('should validate commit comment reactions and missing reaction targets', async () => {
      const createCommentRes = await handleShimRequest(ctx, repoUrl(`/commits/${MAIN_SHA}/comments`), 'POST', {
        body: 'Invalid commit reaction target.',
      });
      expect(createCommentRes.status).toBe(201);
      const comment = parse(createCommentRes);

      const invalidCreateRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions`), 'POST', {
        content: 'shipit',
      });
      expect(invalidCreateRes.status).toBe(422);
      expect(parse(invalidCreateRes).message).toContain('content');

      const invalidFilterRes = await handleShimRequest(ctx, repoUrl(`/comments/${comment.id}/reactions?content=shipit`));
      expect(invalidFilterRes.status).toBe(422);
      expect(parse(invalidFilterRes).message).toContain('content');

      const missingCommentRes = await handleShimRequest(ctx, repoUrl('/comments/999/reactions'));
      expect(missingCommentRes.status).toBe(404);

      const missingReactionRes = await handleShimRequest(
        ctx,
        repoUrl(`/comments/${comment.id}/reactions/999`),
        'DELETE',
      );
      expect(missingReactionRes.status).toBe(404);
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

    it('should return 405 for POST on /pulls/:number/merge', async () => {
      const patchNum = numericId(patchRecId);
      const res = await handleShimRequest(ctx, repoUrl(`/pulls/${patchNum}/merge`), 'POST', {});
      expect(res.status).toBe(405);
    });
  });
});
