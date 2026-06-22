import type { EnboxUserAgent } from '@enbox/agent';

type PortableDidPublic = {
  uri: string;
  document: any;
  metadata: any;
};

/**
 * Cache a public DID document in an agent's DID API before local DWN requests
 * need to verify messages signed by that DID.
 */
export async function cachePortableDid(
  agent: EnboxUserAgent,
  portableDid: PortableDidPublic,
  tenant: string = agent.agentDid.uri,
): Promise<void> {
  void tenant;
  await (agent.did as any).cache.set(portableDid.uri, {
    didDocument           : portableDid.document,
    didDocumentMetadata   : portableDid.metadata,
    didResolutionMetadata : {},
  });
}

/**
 * Cache the agent's own DID document in its DID API before local DWN requests
 * need to verify messages signed by the agent DID.
 */
export async function cacheAgentDid(agent: EnboxUserAgent): Promise<void> {
  await cachePortableDid(agent, await agent.agentDid.export(), agent.agentDid.uri);
}

/**
 * Create a test identity that can author encrypted DWN protocol records on
 * current Enbox SDKs. DID:JWK identities sign push tokens fine, but they do
 * not provide the keyAgreement material needed by encrypted protocol setup.
 */
export function createTestIdentity(
  agent: EnboxUserAgent,
  name: string,
): ReturnType<EnboxUserAgent['identity']['create']> {
  return agent.identity.create({
    didMethod  : 'dht',
    metadata   : { name },
    didOptions : {
      services            : [],
      verificationMethods : [
        { algorithm: 'Ed25519', id: 'sig', purposes: ['assertionMethod', 'authentication'] },
        { algorithm: 'X25519', id: 'enc', purposes: ['keyAgreement'] },
      ],
    },
  });
}
