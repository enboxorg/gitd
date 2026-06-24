---
'@enbox/gitd': minor
---

feat: git push/fetch work without a running helper

The git credential helper's fallback and the daemon auto-start now resolve the
vault password from the durable secret store (OS keychain / encrypted file) that
was set on the first unlock — in addition to `GITD_PASSWORD` and the `/dev/tty`
prompt. As a result `git push` and `git fetch` succeed even when no local helper
is running and without an interactive prompt: the credential helper signs a
fresh DID push token directly, so a dead or never-started helper no longer
blocks pushes.

Daemon lockfiles are now written atomically (temp file + rename) so a crash
mid-write can't leave a corrupt lockfile behind.
