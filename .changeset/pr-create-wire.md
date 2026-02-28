---
'@enbox/gitd': minor
---

Wire `gitd pr create` to automatically generate a revision record and attach a scoped git bundle when run from a git repo with commits ahead of the base branch. The command now computes merge-base, diff stats, commit count, and creates a `repo/patch/revision` + `repo/patch/revision/revisionBundle` in one shot. Use `--no-bundle` to skip git operations and create a metadata-only PR.
