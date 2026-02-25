/**
 * npm registry shim — HTTP server.
 *
 * Starts a local npm-compatible registry that resolves DID-scoped
 * packages from DWN records.
 *
 * Usage:
 *   gitd shim npm [--port 4873]
 *
 * Then:
 *   npm install --registry=http://localhost:4873 @did:dht:abc123/my-pkg
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { NpmResponse } from './registry.js';

import { handleNpmRequest } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NpmShimOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the npm registry shim server. Returns the server instance. */
export function startNpmShim(options: NpmShimOptions): Server {
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

    // Only support GET — this is a read-only registry proxy.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. This is a read-only registry shim.' }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result: NpmResponse = await handleNpmRequest(ctx, url);

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error(`[npm-shim] Error: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    console.log(`[npm-shim] npm registry shim running at http://localhost:${port}`);
    console.log('[npm-shim] Usage:');
    console.log(`  npm install --registry=http://localhost:${port} @did:dht:<id>/<package>`);
    console.log(`  bun install --registry http://localhost:${port} @did:dht:<id>/<package>`);
    console.log('');
  });

  return server;
}
