---
'@enbox/gitd': minor
---

Add `gitd pr checkout <number>` (alias `co`) to fetch a PR's bundle from DWN, import git objects, and create a local branch at the tip commit. Supports `--branch` to override the local branch name and `--detach` for a detached HEAD.
