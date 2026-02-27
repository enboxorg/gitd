#!/usr/bin/env bun
/**
 * Git credential helper for DID-based push authentication.
 *
 * Git invokes credential helpers with a single argument: `get`, `store`, or
 * `erase`. For `get`, the helper reads the request from stdin and writes
 * credentials to stdout.
 *
 * This helper creates a DID-signed push token using the local Web5 agent's
 * identity, formatted as HTTP Basic auth credentials:
 *   username: did-auth
 *   password: <base64url-signature>.<base64url-token>
 *
 * Usage in .gitconfig:
 *   [credential "https://git.example.com"]
 *     helper = /path/to/gitd-credential-helper
 *
 * Environment:
 *   GITD_PASSWORD — vault password for the local agent
 *
 * @module
 */

import { Ed25519 } from '@enbox/crypto';

import {
  createPushTokenPayload,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
} from '../git-server/auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed credential request from git. */
export type CredentialRequest = {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
  password?: string;
};

// ---------------------------------------------------------------------------
// Credential helper logic
// ---------------------------------------------------------------------------

/**
 * Generate push credentials for a git request.
 *
 * @param request - The parsed credential request from git
 * @param agentDid - The local agent's DID
 * @param privateKeyJwk - The agent's Ed25519 private key (JWK)
 * @returns The credential response to write to stdout, or undefined if not applicable
 */
export async function generatePushCredentials(
  request: CredentialRequest,
  agentDid: string,
  privateKeyJwk: Record<string, unknown>,
): Promise<{ username: string; password: string } | undefined> {
  // Extract the owner DID and repo from the URL path.
  // Expected path format: /<did>/<repo> or /<prefix>/<did>/<repo>
  const path = request.path ?? '';
  const segments = path.split('/').filter(Boolean);

  // Find the DID segment (starts with "did:").
  const didIdx = segments.findIndex((s) => s.startsWith('did:'));
  if (didIdx === -1) { return undefined; }

  const ownerDid = segments[didIdx];
  const repo = segments[didIdx + 1];
  if (!repo) { return undefined; }

  // Create and sign the push token.
  const payload = createPushTokenPayload(agentDid, ownerDid, repo);
  const token = encodePushToken(payload);
  const tokenBytes = new TextEncoder().encode(token);

  const signature = await Ed25519.sign({
    key  : privateKeyJwk as any,
    data : tokenBytes,
  });

  const signatureBase64url = Buffer.from(signature).toString('base64url');

  return {
    username : DID_AUTH_USERNAME,
    password : formatAuthPassword({ signature: signatureBase64url, token }),
  };
}

// ---------------------------------------------------------------------------
// stdin/stdout protocol
// ---------------------------------------------------------------------------

/** Parse a git credential helper request from stdin lines. */
export function parseCredentialRequest(input: string): CredentialRequest {
  const result: CredentialRequest = {};
  for (const line of input.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) { continue; }
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key === 'protocol') { result.protocol = value; }
    if (key === 'host') { result.host = value; }
    if (key === 'path') { result.path = value; }
    if (key === 'username') { result.username = value; }
    if (key === 'password') { result.password = value; }
  }
  return result;
}

/** Format a credential response for git. */
export function formatCredentialResponse(creds: { username: string; password: string }): string {
  return `username=${creds.username}\npassword=${creds.password}\n`;
}
