---
'@enbox/gitd': patch
---

Add two-actor E2E collaboration test exercising the full maintainer + contributor workflow: repo creation, clone, feature branch, git bundle PR submission, review, merge, pull, and push authorization. Uses offline agent creation (DidDht with publish: false) to avoid DHT network dependency.
