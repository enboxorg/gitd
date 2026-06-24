---
'@enbox/gitd': minor
---

feat: durable vault-unlock secret so commands stop re-prompting

gitd now resolves the vault unlock password through a single path (explicit →
`GITD_PASSWORD` → public-reader secret → durable secret store → prompt) and
persists a freshly entered secret in a durable per-profile store — the OS
keychain (macOS `security`, Linux `secret-tool`) when available, otherwise a
machine-keyed AES-256-GCM encrypted file under `~/.enbox/secrets/`. After the
first unlock, subsequent commands restore the session without prompting for the
vault password again.

`GITD_SECRET_BACKEND=keychain|file|none` pins or disables the backend. A cached
secret that is later rejected is cleared automatically so a stale secret can't
lock you out. `gitd auth logout` / `gitd auth reset` drop the stored secret.
