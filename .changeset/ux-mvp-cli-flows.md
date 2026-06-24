---
'@enbox/gitd': patch
---

Add the first gitd UX MVP slice for local, edge-run repository workflows.

The CLI now exposes `gitd doctor`, `gitd repair`, and `gitd helper ...`
commands, keeps local helper guidance separate from public GitTransport
publishing, and records repo context during `gitd init` and `gitd clone` so
later commands can infer owner, repo, branch, and identity without extra flags.

First-run write commands now resolve a concrete identity before connecting the
Enbox agent, create the implicit `default` identity in interactive terminals,
and keep non-interactive `GITD_PASSWORD` flows working for scripts. Public
read-only clones can use a hidden local public-read cache when no identity is
configured.

Contributor PR creation now infers base/head branch context, can publish the
canonical contributor branch with `--push`, and prompts interactively when a
remote-owner PR needs that publish step. Maintainer merges, role changes, and
moderation commands print concise authority summaries before writing records.

The local helper lockfile now records session-style metadata used by `gitd
helper status`, `gitd auth sessions`, and `gitd auth revoke helper`. Doctor and
repair cover configured DWN reachability, `did::` origins, dangling bare-repo
`HEAD` refs, and duplicate `squash` SQLite migration drift. The repo protocol
also includes `$squash` `repo/viewSnapshot` records for maintainer/moderator
issue, PR, moderation, and report checkpoints.
