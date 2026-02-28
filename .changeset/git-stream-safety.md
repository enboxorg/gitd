---
'@enbox/gitd': patch
---

Fix potential deadlocks and unbounded memory growth in git subprocess management: drain unused stderr/stdout pipes across all spawn helpers, and handle stdin backpressure in spawnGitService
