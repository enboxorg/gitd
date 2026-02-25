/**
 * OCI/Docker registry shim adapter for the unified daemon.
 *
 * Wraps `handleOciRequest()` behind the `ShimAdapter` interface.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { ShimAdapter } from '../adapter.js';

import { handleOciRequest } from '../../shims/oci/registry.js';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const ociAdapter: ShimAdapter = {
  id          : 'oci',
  name        : 'OCI/Docker registry',
  defaultPort : 5555,
  portEnvVar  : 'DWN_GIT_OCI_SHIM_PORT',
  corsMethods : 'GET, HEAD, OPTIONS',
  corsHeaders : 'Authorization, Accept, Docker-Distribution-Api-Version',
  usageHint   : 'docker pull localhost:{port}/did:dht:<id>/<image>:<tag>',

  async handle(ctx: AgentContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
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
      const port = (req.socket.address() as { port?: number })?.port ?? 5555;
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const result = await handleOciRequest(ctx, url, method);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, {
        'Content-Type'                    : 'application/json',
        'Docker-Distribution-Api-Version' : 'registry/2.0',
      });
      res.end(JSON.stringify({
        errors: [{ code: 'UNKNOWN', message: 'Internal server error', detail: null }],
      }));
    }
  },
};
