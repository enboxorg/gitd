---
"@enbox/gitd": minor
---

feat: identity profiles and `gitd auth` onboarding

Adds an AWS-style profile system for managing multiple DID identities:

- Profiles stored at `~/.enbox/profiles/<name>/` (cross-platform, shared
  across enbox-enabled apps)
- `gitd auth login` — interactive wizard to create or import an identity
- `gitd auth list` — list all profiles
- `gitd auth use <name>` — set active profile per-repo or globally
- `gitd auth logout <name>` — remove a profile
- Profile resolution: `--profile` flag > `ENBOX_PROFILE` env > `.git/config`
  > default profile > single-profile fallback
- `connectAgent()` refactored to accept `dataPath` for profile-based storage
- Uses `@clack/prompts` for clean interactive terminal UX
