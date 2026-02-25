/**
 * Agent bootstrapping — connects to (or creates) a local Web5 agent.
 *
 * On first run the agent vault is initialized with a password, a DID is
 * created, and the forge protocols are installed.  Subsequent runs unlock
 * the existing vault and return a ready-to-use `TypedWeb5` instance for
 * each protocol.
 *
 * Agent data is stored under the resolved profile path:
 *   `~/.enbox/profiles/<profile>/DATA/AGENT/`
 *
 * @module
 */

import type { ProviderAuthParams, RegistrationTokenData, TypedWeb5 } from '@enbox/api';

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import type { ForgeCiSchemaMap } from '../ci.js';
import type { ForgeIssuesSchemaMap } from '../issues.js';
import type { ForgeNotificationsSchemaMap } from '../notifications.js';
import type { ForgeOrgSchemaMap } from '../org.js';
import type { ForgePatchesSchemaMap } from '../patches.js';
import type { ForgeRefsSchemaMap } from '../refs.js';
import type { ForgeRegistrySchemaMap } from '../registry.js';
import type { ForgeReleasesSchemaMap } from '../releases.js';
import type { ForgeRepoSchemaMap } from '../repo.js';
import type { ForgeSocialSchemaMap } from '../social.js';
import type { ForgeWikiSchemaMap } from '../wiki.js';

import { ForgeCiProtocol } from '../ci.js';
import { ForgeIssuesProtocol } from '../issues.js';
import { ForgeNotificationsProtocol } from '../notifications.js';
import { ForgeOrgProtocol } from '../org.js';
import { ForgePatchesProtocol } from '../patches.js';
import { ForgeRefsProtocol } from '../refs.js';
import { ForgeRegistryProtocol } from '../registry.js';
import { ForgeReleasesProtocol } from '../releases.js';
import { ForgeRepoProtocol } from '../repo.js';
import { ForgeSocialProtocol } from '../social.js';
import { ForgeWikiProtocol } from '../wiki.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context returned by `connectAgent()` — provides typed protocol handles. */
export type AgentContext = {
  did : string;
  /** Active profile name, or `undefined` when running in legacy (CWD) mode. */
  profileName? : string;
  repo : TypedWeb5<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;
  refs : TypedWeb5<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  issues : TypedWeb5<typeof ForgeIssuesProtocol.definition, ForgeIssuesSchemaMap>;
  patches : TypedWeb5<typeof ForgePatchesProtocol.definition, ForgePatchesSchemaMap>;
  ci : TypedWeb5<typeof ForgeCiProtocol.definition, ForgeCiSchemaMap>;
  releases : TypedWeb5<typeof ForgeReleasesProtocol.definition, ForgeReleasesSchemaMap>;
  registry : TypedWeb5<typeof ForgeRegistryProtocol.definition, ForgeRegistrySchemaMap>;
  social : TypedWeb5<typeof ForgeSocialProtocol.definition, ForgeSocialSchemaMap>;
  notifications : TypedWeb5<typeof ForgeNotificationsProtocol.definition, ForgeNotificationsSchemaMap>;
  wiki : TypedWeb5<typeof ForgeWikiProtocol.definition, ForgeWikiSchemaMap>;
  org : TypedWeb5<typeof ForgeOrgProtocol.definition, ForgeOrgSchemaMap>;
  web5 : Web5;
};

/** Valid sync interval values accepted by `Web5.connect()`. */
export type SyncInterval = 'off' | '1s' | '5s' | '15s' | '30s' | '1m' | '5m';

/** Options for connecting to the agent. */
export type ConnectOptions = {
  /** Vault password. */
  password : string;
  /**
   * Agent data path.  When provided, the agent stores all data under
   * this directory instead of the default `DATA/AGENT` relative to CWD.
   *
   * The profile system sets this to `~/.enbox/profiles/<name>/DATA/AGENT`.
   */
  dataPath? : string;
  /**
   * Optional recovery phrase (12-word BIP-39 mnemonic) for initializing
   * a new vault.  When omitted, a new phrase is generated automatically.
   */
  recoveryPhrase? : string;
  /**
   * DWN sync interval.  When set to anything other than `'off'`, the
   * agent automatically replicates local DWN records to the remote
   * DWN endpoint registered in the DID document.
   *
   * - `'off'`  — no sync (default for one-shot CLI commands)
   * - `'5s'`   — aggressive sync (good for `serve`)
   * - `'30s'`  — moderate sync
   * - `'1m'`   — lazy sync
   *
   * @default 'off'
   */
  sync? : SyncInterval;
};

// ---------------------------------------------------------------------------
// Registration token persistence
// ---------------------------------------------------------------------------

/** Re-export for external use. */
export type { ProviderAuthParams, RegistrationTokenData };

/** File name for cached DWN registration tokens. */
const TOKENS_FILE = 'registration-tokens.json';

/**
 * Resolve the path to the registration-tokens file for a profile.
 * The tokens file sits next to the `DATA/` directory inside the profile:
 *   `~/.enbox/profiles/<name>/registration-tokens.json`
 *
 * When `dataPath` ends with `/DATA/AGENT`, the profile root is two levels up.
 * Otherwise, falls back to a sibling of `dataPath`.
 */
function tokensPath(dataPath: string): string {
  // dataPath is typically `~/.enbox/profiles/<name>/DATA/AGENT`.
  // Walk up to the profile root (`<name>/`).
  const profileRoot = dataPath.endsWith('/DATA/AGENT')
    ? dirname(dirname(dataPath))
    : dirname(dataPath);
  return join(profileRoot, TOKENS_FILE);
}

/** Load cached registration tokens from disk. */
function loadRegistrationTokens(
  dataPath: string,
): Record<string, RegistrationTokenData> {
  const path = tokensPath(dataPath);
  if (!existsSync(path)) { return {}; }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, RegistrationTokenData>;
  } catch {
    return {};
  }
}

/** Persist registration tokens to disk. */
function saveRegistrationTokens(
  dataPath: string,
  tokens: Record<string, RegistrationTokenData>,
): void {
  const path = tokensPath(dataPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Provider auth callback
// ---------------------------------------------------------------------------

/**
 * Handle the `provider-auth-v0` flow for DWN servers that require it.
 *
 * The Enbox DWN servers expose an authorize endpoint that returns a JSON
 * response with `{ code, state }` directly (no interactive browser flow).
 * This callback fetches that URL and returns the auth code to the SDK.
 */
async function handleProviderAuth(
  params: ProviderAuthParams,
): Promise<{ code: string; state: string }> {
  const response = await fetch(params.authorizeUrl, {
    method : 'GET',
    signal : AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Provider auth failed for ${params.dwnEndpoint}: `
      + `${response.status} ${response.statusText}: ${body}`,
    );
  }

  const result = await response.json() as { code: string; state: string };
  return { code: result.code, state: result.state };
}

// ---------------------------------------------------------------------------
// Agent bootstrap
// ---------------------------------------------------------------------------

/**
 * Connect to the local Web5 agent, initializing on first launch.
 *
 * When `dataPath` is provided, the agent's persistent data lives there.
 * Otherwise, it falls back to `DATA/AGENT` relative to CWD (legacy).
 *
 * Sync defaults to `'off'` for one-shot commands.  Long-running
 * commands like `serve` should pass an explicit interval.
 */
export async function connectAgent(options: ConnectOptions): Promise<AgentContext & { recoveryPhrase?: string }> {
  const { password, dataPath, recoveryPhrase: inputPhrase, sync = 'off' } = options;

  let agent: Web5UserAgent;
  let recoveryPhrase: string | undefined;

  if (dataPath) {
    // Profile-based: create agent with explicit data path.
    agent = await Web5UserAgent.create({ dataPath });

    if (await agent.firstLaunch()) {
      recoveryPhrase = await agent.initialize({
        password,
        recoveryPhrase : inputPhrase,
        dwnEndpoints   : ['https://enbox-dwn.fly.dev'],
      });
    }
    await agent.start({ password });

    // Ensure at least one identity exists.
    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod  : 'dht',
        metadata   : { name: 'Default' },
        didOptions : {
          services: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://enbox-dwn.fly.dev'],
            enc             : '#enc',
            sig             : '#sig',
          }],
          verificationMethods: [
            { algorithm: 'Ed25519', id: 'sig', purposes: ['assertionMethod', 'authentication'] },
            { algorithm: 'X25519', id: 'enc', purposes: ['keyAgreement'] },
          ],
        },
      });
    }

    // Build the registration option so the SDK handles both PoW and
    // provider-auth-v0 servers automatically.  Tokens are cached on disk
    // so that re-auth only happens when they expire.
    const cachedTokens = loadRegistrationTokens(dataPath);
    let registrationOk = false;

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync,
      registration : {
        registrationTokens     : cachedTokens,
        onProviderAuthRequired : handleProviderAuth,
        onRegistrationTokens(tokens): void {
          saveRegistrationTokens(dataPath, tokens);
        },
        onSuccess(): void { registrationOk = true; },
        onFailure(error): void {
          // Log but don't throw — the agent can still function locally
          // even if DWN registration fails (sync will fail later).
          console.error('[dwn-registration] failed:', error);
        },
      },
    });

    if (registrationOk) {
      // Silently note success — useful when debugging sync issues.
      // console.log('[dwn-registration] ok');
    }

    return bindProtocols(result.web5, result.did, recoveryPhrase);
  }

  // Legacy: let Web5.connect() manage the agent (uses CWD-relative path).
  // Still wire up provider-auth so legacy setups can register with
  // provider-auth-v0 DWN servers.
  const legacyDataPath = join(process.cwd(), 'DATA', 'AGENT');
  const legacyCachedTokens = loadRegistrationTokens(legacyDataPath);

  const result = await Web5.connect({
    password,
    sync,
    registration: {
      registrationTokens     : legacyCachedTokens,
      onProviderAuthRequired : handleProviderAuth,
      onRegistrationTokens(tokens): void {
        saveRegistrationTokens(legacyDataPath, tokens);
      },
      onSuccess(): void { /* ok */ },
      onFailure(error): void {
        console.error('[dwn-registration] failed:', error);
      },
    },
  });

  if (result.recoveryPhrase) {
    console.log('');
    console.log('  Recovery phrase (save this — it cannot be shown again):');
    console.log(`  ${result.recoveryPhrase}`);
    console.log('');
  }

  return bindProtocols(result.web5, result.did, result.recoveryPhrase);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Bind typed protocol handles and configure all protocols. */
async function bindProtocols(
  web5: Web5,
  did: string,
  recoveryPhrase?: string,
): Promise<AgentContext & { recoveryPhrase?: string }> {
  const repo = web5.using(ForgeRepoProtocol);
  const refs = web5.using(ForgeRefsProtocol);
  const issues = web5.using(ForgeIssuesProtocol);
  const patches = web5.using(ForgePatchesProtocol);
  const ci = web5.using(ForgeCiProtocol);
  const releases = web5.using(ForgeReleasesProtocol);
  const registry = web5.using(ForgeRegistryProtocol);
  const social = web5.using(ForgeSocialProtocol);
  const notifications = web5.using(ForgeNotificationsProtocol);
  const wiki = web5.using(ForgeWikiProtocol);
  const org = web5.using(ForgeOrgProtocol);

  // Install / verify all protocols (idempotent).
  // Repo protocol requires encryption: webhook has encryptionRequired: true,
  // and bundle records are optionally encrypted based on repo visibility.
  await repo.configure({ encryption: true });
  await refs.configure();
  await issues.configure();
  await patches.configure();
  await ci.configure();
  await releases.configure();
  await registry.configure();
  await social.configure();
  await notifications.configure();
  await wiki.configure();
  await org.configure();

  return {
    did, repo, refs, issues, patches, ci, releases,
    registry, social, notifications, wiki, org, web5,
    recoveryPhrase,
  };
}
