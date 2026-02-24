#!/usr/bin/env bun
/**
 * Git credential helper entry point for DID-based push authentication.
 *
 * Git invokes this binary with a single argument: `get`, `store`, or `erase`.
 * For `get`, the helper reads the request from stdin (key=value lines) and
 * writes credentials to stdout.
 *
 * This helper creates a DID-signed push token using the local Web5 agent's
 * identity, formatted as HTTP Basic auth credentials:
 *   username: did-auth
 *   password: <base64url-signature>.<base64url-token>
 *
 * Install in .gitconfig:
 *   [credential]
 *     helper = /path/to/git-remote-did-credential
 *
 * Environment:
 *   DWN_GIT_PASSWORD — vault password for the local agent
 *
 * @module
 */

import { Web5 } from '@enbox/api';

import {
  createPushTokenPayload,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
} from '../git-server/auth.js';
import {
  formatCredentialResponse,
  parseCredentialRequest,
} from './credential-helper.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const action = process.argv[2];

  // Only handle `get` requests — `store` and `erase` are no-ops.
  if (action !== 'get') {
    return;
  }

  // Read the credential request from stdin.
  const input = await readStdin();
  const request = parseCredentialRequest(input);

  // We only handle HTTP/HTTPS requests.
  if (request.protocol && request.protocol !== 'https' && request.protocol !== 'http') {
    return;
  }

  // Connect to the local agent to get the DID and signing key.
  const password = process.env.DWN_GIT_PASSWORD;
  if (!password) {
    // Credential helpers must be non-interactive. If no password is set,
    // silently exit and let git fall back to another credential helper.
    return;
  }

  const { web5, did } = await Web5.connect({
    password,
    sync: 'off',
  });

  // Extract the owner DID and repo from the URL path.
  const path = request.path ?? '';
  const segments = path.split('/').filter(Boolean);
  const didIdx = segments.findIndex((s) => s.startsWith('did:'));
  if (didIdx === -1) { return; }

  const ownerDid = segments[didIdx];
  const repo = segments[didIdx + 1];
  if (!repo) { return; }

  // Create the push token.
  const payload = createPushTokenPayload(did, ownerDid, repo);
  const token = encodePushToken(payload);

  // Sign the token using the agent's DID signer.
  const signer = await web5.agent.agentDid.getSigner();
  const tokenBytes = new TextEncoder().encode(token);
  const signature = await signer.sign({ data: tokenBytes });
  const signatureBase64url = Buffer.from(signature).toString('base64url');

  const creds = {
    username : DID_AUTH_USERNAME,
    password : formatAuthPassword({ signature: signatureBase64url, token }),
  };

  process.stdout.write(formatCredentialResponse(creds));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all of stdin until EOF. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.resume();
  });
}

main().catch(() => {
  // Credential helpers must never crash loudly — silent exit on error
  // lets git fall back to the next configured credential helper.
  process.exit(0);
});
