/**
 * Remote-owner branch writeback for local helper pushes.
 *
 * When a contributor pushes to a DID remote that resolves to their local
 * helper, the helper updates its local bare cache via git receive-pack, then
 * writes contributor-authored branch state and bundle records to the repo
 * owner's DWN.  This keeps the remote DWN as the source of truth without a
 * hosted git server holding project keys.
 *
 * @module
 */

import type { ForgeRefsProtocol } from '../refs.js';
import type { PushRefUpdate } from './push-updates.js';
import type { TypedEnbox } from '@enbox/api';
import type { BranchStateData, ForgeRefsSchemaMap } from '../refs.js';

import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';

import { createBranchBundle } from './bundle-sync.js';
import { branchDataForRef, isContributorBranchRef } from '../branch-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function used to deliver a locally-created record to the repo owner's DWN. */
export type RemoteRecordSender = (record: any, targetDid: string) => Promise<void>;

/** Function used to look up existing branch records in the repo owner's DWN. */
export type RemoteBranchLookup = (refName: string) => Promise<any[]>;

export type RemoteBranchPushSyncOptions = {
  /** The contributor's typed refs handle. */
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;

  /** Alice's repo context ID, read from Alice's DWN. */
  repoContextId: string;

  /** Repo owner DID whose DWN receives the branch records. */
  targetDid: string;

  /** DID authoring the contributor branch records. */
  actorDid: string;

  /** Local bare repo cache updated by receive-pack. */
  repoPath: string;

  /** Git receive-pack ref updates from the accepted push. */
  updates: readonly PushRefUpdate[];

  /** Optional test hook. Defaults to `record.send(targetDid)`. */
  sendRecord?: RemoteRecordSender;

  /** Optional test hook. Defaults to querying `refs` with `from: targetDid`. */
  lookupBranches?: RemoteBranchLookup;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write contributor branch state and bundle records to the repo owner's DWN. */
export async function syncRemoteBranchPush(options: RemoteBranchPushSyncOptions): Promise<void> {
  const {
    refs,
    repoContextId,
    targetDid,
    actorDid,
    repoPath,
    updates,
    sendRecord = sendRecordToDwn,
    lookupBranches,
  } = options;

  for (const update of updates) {
    if (!isContributorBranchRef(update.refName, actorDid)) {
      throw new Error(`Ref ${update.refName} is not in contributor namespace for ${actorDid}`);
    }

    const branchRecord = await ensureRemoteBranchRecord({
      refs,
      repoContextId,
      targetDid,
      actorDid,
      refName: update.refName,
      sendRecord,
      lookupBranches,
    });

    const bundleRecordId = update.newTarget
      ? await writeRemoteBranchBundle({
        refs,
        branchRecord,
        targetDid,
        repoPath,
        update,
        sendRecord,
      })
      : undefined;

    const stateRecordId = await writeRemoteBranchRefUpdate({
      refs,
      branchRecord,
      targetDid,
      actorDid,
      update,
      bundleRecordId,
      sendRecord,
    });

    await writeRemoteBranchCheckpoint({
      refs,
      branchRecord,
      targetDid,
      actorDid,
      update,
      acceptedStateRecordId: stateRecordId,
      sendRecord,
    });
  }
}

// ---------------------------------------------------------------------------
// Branch records
// ---------------------------------------------------------------------------

async function ensureRemoteBranchRecord(options: {
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  repoContextId: string;
  targetDid: string;
  actorDid: string;
  refName: string;
  sendRecord: RemoteRecordSender;
  lookupBranches?: RemoteBranchLookup;
}): Promise<any> {
  const { refs, repoContextId, targetDid, actorDid, refName, sendRecord, lookupBranches } = options;

  const records = lookupBranches
    ? await lookupBranches(refName)
    : (await refs.records.query('repo/branch' as any, {
      from   : targetDid,
      filter : { contextId: repoContextId, tags: { refName } },
    })).records;

  if (records.length > 0) {
    const data = await records[0].data.json();
    if (data.ownerDid !== actorDid || data.kind !== 'contributor') {
      throw new Error(`Remote branch ${refName} is not owned by ${actorDid}`);
    }
    return records[0];
  }

  const data = branchDataForRef(refName, actorDid);
  if (data.kind !== 'contributor') {
    throw new Error(`Ref ${refName} does not map to a contributor branch for ${actorDid}`);
  }

  const { record } = await refs.records.create('repo/branch' as any, {
    data,
    tags: {
      refName  : data.refName,
      ownerDid : data.ownerDid,
      kind     : data.kind,
    },
    parentContextId : repoContextId,
    protocolRole    : 'repo:repo/contributor',
    recipient       : targetDid,
    published       : true,
    store           : false,
  });
  if (!record) {
    throw new Error(`Failed to create contributor branch record for ${refName}`);
  }

  await sendRecord(record, targetDid);
  return record;
}

// ---------------------------------------------------------------------------
// State and bundle records
// ---------------------------------------------------------------------------

async function writeRemoteBranchBundle(options: {
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  branchRecord: any;
  targetDid: string;
  repoPath: string;
  update: PushRefUpdate;
  sendRecord: RemoteRecordSender;
}): Promise<string> {
  const { refs, branchRecord, targetDid, repoPath, update, sendRecord } = options;
  const bundleInfo = await createBranchBundle(repoPath, update.refName);

  try {
    const bundleData = new Uint8Array(await readFile(bundleInfo.path));
    const { record } = await refs.records.create('repo/branch/bundle' as any, {
      data       : bundleData,
      dataFormat : 'application/x-git-bundle',
      tags       : {
        kind      : 'checkpoint',
        refName   : update.refName,
        tipCommit : bundleInfo.tipCommit,
        size      : bundleInfo.size,
      },
      parentContextId : branchRecord.contextId,
      recipient       : targetDid,
      published       : true,
      squash          : true,
      store           : false,
    });
    if (!record) {
      throw new Error(`Failed to create branch bundle record for ${update.refName}`);
    }

    await sendRecord(record, targetDid);
    return record.id;
  } finally {
    await unlink(bundleInfo.path).catch(() => {});
  }
}

async function writeRemoteBranchRefUpdate(options: {
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  branchRecord: any;
  targetDid: string;
  actorDid: string;
  update: PushRefUpdate;
  bundleRecordId?: string;
  sendRecord: RemoteRecordSender;
}): Promise<string> {
  const { refs, branchRecord, targetDid, actorDid, update, bundleRecordId, sendRecord } = options;
  const now = new Date().toISOString();
  const data: BranchStateData = {
    kind      : 'refUpdate',
    refName   : update.refName,
    oldTarget : update.oldTarget,
    newTarget : update.newTarget,
    actorDid,
    createdAt : now,
    nonce     : randomUUID(),
    ...(bundleRecordId ? { bundleRecordId } : {}),
  };

  const tags: Record<string, string> = {
    kind    : 'refUpdate',
    refName : update.refName,
    actorDid,
  };
  if (update.oldTarget) { tags.oldTarget = update.oldTarget; }
  if (update.newTarget) { tags.newTarget = update.newTarget; }
  if (bundleRecordId) { tags.bundleRecordId = bundleRecordId; }

  const { record } = await refs.records.create('repo/branch/state' as any, {
    data,
    tags,
    parentContextId : branchRecord.contextId,
    recipient       : targetDid,
    published       : true,
    store           : false,
  });
  if (!record) {
    throw new Error(`Failed to create branch state record for ${update.refName}`);
  }

  await sendRecord(record, targetDid);
  return record.id;
}

async function writeRemoteBranchCheckpoint(options: {
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  branchRecord: any;
  targetDid: string;
  actorDid: string;
  update: PushRefUpdate;
  acceptedStateRecordId: string;
  sendRecord: RemoteRecordSender;
}): Promise<void> {
  const { refs, branchRecord, targetDid, actorDid, update, acceptedStateRecordId, sendRecord } = options;
  const now = new Date().toISOString();
  const data: BranchStateData = {
    kind       : 'checkpoint',
    refName    : update.refName,
    target     : update.newTarget,
    actorDid,
    acceptedStateRecordId,
    acceptedAt : now,
    createdAt  : now,
  };
  const tags: Record<string, string> = {
    kind    : 'checkpoint',
    refName : update.refName,
    actorDid,
    acceptedStateRecordId,
  };
  if (update.newTarget) {
    tags.target = update.newTarget;
  }

  const { record } = await refs.records.create('repo/branch/state' as any, {
    data,
    tags,
    parentContextId : branchRecord.contextId,
    recipient       : targetDid,
    published       : true,
    squash          : true,
    store           : false,
  });
  if (!record) {
    throw new Error(`Failed to create branch checkpoint record for ${update.refName}`);
  }

  await sendRecord(record, targetDid);
}

async function sendRecordToDwn(record: any, targetDid: string): Promise<void> {
  const status = await record.send(targetDid);
  if (status.code >= 300) {
    throw new Error(`remote branch write failed: ${status.code} ${status.detail ?? ''}`.trim());
  }
}
