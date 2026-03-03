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

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { parseDidUrl } from './parse-url.js';
import { resolveGitEndpoint } from './resolve.js';

/** Resolve the absolute path to the credential helper binary (sibling file). */
function resolveCredentialHelper(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(thisFile, '..', 'credential-main.js');
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
  const child = spawn('git', [
    '-c', `credential.helper=!bun '${credHelper}'`,
    '-c', 'credential.useHttpPath=true',
    helper, remoteName, endpoint.url,
  ], {
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error('');
      console.error(`git-remote-did: operation failed for ${parsed!.did}/${parsed!.repo ?? ''}`);
      console.error('Please make sure:');
      console.error('  - The repository exists (create it with `gitd init <name>`)');
      console.error('  - The DID is correct and resolvable');
      console.error('  - The daemon is running (`gitd serve`)');
    }
    process.exit(code ?? 128);
  });
}

main().catch((err: Error) => {
  console.error(`git-remote-did: fatal: ${err.message}`);
  process.exit(128);
});
