---
"@enbox/gitd": patch
---

Wire credential helper automatically in git-remote-did so push auth works without running `gitd setup`. Fail loudly with actionable hints when authentication cannot proceed.
