#!/usr/bin/env bun
/**
 * Minimal test daemon — starts a git server with /auth/token support.
 *
 * This is a stripped-down version of `gitd serve` that skips AuthManager,
 * DWN registration, DHT publishing, and DWN sync.  It opens the agent
 * directly, holds the LevelDB lock, and serves git + /auth/token.
 *
 * Usage:
 *   ENBOX_HOME=... GITD_PASSWORD=... GITD_REPOS=... bun tests/helpers/test-daemon.ts
 *
 * Writes a lockfile to $ENBOX_HOME/daemon.lock so the credential helper
 * can discover it.  The server port is printed to stdout as JSON.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import { createDidSignatureVerifier } from '../../src/git-server/verify.js';
import { createDwnPushAuthorizer } from '../../src/git-server/push-authorizer.js';
import { createGitServer } from '../../src/git-server/server.js';
import { ForgeRefsProtocol } from '../../src/refs.js';
import { ForgeRepoProtocol } from '../../src/repo.js';
import { GitBackend } from '../../src/git-server/git-backend.js';
import {
  createPushTokenPayload,
  decodePushToken,
  DID_AUTH_USERNAME,
  encodePushToken,
  formatAuthPassword,
  parseAuthPassword,
} from '../../src/git-server/auth.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const enboxHome = process.env.ENBOX_HOME ?? '';
const password = process.env.GITD_PASSWORD ?? '';
const reposPath = process.env.GITD_REPOS ?? '';

if (!enboxHome || !password || !reposPath) {
  console.error('Required: ENBOX_HOME, GITD_PASSWORD, GITD_REPOS');
  process.exit(1);
}

const dataPath = join(enboxHome, 'profiles', 'default', 'DATA', 'AGENT');

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Open the agent — this grabs the exclusive LevelDB lock.
  const agent = await EnboxUserAgent.create({ dataPath });

  // Initialize on first run, or just start if already initialized.
  try {
    await agent.start({ password });
  } catch {
    await agent.initialize({ password });
    await agent.start({ password });
  }

  const identities = await agent.identity.list();
  let identity = identities[0];
  if (!identity) {
    identity = await agent.identity.create({
      didMethod  : 'jwk',
      metadata   : { name: 'Test Daemon' },
      didOptions : { algorithm: 'Ed25519' },
    });
  }

  const enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
  const repoHandle = enbox.using(ForgeRepoProtocol);
  const refsHandle = enbox.using(ForgeRefsProtocol);
  await repoHandle.configure();
  await refsHandle.configure();

  // Create repo record + init bare repo if not already present.
  const repoName = process.env.GITD_REPO_NAME ?? 'test-repo';
  const { records: existingRepos } = await repoHandle.records.query('repo');
  let existing = false;
  for (const r of existingRepos) {
    const data = await r.data.json() as { name?: string };
    if (data.name === repoName) { existing = true; break; }
  }
  if (!existing) {
    await repoHandle.records.create('repo', {
      data : { name: repoName, description: 'test', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: repoName, visibility: 'public' },
    });
  }
  const backend = new GitBackend({ basePath: reposPath });
  await backend.initRepo(identity.did.uri, repoName);

  // Push authentication — inline authenticator WITHOUT nonce replay protection.
  // Git reuses the same credentials for both ref discovery GET and receive-pack
  // POST within a single push, so nonce-tracking would reject the second call.
  const verifySignature = createDidSignatureVerifier();
  const authorizePush = createDwnPushAuthorizer({
    repo     : repoHandle,
    ownerDid : identity.did.uri,
  });

  const authenticatePush = async (request: Request, did: string, repo: string): Promise<boolean> => {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) { return false; }

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) { return false; }

    const username = decoded.slice(0, colonIdx);
    const pw = decoded.slice(colonIdx + 1);
    if (username !== DID_AUTH_USERNAME) { return false; }

    let signed;
    try { signed = parseAuthPassword(pw); } catch { return false; }

    let payload;
    try { payload = decodePushToken(signed.token); } catch { return false; }

    if (payload.owner !== did || payload.repo !== repo) { return false; }
    if (payload.exp < Math.floor(Date.now() / 1000)) { return false; }

    const tokenBytes = new TextEncoder().encode(signed.token);
    const signatureBytes = new Uint8Array(Buffer.from(signed.signature, 'base64url'));
    if (!(await verifySignature(payload.did, tokenBytes, signatureBytes))) { return false; }

    return authorizePush(payload.did, did, repo);
  };

  // Token generation — the credential helper calls this via /auth/token.
  const generateToken = async (owner: string, repo: string): Promise<{ username: string; password: string } | null> => {
    const payload = createPushTokenPayload(identity.did.uri, owner, repo);
    const token = encodePushToken(payload);
    const signer = await identity.did.getSigner();
    const tokenBytes = new TextEncoder().encode(token);
    const signature = await signer.sign({ data: tokenBytes });
    const signatureBase64url = Buffer.from(signature).toString('base64url');
    return {
      username : DID_AUTH_USERNAME,
      password : formatAuthPassword({ signature: signatureBase64url, token }),
    };
  };

  const server = await createGitServer({
    basePath : reposPath,
    port     : 0,
    authenticatePush,
    generateToken,
  });

  // Write lockfile so the credential helper finds us.
  const lockData = {
    pid       : process.pid,
    port      : server.port,
    startedAt : new Date().toISOString(),
  };
  mkdirSync(enboxHome, { recursive: true });
  writeFileSync(
    join(enboxHome, 'daemon.lock'),
    JSON.stringify(lockData, null, 2) + '\n',
    { mode: 0o644 },
  );

  // Signal readiness to the parent process.
  console.log(JSON.stringify({ port: server.port, did: identity.did.uri }));

  // Keep alive until killed.
  await new Promise<void>(() => {
    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });
  });
}

main().catch((err: Error) => {
  console.error(`test-daemon: ${err.message}`);
  process.exit(1);
});
