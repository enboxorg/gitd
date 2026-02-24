/**
 * Tests for git-remote-did: URL parsing, service type utilities, and
 * endpoint resolution.
 *
 * Resolution tests require `DID_DHT_GATEWAY_URI` to be set (e.g. to
 * `https://enbox-did-dht.fly.dev`). Without it, resolution tests are skipped.
 */
import { DidDht } from '@enbox/dids';
import { parseDidUrl } from '../src/git-remote/parse-url.js';
import { resolveGitEndpoint } from '../src/git-remote/resolve.js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  createGitTransportService,
  getGitTransportServices,
  GIT_TRANSPORT_SERVICE_TYPE,
  isGitTransportService,
} from '../src/git-remote/service.js';

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
// resolveGitEndpoint — error cases (no network required)
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

// ---------------------------------------------------------------------------
// resolveGitEndpoint — happy paths (requires DID_DHT_GATEWAY_URI)
//
// These tests create real did:dht identities with various services and publish
// them to the DHT gateway. Set DID_DHT_GATEWAY_URI to enable them.
// ---------------------------------------------------------------------------

const gatewayUri = process.env.DID_DHT_GATEWAY_URI;
const describeDht = gatewayUri ? describe : describe.skip;

describeDht('resolveGitEndpoint (did:dht integration)', () => {
  /** DID with a GitTransport service. */
  let gitTransportDid: string;
  const gitEndpointUrl = 'https://git.example.com/repos';

  /** DID with only a DecentralizedWebNode service (fallback path). */
  let dwnOnlyDid: string;
  const dwnEndpointUrl = 'https://dwn.example.com';

  /** DID with no services at all. */
  let noServicesDid: string;

  /** DID with both GitTransport and DWN services (GitTransport should win). */
  let bothServicesDid: string;
  const gitPriorityUrl = 'https://git-priority.example.com';
  const dwnFallbackUrl = 'https://dwn-fallback.example.com';

  beforeAll(async () => {
    // Create and publish 4 DIDs with different service configurations.
    const [gitDid, dwnDid, emptyDid, bothDid] = await Promise.all([
      // 1. DID with GitTransport service only.
      DidDht.create({
        options: {
          publish  : true,
          services : [
            { id: 'git', type: 'GitTransport', serviceEndpoint: gitEndpointUrl },
          ],
        },
      }),

      // 2. DID with DecentralizedWebNode service only.
      DidDht.create({
        options: {
          publish  : true,
          services : [
            { id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: dwnEndpointUrl },
          ],
        },
      }),

      // 3. DID with no services.
      DidDht.create({
        options: { publish: true },
      }),

      // 4. DID with both GitTransport and DWN services.
      DidDht.create({
        options: {
          publish  : true,
          services : [
            { id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: dwnFallbackUrl },
            { id: 'git', type: 'GitTransport', serviceEndpoint: gitPriorityUrl },
          ],
        },
      }),
    ]);

    gitTransportDid = gitDid.uri;
    dwnOnlyDid = dwnDid.uri;
    noServicesDid = emptyDid.uri;
    bothServicesDid = bothDid.uri;
  }, 30000);

  afterAll(() => {
    // DIDs are ephemeral — no cleanup needed.
  });

  it('should resolve a DID with GitTransport service', async () => {
    const result = await resolveGitEndpoint(gitTransportDid);
    expect(result.did).toBe(gitTransportDid);
    expect(result.source).toBe('GitTransport');
    expect(result.url).toBe(gitEndpointUrl);
  });

  it('should append repo name to GitTransport endpoint', async () => {
    const result = await resolveGitEndpoint(gitTransportDid, 'my-repo');
    expect(result.url).toBe(`${gitEndpointUrl}/my-repo`);
    expect(result.source).toBe('GitTransport');
  });

  it('should fall back to DWN service with /git suffix', async () => {
    const result = await resolveGitEndpoint(dwnOnlyDid);
    expect(result.did).toBe(dwnOnlyDid);
    expect(result.source).toBe('DecentralizedWebNode');
    expect(result.url).toBe(`${dwnEndpointUrl}/git`);
  });

  it('should append repo name to DWN fallback endpoint', async () => {
    const result = await resolveGitEndpoint(dwnOnlyDid, 'my-repo');
    expect(result.url).toBe(`${dwnEndpointUrl}/git/my-repo`);
  });

  it('should throw when DID has no GitTransport or DWN services', async () => {
    await expect(
      resolveGitEndpoint(noServicesDid),
    ).rejects.toThrow('No GitTransport or DecentralizedWebNode service found');
  });

  it('should prefer GitTransport over DecentralizedWebNode when both exist', async () => {
    const result = await resolveGitEndpoint(bothServicesDid);
    expect(result.source).toBe('GitTransport');
    expect(result.url).toBe(gitPriorityUrl);
  });

  it('should prefer GitTransport over DWN even with repo appended', async () => {
    const result = await resolveGitEndpoint(bothServicesDid, 'test-repo');
    expect(result.source).toBe('GitTransport');
    expect(result.url).toBe(`${gitPriorityUrl}/test-repo`);
  });
});
