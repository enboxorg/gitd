---
'@enbox/gitd': patch
---

Add per-repo mutex to serialize post-push sync operations

Concurrent pushes to the same repository could race on DWN record
updates (ref-sync, bundle-sync) or bundle restores, causing data
corruption. A lightweight promise-chain mutex keyed by `did/repoName`
now serializes these operations per repository while allowing different
repos to proceed concurrently.
