---
'@enbox/gitd': patch
---

Fix `findGitdBin()` dev path heuristic

The function used `lockfilePath()` (`~/.enbox/daemon.lock`) to derive the
source tree location, resolving to `~/src/cli/main.ts` — completely wrong.

Now uses `import.meta.url` to resolve relative to the module file itself,
correctly finding `src/cli/main.ts` in the project tree.
