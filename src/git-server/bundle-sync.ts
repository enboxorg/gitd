/**
 * Git bundle → DWN sync — creates/updates a git bundle as a DWN record.
 *
 * After a successful `git push`, this module generates a `git bundle` from
 * the bare repository and writes it as a ForgeRepo `bundle` record.
 * Incremental bundles are created when a previous bundle exists; periodic
 * squash writes compact all incrementals into a single full bundle.
 *
 * Bundle sync flow:
 * 1. Query existing bundle records for the repo (sorted by timestamp desc)
 * 2. If no bundles exist → create full bundle (`git bundle create --all`)
 * 3. If bundles exist → create incremental bundle since last tip commit
 * 4. Every N pushes (configurable), create a squash bundle (full bundle
 *    with `squash: true`) which purges all older bundle records
 *
 * The bundle data (binary `application/x-git-bundle`) is stored as the
 * record payload. Queryable metadata is stored in tags.
 *
 * @module
 */

import type { ForgeRefsProtocol } from '../refs.js';
import type { ForgeRefsSchemaMap } from '../refs.js';
import type { ForgeRepoProtocol } from '../repo.js';
import type { ForgeRepoSchemaMap } from '../repo.js';
import type { TypedEnbox } from '@enbox/api';
import type { GitRef, OnPushComplete } from './ref-sync.js';

import { DateSort } from '@enbox/dwn-sdk-js';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFile, stat, unlink } from 'node:fs/promises';

import { branchDataForRef } from '../branch-state.js';
import { readGitRefs } from './ref-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a bundle syncer. */
export type BundleSyncOptions = {
  /** The typed ForgeRepoProtocol handle. */
  repo: TypedEnbox<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;

  /** The repo's contextId (from the ForgeRepoProtocol repo record). */
  repoContextId: string;

  /** Optional ForgeRefsProtocol handle used to write branch-scoped bundles. */
  refs?: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;

  /**
   * Repo visibility — controls whether bundle records are encrypted.
   *
   * - `'private'` → bundles are JWE-encrypted (only key-holders can read)
   * - `'public'`  → bundles are plaintext (IPFS-friendly, globally readable)
   *
   * The protocol must be installed with `encryption: true` for private repos
   * to work (this injects `$encryption` keys on all protocol paths).
   *
   * @default 'public'
   */
  visibility?: 'public' | 'private';

  /**
   * Number of incremental bundles to accumulate before squashing.
   * When this threshold is reached, the next bundle write is a squash
   * that replaces all older bundles with a single full bundle.
   *
   * @default 5
   */
  squashThreshold?: number;
};

/** Metadata about a generated git bundle. */
export type BundleInfo = {
  /** Path to the bundle file on disk. */
  path: string;
  /** SHA of the tip commit (HEAD of default branch). */
  tipCommit: string;
  /** Whether this is a full bundle (all refs) or incremental. */
  isFull: boolean;
  /** Number of refs included in the bundle. */
  refCount: number;
  /** File size in bytes. */
  size: number;
};

/** Metadata about a generated branch-scoped bundle. */
export type BranchBundleInfo = {
  /** Path to the bundle file on disk. */
  path: string;
  /** Full branch ref name included in the bundle. */
  refName: string;
  /** Commit SHA at the branch tip. */
  tipCommit: string;
  /** File size in bytes. */
  size: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an `onPushComplete` callback that syncs a git bundle to a DWN record.
 *
 * @param options - Bundle sync configuration
 * @returns An async callback to invoke after a successful push
 */
export function createBundleSyncer(options: BundleSyncOptions): OnPushComplete {
  const { repo, repoContextId, refs, visibility = 'public', squashThreshold = 5 } = options;
  const encrypt = visibility === 'private';

  return async (did: string, _repoName: string, repoPath: string): Promise<void> => {
    // Query existing bundle records scoped to this repo, newest first.
    const { records: existingBundles } = await repo.records.query('repo/bundle', {
      filter   : { contextId: repoContextId, tags: { isFull: true } },
      dateSort : DateSort.CreatedDescending,
    });

    // Also query incremental bundles scoped to this repo.
    const { records: incrementalBundles } = await repo.records.query('repo/bundle', {
      filter   : { contextId: repoContextId, tags: { isFull: false } },
      dateSort : DateSort.CreatedDescending,
    });

    const totalBundles = existingBundles.length + incrementalBundles.length;

    // Determine the last tip commit from the most recent bundle (full or incremental).
    let lastTipCommit: string | undefined;
    if (incrementalBundles.length > 0 && incrementalBundles[0].tags) {
      lastTipCommit = incrementalBundles[0].tags.tipCommit as string;
    } else if (existingBundles.length > 0 && existingBundles[0].tags) {
      lastTipCommit = existingBundles[0].tags.tipCommit as string;
    }

    // Decide whether to create a full or incremental bundle.
    const shouldSquash = totalBundles > 0 && totalBundles >= squashThreshold;
    const isIncremental = !shouldSquash && lastTipCommit !== undefined;

    let bundleInfo: BundleInfo;
    try {
      if (isIncremental) {
        // Create incremental bundle: only objects reachable from --all but not from lastTipCommit.
        bundleInfo = await createIncrementalBundle(repoPath, lastTipCommit!);
      } else {
        // Create full bundle: all refs, all objects.
        bundleInfo = await createFullBundle(repoPath);
      }
    } catch (err) {
      console.error(`bundle-sync: failed to create bundle: ${(err as Error).message}`);
      return;
    }

    try {
      // Read the bundle data from disk.
      const bundleData = new Uint8Array(await readFile(bundleInfo.path));

      const tags = {
        tipCommit : bundleInfo.tipCommit,
        isFull    : bundleInfo.isFull,
        refCount  : bundleInfo.refCount,
        size      : bundleInfo.size,
      };

      const createOptions: any = {
        data            : bundleData,
        dataFormat      : 'application/x-git-bundle',
        tags,
        parentContextId : repoContextId,
        encryption      : encrypt,
        published       : !encrypt,
      };

      if (shouldSquash) {
        // Squash write: creates a new bundle record and purges all older ones.
        createOptions.squash = true;
      }

      await repo.records.create('repo/bundle', createOptions);

      if (refs) {
        await syncBranchBundles({
          refs,
          repoContextId,
          ownerDid: did,
          repoPath,
          encrypt,
        });
      }
    } finally {
      // Clean up the temp bundle file.
      await unlink(bundleInfo.path).catch(() => {});
    }
  };
}

// ---------------------------------------------------------------------------
// Branch bundle sync
// ---------------------------------------------------------------------------

type BranchBundleSyncOptions = {
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  repoContextId: string;
  ownerDid: string;
  repoPath: string;
  encrypt: boolean;
};

async function syncBranchBundles(options: BranchBundleSyncOptions): Promise<void> {
  const { refs, repoContextId, ownerDid, repoPath, encrypt } = options;
  let gitRefs: GitRef[];
  try {
    gitRefs = await readGitRefs(repoPath);
  } catch (err) {
    console.error(`bundle-sync: failed to read refs from ${repoPath}: ${(err as Error).message}`);
    return;
  }

  const branchRefs = gitRefs.filter((ref) => ref.type === 'branch');
  if (branchRefs.length === 0) {
    return;
  }

  const { records: existingBranches } = await refs.records.query('repo/branch' as any, {
    filter: { contextId: repoContextId },
  });
  const branchRecords = new Map<string, any>();
  for (const record of existingBranches) {
    const data = await record.data.json();
    if (typeof data.refName === 'string') {
      branchRecords.set(data.refName, record);
    }
  }

  for (const ref of branchRefs) {
    const branchRecord = await ensureBranchRecord(refs, repoContextId, ownerDid, ref.name, branchRecords, !encrypt);
    await writeBranchBundleIfChanged(refs, branchRecord, repoPath, ref, encrypt);
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

  const { records: matching } = await refs.records.query('repo/branch' as any, {
    filter: { contextId: repoContextId, tags: { refName } },
  });
  if (matching.length > 0) {
    branchRecords.set(refName, matching[0]);
    return matching[0];
  }

  const data = branchDataForRef(refName, ownerDid);
  const { record } = await refs.records.create('repo/branch' as any, {
    data,
    tags: {
      refName  : data.refName,
      ownerDid : data.ownerDid,
      kind     : data.kind,
    },
    parentContextId : repoContextId,
    published       : publish,
  });
  branchRecords.set(refName, record);
  return record;
}

async function writeBranchBundleIfChanged(
  refs: TypedEnbox<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>,
  branchRecord: any,
  repoPath: string,
  ref: GitRef,
  encrypt: boolean,
): Promise<void> {
  const branchContextId = branchRecord.contextId;
  if (!branchContextId) {
    console.error(`bundle-sync: branch record for ${ref.name} has no contextId; skipping branch bundle`);
    return;
  }

  const { records } = await refs.records.query('repo/branch/bundle' as any, {
    filter   : { contextId: branchContextId },
    dateSort : DateSort.CreatedDescending,
  });
  if (records[0]?.tags?.tipCommit === ref.target) {
    return;
  }

  let bundleInfo: BranchBundleInfo;
  try {
    bundleInfo = await createBranchBundle(repoPath, ref.name);
  } catch (err) {
    console.error(`bundle-sync: failed to create branch bundle for ${ref.name}: ${(err as Error).message}`);
    return;
  }

  try {
    const bundleData = new Uint8Array(await readFile(bundleInfo.path));
    await refs.records.create('repo/branch/bundle' as any, {
      data       : bundleData,
      dataFormat : 'application/x-git-bundle',
      tags       : {
        kind      : 'checkpoint',
        refName   : ref.name,
        tipCommit : bundleInfo.tipCommit,
        size      : bundleInfo.size,
      },
      parentContextId : branchContextId,
      encryption      : encrypt,
      published       : !encrypt,
      squash          : true,
    });
  } finally {
    await unlink(bundleInfo.path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Bundle creation
// ---------------------------------------------------------------------------

/**
 * Create a full git bundle containing all refs and all reachable objects.
 *
 * @param repoPath - Path to the bare git repository
 * @returns Bundle metadata and file path
 */
export async function createFullBundle(repoPath: string): Promise<BundleInfo> {
  const bundlePath = join(tmpdir(), `gitd-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);

  await spawnChecked('git', ['bundle', 'create', bundlePath, '--all'], repoPath);

  const tipCommit = await getTipCommit(repoPath);
  const refCount = await getRefCount(repoPath);
  const fileInfo = await stat(bundlePath);

  return {
    path   : bundlePath,
    tipCommit,
    isFull : true,
    refCount,
    size   : fileInfo.size,
  };
}

/**
 * Create an incremental git bundle containing only objects since a base commit.
 *
 * The bundle uses the base commit as a prerequisite, meaning the consumer
 * must already have it to apply the incremental bundle.
 *
 * @param repoPath - Path to the bare git repository
 * @param baseCommit - The commit SHA to use as the prerequisite (exclude point)
 * @returns Bundle metadata and file path
 */
export async function createIncrementalBundle(
  repoPath: string,
  baseCommit: string,
): Promise<BundleInfo> {
  const bundlePath = join(tmpdir(), `gitd-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);

  // `--all ^<base>` means: include all refs, exclude objects reachable from base.
  await spawnChecked('git', ['bundle', 'create', bundlePath, '--all', `^${baseCommit}`], repoPath);

  const tipCommit = await getTipCommit(repoPath);
  const refCount = await getRefCount(repoPath);
  const fileInfo = await stat(bundlePath);

  return {
    path   : bundlePath,
    tipCommit,
    isFull : false,
    refCount,
    size   : fileInfo.size,
  };
}

/**
 * Create a branch-scoped checkpoint bundle containing one branch ref.
 *
 * @param repoPath - Path to the bare git repository
 * @param refName - Full branch ref name to include
 * @returns Branch bundle metadata and file path
 */
export async function createBranchBundle(repoPath: string, refName: string): Promise<BranchBundleInfo> {
  const bundlePath = join(tmpdir(), `gitd-branch-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);

  await spawnChecked('git', ['bundle', 'create', bundlePath, refName], repoPath);

  const tipCommit = (await spawnCollectStdout('git', ['rev-parse', refName], repoPath)).trim();
  const fileInfo = await stat(bundlePath);

  return {
    path : bundlePath,
    refName,
    tipCommit,
    size : fileInfo.size,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the tip commit SHA (HEAD of the default branch).
 * Falls back to the first ref if HEAD is unset.
 */
async function getTipCommit(repoPath: string): Promise<string> {
  try {
    const sha = (await spawnCollectStdout('git', ['rev-parse', 'HEAD'], repoPath)).trim();
    // In bare repos, HEAD may be a dangling symbolic ref (e.g. refs/heads/master
    // doesn't exist). `git rev-parse HEAD` outputs the literal string "HEAD" in
    // that case instead of a 40-hex SHA.
    if (/^[0-9a-f]{40}$/.test(sha)) {
      return sha;
    }
  } catch {
    // rev-parse failed entirely — fall through to for-each-ref.
  }

  // HEAD didn't resolve; get the first ref.
  const output = await spawnCollectStdout(
    'git', ['for-each-ref', '--format=%(objectname)', '--count=1', 'refs/'], repoPath,
  );
  return output.trim();
}

/** Count the number of refs (branches + tags) in the repo. */
async function getRefCount(repoPath: string): Promise<number> {
  const output = await spawnCollectStdout(
    'git', ['for-each-ref', '--format=x', 'refs/heads/', 'refs/tags/'], repoPath,
  );
  return output.split('\n').filter((l) => l.trim()).length;
}

/** Spawn a process and reject if it exits with non-zero code. */
function spawnChecked(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];

    // Drain stdout to prevent pipe buffer deadlocks.
    child.stdout!.resume();
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

/** Spawn a process, collect stdout, and return it as a string. */
function spawnCollectStdout(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr to prevent pipe buffer deadlocks.
    child.stderr!.resume();
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });
  });
}
