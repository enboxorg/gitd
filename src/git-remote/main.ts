#!/usr/bin/env bun
/**
 * git-remote-did — Git remote helper for DID-addressed repositories.
 *
 * This helper is invoked by Git when it encounters a `did::` or `did://`
 * remote URL.  It resolves the DID to an HTTPS endpoint and delegates all
 * git transport to `git-remote-https`.
 *
 * Usage (invoked by Git, not directly):
 *   git clone did::dht:abc123/my-repo
 *   git remote add origin did::dht:abc123/my-repo
 *   git push origin main
 *
 * The helper:
 *   1. Parses the DID from the URL
 *   2. Resolves the DID document
 *   3. Extracts the GitTransport or DWN service endpoint
 *   4. Execs `git-remote-https` with the resolved HTTPS URL
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import { parseDidUrl } from './parse-url.js';
import { resolveGitEndpoint } from './resolve.js';
import { decodePushToken, parseAuthPassword } from '../git-server/auth.js';

/** Resolve the absolute path to the credential helper binary (sibling file). */
function resolveCredentialHelper(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const dir = dirname(thisFile);
  const jsPath = resolve(dir, 'credential-main.js');
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return resolve(dir, 'credential-main.ts');
}

async function localEndpointAuthHeader(
  endpointUrl: string,
  owner: string,
  repo: string | undefined,
): Promise<string | undefined> {
  if (!repo) { return undefined; }

  try {
    const url = new URL(endpointUrl);
    const response = await fetch(`${url.origin}/auth/token`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ owner, repo }),
      signal  : AbortSignal.timeout(5_000),
    });
    if (!response.ok) { return undefined; }

    const creds = await response.json() as { username?: string; password?: string };
    if (!creds.username || !creds.password) { return undefined; }

    if (process.env.GITD_DEBUG === '1') {
      try {
        const payload = decodePushToken(parseAuthPassword(creds.password).token);
        console.error(`[git-remote-did] local auth token did=${payload.did} owner=${payload.owner} repo=${payload.repo}`);
      } catch {
        console.error('[git-remote-did] local auth token could not be decoded');
      }
    }

    return `Authorization: Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const remoteName = process.argv[2];
  const url = process.argv[3] ?? remoteName;

  if (!url) {
    console.error('git-remote-did: missing URL argument');
    process.exit(1);
  }

  // Parse DID from URL.
  let parsed;
  try {
    parsed = parseDidUrl(url);
  } catch (err: unknown) {
    console.error(`git-remote-did: ${(err as Error).message}`);
    process.exit(1);
  }

  // Resolve DID → HTTPS endpoint.
  // The password for daemon auto-start is obtained lazily inside
  // resolveLocalDaemon → ensureDaemon only when a daemon actually needs
  // to be spawned.  This avoids prompting when the daemon is already
  // running (the common case).
  let endpoint;
  try {
    endpoint = await resolveGitEndpoint(parsed.did, parsed.repo);
  } catch (err: unknown) {
    console.error(`git-remote-did: ${(err as Error).message}`);
    process.exit(1);
  }

  console.error(`git-remote-did: resolved ${parsed.did} → ${endpoint.url} (via ${endpoint.source})`);

  // Pick the right transport helper based on the URL scheme.
  const helper = endpoint.url.startsWith('https://')
    ? 'remote-https'
    : 'remote-http';

  // The credential helper is a sibling .js file with a bun shebang.
  // Use git's `!<command>` syntax to invoke it via bun, which avoids
  // needing the file to be +x or on PATH.
  const credHelper = resolveCredentialHelper();
  const gitArgs = [
    '-c', `credential.helper=!bun '${credHelper}'`,
    '-c', 'credential.useHttpPath=true',
  ];
  const authHeader = endpoint.source === 'LocalDaemon' || endpoint.source === 'LocalDwnHelper'
    ? await localEndpointAuthHeader(endpoint.url, parsed.did, parsed.repo)
    : undefined;
  if (authHeader) {
    gitArgs.push('-c', `http.extraHeader=${authHeader}`);
  }
  gitArgs.push(helper, remoteName, endpoint.url);

  const child = spawn('git', gitArgs, {
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error('');
      console.error(`git-remote-did: operation failed for ${parsed!.did}/${parsed!.repo ?? ''}`);
      console.error('Please make sure:');
      console.error('  - The repository exists (create it with `gitd init <name>`)');
      console.error('  - The DID is correct and resolvable');
      console.error('  - The local helper is running (`gitd helper status`)');
    }
    process.exit(code ?? 128);
  });
}

main().catch((err: Error) => {
  console.error(`git-remote-did: fatal: ${err.message}`);
  process.exit(128);
});
