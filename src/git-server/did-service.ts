/**
 * DID document service management for git transport.
 *
 * Adds or updates a `GitTransport` service entry in a DID document,
 * advertising the git smart HTTP endpoint for the `git-remote-did` helper.
 *
 * This module works with the agent's DID API to persist and publish
 * service updates. For `did:dht`, the updated document is republished
 * to the DHT network.
 *
 * @module
 */

import type { Web5 } from '@enbox/api';

import { GIT_TRANSPORT_SERVICE_TYPE } from '../git-remote/service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default service entry ID for the git transport endpoint. */
const GIT_SERVICE_ID = '#git';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a GitTransport service endpoint in the agent's DID document.
 *
 * If a GitTransport service already exists, its endpoint is updated.
 * Otherwise, a new service entry is created. The updated DID document
 * is persisted in the agent store and (for did:dht) republished.
 *
 * @param web5 - The Web5 instance (provides agent DID and did API)
 * @param endpoint - The git transport HTTPS URL (e.g. `https://git.example.com`)
 * @throws If the agent does not support DID updates
 */
export async function registerGitService(web5: Web5, endpoint: string): Promise<void> {
  const agent = web5.agent as any;

  // Verify the agent supports DID updates.
  if (!agent.did?.update) {
    console.warn(
      'Agent does not support DID document updates. ' +
      'GitTransport service not registered. ' +
      'The git-remote-did helper will need a DWN endpoint fallback.',
    );
    return;
  }

  const bearerDid = agent.agentDid;
  const portableDid = await bearerDid.export();

  // Look for an existing GitTransport service.
  const services = portableDid.document.service ?? [];
  const existingIdx = services.findIndex(
    (s: any) => s.type === GIT_TRANSPORT_SERVICE_TYPE || s.id?.endsWith('git'),
  );

  const newService = {
    id              : GIT_SERVICE_ID,
    type            : GIT_TRANSPORT_SERVICE_TYPE,
    serviceEndpoint : endpoint,
  };

  if (existingIdx >= 0) {
    services[existingIdx] = newService;
  } else {
    services.push(newService);
  }

  portableDid.document.service = services;

  await agent.did.update({ portableDid });
}
