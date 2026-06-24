import { PUBLIC_READER_PROFILE } from '../profiles/public-reader.js';

const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  ci       : new Set(['status', 'list', 'ls', 'show']),
  issue    : new Set(['list', 'ls', 'show']),
  pr       : new Set(['list', 'ls', 'show', 'checkout', 'co']),
  patch    : new Set(['list', 'ls', 'show', 'checkout', 'co']),
  registry : new Set(['info', 'versions', 'list', 'resolve', 'verify', 'verify-deps', 'attestations']),
  release  : new Set(['list', 'ls', 'show']),
  repo     : new Set(['info', 'list', 'ls']),
  wiki     : new Set(['show', 'list', 'ls']),
};

const READ_ONLY_COMMANDS = new Set([
  'log',
  'web',
  'whoami',
]);

const LOCAL_HELPER_SUBCOMMANDS = new Set(['', 'status', 'start', 'stop', 'restart', 'logs']);

export function isPublicReaderCommandAllowed(command: string, rest: string[]): boolean {
  if (READ_ONLY_COMMANDS.has(command)) { return true; }
  if (command === 'helper') {
    return LOCAL_HELPER_SUBCOMMANDS.has(rest[0] ?? '');
  }
  if (command === 'serve') {
    return isLocalHelperServe(rest);
  }

  const allowedSubcommands = READ_ONLY_SUBCOMMANDS[command];
  if (!allowedSubcommands) { return false; }

  const subcommand = rest[0] ?? defaultReadOnlySubcommand(command);
  return allowedSubcommands.has(subcommand);
}

export function shouldBlockPublicReaderCommand(
  profileName: string | undefined,
  command: string,
  rest: string[],
): boolean {
  return profileName === PUBLIC_READER_PROFILE && !isPublicReaderCommandAllowed(command, rest);
}

export function publicReaderWriteBlockMessage(command: string, rest: string[]): string[] {
  const retry = ['gitd', command, ...rest].join(' ');
  return [
    'gitd: this repo is using the public-read cache.',
    'The public-read cache can inspect public repo data, but it cannot write issues, PRs, roles, packages, or branches.',
    '',
    'Run:',
    '  gitd auth login',
    '  gitd auth use <identity>',
    '',
    `Then retry: ${retry}`,
  ];
}

function defaultReadOnlySubcommand(command: string): string {
  if (command === 'repo') { return 'info'; }
  if (command === 'ci') { return 'status'; }
  return '';
}

function isLocalHelperServe(rest: string[]): boolean {
  if (rest.some((arg) => arg === '--public-url' || arg.startsWith('--public-url='))) {
    return false;
  }
  if (rest.includes('--publish')) {
    return false;
  }

  const subcommand = rest[0];
  if (!subcommand || subcommand.startsWith('-')) { return true; }
  return LOCAL_HELPER_SUBCOMMANDS.has(subcommand);
}
