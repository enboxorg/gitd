# @enbox/gitd

## 0.3.0

### Minor Changes

- [#64](https://github.com/enboxorg/gitd/pull/64) [`695b2ae`](https://github.com/enboxorg/gitd/commit/695b2ae9eeb9082d49a648f8b28a5dd904d9ff34) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: identity profiles and `gitd auth` onboarding

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

### Patch Changes

- [#66](https://github.com/enboxorg/gitd/pull/66) [`1a6f8ff`](https://github.com/enboxorg/gitd/commit/1a6f8ff329646134b2f4e49a005c863e0a36a5b2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: credential helper uses identity profiles and signs with correct DID

  The git credential helper (`git-remote-did-credential`) now resolves
  the active identity profile before connecting to the agent, matching
  the same resolution chain used by all `gitd` CLI commands (env var,
  git config, global default, single fallback).

  Also fixes a signing bug: the helper previously signed push tokens
  with the internal agent DID but claimed the identity DID in the token
  payload, which would cause signature verification to fail when the
  server resolves the claimed DID's public key. Now signs with the
  identity's own BearerDid signer.

## 0.2.0

### Minor Changes

- [#61](https://github.com/enboxorg/gitd/pull/61) [`e385606`](https://github.com/enboxorg/gitd/commit/e385606b3865cc53c704dc6b46c667a66c841322) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: migrate git content (clone, bundle, refs) from GitHub

  The `gitd migrate repo` and `gitd migrate all` commands now support
  migrating actual git content — not just metadata. When `--repos <path>`
  or `GITD_REPOS` is provided, migration will:

  1. Clone the GitHub repo as a bare repository on disk
  2. Create a full git bundle and upload it to DWN
  3. Sync all git refs (branches + tags) to DWN records

  This enables the full e2e flow: migrate → serve → clone-via-DID.

## 0.1.1

### Patch Changes

- [#57](https://github.com/enboxorg/gitd/pull/57) [`19ac7f3`](https://github.com/enboxorg/gitd/commit/19ac7f3d29f147e8b1dc7f53225ffc63900b23fc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `--version` flag and hide password input in the terminal

- [#58](https://github.com/enboxorg/gitd/pull/58) [`7e8ce08`](https://github.com/enboxorg/gitd/commit/7e8ce08ac225d8db6f7062f63107aa395ba970d8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix process hang after one-shot CLI commands by calling process.exit(0)

## 0.1.0

### Minor Changes

- [#55](https://github.com/enboxorg/gitd/pull/55) [`31f9772`](https://github.com/enboxorg/gitd/commit/31f9772b14046b5e158aa1a37bbe2354323c93d4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Auto-detect GitHub auth from `gh` CLI and infer owner/repo from local git remotes for the migrate command

## 0.0.3

### Patch Changes

- [#52](https://github.com/enboxorg/gitd/pull/52) [`dc971e4`](https://github.com/enboxorg/gitd/commit/dc971e4e41607a09cb3f4eb5f8061981490c3b7e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add classic-level to trustedDependencies so bun runs its native postinstall script during install

## 0.0.2

### Patch Changes

- [#48](https://github.com/enboxorg/gitd/pull/48) [`c4d7575`](https://github.com/enboxorg/gitd/commit/c4d75754ce7f54c393abae5d2c3cbf19977f6f3e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Initial npm release of gitd — a decentralized forge (GitHub alternative) built on DWN protocols.
