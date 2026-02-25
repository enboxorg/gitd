---
"@enbox/gitd": minor
---

Multi-repo architecture: a DID can now own multiple repositories. Removes the `$recordLimit` singleton constraint on repo records. All CLI commands, the GitHub shim, the web UI, and migration resolve repos by name. Web UI routes change from `/:did/...` to `/:did/:repo/...` with a new repo list page at `/:did`. The `--repo` flag, `GITD_REPO` env, and `git config enbox.repo` select the active repo when multiple exist.
