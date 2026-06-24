/**
 * Local helper lifecycle management.
 *
 * These subcommands do not require the Web5 agent.  They read the
 * lockfile and interact with the daemon process directly.
 *
 * Usage:
 *   gitd helper status    Show local helper status
 *   gitd helper start     Start the local helper
 *   gitd helper stop      Stop the local helper
 *   gitd helper restart   Stop + start the local helper
 *   gitd helper logs      Tail the helper log file
 *
 * Compatibility:
 *   gitd serve status     Alias for helper status
 *   gitd serve stop       Alias for helper stop
 *   gitd serve restart    Alias for helper restart
 *   gitd serve logs       Alias for helper logs
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { flagValue } from '../flags.js';
import { getVaultPassword } from '../../git-remote/tty-prompt.js';
import { resolveCommandProfile } from '../profile-session.js';
import { createFirstIdentityFromSetup, maybePromptForFirstIdentitySetup } from '../identity-wizard.js';
import { daemonLogPath, daemonStatus, ensureDaemon, stopDaemon } from '../../daemon/lifecycle.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveDaemonCommand(args: string[]): Promise<void> {
  return lifecycleCommand(args, 'serve');
}

export async function helperCommand(args: string[]): Promise<void> {
  return lifecycleCommand(args, 'helper');
}

async function lifecycleCommand(args: string[], surface: 'serve' | 'helper'): Promise<void> {
  const sub = lifecycleSubcommand(args);
  let profileName: string | undefined;
  try {
    profileName = resolveLifecycleProfileName(args);
  } catch (err) {
    console.error(`gitd: ${(err as Error).message}`);
    process.exit(1);
  }

  switch (sub) {
    case undefined:
    case 'status':
      return statusCmd(surface, profileName);

    case 'start':
      return startCmd(surface, args, profileName);

    case 'stop':
      return stopCmd(surface, profileName);

    case 'restart':
      return restartCmd(surface, args, profileName);

    case 'logs':
      return logsCmd(profileName);

    default:
      console.error(`Unknown ${surface} subcommand: ${sub}`);
      console.error(`Usage: gitd ${surface} status|start|stop|restart|logs`);
      process.exit(1);
  }
}

function lifecycleSubcommand(args: string[]): string | undefined {
  const first = args[0];
  if (!first || first.startsWith('-')) { return undefined; }
  return first;
}

export function resolveLifecycleProfileName(args: string[]): string {
  return resolveCommandProfile(flagValue(args, '--profile')).name;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function label(_surface: 'serve' | 'helper'): string {
  return 'Local helper';
}

function expiryLabel(policy: string | undefined): string | undefined {
  if (policy === 'helper-lifetime') { return 'when helper stops'; }
  return policy;
}

function repoContextLine(context: NonNullable<ReturnType<typeof daemonStatus>['repoContexts']>[number]): string {
  const branch = context.defaultBranch ? ` (${context.defaultBranch})` : '';
  const path = context.path ? ` at ${context.path}` : '';
  return `${context.ownerDid}/${context.repo}${branch}${path}`;
}

function statusCmd(surface: 'serve' | 'helper', profileName?: string): void {
  const status = daemonStatus({ profileName });

  if (!status.running) {
    console.log(`${label(surface)} is not running.`);
    return;
  }

  console.log(`${label(surface)} is running.`);
  console.log(`  PID:      ${status.pid}`);
  console.log(`  Port:     ${status.port}`);
  console.log(`  Uptime:   ${status.uptime}`);
  if (status.sessionId) {
    console.log(`  Session:  ${status.sessionId}`);
  }
  if (status.profileName) {
    console.log(`  Profile:  ${status.profileName}`);
  }
  if (status.ownerDid) {
    console.log(`  DID:      ${status.ownerDid}`);
  }
  if (status.version) {
    console.log(`  Version:  ${status.version}`);
  }
  if (status.reposPath) {
    console.log(`  Repos:    ${status.reposPath}`);
  }
  if (status.capabilities?.length) {
    console.log('  Capabilities:');
    for (const capability of status.capabilities) {
      console.log(`    - ${capability}`);
    }
  } else if (status.dwnHelper) {
    console.log('  Capabilities: dwn-restore');
  }
  const expiry = expiryLabel(status.expiryPolicy);
  if (expiry) {
    console.log(`  Expires:  ${expiry}`);
  }
  if (status.repoContexts?.length) {
    console.log('  Seen repos:');
    for (const context of status.repoContexts) {
      console.log(`    - ${repoContextLine(context)}`);
    }
  }
  console.log(`  Started:  ${status.startedAt}`);
  console.log(`  Log:      ${daemonLogPath(profileName)}`);
}

async function helperStartCredentials(
  surface: 'serve' | 'helper',
  args: string[],
  profileName?: string,
): Promise<{ password?: string; profileName?: string }> {
  const setup = await maybePromptForFirstIdentitySetup(surface, args, flagValue(args, '--profile'));
  if (!setup) {
    return {
      password: getVaultPassword() ?? undefined,
      profileName,
    };
  }

  await createFirstIdentityFromSetup(setup);
  return {
    password    : setup.password,
    profileName : setup.profileName,
  };
}

async function startCmd(surface: 'serve' | 'helper', args: string[], profileName?: string): Promise<void> {
  const status = daemonStatus({ profileName });
  if (status.running) {
    console.log(`${label(surface)} is already running on port ${status.port}.`);
    return;
  }

  console.log(`Starting ${label(surface).toLowerCase()}...`);
  try {
    const credentials = await helperStartCredentials(surface, args, profileName);
    const result = await ensureDaemon(credentials.password, { profileName: credentials.profileName });
    console.log(`${label(surface)} started on port ${result.port}.`);
  } catch (err) {
    console.error(`Failed to start ${label(surface).toLowerCase()}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function stopCmd(surface: 'serve' | 'helper', profileName?: string): void {
  const stopped = stopDaemon({ profileName });
  if (stopped) {
    console.log(`${label(surface)} stopped.`);
  } else {
    console.log(`No ${label(surface).toLowerCase()} is running.`);
  }
}

async function restartCmd(surface: 'serve' | 'helper', args: string[], profileName?: string): Promise<void> {
  stopDaemon({ profileName });
  console.log(`Starting ${label(surface).toLowerCase()}...`);
  try {
    const credentials = await helperStartCredentials(surface, args, profileName);
    const result = await ensureDaemon(credentials.password, { profileName: credentials.profileName });
    console.log(`${label(surface)} started on port ${result.port}.`);
  } catch (err) {
    console.error(`Failed to start ${label(surface).toLowerCase()}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function logsCmd(profileName?: string): void {
  const logPath = daemonLogPath(profileName);

  if (!existsSync(logPath)) {
    console.log(`No log file found at ${logPath}`);
    console.log('The daemon has not been started yet, or logs have been cleared.');
    return;
  }

  console.log(`Tailing ${logPath} (Ctrl+C to stop)\n`);

  const tail = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));

  process.on('SIGINT', () => {
    tail.kill();
    process.exit(0);
  });
}
