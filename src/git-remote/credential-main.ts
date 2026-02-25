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
 *   GITD_PASSWORD    — vault password for the local agent
 *   ENBOX_PROFILE    — (optional) profile name override
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';

import { Web5UserAgent } from '@enbox/agent';

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
import { profileDataPath, resolveProfile } from '../profiles/config.js';

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
  const password = process.env.GITD_PASSWORD;
  if (!password) {
    // Credential helpers must be non-interactive. If no password is set,
    // silently exit and let git fall back to another credential helper.
    return;
  }

  const { did, bearerDid } = await connectForCredentials(password);

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

  // Sign the token using the identity's DID signer (not the agent DID).
  const signer = await bearerDid.getSigner();
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
// Agent connection
// ---------------------------------------------------------------------------

/**
 * Connect to the Web5 agent and return the identity DID and its BearerDid.
 *
 * Resolves the active profile (env, git config, global default, or single
 * fallback) and connects using the profile's agent data path.  Falls back
 * to the legacy CWD-relative `DATA/AGENT` path when no profile exists.
 */
async function connectForCredentials(
  password: string,
): Promise<{ did: string; bearerDid: BearerDid }> {
  // Resolve profile (env, git config, global default, single fallback).
  // When a profile exists, the agent lives at ~/.enbox/profiles/<name>/DATA/AGENT.
  // Otherwise, fall back to the CWD-relative default path (legacy).
  const profileName = resolveProfile();
  const dataPath = profileName ? profileDataPath(profileName) : undefined;

  const agent = await Web5UserAgent.create(dataPath ? { dataPath } : undefined);
  await agent.start({ password });

  const identities = await agent.identity.list();
  const identity = identities[0];
  if (!identity) {
    throw new Error('No identity found in agent');
  }

  return { did: identity.did.uri, bearerDid: identity.did };
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
