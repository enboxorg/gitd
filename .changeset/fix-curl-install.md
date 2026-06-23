---
'@enbox/gitd': patch
---

fix: install gitd through the Bun package path

The curl installer now installs the published `@enbox/gitd` package with Bun
and links wrappers into `~/.gitd/bin`. Standalone release artifacts are disabled
until gitd no longer depends on native packages that need platform-local
installation.
