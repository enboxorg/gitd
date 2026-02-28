---
'@enbox/gitd': patch
---

Prevent silent ref deletion when git fails: ref-sync now aborts instead of deleting all DWN ref records when `git for-each-ref` exits with a non-zero code
