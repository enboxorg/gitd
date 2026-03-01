/**
 * Tests for the DWN-based push authorizer.
 *
 * Tests the `createDwnPushAuthorizer()` function using a real Enbox agent
 * with ForgeRepoProtocol installed, verifying role-based push authorization.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';

import { Enbox } from '@enbox/api';
import { EnboxUserAgent } from '@enbox/agent';

import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { ForgeRepoProtocol } from '../src/repo.js';

const DATA_PATH = '__TESTDATA__/push-auth';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDwnPushAuthorizer', () => {
  let enbox: Enbox;
  let did: string;
  let repo: ReturnType<Enbox['using']>;
  let repoContextId: string;

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
        metadata  : { name: 'Push Auth Test' },
      });
    }

    enbox = Enbox.connect({ agent, connectedDid: identity.did.uri });
    did = identity.did.uri;

    repo = enbox.using(ForgeRepoProtocol);
    await repo.configure();

    // Create a repo record to get a contextId.
    const { record } = await repo.records.create('repo', {
      data : { name: 'test-repo', description: '', defaultBranch: 'main', dwnEndpoints: [] },
      tags : { name: 'test-repo', visibility: 'public' },
    });
    repoContextId = record.contextId!;
  });

  afterAll(() => {
    rmSync(DATA_PATH, { recursive: true, force: true });
  });

  it('should allow the owner DID to push', async () => {
    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });
    const result = await authorizer(did, did, 'test-repo');
    expect(result).toBe(true);
  });

  it('should allow the ownerDid even when pushing to a different DID repo', async () => {
    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });
    // The server operator's DID matches ownerDid, even though the token targets a different owner.
    const result = await authorizer(did, 'did:dht:other', 'test-repo');
    expect(result).toBe(true);
  });

  it('should reject an unknown DID with no roles', async () => {
    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });
    const result = await authorizer('did:jwk:stranger', did, 'test-repo');
    expect(result).toBe(false);
  });

  it('should allow a DID with a maintainer role', async () => {
    const maintainerDid = 'did:jwk:maintainer1';

    // Add a maintainer role record.
    await repo.records.create('repo/maintainer' as any, {
      data            : { did: maintainerDid, alias: 'Maintainer' },
      tags            : { did: maintainerDid },
      parentContextId : repoContextId,
      recipient       : maintainerDid,
    });

    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });
    const result = await authorizer(maintainerDid, did, 'test-repo');
    expect(result).toBe(true);
  });

  it('should allow a DID with a contributor role', async () => {
    const contributorDid = 'did:jwk:contributor1';

    // Add a contributor role record.
    await repo.records.create('repo/contributor' as any, {
      data            : { did: contributorDid, alias: 'Contributor' },
      tags            : { did: contributorDid },
      parentContextId : repoContextId,
      recipient       : contributorDid,
    });

    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });
    const result = await authorizer(contributorDid, did, 'test-repo');
    expect(result).toBe(true);
  });

  it('should reject a DID after its role is revoked', async () => {
    const tempDid = 'did:jwk:temporary1';

    // Add a maintainer role.
    const { record } = await repo.records.create('repo/maintainer' as any, {
      data            : { did: tempDid, alias: 'Temporary' },
      tags            : { did: tempDid },
      parentContextId : repoContextId,
      recipient       : tempDid,
    });

    const authorizer = createDwnPushAuthorizer({ repo: repo as any, ownerDid: did });

    // Initially authorized.
    let result = await authorizer(tempDid, did, 'test-repo');
    expect(result).toBe(true);

    // Revoke the role.
    await record.delete();

    // Should now be rejected.
    result = await authorizer(tempDid, did, 'test-repo');
    expect(result).toBe(false);
  });
});
