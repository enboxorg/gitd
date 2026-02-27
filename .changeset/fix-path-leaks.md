---
'@enbox/gitd': patch
---

Eliminate CWD-relative path leaks: RESOLVERCACHE/, DATA/AGENT/, and ./repos no longer created in the working directory. All paths now resolve to ~/.enbox/profiles/default/ when no named profile is active.
