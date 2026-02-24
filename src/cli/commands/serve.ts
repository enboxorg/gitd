/**
 * `dwn-git serve` — start the git transport sidecar server.
 *
 * Starts a smart HTTP git server that serves bare repositories and
 * authenticates pushes using DID-signed tokens.
 *
 * Usage: dwn-git serve [--port <port>] [--repos <path>] [--prefix <path>]
 *
 * Environment:
 *   DWN_GIT_PORT     — server port (default: 9418)
 *   DWN_GIT_REPOS    — base path for bare repos (default: ./repos)
 *   DWN_GIT_PREFIX   — URL path prefix (default: none)
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { createDidSignatureVerifier } from '../../git-server/verify.js';
import { createGitServer } from '../../git-server/server.js';
import { createPushAuthenticator } from '../../git-server/auth.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function serveCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parseInt(flagValue(args, '--port') ?? process.env.DWN_GIT_PORT ?? '9418', 10);
  const basePath = flagValue(args, '--repos') ?? process.env.DWN_GIT_REPOS ?? './repos';
  const pathPrefix = flagValue(args, '--prefix') ?? process.env.DWN_GIT_PREFIX;

  const verifySignature = createDidSignatureVerifier();

  const authenticatePush = createPushAuthenticator({
    verifySignature,
    // For now, any authenticated DID can push. Role-based auth will be
    // added when DWN role queries are integrated.
  });

  const server = await createGitServer({
    basePath,
    port,
    pathPrefix,
    authenticatePush,
  });

  console.log(`dwn-git server listening on port ${server.port}`);
  console.log(`  DID:     ${ctx.did}`);
  console.log(`  Repos:   ${basePath}`);
  if (pathPrefix) {
    console.log(`  Prefix:  ${pathPrefix}`);
  }
  console.log('');
  console.log(`Clone URL: git clone http://localhost:${server.port}/${ctx.did}/<repo>`);
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
