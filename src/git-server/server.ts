/**
 * Git transport sidecar server.
 *
 * A standalone HTTP server that serves Git smart HTTP transport alongside
 * a DWN.  Uses Node.js `http` module for maximum compatibility.
 *
 * Usage:
 * ```ts
 * import { createGitServer } from '@enbox/dwn-git/git-server/server';
 *
 * const server = createGitServer({
 *   basePath : '/var/lib/dwn-git/repos',
 *   port     : 9418,
 * });
 *
 * console.log(`Git server listening on port ${server.port}`);
 * ```
 *
 * @module
 */

import type { IncomingMessage } from 'node:http';

import { createServer } from 'node:http';

import { createGitHttpHandler } from './http-handler.js';
import { GitBackend } from './git-backend.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the git transport sidecar server. */
export type GitServerOptions = {
  /** Base directory for storing bare repositories. */
  basePath: string;

  /** TCP port to listen on. Use 0 for a random available port. @default 9418 */
  port?: number;

  /** Hostname to bind to. @default '0.0.0.0' */
  hostname?: string;

  /** Optional path prefix for the HTTP handler (e.g. `/git`). */
  pathPrefix?: string;

  /**
   * Optional authentication callback for push operations.
   * @see GitHttpHandlerOptions.authenticatePush
   */
  authenticatePush?: (request: Request, did: string, repo: string) => Promise<boolean>;

  /**
   * Optional callback invoked after a successful push.
   * @see GitHttpHandlerOptions.onPushComplete
   */
  onPushComplete?: (did: string, repo: string, repoPath: string) => Promise<void>;

  /**
   * Optional callback invoked when a repo is not found on disk.
   * Implementations can restore the repo from DWN bundle records.
   * @see GitHttpHandlerOptions.onRepoNotFound
   */
  onRepoNotFound?: (did: string, repo: string, repoPath: string) => Promise<boolean>;
};

/** A running git server instance. */
export type GitServer = {
  /** The TCP port the server is listening on. */
  port: number;

  /** The git backend managing repositories. */
  backend: GitBackend;

  /** Stop the server. Returns a promise that resolves when fully closed. */
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and start a git transport sidecar server.
 *
 * @param options - Server configuration
 * @returns A promise resolving to a running GitServer instance
 */
export async function createGitServer(options: GitServerOptions): Promise<GitServer> {
  const {
    basePath,
    port = 9418,
    hostname = '0.0.0.0',
    pathPrefix,
    authenticatePush,
    onPushComplete,
    onRepoNotFound,
  } = options;

  const backend = new GitBackend({ basePath });

  const fetchHandler = createGitHttpHandler({
    backend,
    pathPrefix,
    authenticatePush,
    onPushComplete,
    onRepoNotFound,
  });

  const server = createServer(async (req, res) => {
    try {
      // Build a Request object from the Node.js IncomingMessage.
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      // Collect request body for POST.
      let body: Uint8Array | undefined;
      if (req.method === 'POST') {
        body = await collectRequestBody(req);
      }

      const request = new Request(url, {
        method  : req.method ?? 'GET',
        headers : headers,
        body    : body ?? null,
      });

      const response = await fetchHandler(request);

      // Write response back to Node.js ServerResponse.
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    } catch (err) {
      console.error(`Git HTTP handler error: ${(err as Error).message}`);
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  // Start listening.
  const actualPort = await new Promise<number>((resolve) => {
    server.listen(port, hostname, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve(boundPort);
    });
  });

  return {
    port    : actualPort,
    backend : backend,
    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) { reject(err); } else { resolve(); }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect the full request body from a Node.js IncomingMessage. */
function collectRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
