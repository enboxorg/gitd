---
'@enbox/gitd': patch
---

Prompt for vault password on /dev/tty in git helpers when GITD_PASSWORD is not set

Both `git-remote-did` and `git-remote-did-credential` now open `/dev/tty` directly
to prompt for the vault password when `GITD_PASSWORD` is not set in the environment.
This is the same technique used by `ssh`, `gpg`, and `sudo` to prompt the user when
stdin/stdout are claimed by a parent process (in this case, git).

Previously, `git push` would silently fail if `GITD_PASSWORD` was not pre-set because
the credential helper had no way to obtain the password and the remote helper could not
auto-start the daemon. Now the user sees a "Vault password:" prompt and everything
just works.
