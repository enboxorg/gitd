---
'@enbox/gitd': patch
---

Guard onPushComplete behind git subprocess exit code so rejected pushes (non-fast-forward, hook failures) no longer trigger ref-sync and bundle-sync
