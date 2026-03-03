---
"@enbox/gitd": patch
---

Fix daemon crash when cloning nonexistent repos (process.exit in server context) and resolve credential helper by absolute path so push auth works without PATH setup.
