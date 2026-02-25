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

/** Maximum JSON request body size (1 MB). */
const MAX_JSON_BODY = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const githubAdapter: ShimAdapter = {
  id          : 'github',
  name        : 'GitHub API',
  defaultPort : 8181,
  portEnvVar  : 'GITD_GITHUB_API_PORT',
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

    // Parse body for mutating methods (with size limit).
    let reqBody: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalSize += buf.length;
        if (totalSize > MAX_JSON_BODY) { tooLarge = true; break; }
        chunks.push(buf);
      }
      if (tooLarge) {
        res.writeHead(413, baseHeaders());
        res.end(JSON.stringify({ message: 'Payload Too Large' }));
        return;
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
      const authHeader = req.headers.authorization ?? null;
      const result = await handleShimRequest(ctx, url, method, reqBody, authHeader);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, baseHeaders());
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  },
};
