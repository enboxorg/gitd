#!/usr/bin/env bun
/**
 * dwn-git CLI — decentralized forge powered by DWN protocols.
 *
 * Usage:
 *   dwn-git init <name> [--description <text>] [--branch <name>]
 *   dwn-git issue create <title> [--body <text>]
 *   dwn-git issue list [--status <open|closed>]
 *   dwn-git patch create <title> [--body <text>] [--base <branch>] [--head <branch>]
 *   dwn-git patch list [--status <draft|open|closed|merged>]
 *
 * Environment:
 *   DWN_GIT_PASSWORD  — vault password (prompted interactively if not set)
 *
 * @module
 */

import { connectAgent } from './agent.js';
import { initCommand } from './commands/init.js';
import { issueCommand } from './commands/issue.js';
import { patchCommand } from './commands/patch.js';

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
  console.log('Usage:');
  console.log('  dwn-git init <name>               Create a repo record');
  console.log('  dwn-git issue create <title>       File an issue');
  console.log('  dwn-git issue list                 List issues');
  console.log('  dwn-git patch create <title>       Open a patch (PR)');
  console.log('  dwn-git patch list                 List patches');
  console.log('  dwn-git whoami                     Show connected DID');
  console.log('  dwn-git help                       Show this message\n');
  console.log('Environment:');
  console.log('  DWN_GIT_PASSWORD  vault password (prompted if not set)');
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
