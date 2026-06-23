/**
 * DID-based signature verification for push authentication.
 *
 * Resolves a DID document, extracts the Ed25519 authentication key,
 * and verifies the signature. This is the production implementation
 * of the `SignatureVerifier` callback used by `createPushAuthenticator`.
 *
 * @module
 */

import type { DidDocument } from '@enbox/dids';
import type { SignatureVerifier } from './auth.js';

import { Ed25519 } from '@enbox/crypto';
import { DidDht, DidJwk, DidKey, DidWeb, UniversalResolver } from '@enbox/dids';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Shared resolver instance (lazy-initialized). */
let resolver: UniversalResolver | undefined;

/** Get or create the DID resolver. */
function getResolver(): UniversalResolver {
  if (!resolver) {
    resolver = new UniversalResolver({
      didResolvers: [DidDht, DidJwk, DidWeb, DidKey],
    });
  }
  return resolver;
}

// ---------------------------------------------------------------------------
// Signature verifier
// ---------------------------------------------------------------------------

/**
 * Create a `SignatureVerifier` that resolves a DID and verifies an Ed25519
 * signature against the DID document's authentication verification method.
 *
 * The verifier looks for the first Ed25519 verification method in the DID
 * document's `authentication` purpose (or falls back to `verificationMethod`
 * if no authentication methods are defined).
 *
 * @returns A `SignatureVerifier` callback
 */
/** DID resolution timeout in milliseconds. */
const DID_RESOLUTION_TIMEOUT_MS = 30_000;

/** Options for creating a DID signature verifier. */
export type DidSignatureVerifierOptions = {
  /**
   * DID documents the caller already trusts, keyed or listed by document ID.
   * These are checked before resolver lookup and are useful for freshly
   * created local DIDs whose DHT publication may not be visible yet.
   */
  didDocuments?: DidDocument[] | Map<string, DidDocument> | Record<string, DidDocument>;
};

export function createDidSignatureVerifier(options: DidSignatureVerifierOptions = {}): SignatureVerifier {
  const localDocuments = normalizeDidDocuments(options.didDocuments);

  return async (did: string, payload: Uint8Array, signature: Uint8Array): Promise<boolean> => {
    try {
      const localDocument = localDocuments.get(did);
      if (localDocument) {
        if (process.env.GITD_DEBUG === '1') {
          console.error(`[auth] verifying ${did} with local DID document`);
        }
        return verifyWithDocument(localDocument, payload, signature);
      }

      if (process.env.GITD_DEBUG === '1') {
        console.error(`[auth] resolving ${did} for signature verification`);
      }
      const { didDocument, didResolutionMetadata } = await Promise.race([
        getResolver().resolve(did),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DID resolution timed out for ${did}`)), DID_RESOLUTION_TIMEOUT_MS),
        ),
      ]);

      if (didResolutionMetadata.error || !didDocument) {
        return false;
      }

      return verifyWithDocument(didDocument, payload, signature);
    } catch (err) {
      if (process.env.GITD_DEBUG === '1') {
        console.error(`[auth] signature verification error for ${did}: ${(err as Error).message}`);
      }
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the first Ed25519 public key JWK from a DID document's authentication
 * verification methods.
 */
function findEd25519AuthKey(didDocument: { verificationMethod?: any[]; authentication?: any[] }): any | undefined {
  const methods = didDocument.verificationMethod ?? [];

  // If authentication references exist, filter to those methods.
  const authRefs = didDocument.authentication ?? [];
  const authMethodIds = new Set<string>();
  for (const ref of authRefs) {
    if (typeof ref === 'string') {
      authMethodIds.add(ref);
    } else if (ref?.id) {
      authMethodIds.add(ref.id);
    }
  }

  // Prefer authentication methods; fall back to all verification methods.
  const candidates = authMethodIds.size > 0
    ? methods.filter((m) => authMethodIds.has(m.id))
    : methods;

  for (const method of candidates) {
    const jwk = method.publicKeyJwk;
    if (jwk && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
      return jwk;
    }
  }

  return undefined;
}

async function verifyWithDocument(
  didDocument: DidDocument,
  payload: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const publicKeyJwk = findEd25519AuthKey(didDocument);
  if (!publicKeyJwk) {
    return false;
  }

  return Ed25519.verify({
    key       : publicKeyJwk,
    data      : payload,
    signature : signature,
  });
}

function normalizeDidDocuments(
  didDocuments: DidSignatureVerifierOptions['didDocuments'],
): Map<string, DidDocument> {
  const result = new Map<string, DidDocument>();
  if (!didDocuments) { return result; }

  if (didDocuments instanceof Map) {
    return new Map(didDocuments);
  }

  const docs = Array.isArray(didDocuments) ? didDocuments : Object.values(didDocuments);
  for (const doc of docs) {
    if (doc?.id) {
      result.set(doc.id, doc);
    }
  }
  return result;
}
