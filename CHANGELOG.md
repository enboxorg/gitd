# @enbox/gitd

## 0.7.0

### Minor Changes

- [#106](https://github.com/enboxorg/gitd/pull/106) [`ac391b6`](https://github.com/enboxorg/gitd/commit/ac391b68ee93926acabb685905a9d85def7d9cf9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add daemon lockfile (`~/.enbox/daemon.lock`) so `gitd serve` advertises its PID and port, and `git-remote-did` resolves `did::` remotes to the local daemon before attempting DID document resolution. This removes the DID-resolution round-trip for local development.

- [#110](https://github.com/enboxorg/gitd/pull/110) [`978ff95`](https://github.com/enboxorg/gitd/commit/978ff952506b98a3a08e378ae9d8cfbebae5831c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add auto-managed daemon lifecycle: `git-remote-did` now auto-starts `gitd serve` in the background when no daemon is running, with idle auto-shutdown after 1 hour. New lifecycle commands: `gitd serve status|stop|restart|logs`. The lockfile now includes the gitd version for upgrade detection.

- [#109](https://github.com/enboxorg/gitd/pull/109) [`4724167`](https://github.com/enboxorg/gitd/commit/47241678193c8902983f079b9b83e1cbe33a8164) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add preflight git dependency check: all CLI commands (except `--version` and `help`) now verify that `git >= 2.28.0` is installed, with clear error messages when it is missing or outdated. Version and help commands print a warning instead of blocking.

- [#103](https://github.com/enboxorg/gitd/pull/103) [`e6947c9`](https://github.com/enboxorg/gitd/commit/e6947c9800b365af3d6e957a28f83f54c4d10167) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `gitd pr checkout <number>` (alias `co`) to fetch a PR's bundle from DWN, import git objects, and create a local branch at the tip commit. Supports `--branch` to override the local branch name and `--detach` for a detached HEAD.

- [#102](https://github.com/enboxorg/gitd/pull/102) [`de5dcf8`](https://github.com/enboxorg/gitd/commit/de5dcf8f14b1c0ad3dc8125eac5252064f2453a2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Wire `gitd pr create` to automatically generate a revision record and attach a scoped git bundle when run from a git repo with commits ahead of the base branch. The command now computes merge-base, diff stats, commit count, and creates a `repo/patch/revision` + `repo/patch/revision/revisionBundle` in one shot. Use `--no-bundle` to skip git operations and create a metadata-only PR.

- [#104](https://github.com/enboxorg/gitd/pull/104) [`98e04d5`](https://github.com/enboxorg/gitd/commit/98e04d51af4acd4ef800a46fffff0dc569e06dd7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace metadata-only `gitd pr merge` with actual git merge. The command now checks out the base branch, performs the merge with `--merge` (default), `--squash`, or `--rebase` strategy, records the real merge commit SHA in a `mergeResult` record, creates a `statusChange` audit trail record, and deletes the local PR branch (use `--no-delete-branch` to keep it).

- [#98](https://github.com/enboxorg/gitd/pull/98) [`18f310a`](https://github.com/enboxorg/gitd/commit/18f310afd55e093fc5b8c0b0e8eaaee0fd400bb1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Rename `gitd patch` CLI command to `gitd pr` for a familiar GitHub-like UX. The `patch` subcommand is kept as an alias. All user-facing output now says "PR" instead of "patch". Internal protocol names (`repo/patch`, `ForgePatchesProtocol`) are unchanged.

- [#100](https://github.com/enboxorg/gitd/pull/100) [`f01dab2`](https://github.com/enboxorg/gitd/commit/f01dab273dbb7dd8ee849b9eb01342306b2ef016) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `repo/patch/revision/bundle` path to ForgePatchesProtocol for carrying git bundle binaries with PR revisions. Each revision can have at most one bundle (`$recordLimit: { max: 1 }`), immutable, with `tipCommit`/`baseCommit`/`refCount`/`size` tags. This enables cross-DWN PR submissions where contributors attach scoped git bundles to their patch revisions.

- [#105](https://github.com/enboxorg/gitd/pull/105) [`5865642`](https://github.com/enboxorg/gitd/commit/58656421d6f1bc8a694cd2b5fab2f049b074a50b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Populate GitHub shim PR response fields from DWN revision and mergeResult records. `head.sha`, `base.sha`, `commits`, `additions`, `deletions`, `changed_files` now come from the latest revision record; `merge_commit_sha` comes from the mergeResult record. The `user` field uses `sourceDid` when available. Also add `statusChange` audit trail records to `pr close`, `pr reopen`, and the shim merge endpoint, and fix the migrate command's `CHANGES_REQUESTED` → `reject` verdict mapping.

- [#136](https://github.com/enboxorg/gitd/pull/136) [`d10a031`](https://github.com/enboxorg/gitd/commit/d10a0318c2e7cb53805304f5ff407351c66ab875) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace sequential PR/issue numbers with short hash IDs derived from DWN record IDs (first 7 hex chars of SHA-256). Remove `number` from protocol tags and data types. CLI and web UI now use short hash IDs for display and lookup.

- [#101](https://github.com/enboxorg/gitd/pull/101) [`7e3bbe4`](https://github.com/enboxorg/gitd/commit/7e3bbe4bc71b763370222a784f7345549b496953) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Open ForgePatchesProtocol to external contributors: anyone can now create patches, reviews, and review comments without needing a contributor role. All child paths (revision, revisionBundle, review, reviewComment, statusChange, mergeResult) are publicly readable. This enables open-source-style PR submissions from any DID.

### Patch Changes

- [#135](https://github.com/enboxorg/gitd/pull/135) [`baa4f0e`](https://github.com/enboxorg/gitd/commit/baa4f0e8d24269d55990b444cf61acf9eee86a81) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix audit findings: rebase merge logic, comment body parsing, issues protocol permissions, draft PR mapping, repo name validation, and enbox.repo git config

- [#112](https://github.com/enboxorg/gitd/pull/112) [`6c46f8b`](https://github.com/enboxorg/gitd/commit/6c46f8ba5c70a0bd560ea9bb2e2646f70698d270) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add two-actor E2E collaboration test exercising the full maintainer + contributor workflow: repo creation, clone, feature branch, git bundle PR submission, review, merge, pull, and push authorization. Uses offline agent creation (DidDht with publish: false) to avoid DHT network dependency.

- [#141](https://github.com/enboxorg/gitd/pull/141) [`d07aaf9`](https://github.com/enboxorg/gitd/commit/d07aaf9d86bbf0ac639450fd384cec32c490eb3f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support `--flag=value` syntax in CLI argument parsing so flags like `--port=8080` work in addition to `--port 8080`

- [#137](https://github.com/enboxorg/gitd/pull/137) [`0a35619`](https://github.com/enboxorg/gitd/commit/0a356194ca090efc520d3deb24f6d4161f6577ba) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix potential deadlocks and unbounded memory growth in git subprocess management: drain unused stderr/stdout pipes across all spawn helpers, and handle stdin backpressure in spawnGitService

- [#140](https://github.com/enboxorg/gitd/pull/140) [`53966f0`](https://github.com/enboxorg/gitd/commit/53966f0ac4b41fb0e075b3147e7d55f6f6284b1f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Make issue and PR migration idempotent: store GitHub source number in the data payload and skip already-imported items on re-run

- [#138](https://github.com/enboxorg/gitd/pull/138) [`ab5f671`](https://github.com/enboxorg/gitd/commit/ab5f6715d02600d975e410db1ef459b49b9a9073) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Guard onPushComplete behind git subprocess exit code so rejected pushes (non-fast-forward, hook failures) no longer trigger ref-sync and bundle-sync

- [#139](https://github.com/enboxorg/gitd/pull/139) [`b23a762`](https://github.com/enboxorg/gitd/commit/b23a762dd9b396f221816bec56e0f3b62302833c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Prevent silent ref deletion when git fails: ref-sync now aborts instead of deleting all DWN ref records when `git for-each-ref` exits with a non-zero code

- [#144](https://github.com/enboxorg/gitd/pull/144) [`a8f9b1a`](https://github.com/enboxorg/gitd/commit/a8f9b1afecfd13a7679ccc786d2906d0d439556d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix `setup --check` to report failure when symlinks point to the wrong target or when binaries exist as regular files instead of symlinks

- [#143](https://github.com/enboxorg/gitd/pull/143) [`dc22a98`](https://github.com/enboxorg/gitd/commit/dc22a98321bf2ec6adc750a6d33b380390a69d77) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Validate port number in `gitd web` command using `parsePort` instead of raw `parseInt`, rejecting invalid values with a clear error

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
