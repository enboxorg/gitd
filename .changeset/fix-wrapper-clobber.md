---
'@enbox/gitd': patch
---

fix: repair installed command wrappers and profile daemon discovery

The installer and `gitd setup` now remove stale symlinks before writing wrapper
commands, preventing shell redirection from overwriting the package's compiled
CLI entry points. The DID remote helper also discovers profile-scoped daemons
from the active gitd profile, so `git push` can use the daemon started by
`gitd serve` without requiring `GITD_PROFILE` to be exported.
