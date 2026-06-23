import { readLockfile } from '../daemon/lockfile.js';

export type CliRpcRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

export type CliRpcResponse = {
  status: number;
  stdout: string;
  stderr: string;
};

const AGENT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export const CLI_RPC_PATH = '/cli';

export function cliRpcDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GITD_CLI_RPC?.toLowerCase();
  return value === 'off' || value === '0' || value === 'false';
}

export function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return {
    GITD_REPO       : env.GITD_REPO,
    GITD_REPO_OWNER : env.GITD_REPO_OWNER,
  };
}

export async function forwardCliCommandIfAvailable(
  profileName: string | undefined,
  command: string,
  args: string[],
): Promise<CliRpcResponse | undefined> {
  if (cliRpcDisabled()) { return undefined; }

  const lock = readLockfile(profileName);
  if (!lock) {
    if (process.env.GITD_DEBUG === '1') {
      console.error(`[cli-rpc] no helper lockfile for profile=${profileName ?? process.env.GITD_PROFILE ?? process.env.ENBOX_PROFILE ?? '<default>'}`);
    }
    return undefined;
  }

  try {
    if (process.env.GITD_DEBUG === '1') {
      console.error(`[cli-rpc] forwarding ${command} to 127.0.0.1:${lock.port}`);
    }
    const response = await fetch(`http://127.0.0.1:${lock.port}${CLI_RPC_PATH}`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        command,
        args,
        cwd : process.cwd(),
        env : forwardedEnv(),
      } satisfies CliRpcRequest),
      signal: AbortSignal.timeout(AGENT_COMMAND_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (process.env.GITD_DEBUG === '1') {
        console.error(`[cli-rpc] helper returned HTTP ${response.status}`);
      }
      return undefined;
    }

    const body = await response.json() as Partial<CliRpcResponse>;
    if (typeof body.status !== 'number') {
      if (process.env.GITD_DEBUG === '1') {
        console.error('[cli-rpc] helper response missing status');
      }
      return undefined;
    }

    return {
      status : body.status,
      stdout : typeof body.stdout === 'string' ? body.stdout : '',
      stderr : typeof body.stderr === 'string' ? body.stderr : '',
    };
  } catch (err) {
    if (process.env.GITD_DEBUG === '1') {
      console.error(`[cli-rpc] forwarding failed: ${(err as Error).message}`);
    }
    return undefined;
  }
}
