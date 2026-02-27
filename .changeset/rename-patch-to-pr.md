---
'@enbox/gitd': minor
---

Rename `gitd patch` CLI command to `gitd pr` for a familiar GitHub-like UX. The `patch` subcommand is kept as an alias. All user-facing output now says "PR" instead of "patch". Internal protocol names (`repo/patch`, `ForgePatchesProtocol`) are unchanged.
