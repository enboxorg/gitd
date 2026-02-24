/**
 * Git smart HTTP transport handler.
 *
 * Implements the server side of Git's smart HTTP protocol (v1):
 *   - `GET /<did>/<repo>/info/refs?service=git-upload-pack`  — ref discovery (clone/fetch)
 *   - `POST /<did>/<repo>/git-upload-pack`                   — pack negotiation (clone/fetch)
 *   - `GET /<did>/<repo>/info/refs?service=git-receive-pack` — ref discovery (push)
 *   - `POST /<did>/<repo>/git-receive-pack`                  — receive pack (push)
 *
 * The handler is a pure function `(Request) => Response | Promise<Response>`
 * suitable for use with `Bun.serve()`, `Deno.serve()`, or any fetch-compatible
 * HTTP runtime.
 *
 * URL format: `/<did>/<repo>/...`
 *   The DID is URL-encoded in the path (colons are preserved since they're
 *   valid in path segments).
 *
 * @module
 */

import { spawn } from 'node:child_process';

import type { GitBackend } from './git-backend.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating the git HTTP handler. */
export type GitHttpHandlerOptions = {
  /** The git backend for repository operations. */
  backend: GitBackend;

  /**
   * Optional authentication callback for push operations.
   * Called before `git-receive-pack` is allowed to proceed.
   * Should return `true` if the request is authorized.
   *
   * @param request - The incoming HTTP request
   * @param did - The repository owner's DID
   * @param repo - The repository name
   */
  authenticatePush?: (request: Request, did: string, repo: string) => Promise<boolean>;

  /**
   * Optional callback invoked after a successful `git receive-pack` (push).
   * Use this for post-push operations like syncing refs to DWN records.
   *
   * @param did - The repository owner's DID
   * @param repo - The repository name
   * @param repoPath - Filesystem path to the bare repository
   */
  onPushComplete?: (did: string, repo: string, repoPath: string) => Promise<void>;

  /**
   * Optional path prefix to strip from incoming URLs.
   * For example, if the sidecar is mounted at `/git`, set this to `/git`.
   * @default ''
   */
  pathPrefix?: string;
};

/** Parsed route from a git smart HTTP URL. */
type GitRoute = {
  did: string;
  repo: string;
  /** The path suffix after `/<did>/<repo>/`, e.g. `info/refs` or `git-upload-pack`. */
  action: string;
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a fetch-compatible HTTP handler for Git smart HTTP transport.
 *
 * @param options - Handler configuration
 * @returns A function that handles incoming HTTP requests
 */
export function createGitHttpHandler(
  options: GitHttpHandlerOptions,
): (request: Request) => Response | Promise<Response> {
  const { backend, authenticatePush, onPushComplete, pathPrefix = '' } = options;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Strip path prefix.
    if (pathPrefix && pathname.startsWith(pathPrefix)) {
      pathname = pathname.slice(pathPrefix.length);
    }

    // Parse the route.
    const route = parseRoute(pathname);
    if (!route) {
      return new Response('Not Found', { status: 404 });
    }

    const { did, repo, action } = route;

    // -----------------------------------------------------------------------
    // GET /<did>/<repo>/info/refs?service=<service>
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && action === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return new Response('Dumb HTTP transport is not supported. Use git smart HTTP.', { status: 403 });
      }

      // Auth check for push ref discovery.
      if (service === 'git-receive-pack' && authenticatePush) {
        const authorized = await authenticatePush(request, did, repo);
        if (!authorized) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      // Check repo exists.
      if (!backend.exists(did, repo)) {
        return new Response('Repository not found', { status: 404 });
      }

      return handleInfoRefs(backend, did, repo, service);
    }

    // -----------------------------------------------------------------------
    // POST /<did>/<repo>/git-upload-pack
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && action === 'git-upload-pack') {
      if (!backend.exists(did, repo)) {
        return new Response('Repository not found', { status: 404 });
      }
      return handleServiceRpc(backend, did, repo, 'upload-pack', request);
    }

    // -----------------------------------------------------------------------
    // POST /<did>/<repo>/git-receive-pack
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && action === 'git-receive-pack') {
      // Auth check for push.
      if (authenticatePush) {
        const authorized = await authenticatePush(request, did, repo);
        if (!authorized) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      if (!backend.exists(did, repo)) {
        return new Response('Repository not found', { status: 404 });
      }

      const response = await handleServiceRpc(backend, did, repo, 'receive-pack', request);

      // Fire the post-push callback asynchronously (don't block the response).
      if (onPushComplete && response.status === 200) {
        const repoPath = backend.repoPath(did, repo);
        onPushComplete(did, repo, repoPath).catch((err) => {
          console.error(`onPushComplete error for ${did}/${repo}: ${(err as Error).message}`);
        });
      }

      return response;
    }

    return new Response('Not Found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

/**
 * Parse a URL path into DID, repo, and action components.
 *
 * Expected format: `/<did>/<repo>/<action>`
 * The DID occupies exactly 3 colon-separated segments: `did:<method>:<id>`.
 * However, since the DID is in the URL path, we split by `/` and reconstruct.
 *
 * URL form: `/<did-scheme>:<did-method>:<did-id>/<repo>/<action...>`
 * Example:  `/did:dht:abc123/my-repo/info/refs`
 */
function parseRoute(pathname: string): GitRoute | undefined {
  // Remove leading slash.
  const path = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  // The DID is the first path segment (contains colons, not slashes).
  const firstSlash = path.indexOf('/');
  if (firstSlash === -1) { return undefined; }

  const did = decodeURIComponent(path.slice(0, firstSlash));

  // Validate it looks like a DID.
  if (!did.startsWith('did:') || did.split(':').length < 3) {
    return undefined;
  }

  // Remaining path: <repo>/<action...>
  const rest = path.slice(firstSlash + 1);
  const secondSlash = rest.indexOf('/');
  if (secondSlash === -1) { return undefined; }

  const repo = rest.slice(0, secondSlash);
  const action = rest.slice(secondSlash + 1);

  if (!repo || !action) { return undefined; }

  return { did, repo, action };
}

// ---------------------------------------------------------------------------
// Git smart HTTP protocol handlers
// ---------------------------------------------------------------------------

/** Git pkt-line helper: encode a single line. */
function pktLine(line: string): string {
  const len = line.length + 4;
  return len.toString(16).padStart(4, '0') + line;
}

/** Git pkt-line flush: `0000`. */
const PKT_FLUSH = '0000';

/**
 * Handle `GET /info/refs?service=<service>`.
 *
 * Runs `git <service> --stateless-rpc --advertise-refs` and wraps the output
 * in the smart HTTP ref advertisement format.
 */
async function handleInfoRefs(
  backend: GitBackend,
  did: string,
  repo: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<Response> {
  const gitService = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  const repoPath = backend.repoPath(did, repo);

  // Run git with --advertise-refs to get the ref listing.
  const refData = await spawnAndCollect(gitService, repoPath);

  if (refData === null) {
    return new Response('Git service error', { status: 500 });
  }

  // Build the smart HTTP response: service announcement + ref data.
  const encoder = new TextEncoder();
  const announcement = pktLine(`# service=${service}\n`) + PKT_FLUSH;
  const announcementBytes = encoder.encode(announcement);

  const body = new Uint8Array(announcementBytes.length + refData.length);
  body.set(announcementBytes, 0);
  body.set(refData, announcementBytes.length);

  return new Response(body, {
    status  : 200,
    headers : {
      'Content-Type'  : `application/x-${service}-advertisement`,
      'Cache-Control' : 'no-cache',
    },
  });
}

/**
 * Handle `POST /git-upload-pack` or `POST /git-receive-pack`.
 *
 * Pipes the request body to `git <service> --stateless-rpc` stdin and
 * streams stdout back as the response.
 */
async function handleServiceRpc(
  backend: GitBackend,
  did: string,
  repo: string,
  service: 'upload-pack' | 'receive-pack',
  request: Request,
): Promise<Response> {
  const gitProcess = service === 'upload-pack'
    ? backend.uploadPack(did, repo)
    : backend.receivePack(did, repo);

  // Pipe request body into git subprocess stdin.
  if (request.body) {
    const writer = gitProcess.stdin.getWriter();
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        await writer.write(value);
      }
    } finally {
      await writer.close();
      reader.releaseLock();
    }
  } else {
    const writer = gitProcess.stdin.getWriter();
    await writer.close();
  }

  return new Response(gitProcess.stdout, {
    status  : 200,
    headers : {
      'Content-Type'  : `application/x-git-${service}-result`,
      'Cache-Control' : 'no-cache',
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `git <service> --stateless-rpc --advertise-refs` and collect stdout.
 * Returns `null` if the process exits with a non-zero code.
 */
function spawnAndCollect(service: string, repoPath: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [service, '--stateless-rpc', '--advertise-refs', repoPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdout!.on('error', reject);

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve(null);
      } else {
        resolve(new Uint8Array(Buffer.concat(chunks)));
      }
    });
  });
}
