/**
 * Tests for git-remote-did URL parsing and endpoint resolution.
 */
import { describe, expect, it } from 'bun:test';

import { parseDidUrl } from '../src/git-remote/parse-url.js';
import { resolveGitEndpoint } from '../src/git-remote/resolve.js';

// ---------------------------------------------------------------------------
// parseDidUrl
// ---------------------------------------------------------------------------

describe('parseDidUrl', () => {
  describe('double-colon form (did::address)', () => {
    it('should parse did:dht DID without repo', () => {
      // Git strips "did::" prefix, passes "dht:abc123"
      const result = parseDidUrl('dht:abc123');
      expect(result.did).toBe('did:dht:abc123');
      expect(result.repo).toBeUndefined();
    });

    it('should parse did:dht DID with repo name', () => {
      const result = parseDidUrl('dht:abc123/my-repo');
      expect(result.did).toBe('did:dht:abc123');
      expect(result.repo).toBe('my-repo');
    });

    it('should parse did:web DID with repo name', () => {
      const result = parseDidUrl('web:example.com/my-repo');
      expect(result.did).toBe('did:web:example.com');
      expect(result.repo).toBe('my-repo');
    });

    it('should parse did:web with path-encoded colons', () => {
      // did:web:example.com:user:repos → method-specific-id is "example.com:user:repos"
      const result = parseDidUrl('web:example.com:user:repos/my-repo');
      expect(result.did).toBe('did:web:example.com:user:repos');
      expect(result.repo).toBe('my-repo');
    });

    it('should parse did:key DID', () => {
      const result = parseDidUrl('key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP');
      expect(result.did).toBe('did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP');
      expect(result.repo).toBeUndefined();
    });

    it('should handle trailing slash without repo', () => {
      const result = parseDidUrl('dht:abc123/');
      expect(result.did).toBe('did:dht:abc123');
      expect(result.repo).toBeUndefined();
    });
  });

  describe('did:// form', () => {
    it('should parse did:// URL with repo', () => {
      const result = parseDidUrl('did://dht:abc123/my-repo');
      expect(result.did).toBe('did:dht:abc123');
      expect(result.repo).toBe('my-repo');
    });

    it('should parse did:// URL without repo', () => {
      const result = parseDidUrl('did://dht:abc123');
      expect(result.did).toBe('did:dht:abc123');
      expect(result.repo).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('should reject empty string', () => {
      expect(() => parseDidUrl('')).toThrow('Invalid DID URL');
    });

    it('should reject malformed DID (missing method)', () => {
      expect(() => parseDidUrl(':abc123')).toThrow('Invalid DID URL');
    });

    it('should reject malformed DID (missing identifier)', () => {
      expect(() => parseDidUrl('dht:')).toThrow('Invalid DID URL');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveGitEndpoint
// ---------------------------------------------------------------------------

describe('resolveGitEndpoint', () => {
  // Note: These tests require real DID resolution (network access).
  // We test the error cases that don't require a network call, and skip
  // the happy path since it depends on a live Pkarr relay / DHT gateway.

  it('should reject an unresolvable DID', async () => {
    await expect(
      resolveGitEndpoint('did:jwk:invalidjwk'),
    ).rejects.toThrow();
  });

  it('should reject a DID method with no resolver', async () => {
    await expect(
      resolveGitEndpoint('did:nonexistent:abc123'),
    ).rejects.toThrow();
  });
});
