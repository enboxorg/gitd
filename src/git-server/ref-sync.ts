/**
 * Git ref → DWN sync — mirrors git branch/tag refs as ForgeRefs records.
 *
 * After a successful `git push`, this module reads the current refs from
 * the bare repository and creates or updates corresponding DWN records
 * using the ForgeRefsProtocol.
 *
 * Ref sync flow:
 * 1. Run `git for-each-ref` on the bare repo to enumerate current refs
 * 2. Query existing DWN ref records for the repo
 * 3. Create new records for refs that don't exist in DWN
 * 4. Update existing records whose target (SHA) has changed
 * 5. Delete DWN records for refs that no longer exist in git
 *
 * @module
 */

import type { TypedWeb5 } from '@enbox/api';

import { spawn } from 'node:child_process';

import type { ForgeRefsProtocol } from '../refs.js';
import type { ForgeRefsSchemaMap } from '../refs.js';

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
  /** The typed ForgeRefsProtocol Web5 handle. */
  refs: TypedWeb5<typeof ForgeRefsProtocol.definition, ForgeRefsSchemaMap>;
  /** The repo's contextId (from the ForgeRepoProtocol repo record). */
  repoContextId: string;
};

/** Callback for post-push ref synchronization. */
export type OnPushComplete = (
  did: string,
  repo: string,
  repoPath: string,
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
  const { refs, repoContextId } = options;

  return async (_did: string, _repo: string, repoPath: string): Promise<void> => {
    // Read current git refs from the bare repository.
    const gitRefs = await readGitRefs(repoPath);

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
  };
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

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr to prevent pipe buffer deadlocks.
    child.stderr!.resume();
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve(''); // Empty refs for non-zero exit (e.g., empty repo).
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });
  });
}
