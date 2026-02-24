#!/usr/bin/env bun
/**
 * dwn-git CLI — decentralized forge powered by DWN protocols.
 *
 * Usage:
 *   dwn-git setup                              Configure git for DID transport
 *   dwn-git clone <did>/<repo>                 Clone a repo via DID
 *   dwn-git init <name> [--description <text>] Create a repo record + bare git repo
 *   dwn-git repo info                          Show repo metadata
 *   dwn-git repo add-collaborator <did> <role> Grant a role
 *   dwn-git repo remove-collaborator <did>     Revoke a collaborator role
 *   dwn-git issue create <title>               File an issue
 *   dwn-git issue show <number>                Show issue details + comments
 *   dwn-git issue comment <number> <body>      Add a comment to an issue
 *   dwn-git issue close <number>               Close an issue
 *   dwn-git issue list [--status <open|closed>]
 *   dwn-git patch create <title>               Open a patch (PR)
 *   dwn-git patch show <number>                Show patch details + reviews
 *   dwn-git patch comment <number> <body>      Add a comment/review
 *   dwn-git patch merge <number>               Merge a patch
 *   dwn-git patch list [--status <status>]
 *   dwn-git release create <tag>               Create a release
 *   dwn-git release show <tag>                 Show release details
 *   dwn-git release list                       List releases
 *   dwn-git ci status [<commit>]               Show latest CI status
 *   dwn-git ci create <commit>                 Create a check suite
 *   dwn-git ci run <suite-id> <name>           Add a check run
 *   dwn-git ci update <run-id> --status <s>    Update a check run status
 *   dwn-git registry publish <name> <ver> <tarball>  Publish a package version
 *   dwn-git registry info <name>               Show package details
 *   dwn-git registry versions <name>           List published versions
 *   dwn-git registry list                      List all packages
 *   dwn-git registry yank <name> <version>     Mark a version as deprecated
 *   dwn-git wiki create <slug> <title>         Create a wiki page
 *   dwn-git wiki show <slug>                   Show a wiki page
 *   dwn-git org create <name>                  Create an organization
 *   dwn-git org info                           Show org details
 *   dwn-git social star <did>                  Star a repo
 *   dwn-git social follow <did>                Follow a user
 *   dwn-git notification list [--unread]       List notifications
 *   dwn-git migrate all <owner/repo>            Import everything from GitHub
 *   dwn-git migrate issues <owner/repo>         Import issues + comments
 *   dwn-git migrate pulls <owner/repo>          Import PRs as patches
 *   dwn-git migrate releases <owner/repo>       Import releases
 *   dwn-git web [--port <port>]                Start the read-only web UI
 *   dwn-git log                                Show recent activity
 *   dwn-git serve [--port <port>]              Start the git transport server
 *   dwn-git whoami                             Show connected DID
 *
 * Environment:
 *   DWN_GIT_PASSWORD  — vault password (prompted interactively if not set)
 *   DWN_GIT_PORT      — server port for `serve` (default: 9418)
 *   DWN_GIT_REPOS     — base path for bare repos (default: ./repos)
 *
 * @module
 */

import { ciCommand } from './commands/ci.js';
import { cloneCommand } from './commands/clone.js';
import { connectAgent } from './agent.js';
import { initCommand } from './commands/init.js';
import { issueCommand } from './commands/issue.js';
import { logCommand } from './commands/log.js';
import { migrateCommand } from './commands/migrate.js';
import { notificationCommand } from './commands/notification.js';
import { orgCommand } from './commands/org.js';
import { patchCommand } from './commands/patch.js';
import { registryCommand } from './commands/registry.js';
import { releaseCommand } from './commands/release.js';
import { repoCommand } from './commands/repo.js';
import { serveCommand } from './commands/serve.js';
import { setupCommand } from './commands/setup.js';
import { socialCommand } from './commands/social.js';
import { webCommand } from './commands/web.js';
import { wikiCommand } from './commands/wiki.js';

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
  console.log('dwn-git — decentralized forge powered by DWN protocols\n');
  console.log('Commands:');
  console.log('  setup                                       Configure git for DID-based remotes');
  console.log('  clone <did>/<repo>                          Clone a repository via DID');
  console.log('  init <name>                                 Create a repo record + bare git repo');
  console.log('  serve [--port <port>]                       Start the git transport server');
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
  console.log('  patch create <title> [--base ...] [--head ...]  Open a patch (PR)');
  console.log('  patch show <number>                         Show patch details and reviews');
  console.log('  patch comment <number> <body>               Add a comment/review');
  console.log('  patch merge <number>                        Merge a patch');
  console.log('  patch close <number>                        Close a patch');
  console.log('  patch reopen <number>                       Reopen a closed patch');
  console.log('  patch list [--status <status>]              List patches');
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
  console.log('  migrate all <owner/repo>                   Import everything from GitHub');
  console.log('  migrate repo <owner/repo>                  Import repo metadata');
  console.log('  migrate issues <owner/repo>                Import issues + comments');
  console.log('  migrate pulls <owner/repo>                 Import PRs as patches + reviews');
  console.log('  migrate releases <owner/repo>              Import releases');
  console.log('');
  console.log('  web [--port <port>]                         Start read-only web UI (default: 8080)');
  console.log('');
  console.log('  log                                         Show recent activity');
  console.log('  whoami                                      Show connected DID');
  console.log('  help                                        Show this message\n');
  console.log('Environment:');
  console.log('  DWN_GIT_PASSWORD  vault password (prompted if not set)');
  console.log('  DWN_GIT_PORT      server port for `serve` (default: 9418)');
  console.log('  DWN_GIT_WEB_PORT  web UI port for `web` (default: 8080)');
  console.log('  DWN_GIT_REPOS     base path for bare repos (default: ./repos)');
  console.log('  GITHUB_TOKEN      GitHub API token for migration (optional, higher rate limits)');
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

async function getPassword(): Promise<string> {
  // Prefer env var for non-interactive use / testing.
  const env = process.env.DWN_GIT_PASSWORD;
  if (env) { return env; }

  // Interactive prompt via stdin.
  process.stdout.write('Vault password: ');
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

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // Commands that don't require the Web5 agent.
  switch (command) {
    case 'setup':
      await setupCommand(rest);
      return;

    case 'clone':
      await cloneCommand(rest);
      return;
  }

  // Commands that require the Web5 agent.
  const password = await getPassword();
  const ctx = await connectAgent(password);

  switch (command) {
    case 'init':
      await initCommand(ctx, rest);
      break;

    case 'issue':
      await issueCommand(ctx, rest);
      break;

    case 'patch':
      await patchCommand(ctx, rest);
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
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
