/**
 * Agent bootstrapping — connects to (or creates) a local Enbox agent.
 *
 * On first run the agent vault is initialized with a password, a DID is
 * created, and the forge protocols are installed.  Subsequent runs unlock
 * the existing vault and return a ready-to-use `TypedEnbox` instance for
 * each protocol.
 *
 * Agent data is stored under the resolved profile path:
 *   `~/.enbox/profiles/<profile>/DATA/AGENT/`
 *
 * Uses `@enbox/auth` AuthManager for vault lifecycle, identity management,
 * DWN registration (provider-auth + PoW), and session persistence.
 *
 * @module
 */

import type { TypedEnbox } from '@enbox/api';
import type { ProviderAuthParams, RegistrationTokenData, SyncOption } from '@enbox/auth';

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { AuthManager } from '@enbox/auth';
import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import { createSqliteDwnApi } from './dwn-sqlite.js';
import { profileDataPath } from '../profiles/config.js';

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
  /** Active profile name, or `undefined` when running without a named profile. */
  profileName? : string;
  repo : TypedEnbox<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;
  refs : TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  issues : TypedEnbox<typeof ForgeIssuesProtocol.definition, ForgeIssuesSchemaMap>;
  patches : TypedEnbox<typeof ForgePatchesProtocol.definition, ForgePatchesSchemaMap>;
  ci : TypedEnbox<typeof ForgeCiProtocol.definition, ForgeCiSchemaMap>;
  releases : TypedEnbox<typeof ForgeReleasesProtocol.definition, ForgeReleasesSchemaMap>;
  registry : TypedEnbox<typeof ForgeRegistryProtocol.definition, ForgeRegistrySchemaMap>;
  social : TypedEnbox<typeof ForgeSocialProtocol.definition, ForgeSocialSchemaMap>;
  notifications : TypedEnbox<typeof ForgeNotificationsProtocol.definition, ForgeNotificationsSchemaMap>;
  wiki : TypedEnbox<typeof ForgeWikiProtocol.definition, ForgeWikiSchemaMap>;
  org : TypedEnbox<typeof ForgeOrgProtocol.definition, ForgeOrgSchemaMap>;
  enbox : Enbox;
};

/** Valid sync interval values. */
export type SyncInterval = 'off' | '1s' | '5s' | '15s' | '30s' | '1m' | '5m';

/** Options for connecting to the agent. */
export type ConnectOptions = {
  /** Vault password. */
  password : string;
  /**
   * Agent data path.  When provided, the agent stores all data under
   * this directory.  Defaults to `~/.enbox/profiles/default/DATA/AGENT`.
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

// Re-export types for external consumers.
export type { ProviderAuthParams, RegistrationTokenData };

// ---------------------------------------------------------------------------
// Registration token persistence
// ---------------------------------------------------------------------------

/** File name for cached DWN registration tokens. */
const TOKENS_FILE = 'registration-tokens.json';

/**
 * Resolve the path to the registration-tokens file for a profile.
 * The tokens file sits next to the `DATA/` directory inside the profile:
 *   `~/.enbox/profiles/<name>/registration-tokens.json`
 */
function tokensPath(dataPath: string): string {
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
 * Connect to the local Enbox agent, initializing on first launch.
 *
 * Uses `@enbox/auth` AuthManager for the full lifecycle:
 * - Vault initialization / unlock
 * - Identity creation (with optional recovery phrase)
 * - DWN registration (provider-auth with cached tokens + PoW fallback)
 * - Sync setup
 *
 * On first launch, a recovery phrase is returned for the user to back up.
 * Subsequent calls unlock the existing vault and restore the session.
 */
export async function connectAgent(options: ConnectOptions): Promise<AgentContext & { recoveryPhrase?: string }> {
  const { password, recoveryPhrase: inputPhrase, sync = 'off' } = options;

  // Always resolve to an absolute data path — never fall back to CWD.
  const dataPath = options.dataPath ?? profileDataPath('default');

  // Pre-construct a SQLite-backed DWN so that EnboxUserAgent.create()
  // skips the default LevelDB stores for the four core DWN interfaces.
  const dwnApi = await createSqliteDwnApi(dataPath);
  const agent = await EnboxUserAgent.create({ dataPath, dwnApi });

  // Create an AuthManager with the pre-built agent + registration config.
  const auth = await AuthManager.create({
    agent,
    password,
    sync         : sync === 'off' ? 'off' : sync as SyncOption,
    dwnEndpoints : ['https://enbox-dwn.fly.dev'],
    registration : {
      onSuccess              : () => { /* silent */ },
      onFailure              : (err) => { console.error(`[dwn-registration] ${(err as Error).message}`); },
      onProviderAuthRequired : handleProviderAuth,
      registrationTokens     : loadRegistrationTokens(dataPath),
      onRegistrationTokens   : (tokens) => { saveRegistrationTokens(dataPath, tokens); },
    },
  });

  // Connect: first launch initializes vault + creates identity;
  // subsequent launches unlock vault + restore identity.
  const session = await auth.connect({
    password,
    recoveryPhrase: inputPhrase,
  });

  // Build the Enbox API from the session.
  const enbox = Enbox.connect({ session });

  return bindProtocols(enbox, session.did, session.recoveryPhrase);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Bind typed protocol handles and configure all protocols. */
async function bindProtocols(
  enbox: Enbox,
  did: string,
  recoveryPhrase?: string,
): Promise<AgentContext & { recoveryPhrase?: string }> {
  const repo = enbox.using(ForgeRepoProtocol);
  const refs = enbox.using(ForgeRefsProtocol);
  const issues = enbox.using(ForgeIssuesProtocol);
  const patches = enbox.using(ForgePatchesProtocol);
  const ci = enbox.using(ForgeCiProtocol);
  const releases = enbox.using(ForgeReleasesProtocol);
  const registry = enbox.using(ForgeRegistryProtocol);
  const social = enbox.using(ForgeSocialProtocol);
  const notifications = enbox.using(ForgeNotificationsProtocol);
  const wiki = enbox.using(ForgeWikiProtocol);
  const org = enbox.using(ForgeOrgProtocol);

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
    registry, social, notifications, wiki, org, enbox,
    recoveryPhrase,
  };
}
