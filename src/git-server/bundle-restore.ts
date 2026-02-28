/**
 * Bundle restore — reconstructs a bare git repo from DWN bundle records.
 *
 * When a commodity git host receives a clone request for a repo it doesn't
 * have on disk, it resolves the owner's DID, reads bundle records from
 * the owner's DWN, and reconstructs the bare repo locally.
 *
 * Restore flow:
 * 1. Query the owner's DWN for bundle records (via the repo's contextId)
 * 2. Find the most recent full bundle (isFull: true)
 * 3. Clone from the full bundle to create a bare repo
 * 4. Apply any incremental bundles (in chronological order) that are newer
 * 5. The restored repo is now ready to serve clones and accept pushes
 *
 * @module
 */

import type { ForgeRepoProtocol } from '../repo.js';
import type { ForgeRepoSchemaMap } from '../repo.js';
import type { TypedWeb5 } from '@enbox/api';

import { DateSort } from '@enbox/dwn-sdk-js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdir, unlink, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for restoring a repository from DWN bundles. */
export type BundleRestoreOptions = {
  /** The typed ForgeRepoProtocol Web5 handle for the owner's DWN. */
  repo: TypedWeb5<typeof ForgeRepoProtocol.definition, ForgeRepoSchemaMap>;

  /** Path where the bare repository should be created. */
  repoPath: string;

  /** Scope bundle queries to a specific repo context. */
  repoContextId?: string;
};

/** Result of a bundle restore operation. */
export type BundleRestoreResult = {
  /** Whether the restore succeeded. */
  success: boolean;

  /** Number of bundles applied (1 full + N incrementals). */
  bundlesApplied: number;

  /** The tip commit SHA after restore. */
  tipCommit?: string;

  /** Error message if restore failed. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Restore a bare git repository from DWN bundle records.
 *
 * Queries the owner's DWN for bundle records, downloads the most recent
 * full bundle, clones from it, then applies any incremental bundles.
 *
 * @param options - Restore configuration
 * @returns Result of the restore operation
 */
export async function restoreFromBundles(
  options: BundleRestoreOptions,
): Promise<BundleRestoreResult> {
  const { repo, repoPath, repoContextId } = options;

  // 1. Query for the most recent full bundle.
  const fullFilter: Record<string, unknown> = { tags: { isFull: true } };
  if (repoContextId) { fullFilter.contextId = repoContextId; }

  const { records: fullBundles } = await repo.records.query('repo/bundle', {
    filter   : fullFilter,
    dateSort : DateSort.CreatedDescending,
  });

  if (fullBundles.length === 0) {
    return { success: false, bundlesApplied: 0, error: 'No full bundle found in DWN' };
  }

  const latestFull = fullBundles[0];
  const fullTimestamp = latestFull.dateCreated;

  // 2. Download the full bundle to a temp file.
  const fullBundlePath = tempBundlePath();
  try {
    const fullBlob = await latestFull.data.blob();
    const fullBlobData = Buffer.from(await fullBlob.arrayBuffer());
    await writeFile(fullBundlePath, fullBlobData);

    // 3. Clone from the full bundle to create the bare repo.
    await ensureParentDir(repoPath);
    await spawnChecked('git', ['clone', '--bare', fullBundlePath, repoPath]);

    let bundlesApplied = 1;

    // 4. Query for incremental bundles newer than the full bundle.
    const incFilter: Record<string, unknown> = { tags: { isFull: false } };
    if (repoContextId) { incFilter.contextId = repoContextId; }

    const { records: incrementals } = await repo.records.query('repo/bundle', {
      filter   : incFilter,
      dateSort : DateSort.CreatedAscending,
    });

    // Apply incremental bundles in chronological order.
    for (const incBundle of incrementals) {
      // Only apply incrementals that are newer than the full bundle.
      if (incBundle.dateCreated <= fullTimestamp) { continue; }

      const incPath = tempBundlePath();
      try {
        const incBlob = await incBundle.data.blob();
        const incData = Buffer.from(await incBlob.arrayBuffer());
        await writeFile(incPath, incData);

        // Fetch all refs from the incremental bundle into the bare repo.
        // The explicit refspec is required because bundles don't have a HEAD
        // ref, and `git fetch` without a refspec tries to fetch HEAD.
        await spawnChecked('git', ['fetch', incPath, 'refs/*:refs/*', '--update-head-ok'], repoPath);
        bundlesApplied++;
      } finally {
        await unlink(incPath).catch(() => {});
      }
    }

    // 5. Get the tip commit.
    const tipCommit = await getTipCommit(repoPath);

    return { success: true, bundlesApplied, tipCommit };
  } catch (err) {
    return {
      success        : false,
      bundlesApplied : 0,
      error          : (err as Error).message,
    };
  } finally {
    await unlink(fullBundlePath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique temp file path for a bundle. */
function tempBundlePath(): string {
  return join(tmpdir(), `gitd-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
}

/** Ensure the parent directory of a path exists. */
async function ensureParentDir(filePath: string): Promise<void> {
  const parentDir = join(filePath, '..');
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }
}

/**
 * Get the tip commit SHA from a bare repo.
 *
 * In bare repos restored from bundles, HEAD may be a dangling symbolic ref
 * (e.g. `refs/heads/master` doesn't exist but `refs/heads/main` does).
 * Falls back to the first ref SHA if HEAD doesn't resolve to a commit.
 */
async function getTipCommit(repoPath: string): Promise<string> {
  // Try HEAD first.
  const headResult = await spawnCollectOptional('git', ['rev-parse', 'HEAD'], repoPath);
  if (headResult && /^[0-9a-f]{40}$/.test(headResult)) {
    return headResult;
  }

  // HEAD didn't resolve; get the first ref.
  const refResult = await spawnCollectOptional(
    'git', ['for-each-ref', '--format=%(objectname)', '--count=1', 'refs/'], repoPath,
  );
  return refResult || 'unknown';
}

/** Spawn a process, collect stdout, return trimmed output or null on failure. */
function spawnCollectOptional(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr to prevent pipe buffer deadlocks.
    child.stderr!.resume();
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve(null);
      } else {
        const result = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(result || null);
      }
    });
  });
}

/** Spawn a process and reject if it exits with non-zero code. */
function spawnChecked(cmd: string, args: string[], cwd?: string): Promise<void> {
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
