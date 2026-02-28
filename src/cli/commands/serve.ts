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

import { createBundleSyncer } from '../../git-server/bundle-sync.js';
import { createDidSignatureVerifier } from '../../git-server/verify.js';
import { createDwnPushAuthorizer } from '../../git-server/push-authorizer.js';
import { createGitServer } from '../../git-server/server.js';
import { createPushAuthenticator } from '../../git-server/auth.js';
import { createRefSyncer } from '../../git-server/ref-sync.js';
import { getRepoContext } from '../repo-context.js';
import { restoreFromBundles } from '../../git-server/bundle-restore.js';
import { flagValue, hasFlag, parsePort, resolveReposPath } from '../flags.js';
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
  const verifySignature = createDidSignatureVerifier();

  // DWN-based push authorization — checks role records.
  const authorizePush = createDwnPushAuthorizer({
    repo     : ctx.repo,
    ownerDid : ctx.did,
  });

  const authenticatePush = createPushAuthenticator({
    verifySignature,
    authorizePush,
  });

  // Post-push callback — resolves repo context dynamically per-push,
  // then runs ref sync and bundle sync.
  const onPushComplete = async (_did: string, repoName: string, repoPath: string): Promise<void> => {
    let repoCtx;
    try {
      repoCtx = await getRepoContext(ctx, repoName);
    } catch {
      console.error(`push-sync: repo "${repoName}" not found in DWN — skipping ref/bundle sync.`);
      return;
    }

    const syncRefs = createRefSyncer({
      refs          : ctx.refs,
      repoContextId : repoCtx.contextId,
    });

    const syncBundle = createBundleSyncer({
      repo          : ctx.repo,
      repoContextId : repoCtx.contextId,
      visibility    : repoCtx.visibility,
    });

    await Promise.all([
      syncRefs(_did, repoName, repoPath),
      syncBundle(_did, repoName, repoPath),
    ]);
  };

  // Auto-restore repos from DWN bundles when not found on disk.
  const onRepoNotFound = async (_did: string, repoName: string, repoPath: string): Promise<boolean> => {
    let repoCtx;
    try {
      repoCtx = await getRepoContext(ctx, repoName);
    } catch {
      console.error(`restore: repo "${repoName}" not found in DWN — cannot restore.`);
      return false;
    }

    console.log(`Restoring repo "${repoName}" from DWN bundles → ${repoPath}`);
    const result = await restoreFromBundles({
      repo          : ctx.repo,
      repoPath,
      repoContextId : repoCtx.contextId,
    });
    if (result.success) {
      console.log(`Restored ${result.bundlesApplied} bundle(s), tip: ${result.tipCommit}`);
    } else {
      console.error(`Bundle restore failed: ${result.error}`);
    }
    return result.success;
  };

  const server = await createGitServer({
    basePath,
    port,
    pathPrefix,
    authenticatePush,
    onPushComplete,
    onRepoNotFound,
  });

  // Register the git endpoint in the DID document (if public URL is provided).
  if (publicUrl) {
    try {
      await registerGitService(ctx.web5, publicUrl);
      console.log(`Registered GitTransport service: ${publicUrl}`);
    } catch (err) {
      console.warn(`Warning: Could not register git service: ${(err as Error).message}`);
    }
  }

  // Ensure all repo records have up-to-date DWN and git endpoints.
  const dwnEndpoints = getDwnEndpoints(ctx.web5);
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
  const stopRepublisher = startDidRepublisher(ctx.web5);

  // Register the daemon so git-remote-did can discover it.
  writeLockfile(server.port);

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
      removeLockfile();
      stopRepublisher();
      await server.stop();
      process.exit(0);
    });
  });
}
