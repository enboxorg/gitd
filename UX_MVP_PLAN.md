# gitd UX MVP Plan

This plan sketches the CLI experience gitd should aim for once the repo-level
MVP is functionally solid. The goal is to make gitd feel closer to `git` and
`gh`: a few predictable commands, automatic local helper management, and
actionable recovery when local state is broken.

The core product rule: users should not need to understand profiles, lockfiles,
DWN migration state, helper daemons, Git remote helpers, credential helpers, or
default-branch repair to create, push, clone, and collaborate on a public repo.

## Current UX Problems

The recent end-to-end smoke test exposed the practical friction:

- The install flow can succeed while old wrapper/symlink state breaks Git.
- `gitd setup` is a separate mental step even though curl install should leave
  Git ready to use.
- `gitd auth login` can create the profile but leave the process hanging.
- Users are asked for a "Vault password" repeatedly without clear session
  behavior.
- `gitd serve` is both a local helper and a public Git transport server, which
  makes the common local-helper case feel like server administration.
- Background startup failures hide the actual cause behind a timeout.
- Profile selection leaks into normal commands through `GITD_PROFILE=default`.
- Fresh public clones need a local helper/cache path; the first UX slice avoids
  explicit identity setup for `gitd clone`, but true unauthenticated DWN reads
  remain open.
- Failed local SQLite migrations, stale daemon locks, and dangling bare-repo
  `HEAD` refs require manual repair commands.
- Clone warnings like "remote HEAD refers to nonexistent ref" are Git-level
  symptoms, not gitd-level guidance.

## UX Principles

- Install should produce a working `gitd` and working `git clone did::...`.
- The first command that needs identity should guide the user through identity
  setup; read-only public clone should not force identity setup if avoidable.
- The local helper should be automatic and boring. Users should not run
  `gitd serve` for ordinary local work.
- `gitd serve` should mean "publish a GitTransport endpoint", not "make local
  git operations possible".
- Every fatal error should include the failing subsystem, likely cause, and one
  direct recovery command.
- Profiles should be invisible until the user has more than one identity.
- The CLI should prefer wizards for ambiguous setup, but not for routine
  repeated operations.
- Native Git should still work. `gitd clone` is the polished path; `git clone
  did::...` remains compatible.

## Current Implementation Status

- Done: helper/session visibility, auth reset, public-read clone cache, native
  public `git clone did::...` fallback, write guards for the public-read cache,
  doctor/repair commands, profile-aware helper startup, clearer post-init
  guidance, and high-authority action summaries.
- Done: `gitd serve --public-url` now stays on the public GitTransport path,
  while bare `gitd serve` is only a compatibility alias for the local helper and
  tells users to prefer `gitd helper start`.
- Done: a fresh-author e2e smoke test now covers setup-equivalent wrapper
  installation, implicit `default` identity creation, `gitd init`, native
  `git push`, and native `git clone` without manual exports, manual setup, or
  manual helper start.
- Done: first-run write commands now launch an identity setup wizard in
  interactive terminals before connecting the Enbox agent. Non-interactive
  flows that set `GITD_PASSWORD` keep the implicit `default` identity behavior,
  and local-helper startup paths create the first identity in the foreground so
  recovery phrases are not hidden in daemon logs.
- Done: `gitd pr create` has an interactive contributor-branch publish prompt
  for remote-owner PRs; scripts can keep using `--push` or copy the printed
  refspec from non-interactive output.
- Done: fresh-reader public clone is covered against a passive remote DWN with
  a separate local home, no configured identity, no `GITD_PROFILE`, and no
  `GITD_PASSWORD`.
- Done: contributor-machine PR creation is covered against a passive remote DWN
  for `gitd pr create --push`, proving gitd can compute and publish the
  contributor ref without a manual refspec.
- Done: issue and repo role commands now have command-specific TTY prompt
  helpers for missing required input, while non-interactive calls keep explicit
  usage errors.
- Done: the interactive PR publish-confirmation branch is covered through an
  injectable confirmation helper, including accepted and declined decisions.
- Done: final verification and plan audit completed for the e2e UX MVP.

## Wallet And Dapp Parity

The Enbox wallet and Focus Boards demo suggest a useful product model for gitd:

- The wallet owns identity, unlock state, protocol setup, permission grants,
  temporary sessions, sync, and revocation.
- The dapp owns product intent: "connect", "show boards", "write task", or
  "read profile".
- The dapp requests scoped access in human terms, and the wallet translates that
  into DWN protocol setup, delegate DID creation, grants, and session metadata.
- Sessions are temporary and visible later in the wallet's permissions view.
- Protocol setup is described as housekeeping, separate from the actual access
  being granted.

For gitd CLI use, the same boundary should be:

- `gitd` CLI is the local dapp surface.
- `gitd helper` is the local capability adapter for Git transport, DWN restore,
  pack generation, cache repair, and background sync.
- The Enbox agent/wallet owns the signing identity, unlock password, DID
  documents, local DWN, remote DWN sync, protocol setup, grants, and revocation.
- The canonical repo owner DWN is the source of truth for repo records,
  protected branches, repo roles, issues, PRs, moderation events, and accepted
  checkpoints.
- Contributor DWNs can hold contributor-owned branches, forks, and out-of-band
  issue/patch submissions until accepted or indexed.
- Optional public indexers and public GitTransport endpoints improve discovery
  and fetch performance, but they should not be required to hold maintainer keys
  or run as authoritative delegates.

Concrete lessons from the current wallet and dapp repos:

- The dapp requests protocols and scopes up front, then the wallet handles DID
  selection, DWN registration, protocol installation, delegate DID creation,
  grant creation, session metadata, and revocation.
- The dapp keeps a local restored session and only asks the wallet again when
  the session is missing, stale, or has insufficient scopes.
- The wallet treats protocol setup as a preparatory step before granting
  access, not as the access itself.
- Read/write intent is expressed at the product layer. The user sees app-level
  nouns, while the SDK maps those nouns to protocol definitions and permission
  scopes.
- Delegate sessions include enough metadata for users to understand and revoke
  them later: app name, origin/transport, selected DID, grants, expiry, and
  connected delegate.

For the CLI MVP, gitd should borrow those boundaries without adding a browser
approval dependency:

- `gitd auth login` is the local wallet setup/unlock path.
- `gitd helper` is the restored dapp runtime for native Git operations.
- Helper startup should ensure forge protocols, DWN registration, sync, and
  local Git transport readiness before native Git gets involved.
- The active local profile can stand in for a delegate session while we are
  focused on local CLI use.
- Session metadata should still be recorded early, so later wallet-approved
  delegate sessions can replace the local-profile session source without
  changing repo records or Git remote behavior.

That means the common CLI should not ask the user to manage delegates directly.
It should ask for intent:

```bash
gitd auth login
gitd init demo
gitd clone did:dht:<owner>/demo
gitd pr create
gitd mod add <did>
```

Then gitd maps that intent onto scoped authority:

| User action | Authority needed | UX target |
|---|---|---|
| Clone public repo | Public read of repo, refs, branch bundles, issues, PRs | No identity ceremony if possible |
| Create repo | Own identity, repo protocol setup, refs protocol setup | First-run identity wizard if missing |
| Push protected branch | Maintainer role or owner identity | Native `git push` works; clear denial if not authorized |
| Push contributor branch | Contributor role and branch namespace owned by caller DID | Auto-publish to `users/<did-hash>/<branch>` |
| Create PR | Contributor role, patch record, revision bundle | `gitd pr create` infers base/head and pushes if needed |
| Open/comment issue | Contributor, moderator, triager, or maintainer role | Direct write only for repo-level contributors |
| Moderate | Moderator or maintainer role | Explicit `gitd mod ...` commands with audit event |
| Merge/squash protected branch | Maintainer role or owner identity | Confirm branch and strategy before writing checkpoint |
| Squash own branch | Branch owner/contributor role | Automatic helper compaction, no extra prompt |

The CLI can present permission prompts in the same style as DWeb Connect, but
with git-native nouns:

```text
gitd wants to connect as liran

It will be able to:
  - Read public repository data
  - Add or edit contributor branches for did:dht:...
  - Create pull requests on repos where this identity is a contributor

Access lasts until the helper stops.
```

For the local CLI MVP, this prompt can be collapsed into the first
`gitd auth login` wizard. For future dapps, it should be a wallet approval flow
with the same temporary/revocable session behavior the web wallet already uses.

### Helper As Local Dapp Runtime

The helper should behave like Focus Boards' restored dapp session, except it is
local and Git-facing:

- On startup, restore the Enbox session for the selected profile.
- Ensure gitd forge protocols are installed and included in sync scope.
- Register or refresh remote DWN tenant access when needed.
- Start local DWN sync for the repo protocols.
- Expose a local GitTransport endpoint only on loopback by default.
- Cache public bundle restores and repo metadata.
- Mint short-lived push credentials for native Git.
- Stop or lock when the wallet/agent session locks.

The helper should never be explained as a "server" in the normal path. It is a
local dapp runtime. `gitd publish` or `gitd serve --public-url` is the separate
advanced path for publishing a public GitTransport endpoint.

### Grant And Session Shape

Gitd can model CLI permissions as session metadata even before a full DWeb
Connect flow exists:

- Session identity: profile name, connected DID, optional delegate DID.
- Client metadata: `gitd` version, platform, shell, local repo path, Git remote.
- Scope summary: public read, contributor branch write, patch write,
  issue/comment write, maintainer write, moderation write.
- Expiry: helper lifetime for MVP; later a configurable TTL similar to the
  wallet's 24-hour dapp sessions.
- Revocation: `gitd auth sessions`, `gitd auth revoke <id>`, and wallet
  permissions UI when available.

The first CLI slice records this in the helper lockfile as a local session:
session id, profile, owner DID, repo cache path, helper capabilities, start
time, expiry policy, version, and bounded repo contexts observed through
`gitd init` and `gitd clone`. `gitd helper status` and `gitd auth sessions`
make it visible; `gitd auth revoke helper` stops the helper as the MVP
revocation mechanism. Later wallet-approved delegate sessions can replace this
local profile-backed session without changing the repo records or native Git
remote behavior.

For native CLI use, the session can be backed by the local Enbox profile instead
of a separate delegate DID. For browser or third-party dapp use, it should use
wallet-approved delegate DIDs and permission grants so a web app never holds the
maintainer's primary keys.

### Protocol Setup UX

The wallet separates "protocol setup" from "permission." Gitd should do the
same:

- `gitd auth login` prepares the forge protocols for the identity.
- `gitd init` prepares repo, refs, issues, patches, moderation, and sync scope.
- `gitd doctor` reports stale/missing protocol setup as repairable
  housekeeping.
- User-facing prompts should say "prepare repository data" or "prepare gitd
  protocols", not "grant Protocols.Configure".

This also gives a clean explanation for first-run latency: gitd is preparing
identity, protocols, DWN registration, and sync before Git starts pushing data.

### Public Repos First

The wallet/dapp model still works for public repos:

- Public repo records and branch bundles can be read by anyone.
- Public clone should use the smallest authority possible.
- If the current Enbox stack requires an agent for DWN reads, gitd should create
  an implicit local reader session without recovery-phrase ceremony.
- Write actions still require an explicit identity and role.
- Moderation/maintainer actions should always show the actor DID and target repo
  before committing the record.

### Future Web/Dapp Shape

We are not designing the web UI now, but the dapp pattern implies a reasonable
future:

- A web gitd UI can request wallet access for repo social records: issues, PRs,
  comments, labels, moderation events, repo metadata.
- Heavy Git pack operations can go through a local helper bridge on loopback,
  because browser Git pack IO and local working-tree integration are different
  from normal DWN record reads.
- A public indexer can support discovery, search, and read-heavy pages without
  holding user keys.
- A hosted public GitTransport can serve public bundles, but maintainer writes
  should still be signed at the edge by the maintainer's wallet/agent/helper.

## Target Happy Paths

### Install

```bash
curl -fsSL https://gitd.sh/install | bash
```

Expected result:

```text
Installed gitd 0.x.y
Git DID remotes configured
Run: gitd auth login
```

No manual `export PATH`, no manual credential helper command, no separate
`gitd setup` unless the user asks for repair/diagnostics.

### First Identity

```bash
gitd auth login
```

Target prompts:

```text
Name this identity [default]:
Create a password to unlock gitd:
Save this recovery phrase:
...
Identity ready
```

Implementation notes:

- Use "identity" and "unlock password" in user-facing copy; avoid "vault" unless
  the command is explicitly diagnostic.
- Exit cleanly after success.
- Store `default` as the global default when it is the first profile.
- Offer import from recovery phrase in the same wizard.

### Create And Push A Repo

```bash
mkdir demo
cd demo
gitd init demo
echo "hello" > README.md
git add README.md
git commit -m "initial commit"
git push -u origin main
```

Target behavior:

- `gitd init` creates identity first if missing.
- It creates the repo record and bare repo with `HEAD` pointed at the chosen
  default branch.
- It initializes the local Git repo when needed.
- It configures `origin`.
- It starts or wakes the local helper automatically.
- `git push` works without `GITD_PROFILE`, `gitd serve`, or manual credential
  helper setup.

Target output from `gitd init`:

```text
Created repo demo
Remote: did::did:dht:.../demo

Next:
  git add .
  git commit -m "initial commit"
  git push -u origin main
```

No public-server deployment guidance in this common local path. Put that behind
`gitd publish` or `gitd serve --public-url`.

### Clone A Public Repo

```bash
gitd clone did:dht:abc/demo
```

Target behavior:

- Works on a fresh machine after install.
- If public read can be done without a persistent identity, use a read-only
  public helper mode.
- If Enbox currently requires an agent for DWN reads, create/use an implicit
  local "reader" profile and explain only if setup fails.
- Auto-start the helper.
- If the restored repo has a dangling `HEAD`, repair it before Git sees it.
- Store `enbox.owner`, `enbox.repo`, and active profile in the cloned repo.

Target output:

```text
Cloning did:dht:abc/demo
Resolved via DWN
Restored branch main
Checked out demo
```

Native Git remains valid:

```bash
git clone did::did:dht:abc/demo
```

But `gitd clone` should be the documented path because it can diagnose and
repair more cleanly than Git's remote helper protocol allows.

### Open A PR

```bash
git switch -c feature
# edit, commit
gitd pr create "Add feature"
```

Target behavior:

- Detect current repo, owner, default branch, and local branch.
- Infer the base branch from `--base`, the repo record, local `enbox.defaultBranch`,
  remote `origin/HEAD`, or conventional local branches.
- If the current branch is not in the canonical contributor namespace, offer to
  publish it as `refs/heads/users/<did-hash>/<branch>`.
- Push the branch when requested with `--push`; later make this an interactive
  yes/no prompt in TTY sessions.
- Create the PR record.
- Print a short result with PR id and checkout command.

No required `--repo`, `--head`, or `--base` for the common case.

### Maintainer Review And Merge

```bash
gitd pr list
gitd pr checkout <id>
gitd pr merge <id>
git push origin main
```

Target behavior:

- `pr checkout` creates a local branch with a predictable name.
- `pr merge` performs the Git merge locally and records the merge result.
- Protected branch push authorization remains enforced by the helper.
- If `git push origin main` would fail because the helper is down, auto-start
  it and retry where possible.

## Command Surface Changes

### Keep

- `gitd auth login`
- `gitd auth list`
- `gitd auth use`
- `gitd init`
- `gitd clone`
- `gitd repo ...`
- `gitd issue ...`
- `gitd pr ...`
- `gitd mod ...`

### Add

```bash
gitd doctor
gitd repair
gitd helper status
gitd helper logs
gitd helper stop
gitd publish --public-url https://git.example.com
```

`gitd doctor` should be read-only and explain:

- installed version
- latest available version when known
- PATH and wrapper status
- Git credential helper status
- active identity/profile
- local helper status
- default DWN endpoint reachability
- repo context when inside a Git repo
- remote `did::` parse and resolution when origin is a DID remote

`gitd repair` should be idempotent and safe:

- rewrite command wrappers
- restore credential helper config
- remove stale daemon locks
- repair known SQLite migration-marker drift
- repair bare repo `HEAD` when a clear default branch exists
- print what it changed

### Reframe

`gitd serve` should become an advanced/public transport command:

```bash
gitd publish --public-url https://git.example.com
```

Internally this can still call the current serve implementation. The user model
should be:

- local helper: automatic background process
- public GitTransport server: explicit publish/deploy action

## Error UX

Every error should follow this shape:

```text
gitd: could not start local helper
Reason: DWN SQLite migration state is inconsistent: squash column already exists

Try:
  gitd repair

Details:
  /home/liran/.enbox/profiles/default/gitd/daemon.log
```

Specific known cases:

| Symptom | Better message | Recovery |
|---|---|---|
| `duplicate column name: squash` | Local DWN store migration marker is out of sync | `gitd repair` |
| `remote HEAD refers to nonexistent ref` | Restored repo has no default branch HEAD | auto-repair before clone; otherwise `gitd repair` |
| daemon timeout | Helper did not become healthy; show last log lines | `gitd helper logs`, `gitd repair` |
| wrong password | Could not unlock identity; offer reset/import | `gitd auth reset default` |
| missing helper binary | Install wrappers are broken | `gitd repair` |
| no profile | No identity configured | launch `auth login` wizard |

## Profile UX

Profiles are necessary but should not dominate the default path.

Rules:

- First identity is `default`.
- Commands use the repo's configured `enbox.profile` when inside a repo.
- Otherwise commands use global default profile.
- `GITD_PROFILE` remains a power-user override.
- If multiple profiles exist and the command is ambiguous, prompt once and then
  store the choice where appropriate.

Target commands:

```bash
gitd auth login              # create/import identity
gitd auth switch work        # set global default
gitd auth use work           # set current repo profile
gitd auth reset default      # archive local profile state, keep backup
```

## Helper Lifecycle

The helper should behave like an implementation detail:

- Auto-start when `gitd init`, `gitd clone`, `git push`, `git fetch`, or a repo
  command needs it.
- Health checks should wait long enough for first-run Enbox startup.
- Startup should expose progress in foreground/wizard flows:
  - unlocking identity
  - opening local DWN
  - syncing protocols
  - starting Git transport
- Background startup timeout should include the last 20 log lines.
- Helper lockfiles must be profile-scoped and version-aware.
- Old helpers should restart automatically after upgrade.

Implementation cut:

- Rename user-facing lifecycle commands to `gitd helper ...`.
- Keep `gitd serve ...` as an alias for now.
- Increase or make adaptive the first-run daemon startup timeout.
- Add structured helper startup events to the daemon log.

## Install UX

Installer responsibilities:

- install Bun if missing
- install/update `@enbox/gitd`
- write command wrappers without following symlinks
- put `~/.gitd/bin` on PATH for common shells
- run `gitd setup` or equivalent internal setup automatically
- verify:
  - `gitd --version`
  - `git-remote-did` wrapper
  - credential helper
  - `git config --global credential.helper`

Installer final output should include only next action, not test/debug exports.

```text
gitd 0.x.y installed
Git DID remotes configured

Next:
  gitd auth login
```

## Repo Creation UX

`gitd init <name>` should handle:

- missing identity
- local git repo initialization
- default branch
- remote setup
- local helper startup
- bare repo default `HEAD`
- clear next steps

Avoid printing deployment guidance unless the user passes `--publish`,
`--public-url`, or asks for `gitd publish`.

Potential wizard when run outside a Git repo with no obvious intent:

```text
Create repo demo?
  Local path: /home/me/demo
  Visibility: public
  Default branch: main
  Remote: origin
```

But the default non-interactive path should remain:

```bash
gitd init demo
```

## Public Clone Without Identity

This is the biggest UX opportunity.

Current behavior needs a helper backed by an Enbox profile because clone/fetch
uses local DWN APIs and local git cache restore. For public repos, target one
of these:

1. True unauthenticated read path:
   - resolve DID
   - read published DWN records directly
   - restore to a temp/local cache
   - no vault prompt

2. Implicit reader identity:
   - create a local read-only profile automatically
   - no recovery phrase ceremony until the user wants to push, open PRs, or
     create issues

Option 1 is cleaner if Enbox APIs support it. Option 2 is acceptable for an
MVP if the prompt is avoided.

Implemented first slice: `gitd clone did:dht:<owner>/<repo>` creates or reuses
a hidden `public-reader` profile only when no explicit, repo, environment, or
default identity is selected. The generated unlock secret is stored outside the
normal identity list under `~/.enbox/public-reader.json`, passed only to the
Git helper process, and the cloned repo records `enbox.profile=public-reader`
so later `git fetch` can wake the same local helper without a password prompt.
Native `git clone did::did:dht:<owner>/<repo>` now also uses the hidden
public-reader helper for public DWN-backed repos when no normal identity is
selected, but it cannot write repo context into `.git/config`; `gitd clone`
remains the polished first-clone path.
Write operations are blocked with a clear recovery path: `gitd auth login`,
then `gitd auth use <identity>` inside the cloned repo.

Covered by `tests/e2e-passive-dwn-sync.spec.ts` for the remote-DWN reader
variant: Alice publishes public repo metadata and branch bundles through a
passive DWN endpoint; a separate fresh reader home with no configured identity
clones with `gitd clone`, uses the hidden public-read cache, and checks out the
repo without a recovery phrase or unlock-password ceremony.

## E2E MVP Line

The end-to-end CLI MVP should not require the full browser DWeb Connect flow.
The useful wallet/dapp ideas to adopt now are the boundaries and language:

- Treat the CLI as the dapp asking for intent.
- Treat the helper as a local runtime, not as a public service.
- Let the Enbox agent own identity, protocol setup, sync, and signing.
- Show user-facing permission summaries for surprising or high-authority
  actions.
- Keep sessions revocable and inspectable, even if the first implementation is
  "active while the helper is unlocked."

Do not block the CLI MVP on:

- QR/popup wallet approval.
- Browser-to-helper bridges.
- Hosted public indexers.
- Hosted public GitTransport.
- Delegating maintainer authority to a remote service.

For the MVP, a successful local session can be the active Enbox profile unlocked
by `gitd auth login` or the first command that needs write authority. A future
browser/dapp can swap that session source for wallet-approved delegate grants
without changing the repo, refs, issues, patches, or moderation records.

## Suggested Implementation Phases

### Phase 1: Repair And Diagnostics

- Add `gitd doctor`.
- Add `gitd repair`.
- Add structured helper startup failures with last log lines.
- Move current manual recovery knowledge into code:
  - wrapper repair
  - stale lock cleanup
  - SQLite migration-marker repair
  - bare HEAD repair

This phase turns support conversations into executable checks.

### Phase 2: Automatic Local Helper

- Make `gitd init`, `gitd clone`, `gitd pr`, `gitd issue`, and `gitd repo`
  consistently auto-start the helper.
- Make native `git clone did::...` and `git push` work without exported
  profile vars by relying on repo/global profile config.
- Rename lifecycle UX to `gitd helper`.
- Keep extending helper session metadata from the MVP lockfile shape toward
  explicit grant-backed scopes when wallet-approved delegates are introduced.
- Keep `gitd serve` for public transport and backwards compatibility.

### Phase 3: First-Run Wizards

- Polish `gitd auth login`.
- Add missing-identity prompts to commands that need identity. Implemented
  slice: interactive first-run write commands and local-helper startup paths
  show an identity setup wizard; scripted `GITD_PASSWORD` flows remain
  non-interactive.
- Add command-specific wizards for common missing issue/repo input. Implemented:
  `gitd issue create`, `issue show`, `issue comment`, `issue close`,
  `issue reopen`, and repo role add/remove commands can prompt in TTY sessions;
  scripts still receive usage errors.
- Add human-readable permission summaries for contributor branch writes,
  maintainer branch writes, and moderation actions. Implemented slices:
  `gitd pr merge` prints actor DID, repo, base/head, strategy, and commit count
  before mutating the local branch and writing merge records; repo role changes
  and moderation events print actor, target repo, target DID/record, and reason
  before writing role or audit records.
- Add `gitd auth reset`. Implemented: resets remove the identity from config,
  stop its helper, and archive the local profile directory under
  `~/.enbox/profile-backups`.
- Add `gitd init` and `gitd clone` success summaries.

### Phase 4: Public Read Mode

- Make public clone/fetch possible without explicit identity setup.
  Implemented first slices for `gitd clone` and native `git clone did::...`:
  hidden local `public-reader` profile/cache when no normal identity exists.
- Block write commands from the hidden reader with an `auth login`/`auth use`
  recovery message instead of prompting for an implementation-detail password.
- Cache restored public repos under a deterministic helper cache.
- Keep write operations gated by identity setup.

### Phase 5: GH-Like Collaboration

- Make `gitd pr create` infer branch/base, compute contributor namespace, and
  publish it with `--push`. Implemented slices: base/head inference,
  contributor namespace calculation, explicit `--push`, and an interactive
  publish prompt for TTY sessions; non-interactive runs still print the exact
  `git push` refspec. Covered by passive-DWN E2E for `gitd pr create --push`
  from a contributor clone without a manual branch refspec, and by unit tests
  for accepted/declined interactive publish confirmations.
- Make `gitd pr checkout` and `gitd pr merge` require minimal arguments.
- Add concise list/show formatting for issues, PRs, moderators, and roles.

### Later: Wallet/Dapp Bridge

- Design a DWeb Connect request shape for gitd repo records and contributor
  branch writes.
- Decide whether web git pack operations need a local helper bridge or a
  read-only public GitTransport.
- Add wallet permission display names for gitd protocols and scopes.
- Add session/revocation UI in the wallet for gitd helper and web dapp sessions.

## Acceptance Scenarios

### Fresh Author Machine

```bash
curl -fsSL https://gitd.sh/install | bash
gitd auth login
mkdir demo && cd demo
gitd init demo
echo hello > README.md
git add README.md
git commit -m "initial commit"
git push -u origin main
```

Passes if no exports, manual setup, manual helper start, or repair commands are
needed.

Covered by `tests/e2e-ux-mvp.spec.ts` for the local author-machine variant:
setup-equivalent wrapper installation, implicit first identity, init, push, and
clone all run through the native Git helper path without exported profile or
password during Git operations.

### Fresh Reader Machine

```bash
curl -fsSL https://gitd.sh/install | bash
gitd clone did:dht:<owner>/demo
cat demo/README.md
```

Passes if public clone works without identity ceremony.

Covered by `tests/e2e-passive-dwn-sync.spec.ts` against a passive remote DWN,
using a separate reader home and no `GITD_PROFILE` or `GITD_PASSWORD`.

### Fresh Contributor Machine

```bash
curl -fsSL https://gitd.sh/install | bash
gitd auth login
gitd clone did:dht:<owner>/demo
cd demo
git switch -c feature
git commit --allow-empty -m "feature"
gitd pr create "Feature"
```

Passes if gitd pushes the right contributor branch and creates the PR without
manual refspecs.

Covered by `tests/e2e-passive-dwn-sync.spec.ts` for the passive remote-DWN
contributor workflow with `gitd pr create --push`, and by
`tests/pr-helpers.spec.ts` for the interactive publish prompt decisions.

### Broken Local State

```bash
gitd doctor
gitd repair
gitd doctor
```

Passes if known broken install/profile/helper states are diagnosed and repaired
without manual file surgery.

Covered by `tests/doctor.spec.ts`, `tests/repair.spec.ts`,
`tests/dwn-sqlite.spec.ts`, and daemon lifecycle coverage in the full suite.

## Open Questions

- Can Enbox expose a clean unauthenticated public-read DWN path, or do we need
  to keep the implicit reader profile beyond the CLI MVP?
- Should OS keychain integration be in the MVP, or is one password prompt per
  helper session acceptable?
- Should the local CLI use the primary profile directly for MVP writes, or
  should it create a same-device delegate session from the start?
- Should `gitd publish` replace most `gitd serve --public-url` docs now, or
  after local helper UX is stable?
- Should install automatically run identity setup when launched in an
  interactive shell, or should it stop at "Run `gitd auth login`"?
- What is the exact repo URL we want users to share: `did:dht:.../repo`,
  `did::did:dht:.../repo`, or a future `gitd.id/<did>/<repo>` resolver?
