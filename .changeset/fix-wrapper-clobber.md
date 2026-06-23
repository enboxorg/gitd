---
'@enbox/gitd': patch
---

fix: avoid clobbering installed package files when writing command wrappers

The installer and `gitd setup` now remove stale symlinks before writing wrapper
commands, preventing shell redirection from overwriting the package's compiled
CLI entry points.
