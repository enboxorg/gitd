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

import type { TypedWeb5 } from '@enbox/api';

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
};

// ---------------------------------------------------------------------------
// Agent bootstrap
// ---------------------------------------------------------------------------

/**
 * Connect to the local Web5 agent, initializing on first launch.
 *
 * When `dataPath` is provided, the agent's persistent data lives there.
 * Otherwise, it falls back to `DATA/AGENT` relative to CWD (legacy).
 *
 * Sync is disabled — the CLI operates against the local DWN only.
 */
export async function connectAgent(options: ConnectOptions): Promise<AgentContext & { recoveryPhrase?: string }> {
  const { password, dataPath, recoveryPhrase: inputPhrase } = options;

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

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });

    return bindProtocols(result.web5, result.did, recoveryPhrase);
  }

  // Legacy: let Web5.connect() manage the agent (uses CWD-relative path).
  const result = await Web5.connect({ password, sync: 'off' });

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
