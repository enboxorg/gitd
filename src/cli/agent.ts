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

import type { ForgeIssuesSchemaMap } from '../issues.js';
import type { ForgePatchesSchemaMap } from '../patches.js';
import type { ForgeRepoSchemaMap } from '../repo.js';

import { ForgeIssuesProtocol } from '../issues.js';
import { ForgePatchesProtocol } from '../patches.js';
import { ForgeRepoProtocol } from '../repo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context returned by `connectAgent()` — provides typed protocol handles. */
export type AgentContext = {
  did : string;
  repo : TypedWeb5<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;
  issues : TypedWeb5<typeof ForgeIssuesProtocol.definition, ForgeIssuesSchemaMap>;
  patches : TypedWeb5<typeof ForgePatchesProtocol.definition, ForgePatchesSchemaMap>;
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

  // Install / verify all three core protocols (idempotent).
  const repo = web5.using(ForgeRepoProtocol);
  const issues = web5.using(ForgeIssuesProtocol);
  const patches = web5.using(ForgePatchesProtocol);

  await repo.configure();
  await issues.configure();
  await patches.configure();

  return { did, repo, issues, patches, web5 };
}
