/**
 * Tests for git-remote-did: URL parsing, service type utilities, and
 * endpoint resolution.
 */
import { describe, expect, it } from 'bun:test';

import {
  createGitTransportService,
  getGitTransportServices,
  GIT_TRANSPORT_SERVICE_TYPE,
  isGitTransportService,
} from '../src/git-remote/service.js';

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
// GitTransport service type utilities
// ---------------------------------------------------------------------------

describe('GitTransport service type', () => {
  describe('GIT_TRANSPORT_SERVICE_TYPE constant', () => {
    it('should be "GitTransport"', () => {
      expect(GIT_TRANSPORT_SERVICE_TYPE).toBe('GitTransport');
    });
  });

  describe('createGitTransportService', () => {
    it('should create a service entry with correct type', () => {
      const service = createGitTransportService({
        id              : '#git',
        serviceEndpoint : 'https://git.example.com',
      });
      expect(service.type).toBe('GitTransport');
      expect(service.id).toBe('#git');
      expect(service.serviceEndpoint).toBe('https://git.example.com');
    });

    it('should auto-add # prefix to id if missing', () => {
      const service = createGitTransportService({
        id              : 'git',
        serviceEndpoint : 'https://git.example.com',
      });
      expect(service.id).toBe('#git');
    });

    it('should not double-prefix # on id', () => {
      const service = createGitTransportService({
        id              : '#git',
        serviceEndpoint : 'https://git.example.com',
      });
      expect(service.id).toBe('#git');
    });

    it('should accept an array of endpoints', () => {
      const service = createGitTransportService({
        id              : '#git',
        serviceEndpoint : ['https://git1.example.com', 'https://git2.example.com'],
      });
      expect(service.serviceEndpoint).toEqual(['https://git1.example.com', 'https://git2.example.com']);
    });

    it('should reject empty string endpoint', () => {
      expect(() => createGitTransportService({
        id              : '#git',
        serviceEndpoint : '',
      })).toThrow('non-empty string');
    });

    it('should reject array with empty string endpoint', () => {
      expect(() => createGitTransportService({
        id              : '#git',
        serviceEndpoint : ['https://git.example.com', ''],
      })).toThrow('non-empty string');
    });
  });

  describe('isGitTransportService', () => {
    it('should return true for GitTransport services', () => {
      const service = { id: '#git', type: 'GitTransport', serviceEndpoint: 'https://git.example.com' };
      expect(isGitTransportService(service)).toBe(true);
    });

    it('should return false for DWN services', () => {
      const service = { id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: 'https://dwn.example.com' };
      expect(isGitTransportService(service)).toBe(false);
    });

    it('should return false for other service types', () => {
      const service = { id: '#linked', type: 'LinkedDomains', serviceEndpoint: 'https://example.com' };
      expect(isGitTransportService(service)).toBe(false);
    });
  });

  describe('getGitTransportServices', () => {
    it('should extract GitTransport services from a DID document', () => {
      const didDocument = {
        id      : 'did:dht:abc123',
        service : [
          { id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: 'https://dwn.example.com' },
          { id: '#git', type: 'GitTransport', serviceEndpoint: 'https://git.example.com' },
        ],
      };
      const services = getGitTransportServices(didDocument);
      expect(services).toHaveLength(1);
      expect(services[0].id).toBe('#git');
      expect(services[0].type).toBe('GitTransport');
    });

    it('should return empty array when no GitTransport services exist', () => {
      const didDocument = {
        id      : 'did:dht:abc123',
        service : [
          { id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: 'https://dwn.example.com' },
        ],
      };
      const services = getGitTransportServices(didDocument);
      expect(services).toHaveLength(0);
    });

    it('should return empty array when DID document has no services', () => {
      const didDocument = { id: 'did:dht:abc123' };
      const services = getGitTransportServices(didDocument);
      expect(services).toHaveLength(0);
    });

    it('should return multiple GitTransport services if present', () => {
      const didDocument = {
        id      : 'did:dht:abc123',
        service : [
          { id: '#git1', type: 'GitTransport', serviceEndpoint: 'https://git1.example.com' },
          { id: '#git2', type: 'GitTransport', serviceEndpoint: 'https://git2.example.com' },
        ],
      };
      const services = getGitTransportServices(didDocument);
      expect(services).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveGitEndpoint
// ---------------------------------------------------------------------------

describe('resolveGitEndpoint', () => {
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
