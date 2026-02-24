/**
 * Tests for the DID-based signature verifier.
 *
 * Tests the `createDidSignatureVerifier()` function using real Ed25519 key
 * pairs and `did:jwk` DIDs (no external infrastructure needed).
 */
import { describe, expect, it } from 'bun:test';

import { createDidSignatureVerifier } from '../src/git-server/verify.js';
import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sign data with an Ed25519 private key. */
async function sign(privateKeyJwk: Record<string, unknown>, data: Uint8Array): Promise<Uint8Array> {
  return Ed25519.sign({ key: privateKeyJwk as any, data });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDidSignatureVerifier', () => {
  it('should verify a valid signature from a did:jwk DID', async () => {
    // Create a did:jwk with an Ed25519 key.
    const bearerDid = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const verifier = createDidSignatureVerifier();

    // Sign some data using the private key.
    const data = new TextEncoder().encode('hello world');
    const vm = bearerDid.document.verificationMethod?.[0];
    expect(vm?.publicKeyJwk).toBeDefined();

    // Get the private key from the portable DID.
    const portableDid = await bearerDid.export();
    const privateKey = portableDid.privateKeys?.[0];
    expect(privateKey).toBeDefined();

    const signature = await sign(privateKey as Record<string, unknown>, data);

    const result = await verifier(bearerDid.uri, data, signature);
    expect(result).toBe(true);
  });

  it('should reject an invalid signature', async () => {
    const bearerDid = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const verifier = createDidSignatureVerifier();

    const data = new TextEncoder().encode('hello world');
    const badSignature = new Uint8Array(64).fill(0); // invalid signature

    const result = await verifier(bearerDid.uri, data, badSignature);
    expect(result).toBe(false);
  });

  it('should reject when data does not match the signature', async () => {
    const bearerDid = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const verifier = createDidSignatureVerifier();

    const data = new TextEncoder().encode('hello world');
    const portableDid = await bearerDid.export();
    const privateKey = portableDid.privateKeys?.[0];
    const signature = await sign(privateKey as Record<string, unknown>, data);

    // Verify with different data — should fail.
    const wrongData = new TextEncoder().encode('goodbye world');
    const result = await verifier(bearerDid.uri, wrongData, signature);
    expect(result).toBe(false);
  });

  it('should reject when DID cannot be resolved', async () => {
    const verifier = createDidSignatureVerifier();
    const data = new TextEncoder().encode('test');
    const signature = new Uint8Array(64);

    const result = await verifier('did:jwk:invalid-did-that-wont-resolve', data, signature);
    expect(result).toBe(false);
  });

  it('should reject a signature from a different DID', async () => {
    const did1 = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const did2 = await DidJwk.create({ options: { algorithm: 'Ed25519' } });
    const verifier = createDidSignatureVerifier();

    // Sign with did2's key but verify against did1's DID.
    const data = new TextEncoder().encode('cross-signed data');
    const portableDid2 = await did2.export();
    const privateKey2 = portableDid2.privateKeys?.[0];
    const signature = await sign(privateKey2 as Record<string, unknown>, data);

    const result = await verifier(did1.uri, data, signature);
    expect(result).toBe(false);
  });
});
