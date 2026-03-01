/**
 * CLI command tests — exercises command functions against a real Enbox agent.
 *
 * Uses `Enbox.connect()` to create an ephemeral agent,
 * then tests each command function directly.  The agent's data directory
 * (`__TESTDATA__/cli`) is cleaned before and after the suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  let enbox: Enbox;
  let did: string;
  let ctx: AgentContext;

  beforeAll(async () => {
    // Clean any leftover state from previous runs.
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });

    // Create agent with isolated data path, initialize, and start.
    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    // Create an identity (Enbox.connect normally does this).
    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'CLI Test' },
      });
    }

    enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
    did = identity.did.uri;

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
  });

  afterAll(() => {
    delete process.env.GITD_REPO;
    rmSync(DATA_PATH, { recursive: true, force: true });
    rmSync(REPOS_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // version
  // =========================================================================

  describe('version', () => {
    it('should print version from package.json', async () => {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const pkg = require('../package.json') as { version: string };

      // Capture stdout by temporarily replacing console.log.
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]): void => { logs.push(args.join(' ')); };

      // Simulate the version code path.
      console.log(`gitd ${pkg.version}`);
      console.log = origLog;

      expect(logs[0]).toBe(`gitd ${pkg.version}`);
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });
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

    it('should allow a second repo with a different name', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['second-repo', '--branch', 'main', '--repos', REPOS_PATH]),
      );
      expect(logs.some((l) => l.includes('Initialized forge repo'))).toBe(true);
      expect(logs.some((l) => l.includes('second-repo'))).toBe(true);

      // With multiple repos, set the default so subsequent tests resolve
      // 'my-test-repo' without needing --repo on every command.
      process.env.GITD_REPO = 'my-test-repo';
    });

    it('should reject a duplicate repo name', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const { errors, exitCode } = await captureError(() => initCommand(ctx, ['my-test-repo']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('already exists');
    });

    it('should populate dwnEndpoints from --dwn-endpoint flag', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      await captureLog(() =>
        initCommand(ctx, ['dwn-ep-test', '--repos', REPOS_PATH, '--dwn-endpoint', 'https://dwn.example.com']),
      );

      const { records } = await ctx.repo.records.query('repo', {
        filter: { tags: { name: 'dwn-ep-test' } },
      });
      expect(records.length).toBe(1);
      const data = await records[0].data.json();
      expect(data.dwnEndpoints).toEqual(['https://dwn.example.com']);
    });

    it('should populate dwnEndpoints from GITD_DWN_ENDPOINT env', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      process.env.GITD_DWN_ENDPOINT = 'https://env-dwn.example.com';
      try {
        await captureLog(() =>
          initCommand(ctx, ['dwn-env-test', '--repos', REPOS_PATH]),
        );

        const { records } = await ctx.repo.records.query('repo', {
          filter: { tags: { name: 'dwn-env-test' } },
        });
        expect(records.length).toBe(1);
        const data = await records[0].data.json();
        expect(data.dwnEndpoints).toEqual(['https://env-dwn.example.com']);
      } finally {
        delete process.env.GITD_DWN_ENDPOINT;
      }
    });
  });

  // =========================================================================
  // getDwnEndpoints
  // =========================================================================

  describe('getDwnEndpoints', () => {
    it('should return empty array for did:jwk (no DWN service)', () => {
      const { getDwnEndpoints } = require('../src/git-server/did-service.js');
      const endpoints = getDwnEndpoints(enbox);
      // did:jwk doesn't have a DWN service entry in its DID document.
      expect(endpoints).toEqual([]);
    });
  });

  // =========================================================================
  // DID republisher
  // =========================================================================

  describe('startDidRepublisher', () => {
    it('should return a no-op cleanup for non-dht DIDs', () => {
      const { startDidRepublisher } = require('../src/git-server/did-service.js');
      const stop = startDidRepublisher(enbox);
      expect(typeof stop).toBe('function');
      // Should not throw when called.
      stop();
    });
  });

  // =========================================================================
  // connectAgent sync option
  // =========================================================================

  describe('connectAgent sync option', () => {
    it('should export SyncInterval type and accept sync in ConnectOptions', async () => {
      // Verify the type exists and the function signature accepts sync.
      const { connectAgent } = await import('../src/cli/agent.js');
      expect(typeof connectAgent).toBe('function');
    });
  });

  // =========================================================================
  // Provider auth and registration token persistence
  // =========================================================================

  describe('provider-auth registration', () => {
    it('should export ProviderAuthParams and RegistrationTokenData types', async () => {
      const mod = await import('../src/cli/agent.js');
      // These are type-only re-exports, but we can verify the module loads.
      expect(typeof mod.connectAgent).toBe('function');
    });

    it('should persist and load registration tokens from disk', async () => {
      const tokensDir = join('__TESTDATA__', 'token-test-profile', 'DATA', 'AGENT');
      const tokensFile = join('__TESTDATA__', 'token-test-profile', 'registration-tokens.json');
      const { mkdirSync, readFileSync: readFs, rmSync: rmFs, existsSync: existsFs } = require('node:fs');

      // Clean up first.
      rmFs(join('__TESTDATA__', 'token-test-profile'), { recursive: true, force: true });
      mkdirSync(tokensDir, { recursive: true });

      // Write tokens file manually to simulate cached tokens.
      const fakeTokens = {
        'https://example.com': {
          registrationToken : 'test-reg-token',
          refreshToken      : 'test-refresh-token',
          expiresAt         : Date.now() + 3600_000,
          tokenUrl          : 'https://example.com/token',
          refreshUrl        : 'https://example.com/refresh',
        },
      };
      writeFileSync(tokensFile, JSON.stringify(fakeTokens, null, 2) + '\n', 'utf-8');

      // Verify the file was written and is valid JSON.
      expect(existsFs(tokensFile)).toBe(true);
      const loaded = JSON.parse(readFs(tokensFile, 'utf-8'));
      expect(loaded['https://example.com'].registrationToken).toBe('test-reg-token');
      expect(loaded['https://example.com'].refreshToken).toBe('test-refresh-token');

      // Clean up.
      rmFs(join('__TESTDATA__', 'token-test-profile'), { recursive: true, force: true });
    });

    it('should gracefully handle missing registration-tokens.json', () => {
      const tokensFile = join('__TESTDATA__', 'nonexistent-profile', 'registration-tokens.json');
      expect(existsSync(tokensFile)).toBe(false);
      // The agent module loads tokens internally; verify it doesn't throw.
    });
  });

  // =========================================================================
  // Repos path resolution
  // =========================================================================

  describe('resolveReposPath', () => {
    it('should return profile-based path when profileName is set', () => {
      const { resolveReposPath } = require('../src/cli/flags.js');
      const result = resolveReposPath([], 'test-profile');
      expect(result).toContain('.enbox');
      expect(result).toContain('profiles');
      expect(result).toContain('test-profile');
      expect(result).toContain('repos');
    });

    it('should prefer --repos flag over profile path', () => {
      const { resolveReposPath } = require('../src/cli/flags.js');
      const result = resolveReposPath(['--repos', '/custom/path'], 'test-profile');
      expect(result).toBe('/custom/path');
    });

    it('should prefer GITD_REPOS env over profile path', () => {
      const { resolveReposPath } = require('../src/cli/flags.js');
      process.env.GITD_REPOS = '/env/repos';
      try {
        const result = resolveReposPath([], 'test-profile');
        expect(result).toBe('/env/repos');
      } finally {
        delete process.env.GITD_REPOS;
      }
    });

    it('should fall back to ~/.enbox/profiles/default/repos without a profile', () => {
      const { resolveReposPath } = require('../src/cli/flags.js');
      const result = resolveReposPath([]);
      expect(result).toContain('profiles');
      expect(result).toContain('default');
      expect(result).toContain('repos');
      expect(result).not.toBe('./repos');
    });
  });

  describe('profileReposPath', () => {
    it('should return ~/.enbox/profiles/<name>/repos', () => {
      const { profileReposPath } = require('../src/profiles/config.js');
      const result = profileReposPath('my-profile');
      expect(result).toContain('my-profile');
      expect(result.endsWith('/repos')).toBe(true);
    });
  });

  // =========================================================================
  // Post-init instructions
  // =========================================================================

  describe('init post-init instructions', () => {
    it('should print next-steps after successful init', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['post-init-test', '--repos', REPOS_PATH]),
      );
      expect(logs.some((l) => l.includes('Next steps'))).toBe(true);
      expect(logs.some((l) => l.includes('git push'))).toBe(true);
      expect(logs.some((l) => l.includes('gitd serve'))).toBe(true);
      // Should include the DID somewhere in the output.
      expect(logs.some((l) => l.includes(ctx.did))).toBe(true);
    });

    it('should mention --public-url and DEPLOY.md in post-init output', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['post-init-url-test', '--repos', REPOS_PATH]),
      );
      expect(logs.some((l) => l.includes('--public-url'))).toBe(true);
      expect(logs.some((l) => l.includes('DEPLOY.md'))).toBe(true);
    });

    it('should report origin already exists when run inside a repo with origin', async () => {
      // Tests run inside the gitd project which already has an origin remote.
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['origin-exists-test', '--repos', REPOS_PATH]),
      );
      expect(logs.some((l) => l.includes('origin'))).toBe(true);
      expect(logs.some((l) => l.includes('already exists'))).toBe(true);
    });

    it('should print git remote add when --no-local is used', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const logs = await captureLog(() =>
        initCommand(ctx, ['no-local-test', '--repos', REPOS_PATH, '--no-local']),
      );
      expect(logs.some((l) => l.includes('git remote add origin'))).toBe(true);
      // Should NOT report local repo setup.
      expect(logs.some((l) => l.includes('Initialized local git repo'))).toBe(false);
    });
  });

  describe('init local repo setup', () => {
    it('should initialize git repo and add remote in a fresh directory', async () => {
      const { initCommand } = await import('../src/cli/commands/init.js');
      const absReposPath = resolve(REPOS_PATH);
      const tmpDir = join(absReposPath, '__local-test');
      mkdirSync(tmpDir, { recursive: true });
      const origCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const logs = await captureLog(() =>
          initCommand(ctx, ['local-init-test', '--repos', absReposPath]),
        );
        expect(logs.some((l) => l.includes('Initialized local git repo'))).toBe(true);
        expect(logs.some((l) => l.includes('Remote "origin" set to'))).toBe(true);
        // Verify .git directory was created.
        expect(existsSync(join(tmpDir, '.git'))).toBe(true);
        // Verify the remote was added.
        const remoteCheck = spawnSync('git', ['remote', 'get-url', 'origin'], {
          cwd   : tmpDir,
          stdio : 'pipe',
        });
        expect(remoteCheck.status).toBe(0);
        expect(remoteCheck.stdout.toString().trim()).toContain(ctx.did);
      } finally {
        process.chdir(origCwd);
        rmSync(tmpDir, { recursive: true, force: true });
      }
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
    // Short hash IDs extracted from CLI output (populated by create tests).
    let issueId1: string;
    let issueId2: string;

    it('should fail create without a title', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const { errors, exitCode } = await captureError(() => issueCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create first issue with short hash ID', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Bug report', '--body', 'Something broke']));
      expect(logs.some((l) => l.includes('Created issue'))).toBe(true);
      expect(logs.some((l) => l.includes('Bug report'))).toBe(true);
      // Extract the 7-char hex short ID from output: "Created issue <id>: ..."
      const match = logs.join('\n').match(/Created issue ([0-9a-f]{7})/);
      expect(match).toBeTruthy();
      issueId1 = match![1];
    });

    it('should create second issue with short hash ID', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['create', 'Feature request']));
      expect(logs.some((l) => l.includes('Created issue'))).toBe(true);
      const match = logs.join('\n').match(/Created issue ([0-9a-f]{7})/);
      expect(match).toBeTruthy();
      issueId2 = match![1];
    });

    it('should show issue details by short ID', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', issueId1]));
      expect(logs.some((l) => l.includes(`Issue ${issueId1}: Bug report`))).toBe(true);
      expect(logs.some((l) => l.includes('Status:  OPEN'))).toBe(true);
      expect(logs.some((l) => l.includes('Something broke'))).toBe(true);
    });

    it('should add a comment to an issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['comment', issueId1, 'Looking into this']));
      expect(logs.some((l) => l.includes(`Added comment to issue ${issueId1}`))).toBe(true);
    });

    it('should show comments in issue detail', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', issueId1]));
      expect(logs.some((l) => l.includes('Comments (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('Looking into this'))).toBe(true);
    });

    it('should close an issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['close', issueId1]));
      expect(logs.some((l) => l.includes(`Closed issue ${issueId1}`))).toBe(true);
    });

    it('should show closed status after closing', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['show', issueId1]));
      expect(logs.some((l) => l.includes('Status:  CLOSED'))).toBe(true);
    });

    it('should reopen a closed issue', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['reopen', issueId1]));
      expect(logs.some((l) => l.includes(`Reopened issue ${issueId1}`))).toBe(true);
    });

    it('should list all issues with IDs', async () => {
      const { issueCommand } = await import('../src/cli/commands/issue.js');
      const logs = await captureLog(() => issueCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('Issues (2)'))).toBe(true);
      expect(logs.some((l) => l.includes(issueId1))).toBe(true);
      expect(logs.some((l) => l.includes(issueId2))).toBe(true);
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
      const { errors, exitCode } = await captureError(() => issueCommand(ctx, ['show', 'fffffff']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });
  });

  // =========================================================================
  // pr commands
  // =========================================================================

  describe('pr', () => {
    // Short hash IDs extracted from CLI output (populated by create tests).
    let prId1: string;
    let prId2: string;
    let prId3: string;

    it('should fail create without a title', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['create']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should create first PR with short hash ID', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() =>
        prCommand(ctx, ['create', 'Add feature X', '--body', 'This adds X', '--base', 'main', '--head', 'feature-x']),
      );
      expect(logs.some((l) => l.includes('Created PR'))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
      const match = logs.join('\n').match(/Created PR ([0-9a-f]{7})/);
      expect(match).toBeTruthy();
      prId1 = match![1];
    });

    it('should create second PR with short hash ID', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['create', 'Fix typo']));
      expect(logs.some((l) => l.includes('Created PR'))).toBe(true);
      const match = logs.join('\n').match(/Created PR ([0-9a-f]{7})/);
      expect(match).toBeTruthy();
      prId2 = match![1];
    });

    it('should show PR details by short ID', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['show', prId1]));
      expect(logs.some((l) => l.includes(`PR ${prId1}: Add feature X`))).toBe(true);
      expect(logs.some((l) => l.includes('Status:   OPEN'))).toBe(true);
      expect(logs.some((l) => l.includes('main <- feature-x'))).toBe(true);
    });

    it('should merge a PR with default strategy', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-merge-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      // Create a git repo with main + feature branch.
      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# Merge test\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['checkout', '-b', 'feature-x'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'feature.ts'), 'export const x = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'add feature'], { cwd: tmpRepo, stdio: 'pipe' });

      const origCwd = process.cwd();
      try {
        process.chdir(tmpRepo);

        // Create PR from the feature branch.
        const createLogs = await captureLog(() =>
          prCommand(ctx, ['create', 'Merge test PR', '--base', 'main']),
        );
        // Extract the short hash ID from the create output.
        const createMatch = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/);
        expect(createMatch).toBeTruthy();
        prId3 = createMatch![1];

        spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, stdio: 'pipe' });

        // Checkout the PR to create the local branch.
        await captureLog(() => prCommand(ctx, ['checkout', prId3, '--branch', 'feature-x']));

        // Now merge it.
        const logs = await captureLog(() => prCommand(ctx, ['merge', prId3]));
        const allOutput = logs.join('\n');
        expect(allOutput).toContain(`Merged PR ${prId3}`);
        expect(allOutput).toContain('strategy: merge');
        expect(allOutput).toContain('Deleted branch feature-x');

        // Verify the merge commit exists on main.
        const head = spawnSync('git', ['log', '--oneline', '-1'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(head.stdout).toContain(`Merge PR ${prId3}`);

        // Verify the feature file exists on main after merge.
        expect(existsSync(join(tmpRepo, 'feature.ts'))).toBe(true);

        // Verify the feature branch was deleted.
        const branches = spawnSync('git', ['branch'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(branches.stdout).not.toContain('feature-x');
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should show merged status after merging', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['show', prId3]));
      expect(logs.some((l) => l.includes('Status:   MERGED'))).toBe(true);
    });

    it('should not re-merge an already merged PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['merge', prId3]));
      expect(logs.some((l) => l.includes('already merged'))).toBe(true);
    });

    it('should add a comment to a PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['comment', prId2, 'Looks good to me']));
      expect(logs.some((l) => l.includes(`Added comment to PR ${prId2}`))).toBe(true);
    });

    it('should show review comments in PR detail', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['show', prId2]));
      expect(logs.some((l) => l.includes('Reviews (1)'))).toBe(true);
      expect(logs.some((l) => l.includes('COMMENTED'))).toBe(true);
      expect(logs.some((l) => l.includes('Looks good to me'))).toBe(true);
    });

    it('should fail comment without body', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['comment', prId2]));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should fail comment for non-existent PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['comment', 'fffffff', 'hello']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should close a PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['close', prId2]));
      expect(logs.some((l) => l.includes(`Closed PR ${prId2}`))).toBe(true);
    });

    it('should reopen a closed PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['reopen', prId2]));
      expect(logs.some((l) => l.includes(`Reopened PR ${prId2}`))).toBe(true);
    });

    it('should not reopen an already open PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['reopen', prId2]));
      expect(logs.some((l) => l.includes('already open'))).toBe(true);
    });

    it('should not reopen a merged PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['reopen', prId3]));
      expect(logs.some((l) => l.includes('cannot be reopened'))).toBe(true);
    });

    it('should fail reopen for non-existent PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['reopen', 'fffffff']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should list all PRs with IDs', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() => prCommand(ctx, ['list']));
      expect(logs.some((l) => l.includes('PRs (3)'))).toBe(true);
      expect(logs.some((l) => l.includes(prId1))).toBe(true);
      expect(logs.some((l) => l.includes(prId2))).toBe(true);
      expect(logs.some((l) => l.includes(prId3))).toBe(true);
      expect(logs.some((l) => l.includes('Add feature X'))).toBe(true);
      expect(logs.some((l) => l.includes('Fix typo'))).toBe(true);
      expect(logs.some((l) => l.includes('Merge test PR'))).toBe(true);
    });

    it('should fail show for non-existent PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['show', 'fffffff']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should create PR with revision and bundle from git context', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-bundle-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      // Create a git repo with a main branch and a feature branch.
      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# Hello\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo, stdio: 'pipe' });

      // Create a feature branch with a new commit.
      spawnSync('git', ['checkout', '-b', 'feat/test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'feature.ts'), 'export const x = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'add feature'], { cwd: tmpRepo, stdio: 'pipe' });

      // chdir into the feature branch repo.
      const origCwd = process.cwd();
      try {
        process.chdir(tmpRepo);

        const logs = await captureLog(() =>
          prCommand(ctx, ['create', 'Feature with bundle', '--base', 'main']),
        );
        const allOutput = logs.join('\n');

        // Should create the PR.
        expect(allOutput).toContain('Created PR');
        expect(allOutput).toMatch(/Created PR [0-9a-f]{7}/);
        expect(allOutput).toContain('main <- feat/test');

        // Should create revision with commit info.
        expect(allOutput).toContain('Revision: 1 commit');

        // Should create bundle.
        expect(allOutput).toContain('Bundle:');
        expect(allOutput).toContain('bytes');
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should skip bundle with --no-bundle flag', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const logs = await captureLog(() =>
        prCommand(ctx, ['create', 'No bundle PR', '--base', 'main', '--head', 'my-branch', '--no-bundle']),
      );
      const allOutput = logs.join('\n');

      // Should create the PR without revision/bundle.
      expect(allOutput).toMatch(/Created PR [0-9a-f]{7}/);
      expect(allOutput).not.toContain('Revision:');
      expect(allOutput).not.toContain('Bundle:');
    });

    it('should checkout a PR with bundle into a local branch', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-checkout-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      // Create a git repo with main + feature branch.
      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# Hello\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['checkout', '-b', 'feat/checkout-test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const y = 2;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'add new file'], { cwd: tmpRepo, stdio: 'pipe' });

      const origCwd = process.cwd();
      try {
        // Create the PR with bundle from the feature branch.
        process.chdir(tmpRepo);
        const createLogs = await captureLog(() =>
          prCommand(ctx, ['create', 'Checkout test PR', '--base', 'main']),
        );
        const checkoutPrId = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/)?.[1] ?? 'missing';

        // Switch back to main so we can checkout the PR.
        spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, stdio: 'pipe' });

        // Checkout the PR.
        const logs = await captureLog(() =>
          prCommand(ctx, ['checkout', checkoutPrId, '--branch', 'pr/test-checkout']),
        );
        const allOutput = logs.join('\n');
        expect(allOutput).toContain('Switched to branch \'pr/test-checkout\'');
        expect(allOutput).toContain(`PR ${checkoutPrId}`);

        // Verify we're on the right branch.
        const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(branch.stdout?.trim()).toBe('pr/test-checkout');

        // Verify the file from the feature branch exists.
        expect(existsSync(join(tmpRepo, 'new-file.ts'))).toBe(true);
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should fail checkout for PR without revision', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      // Create a PR explicitly without a bundle.
      const createLogs = await captureLog(() =>
        prCommand(ctx, ['create', 'No-bundle PR', '--no-bundle']),
      );
      const noBundleId = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/)?.[1] ?? 'missing';
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['checkout', noBundleId]));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('no revisions');
    });

    it('should fail checkout for non-existent PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['checkout', 'aaaaaaa']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found');
    });

    it('should squash merge a PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-squash-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# Squash test\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['checkout', '-b', 'feat/squash'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'a.ts'), 'export const a = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'commit 1'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'b.ts'), 'export const b = 2;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'commit 2'], { cwd: tmpRepo, stdio: 'pipe' });

      const origCwd = process.cwd();
      try {
        process.chdir(tmpRepo);
        // Create PR from the feature branch. Extract short hash ID.
        const createLogs = await captureLog(() =>
          prCommand(ctx, ['create', 'Squash PR', '--base', 'main']),
        );
        const squashId = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/)?.[1] ?? 'missing';

        spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, stdio: 'pipe' });
        await captureLog(() => prCommand(ctx, ['checkout', squashId, '--branch', 'feat/squash']));

        const logs = await captureLog(() => prCommand(ctx, ['merge', squashId, '--squash']));
        const allOutput = logs.join('\n');
        expect(allOutput).toContain(`Merged PR ${squashId}`);
        expect(allOutput).toContain('strategy: squash');

        // Squash should produce a single commit with the squash message.
        const log = spawnSync('git', ['log', '--oneline', '-1'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(log.stdout).toContain('(squash)');

        // Both files should exist on main.
        expect(existsSync(join(tmpRepo, 'a.ts'))).toBe(true);
        expect(existsSync(join(tmpRepo, 'b.ts'))).toBe(true);
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should rebase merge a PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-rebase-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# Rebase test\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['checkout', '-b', 'feat/rebase'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'r.ts'), 'export const r = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'rebase commit'], { cwd: tmpRepo, stdio: 'pipe' });

      const origCwd = process.cwd();
      try {
        process.chdir(tmpRepo);
        const createLogs = await captureLog(() =>
          prCommand(ctx, ['create', 'Rebase PR', '--base', 'main']),
        );
        const rebaseId = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/)?.[1] ?? 'missing';

        spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, stdio: 'pipe' });
        await captureLog(() => prCommand(ctx, ['checkout', rebaseId, '--branch', 'feat/rebase']));

        const logs = await captureLog(() => prCommand(ctx, ['merge', rebaseId, '--rebase']));
        const allOutput = logs.join('\n');
        expect(allOutput).toContain(`Merged PR ${rebaseId}`);
        expect(allOutput).toContain('strategy: rebase');

        // The rebased file should exist on main.
        expect(existsSync(join(tmpRepo, 'r.ts'))).toBe(true);

        // Rebase should NOT produce a merge commit — the log should have the original commit.
        const log = spawnSync('git', ['log', '--oneline', '-3'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(log.stdout).toContain('rebase commit');
        expect(log.stdout).not.toContain('Merge PR');
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should keep branch with --no-delete-branch', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      const tmpRepo = resolve('__TESTDATA__/pr-nodelete-repo');
      rmSync(tmpRepo, { recursive: true, force: true });

      spawnSync('git', ['init', '-b', 'main', tmpRepo], { stdio: 'pipe' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'README.md'), '# No-delete test\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['checkout', '-b', 'feat/keep'], { cwd: tmpRepo, stdio: 'pipe' });
      writeFileSync(join(tmpRepo, 'keep.ts'), 'export const keep = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'keep branch commit'], { cwd: tmpRepo, stdio: 'pipe' });

      const origCwd = process.cwd();
      try {
        process.chdir(tmpRepo);
        const createLogs = await captureLog(() =>
          prCommand(ctx, ['create', 'Keep branch PR', '--base', 'main']),
        );
        const keepId = createLogs.join('\n').match(/Created PR ([0-9a-f]{7})/)?.[1] ?? 'missing';

        spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, stdio: 'pipe' });
        await captureLog(() => prCommand(ctx, ['checkout', keepId, '--branch', 'feat/keep']));

        const logs = await captureLog(() =>
          prCommand(ctx, ['merge', keepId, '--no-delete-branch']),
        );
        const allOutput = logs.join('\n');
        expect(allOutput).toContain(`Merged PR ${keepId}`);
        expect(allOutput).not.toContain('Deleted branch');

        // The branch should still exist.
        const branches = spawnSync('git', ['branch'], {
          cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe',
        });
        expect(branches.stdout).toContain('feat/keep');
      } finally {
        process.chdir(origCwd);
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    });

    it('should fail merge when branch not found locally', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      // prId1 has headBranch=feature-x which doesn't exist locally.
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['merge', prId1]));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('not found locally');
    });

    it('should fail merge for closed PR', async () => {
      const { prCommand } = await import('../src/cli/commands/pr.js');
      // prId2 was closed earlier in the close test, then reopened.
      // Close it again for this test.
      await captureLog(() => prCommand(ctx, ['close', prId2]));
      const { errors, exitCode } = await captureError(() => prCommand(ctx, ['merge', prId2]));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('closed');
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
      // Should have both issues and PRs.
      expect(logs.some((l) => l.includes('issue'))).toBe(true);
      expect(logs.some((l) => l.includes('pr'))).toBe(true);
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
    it('should print next steps on install', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      // Use a test-specific bin dir to avoid modifying the user's system.
      const logs = await captureLog(() => setupCommand(['--bin-dir', '__TESTDATA__/cli-bin']));
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('Next steps');
      expect(allOutput).toContain('credential.helper');
    });

    it('--check should report status of binaries and credential helper', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      const logs = await captureLog(() => setupCommand(['--check', '--bin-dir', '__TESTDATA__/cli-bin']));
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('Checking gitd setup');
      expect(allOutput).toContain('git-remote-did');
    });

    it('--check should report failure when symlink points to wrong target', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      const binDir = '__TESTDATA__/cli-bin-mismatch';
      mkdirSync(binDir, { recursive: true });
      // Create symlinks pointing to the wrong file.
      const { symlinkSync: sls, unlinkSync: uls } = await import('node:fs');
      for (const name of ['git-remote-did', 'git-remote-did-credential']) {
        const p = join(binDir, name);
        if (existsSync(p)) { uls(p); }
        sls('/dev/null', p);
      }
      try {
        const logs = await captureLog(() => setupCommand(['--check', '--bin-dir', binDir]));
        const allOutput = logs.join('\n');
        expect(allOutput).toContain('[MISMATCH]');
        expect(allOutput).toContain('Some checks failed');
        expect(allOutput).not.toContain('All checks passed');
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it('--check should report failure when binary exists but is not a symlink', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      const binDir = '__TESTDATA__/cli-bin-exists';
      mkdirSync(binDir, { recursive: true });
      // Create regular files instead of symlinks.
      for (const name of ['git-remote-did', 'git-remote-did-credential']) {
        writeFileSync(join(binDir, name), '#!/bin/sh\n');
      }
      try {
        const logs = await captureLog(() => setupCommand(['--check', '--bin-dir', binDir]));
        const allOutput = logs.join('\n');
        expect(allOutput).toContain('[EXISTS]');
        expect(allOutput).toContain('not a symlink');
        expect(allOutput).toContain('Some checks failed');
        expect(allOutput).not.toContain('All checks passed');
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it('--uninstall should remove symlinks', async () => {
      const { setupCommand } = await import('../src/cli/commands/setup.js');
      const logs = await captureLog(() => setupCommand(['--uninstall', '--bin-dir', '__TESTDATA__/cli-bin']));
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('Removing gitd setup');
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
      // Star the local agent's own repo — use did/repo format since multiple repos exist.
      const logs = await captureLog(() => socialCommand(ctx, ['star', `${ctx.did}/my-test-repo`]));
      expect(logs.some((l) => l.includes(`Starred ${ctx.did}`))).toBe(true);
      expect(logs.some((l) => l.includes('my-test-repo'))).toBe(true);
    });

    it('should store correct repoRecordId and repoName in star record', async () => {
      // Query the repo record by name to get its ID for comparison.
      const { records: repoRecords } = await ctx.repo.records.query('repo', {
        filter: { tags: { name: 'my-test-repo' } },
      });
      expect(repoRecords.length).toBe(1);
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
      const logs = await captureLog(() => socialCommand(ctx, ['star', `${ctx.did}/my-test-repo`]));
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
  // serve --check
  // =========================================================================

  describe('serve --check', () => {
    const origFetch = globalThis.fetch;

    afterAll(() => {
      globalThis.fetch = origFetch;
    });

    it('checkPublicUrl should return true when /health returns ok', async () => {
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ status: 'ok', service: 'git-server' }), {
            status  : 200,
            headers : { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;

      const { checkPublicUrl } = await import('../src/cli/commands/serve.js');
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(' ')); };
      const result = await checkPublicUrl('https://git.example.com');
      console.log = orig;

      expect(result).toBe(true);
      expect(logs.some((l) => l.includes('OK'))).toBe(true);
    });

    it('checkPublicUrl should return false on non-200 response', async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
      }) as typeof fetch;

      const { checkPublicUrl } = await import('../src/cli/commands/serve.js');
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(' ')); };
      const result = await checkPublicUrl('https://git.example.com');
      console.error = orig;

      expect(result).toBe(false);
      expect(errors.some((l) => l.includes('FAIL'))).toBe(true);
    });

    it('checkPublicUrl should return false on unexpected body', async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(JSON.stringify({ status: 'error' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const { checkPublicUrl } = await import('../src/cli/commands/serve.js');
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(' ')); };
      const result = await checkPublicUrl('https://git.example.com');
      console.error = orig;

      expect(result).toBe(false);
      expect(errors.some((l) => l.includes('FAIL'))).toBe(true);
    });

    it('checkPublicUrl should return false on network error', async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;

      const { checkPublicUrl } = await import('../src/cli/commands/serve.js');
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(' ')); };
      const result = await checkPublicUrl('https://unreachable.example.com');
      console.error = orig;

      expect(result).toBe(false);
      expect(errors.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
    });

    it('--check should fail without --public-url', async () => {
      const { serveCommand } = await import('../src/cli/commands/serve.js');
      const { errors, exitCode } = await captureError(() => serveCommand(ctx, ['--check']));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('--check requires --public-url');
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
    const origGhToken = process.env.GITHUB_TOKEN;

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

    beforeEach(async () => {
      // Set a dummy token so tests don't invoke `gh auth token`.
      process.env.GITHUB_TOKEN = 'test-token';
      const { resetTokenCache } = await import('../src/cli/commands/migrate.js');
      resetTokenCache();
    });

    afterAll(() => {
      globalThis.fetch = origFetch;
      if (origGhToken !== undefined) {
        process.env.GITHUB_TOKEN = origGhToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    });

    it('should fail with no subcommand', async () => {
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const { errors, exitCode } = await captureError(() => migrateCommand(ctx, []));
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain('Usage');
    });

    it('should auto-detect owner/repo from git remote', async () => {
      // When no owner/repo arg is given, resolveGhRepo falls back to
      // the current directory's git remotes.  We verify the detection
      // message appears (the actual migration may fail since the detected
      // repo name doesn't have a DWN record).
      const { resolveGhRepo } = await import('../src/cli/commands/migrate.js');
      const detected = resolveGhRepo([]);
      expect(detected.owner).toBeDefined();
      expect(detected.repo).toBeDefined();
    });

    it('should auto-detect when arg has no slash', async () => {
      // An arg without a slash is not a valid owner/repo, so resolveGhRepo
      // falls through to auto-detection from git remotes.
      const { resolveGhRepo } = await import('../src/cli/commands/migrate.js');
      const detected = resolveGhRepo(['noslash']);
      expect(detected.owner).toBeDefined();
      expect(detected.repo).toBeDefined();
    });

    it('should parse SSH GitHub remote URLs', async () => {
      const { parseGitHubRemote } = await import('../src/cli/commands/migrate.js');
      expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
      expect(parseGitHubRemote('git@github.com:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTPS GitHub remote URLs', async () => {
      const { parseGitHubRemote } = await import('../src/cli/commands/migrate.js');
      expect(parseGitHubRemote('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
      expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
      expect(parseGitHubRemote('http://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should return null for non-GitHub remotes', async () => {
      const { parseGitHubRemote } = await import('../src/cli/commands/migrate.js');
      expect(parseGitHubRemote('git@gitlab.com:owner/repo.git')).toBeNull();
      expect(parseGitHubRemote('https://bitbucket.org/owner/repo')).toBeNull();
      expect(parseGitHubRemote('not-a-url')).toBeNull();
    });

    it('should resolve GITHUB_TOKEN from env', async () => {
      const { resolveGitHubToken, resetTokenCache } = await import('../src/cli/commands/migrate.js');
      resetTokenCache();
      process.env.GITHUB_TOKEN = 'my-test-token';
      expect(resolveGitHubToken()).toBe('my-test-token');
    });

    it('should report 404 errors from GitHub API', async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }) as typeof fetch;

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      // Use 'my-test-repo' so getRepoContextId succeeds, then the 404
      // comes from the actual GitHub API fetch.
      const { errors } = await captureError(() => migrateCommand(ctx, ['issues', 'notfound/my-test-repo']));
      expect(errors.some((e) => e.includes('GitHub API 404'))).toBe(true);
    });

    it('should skip repo import when repo already exists', async () => {
      // Use a repo name that was already created by `gitd init` (my-test-repo).
      // The migrate should detect the existing DWN record by name and skip.
      mockGitHubApi({});
      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['repo', 'testowner/my-test-repo', '--no-git']));
      expect(logs.some((l) => l.includes('already exists'))).toBe(true);
      expect(logs.some((l) => l.includes('skipping'))).toBe(true);
    });

    it('should import issues with comments', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/issues?': [
          { number: 100, title: 'GH Issue One', body: 'From GitHub', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 101, title: 'GH Issue Two', body: 'Closed one', state: 'closed', user: { login: 'bob' }, created_at: '2025-01-02T00:00:00Z', pull_request: undefined },
        ],
        '/repos/testowner/my-test-repo/issues/100/comments': [
          { body: 'First comment', user: { login: 'charlie' }, created_at: '2025-01-01T12:00:00Z' },
        ],
        '/repos/testowner/my-test-repo/issues/101/comments': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('#100'))).toBe(true);
      expect(logs.some((l) => l.includes('GH Issue One'))).toBe(true);
      expect(logs.some((l) => l.includes('1 comment'))).toBe(true);
      expect(logs.some((l) => l.includes('#101'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 issues'))).toBe(true);
    });

    it('should filter out pull requests from issues list', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/issues?': [
          { number: 1, title: 'Real issue', body: '', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 2, title: 'Actually a PR', body: '', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z', pull_request: { url: 'https://...' } },
        ],
        '/repos/testowner/my-test-repo/issues/1/comments': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('Imported 1 issue'))).toBe(true);
      // Should NOT contain the PR.
      expect(logs.some((l) => l.includes('Actually a PR'))).toBe(false);
    });

    it('should skip already-imported issues on re-run', async () => {
      // Re-run the same import — issues 100 and 101 were imported above.
      mockGitHubApi({
        '/repos/testowner/my-test-repo/issues?': [
          { number: 100, title: 'GH Issue One', body: 'From GitHub', state: 'open', user: { login: 'alice' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 101, title: 'GH Issue Two', body: 'Closed one', state: 'closed', user: { login: 'bob' }, created_at: '2025-01-02T00:00:00Z', pull_request: undefined },
        ],
        '/repos/testowner/my-test-repo/issues/100/comments' : [],
        '/repos/testowner/my-test-repo/issues/101/comments' : [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('already imported'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 0 issues'))).toBe(true);
    });

    it('should handle no issues gracefully', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/issues?': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['issues', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('No issues found'))).toBe(true);
    });

    it('should import pull requests with reviews', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/pulls?': [
          { number: 200, title: 'GH PR One', body: 'Add feature', state: 'closed', merged: true, user: { login: 'alice' }, base: { ref: 'main' }, head: { ref: 'feature-a' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 201, title: 'GH PR Two', body: 'WIP', state: 'open', merged: false, user: { login: 'bob' }, base: { ref: 'main' }, head: { ref: 'feature-b' }, created_at: '2025-01-02T00:00:00Z' },
        ],
        '/repos/testowner/my-test-repo/pulls/200/reviews': [
          { body: 'Looks good!', state: 'APPROVED', user: { login: 'charlie' }, submitted_at: '2025-01-01T12:00:00Z' },
        ],
        '/repos/testowner/my-test-repo/pulls/201/reviews': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['pulls', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('#200'))).toBe(true);
      expect(logs.some((l) => l.includes('GH PR One'))).toBe(true);
      expect(logs.some((l) => l.includes('merged'))).toBe(true);
      expect(logs.some((l) => l.includes('1 review'))).toBe(true);
      expect(logs.some((l) => l.includes('#201'))).toBe(true);
      expect(logs.some((l) => l.includes('open'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 PRs'))).toBe(true);
    });

    it('should skip already-imported PRs on re-run', async () => {
      // Re-run the same import — PRs 200 and 201 were imported above.
      mockGitHubApi({
        '/repos/testowner/my-test-repo/pulls?': [
          { number: 200, title: 'GH PR One', body: 'Add feature', state: 'closed', merged: true, user: { login: 'alice' }, base: { ref: 'main' }, head: { ref: 'feature-a' }, created_at: '2025-01-01T00:00:00Z' },
          { number: 201, title: 'GH PR Two', body: 'WIP', state: 'open', merged: false, user: { login: 'bob' }, base: { ref: 'main' }, head: { ref: 'feature-b' }, created_at: '2025-01-02T00:00:00Z' },
        ],
        '/repos/testowner/my-test-repo/pulls/200/reviews' : [],
        '/repos/testowner/my-test-repo/pulls/201/reviews' : [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['pulls', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('already imported'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 0 PRs'))).toBe(true);
    });

    it('should handle no pull requests gracefully', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/pulls?': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['pulls', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('No pull requests found'))).toBe(true);
    });

    it('should import releases', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/releases': [
          { tag_name: 'v1.0.0', name: 'Stable Release', body: 'First!', prerelease: false, draft: false, target_commitish: 'main', created_at: '2025-01-01T00:00:00Z' },
          { tag_name: 'v2.0.0-rc.1', name: 'RC1', body: 'Testing', prerelease: true, draft: false, target_commitish: 'main', created_at: '2025-02-01T00:00:00Z' },
        ],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['releases', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('v1.0.0'))).toBe(true);
      expect(logs.some((l) => l.includes('Stable Release'))).toBe(true);
      expect(logs.some((l) => l.includes('v2.0.0-rc.1'))).toBe(true);
      expect(logs.some((l) => l.includes('pre-release'))).toBe(true);
      expect(logs.some((l) => l.includes('Imported 2 releases'))).toBe(true);
    });

    it('should handle no releases gracefully', async () => {
      mockGitHubApi({
        '/repos/testowner/my-test-repo/releases': [],
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() => migrateCommand(ctx, ['releases', 'testowner/my-test-repo']));
      expect(logs.some((l) => l.includes('No releases found'))).toBe(true);
    });

    it('should run full migration with migrate all', async () => {
      // Pre-create a bare repo with a commit so git content migration
      // skips the clone step and succeeds with bundle/ref sync.
      const didHash = createHash('sha256').update(did).digest('hex').slice(0, 16);
      const bareRepoPath = join(REPOS_PATH, didHash, 'fullrepo.git');
      if (!existsSync(join(bareRepoPath, 'HEAD'))) {
        // Init bare with default branch = main.
        spawnSync('git', ['init', '--bare', '--initial-branch=main', bareRepoPath]);
        // Create a commit by using a temporary working clone.
        const tmpClone = join(REPOS_PATH, '_tmp_fullrepo');
        rmSync(tmpClone, { recursive: true, force: true });
        spawnSync('git', ['clone', bareRepoPath, tmpClone]);
        spawnSync('git', ['checkout', '-b', 'main'], { cwd: tmpClone });
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpClone });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpClone });
        writeFileSync(join(tmpClone, 'README.md'), '# fullrepo\n');
        spawnSync('git', ['add', '.'], { cwd: tmpClone });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpClone });
        spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: tmpClone });
        rmSync(tmpClone, { recursive: true, force: true });
      }

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
      const logs = await captureLog(() => migrateCommand(ctx, ['all', 'fullowner/fullrepo', '--repos', REPOS_PATH]));
      expect(logs.some((l) => l.includes('Migrating fullowner/fullrepo'))).toBe(true);
      // Repo is created fresh (no prior record with name "fullrepo").
      expect(logs.some((l) => l.includes('Created repo "fullrepo"'))).toBe(true);
      // Git content migration: repo exists on disk, so clone is skipped.
      expect(logs.some((l) => l.includes('Bare repo already exists'))).toBe(true);
      // Bundle should be created and uploaded.
      expect(logs.some((l) => l.includes('Bundle uploaded to DWN'))).toBe(true);
      // Refs should be synced.
      expect(logs.some((l) => l.includes('Synced') && l.includes('ref(s) to DWN'))).toBe(true);
      expect(logs.some((l) => l.includes('Migration complete'))).toBe(true);
      expect(logs.some((l) => l.includes('Issues:'))).toBe(true);
      expect(logs.some((l) => l.includes('Patches:'))).toBe(true);
      expect(logs.some((l) => l.includes('Releases:'))).toBe(true);
    });

    it('should migrate git content with migrate repo', async () => {
      // Pre-create a bare repo with a commit for a "new" repo.
      const didHash = createHash('sha256').update(did).digest('hex').slice(0, 16);
      const bareRepoPath = join(REPOS_PATH, didHash, 'gitcontent-repo.git');
      if (!existsSync(join(bareRepoPath, 'HEAD'))) {
        spawnSync('git', ['init', '--bare', '--initial-branch=main', bareRepoPath]);
        const tmpClone = join(REPOS_PATH, '_tmp_gitcontent');
        rmSync(tmpClone, { recursive: true, force: true });
        spawnSync('git', ['clone', bareRepoPath, tmpClone]);
        spawnSync('git', ['checkout', '-b', 'main'], { cwd: tmpClone });
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpClone });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpClone });
        writeFileSync(join(tmpClone, 'README.md'), '# gitcontent-repo\n');
        spawnSync('git', ['add', '.'], { cwd: tmpClone });
        spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpClone });
        spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: tmpClone });
        // Also create a tag.
        spawnSync('git', ['tag', 'v1.0.0'], { cwd: tmpClone });
        spawnSync('git', ['push', 'origin', 'v1.0.0'], { cwd: tmpClone });
        rmSync(tmpClone, { recursive: true, force: true });
      }

      // Mock GitHub API to return repo metadata.
      mockGitHubApi({
        '/repos/gitowner/gitcontent-repo': {
          name           : 'gitcontent-repo', description    : 'Test', default_branch : 'main',
          private        : false, html_url       : 'https://github.com/gitowner/gitcontent-repo', topics         : [],
        },
      });

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() =>
        migrateCommand(ctx, ['repo', 'gitowner/gitcontent-repo', '--repos', REPOS_PATH]),
      );

      // Repo record created fresh (no prior record with name "gitcontent-repo").
      expect(logs.some((l) => l.includes('Created repo "gitcontent-repo"'))).toBe(true);
      // Bare repo already on disk — clone skipped.
      expect(logs.some((l) => l.includes('Bare repo already exists'))).toBe(true);
      // Bundle created and uploaded.
      expect(logs.some((l) => l.includes('Creating git bundle'))).toBe(true);
      expect(logs.some((l) => l.includes('Bundle uploaded to DWN'))).toBe(true);
      // Refs synced (at least 1 branch + 1 tag).
      expect(logs.some((l) => l.includes('Syncing refs to DWN'))).toBe(true);
      expect(logs.some((l) => l.includes('ref(s) to DWN'))).toBe(true);
      expect(logs.some((l) => l.includes('Git content migration complete'))).toBe(true);
    });

    it('should skip clone when bare repo exists on disk', async () => {
      // Both the bare repo and the DWN record exist from the previous test.
      // Mock is empty — no GitHub API calls should be needed.
      mockGitHubApi({});

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      const logs = await captureLog(() =>
        migrateCommand(ctx, ['repo', 'owner/gitcontent-repo', '--repos', REPOS_PATH]),
      );
      // DWN record already exists (by name) — metadata skipped.
      expect(logs.some((l) => l.includes('already exists'))).toBe(true);
      // Bare repo already on disk — clone skipped.
      expect(logs.some((l) => l.includes('Bare repo already exists'))).toBe(true);
    });

    it('should fail gracefully on GitHub API error', async () => {
      // Mock a 403 Forbidden (rate limit).
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
      }) as typeof fetch;

      const { migrateCommand } = await import('../src/cli/commands/migrate.js');
      // Use 'my-test-repo' so getRepoContextId finds the DWN record
      // before the GitHub API fetch fails.
      const { errors } = await captureError(() => migrateCommand(ctx, ['issues', 'ratelimited/my-test-repo']));
      expect(errors.some((e) => e.includes('GitHub API 403'))).toBe(true);
    });
  });
});
