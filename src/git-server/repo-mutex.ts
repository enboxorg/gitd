/**
 * Per-repo mutex — serializes async operations on the same repository.
 *
 * Prevents race conditions when concurrent pushes to the same repo
 * trigger overlapping ref-sync, bundle-sync, or bundle-restore operations.
 *
 * Uses a simple promise-chain per key: each new operation awaits the
 * previous one before starting, regardless of whether it succeeded or
 * failed.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A mutex key — typically `${did}/${repoName}`. */
type MutexKey = string;

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

/** Map of repo keys to the tail of the promise chain. */
const locks = new Map<MutexKey, Promise<void>>();

/**
 * Run `fn` while holding the mutex for `key`.
 *
 * If another operation is in progress for the same key, this call waits
 * for it to finish before starting.  Operations on different keys run
 * concurrently.
 *
 * @param key - Mutex key (e.g. `${did}/${repoName}`)
 * @param fn  - Async work to run exclusively
 * @returns The return value of `fn`
 */
export async function withRepoLock<T>(key: MutexKey, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();

  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  locks.set(key, next);

  // Wait for any previous operation on this key to finish.
  await prev;

  try {
    return await fn();
  } finally {
    resolve!();

    // Clean up the map entry if no one else has queued behind us.
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}
