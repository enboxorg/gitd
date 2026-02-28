---
'@enbox/gitd': minor
---

Add preflight git dependency check: all CLI commands (except `--version` and `help`) now verify that `git >= 2.28.0` is installed, with clear error messages when it is missing or outdated. Version and help commands print a warning instead of blocking.
