/**
 * DWN-based push authorization — checks collaborator roles in the DWN.
 *
 * When a DID attempts to push to a repository, this module queries the
 * DWN for `repo/maintainer` and `repo/contributor` role records to
 * determine if the pusher is authorized.
 *
 * Authorization rules:
 * - The repo owner (DID that owns the DWN) can always push
 * - DIDs with a `maintainer` role record can push
 * - DIDs with a `contributor` role record can push only their own
 *   contributor branch namespace
 * - All other DIDs are rejected
 *
 * @module
 */

import type { TypedEnbox } from '@enbox/api';

import type { ForgeRepoProtocol } from '../repo.js';
import type { ForgeRepoSchemaMap } from '../repo.js';
import type { PushRefUpdate } from './push-updates.js';

import { isContributorBranchRef } from '../branch-state.js';
import type { PushAuthorizer } from './auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a DWN-based push authorizer. */
export type DwnPushAuthorizerOptions = {
  /** The typed ForgeRepoProtocol handle. */
  repo: TypedEnbox<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;
  /** The DID of the DWN owner (server operator). */
  ownerDid: string;
  /** Optional remote DWN DID to query for repo and role records. */
  from?: string;
  /** Optional known repo context. If omitted, resolved from the pushed repo name. */
  repoContextId?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a `PushAuthorizer` that checks DWN collaborator role records.
 *
 * The authorizer queries the ForgeRepoProtocol for `maintainer` and
 * `contributor` role records matching the pusher's DID. The repo owner
 * is always authorized.
 *
 * @param options - Authorizer configuration
 * @returns A PushAuthorizer callback
 */
export function createDwnPushAuthorizer(options: DwnPushAuthorizerOptions): PushAuthorizer {
  const { repo, ownerDid, from, repoContextId } = options;

  return async (
    did: string,
    owner: string,
    repoName: string,
    updates?: readonly PushRefUpdate[],
  ): Promise<boolean> => {
    // The owner can always push to their own repos.
    if (did === owner || did === ownerDid) {
      return true;
    }

    const contextId = repoContextId ?? await findRepoContextId(repo, repoName, from);
    if (!contextId) {
      return false;
    }

    if (await isBlocked(repo, contextId, did, from)) {
      return false;
    }

    // Query for maintainer role records for this DID.
    const { records: maintainers } = await repo.records.query('repo/maintainer' as any, {
      ...(from ? { from } : {}),
      filter: { contextId, tags: { did } },
    });
    if (maintainers.length > 0) {
      return true;
    }

    // Query for contributor role records for this DID.
    const { records: contributors } = await repo.records.query('repo/contributor' as any, {
      ...(from ? { from } : {}),
      filter: { contextId, tags: { did } },
    });
    if (contributors.length > 0) {
      return contributorCanPushUpdates(did, updates);
    }

    return false;
  };
}

function contributorCanPushUpdates(
  did: string,
  updates?: readonly PushRefUpdate[],
): boolean {
  // GET /info/refs does not include update commands.  Allow advertisement for
  // contributors; the POST receive-pack command list is checked below.
  if (!updates) { return true; }

  return updates.every((update) =>
    update.refName.startsWith('refs/heads/')
    && isContributorBranchRef(update.refName, did),
  );
}

async function findRepoContextId(
  repo: TypedEnbox<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>,
  repoName: string,
  from?: string,
): Promise<string | undefined> {
  const { records } = await repo.records.query('repo', {
    ...(from ? { from } : {}),
    filter: { tags: { name: repoName } },
  });
  return records[0]?.contextId;
}

async function isBlocked(
  repo: TypedEnbox<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>,
  contextId: string,
  did: string,
  from?: string,
): Promise<boolean> {
  const { records } = await repo.records.query('repo/moderationEvent' as any, {
    ...(from ? { from } : {}),
    filter: { contextId, tags: { targetDid: did } },
  });
  if (records.length === 0) {
    return false;
  }

  const events = await Promise.all(records.map(async (record: any) => {
    const data = await record.data.json().catch(() => ({}));
    return {
      action    : (record.tags?.action ?? data.action) as string | undefined,
      createdAt : data.createdAt ?? record.dateCreated ?? '',
      id        : record.id ?? '',
    };
  }));

  events.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    if (byTime !== 0) { return byTime; }
    return b.id.localeCompare(a.id);
  });

  return events[0]?.action === 'block';
}
