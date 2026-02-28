---
'@enbox/gitd': minor
---

Populate GitHub shim PR response fields from DWN revision and mergeResult records. `head.sha`, `base.sha`, `commits`, `additions`, `deletions`, `changed_files` now come from the latest revision record; `merge_commit_sha` comes from the mergeResult record. The `user` field uses `sourceDid` when available. Also add `statusChange` audit trail records to `pr close`, `pr reopen`, and the shim merge endpoint, and fix the migrate command's `CHANGES_REQUESTED` → `reject` verdict mapping.
