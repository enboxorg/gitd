---
'@enbox/gitd': minor
---

Add `--private` flag to `gitd init`

Repos are public by default. Pass `--private` to create a private repo
whose bundles are encrypted during sync. The visibility is stored in the
DWN repo record's `visibility` tag and is already handled downstream by
`bundle-sync.ts` and `migrate.ts`.
