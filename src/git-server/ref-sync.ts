/**
 * Git ref → DWN sync — mirrors git refs and checkpoints branch state.
 *
 * After a successful `git push`, this module reads the current refs from
 * the bare repository and creates or updates corresponding DWN records using
 * the ForgeRefsProtocol.
 *
 * Ref sync flow:
 * 1. Run `git for-each-ref` on the bare repo to enumerate current refs
 * 2. Query existing DWN ref records for the repo
 * 3. Create new records for refs that don't exist in DWN
 * 4. Update existing records whose target (SHA) has changed
 * 5. Delete DWN records for refs that no longer exist in git
 * 6. Ensure branch records exist and write `$squash` checkpoints for branch
 *    targets under `repo/branch/state`
 *
 * @module
 */

import type { TypedEnbox } from '@enbox/api';
import type { PushRefUpdate } from './push-updates.js';

import { spawn } from 'node:child_process';

import { branchDataForRef, reduceBranchState } from '../branch-state.js';
import type { ForgeRefsProtocol } from '../refs.js';
import type { BranchStateData, ForgeRefsSchemaMap } from '../refs.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A git ref as read from `git for-each-ref`. */
export type GitRef = {
  /** Full ref name, e.g. `refs/heads/main` or `refs/tags/v1.0.0`. */
  name: string;
  /** The commit SHA this ref points to. */
  target: string;
  /** Ref type discriminator. */
  type: 'branch' | 'tag';
};

/** Options for syncing refs. */
export type RefSyncOptions = {
  /** The typed ForgeRefsProtocol handle. */
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  /** The repo's contextId (from the ForgeRepoProtocol repo record). */
  repoContextId: string;
  /** Repo visibility controls whether ref and branch checkpoint records are published. */
  visibility?: 'public' | 'private';
};

/** Callback for post-push ref synchronization. */
export type OnPushComplete = (
  did: string,
  repo: string,
  repoPath: string,
  context?: {
    updates?: readonly PushRefUpdate[];
  },
) => Promise<void>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an `onPushComplete` callback that syncs git refs to DWN records.
 *
 * @param options - Ref sync configuration
 * @returns An async callback to invoke after a successful push
 */
export function createRefSyncer(options: RefSyncOptions): OnPushComplete {
  const { refs, repoContextId, visibility = 'public' } = options;
  const publish = visibility === 'public';

  return async (did: string, _repo: string, repoPath: string): Promise<void> => {
    // Read current git refs from the bare repository.
    // If git fails (corrupt repo, permission denied, etc.), abort the sync
    // to avoid deleting all DWN ref records due to an empty ref list.
    let gitRefs: GitRef[];
    try {
      gitRefs = await readGitRefs(repoPath);
    } catch (err) {
      console.error(`ref-sync: failed to read refs from ${repoPath}: ${(err as Error).message}`);
      return;
    }

    // Query existing DWN ref records scoped to this repo.
    const { records: existingRecords } = await refs.records.query('repo/ref' as any, {
      filter: { contextId: repoContextId },
    });

    // Build a map of existing DWN refs: name → { record, target }.
    const existingMap = new Map<string, { record: any; target: string }>();
    for (const record of existingRecords) {
      const data = await record.data.json();
      existingMap.set(data.name, { record, target: data.target });
    }

    // Build a set of current git ref names.
    const gitRefNames = new Set(gitRefs.map((r) => r.name));

    // Create or update refs.
    for (const ref of gitRefs) {
      const existing = existingMap.get(ref.name);

      if (!existing) {
        // Create a new DWN ref record.
        await refs.records.create('repo/ref', {
          data            : { name: ref.name, target: ref.target, type: ref.type },
          tags            : { name: ref.name, type: ref.type, target: ref.target },
          parentContextId : repoContextId,
          published       : publish,
        });
      } else if (existing.target !== ref.target) {
        // Update existing record with new target.
        await existing.record.update({
          data : { name: ref.name, target: ref.target, type: ref.type },
          tags : { name: ref.name, type: ref.type, target: ref.target },
        });
      }
      // If target matches, no action needed.
    }

    // Delete DWN records for refs that no longer exist in git.
    for (const [name, { record }] of existingMap) {
      if (!gitRefNames.has(name)) {
        await record.delete();
      }
    }

    await syncBranchCheckpoints(refs, repoContextId, did, gitRefs, publish);
  };
}

// ---------------------------------------------------------------------------
// Branch state sync
// ---------------------------------------------------------------------------

/** Ensure branch records and checkpoint state exist for current git branches. */
async function syncBranchCheckpoints(
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>,
  repoContextId: string,
  ownerDid: string,
  gitRefs: GitRef[],
  publish: boolean,
): Promise<void> {
  const branchRefs = gitRefs.filter((ref) => ref.type === 'branch');
  const branchRefNames = new Set(branchRefs.map((ref) => ref.name));
  const { records: existingBranchRecords } = await refs.records.query('repo/branch' as any, {
    filter: { contextId: repoContextId },
  });

  const branchRecords = new Map<string, any>();
  for (const record of existingBranchRecords) {
    const data = await record.data.json();
    if (typeof data.refName === 'string') {
      branchRecords.set(data.refName, record);
    }
  }

  for (const ref of branchRefs) {
    const branchRecord = await ensureBranchRecord(refs, repoContextId, ownerDid, ref.name, branchRecords, publish);
    await writeCheckpointIfChanged(refs, branchRecord, ownerDid, ref.name, ref.target, publish);
  }

  for (const [refName, branchRecord] of branchRecords) {
    if (!branchRefNames.has(refName)) {
      await writeCheckpointIfChanged(refs, branchRecord, ownerDid, refName, null, publish);
    }
  }
}

async function ensureBranchRecord(
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>,
  repoContextId: string,
  ownerDid: string,
  refName: string,
  branchRecords: Map<string, any>,
  publish: boolean,
): Promise<any> {
  const existing = branchRecords.get(refName);
  if (existing) {
    return existing;
  }

  const data = branchDataForRef(refName, ownerDid);
  const { record } = await refs.records.create('repo/branch' as any, {
    data,
    tags: {
      refName  : data.refName,
      ownerDid : data.ownerDid,
      kind     : data.kind,
    },
    parentContextId: repoContextId,
    published      : publish,
  });

  branchRecords.set(refName, record);
  return record;
}

async function writeCheckpointIfChanged(
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>,
  branchRecord: any,
  actorDid: string,
  refName: string,
  target: string | null,
  publish: boolean,
): Promise<void> {
  const branchContextId = branchRecord.contextId;
  if (!branchContextId) {
    console.error(`ref-sync: branch record for ${refName} has no contextId; skipping branch state checkpoint`);
    return;
  }

  const { records } = await refs.records.query('repo/branch/state' as any, {
    filter: { contextId: branchContextId },
  });
  const stateRecords = await Promise.all(records.map(async (record: any) => ({
    recordId    : record.id ?? '',
    authorDid   : record.author ?? record.authorDid,
    dateCreated : record.dateCreated,
    data        : await record.data.json() as BranchStateData,
  })));
  const reduction = reduceBranchState(refName, stateRecords);
  if (reduction.target === target && reduction.accepted.length > 0) {
    return;
  }

  const now = new Date().toISOString();
  const data: BranchStateData = {
    kind       : 'checkpoint',
    refName,
    target,
    actorDid,
    acceptedAt : now,
    createdAt  : now,
  };
  const tags: Record<string, string> = {
    kind: 'checkpoint',
    refName,
    actorDid,
  };
  if (target) {
    tags.target = target;
  }

  await refs.records.create('repo/branch/state' as any, {
    data,
    tags,
    parentContextId : branchContextId,
    published       : publish,
    squash          : true,
  });
}

// ---------------------------------------------------------------------------
// Git ref reader
// ---------------------------------------------------------------------------

/**
 * Read all refs from a bare git repository using `git for-each-ref`.
 *
 * @param repoPath - Path to the bare git repository
 * @returns Array of GitRef objects
 */
export async function readGitRefs(repoPath: string): Promise<GitRef[]> {
  const output = await spawnCollectStdout('git', [
    'for-each-ref',
    '--format=%(refname)\t%(objectname)',
    'refs/heads/',
    'refs/tags/',
  ], repoPath);

  const refs: GitRef[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) { continue; }
    const [name, target] = line.split('\t');
    if (!name || !target) { continue; }

    const type: 'branch' | 'tag' = name.startsWith('refs/tags/') ? 'tag' : 'branch';
    refs.push({ name, target, type });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn a process, collect stdout, and return it as a string. */
function spawnCollectStdout(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}: ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });
  });
}
