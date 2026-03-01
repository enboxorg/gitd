/**
 * Unified daemon tests — exercises the ShimAdapter interface, config
 * resolution, adapter server creation, and daemon lifecycle.
 *
 * Tests the daemon infrastructure against a real Enbox agent — each
 * adapter's HTTP server is started and receives real HTTP requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { rmSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import type { AgentContext } from '../src/cli/agent.js';
import type { DaemonConfig, ShimAdapter } from '../src/daemon/adapter.js';

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
import { githubAdapter } from '../src/daemon/adapters/github.js';
import { goAdapter } from '../src/daemon/adapters/go.js';
import { npmAdapter } from '../src/daemon/adapters/npm.js';
import { ociAdapter } from '../src/daemon/adapters/oci.js';
import { builtinAdapters, findAdapter } from '../src/daemon/adapters/index.js';
import { createAdapterServer, resolveConfig, startDaemon } from '../src/daemon/server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_PATH = '__TESTDATA__/daemon-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a simple HTTP GET request and return status + body. */
async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

/** Make an HTTP request with a specific method and optional JSON body. */
async function httpRequest(
  port: number, path: string, method: string, jsonBody?: Record<string, unknown>,
): Promise<{ status: number; body: string; headers: Headers }> {
  const opts: RequestInit = { method };
  if (jsonBody) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(jsonBody);
  }
  const res = await fetch(`http://localhost:${port}${path}`, opts);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Unified daemon', () => {
  let ctx: AgentContext;
  let testDid: string;

  beforeAll(async () => {
    rmSync(DATA_PATH, { recursive: true, force: true });

    const agent = await EnboxUserAgent.create({ dataPath: DATA_PATH });
    await agent.initialize({ password: 'test-password' });
    await agent.start({ password: 'test-password' });

    const identities = await agent.identity.list();
    let identity = identities[0];
    if (!identity) {
      identity = await agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Daemon Test' },
      });
    }

    const enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
    const did = identity.did.uri;
    testDid = did;

    const repo = enbox.using(ForgeRepoProtocol);
    const refs = enbox.using(ForgeRefsProtocol);
    const issues = enbox.using(ForgeIssuesProtocol);
    const patches = enbox.using(ForgePatchesProtocol);
    const ci = enbox.using(ForgeCiProtocol);
    const releases = enbox.using(ForgeReleasesProtocol);
    const registry = enbox.using(ForgeRegistryProtocol);
    const social = enbox.using(ForgeSocialProtocol);
    const notifications = enbox.using(ForgeNotificationsProtocol);
    const wiki = enbox.using(ForgeWikiProtocol);
    const org = enbox.using(ForgeOrgProtocol);

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
      registry, social, notifications, wiki, org, enbox,
    };

    // Seed a repo for GitHub shim testing.
    await ctx.repo.records.create('repo', {
      data : { name: 'daemon-test', description: 'Test repo', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'daemon-test', visibility: 'public' },
    });
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  // =========================================================================
  // Adapter registry
  // =========================================================================

  describe('adapter registry', () => {
    it('should have 4 built-in adapters', () => {
      expect(builtinAdapters.length).toBe(4);
    });

    it('should have github, npm, go, oci adapters', () => {
      const ids = builtinAdapters.map((a) => a.id);
      expect(ids).toContain('github');
      expect(ids).toContain('npm');
      expect(ids).toContain('go');
      expect(ids).toContain('oci');
    });

    it('should find adapters by id', () => {
      expect(findAdapter('github')).toBe(githubAdapter);
      expect(findAdapter('npm')).toBe(npmAdapter);
      expect(findAdapter('go')).toBe(goAdapter);
      expect(findAdapter('oci')).toBe(ociAdapter);
    });

    it('should return undefined for unknown adapter id', () => {
      expect(findAdapter('maven')).toBeUndefined();
    });
  });

  // =========================================================================
  // Adapter properties
  // =========================================================================

  describe('adapter properties', () => {
    it('should have correct ids', () => {
      expect(githubAdapter.id).toBe('github');
      expect(npmAdapter.id).toBe('npm');
      expect(goAdapter.id).toBe('go');
      expect(ociAdapter.id).toBe('oci');
    });

    it('should have unique default ports', () => {
      const ports = builtinAdapters.map((a) => a.defaultPort);
      expect(new Set(ports).size).toBe(ports.length);
    });

    it('should have unique port env vars', () => {
      const envVars = builtinAdapters.map((a) => a.portEnvVar);
      expect(new Set(envVars).size).toBe(envVars.length);
    });

    it('should have human-readable names', () => {
      for (const adapter of builtinAdapters) {
        expect(adapter.name.length).toBeGreaterThan(0);
      }
    });

    it('should have usage hints with port placeholder', () => {
      for (const adapter of builtinAdapters) {
        if (adapter.usageHint) {
          expect(adapter.usageHint).toContain('{port}');
        }
      }
    });
  });

  // =========================================================================
  // Config resolution
  // =========================================================================

  describe('resolveConfig()', () => {
    it('should use defaults when config is empty', () => {
      const resolved = resolveConfig({});
      expect(resolved.length).toBe(4);
      for (const r of resolved) {
        expect(r.enabled).toBe(true);
        expect(r.port).toBe(r.adapter.defaultPort);
      }
    });

    it('should apply port overrides from config', () => {
      const config: DaemonConfig = {
        shims: {
          github : { port: 9999 },
          npm    : { port: 7777 },
        },
      };
      const resolved = resolveConfig(config);
      const github = resolved.find((r) => r.adapter.id === 'github');
      const npm = resolved.find((r) => r.adapter.id === 'npm');
      expect(github?.port).toBe(9999);
      expect(npm?.port).toBe(7777);
    });

    it('should disable adapters via config', () => {
      const config: DaemonConfig = {
        shims: {
          go  : { enabled: false },
          oci : { enabled: false },
        },
      };
      const resolved = resolveConfig(config);
      const go = resolved.find((r) => r.adapter.id === 'go');
      const oci = resolved.find((r) => r.adapter.id === 'oci');
      expect(go?.enabled).toBe(false);
      expect(oci?.enabled).toBe(false);

      const github = resolved.find((r) => r.adapter.id === 'github');
      expect(github?.enabled).toBe(true);
    });

    it('should resolve config for custom adapter list', () => {
      const custom: ShimAdapter = {
        id          : 'maven',
        name        : 'Maven Central',
        defaultPort : 8082,
        portEnvVar  : 'GITD_MAVEN_PORT',
        async handle(): Promise<void> { /* noop */ },
      };
      const resolved = resolveConfig({}, [custom]);
      expect(resolved.length).toBe(1);
      expect(resolved[0].adapter.id).toBe('maven');
      expect(resolved[0].port).toBe(8082);
    });
  });

  // =========================================================================
  // createAdapterServer() — health endpoint
  // =========================================================================

  describe('createAdapterServer()', () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      server = createAdapterServer(ctx, githubAdapter);
      await new Promise<void>((resolve) => {
        server.listen(0, () => { resolve(); });
      });
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });

    it('should respond to /health with ok status', async () => {
      const { status, body } = await httpGet(port, '/health');
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.status).toBe('ok');
      expect(data.shim).toBe('github');
    });

    it('should handle CORS preflight', async () => {
      const res = await fetch(`http://localhost:${port}/anything`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });

    it('should delegate to the adapter for real requests', async () => {
      // GET /users/:did should be handled by the GitHub adapter.
      const { status, body } = await httpGet(port, `/users/${testDid}`);
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.login).toBe(testDid);
    });
  });

  // =========================================================================
  // startDaemon() — full lifecycle
  // =========================================================================

  describe('startDaemon()', () => {
    it('should start only enabled adapters', async () => {
      const config: DaemonConfig = {
        shims: {
          github : { enabled: true, port: 0 },
          npm    : { enabled: false },
          go     : { enabled: false },
          oci    : { enabled: false },
        },
      };

      const instance = await startDaemon({ ctx, config });
      try {
        expect(instance.servers.size).toBe(1);
        expect(instance.servers.has('github')).toBe(true);
        expect(instance.servers.has('npm')).toBe(false);
      } finally {
        await instance.stop();
      }
    });

    it('should return empty servers when nothing is enabled', async () => {
      const config: DaemonConfig = {
        shims: {
          github : { enabled: false },
          npm    : { enabled: false },
          go     : { enabled: false },
          oci    : { enabled: false },
        },
      };

      const instance = await startDaemon({ ctx, config });
      expect(instance.servers.size).toBe(0);
    });

    it('should start multiple adapters and serve health on each', async () => {
      const config: DaemonConfig = {
        shims: {
          github : { port: 0 },
          npm    : { port: 0 },
          go     : { enabled: false },
          oci    : { enabled: false },
        },
      };

      const instance = await startDaemon({ ctx, config });
      try {
        expect(instance.servers.size).toBe(2);

        const githubServer = instance.servers.get('github')!;
        const npmServer = instance.servers.get('npm')!;
        const githubPort = (githubServer.address() as AddressInfo).port;
        const npmPort = (npmServer.address() as AddressInfo).port;

        // Health on github port.
        const gh = await httpGet(githubPort, '/health');
        expect(JSON.parse(gh.body).shim).toBe('github');

        // Health on npm port.
        const npm = await httpGet(npmPort, '/health');
        expect(JSON.parse(npm.body).shim).toBe('npm');
      } finally {
        await instance.stop();
      }
    });

    it('should stop all servers on stop()', async () => {
      const config: DaemonConfig = {
        shims: {
          github : { port: 0 },
          npm    : { enabled: false },
          go     : { enabled: false },
          oci    : { enabled: false },
        },
      };

      const instance = await startDaemon({ ctx, config });
      const port = (instance.servers.get('github')!.address() as AddressInfo).port;

      // Verify server is running.
      const before = await httpGet(port, '/health');
      expect(before.status).toBe(200);

      await instance.stop();
      expect(instance.servers.size).toBe(0);

      // Verify server is stopped (fetch should fail).
      try {
        await fetch(`http://localhost:${port}/health`);
        // If we get here without error, that's unexpected.
        expect(true).toBe(false);
      } catch {
        // Expected — connection refused.
        expect(true).toBe(true);
      }
    });
  });

  // =========================================================================
  // GitHub adapter — via daemon
  // =========================================================================

  describe('GitHub adapter via daemon', () => {
    let port: number;
    let server: Server;

    beforeAll(async () => {
      server = createAdapterServer(ctx, githubAdapter);
      await new Promise<void>((resolve) => { server.listen(0, () => { resolve(); }); });
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });

    it('should serve repo info via GET', async () => {
      const { status, body } = await httpGet(port, `/repos/${testDid}/daemon-test`);
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.name).toBe('daemon-test');
    });

    it('should create an issue via POST', async () => {
      const { status, body } = await httpRequest(port, `/repos/${testDid}/daemon-test/issues`, 'POST', {
        title : 'Daemon test issue',
        body  : 'Created via daemon.',
      });
      expect(status).toBe(201);
      const data = JSON.parse(body);
      expect(data.title).toBe('Daemon test issue');
      expect(data.state).toBe('open');
    });

    it('should return 404 for unknown routes', async () => {
      const { status } = await httpGet(port, '/nonexistent');
      expect(status).toBe(404);
    });
  });

  // =========================================================================
  // npm adapter — via daemon
  // =========================================================================

  describe('npm adapter via daemon', () => {
    let port: number;
    let server: Server;

    beforeAll(async () => {
      server = createAdapterServer(ctx, npmAdapter);
      await new Promise<void>((resolve) => { server.listen(0, () => { resolve(); }); });
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });

    it('should respond to health check', async () => {
      const { status, body } = await httpGet(port, '/health');
      expect(status).toBe(200);
      expect(JSON.parse(body).shim).toBe('npm');
    });

    it('should reject POST with 405', async () => {
      const { status } = await httpRequest(port, '/@did:jwk:test/pkg', 'POST');
      expect(status).toBe(405);
    });
  });

  // =========================================================================
  // Go adapter — via daemon
  // =========================================================================

  describe('Go adapter via daemon', () => {
    let port: number;
    let server: Server;

    beforeAll(async () => {
      server = createAdapterServer(ctx, goAdapter);
      await new Promise<void>((resolve) => { server.listen(0, () => { resolve(); }); });
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });

    it('should respond to health check', async () => {
      const { status, body } = await httpGet(port, '/health');
      expect(status).toBe(200);
      expect(JSON.parse(body).shim).toBe('go');
    });

    it('should reject POST with 405', async () => {
      const { status } = await httpRequest(port, '/test/@latest', 'POST');
      expect(status).toBe(405);
    });
  });

  // =========================================================================
  // OCI adapter — via daemon
  // =========================================================================

  describe('OCI adapter via daemon', () => {
    let port: number;
    let server: Server;

    beforeAll(async () => {
      server = createAdapterServer(ctx, ociAdapter);
      await new Promise<void>((resolve) => { server.listen(0, () => { resolve(); }); });
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });

    it('should respond to health check', async () => {
      const { status, body } = await httpGet(port, '/health');
      expect(status).toBe(200);
      expect(JSON.parse(body).shim).toBe('oci');
    });

    it('should serve OCI v2 API check', async () => {
      const { status, body } = await httpGet(port, '/v2/');
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({});
    });

    it('should reject POST with 405', async () => {
      const { status } = await httpRequest(port, '/v2/test/manifests/latest', 'POST');
      expect(status).toBe(405);
    });

    it('should support HEAD method (not 405)', async () => {
      // HEAD is a valid OCI method — should NOT return 405.
      const res = await fetch(`http://localhost:${port}/v2/did:jwk:test/img/manifests/latest`, { method: 'HEAD' });
      expect(res.status).not.toBe(405);
    });
  });

  // =========================================================================
  // Config edge cases
  // =========================================================================

  describe('config edge cases', () => {
    it('should handle config with unknown shim ids gracefully', () => {
      const config: DaemonConfig = {
        shims: {
          unknown_shim: { enabled: true, port: 9999 },
        },
      };
      // Unknown ids are ignored — only built-in adapters are resolved.
      const resolved = resolveConfig(config);
      expect(resolved.length).toBe(4);
      const unknown = resolved.find((r) => r.adapter.id === 'unknown_shim');
      expect(unknown).toBeUndefined();
    });

    it('should resolve config with partial shim entries', () => {
      const config: DaemonConfig = {
        shims: {
          github: { port: 1234 },
          // npm, go, oci not mentioned — should get defaults.
        },
      };
      const resolved = resolveConfig(config);
      const github = resolved.find((r) => r.adapter.id === 'github');
      const npm = resolved.find((r) => r.adapter.id === 'npm');
      expect(github?.port).toBe(1234);
      expect(github?.enabled).toBe(true);
      expect(npm?.port).toBe(4873);
      expect(npm?.enabled).toBe(true);
    });

    it('should handle port: 0 for OS-assigned ports', async () => {
      const config: DaemonConfig = {
        shims: {
          github : { port: 0 },
          npm    : { enabled: false },
          go     : { enabled: false },
          oci    : { enabled: false },
        },
      };

      const instance = await startDaemon({ ctx, config });
      try {
        const server = instance.servers.get('github')!;
        const port = (server.address() as AddressInfo).port;
        expect(port).toBeGreaterThan(0);

        const { status } = await httpGet(port, '/health');
        expect(status).toBe(200);
      } finally {
        await instance.stop();
      }
    });
  });
});
