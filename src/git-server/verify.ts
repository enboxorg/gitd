/**
 * DID-based signature verification for push authentication.
 *
 * Resolves a DID document, extracts the Ed25519 authentication key,
 * and verifies the signature. This is the production implementation
 * of the `SignatureVerifier` callback used by `createPushAuthenticator`.
 *
 * @module
 */

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
export function createDidSignatureVerifier(): SignatureVerifier {
  return async (did: string, payload: Uint8Array, signature: Uint8Array): Promise<boolean> => {
    try {
      const { didDocument, didResolutionMetadata } = await getResolver().resolve(did);

      if (didResolutionMetadata.error || !didDocument) {
        return false;
      }

      // Find an Ed25519 public key from the authentication verification methods.
      const publicKeyJwk = findEd25519AuthKey(didDocument);
      if (!publicKeyJwk) {
        return false;
      }

      return await Ed25519.verify({
        key       : publicKeyJwk,
        data      : payload,
        signature : signature,
      });
    } catch {
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
