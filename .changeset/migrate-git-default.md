---
"@enbox/gitd": patch
---

Make git content migration the default for `gitd migrate`. Previously, git content (clone, bundle, refs) was only included when `--repos <path>` was explicitly provided. Now it defaults to `./repos` (matching `gitd serve`), and a new `--no-git` flag skips git content when not needed.
