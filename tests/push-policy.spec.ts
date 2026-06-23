import { describe, expect, it } from 'bun:test';

import { branchOwnerHash } from '../src/branch-state.js';
import { createDwnPushAuthorizer } from '../src/git-server/push-authorizer.js';
import { parseReceivePackUpdates } from '../src/git-server/push-updates.js';

const OWNER_DID = 'did:dht:owner';
const MAINTAINER_DID = 'did:dht:maintainer';
const CONTRIBUTOR_DID = 'did:dht:contributor';
const OTHER_DID = 'did:dht:other';
const REPO_NAME = 'demo';
const CONTEXT_ID = 'ctx-demo';

const ZERO = '0'.repeat(40);
const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);

describe('parseReceivePackUpdates', () => {
  it('parses a create command with capabilities', () => {
    const body = pkt(`${ZERO} ${NEW} refs/heads/main\0report-status side-band-64k\n`) + '0000PACK';
    expect(parseReceivePackUpdates(body)).toEqual([
      { oldTarget: null, newTarget: NEW, refName: 'refs/heads/main' },
    ]);
  });

  it('parses multiple update commands before the flush packet', () => {
    const body = pkt(`${OLD} ${NEW} refs/heads/main\n`)
      + pkt(`${NEW} ${ZERO} refs/heads/topic\n`)
      + '0000PACK';

    expect(parseReceivePackUpdates(body)).toEqual([
      { oldTarget: OLD, newTarget: NEW, refName: 'refs/heads/main' },
      { oldTarget: NEW, newTarget: null, refName: 'refs/heads/topic' },
    ]);
  });

  it('returns no updates for a flush-only receive-pack request', () => {
    expect(parseReceivePackUpdates('0000')).toEqual([]);
  });
});

describe('createDwnPushAuthorizer branch policy', () => {
  it('allows owners to update protected branches', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo(),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(OWNER_DID, OWNER_DID, REPO_NAME, [
      update('refs/heads/main'),
    ])).resolves.toBe(true);
  });

  it('allows maintainers to update protected branches and tags', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({ maintainers: [MAINTAINER_DID] }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(MAINTAINER_DID, OWNER_DID, REPO_NAME, [
      update('refs/heads/main'),
      update('refs/tags/v1.0.0'),
    ])).resolves.toBe(true);
  });

  it('allows contributors to advertise push refs before commands are known', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({ contributors: [CONTRIBUTOR_DID] }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME)).resolves.toBe(true);
  });

  it('allows contributors to update their own contributor branch namespace', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({ contributors: [CONTRIBUTOR_DID] }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update(`refs/heads/users/${branchOwnerHash(CONTRIBUTOR_DID)}/feature`),
    ])).resolves.toBe(true);
  });

  it('queries remote owner DWN role records when from is provided', async () => {
    const queries: Array<{ path: string; from?: string }> = [];
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({ contributors: [CONTRIBUTOR_DID], queries }),
      ownerDid : OWNER_DID,
      from     : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update(`refs/heads/users/${branchOwnerHash(CONTRIBUTOR_DID)}/feature`),
    ])).resolves.toBe(true);

    expect(queries).toEqual([
      { path: 'repo', from: OWNER_DID },
      { path: 'repo/moderationEvent', from: OWNER_DID },
      { path: 'repo/maintainer', from: OWNER_DID },
      { path: 'repo/contributor', from: OWNER_DID },
    ]);
  });

  it('rejects blocked contributors even when their role record remains', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({
        contributors: [CONTRIBUTOR_DID],
        moderationEvents: [
          moderationEvent('block', CONTRIBUTOR_DID, '2026-06-23T00:00:00.000Z'),
        ],
      }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update(`refs/heads/users/${branchOwnerHash(CONTRIBUTOR_DID)}/feature`),
    ])).resolves.toBe(false);
  });

  it('allows a contributor again after a later unblock event', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({
        contributors: [CONTRIBUTOR_DID],
        moderationEvents: [
          moderationEvent('block', CONTRIBUTOR_DID, '2026-06-23T00:00:00.000Z'),
          moderationEvent('unblock', CONTRIBUTOR_DID, '2026-06-23T00:01:00.000Z'),
        ],
      }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update(`refs/heads/users/${branchOwnerHash(CONTRIBUTOR_DID)}/feature`),
    ])).resolves.toBe(true);
  });

  it('rejects contributors updating protected branches, tags, or another contributor namespace', async () => {
    const authorize = createDwnPushAuthorizer({
      repo     : mockRepo({ contributors: [CONTRIBUTOR_DID] }),
      ownerDid : OWNER_DID,
    });

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update('refs/heads/main'),
    ])).resolves.toBe(false);

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update('refs/tags/v1.0.0'),
    ])).resolves.toBe(false);

    await expect(authorize(CONTRIBUTOR_DID, OWNER_DID, REPO_NAME, [
      update(`refs/heads/users/${branchOwnerHash(OTHER_DID)}/feature`),
    ])).resolves.toBe(false);
  });
});

function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, '0') + payload;
}

function update(refName: string) {
  return { oldTarget: OLD, newTarget: NEW, refName };
}

function moderationEvent(action: 'block' | 'unblock', targetDid: string, createdAt: string) {
  return {
    id: `${action}-${targetDid}-${createdAt}`,
    dateCreated: createdAt,
    tags: { action, targetDid },
    data: {
      json: async () => ({ action, targetDid, createdAt }),
    },
  };
}

function mockRepo(options: {
  maintainers?: string[];
  contributors?: string[];
  moderationEvents?: any[];
  queries?: Array<{ path: string; from?: string }>;
} = {}) {
  return {
    records: {
      query: async (path: string, query: any = {}) => {
        options.queries?.push({ path, from: query.from });
        if (path === 'repo') {
          return {
            records: [{ contextId: CONTEXT_ID }],
          };
        }

        if (path === 'repo/moderationEvent') {
          const did = query.filter?.tags?.targetDid;
          return {
            records: (options.moderationEvents ?? []).filter((event) => event.tags?.targetDid === did),
          };
        }

        if (path === 'repo/maintainer') {
          const did = query.filter?.tags?.did;
          return {
            records: options.maintainers?.includes(did) ? [{ contextId: CONTEXT_ID }] : [],
          };
        }

        if (path === 'repo/contributor') {
          const did = query.filter?.tags?.did;
          return {
            records: options.contributors?.includes(did) ? [{ contextId: CONTEXT_ID }] : [],
          };
        }

        return { records: [] };
      },
    },
  } as any;
}
