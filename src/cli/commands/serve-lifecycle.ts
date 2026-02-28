/**
 * `gitd serve status|stop|restart|logs` — daemon lifecycle management.
 *
 * These subcommands do not require the Web5 agent.  They read the
 * lockfile and interact with the daemon process directly.
 *
 * Usage:
 *   gitd serve status     Show daemon status (PID, port, uptime, version)
 *   gitd serve stop       Stop the running daemon
 *   gitd serve restart    Stop + start the daemon in the background
 *   gitd serve logs       Tail the daemon log file
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { daemonLogPath, daemonStatus, ensureDaemon, stopDaemon } from '../../daemon/lifecycle.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveDaemonCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'status':
      return statusCmd();

    case 'stop':
      return stopCmd();

    case 'restart':
      return restartCmd();

    case 'logs':
      return logsCmd();

    default:
      console.error(`Unknown serve subcommand: ${sub}`);
      console.error('Usage: gitd serve status|stop|restart|logs');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function statusCmd(): void {
  const status = daemonStatus();

  if (!status.running) {
    console.log('Daemon is not running.');
    return;
  }

  console.log('Daemon is running.');
  console.log(`  PID:      ${status.pid}`);
  console.log(`  Port:     ${status.port}`);
  console.log(`  Uptime:   ${status.uptime}`);
  if (status.version) {
    console.log(`  Version:  ${status.version}`);
  }
  console.log(`  Started:  ${status.startedAt}`);
  console.log(`  Log:      ${daemonLogPath()}`);
}

function stopCmd(): void {
  const stopped = stopDaemon();
  if (stopped) {
    console.log('Daemon stopped.');
  } else {
    console.log('No daemon is running.');
  }
}

async function restartCmd(): Promise<void> {
  stopDaemon();
  console.log('Starting daemon...');
  try {
    const result = await ensureDaemon();
    console.log(`Daemon started on port ${result.port}.`);
  } catch (err) {
    console.error(`Failed to start daemon: ${(err as Error).message}`);
    process.exit(1);
  }
}

function logsCmd(): void {
  const logPath = daemonLogPath();

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
