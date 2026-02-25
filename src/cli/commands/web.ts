/**
 * `gitd web` — start the read-only web UI server.
 *
 * Usage:
 *   gitd web [--port <port>]
 *
 * Serves a read-only HTML interface for browsing repo metadata, issues,
 * patches, releases, and wiki pages.  Default port: 8080.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { startWebServer } from '../../web/server.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function webCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parseInt(flagValue(args, '--port') ?? process.env.GITD_WEB_PORT ?? '8080', 10);

  console.log('Starting gitd web UI...');
  startWebServer({ ctx, port });

  // Keep the process alive — the server runs until Ctrl+C.
  await new Promise(() => {});
}
