/**
 * CLI command tests — exercises command functions against a real Web5 agent.
 *
 * Uses `Web5.connect()` with `sync: 'off'` to create an ephemeral agent,
 * then tests each command function directly.  The agent's data directory
 * (`__TESTDATA__/cli`) is cleaned before and after the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { gzipSync } from 'node:zlib';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/cli-agent';
const REPOS_PATH = '__TESTDATA__/cli-repos';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Capture console.log output during a function call. */
function captureLog(fn: () => Promise<void>): Promise<string[]> {
  return (async (): Promise<string[]> => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(' ')); };
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return logs;
  })();
}

/** Capture console.error and suppress process.exit during a function call. */
function captureError(fn: () => Promise<void>): Promise<{ errors: string[]; exitCode?: number }> {
  return (async (): Promise<{ errors: string[]; exitCode?: number }> => {
    const errors: string[] = [];
    const origError = console.error;
    const origExit = process.exit;
    let exitCode: number | undefined;

    console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { exitCode = code ?? 1; throw new Error(`process.exit(${code})`); }) as never;

    try {
      await fn();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.startsWith('process.exit'))) {
        throw err;
      }
    } finally {
      console.error = origError;
      process.exit = origExit;
    }
    return { errors, exitCode };
  })();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('gitd CLI commands', () => {
  let web5: Web5;
  let did: string;
  let ctx: AgentContext;

  beforeAll(async () => {
    // Clean any leftover state from previous runs.
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });

    // Create agent with isolated data path, initialize, and start.
    const agent = await Web5UserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    // Create an identity (Web5.connect normally does this).
    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'CLI Test' },
      });
    }

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    web5 = result.web5;
    did = result.did;

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
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // init command
  // =========================================================================

  describe('init', () => {
    it('should fail without a name argument', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const { errors, exitCode } = await captureError(() => initCommand(ctx, []));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create a repo record and bare git repo', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['my-test-repo', '--branch', 'main', '--repos', REPOS_PATH]),
      );
      expect(logs.some((l) => l.includes('Initialized forge repo'))).toBe(true);
      expect(logs.some((l) => l.includes('my-test-repo'))).toBe(true);
      expect(logs.some((l) => l.includes('Record ID'))).toBe(true);
      expect(logs.some((l) => l.includes('Git path'))).toBe(true);

      // Verify the bare git repo was created on disk.
      const gitPathLog = logs.find((l) => l.includes('Git path'));
      const gitPath = gitPathLog?.split('Git path:')[1]?.trim();
      expect(gitPath).toBeDefined();
      expect(existsSync(gitPath!)).toBe(true);
    });

    it('should reject a second repo (singleton)', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const { errors, exitCode } = await captureError(() => initCommand(ctx, ['second-repo']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('already exists');
    });
  });

  // =========================================================================
  // repo commands
  // =========================================================================

  describe('repo', () => {
    it('should fail with no subcommand', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const { errors, exitCode } = await captureError(() => repoCommand(ctx, []));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should show repo info', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const logs = await captureLog(() => repoCommand(ctx, ['info']));
      expect(logs.some((l) => l.includes('Repository: my-test-repo'))).toBe(true);
      expect(logs.some((l) => l.includes('DID:'))).toBe(true);
      expect(logs.some((l) => l.includes('Default Branch: main'))).toBe(true);
    });

    it('should fail add-collaborator without arguments', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const { errors, exitCode } = await captureError(() => repoCommand(ctx, ['add-collaborator']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should reject invalid role', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const { errors, exitCode } = await captureError(() =>
        repoCommand(ctx, ['add-collaborator', 'did:jwk:test123', 'admin']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Invalid role');
    });

    it('should add a maintainer collaborator', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const logs = await captureLog(() =>
        repoCommand(ctx, ['add-collaborator', 'did:jwk:collab123', 'maintainer']),
      );
      expect(logs.some((l) => l.includes('Added maintainer'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:collab123'))).toBe(true);
    });

    it('should add a contributor collaborator', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const logs = await captureLog(() =>
        repoCommand(ctx, ['add-collaborator', 'did:jwk:contrib456', 'contributor', '--alias', 'Bob']),
      );
      expect(logs.some((l) => l.includes('Added contributor'))).toBe(true);
    });

    it('should list collaborators in repo info', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const logs = await captureLog(() => repoCommand(ctx, ['info']));
      expect(logs.some((l) => l.includes('maintainers:'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:collab123'))).toBe(true);
      expect(logs.some((l) => l.includes('contributors:'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:contrib456'))).toBe(true);
    });

    it('should remove a collaborator by DID', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const logs = await captureLog(() =>
        repoCommand(ctx, ['remove-collaborator', 'did:jwk:collab123']),
      );
      expect(logs.some((l) => l.includes('Removed maintainer'))).toBe(true);
    });

    it('should fail to remove a non-existent collaborator', async () => {
      const { repoCommand } = await import('../src/cli/commands/repo.js');
      const { errors, exitCode } = await captureError(() =>
        repoCommand(ctx, ['remove-collaborator', 'did:jwk:nonexistent']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('No collaborator roles found');
    });
  });

  // =========================================================================
  // issue commands
  // =========================================================================

  describe('issue', () => {
    it('should fail create without a title', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const { errors, exitCode } = await captureError(() => issueCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create issue #1 with sequential numbering', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Bug report', '--body', 'Something broke']));
      expect(logs.some((l) => l.includes('Created issue #1'))).toBe(true);
      expect(logs.some((l) => l.includes('Bug report'))).toBe(true);
    });

    it('should create issue #2 with next number', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Feature request']));
      expect(logs.some((l) => l.includes('Created issue #2'))).toBe(true);
    });

    it('should show issue details by number', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', '1']));
      expect(logs.some((l) => l.includes('Issue #1: Bug report'))).toBe(true);
      expect(logs.some((l) => l.includes('Status:  OPEN'))).toBe(true);
      expect(logs.some((l) => l.includes('Something broke'))).toBe(true);
    });

    it('should add a comment to an issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['comment', '1', 'Looking into this']));
      expect(logs.some((l) => l.includes('Added comment to issue #1'))).toBe(true);
    });

    it('should show comments in issue detail', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', '1']));
      expect(logs.some((l) => l.includes('Comments (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('Looking into this'))).toBe(true);
    });

    it('should close an issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['close', '1']));
      expect(logs.some((l) => l.includes('Closed issue #1'))).toBe(true);
    });

    it('should show closed status after closing', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', '1']));
      expect(logs.some((l) => l.includes('Status:  CLOSED'))).toBe(true);
    });

    it('should reopen a closed issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['reopen', '1']));
      expect(logs.some((l) => l.includes('Reopened issue #1'))).toBe(true);
    });

    it('should list all issues with numbers', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Issues (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('#1'))).toBe(true);
      expect(logs.some((l) => l.includes('#2'))).toBe(true);
      expect(logs.some((l) => l.includes('Bug report'))).toBe(true);
      expect(logs.some((l) => l.includes('Feature request'))).toBe(true);
    });

    it('should show empty message when no issues match filter', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['list', '--status', 'closed']));
      expect(logs.some((l) => l.includes('No issues found'))).toBe(true);
    });

    it('should fail show for non-existent issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const { errors, exitCode } = await captureError(() => issueCommand(ctx, ['show', '99']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });
  });

  // =========================================================================
  // patch commands
  // =========================================================================

  describe('patch', () => {
    it('should fail create without a title', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const { errors, exitCode } = await captureError(() => patchCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create patch #1 with sequential numbering', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() =>
        patchCommand(ctx, ['create', 'Add feature X', '--body', 'This adds X', '--base', 'main', '--head', 'feature-x']),
      );
      expect(logs.some((l) => l.includes('Created patch #1'))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
    });

    it('should create patch #2 with next number', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['create', 'Fix typo']));
      expect(logs.some((l) => l.includes('Created patch #2'))).toBe(true);
    });

    it('should show patch details by number', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['show', '1']));
      expect(logs.some((l) => l.includes('Patch #1: Add feature X'))).toBe(true);
      expect(logs.some((l) => l.includes('Status:   OPEN'))).toBe(true);
      expect(logs.some((l) => l.includes('main <- feature-x'))).toBe(true);
    });

    it('should merge a patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['merge', '1']));
      expect(logs.some((l) => l.includes('Merged patch #1'))).toBe(true);
      expect(logs.some((l) => l.includes('strategy: merge'))).toBe(true);
    });

    it('should show merged status after merging', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['show', '1']));
      expect(logs.some((l) => l.includes('Status:   MERGED'))).toBe(true);
    });

    it('should not re-merge an already merged patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['merge', '1']));
      expect(logs.some((l) => l.includes('already merged'))).toBe(true);
    });

    it('should add a comment to a patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['comment', '2', 'Looks good to me']));
      expect(logs.some((l) => l.includes('Added comment to patch #2'))).toBe(true);
    });

    it('should show review comments in patch detail', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['show', '2']));
      expect(logs.some((l) => l.includes('Reviews (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('COMMENTED'))).toBe(true);
      expect(logs.some((l) => l.includes('Looks good to me'))).toBe(true);
    });

    it('should fail comment without body', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const { errors, exitCode } = await captureError(() => patchCommand(ctx, ['comment', '2']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail comment for non-existent patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const { errors, exitCode } = await captureError(() => patchCommand(ctx, ['comment', '99', 'hello']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should close a patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['close', '2']));
      expect(logs.some((l) => l.includes('Closed patch #2'))).toBe(true);
    });

    it('should reopen a closed patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['reopen', '2']));
      expect(logs.some((l) => l.includes('Reopened patch #2'))).toBe(true);
    });

    it('should not reopen an already open patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['reopen', '2']));
      expect(logs.some((l) => l.includes('already open'))).toBe(true);
    });

    it('should not reopen a merged patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['reopen', '1']));
      expect(logs.some((l) => l.includes('cannot be reopened'))).toBe(true);
    });

    it('should fail reopen for non-existent patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const { errors, exitCode } = await captureError(() => patchCommand(ctx, ['reopen', '99']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should list all patches with numbers', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Patches (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('#1'))).toBe(true);
      expect(logs.some((l) => l.includes('#2'))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
      expect(logs.some((l) => l.includes('Fix typo'))).toBe(true);
    });

    it('should fail show for non-existent patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const { errors, exitCode } = await captureError(() => patchCommand(ctx, ['show', '99']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });
  });

  // =========================================================================
  // log command
  // =========================================================================

  describe('log', () => {
    it('should show recent activity', async () => {
      const { logCommand } = await import('../src/cli/commands/log.js');
      const logs = await captureLog(() => logCommand(ctx, []));
      expect(logs.some((l) => l.includes('Recent activity'))).toBe(true);
      // Should have both issues and patches.
      expect(logs.some((l) => l.includes('issue'))).toBe(true);
      expect(logs.some((l) => l.includes('patch'))).toBe(true);
    });

    it('should respect --limit flag', async () => {
      const { logCommand } = await import('../src/cli/commands/log.js');
      const logs = await captureLog(() => logCommand(ctx, ['--limit', '2']));
      // Header + 2 entries.
      expect(logs.some((l) => l.includes('Recent activity (2)'))).toBe(true);
    });
  });

  // =========================================================================
  // setup command
  // =========================================================================

  describe('setup', () => {
    it('should print setup instructions', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      // Use a test-specific bin dir to avoid modifying the user's system.
      const logs = await captureLog(() => setupCommand(['--bin-dir', '__TESTDATA__/cli-bin']));
      // Even if sources don't exist (not built at test time), setup should print messages.
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('clone repos via DID');
    });
  });

  // =========================================================================
  // clone command
  // =========================================================================

  describe('clone', () => {
    it('should fail without arguments', async () => {
      const { cloneCommand } = await import('../src/cli/commands/clone.js');
      const { errors, exitCode } = await captureError(() => cloneCommand([]));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should reject invalid DID format', async () => {
      const { cloneCommand } = await import('../src/cli/commands/clone.js');
      const { errors, exitCode } = await captureError(() => cloneCommand(['not-a-did/repo']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Invalid target');
    });

    it('should reject DID without repo name', async () => {
      const { cloneCommand } = await import('../src/cli/commands/clone.js');
      const { errors, exitCode } = await captureError(() => cloneCommand(['did:dht:abc123']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Invalid target');
    });
  });

  // =========================================================================
  // release commands
  // =========================================================================

  describe('release', () => {
    it('should fail create without a tag', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const { errors, exitCode } = await captureError(() => releaseCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create a release', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const logs = await captureLog(() =>
        releaseCommand(ctx, ['create', 'v1.0.0', '--name', 'First Release', '--body', 'Initial stable release']),
      );
      expect(logs.some((l) => l.includes('Created release v1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('Record ID'))).toBe(true);
    });

    it('should create a pre-release', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const logs = await captureLog(() =>
        releaseCommand(ctx, ['create', 'v2.0.0-beta.1', '--name', 'Beta', '--prerelease']),
      );
      expect(logs.some((l) => l.includes('Created release v2.0.0-beta.1'))).toBe(true);
      expect(logs.some((l) => l.includes('Pre-release: yes'))).toBe(true);
    });

    it('should show release details by tag', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const logs = await captureLog(() => releaseCommand(ctx, ['show', 'v1.0.0']));
      expect(logs.some((l) => l.includes('Release: First Release'))).toBe(true);
      expect(logs.some((l) => l.includes('Tag:'))).toBe(true);
      expect(logs.some((l) => l.includes('Initial stable release'))).toBe(true);
    });

    it('should fail show for non-existent release', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const { errors, exitCode } = await captureError(() => releaseCommand(ctx, ['show', 'v99.0.0']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should list releases', async () => {
      const { releaseCommand } = await import('../src/cli/commands/release.js');
      const logs = await captureLog(() => releaseCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Releases (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('v1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('v2.0.0-beta.1'))).toBe(true);
    });
  });

  // =========================================================================
  // ci commands
  // =========================================================================

  describe('ci', () => {
    let suiteId: string;
    let runId: string;

    it('should fail create without a commit', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const { errors, exitCode } = await captureError(() => ciCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create a check suite', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() =>
        ciCommand(ctx, ['create', 'abc123def456', '--app', 'test-ci', '--branch', 'main']),
      );
      expect(logs.some((l) => l.includes('Created check suite'))).toBe(true);
      expect(logs.some((l) => l.includes('abc123de'))).toBe(true);
      const idLog = logs.find((l) => l.includes('Suite ID:'));
      suiteId = idLog?.split('Suite ID:')[1]?.trim() ?? '';
      expect(suiteId).toBeTruthy();
    });

    it('should show CI status', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['status']));
      expect(logs.some((l) => l.includes('CI Status: QUEUED'))).toBe(true);
      expect(logs.some((l) => l.includes('test-ci'))).toBe(true);
    });

    it('should list check suites', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Check suites (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('abc123de'))).toBe(true);
    });

    it('should show check suite details', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['show', suiteId]));
      expect(logs.some((l) => l.includes('Check Suite: test-ci'))).toBe(true);
      expect(logs.some((l) => l.includes('Status:'))).toBe(true);
    });

    it('should add a check run to a suite', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['run', suiteId, 'lint']));
      expect(logs.some((l) => l.includes('Created check run "lint"'))).toBe(true);
      const idLog = logs.find((l) => l.includes('Run ID:'));
      runId = idLog?.split('Run ID:')[1]?.trim() ?? '';
      expect(runId).toBeTruthy();
    });

    it('should fail update without arguments', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const { errors, exitCode } = await captureError(() => ciCommand(ctx, ['update']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail update with invalid status', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const { errors, exitCode } = await captureError(() =>
        ciCommand(ctx, ['update', runId, '--status', 'banana']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Invalid status');
    });

    it('should update a check run to in_progress', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() =>
        ciCommand(ctx, ['update', runId, '--status', 'in_progress']),
      );
      expect(logs.some((l) => l.includes('in_progress'))).toBe(true);
    });

    it('should update a check run to completed with conclusion', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() =>
        ciCommand(ctx, ['update', runId, '--status', 'completed', '--conclusion', 'success']),
      );
      expect(logs.some((l) => l.includes('completed'))).toBe(true);
      expect(logs.some((l) => l.includes('success'))).toBe(true);
    });

    it('should fail update for non-existent run', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const { errors, exitCode } = await captureError(() =>
        ciCommand(ctx, ['update', 'nonexistent-run-id', '--status', 'completed']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should show check runs in suite detail', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['show', suiteId]));
      expect(logs.some((l) => l.includes('Check runs (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('lint'))).toBe(true);
    });

    it('should show empty status when no suites for commit', async () => {
      const { ciCommand } = await import('../src/cli/commands/ci.js');
      const logs = await captureLog(() => ciCommand(ctx, ['status', 'nonexistent000']));
      expect(logs.some((l) => l.includes('No CI check suites found'))).toBe(true);
    });
  });

  // =========================================================================
  // wiki commands
  // =========================================================================

  describe('wiki', () => {
    it('should fail create without slug and title', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const { errors, exitCode } = await captureError(() => wikiCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create a wiki page', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const logs = await captureLog(() =>
        wikiCommand(ctx, ['create', 'getting-started', 'Getting Started', '--body', '# Welcome\nThis is the wiki.']),
      );
      expect(logs.some((l) => l.includes('Created wiki page: Getting Started'))).toBe(true);
      expect(logs.some((l) => l.includes('/getting-started'))).toBe(true);
    });

    it('should reject duplicate slug', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const { errors, exitCode } = await captureError(() =>
        wikiCommand(ctx, ['create', 'getting-started', 'Duplicate']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('already exists');
    });

    it('should show a wiki page', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const logs = await captureLog(() => wikiCommand(ctx, ['show', 'getting-started']));
      expect(logs.some((l) => l.includes('Wiki: Getting Started'))).toBe(true);
      expect(logs.some((l) => l.includes('# Welcome'))).toBe(true);
    });

    it('should edit a wiki page', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const logs = await captureLog(() =>
        wikiCommand(ctx, ['edit', 'getting-started', '--body', '# Updated\nNew content.', '--summary', 'Updated intro']),
      );
      expect(logs.some((l) => l.includes('Updated wiki page'))).toBe(true);
    });

    it('should show updated content after edit', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const logs = await captureLog(() => wikiCommand(ctx, ['show', 'getting-started']));
      expect(logs.some((l) => l.includes('# Updated'))).toBe(true);
    });

    it('should fail show for non-existent page', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const { errors, exitCode } = await captureError(() => wikiCommand(ctx, ['show', 'nonexistent']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should list wiki pages', async () => {
      const { wikiCommand } = await import('../src/cli/commands/wiki.js');
      const logs = await captureLog(() => wikiCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Wiki pages (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('getting-started'))).toBe(true);
    });
  });

  // =========================================================================
  // org commands
  // =========================================================================

  describe('org', () => {
    it('should fail create without a name', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const { errors, exitCode } = await captureError(() => orgCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create an organization', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() =>
        orgCommand(ctx, ['create', 'test-org', '--description', 'A test organization']),
      );
      expect(logs.some((l) => l.includes('Created organization: test-org'))).toBe(true);
    });

    it('should reject creating a second org (singleton)', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const { errors, exitCode } = await captureError(() => orgCommand(ctx, ['create', 'second-org']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('already exists');
    });

    it('should show org info', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() => orgCommand(ctx, ['info']));
      expect(logs.some((l) => l.includes('Organization: test-org'))).toBe(true);
      expect(logs.some((l) => l.includes('DID:'))).toBe(true);
    });

    it('should add an owner', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() =>
        orgCommand(ctx, ['add-owner', 'did:jwk:owner123', '--alias', 'Alice']),
      );
      expect(logs.some((l) => l.includes('Added owner'))).toBe(true);
    });

    it('should add a member', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() =>
        orgCommand(ctx, ['add-member', 'did:jwk:member456', '--alias', 'Bob']),
      );
      expect(logs.some((l) => l.includes('Added member'))).toBe(true);
    });

    it('should list members', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() => orgCommand(ctx, ['list-members']));
      expect(logs.some((l) => l.includes('Owners (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:owner123'))).toBe(true);
      expect(logs.some((l) => l.includes('Members (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:member456'))).toBe(true);
    });

    it('should remove a member', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() => orgCommand(ctx, ['remove-member', 'did:jwk:member456']));
      expect(logs.some((l) => l.includes('Removed member'))).toBe(true);
    });

    it('should fail to remove non-existent member', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const { errors, exitCode } = await captureError(() => orgCommand(ctx, ['remove-member', 'did:jwk:nonexistent']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should create a team', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() =>
        orgCommand(ctx, ['team', 'create', 'backend', '--description', 'Backend team']),
      );
      expect(logs.some((l) => l.includes('Created team: backend'))).toBe(true);
    });

    it('should list teams', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() => orgCommand(ctx, ['team', 'list']));
      expect(logs.some((l) => l.includes('Teams (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('backend'))).toBe(true);
    });

    it('should show teams in org info', async () => {
      const { orgCommand } = await import('../src/cli/commands/org.js');
      const logs = await captureLog(() => orgCommand(ctx, ['info']));
      expect(logs.some((l) => l.includes('Teams (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('backend'))).toBe(true);
    });
  });

  // =========================================================================
  // social commands
  // =========================================================================

  describe('social', () => {
    it('should fail star without a DID', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const { errors, exitCode } = await captureError(() => socialCommand(ctx, ['star']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should star a repo', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      // Star the local agent's own repo (initialized earlier as 'my-test-repo').
      const logs = await captureLog(() => socialCommand(ctx, ['star', ctx.did]));
      expect(logs.some((l) => l.includes(`Starred ${ctx.did}`))).toBe(true);
      expect(logs.some((l) => l.includes('my-test-repo'))).toBe(true);
    });

    it('should store correct repoRecordId and repoName in star record', async () => {
      // Query the repo record to get its ID for comparison.
      const { records: repoRecords } = await ctx.repo.records.query('repo');
      expect(repoRecords.length).toBeGreaterThan(0);
      const expectedRecordId = repoRecords[0].id;

      // Query the star record we just created.
      const { records: stars } = await ctx.social.records.query('star', {
        filter: { tags: { repoDid: ctx.did } },
      });
      expect(stars.length).toBe(1);

      const starData = await stars[0].data.json();
      expect(starData.repoRecordId).toBe(expectedRecordId);
      expect(starData.repoName).toBe('my-test-repo');
    });

    it('should not double-star', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['star', ctx.did]));
      expect(logs.some((l) => l.includes('Already starred'))).toBe(true);
    });

    it('should list stars', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['stars']));
      expect(logs.some((l) => l.includes('Starred repos (1)'))).toBe(true);
      expect(logs.some((l) => l.includes(ctx.did))).toBe(true);
      expect(logs.some((l) => l.includes('my-test-repo'))).toBe(true);
    });

    it('should unstar a repo', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['unstar', ctx.did]));
      expect(logs.some((l) => l.includes(`Unstarred ${ctx.did}`))).toBe(true);
    });

    it('should fail unstar for non-starred repo', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const { errors, exitCode } = await captureError(() => socialCommand(ctx, ['unstar', 'did:jwk:nobody']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('No star found');
    });

    it('should follow a user', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['follow', 'did:jwk:alice']));
      expect(logs.some((l) => l.includes('Following did:jwk:alice'))).toBe(true);
    });

    it('should not double-follow', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['follow', 'did:jwk:alice']));
      expect(logs.some((l) => l.includes('Already following'))).toBe(true);
    });

    it('should list following', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['following']));
      expect(logs.some((l) => l.includes('Following (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:alice'))).toBe(true);
    });

    it('should unfollow a user', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['unfollow', 'did:jwk:alice']));
      expect(logs.some((l) => l.includes('Unfollowed did:jwk:alice'))).toBe(true);
    });

    it('should fail unfollow for non-followed user', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const { errors, exitCode } = await captureError(() => socialCommand(ctx, ['unfollow', 'did:jwk:nobody']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Not following');
    });
  });

  // =========================================================================
  // notification commands
  // =========================================================================

  describe('notification', () => {
    it('should show empty notifications', async () => {
      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('No notifications'))).toBe(true);
    });

    it('should create and list a notification', async () => {
      // Create a notification directly (simulating what a CI bot or repo agent would do).
      await ctx.notifications.records.create('notification', {
        data : { type: 'mention', title: 'You were mentioned', body: 'In issue #1' },
        tags : { type: 'mention', read: false },
      });

      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Notifications (1'))).toBe(true);
      expect(logs.some((l) => l.includes('mention'))).toBe(true);
      expect(logs.some((l) => l.includes('You were mentioned'))).toBe(true);
    });

    it('should filter unread notifications', async () => {
      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['list', '--unread']));
      expect(logs.some((l) => l.includes('Notifications (1'))).toBe(true);
    });

    it('should mark a notification as read', async () => {
      // Get the notification ID.
      const { records } = await ctx.notifications.records.query('notification');
      expect(records.length).toBeGreaterThan(0);
      const notifId = records[0].id;

      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['read', notifId]));
      expect(logs.some((l) => l.includes('Marked notification as read'))).toBe(true);
    });

    it('should not double-mark as read', async () => {
      const { records } = await ctx.notifications.records.query('notification');
      const notifId = records[0].id;

      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['read', notifId]));
      expect(logs.some((l) => l.includes('already marked as read'))).toBe(true);
    });

    it('should show no unread after marking as read', async () => {
      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['list', '--unread']));
      expect(logs.some((l) => l.includes('No unread notifications'))).toBe(true);
    });

    it('should clear read notifications', async () => {
      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['clear']));
      expect(logs.some((l) => l.includes('Cleared 1 read notification'))).toBe(true);
    });

    it('should show no notifications after clear', async () => {
      const { notificationCommand } = await import('../src/cli/commands/notification.js');
      const logs = await captureLog(() => notificationCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('No notifications'))).toBe(true);
    });
  });

  // =========================================================================
  // registry commands
  // =========================================================================

  describe('registry', () => {
    const tarballPath = '__TESTDATA__/cli-test-package.tgz';

    beforeAll(() => {
      // Create a minimal gzip file to use as a tarball for publish tests.
      const payload = gzipSync(Buffer.from('fake-package-content'));
      writeFileSync(tarballPath, payload);
    });

    afterAll(() => {
      rmSync(tarballPath, { force: true });
    });

    it('should fail publish without arguments', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['publish']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail with no subcommand', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, []));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should publish a package', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() =>
        registryCommand(ctx, ['publish', 'my-pkg', '1.0.0', tarballPath, '--description', 'A test package']),
      );
      expect(logs.some((l) => l.includes('Created package: my-pkg'))).toBe(true);
      expect(logs.some((l) => l.includes('Published my-pkg@1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('Version ID:'))).toBe(true);
    });

    it('should publish a second version to the same package', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() =>
        registryCommand(ctx, ['publish', 'my-pkg', '1.1.0', tarballPath]),
      );
      // Should NOT print "Created package" since it already exists.
      expect(logs.some((l) => l.includes('Created package'))).toBe(false);
      expect(logs.some((l) => l.includes('Published my-pkg@1.1.0'))).toBe(true);
    });

    it('should reject duplicate version', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() =>
        registryCommand(ctx, ['publish', 'my-pkg', '1.0.0', tarballPath]),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('already exists');
    });

    it('should reject invalid ecosystem', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() =>
        registryCommand(ctx, ['publish', 'bad-eco', '1.0.0', tarballPath, '--ecosystem', 'ruby']),
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Invalid ecosystem');
    });

    it('should show package info', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['info', 'my-pkg']));
      expect(logs.some((l) => l.includes('Package: my-pkg'))).toBe(true);
      expect(logs.some((l) => l.includes('Ecosystem:   npm'))).toBe(true);
      expect(logs.some((l) => l.includes('Description: A test package'))).toBe(true);
      expect(logs.some((l) => l.includes('Versions:    2'))).toBe(true);
    });

    it('should fail info for non-existent package', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['info', 'no-such-pkg']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should fail info without a name', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['info']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should list versions', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['versions', 'my-pkg']));
      expect(logs.some((l) => l.includes('my-pkg'))).toBe(true);
      expect(logs.some((l) => l.includes('2 versions'))).toBe(true);
      expect(logs.some((l) => l.includes('1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('1.1.0'))).toBe(true);
    });

    it('should fail versions without a name', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['versions']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail versions for non-existent package', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['versions', 'ghost-pkg']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should list all packages', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Packages (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('my-pkg'))).toBe(true);
      expect(logs.some((l) => l.includes('[npm]'))).toBe(true);
    });

    it('should show empty list for non-matching ecosystem filter', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['list', '--ecosystem', 'cargo']));
      expect(logs.some((l) => l.includes('No packages found'))).toBe(true);
    });

    it('should print immutability note on yank', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['yank', 'my-pkg', '1.0.0']));
      expect(logs.some((l) => l.includes('immutable'))).toBe(true);
    });

    it('should fail yank without arguments', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['yank']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail yank for non-existent package', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['yank', 'no-pkg', '1.0.0']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should fail yank for non-existent version', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const { errors, exitCode } = await captureError(() => registryCommand(ctx, ['yank', 'my-pkg', '9.9.9']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should publish a package with a different ecosystem', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() =>
        registryCommand(ctx, ['publish', 'rust-crate', '0.1.0', tarballPath, '--ecosystem', 'cargo']),
      );
      expect(logs.some((l) => l.includes('Created package: rust-crate (cargo)'))).toBe(true);
      expect(logs.some((l) => l.includes('Published rust-crate@0.1.0'))).toBe(true);
    });

    it('should list both packages', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Packages (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('my-pkg'))).toBe(true);
      expect(logs.some((l) => l.includes('rust-crate'))).toBe(true);
    });

    it('should filter packages by ecosystem', async () => {
      const { registryCommand } = await import('../src/cli/commands/registry.js');
      const logs = await captureLog(() => registryCommand(ctx, ['list', '--ecosystem', 'cargo']));
      expect(logs.some((l) => l.includes('Packages (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('rust-crate'))).toBe(true);
      expect(logs.some((l) => l.includes('my-pkg'))).toBe(false);
    });
  });

  // =========================================================================
  // migrate commands
  // =========================================================================

  describe('migrate', () => {
    const origFetch = globalThis.fetch;

    /** Create a mock fetch that returns canned GitHub API responses. */
    function mockGitHubApi(routes: Record<string, unknown>): void {
      // Sort patterns longest-first so specific paths match before shorter prefixes.
      const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);

      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();

        for (const [pattern, data] of sorted) {
          if (url.includes(pattern)) {
            return new Response(JSON.stringify(data), {
              status  : 200,
              headers : { 'Content-Type': 'application/json' },
            });
          }
        }

        // Default: 404 for unmatched routes.
        return new Response('{"message":"Not Found"}', { status: 404 });
      }) as typeof fetch;
    }

    afterAll(() => {
      globalThis.fetch = origFetch;
    });

    it('should fail with no subcommand', async () => {
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const { errors, exitCode } = await captureError(() => migrateCommand(ctx, []));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail without owner/repo argument', async () => {
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const { errors, exitCode } = await captureError(() => migrateCommand(ctx, ['repo']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail with invalid owner/repo format', async () => {
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const { errors, exitCode } = await captureError(() => migrateCommand(ctx, ['repo', 'noslash']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should skip repo import when repo already exists', async () => {
      mockGitHubApi({});
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['repo', 'testowner/testrepo']));
      expect(logs.some((l) => l.includes('already exists'))).toBe(true);
      expect(logs.some((l) => l.includes('skipping'))).toBe(true);
    });

    it('should import issues with comments', async () => {
      mockGitHubApi({
        '/repos/testowner/testrepo/issues?': [
          { number: 100, title: 'GH Issue One', body: 'From GitHub', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 101, title: 'GH Issue Two', body: 'Closed one', state: 'closed', user: { login: 'bob' }, created_at: '2025-01-02T00:00:00Z', pull_request: undefined },
        ],
        '/repos/testowner/testrepo/issues/100/comments': [
          { body: 'First comment', user: { login: 'charlie' }, created_at: '2025-01-01T12:00:00Z' },
        ],
        '/repos/testowner/testrepo/issues/101/comments': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/testrepo']));
      expect(logs.some((l) => l.includes('#100'))).toBe(true);
      expect(logs.some((l) => l.includes('GH Issue One'))).toBe(true);
      expect(logs.some((l) => l.includes('1 comment'))).toBe(true);
      expect(logs.some((l) => l.includes('#101'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 issues'))).toBe(true);
    });

    it('should filter out pull requests from issues list', async () => {
      mockGitHubApi({
        '/repos/testowner/testrepo2/issues?': [
          { number: 1, title: 'Real issue', body: '', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 2, title: 'Actually a PR', body: '', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z', pull_request: { url: 'https://...' } },
        ],
        '/repos/testowner/testrepo2/issues/1/comments': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/testrepo2']));
      expect(logs.some((l) => l.includes('Imported 1 issue'))).toBe(true);
      // Should NOT contain the PR.
      expect(logs.some((l) => l.includes('Actually a PR'))).toBe(false);
    });

    it('should handle no issues gracefully', async () => {
      mockGitHubApi({
        '/repos/emptyowner/emptyrepo/issues?': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'emptyowner/emptyrepo']));
      expect(logs.some((l) => l.includes('No issues found'))).toBe(true);
    });

    it('should import pull requests with reviews', async () => {
      mockGitHubApi({
        '/repos/testowner/testrepo/pulls?': [
          { number: 200, title: 'GH PR One', body: 'Add feature', state: 'closed', merged: true, user: { login: 'alice' }, base: { ref: 'main' }, head: { ref: 'feature-a' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 201, title: 'GH PR Two', body: 'WIP', state: 'open', merged: false, user: { login: 'bob' }, base: { ref: 'main' }, head: { ref: 'feature-b' }, created_at: '2025-01-02T00:00:00Z' },
        ],
        '/repos/testowner/testrepo/pulls/200/reviews': [
          { body: 'Looks good!', state: 'APPROVED', user: { login: 'charlie' }, submitted_at: '2025-01-01T12:00:00Z' },
        ],
        '/repos/testowner/testrepo/pulls/201/reviews': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['pulls', 'testowner/testrepo']));
      expect(logs.some((l) => l.includes('#200'))).toBe(true);
      expect(logs.some((l) => l.includes('GH PR One'))).toBe(true);
      expect(logs.some((l) => l.includes('merged'))).toBe(true);
      expect(logs.some((l) => l.includes('1 review'))).toBe(true);
      expect(logs.some((l) => l.includes('#201'))).toBe(true);
      expect(logs.some((l) => l.includes('open'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 patches'))).toBe(true);
    });

    it('should handle no pull requests gracefully', async () => {
      mockGitHubApi({
        '/repos/emptyowner/emptyrepo/pulls?': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['pulls', 'emptyowner/emptyrepo']));
      expect(logs.some((l) => l.includes('No pull requests found'))).toBe(true);
    });

    it('should import releases', async () => {
      mockGitHubApi({
        '/repos/testowner/testrepo/releases': [
          { tag_name: 'v1.0.0', name: 'Stable Release', body: 'First!', prerelease: false, draft: false, target_commitish: 'main', created_at: '2025-01-01T00:00:00Z' },
          { tag_name: 'v2.0.0-rc.1', name: 'RC1', body: 'Testing', prerelease: true, draft: false, target_commitish: 'main', created_at: '2025-02-01T00:00:00Z' },
        ],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['releases', 'testowner/testrepo']));
      expect(logs.some((l) => l.includes('v1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('Stable Release'))).toBe(true);
      expect(logs.some((l) => l.includes('v2.0.0-rc.1'))).toBe(true);
      expect(logs.some((l) => l.includes('pre-release'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 releases'))).toBe(true);
    });

    it('should handle no releases gracefully', async () => {
      mockGitHubApi({
        '/repos/emptyowner/emptyrepo/releases': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['releases', 'emptyowner/emptyrepo']));
      expect(logs.some((l) => l.includes('No releases found'))).toBe(true);
    });

    it('should run full migration with migrate all', async () => {
      mockGitHubApi({
        '/repos/fullowner/fullrepo'         : { name: 'fullrepo', description: 'Test repo', default_branch: 'main', private: false, html_url: 'https://github.com/fullowner/fullrepo', topics: [] },
        '/repos/fullowner/fullrepo/issues?' : [
          { number: 1, title: 'Migration issue', body: 'test', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
        ],
        '/repos/fullowner/fullrepo/issues/1/comments' : [],
        '/repos/fullowner/fullrepo/pulls?'            : [
          { number: 2, title: 'Migration PR', body: 'test', state: 'open', merged: false, user: { login: 'bob' }, base: { ref: 'main' }, head: { ref: 'fix' }, created_at: '2025-01-01T00:00:00Z' },
        ],
        '/repos/fullowner/fullrepo/pulls/2/reviews' : [],
        '/repos/fullowner/fullrepo/releases'        : [
          { tag_name: 'v0.1.0', name: 'Alpha', body: '', prerelease: false, draft: false, target_commitish: 'main', created_at: '2025-01-01T00:00:00Z' },
        ],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['all', 'fullowner/fullrepo']));
      expect(logs.some((l) => l.includes('Migrating fullowner/fullrepo'))).toBe(true);
      // Repo already exists from `init` test, so skip.
      expect(logs.some((l) => l.includes('already exists'))).toBe(true);
      expect(logs.some((l) => l.includes('Migration complete'))).toBe(true);
      expect(logs.some((l) => l.includes('Issues:'))).toBe(true);
      expect(logs.some((l) => l.includes('Patches:'))).toBe(true);
      expect(logs.some((l) => l.includes('Releases:'))).toBe(true);
    });

    it('should fail gracefully on GitHub API error', async () => {
      // Mock a 403 Forbidden (rate limit).
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
      }) as typeof fetch;

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const { errors } = await captureError(() => migrateCommand(ctx, ['issues', 'ratelimited/repo']));
      expect(errors.some((e) => e.includes('GitHub API 403'))).toBe(true);
    });
  });
});
