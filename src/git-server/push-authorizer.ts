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
 * - DIDs with a `contributor` role record can push
 * - All other DIDs are rejected
 *
 * @module
 */

import type { TypedEnbox } from '@enbox/api';

import type { ForgeRepoProtocol } from '../repo.js';
import type { ForgeRepoSchemaMap } from '../repo.js';

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
  const { repo, ownerDid } = options;

  return async (did: string, owner: string, _repoName: string): Promise<boolean> => {
    // The owner can always push to their own repos.
    if (did === owner || did === ownerDid) {
      return true;
    }

    // Query for maintainer role records for this DID.
    const { records: maintainers } = await repo.records.query('repo/maintainer' as any, {
      filter: { tags: { did } },
    });
    if (maintainers.length > 0) {
      return true;
    }

    // Query for contributor role records for this DID.
    const { records: contributors } = await repo.records.query('repo/contributor' as any, {
      filter: { tags: { did } },
    });
    if (contributors.length > 0) {
      return true;
    }

    return false;
  };
}
