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

    it('should create an issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Bug report', '--body', 'Something broke']));
      expect(logs.some((l) => l.includes('Created issue'))).toBe(true);
      expect(logs.some((l) => l.includes('Bug report'))).toBe(true);
    });

    it('should create a second issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Feature request']));
      expect(logs.some((l) => l.includes('Created issue'))).toBe(true);
    });

    it('should list all issues', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Issues (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('Bug report'))).toBe(true);
      expect(logs.some((l) => l.includes('Feature request'))).toBe(true);
    });

    it('should show empty message when no issues match filter', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['list', '--status', 'closed']));
      expect(logs.some((l) => l.includes('No issues found'))).toBe(true);
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

    it('should create a patch', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() =>
        patchCommand(ctx, ['create', 'Add feature X', '--body', 'This adds X', '--base', 'main', '--head', 'feature-x']),
      );
      expect(logs.some((l) => l.includes('Created patch'))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
    });

    it('should create a second patch with defaults', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['create', 'Fix typo']));
      expect(logs.some((l) => l.includes('Created patch'))).toBe(true);
    });

    it('should list all patches', async () => {
      const { patchCommand } = await import('../src/cli/commands/patch.js');
      const logs = await captureLog(() => patchCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Patches (2)'))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
      expect(logs.some((l) => l.includes('Fix typo'))).toBe(true);
    });
  });
});
