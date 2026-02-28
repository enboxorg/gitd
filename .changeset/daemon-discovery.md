---
'@enbox/gitd': minor
---

Add daemon lockfile (`~/.enbox/daemon.lock`) so `gitd serve` advertises its PID and port, and `git-remote-did` resolves `did::` remotes to the local daemon before attempting DID document resolution. This removes the DID-resolution round-trip for local development.
