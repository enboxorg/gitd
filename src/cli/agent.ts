/**
 * Agent bootstrapping — connects to (or creates) a local Web5 agent.
 *
 * On first run the agent vault is initialized with a password, a DID is
 * created, and the forge protocols are installed.  Subsequent runs unlock
 * the existing vault and return a ready-to-use `TypedWeb5` instance for
 * each protocol.
 *
 * @module
 */

import type { TypedWeb5 } from '@enbox/api';

import { Web5 } from '@enbox/api';

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

// ---------------------------------------------------------------------------
// Agent bootstrap
// ---------------------------------------------------------------------------

/**
 * Connect to the local Web5 agent, initializing on first launch.
 *
 * The agent's persistent data lives under `dataPath` (default:
 * `~/.dwn-git/agent`).  Sync is disabled — the CLI operates against
 * the local DWN only.
 */
export async function connectAgent(password: string): Promise<AgentContext> {
  const { web5, did, recoveryPhrase } = await Web5.connect({
    password,
    sync: 'off',
  });

  if (recoveryPhrase) {
    console.log('');
    console.log('  Recovery phrase (save this — it cannot be shown again):');
    console.log(`  ${recoveryPhrase}`);
    console.log('');
  }

  // Bind typed protocol handles.
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
  await repo.configure();
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
  };
}
