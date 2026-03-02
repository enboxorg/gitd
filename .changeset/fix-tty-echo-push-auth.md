---
'@enbox/gitd': patch
---

Fix TTY password prompt echo and eliminate double prompt during git push

The `/dev/tty` password prompt introduced in PR #153 was not disabling
terminal echo, so the vault password was visible as the user typed.
Now runs `stty -echo` before reading and `stty echo` after, matching
the behavior of `ssh`, `gpg`, and `sudo`.

Also fixes the double-prompt issue: `git-remote-did` was unconditionally
prompting for the vault password before resolving the DID, even when the
daemon was already running and the password wasn't needed. The prompt is
now deferred to `resolveLocalDaemon` and only triggered when a daemon
actually needs to be spawned. In the common case (daemon already running),
only the credential helper prompts — once.

Additionally switches from byte-at-a-time reads to cooked-mode line reads
on `/dev/tty`, which is more reliable across shells and lets the terminal
driver handle backspace and line editing natively.
