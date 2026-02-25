/**
 * Go module proxy shim — HTTP server.
 *
 * Starts a local GOPROXY-compatible server that resolves DID-scoped
 * Go modules from DWN records.
 *
 * Usage:
 *   dwn-git shim go [--port 4874]
 *
 * Then:
 *   GOPROXY=http://localhost:4874 go get did.enbox.org/did:dht:abc123/my-mod@v1.0.0
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { GoProxyResponse } from './proxy.js';

import { handleGoProxyRequest } from './proxy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoShimOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the Go module proxy shim server. Returns the server instance. */
export function startGoShim(options: GoShimOptions): Server {
  const { ctx, port } = options;

  const server = createServer(async (req, res) => {
    // CORS preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : 'GET, OPTIONS',
        'Access-Control-Allow-Headers' : 'Authorization, Accept',
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed. This is a read-only Go module proxy.');
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result: GoProxyResponse = await handleGoProxyRequest(ctx, url);

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error(`[go-shim] Error: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });

  server.listen(port, () => {
    console.log(`[go-shim] Go module proxy running at http://localhost:${port}`);
    console.log('[go-shim] Usage:');
    console.log(`  GOPROXY=http://localhost:${port} go get did.enbox.org/did:dht:<id>/<module>@v1.0.0`);
    console.log('');
  });

  return server;
}
