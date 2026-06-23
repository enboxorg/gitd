/**
 * `gitd serve` — start the git transport sidecar server.
 *
 * Starts a smart HTTP git server that serves bare repositories and
 * authenticates pushes using DID-signed tokens. After each successful
 * push, git refs are mirrored to DWN records via ForgeRefsProtocol and
 * a git bundle is synced to a DWN record via ForgeRepoProtocol.
 *
 * Multi-repo: ref/bundle sync is resolved per-push using the repo name
 * from the push URL. Each repo has its own contextId in the DWN.
 *
 * Usage: gitd serve [--port <port>] [--repos <path>] [--prefix <path>]
 *                       [--public-url <url>] [--check]
 *
 * Environment:
 *   GITD_PORT        — server port (default: 9418)
 *   GITD_REPOS       — base path for bare repos (default: ./repos)
 *   GITD_PREFIX      — URL path prefix (default: none)
 *   GITD_PUBLIC_URL  — public URL for the server (enables DID service registration)
 *
 * @module
 */

import type { AgentContext } from '../agent.js';
import type { DidDocument } from '@enbox/dids';
import type { EnboxPlatformAgent } from '@enbox/agent';
import type { PushRefUpdate } from '../../git-server/push-updates.js';
import type { CliRpcRequest, CliRpcResponse } from '../local-rpc.js';

import { rmSync } from 'node:fs';

import { createBundleSyncer } from '../../git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../../git-server/verify.js';
import { createDwnPushAuthorizer } from '../../git-server/push-authorizer.js';
import { createGitServer } from '../../git-server/server.js';
import { createRefSyncer } from '../../git-server/ref-sync.js';
import { dispatchAgentCommand } from '../dispatch.js';
import { getVersion } from '../../version.js';
import { isContributorBranchRef } from '../../branch-state.js';
import { restoreFromBundles } from '../../git-server/bundle-restore.js';
import { syncRemoteBranchPush } from '../../git-server/remote-branch-sync.js';
import { withRepoLock } from '../../git-server/repo-mutex.js';
import { applyMessageToDwnEndpoint, applyRecordToDwnEndpoint } from '../record-send.js';
import {
  createPushAuthenticator,
  createPushTokenPayload,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
} from '../../git-server/auth.js';
import { flagValue, hasFlag, parsePort, resolveReposPath } from '../flags.js';
import { fromOpt, getRepoContext, getRepoContextForDid } from '../repo-context.js';
import {
  getDwnEndpoints,
  registerGitService,
  startDidRepublisher,
} from '../../git-server/did-service.js';
import { removeLockfile, writeLockfile } from '../../daemon/lockfile.js';


// ---------------------------------------------------------------------------
// Public URL check
// ---------------------------------------------------------------------------

/** Timeout in ms for the `--check` connectivity probe. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Probe the `--public-url` to verify that it is reachable from the
 * outside.  Hits the `/health` endpoint and expects a JSON response
 * with `{ status: 'ok' }`.
 *
 * @returns `true` if the probe succeeded, `false` otherwise
 */
export async function checkPublicUrl(publicUrl: string): Promise<boolean> {
  const healthUrl = publicUrl.replace(/\/$/, '') + '/health';
  console.log(`Checking public URL reachability: ${healthUrl}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`  FAIL: HTTP ${res.status} ${res.statusText}`);
      return false;
    }

    const body = await res.json() as { status?: string };
    if (body.status !== 'ok') {
      console.error(`  FAIL: unexpected response body: ${JSON.stringify(body)}`);
      return false;
    }

    console.log('  OK: /health returned status ok');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL: ${msg}`);
    return false;
  }
}

async function getLocalDidDocuments(ctx: AgentContext): Promise<Map<string, DidDocument>> {
  const documents = new Map<string, DidDocument>();
  const agent = ctx.enbox.agent as EnboxPlatformAgent;
  try {
    const connectedDid = await resolveConnectedBearerDid(agent, ctx.did);
    if (connectedDid) {
      const portableDid = await connectedDid.export?.();
      const document = portableDid?.document ?? connectedDid.document;
      if (document) {
        documents.set(connectedDid.uri, document);
      }
    }
  } catch {
    // identity.list below and resolver lookup can still handle it.
  }

  try {
    const identities = await agent.identity.list();
    for (const identity of identities) {
      documents.set(identity.did.uri, identity.did.document);
    }
  } catch {
    // Resolver lookup still handles non-local DIDs.
  }
  return documents;
}

async function resolveConnectedBearerDid(agent: EnboxPlatformAgent, did: string): Promise<any | undefined> {
  if (agent.agentDid?.uri === did) {
    return agent.agentDid;
  }

  const storedDid = await agent.did.get({ didUri: did, tenant: agent.agentDid?.uri });
  if (storedDid) {
    return storedDid;
  }

  const identities = await agent.identity.list();
  return identities.find((identity) => identity.did.uri === did)?.did;
}

async function syncLocalDwn(ctx: AgentContext, direction: 'push' | 'pull', label: string): Promise<void> {
  const agent = ctx.enbox.agent as unknown as {
    sync?: { sync?: (direction: 'push' | 'pull') => Promise<unknown> };
  };

  try {
    await agent.sync?.sync?.(direction);
  } catch (err) {
    console.error(`[dwn-sync] ${label} failed: ${(err as Error).message}`);
  }
}

function createEndpointRecordSender(
  ctx: AgentContext,
  label: string,
  protocolMessage?: any,
): (record: any, targetDid: string) => Promise<void> {
  const dwnEndpoints = getDwnEndpoints(ctx.enbox);
  const configuredTargets = new Set<string>();

  return async (record: any, targetDid: string): Promise<void> => {
    if (dwnEndpoints.length === 0) {
      debugLog(`[dwn-send] ${label}: no endpoint configured, using record.send for ${record.id ?? '<unknown>'}`);
      const status = await record.send(targetDid);
      if (status.code >= 300) {
        throw new Error(`${label} failed: ${status.code} ${status.detail ?? ''}`.trim());
      }
      return;
    }

    for (const endpoint of dwnEndpoints) {
      const configureKey = `${endpoint} ${targetDid}`;
      if (protocolMessage && !configuredTargets.has(configureKey)) {
        debugLog(`[dwn-send] ${label}: applying protocol to ${targetDid} via ${endpoint}`);
        await applyMessageToDwnEndpoint(endpoint, targetDid, protocolMessage, `${label} protocol`);
        configuredTargets.add(configureKey);
      }
      debugLog(`[dwn-send] ${label}: applying ${record.id ?? '<unknown>'} to ${targetDid} via ${endpoint} descriptor=${JSON.stringify(record.rawMessage?.descriptor ?? {})}`);
      await applyRecordToDwnEndpoint(endpoint, targetDid, record, label);
    }
  };
}

async function publishProtocolToLocalDwnEndpoints(
  ctx: AgentContext,
  protocolMessage: any,
  label: string,
): Promise<void> {
  const dwnEndpoints = getDwnEndpoints(ctx.enbox);
  for (const endpoint of dwnEndpoints) {
    debugLog(`[dwn-send] ${label}: applying protocol to ${ctx.did} via ${endpoint}`);
    await applyMessageToDwnEndpoint(endpoint, ctx.did, protocolMessage, `${label} protocol`);
  }
}

function debugLog(message: string): void {
  if (process.env.GITD_DEBUG === '1') {
    console.error(message);
  }
}

const FORWARDED_LONG_RUNNING_COMMANDS = new Set(['serve', 'web', 'daemon', 'indexer', 'github-api', 'shim']);

class CliRpcExit extends Error {
  public constructor(public readonly code: number) {
    super(`CLI exited with status ${code}`);
  }
}

function createCliRpcHandler(ctx: AgentContext): (request: CliRpcRequest) => Promise<CliRpcResponse> {
  let queue = Promise.resolve();

  return async (request: CliRpcRequest): Promise<CliRpcResponse> => {
    const previous = queue;
    let release = (): void => {};
    queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await executeCliRpc(ctx, request);
    } finally {
      release();
    }
  };
}

async function executeCliRpc(ctx: AgentContext, request: CliRpcRequest): Promise<CliRpcResponse> {
  if (!request.command || FORWARDED_LONG_RUNNING_COMMANDS.has(request.command)) {
    return {
      status : 1,
      stdout : '',
      stderr : `Command cannot be forwarded to the local helper: ${request.command || '<missing>'}\n`,
    };
  }

  const originalCwd = process.cwd();
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalEnv = new Map<string, string | undefined>();

  let stdout = '';
  let stderr = '';
  let status = 0;

  const writeStdout = (chunk: unknown): void => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
  };
  const writeStderr = (chunk: unknown): void => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
  };

  try {
    for (const [key, value] of Object.entries(request.env ?? {})) {
      originalEnv.set(key, process.env[key]);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (request.cwd) {
      process.chdir(request.cwd);
    }

    (process.stdout.write as any) = (chunk: unknown, ..._args: unknown[]): boolean => {
      writeStdout(chunk);
      return true;
    };
    (process.stderr.write as any) = (chunk: unknown, ..._args: unknown[]): boolean => {
      writeStderr(chunk);
      return true;
    };
    console.log = (...values: unknown[]): void => {
      stdout += `${values.map(formatConsoleValue).join(' ')}\n`;
    };
    console.error = (...values: unknown[]): void => {
      stderr += `${values.map(formatConsoleValue).join(' ')}\n`;
    };
    console.warn = (...values: unknown[]): void => {
      stderr += `${values.map(formatConsoleValue).join(' ')}\n`;
    };
    (process as any).exit = (code?: number): never => {
      throw new CliRpcExit(typeof code === 'number' ? code : 0);
    };

    try {
      if (request.command === 'whoami') {
        console.log(ctx.did);
      } else {
        await dispatchAgentCommand(ctx, request.command, request.args ?? []);
      }
    } catch (err) {
      if (err instanceof CliRpcExit) {
        status = err.code;
      } else {
        status = 1;
        stderr += `Fatal: ${(err as Error).message}\n`;
      }
    }

    if (status === 0) {
      await syncLocalDwn(ctx, 'push', `cli ${request.command}`);
    }
  } finally {
    (process as any).exit = originalExit;
    (process.stdout.write as any) = originalStdoutWrite;
    (process.stderr.write as any) = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      process.chdir(originalCwd);
    } catch {
      // Keep the helper alive even if the caller's cwd disappeared.
    }
  }

  return { status, stdout, stderr };
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (value instanceof Error) { return value.stack ?? value.message; }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parsePort(flagValue(args, '--port') ?? process.env.GITD_PORT ?? '9418');
  const basePath = resolveReposPath(args, ctx.profileName);
  const pathPrefix = flagValue(args, '--prefix') ?? process.env.GITD_PREFIX;
  const publicUrl = flagValue(args, '--public-url') ?? process.env.GITD_PUBLIC_URL;

  // --check: validate that the public URL is reachable, then exit.
  if (hasFlag(args, '--check')) {
    if (!publicUrl) {
      console.error('--check requires --public-url (or GITD_PUBLIC_URL).');
      process.exit(1);
    }
    const ok = await checkPublicUrl(publicUrl);
    process.exit(ok ? 0 : 1);
  }

  // DID-based signature verification for push tokens.
  const localDidDocuments = await getLocalDidDocuments(ctx);
  debugLog(`[auth] local DID documents: ${[...localDidDocuments.keys()].join(', ') || '<none>'}`);
  const verifySignature = createDidSignatureVerifier({
    didDocuments: localDidDocuments,
  });

  // DWN-based push authorization — checks role records and branch rules.
  const authorizeLocalPush = createDwnPushAuthorizer({
    repo     : ctx.repo,
    ownerDid : ctx.did,
  });
  const remoteAuthorizers = new Map<string, ReturnType<typeof createDwnPushAuthorizer>>();
  const remoteRepoContexts = new Map<string, Awaited<ReturnType<typeof getRepoContextForDid>>>();
  const authorizePush = async (
    actorDid: string,
    ownerDid: string,
    repoName: string,
    updates?: readonly PushRefUpdate[],
  ): Promise<boolean> => {
    debugLog(`[authz] checking ${actorDid} -> ${ownerDid}/${repoName}`);
    if (ownerDid === ctx.did) {
      const allowed = await authorizeLocalPush(actorDid, ownerDid, repoName, updates);
      debugLog(`[authz] local result ${allowed}`);
      return allowed;
    }

    if (actorDid === ctx.did && updates) {
      const allowed = updates.every((update) =>
        update.refName.startsWith('refs/heads/')
        && isContributorBranchRef(update.refName, actorDid),
      );
      debugLog(`[authz] local helper contributor branch result ${allowed}`);
      return allowed;
    }

    let remoteAuthorizer = remoteAuthorizers.get(ownerDid);
    if (!remoteAuthorizer) {
      remoteAuthorizer = createDwnPushAuthorizer({
        repo : ctx.repo,
        ownerDid,
        from : fromOpt(ctx, ownerDid),
      });
      remoteAuthorizers.set(ownerDid, remoteAuthorizer);
    }

    const allowed = await remoteAuthorizer(actorDid, ownerDid, repoName, updates);
    debugLog(`[authz] remote result ${allowed}`);
    return allowed;
  };

  const authenticateLocalPush = createPushAuthenticator({
    verifySignature,
    authorizePush,
  });

  const authenticatePush = async (
    request: Request,
    did: string,
    repo: string,
    updates?: readonly PushRefUpdate[],
  ): Promise<boolean> => {
    try {
      debugLog(`[auth] authenticating push for ${did}/${repo}; auth=${request.headers.has('Authorization') ? 'present' : 'missing'}`);
      const allowed = await authenticateLocalPush(request, did, repo, updates);
      debugLog(`[auth] authenticated push for ${did}/${repo}: ${allowed}`);
      return allowed;
    } catch (err) {
      console.error(`[auth] Push authentication failed for ${did}/${repo}: ${(err as Error).message}`);
      return false;
    }
  };

  // Post-push callback — resolves repo context dynamically per-push,
  // then runs ref sync and bundle sync.  Serialized per-repo via mutex
  // to prevent concurrent pushes from racing on DWN record updates.
  const onPushComplete = async (
    _did: string,
    repoName: string,
    repoPath: string,
    pushContext?: { updates?: readonly PushRefUpdate[] },
  ): Promise<void> => {
    const lockKey = `${_did}/${repoName}`;
    await withRepoLock(lockKey, async () => {
      debugLog(`[push-sync] start ${_did}/${repoName}`);
      let repoCtx;
      try {
        repoCtx = _did === ctx.did
          ? await getRepoContext(ctx, repoName)
          : remoteRepoContexts.get(lockKey) ?? await getRepoContextForDid(ctx, _did, repoName);
        if (_did !== ctx.did) {
          remoteRepoContexts.set(lockKey, repoCtx);
        }
      } catch {
        console.error(`push-sync: repo "${repoName}" not found in DWN — skipping ref/bundle sync.`);
        return;
      }
      debugLog(`[push-sync] context resolved ${_did}/${repoName}: ${repoCtx.contextId}`);

      if (_did !== ctx.did) {
        try {
          debugLog(`[push-sync] remote branch writeback start ${_did}/${repoName}`);
          await syncRemoteBranchPush({
            refs          : ctx.refs,
            repoContextId : repoCtx.contextId,
            targetDid     : _did,
            actorDid      : ctx.did,
            repoPath,
            updates       : pushContext?.updates ?? [],
            sendRecord    : createEndpointRecordSender(ctx, `remote branch writeback for ${_did}/${repoName}`),
          });
          debugLog(`[push-sync] remote branch writeback complete ${_did}/${repoName}`);
        } catch (err) {
          console.error(`push-sync: failed to write contributor branch records for ${_did}/${repoName}: ${(err as Error).message}`);
        }
        return;
      }

      const syncRefs = createRefSyncer({
        refs          : ctx.refs,
        repoContextId : repoCtx.contextId,
        visibility    : repoCtx.visibility,
      });

      const syncBundle = createBundleSyncer({
        repo          : ctx.repo,
        refs          : ctx.refs,
        repoContextId : repoCtx.contextId,
        visibility    : repoCtx.visibility,
      });

      const refsProtocolResult = await ctx.refs.configure({ encryption: true });
      if (refsProtocolResult.protocol) {
        await publishProtocolToLocalDwnEndpoints(ctx, refsProtocolResult.protocol.toJSON(), `refs protocol for ${_did}/${repoName}`);
      }
      await syncRefs(_did, repoName, repoPath);
      debugLog(`[push-sync] refs synced ${_did}/${repoName}`);
      await syncBundle(_did, repoName, repoPath);
      debugLog(`[push-sync] bundle synced ${_did}/${repoName}`);
      await syncLocalDwn(ctx, 'push', `post-push sync for ${_did}/${repoName}`);
      debugLog(`[push-sync] dwn pushed ${_did}/${repoName}`);
    });
  };

  // Auto-restore repos from DWN bundles when not found on disk.
  // Serialized per-repo via mutex to prevent concurrent fetches from
  // racing on the same restore.
  const onRepoNotFound = async (_did: string, repoName: string, repoPath: string): Promise<boolean> => {
    const lockKey = `${_did}/${repoName}`;
    return withRepoLock(lockKey, async () => {
      let repoCtx;
      try {
        repoCtx = await getRepoContextForDid(ctx, _did, repoName);
        remoteRepoContexts.set(lockKey, repoCtx);
      } catch {
        console.error(`restore: repo "${repoName}" not found in DWN for ${_did} — cannot restore.`);
        return false;
      }

      console.log(`Restoring repo "${repoName}" from DWN bundles for ${_did} → ${repoPath}`);
      const result = await restoreFromBundles({
        repo          : ctx.repo,
        refs          : ctx.refs,
        from          : fromOpt(ctx, _did),
        repoPath,
        repoContextId : repoCtx.contextId,
      });
      if (result.success) {
        console.log(`Restored ${result.bundlesApplied} bundle(s), tip: ${result.tipCommit}`);
      } else {
        console.error(`Bundle restore failed: ${result.error}`);
      }
      return result.success;
    });
  };

  const onRepoAccess = async (_did: string, repoName: string, repoPath: string): Promise<boolean> => {
    if (_did === ctx.did) {
      return true;
    }

    const lockKey = `${_did}/${repoName}`;
    return withRepoLock(lockKey, async () => {
      let repoCtx = remoteRepoContexts.get(lockKey);
      try {
        await syncLocalDwn(ctx, 'pull', `pre-fetch sync for ${_did}/${repoName}`);
        repoCtx = repoCtx ?? await getRepoContextForDid(ctx, _did, repoName);
        remoteRepoContexts.set(lockKey, repoCtx);
      } catch (err) {
        console.error(`refresh: repo "${repoName}" not found in DWN for ${_did}: ${(err as Error).message}`);
        return false;
      }

      rmSync(repoPath, { recursive: true, force: true });
      const result = await restoreFromBundles({
        repo          : ctx.repo,
        refs          : ctx.refs,
        from          : fromOpt(ctx, _did),
        repoPath,
        repoContextId : repoCtx.contextId,
      });

      if (result.success) {
        debugLog(`[fetch-refresh] restored ${_did}/${repoName} bundles=${result.bundlesApplied} tip=${result.tipCommit}`);
      } else {
        console.error(`Bundle refresh failed: ${result.error}`);
      }
      return result.success;
    });
  };

  // Idle auto-shutdown — when running as a background daemon, shut down
  // after 1 hour of no incoming HTTP requests to prevent orphaned processes.
  const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
  const isBackground = process.env.GITD_DAEMON_BACKGROUND === '1';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Mutable holder so the idle timer callback can reference the shutdown
  // function that is only available after the server is created.
  const shutdown: { fn?: () => Promise<void> } = {};

  const onRequest = isBackground
    ? (): void => {
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(() => {
        console.log('[daemon] Idle timeout reached (1h). Shutting down...');
        shutdown.fn?.();
      }, IDLE_TIMEOUT_MS);
    }
    : undefined;

  // Token generation callback — the credential helper calls POST /auth/token
  // instead of opening the agent's LevelDB (which would deadlock while the
  // daemon holds the lock). Uses the connected session DID to sign tokens.
  const generateToken = async (owner: string, repo: string): Promise<{ username: string; password: string } | null> => {
    try {
      const agent = ctx.enbox.agent as EnboxPlatformAgent;
      const bearerDid = await resolveConnectedBearerDid(agent, ctx.did);
      if (!bearerDid) { return null; }

      const payload = createPushTokenPayload(bearerDid.uri, owner, repo);
      const token = encodePushToken(payload);

      const signer = await bearerDid.getSigner();
      const tokenBytes = new TextEncoder().encode(token);
      const signature = await signer.sign({ data: tokenBytes });
      const signatureBase64url = Buffer.from(signature).toString('base64url');

      return {
        username : DID_AUTH_USERNAME,
        password : formatAuthPassword({ signature: signatureBase64url, token }),
      };
    } catch (err) {
      console.error(`[auth/token] Token generation failed: ${(err as Error).message}`);
      return null;
    }
  };

  const server = await createGitServer({
    basePath,
    port,
    pathPrefix,
    authenticatePush,
    authenticateReceivePackDiscovery : false,
    onPushComplete,
    onRepoNotFound,
    onRepoAccess,
    onRequest,
    generateToken,
    handleCliCommand                 : createCliRpcHandler(ctx),
  });

  // Register the git endpoint in the DID document (if public URL is provided).
  if (publicUrl) {
    try {
      await registerGitService(ctx.enbox, publicUrl);
      console.log(`Registered GitTransport service: ${publicUrl}`);
    } catch (err) {
      console.warn(`Warning: Could not register git service: ${(err as Error).message}`);
    }
  }

  // Ensure all repo records have up-to-date DWN and git endpoints.
  const dwnEndpoints = getDwnEndpoints(ctx.enbox);
  const { records: allRepos } = await ctx.repo.records.query('repo');
  for (const record of allRepos) {
    const data = await record.data.json();
    let updated = false;

    // Populate dwnEndpoints from DID document if missing.
    const currentDwn: string[] = data.dwnEndpoints ?? [];
    for (const ep of dwnEndpoints) {
      if (!currentDwn.includes(ep)) {
        currentDwn.push(ep);
        updated = true;
      }
    }

    // Populate gitEndpoints from --public-url if provided.
    if (publicUrl) {
      const currentGit: string[] = data.gitEndpoints ?? [];
      if (!currentGit.includes(publicUrl)) {
        currentGit.push(publicUrl);
        data.gitEndpoints = currentGit;
        updated = true;
      }
    }

    if (updated) {
      data.dwnEndpoints = currentDwn;
      await record.update({ data });
    }
  }

  // Keep the DID document alive on the DHT network.
  const stopRepublisher = startDidRepublisher(ctx.enbox);

  // Register the daemon so git-remote-did can discover it.
  writeLockfile(server.port, getVersion() ?? undefined, ctx.did, {
    dwnHelper   : true,
    profileName : ctx.profileName,
  });

  // Wire up the idle shutdown function now that we have all the pieces.
  shutdown.fn = async (): Promise<void> => {
    removeLockfile(ctx.profileName);
    stopRepublisher();
    await server.stop();
    process.exit(0);
  };

  // Start the idle timer for background daemons.
  if (isBackground && onRequest) { onRequest(); }

  console.log(`gitd server listening on port ${server.port}`);
  console.log(`  DID:     ${ctx.did}`);
  console.log(`  Repos:   ${basePath}`);
  if (pathPrefix) {
    console.log(`  Prefix:  ${pathPrefix}`);
  }
  if (publicUrl) {
    console.log(`  Public:  ${publicUrl}`);
  }
  console.log('');
  console.log(`Clone URL: git clone http://localhost:${server.port}/${ctx.did}/<repo>`);
  if (publicUrl) {
    console.log(`Public:    git clone did::${ctx.did}/<repo>`);
  }
  console.log('');
  console.log('Press Ctrl+C to stop.');

  // Keep the process alive.
  await new Promise<void>(() => {
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      removeLockfile(ctx.profileName);
      stopRepublisher();
      await server.stop();
      process.exit(0);
    });
  });
}
