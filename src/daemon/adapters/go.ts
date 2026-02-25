/**
 * Go module proxy shim adapter for the unified daemon.
 *
 * Wraps `handleGoProxyRequest()` behind the `ShimAdapter` interface.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { ShimAdapter } from '../adapter.js';

import { handleGoProxyRequest } from '../../shims/go/proxy.js';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const goAdapter: ShimAdapter = {
  id          : 'go',
  name        : 'Go module proxy',
  defaultPort : 4874,
  portEnvVar  : 'GITD_GO_SHIM_PORT',
  corsMethods : 'GET, OPTIONS',
  corsHeaders : 'Authorization, Accept',
  usageHint   : 'GOPROXY=http://localhost:{port} go get did.enbox.org/did:dht:<id>/<module>@v1.0.0',

  async handle(ctx: AgentContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed. This is a read-only Go module proxy.');
      return;
    }

    try {
      const port = (req.socket.address() as { port?: number })?.port ?? 4874;
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = await handleGoProxyRequest(ctx, url);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  },
};
