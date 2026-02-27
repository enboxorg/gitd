# @enbox/gitd

## 0.6.1

### Patch Changes

- [#88](https://github.com/enboxorg/gitd/pull/88) [`5b0f58d`](https://github.com/enboxorg/gitd/commit/5b0f58dcd9edfcb1420b7cebeeb3aff5871df29f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix `did:` prefix doubling when remote URL contains the full DID (`did::did:dht:.../repo`). The URL parser now accepts both short (`dht:id/repo`) and full (`did:dht:id/repo`) forms.

## 0.6.0

### Minor Changes

- [#87](https://github.com/enboxorg/gitd/pull/87) [`b94169f`](https://github.com/enboxorg/gitd/commit/b94169f797b63864c292a2f7b89acddbbce2478e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - `gitd init` now initializes a local git repo in the current directory and adds the `origin` remote automatically, matching git/gh conventions. Pass `--no-local` to skip local setup and only create the server-side bare repo + DWN record.

### Patch Changes

- [#85](https://github.com/enboxorg/gitd/pull/85) [`4794775`](https://github.com/enboxorg/gitd/commit/479477541504abc20d209183f1a9a4749d38aac6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Eliminate CWD-relative path leaks: RESOLVERCACHE/, DATA/AGENT/, and ./repos no longer created in the working directory. All paths now resolve to ~/.enbox/profiles/default/ when no named profile is active.

## 0.5.0

### Minor Changes

- [#82](https://github.com/enboxorg/gitd/pull/82) [`bf734a0`](https://github.com/enboxorg/gitd/commit/bf734a053274b0b22f44b8a1c40c4217b941b53f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `gitd serve --check` to validate public URL reachability, improve `gitd init` post-instructions to mention `--public-url`, and add DEPLOY.md deployment guide

### Patch Changes

- [#83](https://github.com/enboxorg/gitd/pull/83) [`b852043`](https://github.com/enboxorg/gitd/commit/b852043cc93b67b1e0d4d6ee64c761f9b30ee692) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Implement credential helper `store` and `erase` actions with file-based TTL-aware cache

- [#84](https://github.com/enboxorg/gitd/pull/84) [`594af61`](https://github.com/enboxorg/gitd/commit/594af6143631568b0fc878cca804110c81d44a4f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add exports test verifying all public symbols from `@enbox/gitd/git-server` and `@enbox/gitd/git-remote` sub-paths

- [#77](https://github.com/enboxorg/gitd/pull/77) [`c093dd9`](https://github.com/enboxorg/gitd/commit/c093dd932bc62fea6d22fd7f63a9c1fee607fd0e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix DWN registration in profile mode and remove spurious DATA/ directory creation. The SDK ignores the `registration` option when an explicit agent is passed, so registration is now performed directly before `Web5.connect()`.

- [#81](https://github.com/enboxorg/gitd/pull/81) [`1a98208`](https://github.com/enboxorg/gitd/commit/1a982086bddb649edd492a8c3f23025f367c980e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Complete `gitd setup` command: configure git credential helper (`git config --global credential.helper`), add `--check` for dry-run validation, and `--uninstall` to reverse configuration.

- [#79](https://github.com/enboxorg/gitd/pull/79) [`2f1fa09`](https://github.com/enboxorg/gitd/commit/2f1fa09ee199e4ed893dcfdf64c6043c35fa850a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace LevelDB with SQLite for DWN core stores (MessageStore, DataStore, StateIndex, ResumableTaskStore) using `@enbox/dwn-sql-store` and Bun's native `bun:sqlite`. The remaining LevelDB stores (SyncEngine, vault, DID resolver cache) await upstream SQL alternatives (enboxorg/enbox#569, enboxorg/enbox#570).

- [#80](https://github.com/enboxorg/gitd/pull/80) [`cb24570`](https://github.com/enboxorg/gitd/commit/cb24570275e6127d975f67451b298f1c6f8fe434) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `GITD_ALLOW_PRIVATE=1` env var to bypass SSRF protection for local development with `did:web:localhost` and other local DID methods. Prints a warning to stderr when active. Also exports `assertNotPrivateUrl` and adds comprehensive SSRF tests replacing the previous stub.

## 0.4.0

### Minor Changes

- [#74](https://github.com/enboxorg/gitd/pull/74) [`e98a55f`](https://github.com/enboxorg/gitd/commit/e98a55fd72236be9459561289ac6d2fc0861c9dd) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Enable DWN sync and populate DWN endpoints in repo records. `connectAgent` now accepts a `sync` option (defaults to `'off'` for one-shot commands, `'30s'` for long-running commands like `serve`). Controlled via `GITD_SYNC` env var or `--sync`/`--no-sync` flags. `gitd init` auto-populates `dwnEndpoints` from the DID document's `DecentralizedWebNode` service, overridable with `--dwn-endpoint` flag or `GITD_DWN_ENDPOINT` env. `gitd serve` ensures all repo records have current DWN and git endpoints at startup, and periodically republishes `did:dht` documents to keep them alive on the DHT network.

- [#72](https://github.com/enboxorg/gitd/pull/72) [`67ead30`](https://github.com/enboxorg/gitd/commit/67ead302632f1c29a4468a7110150a9dca8a824c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Multi-repo architecture: a DID can now own multiple repositories. Removes the `$recordLimit` singleton constraint on repo records. All CLI commands, the GitHub shim, the web UI, and migration resolve repos by name. Web UI routes change from `/:did/...` to `/:did/:repo/...` with a new repo list page at `/:did`. The `--repo` flag, `GITD_REPO` env, and `git config enbox.repo` select the active repo when multiple exist. Ref and bundle sync queries are now scoped to the repo's contextId to prevent cross-repo interference. Bundle restore accepts an optional `repoContextId` for scoped restores.

- [#75](https://github.com/enboxorg/gitd/pull/75) [`41e406d`](https://github.com/enboxorg/gitd/commit/41e406d59ef71906972d3424c99de35b52455d20) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Wire up provider-auth-v0 DWN registration so the agent can authenticate with DWN servers that require it. Registration tokens are cached on disk and refreshed automatically when they expire.

- [#76](https://github.com/enboxorg/gitd/pull/76) [`efaa13f`](https://github.com/enboxorg/gitd/commit/efaa13f4ad6a2aaefdf9a357e532635ae2883f8f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Store bare git repos under the profile directory (~/.enbox/profiles/<name>/repos/) instead of CWD-relative ./repos, and print post-init instructions showing how to set up a git working tree and push.

### Patch Changes

- [#70](https://github.com/enboxorg/gitd/pull/70) [`4f73edd`](https://github.com/enboxorg/gitd/commit/4f73edda4df725cef8ea0d4a5692a009c8a716fb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Make git content migration the default for `gitd migrate`. Previously, git content (clone, bundle, refs) was only included when `--repos <path>` was explicitly provided. Now it defaults to `./repos` (matching `gitd serve`), and a new `--no-git` flag skips git content when not needed.

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
