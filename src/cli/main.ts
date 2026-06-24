#!/usr/bin/env bun
/**
 * gitd CLI — decentralized forge powered by DWN protocols.
 *
 * Usage:
 *   gitd setup                              Configure git for DID transport
 *   gitd clone <did>/<repo>                 Clone a repo via DID
 *   gitd init <name> [--description <text>] Create a repo record + bare git repo
 *   gitd repo info                          Show repo metadata
 *   gitd repo add-moderator <did>           Grant moderator role
 *   gitd repo remove-moderator <did>        Revoke moderator role
 *   gitd mod add <did>                      Grant moderator role
 *   gitd mod remove <did>                   Revoke moderator role
 *   gitd mod list                           List moderators
 *   gitd mod block <did>                    Block a DID from repo interaction
 *   gitd mod lock pr <id>                   Lock a PR discussion
 *   gitd mod hide-comment <id>              Hide a comment in canonical views
 *   gitd repo add-contributor <did>         Grant contributor role
 *   gitd repo remove-contributor <did>      Revoke contributor role
 *   gitd repo add-collaborator <did> <role> Grant a role
 *   gitd repo remove-collaborator <did>     Revoke a collaborator role
 *   gitd issue create <title>               File an issue
 *   gitd issue show <number>                Show issue details + comments
 *   gitd issue comment <number> <body>      Add a comment to an issue
 *   gitd issue close <number>               Close an issue
 *   gitd issue list [--status <open|closed>]
 *   gitd pr create <title>                  Open a pull request
 *   gitd pr checkout <number>               Fetch bundle + create branch
 *   gitd pr show <number>                   Show PR details + reviews
 *   gitd pr comment <number> <body>         Add a comment/review
 *   gitd pr merge <number>                  Merge a PR
 *   gitd pr list [--status <status>]
 *   gitd release create <tag>               Create a release
 *   gitd release show <tag>                 Show release details
 *   gitd release list                       List releases
 *   gitd ci status [<commit>]               Show latest CI status
 *   gitd ci create <commit>                 Create a check suite
 *   gitd ci run <suite-id> <name>           Add a check run
 *   gitd ci update <run-id> --status <s>    Update a check run status
 *   gitd registry publish <name> <ver> <tarball>  Publish a package version
 *   gitd registry info <name>               Show package details
 *   gitd registry versions <name>           List published versions
 *   gitd registry list                      List all packages
 *   gitd registry yank <name> <version>     Mark a version as deprecated
 *   gitd registry attest <name> <ver> --claim <c>  Create attestation
 *   gitd registry attestations <name> <ver> List attestations
 *   gitd registry verify <name> <ver>       Verify a package version
 *   gitd registry resolve <did>/<name>@<ver> Resolve a remote package
 *   gitd registry verify-deps <did>/<name>@<ver> Verify trust chain
 *   gitd wiki create <slug> <title>         Create a wiki page
 *   gitd wiki show <slug>                   Show a wiki page
 *   gitd org create <name>                  Create an organization
 *   gitd org info                           Show org details
 *   gitd social star <did>                  Star a repo
 *   gitd social follow <did>                Follow a user
 *   gitd notification list [--unread]       List notifications
 *   gitd migrate all [owner/repo]             Import everything from GitHub
 *   gitd migrate issues [owner/repo]          Import issues + comments
 *   gitd migrate pulls [owner/repo]           Import PRs as patches
 *   gitd migrate releases [owner/repo]        Import releases
 *   gitd web [--port <port>]                Start the read-only web UI
 *   gitd indexer [--port] [--interval] [--seed]  Start the indexer service
 *   gitd daemon [--config <path>] [--only ...] Start unified shim daemon
 *   gitd github-api [--port <port>]         Start GitHub API compatibility shim
 *   gitd shim npm [--port 4873]             Start npm registry proxy
 *   gitd shim go  [--port 4874]             Start Go module proxy (GOPROXY)
 *   gitd shim oci [--port 5555]             Start OCI/Docker registry proxy
 *   gitd log                                Show recent activity
 *   gitd helper status                      Show local helper status
 *   gitd helper start                       Start the local helper
 *   gitd auth sessions                      List active local helper sessions
 *   gitd auth revoke helper                 Revoke the active helper session
 *   gitd publish --public-url <url>         Publish a public GitTransport endpoint
 *   gitd serve --public-url <url>           Publish a public GitTransport endpoint
 *   gitd doctor                             Diagnose local setup
 *   gitd repair                             Repair local setup
 *   gitd whoami                             Show connected DID
 *
 * Environment:
 *   GITD_PASSWORD  — identity unlock password (prompted interactively if not set)
 *   GITD_PORT      — local helper/GitTransport port (default: 9418)
 *   GITD_REPOS     — base path for bare repos (default: ./repos)
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

import type { FirstIdentitySetup } from './identity-wizard.js';
import type { ResolvedPassword } from '../auth/vault-password.js';

import { authCommand } from './commands/auth.js';
import { cloneCommand } from './commands/clone.js';
import { connectAgent } from './agent.js';
import { dispatchAgentCommand } from './dispatch.js';
import { doctorCommand } from './commands/doctor.js';
import { flagValue } from './flags.js';
import { forwardCliCommandIfAvailable } from './local-rpc.js';
import { repairCommand } from './commands/repair.js';
import { setupCommand } from './commands/setup.js';
import { checkGit, requireGit, warnGit } from './preflight.js';
import { createFirstIdentityFromSetup, maybePromptForFirstIdentitySetup } from './identity-wizard.js';
import { ensureDaemon, findGitdBin, markDeferredDaemonStart } from '../daemon/lifecycle.js';
import { forgetVaultSecret, rememberVaultSecret, resolveVaultPassword } from '../auth/vault-password.js';
import { helperCommand, serveDaemonCommand } from './commands/serve-lifecycle.js';
import { printImplicitRecoveryPhrase, recordConnectedProfile, resolveCommandProfile } from './profile-session.js';
import { publicReaderWriteBlockMessage, shouldBlockPublicReaderCommand } from './public-reader-guard.js';
import { serveLocalHelperAliasLines, shouldStartLocalHelperFromServe } from './serve-ux.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

const HELPER_START_DELAY_ENV = 'GITD_HELPER_START_DELAY_MS';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log('gitd — decentralized forge powered by DWN protocols\n');
  console.log('Commands:');
  console.log('  auth                                        Show current identity info');
  console.log('  auth login                                  Create or import an identity');
  console.log('  auth list                                   List identities');
  console.log('  auth switch <identity>                      Set default identity');
  console.log('  auth use <identity> [--global]              Set active identity');
  console.log('  auth sessions                               List active local helper sessions');
  console.log('  auth revoke helper                          Revoke the active helper session');
  console.log('');
  console.log('  setup [--check | --uninstall]                Configure git for DID-based remotes');
  console.log('  doctor                                      Diagnose local setup');
  console.log('  repair                                      Repair local wrappers, git config, and helper locks');
  console.log('  clone <did>/<repo>                          Clone a repository via DID');
  console.log('  init <name>                                 Create a repo record + bare git repo');
  console.log('  helper status                               Show local helper status');
  console.log('  helper start                                Start the local helper');
  console.log('  helper stop                                 Stop the local helper');
  console.log('  helper restart                              Restart the local helper');
  console.log('  helper logs                                 Tail local helper logs');
  console.log('  publish --public-url <url>                  Publish a public GitTransport endpoint');
  console.log('  serve --public-url <url> [--foreground]     Publish a public GitTransport endpoint');
  console.log('  serve status                                Alias for helper status');
  console.log('  serve stop                                  Alias for helper stop');
  console.log('  serve restart                               Alias for helper restart');
  console.log('  serve logs                                  Alias for helper logs');
  console.log('');
  console.log('  repo info                                   Show repo metadata');
  console.log('  repo add-moderator <did>                    Grant moderator role');
  console.log('  repo remove-moderator <did>                 Revoke moderator role');
  console.log('  repo add-contributor <did>                  Grant contributor role');
  console.log('  repo remove-contributor <did>               Revoke contributor role');
  console.log('  repo add-collaborator <did> <role>          Grant a role (maintainer|moderator|contributor|viewer)');
  console.log('  repo remove-collaborator <did>              Revoke a collaborator role');
  console.log('  mod add <did> [--alias <name>]              Grant moderator role');
  console.log('  mod remove <did>                            Revoke moderator role');
  console.log('  mod list                                    List moderators');
  console.log('  mod block <did> [--reason <text>]           Block repo interaction');
  console.log('  mod unblock <did>                           Remove a repo block');
  console.log('  mod lock <issue|pr> <id>                    Lock a discussion');
  console.log('  mod unlock <issue|pr> <id>                  Unlock a discussion');
  console.log('  mod hide-comment <id> [--kind issue|pr]     Hide a comment');
  console.log('  mod delete-comment <id> [--kind issue|pr]   Tombstone a comment');
  console.log('  mod report <record-id>                      Report repo content');
  console.log('  mod resolve-report <id>                     Resolve a report');
  console.log('  mod interaction-limit <mode>                Set interaction limit');
  console.log('');
  console.log('  issue create <title> [--body <text>]        File an issue');
  console.log('  issue show <number>                         Show issue details and comments');
  console.log('  issue comment <number> <body>               Add a comment to an issue');
  console.log('  issue close <number>                        Close an issue');
  console.log('  issue reopen <number>                       Reopen a closed issue');
  console.log('  issue accept <did> <id>                     Accept an external issue submission');
  console.log('  issue ignore <did> <id>                     Ignore an external issue submission');
  console.log('  issue list [--status <open|closed>]         List issues');
  console.log('');
  console.log('  pr create <title> [--base ...] [--head ...] [--push|--no-push] Open a pull request');
  console.log('  pr show <number>                               Show PR details and reviews');
  console.log('  pr comment <number> <body>                     Add a comment/review');
  console.log('  pr merge <number> [--squash|--rebase]           Merge a PR with actual git merge');
  console.log('  pr close <number>                              Close a PR');
  console.log('  pr reopen <number>                             Reopen a closed PR');
  console.log('  pr accept <did> <id>                           Accept an external PR submission');
  console.log('  pr ignore <did> <id>                           Ignore an external PR submission');
  console.log('  pr list [--status <status>]                    List PRs');
  console.log('');
  console.log('  release create <tag> [--name ...] [--body ...]  Create a release');
  console.log('  release show <tag>                          Show release details + assets');
  console.log('  release list                                List releases');
  console.log('');
  console.log('  ci status [<commit>]                        Show latest CI status');
  console.log('  ci list                                     List recent check suites');
  console.log('  ci show <suite-id>                          Show check suite + runs');
  console.log('  ci create <commit> [--app <name>]           Create a check suite');
  console.log('  ci run <suite-id> <name>                   Add a check run to a suite');
  console.log('  ci update <run-id> --status <status>       Update a check run status');
  console.log('');
  console.log('  registry publish <name> <ver> <tarball>     Publish a package version');
  console.log('  registry info <name>                        Show package details');
  console.log('  registry versions <name>                    List published versions');
  console.log('  registry list [--ecosystem <eco>]           List all packages');
  console.log('  registry yank <name> <version>              Mark a version as deprecated');
  console.log('  registry attest <name> <ver> --claim <c>    Create an attestation');
  console.log('  registry attestations <name> <version>      List attestations');
  console.log('  registry verify <name> <version>            Verify a package version');
  console.log('  registry resolve <did>/<name>@<ver>         Resolve a remote package');
  console.log('  registry verify-deps <did>/<name>@<ver>     Verify dependency trust chain');
  console.log('');
  console.log('  wiki create <slug> <title> [--body ...]     Create a wiki page');
  console.log('  wiki show <slug>                            Show a wiki page');
  console.log('  wiki edit <slug> --body <markdown>          Edit a wiki page');
  console.log('  wiki list                                   List wiki pages');
  console.log('');
  console.log('  org create <name>                           Create an organization');
  console.log('  org info                                    Show org details');
  console.log('  org add-member <did>                        Add a member');
  console.log('  org team create <name>                      Create a team');
  console.log('');
  console.log('  social star <did>                           Star a repo');
  console.log('  social unstar <did>                         Remove a star');
  console.log('  social stars                                List starred repos');
  console.log('  social follow <did>                         Follow a user');
  console.log('  social following                            List followed users');
  console.log('');
  console.log('  notification list [--unread]                List notifications');
  console.log('  notification read <id>                      Mark as read');
  console.log('  notification clear                          Clear read notifications');
  console.log('');
  console.log('  migrate all [owner/repo]                    Import everything from GitHub');
  console.log('  migrate repo [owner/repo]                   Import repo metadata');
  console.log('  migrate issues [owner/repo]                 Import issues + comments');
  console.log('  migrate pulls [owner/repo]                  Import PRs + reviews');
  console.log('  migrate releases [owner/repo]               Import releases');
  console.log('');
  console.log('  web [--port <port>]                         Start read-only web UI (default: 8080)');
  console.log('');
  console.log('  indexer [--port <port>] [--interval <sec>]  Start the indexer service');
  console.log('  indexer --seed <did>                        Discover DIDs from a seed');
  console.log('');
  console.log('  daemon [--config <path>] [--only ...]        Start all shims in one process');
  console.log('  daemon --list                               List available shim adapters');
  console.log('');
  console.log('  github-api [--port <port>]                  Start GitHub API shim (default: 8181)');
  console.log('');
  console.log('  shim npm [--port 4873]                      Start npm registry proxy');
  console.log('  shim go  [--port 4874]                      Start Go module proxy (GOPROXY)');
  console.log('  shim oci [--port 5555]                      Start OCI/Docker registry proxy');
  console.log('');
  console.log('  log                                         Show recent activity');
  console.log('  whoami                                      Show connected DID');
  console.log('  help                                        Show this message\n');
  console.log('Environment:');
  console.log('  GITD_PASSWORD      identity unlock password (prompted if not set)');
  console.log('  GITD_PROFILE       active identity profile (alias: ENBOX_PROFILE)');
  console.log('  GITD_PORT          local helper/GitTransport port (default: 9418)');
  console.log('  GITD_WEB_PORT      web UI port for `web` (default: 8080)');
  console.log('  GITD_REPOS         base path for bare repos (default: ~/.enbox/profiles/<name>/repos/)');
  console.log('  GITD_PUBLIC_URL    public URL for `serve` (enables DID service registration)');
  console.log('  GITD_SYNC          DWN sync interval: off|5s|30s|1m (default: 30s for serve, off otherwise)');
  console.log('  GITD_DWN_REGISTRATION=off  skip remote DWN registration');
  console.log('  GITD_DID_REPUBLISH=off     skip DID DHT republishing in serve');
  console.log('  GITD_DWN_ENDPOINT   DWN endpoint URL for repo records and agent sync');
  console.log('  GITD_DWN_ENDPOINTS  comma-separated DWN endpoint URLs for agent sync');
  console.log('  GITD_DID_RESOLUTION_TIMEOUT_MS  DID lookup timeout before local-helper fallback');
  console.log('  GITD_CLI_RPC=off    disable one-shot command forwarding to a running local helper');
  console.log('  GITD_INDEXER_PORT      indexer API port (default: 8090)');
  console.log('  GITD_INDEXER_INTERVAL  crawl interval in seconds (default: 60)');
  console.log('  GITD_GITHUB_API_PORT   GitHub API shim port (default: 8181)');
  console.log('  GITD_NPM_SHIM_PORT    npm shim port (default: 4873)');
  console.log('  GITD_GO_SHIM_PORT     Go proxy shim port (default: 4874)');
  console.log('  GITD_OCI_SHIM_PORT    OCI registry shim port (default: 5555)');
  console.log('  GITHUB_TOKEN       GitHub API token for migration (auto-detected from gh CLI)');
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * Resolve the vault password for a command and, on a verified unlock, cache a
 * freshly entered secret so later commands don't re-prompt.
 *
 * Resolution and caching live in `../auth/vault-password.js`; this wrapper
 * keeps the call sites terse while threading the active profile name through.
 */
async function resolveCommandPassword(
  profileName: string | undefined,
  explicit?: string,
): Promise<ResolvedPassword> {
  return resolveVaultPassword({ profileName, explicit });
}

async function maybeDelayHelperStart(args: string[]): Promise<void> {
  if (args[0] !== 'start') { return; }
  const raw = process.env[HELPER_START_DELAY_ENV];
  if (!raw) { return; }
  const delayMs = Number.parseInt(raw, 10);
  if (!Number.isFinite(delayMs) || delayMs <= 0) { return; }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isTransientHelperLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Database is not open')
    || message.includes('LEVEL_LOCKED')
    || message.includes('LOCK');
}

function scheduleDeferredHelperStart(password: string, profileName?: string): boolean {
  const gitdBin = findGitdBin();
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITD_PASSWORD            : password,
    [HELPER_START_DELAY_ENV] : '250',
  };
  if (profileName) {
    env.GITD_PROFILE = profileName;
  }

  const child = spawn(gitdBin.command, [
    ...gitdBin.prefix,
    'helper',
    'start',
    ...(profileName ? ['--profile', profileName] : []),
  ], {
    detached : true,
    stdio    : 'ignore',
    env,
  });

  child.unref();
  markDeferredDaemonStart(profileName);
  return true;
}

async function connectAgentWithRetry(options: Parameters<typeof connectAgent>[0]): ReturnType<typeof connectAgent> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await connectAgent(options);
    } catch (err) {
      lastError = err;
      if (!isTransientHelperLockError(err)) { throw err; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function shouldAutoStartHelperAfterCommand(commandName: string, commandArgs: string[]): boolean {
  if (commandName === 'whoami') { return false; }
  if (commandName === 'init' && commandArgs.includes('--no-local')) { return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printVersion(): void {
  // Walk up from the current file to find package.json.
  // Works from both src/cli/main.ts and dist/esm/cli/main.js.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as { version: string };
      console.log(`gitd ${pkg.version}`);
      return;
    } catch {
      dir = dirname(dir);
    }
  }
  console.log('gitd (unknown version)');
}

async function main(): Promise<void> {
  if (command === '--version' || command === '-v' || command === 'version') {
    printVersion();
    warnGit(checkGit());
    return;
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    warnGit(checkGit());
    return;
  }

  if (command === 'doctor') {
    await doctorCommand(rest);
    return;
  }

  // All functional commands require git.
  requireGit();

  // Commands that don't require the Enbox agent.
  switch (command) {
    case 'setup':
      await setupCommand(rest);
      return;

    case 'repair':
      await repairCommand(rest);
      return;

    case 'clone':
      await cloneCommand(rest);
      return;

    case 'auth':
      // Auth can run without a pre-existing identity (for `login`).
      await authCommand(null, rest);
      return process.exit(0);

    case 'helper':
      await maybeDelayHelperStart(rest);
      await helperCommand(rest);
      return;

    case 'serve':
      // Lifecycle subcommands don't need the agent.
      if (rest[0] === 'status' || rest[0] === 'start' || rest[0] === 'stop' || rest[0] === 'restart' || rest[0] === 'logs') {
        await serveDaemonCommand(rest);
        return;
      }

      // Compatibility alias: bare `gitd serve` still starts the local helper,
      // but public publishing flags must fall through to the agent-backed
      // GitTransport path.
      if (shouldStartLocalHelperFromServe(rest)) {
        const setup = await maybePromptForFirstIdentitySetup('serve', rest, flagValue(rest, '--profile'));
        if (setup) {
          await createFirstIdentityFromSetup(setup);
        }
        let profileName: string | undefined;
        try {
          profileName = setup?.profileName ?? resolveCommandProfile(flagValue(rest, '--profile')).name;
        } catch (err) {
          console.error(`gitd: ${(err as Error).message}`);
          process.exit(1);
        }
        const resolved = await resolveCommandPassword(profileName, setup?.password);
        try {
          const result = await ensureDaemon(resolved.password, { profileName });
          await rememberVaultSecret(profileName, resolved);
          for (const line of serveLocalHelperAliasLines(result.spawned, result.port)) {
            console.log(line);
          }
        } catch (err) {
          if (resolved.source === 'keychain' && profileName) {
            await forgetVaultSecret(profileName);
          }
          console.error(`Failed to start local helper: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }
      break; // Fall through to agent-requiring path for foreground serve.
  }

  const profileFlag = flagValue(rest, '--profile');
  let commandProfile: ReturnType<typeof resolveCommandProfile>;
  try {
    commandProfile = resolveCommandProfile(profileFlag);
  } catch (err) {
    console.error(`gitd: ${(err as Error).message}`);
    process.exit(1);
  }
  let profileName = commandProfile.name;

  if (shouldBlockPublicReaderCommand(profileName ?? undefined, command, rest)) {
    for (const line of publicReaderWriteBlockMessage(command, rest)) {
      console.error(line);
    }
    process.exit(1);
  }

  // Resolve DWN sync interval.
  // Long-running commands default to '30s'; one-shot commands default to 'off'.
  const longRunning = ['serve', 'publish', 'web', 'daemon', 'indexer', 'github-api', 'shim'].includes(command);
  const syncDefault = longRunning ? '30s' : 'off';
  const noSync = rest.includes('--no-sync');
  const syncEnv = process.env.GITD_SYNC;
  const syncFlag = flagValue(rest, '--sync');
  const sync = noSync ? 'off' : (syncFlag ?? syncEnv ?? syncDefault);

  let firstIdentitySetup: FirstIdentitySetup | undefined;
  if (!longRunning) {
    firstIdentitySetup = await maybePromptForFirstIdentitySetup(command, rest, profileFlag);
    if (firstIdentitySetup) {
      commandProfile = {
        name     : firstIdentitySetup.profileName,
        dataPath : firstIdentitySetup.dataPath,
      };
      profileName = commandProfile.name;
    }
  }

  if (!longRunning) {
    const forwarded = await forwardCliCommandIfAvailable(profileName ?? undefined, command, rest);
    if (forwarded) {
      if (forwarded.stdout) { process.stdout.write(forwarded.stdout); }
      if (forwarded.stderr) { process.stderr.write(forwarded.stderr); }
      process.exit(forwarded.status);
    }
  }

  // Commands that require the Enbox agent.
  const resolved = await resolveCommandPassword(profileName, firstIdentitySetup?.password);

  let ctx: Awaited<ReturnType<typeof connectAgentWithRetry>>;
  try {
    ctx = await connectAgentWithRetry({
      password       : resolved.password,
      dataPath       : commandProfile.dataPath,
      sync           : sync as any,
      recoveryPhrase : firstIdentitySetup?.recoveryPhrase,
    });
  } catch (err) {
    if (resolved.source === 'keychain' && profileName) {
      await forgetVaultSecret(profileName);
      console.error('gitd: the cached unlock secret was rejected and cleared. Re-run the command to re-enter it.');
    }
    throw err;
  }
  await rememberVaultSecret(profileName, resolved);
  const recordedProfile = recordConnectedProfile(profileName, ctx.did);
  ctx.profileName = profileName;

  if (recordedProfile.created && ctx.recoveryPhrase) {
    printImplicitRecoveryPhrase(recordedProfile.name, ctx.recoveryPhrase);
    console.log('');
  }

  let completed = false;
  try {
    if (command === 'whoami') {
      console.log(ctx.did);
    } else {
      await dispatchAgentCommand(ctx, command, rest);
    }
    completed = true;
  } finally {
    if (!longRunning) {
      try {
        await ctx.close?.();
      } catch (err) {
        console.error(`[agent] Could not release local identity resources: ${(err as Error).message}`);
      }
    }
  }

  // For one-shot commands, ensure the background helper is running after the
  // foreground agent has released its LevelDB handles. This keeps `git push`
  // and native `git clone did::...` working immediately after commands such as
  // `gitd init` without hiding first-run recovery phrase output in the helper.
  if (completed && !longRunning && shouldAutoStartHelperAfterCommand(command, rest)) {
    try {
      await ensureDaemon(resolved.password, { profileName: profileName ?? undefined });
    } catch (err) {
      if (isTransientHelperLockError(err) && scheduleDeferredHelperStart(resolved.password, profileName ?? undefined)) {
        process.exit(0);
      }
      // Non-fatal — warn but don't block the command.
      console.error('[helper] Could not start local helper. Run `gitd helper start` manually for push/clone.');
    }
  }

  // One-shot commands reach here after completing.  The Enbox agent keeps
  // LevelDB stores and other handles open, which prevents the process from
  // exiting naturally.  Long-running commands (serve, web, daemon, indexer,
  // github-api, shim) never reach this point because they block on an
  // infinite promise internally.
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
