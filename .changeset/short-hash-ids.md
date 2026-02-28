---
'@enbox/gitd': minor
---

Replace sequential PR/issue numbers with short hash IDs derived from DWN record IDs (first 7 hex chars of SHA-256). Remove `number` from protocol tags and data types. CLI and web UI now use short hash IDs for display and lookup.
