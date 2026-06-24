import { flagValue, hasFlag } from './flags.js';

type Env = Record<string, string | undefined>;

export function serveUsesPublicTransport(args: string[], env: Env = process.env): boolean {
  return Boolean(flagValue(args, '--public-url') ?? env.GITD_PUBLIC_URL) || hasFlag(args, '--check');
}

export function shouldStartLocalHelperFromServe(args: string[], env: Env = process.env): boolean {
  if (env.GITD_DAEMON_BACKGROUND === '1') { return false; }
  if (hasFlag(args, '--foreground')) { return false; }
  return !serveUsesPublicTransport(args, env);
}

export function serveLocalHelperAliasLines(spawned: boolean, port: number): string[] {
  const state = spawned
    ? `Local helper started on port ${port}.`
    : `Local helper is already running on port ${port}.`;

  return [
    '`gitd serve` without --public-url is a compatibility alias for the local helper.',
    'Prefer `gitd helper start` for local Git/DWN work.',
    state,
    'Run `gitd helper status` for details, `gitd helper logs` to tail output.',
  ];
}
