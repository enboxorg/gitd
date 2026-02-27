---
'@enbox/gitd': minor
---

Add `repo/patch/revision/bundle` path to ForgePatchesProtocol for carrying git bundle binaries with PR revisions. Each revision can have at most one bundle (`$recordLimit: { max: 1 }`), immutable, with `tipCommit`/`baseCommit`/`refCount`/`size` tags. This enables cross-DWN PR submissions where contributors attach scoped git bundles to their patch revisions.
