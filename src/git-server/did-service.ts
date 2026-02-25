/**
 * DID document service management for git transport.
 *
 * Adds or updates a `GitTransport` service entry in a DID document,
 * advertising the git smart HTTP endpoint for the `git-remote-did` helper.
 *
 * Also provides a helper to read the DWN endpoint(s) from the DID
 * document's `DecentralizedWebNode` service entry.
 *
 * This module works with the agent's DID API to persist and publish
 * service updates. For `did:dht`, the updated document is republished
 * to the DHT network.
 *
 * @module
 */

import type { Web5 } from '@enbox/api';

import { DidDht } from '@enbox/dids';

import { GIT_TRANSPORT_SERVICE_TYPE } from '../git-remote/service.js';

/** DID service type for Decentralized Web Nodes. */
const DWN_SERVICE_TYPE = 'DecentralizedWebNode';

/**
 * Default interval for periodic DID DHT republishing (1 hour).
 * The Mainline DHT TTL is ~2 hours; republishing every hour keeps
 * the record alive with comfortable margin.
 */
const DEFAULT_REPUBLISH_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * Read the DWN service endpoint(s) from the agent's DID document.
 *
 * Returns an array of endpoint URLs, or an empty array if no
 * `DecentralizedWebNode` service is found.
 *
 * @param web5 - The Web5 instance (provides agent DID document)
 */
export function getDwnEndpoints(web5: Web5): string[] {
  const agent = web5.agent as any;
  const doc = agent?.agentDid?.document;
  if (!doc?.service) { return []; }

  const svc = (doc.service as any[]).find(
    (s) => s.type === DWN_SERVICE_TYPE,
  );
  if (!svc) { return []; }

  const ep = svc.serviceEndpoint;
  if (Array.isArray(ep)) { return ep as string[]; }
  if (typeof ep === 'string') { return [ep]; }
  return [];
}

/**
 * Start a periodic timer that republishes the agent's DID document
 * to the DHT network.
 *
 * `did:dht` records in the Mainline DHT expire after ~2 hours if not
 * refreshed.  This function sets up an interval that keeps the record
 * alive so remote clients can always resolve the DID.
 *
 * The first republish happens immediately, then repeats every
 * `intervalMs` milliseconds (default: 1 hour).
 *
 * Only republishes `did:dht` DIDs.  For other methods (e.g. `did:jwk`)
 * this is a safe no-op.
 *
 * @param web5 - The Web5 instance (provides the agent's bearer DID)
 * @param intervalMs - Republish interval in ms (default: 1 hour)
 * @returns A cleanup function that stops the timer
 */
export function startDidRepublisher(
  web5: Web5,
  intervalMs: number = DEFAULT_REPUBLISH_INTERVAL_MS,
): () => void {
  const agent = web5.agent as any;
  const bearerDid = agent?.agentDid;

  if (!bearerDid || !bearerDid.uri?.startsWith('did:dht:')) {
    // Not a did:dht — nothing to republish.
    return (): void => {};
  }

  const republish = async (): Promise<void> => {
    try {
      await DidDht.publish({ did: bearerDid });
    } catch (err) {
      console.warn(`DID republish failed: ${(err as Error).message}`);
    }
  };

  // Publish immediately on startup, then periodically.
  void republish();
  const timer = setInterval(() => void republish(), intervalMs);

  return (): void => { clearInterval(timer); };
}
