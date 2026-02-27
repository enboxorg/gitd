---
'@enbox/gitd': minor
---

`gitd init` now initializes a local git repo in the current directory and adds the `origin` remote automatically, matching git/gh conventions. Pass `--no-local` to skip local setup and only create the server-side bare repo + DWN record.
