---
"@enbox/gitd": minor
---

feat: migrate git content (clone, bundle, refs) from GitHub

The `gitd migrate repo` and `gitd migrate all` commands now support
migrating actual git content — not just metadata. When `--repos <path>`
or `GITD_REPOS` is provided, migration will:

1. Clone the GitHub repo as a bare repository on disk
2. Create a full git bundle and upload it to DWN
3. Sync all git refs (branches + tags) to DWN records

This enables the full e2e flow: migrate → serve → clone-via-DID.
