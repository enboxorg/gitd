---
'@enbox/gitd': patch
---

Validate port number in `gitd web` command using `parsePort` instead of raw `parseInt`, rejecting invalid values with a clear error
