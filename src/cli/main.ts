#!/usr/bin/env bun
/**
 * gitd CLI — decentralized forge powered by DWN protocols.
 *
 * Usage:
 *   gitd setup                              Configure git for DID transport
 *   gitd clone <did>/<repo>                 Clone a repo via DID
 *   gitd init <name> [--description <text>] Create a repo record + bare git repo
 *   gitd repo info                          Show repo metadata
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
 *   gitd serve [--port <port>] [--check]    Start the git transport server
 *   gitd whoami                             Show connected DID
 *
 * Environment:
 *   GITD_PASSWORD  — vault password (prompted interactively if not set)
 *   GITD_PORT      — server port for `serve` (default: 9418)
 *   GITD_REPOS     — base path for bare repos (default: ./repos)
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { authCommand } from './commands/auth.js';
import { ciCommand } from './commands/ci.js';
import { cloneCommand } from './commands/clone.js';
import { connectAgent } from './agent.js';
import { daemonCommand } from './commands/daemon.js';
import { flagValue } from './flags.js';
import { githubApiCommand } from './commands/github-api.js';
import { indexerCommand } from '../indexer/main.js';
import { initCommand } from './commands/init.js';
import { issueCommand } from './commands/issue.js';
import { logCommand } from './commands/log.js';
import { migrateCommand } from './commands/migrate.js';
import { notificationCommand } from './commands/notification.js';
import { orgCommand } from './commands/org.js';
import { prCommand } from './commands/pr.js';
import { registryCommand } from './commands/registry.js';
import { releaseCommand } from './commands/release.js';
import { repoCommand } from './commands/repo.js';
import { serveCommand } from './commands/serve.js';
import { setupCommand } from './commands/setup.js';
import { shimCommand } from './commands/shim.js';
import { socialCommand } from './commands/social.js';
import { webCommand } from './commands/web.js';
import { wikiCommand } from './commands/wiki.js';
import { checkGit, requireGit, warnGit } from './preflight.js';
import { profileDataPath, resolveProfile } from '../profiles/config.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log('gitd — decentralized forge powered by DWN protocols\n');
  console.log('Commands:');
  console.log('  auth                                        Show current identity info');
  console.log('  auth login                                  Create or import an identity');
  console.log('  auth list                                   List all profiles');
  console.log('  auth use <profile> [--global]               Set active profile');
  console.log('');
  console.log('  setup [--check | --uninstall]                Configure git for DID-based remotes');
  console.log('  clone <did>/<repo>                          Clone a repository via DID');
  console.log('  init <name>                                 Create a repo record + bare git repo');
  console.log('  serve [--port <port>] [--check]              Start the git transport server');
  console.log('');
  console.log('  repo info                                   Show repo metadata');
  console.log('  repo add-collaborator <did> <role>          Grant a role (maintainer|triager|contributor)');
  console.log('  repo remove-collaborator <did>              Revoke a collaborator role');
  console.log('');
  console.log('  issue create <title> [--body <text>]        File an issue');
  console.log('  issue show <number>                         Show issue details and comments');
  console.log('  issue comment <number> <body>               Add a comment to an issue');
  console.log('  issue close <number>                        Close an issue');
  console.log('  issue reopen <number>                       Reopen a closed issue');
  console.log('  issue list [--status <open|closed>]         List issues');
  console.log('');
  console.log('  pr create <title> [--base ...] [--head ...]     Open a pull request');
  console.log('  pr show <number>                               Show PR details and reviews');
  console.log('  pr comment <number> <body>                     Add a comment/review');
  console.log('  pr merge <number> [--squash|--rebase]           Merge a PR with actual git merge');
  console.log('  pr close <number>                              Close a PR');
  console.log('  pr reopen <number>                             Reopen a closed PR');
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
  console.log('  GITD_PASSWORD      vault password (prompted if not set)');
  console.log('  GITD_PORT          server port for `serve` (default: 9418)');
  console.log('  GITD_WEB_PORT      web UI port for `web` (default: 8080)');
  console.log('  GITD_REPOS         base path for bare repos (default: ~/.enbox/profiles/<name>/repos/)');
  console.log('  GITD_PUBLIC_URL    public URL for `serve` (enables DID service registration)');
  console.log('  GITD_SYNC          DWN sync interval: off|5s|30s|1m (default: 30s for serve, off otherwise)');
  console.log('  GITD_DWN_ENDPOINT  DWN endpoint URL for repo records');
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

async function getPassword(): Promise<string> {
  // Prefer env var for non-interactive use / testing.
  const env = process.env.GITD_PASSWORD;
  if (env) { return env; }

  // Interactive prompt — hide input when running in a TTY.
  process.stdout.write('Vault password: ');

  if (process.stdin.isTTY) {
    // Raw mode: read character-by-character, echo nothing.
    const password = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.resume();

      const onData = (ch: string): void => {
        const code = ch.charCodeAt(0);

        if (ch === '\r' || ch === '\n') {
          // Enter — done.
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
        } else if (code === 3) {
          // Ctrl-C — abort.
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (code === 127 || code === 8) {
          // Backspace / Delete.
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
          }
        } else if (code >= 32) {
          // Printable character.
          buf += ch;
        }
      };

      process.stdin.on('data', onData);
    });
    return password;
  }

  // Non-TTY fallback (piped input).
  const response = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk: string) => {
      buf += chunk;
      resolve(buf.trim());
    });
    process.stdin.resume();
  });
  return response;
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

  // All functional commands require git.
  requireGit();

  // Commands that don't require the Web5 agent.
  switch (command) {
    case 'setup':
      await setupCommand(rest);
      return;

    case 'clone':
      await cloneCommand(rest);
      return;

    case 'auth':
      // Auth can run without a pre-existing profile (for `login`).
      await authCommand(null, rest);
      return;
  }

  // Commands that require the Web5 agent.
  const password = await getPassword();
  const profileFlag = flagValue(rest, '--profile');
  const profileName = resolveProfile(profileFlag);
  const dataPath = profileName ? profileDataPath(profileName) : undefined;

  // Resolve DWN sync interval.
  // Long-running commands default to '30s'; one-shot commands default to 'off'.
  const longRunning = ['serve', 'web', 'daemon', 'indexer', 'github-api', 'shim'].includes(command);
  const syncDefault = longRunning ? '30s' : 'off';
  const noSync = rest.includes('--no-sync');
  const syncEnv = process.env.GITD_SYNC;
  const syncFlag = flagValue(rest, '--sync');
  const sync = noSync ? 'off' : (syncFlag ?? syncEnv ?? syncDefault);

  const ctx = await connectAgent({ password, dataPath, sync: sync as any });
  ctx.profileName = profileName ?? undefined;

  switch (command) {
    case 'init':
      await initCommand(ctx, rest);
      break;

    case 'issue':
      await issueCommand(ctx, rest);
      break;

    case 'pr':
    case 'patch':
      await prCommand(ctx, rest);
      break;

    case 'repo':
      await repoCommand(ctx, rest);
      break;

    case 'serve':
      await serveCommand(ctx, rest);
      break;

    case 'release':
      await releaseCommand(ctx, rest);
      break;

    case 'registry':
      await registryCommand(ctx, rest);
      break;

    case 'ci':
      await ciCommand(ctx, rest);
      break;

    case 'wiki':
      await wikiCommand(ctx, rest);
      break;

    case 'org':
      await orgCommand(ctx, rest);
      break;

    case 'social':
      await socialCommand(ctx, rest);
      break;

    case 'notification':
    case 'notifications':
      await notificationCommand(ctx, rest);
      break;

    case 'migrate':
      await migrateCommand(ctx, rest);
      break;

    case 'web':
      await webCommand(ctx, rest);
      break;

    case 'indexer':
      await indexerCommand(ctx, rest);
      break;

    case 'daemon':
      await daemonCommand(ctx, rest);
      break;

    case 'github-api':
      await githubApiCommand(ctx, rest);
      break;

    case 'shim':
      await shimCommand(ctx, rest);
      break;

    case 'log':
      await logCommand(ctx, rest);
      break;

    case 'whoami':
      console.log(ctx.did);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }

  // One-shot commands reach here after completing.  The Web5 agent keeps
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
