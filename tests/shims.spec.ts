/**
 * Package manager and container registry shim tests — exercises the
 * npm, Go, and OCI shim request handlers against a real Web5 agent
 * populated with DWN records.
 *
 * The test agent is created once in `beforeAll`, packages are seeded
 * for each ecosystem (npm, go, oci), and then each test calls the
 * handler functions directly with constructed URLs.  No HTTP server
 * is started.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Web5 } from '@enbox/api';
import { Web5UserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';

import { ForgeCiProtocol } from '../src/ci.js';
import { ForgeIssuesProtocol } from '../src/issues.js';
import { ForgeNotificationsProtocol } from '../src/notifications.js';
import { ForgeOrgProtocol } from '../src/org.js';
import { ForgePatchesProtocol } from '../src/patches.js';
import { ForgeRefsProtocol } from '../src/refs.js';
import { ForgeRegistryProtocol } from '../src/registry.js';
import { ForgeReleasesProtocol } from '../src/releases.js';
import { ForgeRepoProtocol } from '../src/repo.js';
import { ForgeSocialProtocol } from '../src/social.js';
import { ForgeWikiProtocol } from '../src/wiki.js';

import { handleGoProxyRequest, parseGoModulePath } from '../src/shims/go/proxy.js';
import { handleNpmRequest, parseNpmScope } from '../src/shims/npm/registry.js';
import { handleOciRequest, parseOciName } from '../src/shims/oci/registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/shims-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDid: string;
let ctx: AgentContext;

/** Create a URL for the npm shim. */
function npmUrl(path: string): URL {
  return new URL(path, 'http://localhost:4873');
}

/** Create a URL for the Go proxy shim. */
function goUrl(path: string): URL {
  return new URL(path, 'http://localhost:4874');
}

/** Create a URL for the OCI shim. */
function ociUrl(path: string): URL {
  return new URL(path, 'http://localhost:5555');
}

/** Parse JSON from a string or Uint8Array body. */
function parseBody(body: string | Uint8Array): any {
  if (typeof body === 'string') { return JSON.parse(body); }
  return JSON.parse(new TextDecoder().decode(body));
}

// Tarball: 8-byte gzip magic number (same as resolver tests).
const TARBALL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);

// OCI manifest JSON.
const OCI_MANIFEST = JSON.stringify({
  schemaVersion : 2,
  mediaType     : 'application/vnd.oci.image.manifest.v1+json',
  config        : {
    mediaType : 'application/vnd.oci.image.config.v1+json',
    digest    : 'sha256:abcdef0123456789',
    size      : 1024,
  },
  layers: [{
    mediaType : 'application/vnd.oci.image.layer.v1.tar+gzip',
    digest    : 'sha256:layer0123456789',
    size      : 2048,
  }],
});
const OCI_MANIFEST_BYTES = new TextEncoder().encode(OCI_MANIFEST);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Package manager shims', () => {

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await Web5UserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Shim Test' },
      });
    }

    const result = await Web5.connect({
      agent,
      connectedDid : identity.did.uri,
      sync         : 'off',
    });
    const { web5, did } = result;
    testDid = did;

    const repo = web5.using(ForgeRepoProtocol);
    const refs = web5.using(ForgeRefsProtocol);
    const issues = web5.using(ForgeIssuesProtocol);
    const patches = web5.using(ForgePatchesProtocol);
    const ci = web5.using(ForgeCiProtocol);
    const releases = web5.using(ForgeReleasesProtocol);
    const registry = web5.using(ForgeRegistryProtocol);
    const social = web5.using(ForgeSocialProtocol);
    const notifications = web5.using(ForgeNotificationsProtocol);
    const wiki = web5.using(ForgeWikiProtocol);
    const org = web5.using(ForgeOrgProtocol);

    await repo.configure();
    await refs.configure();
    await issues.configure();
    await patches.configure();
    await ci.configure();
    await releases.configure();
    await registry.configure();
    await social.configure();
    await notifications.configure();
    await wiki.configure();
    await org.configure();

    ctx = {
      did, repo, refs, issues, patches, ci, releases,
      registry, social, notifications, wiki, org, web5,
    };

    // -----------------------------------------------------------------------
    // Seed npm package: "my-utils" with v1.0.0 and v2.0.0
    // -----------------------------------------------------------------------
    const { record: npmPkgRec } = await registry.records.create('package', {
      data : { name: 'my-utils', description: 'Utility functions' },
      tags : { name: 'my-utils', ecosystem: 'npm', description: 'Utility functions' },
    });
    const npmPkgCtx = npmPkgRec!.contextId ?? '';

    // v1.0.0 — no deps
    const { record: npmV1Rec } = await registry.records.create('package/version' as any, {
      data            : { semver: '1.0.0', dependencies: {} },
      tags            : { semver: '1.0.0' },
      parentContextId : npmPkgCtx,
    } as any);
    const npmV1Ctx = npmV1Rec!.contextId ?? '';

    await registry.records.create('package/version/tarball' as any, {
      data            : TARBALL_BYTES,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-utils-1.0.0.tgz', contentType: 'application/gzip', size: 8 },
      parentContextId : npmV1Ctx,
    } as any);

    // v2.0.0 — has dependency
    const { record: npmV2Rec } = await registry.records.create('package/version' as any, {
      data            : { semver: '2.0.0', dependencies: { [`${testDid}/my-utils`]: '1.0.0' } },
      tags            : { semver: '2.0.0' },
      parentContextId : npmPkgCtx,
    } as any);
    const npmV2Ctx = npmV2Rec!.contextId ?? '';

    await registry.records.create('package/version/tarball' as any, {
      data            : TARBALL_BYTES,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-utils-2.0.0.tgz', contentType: 'application/gzip', size: 8 },
      parentContextId : npmV2Ctx,
    } as any);

    // -----------------------------------------------------------------------
    // Seed Go module: "my-mod" with v1.0.0 and v2.0.0
    // -----------------------------------------------------------------------
    const { record: goPkgRec } = await registry.records.create('package', {
      data : { name: 'my-mod', description: 'Go module' },
      tags : { name: 'my-mod', ecosystem: 'go', description: 'Go module' },
    });
    const goPkgCtx = goPkgRec!.contextId ?? '';

    const { record: goV1Rec } = await registry.records.create('package/version' as any, {
      data            : { semver: '1.0.0', dependencies: {} },
      tags            : { semver: '1.0.0' },
      parentContextId : goPkgCtx,
    } as any);
    const goV1Ctx = goV1Rec!.contextId ?? '';

    await registry.records.create('package/version/tarball' as any, {
      data            : TARBALL_BYTES,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-mod-1.0.0.tar.gz', contentType: 'application/gzip', size: 8 },
      parentContextId : goV1Ctx,
    } as any);

    // v2.0.0 with a dependency
    const { record: goV2Rec } = await registry.records.create('package/version' as any, {
      data            : { semver: '2.0.0', dependencies: { [`${testDid}/my-mod`]: '1.0.0' } },
      tags            : { semver: '2.0.0' },
      parentContextId : goPkgCtx,
    } as any);
    const goV2Ctx = goV2Rec!.contextId ?? '';

    await registry.records.create('package/version/tarball' as any, {
      data            : TARBALL_BYTES,
      dataFormat      : 'application/gzip',
      tags            : { filename: 'my-mod-2.0.0.tar.gz', contentType: 'application/gzip', size: 8 },
      parentContextId : goV2Ctx,
    } as any);

    // -----------------------------------------------------------------------
    // Seed OCI image: "my-image" with v1.0.0
    // -----------------------------------------------------------------------
    const { record: ociPkgRec } = await registry.records.create('package', {
      data : { name: 'my-image', description: 'Container image' },
      tags : { name: 'my-image', ecosystem: 'oci', description: 'Container image' },
    });
    const ociPkgCtx = ociPkgRec!.contextId ?? '';

    const { record: ociV1Rec } = await registry.records.create('package/version' as any, {
      data            : { semver: 'v1.0.0', dependencies: {} },
      tags            : { semver: 'v1.0.0' },
      parentContextId : ociPkgCtx,
    } as any);
    const ociV1Ctx = ociV1Rec!.contextId ?? '';

    await registry.records.create('package/version/tarball' as any, {
      data            : OCI_MANIFEST_BYTES,
      dataFormat      : 'application/octet-stream',
      tags            : { filename: 'manifest.json', contentType: 'application/octet-stream', size: OCI_MANIFEST_BYTES.byteLength },
      parentContextId : ociV1Ctx,
    } as any);
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // parseNpmScope
  // =========================================================================

  describe('parseNpmScope()', () => {
    it('should parse a DID-scoped npm path', () => {
      const result = parseNpmScope('/@did:dht:abc123/my-pkg');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:dht:abc123');
      expect(result!.name).toBe('my-pkg');
    });

    it('should parse a URL-encoded DID scope', () => {
      const result = parseNpmScope('/@did%3Adht%3Aabc123/my-pkg');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:dht:abc123');
      expect(result!.name).toBe('my-pkg');
    });

    it('should return null for non-DID scopes', () => {
      expect(parseNpmScope('/@myorg/my-pkg')).toBeNull();
    });

    it('should return null for unscoped packages', () => {
      expect(parseNpmScope('/lodash')).toBeNull();
    });
  });

  // =========================================================================
  // parseGoModulePath
  // =========================================================================

  describe('parseGoModulePath()', () => {
    it('should parse a DID-scoped Go module path', () => {
      const result = parseGoModulePath('did:dht:abc123/my-mod');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:dht:abc123');
      expect(result!.name).toBe('my-mod');
    });

    it('should decode Go module proxy encoding', () => {
      // In Go proxy encoding, uppercase → !lowercase
      const result = parseGoModulePath('did:dht:abc123/my!module');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('myModule');
    });

    it('should handle nested module paths', () => {
      const result = parseGoModulePath('did:dht:abc123/org/sub-mod');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('org/sub-mod');
    });

    it('should return null for invalid paths', () => {
      expect(parseGoModulePath('not-a-did/mod')).toBeNull();
    });
  });

  // =========================================================================
  // parseOciName
  // =========================================================================

  describe('parseOciName()', () => {
    it('should parse a DID-scoped OCI repository name', () => {
      const result = parseOciName('did:dht:abc123/my-image');
      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:dht:abc123');
      expect(result!.imageName).toBe('my-image');
    });

    it('should handle nested image names', () => {
      const result = parseOciName('did:dht:abc123/org/sub-image');
      expect(result).not.toBeNull();
      expect(result!.imageName).toBe('org/sub-image');
    });

    it('should return null for invalid names', () => {
      expect(parseOciName('not-a-did')).toBeNull();
    });

    it('should return null for plain image names without DID', () => {
      expect(parseOciName('library/nginx')).toBeNull();
    });
  });

  // =========================================================================
  // npm registry shim
  // =========================================================================

  describe('npm registry shim', () => {
    describe('GET /@did/name — packument', () => {
      it('should return a packument with all versions', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.name).toBe(`@${testDid}/my-utils`);
        expect(body.description).toBe('Utility functions');
        expect(body['dist-tags'].latest).toBeDefined();
        expect(body.versions['1.0.0']).toBeDefined();
        expect(body.versions['2.0.0']).toBeDefined();
      });

      it('should include tarball URLs in each version', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
        const body = parseBody(res.body);
        const v1 = body.versions['1.0.0'];
        expect(v1.dist.tarball).toContain('my-utils-1.0.0.tgz');
      });

      it('should include dependencies in version metadata', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
        const body = parseBody(res.body);
        const v2 = body.versions['2.0.0'];
        expect(v2.dependencies).toBeDefined();
        expect(v2.dependencies[`${testDid}/my-utils`]).toBe('1.0.0');
      });

      it('should include DWN metadata in _dwn field', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
        const body = parseBody(res.body);
        expect(body._dwn.publisherDid).toBe(testDid);
        expect(body._dwn.ecosystem).toBe('npm');
      });

      it('should return 404 for nonexistent packages', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/nonexistent`));
        expect(res.status).toBe(404);
      });
    });

    describe('GET /@did/name/version — version metadata', () => {
      it('should return version-specific metadata', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils/1.0.0`));
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.name).toBe(`@${testDid}/my-utils`);
        expect(body.version).toBe('1.0.0');
        expect(body.dist.tarball).toContain('my-utils-1.0.0.tgz');
      });

      it('should return 404 for nonexistent version', async () => {
        const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils/9.9.9`));
        expect(res.status).toBe(404);
      });
    });

    describe('GET tarball — download', () => {
      it('should return the tarball bytes', async () => {
        const res = await handleNpmRequest(
          ctx,
          npmUrl(`/-/@${testDid}/my-utils/-/my-utils-1.0.0.tgz`),
        );
        expect(res.status).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/octet-stream');

        const bytes = res.body as Uint8Array;
        expect(bytes.byteLength).toBe(TARBALL_BYTES.byteLength);
        expect(bytes[0]).toBe(0x1f);
        expect(bytes[1]).toBe(0x8b);
      });

      it('should return 404 for nonexistent tarball', async () => {
        const res = await handleNpmRequest(
          ctx,
          npmUrl(`/-/@${testDid}/my-utils/-/my-utils-9.9.9.tgz`),
        );
        expect(res.status).toBe(404);
      });

      it('should return 404 for malformed tarball filename', async () => {
        const res = await handleNpmRequest(
          ctx,
          npmUrl(`/-/@${testDid}/my-utils/-/bad-file.tar`),
        );
        expect(res.status).toBe(404);
      });
    });

    describe('error cases', () => {
      it('should return 404 for non-DID-scoped requests', async () => {
        const res = await handleNpmRequest(ctx, npmUrl('/lodash'));
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.error).toContain('DID-scoped');
      });
    });
  });

  // =========================================================================
  // Go module proxy shim
  // =========================================================================

  describe('Go module proxy shim', () => {
    describe('GET /@v/list — version list', () => {
      it('should list available versions with v prefix', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/list`),
        );
        expect(res.status).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/plain');

        const body = res.body as string;
        expect(body).toContain('v1.0.0');
        expect(body).toContain('v2.0.0');
      });

      it('should return 410 for nonexistent module', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/nonexistent/@v/list`),
        );
        expect(res.status).toBe(410);
      });
    });

    describe('GET /@v/{ver}.info — version info', () => {
      it('should return version info JSON', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v1.0.0.info`),
        );
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.Version).toBe('v1.0.0');
        expect(body.Time).toBeDefined();
      });

      it('should handle versions without v prefix', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/1.0.0.info`),
        );
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.Version).toBe('v1.0.0');
      });

      it('should return 410 for nonexistent version', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v9.9.9.info`),
        );
        expect(res.status).toBe(410);
      });
    });

    describe('GET /@v/{ver}.mod — go.mod file', () => {
      it('should return a valid go.mod file', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v1.0.0.mod`),
        );
        expect(res.status).toBe(200);

        const body = res.body as string;
        expect(body).toContain(`module did.enbox.org/${testDid}/my-mod`);
        expect(body).toContain('go 1.21');
      });

      it('should include dependencies in go.mod', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v2.0.0.mod`),
        );
        expect(res.status).toBe(200);

        const body = res.body as string;
        expect(body).toContain('require (');
        expect(body).toContain(`did.enbox.org/${testDid}/my-mod`);
      });
    });

    describe('GET /@v/{ver}.zip — module archive', () => {
      it('should return the module archive bytes', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v1.0.0.zip`),
        );
        expect(res.status).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/zip');

        const bytes = res.body as Uint8Array;
        expect(bytes.byteLength).toBe(TARBALL_BYTES.byteLength);
      });

      it('should return 410 for nonexistent version', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/v9.9.9.zip`),
        );
        expect(res.status).toBe(410);
      });
    });

    describe('GET /@latest — latest version', () => {
      it('should return the latest version info', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@latest`),
        );
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.Version).toBeDefined();
        expect(body.Time).toBeDefined();
      });

      it('should return 410 for nonexistent module', async () => {
        const res = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/nonexistent/@latest`),
        );
        expect(res.status).toBe(410);
      });
    });

    describe('error cases', () => {
      it('should return 404 for non-module paths', async () => {
        const res = await handleGoProxyRequest(ctx, goUrl('/random/path'));
        expect(res.status).toBe(404);
      });

      it('should return 404 for invalid module paths', async () => {
        const res = await handleGoProxyRequest(ctx, goUrl('/not-a-did/@v/list'));
        expect(res.status).toBe(404);
      });
    });
  });

  // =========================================================================
  // OCI/Docker registry shim
  // =========================================================================

  describe('OCI/Docker registry shim', () => {
    describe('GET /v2/ — API version check', () => {
      it('should return 200 with registry API version header', async () => {
        const res = await handleOciRequest(ctx, ociUrl('/v2/'));
        expect(res.status).toBe(200);
        expect(res.headers['Docker-Distribution-Api-Version']).toBe('registry/2.0');
      });

      it('should work without trailing slash', async () => {
        const res = await handleOciRequest(ctx, ociUrl('/v2'));
        expect(res.status).toBe(200);
      });
    });

    describe('GET /v2/{name}/tags/list — list tags', () => {
      it('should list available tags', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/tags/list`),
        );
        expect(res.status).toBe(200);

        const body = parseBody(res.body);
        expect(body.name).toBe(`${testDid}/my-image`);
        expect(body.tags).toBeArray();
        expect(body.tags).toContain('v1.0.0');
      });

      it('should return 404 for nonexistent repository', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/nonexistent/tags/list`),
        );
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.errors[0].code).toBe('NAME_UNKNOWN');
      });

      it('should return 404 for invalid repository names', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl('/v2/not-a-did/tags/list'),
        );
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.errors[0].code).toBe('NAME_INVALID');
      });
    });

    describe('GET /v2/{name}/manifests/{reference} — pull manifest', () => {
      it('should return the manifest by tag', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/v1.0.0`),
        );
        expect(res.status).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/vnd.oci.image.manifest.v1+json');
        expect(res.headers['Docker-Content-Digest']).toMatch(/^sha256:/);

        const body = parseBody(res.body);
        expect(body.schemaVersion).toBe(2);
        expect(body.config).toBeDefined();
        expect(body.layers).toBeArray();
      });

      it('should return the manifest by digest', async () => {
        // First get the digest from a tag-based request.
        const tagRes = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/v1.0.0`),
        );
        const digest = tagRes.headers['Docker-Content-Digest'];

        // Now fetch by digest.
        const digestRes = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/${digest}`),
        );
        expect(digestRes.status).toBe(200);
        expect(digestRes.headers['Docker-Content-Digest']).toBe(digest);
      });

      it('should handle HEAD requests (manifest existence check)', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/v1.0.0`),
          'HEAD',
        );
        expect(res.status).toBe(200);
        expect(res.headers['Docker-Content-Digest']).toMatch(/^sha256:/);
        expect(res.headers['Content-Length']).toBeDefined();
        // HEAD response body should be empty.
        expect(res.body).toBe('');
      });

      it('should return 404 for nonexistent tag', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/v9.9.9`),
        );
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.errors[0].code).toBe('MANIFEST_UNKNOWN');
      });

      it('should return 404 for nonexistent digest', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/sha256:0000000000000000`),
        );
        expect(res.status).toBe(404);
      });
    });

    describe('GET /v2/{name}/blobs/{digest} — pull blob', () => {
      it('should return a blob matching the manifest content digest', async () => {
        // Get the digest of the manifest (which is our "blob" in this test).
        const tagRes = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/v1.0.0`),
        );
        const digest = tagRes.headers['Docker-Content-Digest'];

        const blobRes = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/blobs/${digest}`),
        );
        expect(blobRes.status).toBe(200);
        expect(blobRes.headers['Content-Type']).toBe('application/octet-stream');
        expect(blobRes.headers['Docker-Content-Digest']).toBe(digest);
      });

      it('should return 404 for nonexistent blob digest', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/blobs/sha256:0000000000000000`),
        );
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.errors[0].code).toBe('BLOB_UNKNOWN');
      });

      it('should return 404 for nonexistent repository', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/nonexistent/blobs/sha256:0000`),
        );
        expect(res.status).toBe(404);
      });
    });

    describe('error cases', () => {
      it('should return 404 for invalid v2 paths', async () => {
        const res = await handleOciRequest(ctx, ociUrl('/v2/invalid'));
        expect(res.status).toBe(404);
      });

      it('should return OCI error envelope with code and message', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/nonexistent/manifests/latest`),
        );
        expect(res.status).toBe(404);
        const body = parseBody(res.body);
        expect(body.errors).toBeArray();
        expect(body.errors[0].code).toBeDefined();
        expect(body.errors[0].message).toBeDefined();
      });

      it('should include Docker-Distribution-Api-Version header in errors', async () => {
        const res = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/nonexistent/manifests/latest`),
        );
        expect(res.headers['Docker-Distribution-Api-Version']).toBe('registry/2.0');
      });
    });
  });

  // =========================================================================
  // Cross-cutting concerns
  // =========================================================================

  describe('cross-cutting', () => {
    it('npm packument dist-tags.latest should point to a real version', async () => {
      const res = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
      const body = parseBody(res.body);
      const latest = body['dist-tags'].latest;
      expect(body.versions[latest]).toBeDefined();
    });

    it('Go proxy list and .info should be consistent', async () => {
      const listRes = await handleGoProxyRequest(
        ctx,
        goUrl(`/${testDid}/my-mod/@v/list`),
      );
      const versions = (listRes.body as string).split('\n').filter(Boolean);
      expect(versions.length).toBeGreaterThan(0);

      // Each listed version should have valid .info
      for (const ver of versions) {
        const infoRes = await handleGoProxyRequest(
          ctx,
          goUrl(`/${testDid}/my-mod/@v/${ver}.info`),
        );
        expect(infoRes.status).toBe(200);
      }
    });

    it('OCI tags/list and manifests should be consistent', async () => {
      const tagsRes = await handleOciRequest(
        ctx,
        ociUrl(`/v2/${testDid}/my-image/tags/list`),
      );
      const body = parseBody(tagsRes.body);

      for (const tag of body.tags) {
        const manifestRes = await handleOciRequest(
          ctx,
          ociUrl(`/v2/${testDid}/my-image/manifests/${tag}`),
        );
        expect(manifestRes.status).toBe(200);
      }
    });

    it('all shims return CORS headers', async () => {
      const npmRes = await handleNpmRequest(ctx, npmUrl(`/@${testDid}/my-utils`));
      expect(npmRes.headers['Access-Control-Allow-Origin']).toBe('*');

      const goRes = await handleGoProxyRequest(
        ctx,
        goUrl(`/${testDid}/my-mod/@v/list`),
      );
      expect(goRes.headers['Access-Control-Allow-Origin']).toBe('*');

      const ociRes = await handleOciRequest(ctx, ociUrl('/v2/'));
      expect(ociRes.headers['Access-Control-Allow-Origin']).toBe('*');
    });
  });
});
