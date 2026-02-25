---
'@enbox/gitd': patch
---

Fix DWN registration in profile mode and remove spurious DATA/ directory creation. The SDK ignores the `registration` option when an explicit agent is passed, so registration is now performed directly before `Web5.connect()`.
