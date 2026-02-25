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
 *                       [--public-url <url>]
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
import { registerGitService } from '../../git-server/did-service.js';
import { restoreFromBundles } from '../../git-server/bundle-restore.js';
import { flagValue, parsePort } from '../flags.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parsePort(flagValue(args, '--port') ?? process.env.GITD_PORT ?? '9418');
  const basePath = flagValue(args, '--repos') ?? process.env.GITD_REPOS ?? './repos';
  const pathPrefix = flagValue(args, '--prefix') ?? process.env.GITD_PREFIX;
  const publicUrl = flagValue(args, '--public-url') ?? process.env.GITD_PUBLIC_URL;

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

      // Update ALL repo records with the git endpoint.
      const { records } = await ctx.repo.records.query('repo');
      for (const record of records) {
        const data = await record.data.json();
        const gitEndpoints = data.gitEndpoints ?? [];
        if (!gitEndpoints.includes(publicUrl)) {
          gitEndpoints.push(publicUrl);
          await record.update({
            data: { ...data, gitEndpoints },
          });
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not register git service: ${(err as Error).message}`);
    }
  }

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
      await server.stop();
      process.exit(0);
    });
  });
}
