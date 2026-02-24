/**
 * `dwn-git serve` — start the git transport sidecar server.
 *
 * Starts a smart HTTP git server that serves bare repositories and
 * authenticates pushes using DID-signed tokens. After each successful
 * push, git refs are mirrored to DWN records via ForgeRefsProtocol and
 * a git bundle is synced to a DWN record via ForgeRepoProtocol.
 *
 * Usage: dwn-git serve [--port <port>] [--repos <path>] [--prefix <path>]
 *                       [--public-url <url>]
 *
 * Environment:
 *   DWN_GIT_PORT        — server port (default: 9418)
 *   DWN_GIT_REPOS       — base path for bare repos (default: ./repos)
 *   DWN_GIT_PREFIX      — URL path prefix (default: none)
 *   DWN_GIT_PUBLIC_URL  — public URL for the server (enables DID service registration)
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parseInt(flagValue(args, '--port') ?? process.env.DWN_GIT_PORT ?? '9418', 10);
  const basePath = flagValue(args, '--repos') ?? process.env.DWN_GIT_REPOS ?? './repos';
  const pathPrefix = flagValue(args, '--prefix') ?? process.env.DWN_GIT_PREFIX;
  const publicUrl = flagValue(args, '--public-url') ?? process.env.DWN_GIT_PUBLIC_URL;

  // Look up the repo context (contextId + visibility) for ref/bundle syncing.
  const { contextId: repoContextId, visibility } = await getRepoContext(ctx);

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

  // Post-push callbacks — run ref sync and bundle sync after each push.
  const syncRefs = createRefSyncer({
    refs          : ctx.refs,
    repoContextId : repoContextId,
  });

  const syncBundle = createBundleSyncer({
    repo          : ctx.repo,
    repoContextId : repoContextId,
    visibility,
  });

  // Compose both post-push callbacks into a single handler.
  const onPushComplete = async (did: string, repo: string, repoPath: string): Promise<void> => {
    await Promise.all([
      syncRefs(did, repo, repoPath),
      syncBundle(did, repo, repoPath),
    ]);
  };

  // Auto-restore repos from DWN bundles when not found on disk.
  const onRepoNotFound = async (_did: string, _repo: string, repoPath: string): Promise<boolean> => {
    console.log(`Restoring repo from DWN bundles → ${repoPath}`);
    const result = await restoreFromBundles({ repo: ctx.repo, repoPath });
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

      // Update the repo record with the git endpoint.
      const { records } = await ctx.repo.records.query('repo');
      if (records.length > 0) {
        const record = records[0];
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

  console.log(`dwn-git server listening on port ${server.port}`);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the value following a flag in argv. */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}
