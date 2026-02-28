---
'@enbox/gitd': minor
---

Replace metadata-only `gitd pr merge` with actual git merge. The command now checks out the base branch, performs the merge with `--merge` (default), `--squash`, or `--rebase` strategy, records the real merge commit SHA in a `mergeResult` record, creates a `statusChange` audit trail record, and deletes the local PR branch (use `--no-delete-branch` to keep it).
