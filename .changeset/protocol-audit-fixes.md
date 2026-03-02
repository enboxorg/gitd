---
'@enbox/gitd': minor
---

Protocol audit fixes

1. **refs.ts**: `target` tag is now required on ref records (a ref without
   a commit SHA is meaningless).

2. **patches.ts**: `statusChange` records now require `from`/`to` tags
   (matching the issues protocol) so transitions can be queried — e.g.
   "all transitions that closed a PR". All callers (shim merge, CLI merge,
   close, reopen) updated.

3. **patches.ts**: Renamed `tipCommit` → `headCommit` in the
   `revisionBundle` schema and its callers for consistency with the
   `revision` record which already uses `headCommit`.

4. **releases.ts**: `target_commitish` now reads the `commitSha` tag from
   the release record instead of always returning `'main'`.

5. **credential-cache.ts**: `writeCache` now creates the parent directory
   (`mkdirSync` with `{ recursive: true }`) before writing, preventing
   ENOENT when `~/.enbox` doesn't exist yet.
