/**
 * npm registry shim adapter for the unified daemon.
 *
 * Wraps `handleNpmRequest()` behind the `ShimAdapter` interface.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { ShimAdapter } from '../adapter.js';

import { handleNpmRequest } from '../../shims/npm/registry.js';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const npmAdapter: ShimAdapter = {
  id          : 'npm',
  name        : 'npm registry',
  defaultPort : 4873,
  portEnvVar  : 'DWN_GIT_NPM_SHIM_PORT',
  corsMethods : 'GET, OPTIONS',
  corsHeaders : 'Authorization, Accept',
  usageHint   : 'npm install --registry=http://localhost:{port} @did:dht:<id>/<package>',

  async handle(ctx: AgentContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. This is a read-only registry shim.' }));
      return;
    }

    try {
      const port = (req.socket.address() as { port?: number })?.port ?? 4873;
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = await handleNpmRequest(ctx, url);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  },
};
