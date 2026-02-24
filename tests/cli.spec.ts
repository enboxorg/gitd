/**
 * CLI command tests — exercises command functions against a real Web5 agent.
 *
 * Uses `Web5.connect()` with `sync: 'off'` to create an ephemeral agent,
 * then tests each command function directly.  The agent's data directory
 * (`__TESTDATA__/cli`) is cleaned before and after the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { existsSync, rmSync } from 'node:fs';

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

describe('dwn-git CLI commands', () => {
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
      const logs = await captureLog(() => socialCommand(ctx, ['star', 'did:jwk:repoowner123']));
      expect(logs.some((l) => l.includes('Starred did:jwk:repoowner123'))).toBe(true);
    });

    it('should not double-star', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['star', 'did:jwk:repoowner123']));
      expect(logs.some((l) => l.includes('Already starred'))).toBe(true);
    });

    it('should list stars', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['stars']));
      expect(logs.some((l) => l.includes('Starred repos (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('did:jwk:repoowner123'))).toBe(true);
    });

    it('should unstar a repo', async () => {
      const { socialCommand } = await import('../src/cli/commands/social.js');
      const logs = await captureLog(() => socialCommand(ctx, ['unstar', 'did:jwk:repoowner123']));
      expect(logs.some((l) => l.includes('Unstarred did:jwk:repoowner123'))).toBe(true);
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
});
