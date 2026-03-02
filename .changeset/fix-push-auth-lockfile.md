---
"@enbox/gitd": patch
---

Fix push authentication deadlock when daemon is running

The credential helper (`git-remote-did-credential`) was opening the agent's
LevelDB stores directly, which deadlocked when the daemon (`gitd serve`)
already held the exclusive lock. The helper now calls the daemon's new
`POST /auth/token` endpoint to request credentials without touching LevelDB.

Falls back to direct agent connection when no daemon is running.
