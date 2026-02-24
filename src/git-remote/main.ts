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

import { spawn } from 'node:child_process';

import { parseDidUrl } from './parse-url.js';
import { resolveGitEndpoint } from './resolve.js';

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
  let endpoint;
  try {
    endpoint = await resolveGitEndpoint(parsed.did, parsed.repo);
  } catch (err: unknown) {
    console.error(`git-remote-did: ${(err as Error).message}`);
    process.exit(1);
  }

  console.error(`git-remote-did: resolved ${parsed.did} → ${endpoint.url} (via ${endpoint.source})`);

  // Delegate to git-remote-https — it handles all the transport complexity.
  const child = spawn('git', ['remote-https', remoteName, endpoint.url], {
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 128);
  });
}

main().catch((err: Error) => {
  console.error(`git-remote-did: fatal: ${err.message}`);
  process.exit(128);
});
