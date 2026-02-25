/**
 * OCI Distribution registry shim — HTTP server.
 *
 * Starts a local OCI-compatible registry that resolves DID-scoped
 * container images from DWN records.
 *
 * Usage:
 *   gitd shim oci [--port 5555]
 *
 * Then:
 *   docker pull localhost:5555/did:dht:abc123/my-image:v1.0.0
 *
 * @module
 */

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { OciResponse } from './registry.js';

import { handleOciRequest } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OciShimOptions = {
  ctx : AgentContext;
  port : number;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Start the OCI registry shim server. Returns the server instance. */
export function startOciShim(options: OciShimOptions): Server {
  const { ctx, port } = options;

  const server = createServer(async (req, res) => {
    // CORS preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers' : 'Authorization, Accept, Docker-Distribution-Api-Version',
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    // Only support GET and HEAD — this is a pull-only registry.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type'                    : 'application/json',
        'Docker-Distribution-Api-Version' : 'registry/2.0',
      });
      res.end(JSON.stringify({
        errors: [{ code: 'UNSUPPORTED', message: 'This is a read-only registry shim.', detail: null }],
      }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result: OciResponse = await handleOciRequest(ctx, url, req.method);

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error(`[oci-shim] Error: ${(err as Error).message}`);
      res.writeHead(500, {
        'Content-Type'                    : 'application/json',
        'Docker-Distribution-Api-Version' : 'registry/2.0',
      });
      res.end(JSON.stringify({
        errors: [{ code: 'UNKNOWN', message: 'Internal server error', detail: null }],
      }));
    }
  });

  server.listen(port, () => {
    console.log(`[oci-shim] OCI registry shim running at http://localhost:${port}`);
    console.log('[oci-shim] Usage:');
    console.log(`  docker pull localhost:${port}/did:dht:<id>/<image>:<tag>`);
    console.log(`  podman pull localhost:${port}/did:dht:<id>/<image>:<tag>`);
    console.log('');
  });

  return server;
}
