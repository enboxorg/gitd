/**
 * GitHub API shim adapter for the unified daemon.
 *
 * Wraps `handleShimRequest()` behind the `ShimAdapter` interface.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentContext } from '../../cli/agent.js';
import type { ShimAdapter } from '../adapter.js';

import { handleShimRequest } from '../../github-shim/server.js';
import { baseHeaders, jsonMethodNotAllowed } from '../../github-shim/helpers.js';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const githubAdapter: ShimAdapter = {
  id          : 'github',
  name        : 'GitHub API',
  defaultPort : 8181,
  portEnvVar  : 'DWN_GIT_GITHUB_API_PORT',
  corsMethods : 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  corsHeaders : 'Authorization, Accept, Content-Type',
  usageHint   : 'GitHub REST API v3 compatible — point tools at http://localhost:{port}',

  async handle(ctx: AgentContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const port = (req.socket.address() as { port?: number })?.port ?? 8181;
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Reject truly unsupported methods.
    const allowed = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
    if (!allowed.has(method)) {
      const r = jsonMethodNotAllowed(`Method ${method} is not supported.`);
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }

    // Parse body for mutating methods.
    let reqBody: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length > 0) {
        try {
          reqBody = JSON.parse(raw);
        } catch {
          res.writeHead(400, baseHeaders());
          res.end(JSON.stringify({ message: 'Invalid JSON in request body.' }));
          return;
        }
      }
    }

    try {
      const result = await handleShimRequest(ctx, url, method, reqBody);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, baseHeaders());
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  },
};
