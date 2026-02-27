/**
 * Tests that all public sub-path exports are accessible.
 *
 * These tests import from the barrel `index.ts` files (not individual
 * source modules) to verify that `@enbox/gitd/git-server` and
 * `@enbox/gitd/git-remote` expose the expected public API.
 */
import { describe, expect, it } from 'bun:test';

// ---------------------------------------------------------------------------
// git-server
// ---------------------------------------------------------------------------

describe('@enbox/gitd/git-server exports', () => {
  it('should export auth utilities', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(mod.DID_AUTH_USERNAME).toBe('did-auth');
    expect(typeof mod.createPushTokenPayload).toBe('function');
    expect(typeof mod.encodePushToken).toBe('function');
    expect(typeof mod.decodePushToken).toBe('function');
    expect(typeof mod.formatAuthPassword).toBe('function');
    expect(typeof mod.parseAuthPassword).toBe('function');
    expect(typeof mod.createPushAuthenticator).toBe('function');
  });

  it('should export git backend', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.GitBackend).toBe('function');
  });

  it('should export HTTP handler and server', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.createGitHttpHandler).toBe('function');
    expect(typeof mod.createGitServer).toBe('function');
  });

  it('should export ref sync utilities', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.createRefSyncer).toBe('function');
    expect(typeof mod.readGitRefs).toBe('function');
  });

  it('should export bundle sync utilities', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.createBundleSyncer).toBe('function');
    expect(typeof mod.createFullBundle).toBe('function');
    expect(typeof mod.createIncrementalBundle).toBe('function');
    expect(typeof mod.restoreFromBundles).toBe('function');
  });

  it('should export DID service utilities', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.registerGitService).toBe('function');
    expect(typeof mod.getDwnEndpoints).toBe('function');
    expect(typeof mod.startDidRepublisher).toBe('function');
  });

  it('should export push authorizer and signature verifier', async () => {
    const mod = await import('../src/git-server/index.js');
    expect(typeof mod.createDwnPushAuthorizer).toBe('function');
    expect(typeof mod.createDidSignatureVerifier).toBe('function');
  });

  it('should export exactly the expected number of symbols', async () => {
    const mod = await import('../src/git-server/index.js');
    const exported = Object.keys(mod);
    // 19 functions + 1 constant + 1 class = 21 runtime exports
    // (types are erased at runtime)
    expect(exported.length).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// git-remote
// ---------------------------------------------------------------------------

describe('@enbox/gitd/git-remote exports', () => {
  it('should export credential helper utilities', async () => {
    const mod = await import('../src/git-remote/index.js');
    expect(typeof mod.generatePushCredentials).toBe('function');
    expect(typeof mod.parseCredentialRequest).toBe('function');
    expect(typeof mod.formatCredentialResponse).toBe('function');
  });

  it('should export credential cache utilities', async () => {
    const mod = await import('../src/git-remote/index.js');
    expect(typeof mod.cacheKey).toBe('function');
    expect(typeof mod.getCachedCredential).toBe('function');
    expect(typeof mod.storeCachedCredential).toBe('function');
    expect(typeof mod.eraseCachedCredential).toBe('function');
  });

  it('should export DID URL parser', async () => {
    const mod = await import('../src/git-remote/index.js');
    expect(typeof mod.parseDidUrl).toBe('function');
  });

  it('should export endpoint resolution', async () => {
    const mod = await import('../src/git-remote/index.js');
    expect(typeof mod.resolveGitEndpoint).toBe('function');
    expect(typeof mod.assertNotPrivateUrl).toBe('function');
  });

  it('should export git transport service utilities', async () => {
    const mod = await import('../src/git-remote/index.js');
    expect(mod.GIT_TRANSPORT_SERVICE_TYPE).toBe('GitTransport');
    expect(typeof mod.createGitTransportService).toBe('function');
    expect(typeof mod.isGitTransportService).toBe('function');
    expect(typeof mod.getGitTransportServices).toBe('function');
  });

  it('should export exactly the expected number of symbols', async () => {
    const mod = await import('../src/git-remote/index.js');
    const exported = Object.keys(mod);
    // 12 functions + 2 constants = 14 runtime exports
    // (types are erased at runtime)
    expect(exported.length).toBe(14);
  });

  it('should NOT export CLI entry points', async () => {
    const mod = await import('../src/git-remote/index.js') as Record<string, unknown>;
    // The main.ts and credential-main.ts entry points should not be
    // re-exported through the barrel.
    expect(mod.main).toBeUndefined();
    expect(mod.connectForCredentials).toBeUndefined();
  });
});
