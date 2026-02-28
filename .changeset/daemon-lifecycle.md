---
'@enbox/gitd': minor
---

Add auto-managed daemon lifecycle: `git-remote-did` now auto-starts `gitd serve` in the background when no daemon is running, with idle auto-shutdown after 1 hour. New lifecycle commands: `gitd serve status|stop|restart|logs`. The lockfile now includes the gitd version for upgrade detection.
