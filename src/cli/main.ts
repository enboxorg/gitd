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

import { cloneCommand } from './commands/clone.js';
import { connectAgent } from './agent.js';
import { initCommand } from './commands/init.js';
import { issueCommand } from './commands/issue.js';
import { logCommand } from './commands/log.js';
import { patchCommand } from './commands/patch.js';
import { repoCommand } from './commands/repo.js';
import { serveCommand } from './commands/serve.js';
import { setupCommand } from './commands/setup.js';

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
  console.log('  log                                         Show recent activity');
  console.log('  whoami                                      Show connected DID');
  console.log('  help                                        Show this message\n');
  console.log('Environment:');
  console.log('  DWN_GIT_PASSWORD  vault password (prompted if not set)');
  console.log('  DWN_GIT_PORT      server port for `serve` (default: 9418)');
  console.log('  DWN_GIT_REPOS     base path for bare repos (default: ./repos)');
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
