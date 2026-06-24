# gitd Repo-Level MVP Plan

This plan narrows `gitd` to the repo-level forge features needed for a project
to start using it in place of GitHub. It intentionally excludes CI, package
registry work, broad GitHub API compatibility, private repositories, and
organization/team permissions. Those can build on this once the repo-level
model is stable.

## Goals

- Let a public project host source, branches, tags, issues, and pull requests
  through Enbox/DWN protocols.
- Keep project authority at the edges. Maintainers and contributors act through
  their own Enbox agent or wallet. No remote live service should need to hold
  project delegate keys.
- Support a canonical repo workflow. Contributors can push to the canonical
  repository, while maintainers control protected/default branch changes and
  merge decisions.
- Add first-class repo-level moderation with explicit moderator assignment and
  revocation.
- Keep public indexers optional and non-authoritative. They may help discovery,
  but repo correctness and permissions must not depend on one.

## Non-Goals

- CI execution, Actions compatibility, check suites beyond future merge-status
  placeholders.
- GitHub REST API breadth. The shim should only expose the endpoints needed by
  the repo-level flows until the core model is stable.
- Private repositories and encrypted read-access management.
- Organization and team permission inheritance.
- Detailed indexer design. This plan only records the contract the core should
  leave available for later discovery work.

## Product Decisions

- Add `moderator` as a new repo role instead of overloading `triager`.
- Contributors may push to the canonical repo.
- Outside parties cannot write issues or pull requests directly to the repo
  owner's DWN in v1. They create records on their own fork/DWN and share them
  out of band.
- Optional third-party public indexers are acceptable, but they must not carry
  repository authority or delegate keys.
- Clone and fetch should work through a standard DWN server. The local app,
  CLI, or browser delegate can materialize git data from DWN records.
- Browser dapps must sign through the standard Enbox agent or wallet.
- The E2E MVP is CLI/local-helper first. Web and browser dapps are deferred,
  except that the protocol should not block a future helper-backed web surface.
- `gitd serve` is the local helper service. It owns local git caches, talks to
  the local Enbox agent, and syncs/sends records through local and remote DWNs
  using the same Enbox pattern as the demo dapp.
- One-shot CLI commands such as `gitd repo`, `gitd issue`, `gitd pr`, and
  `gitd mod` reuse a running same-profile local helper through a local-only
  helper RPC. This keeps the helper as the single owner of the profile's agent
  stores during normal CLI use. `GITD_CLI_RPC=off` disables this forwarding for
  debugging.
- For the CLI MVP, clone/fetch for a non-local owner DID can route through the
  local helper and read that owner's standard DWN records. Contributor push
  policy is enforced from Git receive-pack commands: contributors may update
  only their own `refs/heads/users/<did-hash>/...` branches, while protected
  refs and global tags remain maintainer/owner authority. Remote-owner
  contributor pushes through the local helper write signed `repo/branch`,
  `repo/branch/state`, and `repo/branch/bundle` records directly to the owner
  DWN.
- DWN `$squash` is used for authoritative checkpoints over deterministic state
  streams. When old deltas should be purged, the deltas and checkpoint must be
  sibling records on the same `$squash` protocol path and parent context.
  `$squash` is not the conflict-resolution algorithm; helpers must still
  validate roles, branch rules, ancestry, and moderation state before accepting
  an operation into the canonical view.
- In this plan, "squash" means DWN `$squash` checkpoint compaction unless
  explicitly called "Git squash merge."
- Branch checkpoint authority follows branch ownership. Contributors can
  `$squash` checkpoints and bundle history for branches they created in their
  contributor namespace; only maintainers and owners can `$squash` protected or
  default branch checkpoints.
- Public repos only for this phase.
- Moderation v1 includes block DID, lock issue/PR, hide comment, delete comment,
  report queue, and interaction limits.
- Record IDs are acceptable for issue and PR identifiers for now.
- Repo-level permissions ship first; org/team permissions follow later.

## E2E MVP Acceptance Path

The MVP is end-to-end only when this full public repo flow works without a
hosted authority service holding project keys:

1. Alice creates a public repo on her DID and pushes an initial default branch.
2. Alice adds Bob as a contributor and Casey as a moderator.
3. Alice, Bob, and Casey run local `gitd serve` helpers backed by their Enbox
   agents. The helpers keep local DWNs in sync with configured remote DWN
   endpoints.
4. Bob clones/fetches the repo through a standard DWN server using
   `git clone did::<alice-did>/<repo>`.
5. Bob pushes a non-protected canonical feature branch in his contributor
   namespace, such as `refs/heads/users/<bob-did-hash>/feature`.
6. Bob opens a canonical PR from that branch.
7. Casey moderates the PR or issue discussion without being able to push or
   merge code.
8. Alice reviews, merges locally at the edge, and pushes the protected/default
   branch update.
9. Bob fetches again through DWN and sees the merged result.

Outside submissions, public indexers, private repos, org/team permissions, and
CI are not required for this acceptance path.

## E2E MVP Contract

The MVP is a single public repo collaboration loop. It is complete only when a
fresh test can create three identities, run the command flow below, and prove
the canonical repo state is reconstructed from DWN records without a hosted
authority service.

### Required Actors

| Actor | Role | Runs |
|---|---|---|
| Alice | Owner/maintainer | local Enbox agent, local DWN, `gitd serve` helper |
| Bob | Contributor | local Enbox agent, local DWN, `gitd serve` helper |
| Casey | Moderator | local Enbox agent, local DWN, `gitd serve` helper |
| Remote DWN endpoint | Passive sync/storage | no git server, no maintainer keys, no project delegate keys |

### Target Command Flow

These commands define the E2E UX target. Exact flags can move during
implementation, but the observable flow should stay this small.

```bash
# Alice
GITD_PROFILE=alice gitd init demo --public
GITD_PROFILE=alice gitd serve
GITD_PROFILE=alice gitd repo add-contributor <bob-did> --repo demo
GITD_PROFILE=alice gitd repo add-moderator <casey-did> --repo demo

# Bob
GITD_PROFILE=bob gitd serve
GITD_PROFILE=bob git clone did::<alice-did>/demo
cd demo
git checkout -b users/<bob-did-hash>/feature
git commit --allow-empty -m "feature"
git push origin HEAD:refs/heads/users/<bob-did-hash>/feature
GITD_PROFILE=bob gitd pr create "Feature" \
  --repo demo \
  --base main \
  --head refs/heads/users/<bob-did-hash>/feature

# Casey
GITD_PROFILE=casey gitd serve
GITD_PROFILE=casey gitd pr comment <pr-id> "needs cleanup" --repo demo
GITD_PROFILE=casey gitd mod hide-comment <comment-id> --reason spam --repo demo
GITD_PROFILE=casey gitd mod lock pr <pr-id> --reason heated --repo demo
GITD_PROFILE=casey gitd mod unlock pr <pr-id> --repo demo

# Alice
GITD_PROFILE=alice gitd pr checkout <pr-id> --repo demo
GITD_PROFILE=alice gitd pr merge <pr-id> --repo demo
GITD_PROFILE=alice git push origin main

# Bob verifies convergence through DWN-backed fetch
GITD_PROFILE=bob git fetch origin main
git merge-base --is-ancestor <feature-commit> origin/main
```

### Minimum Feature Set

| Area | MVP Requirement |
|---|---|
| Identity/session | Named local profiles can create distinct DIDs and run helpers with sync enabled. |
| Repo creation | Alice creates a public repo record, default branch metadata, and initial branch state. |
| Roles | Owner can add/remove contributor and moderator role records. `triager` is not user-facing. |
| Clone/fetch | Bob clones and fetches through `did::` using a local helper that reads DWN records. |
| Push | Bob pushes only to `refs/heads/users/<bob-did-hash>/*`; protected/default branch pushes are rejected. |
| Branch state | Contributor branch state uses branch-scoped `$squash`; protected/default branch state uses maintainer-owned `$squash`. |
| PRs | Bob opens a canonical PR from his canonical contributor branch; Alice can checkout and merge it. |
| Issues/comments | Contributors, moderators, maintainers, and owners can create canonical issue/PR comments. |
| Moderation | Casey can hide/tombstone comments, lock/unlock PRs/issues, block/unblock DIDs, and review reports. |
| Authorization | Casey cannot push/merge; Bob cannot update or squash protected/default branch state; blocked users cannot continue canonical writes. |
| Convergence | A helper with an empty git cache can reconstruct current branch heads and objects from DWN records. |
| No hosted authority | The remote endpoint never signs as Alice, Bob, Casey, or a project delegate. |

### Minimum Record Shape

The final protocol names can follow the existing `repo`, `refs`, `issues`, and
`patches` modules, but the E2E slice needs these logical records:

| Logical Record | Purpose | Write Authority |
|---|---|---|
| `repo` | public repo metadata, default branch, visibility | owner |
| `repo/contributor` | contributor role grant | owner |
| `repo/moderator` | moderator role grant | owner |
| `branch` | branch context with `refName`, `ownerDid`, `kind` | contributor for own namespace, maintainer for protected/default |
| `branch/state` | `$squash` stream containing `refUpdate` deltas and `checkpoint` records | branch owner for contributor branches, maintainer/owner for protected/default |
| `branch/bundle` | `$squash` stream containing incremental/full git bundles for that branch | branch owner for contributor branches, maintainer/owner for protected/default |
| `repo/bundle` | optional full repo clone acceleration checkpoint | maintainer/owner |
| `patch` | canonical PR metadata | contributor, maintainer, owner |
| `patch/revision` | PR revision metadata pointing at branch state/bundle records | PR author, maintainer, owner |
| `issue` | canonical issue metadata | contributor, moderator, maintainer, owner |
| `comment` | issue/PR comments | contributor, moderator, maintainer, owner unless locked/blocked |
| `moderationEvent` | lock, hide, tombstone, block, report resolution | moderator, maintainer, owner |
| `viewSnapshot` | `$squash` snapshot for issue/PR/mod queues | moderator, maintainer, owner |

### Verification Gates

The E2E MVP should not be called done until these checks pass:

1. `bun run build`
2. Unit tests for role authorization, branch namespace validation, branch-state
   reducer convergence, `$squash` authority, blocked DID enforcement, and
   moderation tombstones.
3. Integration tests for local helper clone/fetch/push using DWN records as the
   source of truth.
4. A new E2E test, for example `tests/e2e-public-repo-mvp.spec.ts`, that runs
   the Alice/Bob/Casey flow with isolated profiles and empty-cache restore.
5. A negative E2E path proving Bob cannot push or `$squash` `main`, and Casey
   cannot push or merge.

### Current Tree Status

These are the concrete implementation facts and remaining gaps visible in the
current tree:

- `triager` remains as compatibility surface in some code paths; MVP user-facing
  paths should keep moving to `moderator`.
- `src/refs.ts` now exposes branch-scoped `repo/branch/state` and
  `repo/branch/bundle` records with `$squash`, and `src/branch-state.ts`
  contains the pure reducer/validation helpers.
- `src/git-server/ref-sync.ts` still maintains legacy `repo/ref` mirror records
  for compatibility, and now also writes squashed `repo/branch/state`
  checkpoints after push. It still does not emit fine-grained CRDT deltas from
  individual push packet commands.
- `src/git-server/bundle-sync.ts` still writes restore-compatible repo bundles,
  and now also writes squashed branch checkpoint bundles to
  `repo/branch/bundle` when the refs protocol handle is available. It still
  does not emit per-branch incremental bundles, but
  `src/git-server/bundle-restore.ts` now replays the newest branch-scoped
  checkpoint bundle for each branch when a refs protocol handle is available.
- `src/git-remote/resolve.ts`, `src/cli/commands/serve.ts`, and
  `src/git-server/bundle-restore.ts` now support DWN-only clone/fetch through a
  local `LocalDwnHelper` that reads a remote owner's standard DWN repo and
  bundle records. `gitd serve` advertises that DWN-helper capability in the
  daemon lockfile, and `git-remote-did` can fall back to the advertised local
  helper when DID resolution does not produce a public `GitTransport` endpoint.
- Daemon discovery is now profile-scoped when `GITD_PROFILE` or an explicit
  lifecycle profile is active. Alice, Bob, and Casey helpers can run as
  separate foreground processes in one `ENBOX_HOME` without overwriting a
  single global lockfile.
- Normal one-shot agent commands now forward to an already-running same-profile
  helper over a local-only `/cli` endpoint before opening their own agent
  connection. `tests/e2e-profile-helpers.spec.ts` covers `gitd repo info` while
  Alice's helper is running, preventing the previous `Database is not open`
  failure mode.
- `src/profiles/config.ts` now accepts `GITD_PROFILE` as the documented profile
  selector, with `ENBOX_PROFILE` retained as a compatibility alias.
- `connectAgent` still uses AuthManager for vault/session/protocol bootstrap,
  and now supports `GITD_DWN_ENDPOINT`, comma-separated
  `GITD_DWN_ENDPOINTS`, and `GITD_DWN_REGISTRATION=off` for deterministic
  local-only tests or edge setups that do not want to contact the hosted DWN
  registration service. When sync is enabled, gitd registers its forge
  protocols with the Enbox sync engine and triggers an initial best-effort
  push after broadening the scope so existing repo records are not missed by
  AuthManager's earlier identity-recovery sync pass. `GITD_DID_REPUBLISH=off`
  disables background DID DHT republishing for the same deterministic test
  path.
- `gitd init` now publishes public repo records (`published: true`) while
  keeping private repo records unpublished, so public repos are visible to
  unsigned standard-DWN reads from passive endpoints.
- `src/git-server/push-updates.ts` parses Git receive-pack ref commands, and
  `src/git-server/push-authorizer.ts` now enforces contributor branch namespace
  rules and latest `block` moderation events for POST pushes while allowing
  role-based receive-pack ref discovery.
- `src/git-server/remote-branch-sync.ts` now writes Bob-signed contributor
  branch, branch ref-update state, squashed branch checkpoint state, and
  branch bundle records to the owner DWN after a remote-owner push accepted by
  Bob's local helper.
- `src/repo.ts` now includes immutable `repo/moderationEvent` records plus
  `$squash` `repo/viewSnapshot` checkpoint records for reduced issue, PR,
  moderation, and report views. `src/cli/commands/mod.ts` writes
  block/unblock, lock/unlock, hide/unhide/delete comment, report resolution,
  and interaction-limit events.
  Block events are enforced by push authorization and by CLI issue/PR write
  paths. CLI issue/PR reads consume lock and comment visibility events when
  rendering discussion views, and CLI issue/PR comment writes reject locked
  discussions.
- `src/cli/commands/issue.ts` and `src/cli/commands/pr.ts` now target the
  canonical owner repo context for remote repos, create contributor/moderator/
  maintainer records with `store: false`, and send those signed records to the
  owner's DID. Reads query the canonical owner DWN with `from`.
- Existing E2E tests cover transport/bundle pieces and the Alice/Bob/Casey role
  path, including Bob's contributor-namespace push and Bob/Casey negative push
  cases, plus Bob's local-helper push writing signed contributor branch records
  and a squashed checkpoint to Alice's DWN. The collaboration E2E now also
  starts a fresh Bob helper cache after Alice's merge and proves it can restore
  `main` plus Bob's contributor branch from Alice's DWN records, then runs a
  real `git clone did::...` child process through `git-remote-did` into that
  empty-cache local DWN helper.
- `tests/e2e-collaboration.spec.ts` now extends the Alice/Bob/Casey path
  through canonical CLI issue and PR records sent from Bob to Alice's DWN,
  including PR revision and bundle records, and Casey's CLI moderation events
  locking the PR and hiding a review note. `tests/cli.spec.ts` covers the
  remote-owner issue/PR command behavior and CLI moderation lock/hide/block
  reducers.
- `tests/e2e-profile-helpers.spec.ts` now bootstraps Alice, Bob, and Casey
  profiles through the real `connectAgent`/AuthManager path in child processes,
  then starts three real `gitd serve --foreground --no-sync` helper processes
  concurrently and verifies profile-scoped lockfiles plus `/health` for each.
- `tests/helpers/passive-dwn-server.ts` provides a test-only passive standard
  DWN HTTP endpoint backed by SQLite stores. It implements `/info`,
  `dwn.processMessage`, streamed record reads via the `dwn-response` header,
  and `dwn.applyReplicatedMessage`, with a seedable DID resolver for
  unpublished local profile DIDs.
- `tests/passive-dwn-server.spec.ts` proves that passive endpoint contract with
  direct `HttpDwnRpcClient` writes, streamed reads, and replicated apply.
  `tests/e2e-passive-dwn-sync.spec.ts` starts a real Alice profile, runs
  `gitd init`, starts a spawned `gitd serve --foreground --sync 1s`, and proves
  Alice's public repo metadata is replicated into the passive DWN with no
  hosted authority or project delegate key.
- `tests/e2e-passive-dwn-sync.spec.ts` now runs the combined spawned
  Alice/Bob/Casey profile slice against a passive standard DWN. Alice creates
  the public repo and role grants, Bob clones through his local helper, Bob
  pushes a contributor branch to Alice's canonical repo through passive-DWN
  records, Bob opens a canonical PR, Casey writes moderation events, Alice
  checks out and merges the PR, and a fresh Bob helper with an empty cache
  clones the merged repo through `git-remote-did` and DWN bundle restore. This
  closes the previous passive-DWN E2E hardening gap for the public repo loop.
- The remaining repo-level gaps are outside the CLI/public-repo MVP slice:
  optional public indexer discovery, private repos and encrypted read access,
  organization/team inheritance, detailed CI/check-suite behavior, and
  browser/dapp helper integration.
- The combined E2E exposed and fixed three CLI-helper requirements: `/auth/token`
  resolves the connected session DID directly instead of depending on
  `identity.list()`, owner-side post-push sync explicitly flushes the local DWN
  to registered remotes, and public repo bundle/ref/branch checkpoint records
  are marked `published` so passive endpoints and optional indexers can read
  them without a hosted git server.

## E2E MVP Decisions

These decisions should be treated as settled for the CLI E2E MVP:

1. **DWN-native git remote shape.** `git-remote-did` should resolve DID remotes
   to the local helper. The helper may expose local smart HTTP to Git, but its
   source of truth is DWN repo, ref state, event, checkpoint, and bundle records.
   A remote `GitTransport` service is optional compatibility, not required.

2. **Contributor branch namespace.** Contributor pushes go under
   `refs/heads/users/<did-hash>/<branch>`. Top-level branches are shared or
   protected space and require maintainer authority unless the repo settings
   explicitly allow otherwise later.

3. **Tags.** Global tags are maintainer-only in the E2E MVP. Contributor tags
   can be added later as a namespaced feature if needed.

4. **Protected ref enforcement.** Contributors never write the authoritative
   protected/default ref checkpoint path. They can write contributor branch
   state records; maintainers write protected ref state records and checkpoints.
   Reducers must ignore any state record whose path, actor role, or ref
   namespace does not match the branch rules.

5. **Bundle and checkpoint authority.** Contributor pushes write branch-scoped
   bundle records for the branch they are allowed to update. Contributors can
   compact their own branch history with `$squash`. Maintainers and owners can
   write protected/default branch checkpoints, full repo bundle checkpoints, and
   repo-wide bundle compaction.

6. **Push conflict semantics.** Every ref operation includes `oldTarget` and
   `newTarget`. A helper rejects locally when `oldTarget` does not match the
   reduced branch head. If racing edge writes arrive through DWN, the reducer
   accepts the valid fast-forward chain and marks conflicting state records as
   stale, requiring a rebase or force-push permission.

7. **Moderator powers.** Moderators can lock/unlock discussions, hide/unhide or
   tombstone comments, resolve/dismiss reports, block/unblock DIDs, and apply
   interaction limits. They cannot push, merge, update protected refs, assign
   roles, edit repo settings, edit labels, assign users, or close/reopen PRs for
   project-management reasons in the MVP.

8. **Delete vs. tombstone.** Normal comment deletion is a moderation tombstone
   in canonical views. Hard deletion remains owner-only emergency behavior and
   should still leave a moderation audit record where possible.

9. **Block enforcement.** Blocking a DID creates an authoritative moderation
   overlay that prevents canonical pushes and issue/PR writes even if role
   grant records remain. When the repo owner issues the block locally, gitd
   also deletes matching contributor or moderator role records. Moderators can
   block interaction, but they do not gain role-management authority.
   Unblocking does not restore deleted roles automatically.

10. **Report records.** Canonical report records are limited to contributors,
    moderators, maintainers, and owners. Outside reports stay actor-owned and
    out-of-band until the indexer/external-submission effort.

11. **Role assignment authority.** Owner-only role assignment for the E2E MVP.
    Maintainer-managed collaborators can be a later repo setting.

12. **User surface.** CLI and local helper only. Web/dapp is a later effort and
    may need a helper bridge, but it should not shape the E2E MVP.

## Permission Model

The repo protocol should expose these repo-scoped roles:

| Role | Scope |
|---|---|
| Owner | Implicit DID tenant authority. Can change repo settings, assign roles, and delete the repo. |
| Maintainer | Can push, merge, manage protected/default branches, manage releases, manage repo settings that are not owner-only, and assign non-owner roles if allowed. |
| Moderator | Can moderate issues, pull requests, comments, reports, locks, blocks, and interaction limits. Cannot push code or merge. |
| Contributor | Can push branches to the canonical repo, create canonical issues/PRs, comment, review, and update their own records. Cannot merge or moderate others. |
| Viewer | Read-only role, mostly future-facing until private repos are added. Public repos are readable without a role. |

`triager` should either be replaced by `moderator` or treated as a deprecated
compatibility alias during migration. The user-facing CLI should use
`moderator`.

Push policy needs one additional split:

- Contributors can push non-protected branches in their contributor namespace,
  subject to repo rules.
- Global tags are maintainer-only in the MVP.
- Maintainers can update protected/default branches and perform merges.
- The owner can always recover or override.

## Core Protocol Work

### Repo

- Add `repo/moderator` as a `$role: true` path.
- Keep `repo/maintainer`, `repo/contributor`, and `repo/viewer`.
- Replace user-facing `triager` language with `moderator`.
- Add owner-controlled moderation settings:
  - interaction limit mode
  - maximum open external submissions to surface later
  - lock defaults
- Keep `submissionDecision`, but keep it minimal. Decisions can record ignored
  outside submissions that were discovered out of band or by an optional
  indexer.

### Refs and Branches

- Represent branch movement as immutable state records plus checkpoint records,
  not only mutable ref records.
- Add a branch ownership context:
  - contributor branch records are authored by the contributor and must map to
    `refs/heads/users/<did-hash>/<branch>`
  - protected/default branch records are maintainer/owner authority
  - reducers ignore branch records whose author, role, or ref namespace does not
    match repo rules
- Make ref state writes reflect the push policy:
  - contributors write ref-update deltas and `$squash` checkpoints for branches
    they own in their contributor namespace
  - maintainers write ref-update deltas and `$squash` checkpoints for
    protected/default branches
  - maintainers and owners can write repo-wide ref snapshots
- Add minimal branch protection configuration for v1:
  - protected ref patterns
  - maintainers-only direct update
  - allow/disallow force push
  - allow/disallow delete

### Issues

- Canonical issue records are created by contributors, moderators, maintainers,
  and owners.
- Public outside reports are not written to the repo owner's DWN in v1.
- Issue moderation records should support:
  - lock and unlock
  - hide and unhide comment
  - delete comment
  - report content
  - resolve or dismiss report
  - block DID from repo interaction
  - interaction-limit changes
- Preserve immutable audit records for moderation actions.

### Pull Requests

- Canonical PR records are created by contributors, maintainers, and owners.
- PR revisions continue to use immutable records and git bundle attachments.
- Moderators can moderate PR discussion and reports, but cannot merge.
- Maintainers can merge and close/reopen PRs.
- Contributors can update their own PRs and push canonical feature branches.

### Git Object Transport

The desired shape is DWN-native clone/fetch with local materialization:

1. A standard DWN server stores repo metadata, refs, and git bundles.
2. `git-remote-did` resolves the target DID and repo.
3. A local delegate reads the repo's DWN records, restores or updates a local
   bare cache from bundles, and serves git's expected remote-helper behavior.
4. Pushes are signed by the contributor's Enbox identity and authorized by repo
   roles/rules.
5. Post-push ref and bundle writes are authored by the pushing edge delegate,
   not by a remote service holding maintainer keys.

The existing smart HTTP sidecar can remain as an optimization or compatibility
adapter, but it should not be the only path for clone/fetch and it should not
require a hosted service with project authority.

## Local Helper, Operation Logs, and `$squash`

For CLI/local use, `gitd serve` should be the edge helper that bridges Git,
Enbox, and DWN:

- It runs against the user's local Enbox agent and local DWN store.
- It syncs to configured remote DWN endpoints, similar to the demo dapp's
  local-vault plus remote-DWN sync pattern.
- It maintains local bare git caches materialized from DWN bundle/checkpoint
  records.
- It exposes local interfaces for `git-remote-did`, CLI issue/PR commands, and
  future helper-backed web surfaces.
- It never needs a remote hosted process with maintainer or project keys.

The canonical repo state should be reducible from records:

- Immutable state/event records describe actions: branch updates, issue edits,
  PR revisions, comments, moderation actions, reports, and role changes.
- Checkpoint records store a reduced view after a known state/event frontier.
- `$squash` purges older sibling records at the same protocol path and parent
  context. If a checkpoint must compact old deltas, the deltas and checkpoint
  must share that path and be distinguished by a `kind` field.
- Every helper should be able to query the latest checkpoint, replay newer
  state/event records, validate actor authority, and arrive at the same
  canonical view.

Ref movement should be modeled as branch-scoped state streams:

- `branch` establishes a branch context with `refName`, `ownerDid`, and branch
  kind such as `contributor` or `protected`.
- `branch/state` is `$squash`-enabled. It contains immutable records with
  `kind: "refUpdate"` or `kind: "checkpoint"`.
- `refUpdate` records include `refName`, `oldTarget`, `newTarget`, `actorDid`,
  `bundleRecordId`, `createdAt`, and a push nonce.
- `checkpoint` records store the current reduced branch head plus the accepted
  state frontier. Because checkpoints and ref updates are siblings, a
  checkpoint can compact old branch deltas.
- Contributor branch state is authorized to the branch author/owner.
- Protected/default branch state is maintainer/owner authority.

Git object storage follows the same branch ownership rule:

- Contributor branch bundles are scoped under that contributor's branch context
  and may be compacted by that contributor with `$squash`.
- Protected/default branch bundles and full repo bundles are maintainer/owner
  checkpoints.
- A repo-wide full bundle checkpoint is an optimization for faster clone/fetch,
  not the only source of truth. Helpers can still reconstruct from branch
  checkpoints and accepted state records if needed.

Conflict handling is reducer logic, not DWN storage magic:

- A local helper rejects a push if `oldTarget` is not the current reduced branch
  head.
- If two validly authored operations race through sync, only the operation that
  extends the accepted head is canonical. The other becomes stale and requires
  rebase, unless the branch rules allow force push.
- Record timestamps are not enough to decide Git history. Git ancestry and
  branch protection rules decide whether a ref operation is valid.

Issues, PRs, and moderation should use the same event/checkpoint shape:

- Comments and revisions are append-only records.
- Edits are explicit operations, so concurrent edits can be reduced
  deterministically by operation type, actor authority, timestamp, and record ID.
- Deletion in the canonical public view is a tombstone/moderation operation.
- Issue, PR, and moderation checkpoints can use `$squash` on snapshot paths to
  keep reads cheap, but audit/event records should not be purged in the MVP.
  The reducer must still validate post-checkpoint operations.

Protocol design must avoid accidental checkpoint authority. In the current DWN
implementation, a squash write can authorize through `squash` or `create`.
Therefore contributor-created operations and maintainer-only checkpoints should
not share a `$squash` path unless the path/context rules safely scope create and
squash authority. The safer MVP shape is separate child paths or branch-owned
contexts where a contributor can only checkpoint their own branch and maintainers
own protected/default branch checkpoints.

## CLI Work

Repo commands:

- `gitd repo add-moderator <did> [--alias <name>]`
- `gitd repo remove-moderator <did>`
- `gitd repo add-contributor <did> [--alias <name>]`
- `gitd repo remove-contributor <did>`
- Keep generic `add-collaborator` only as an advanced or compatibility command.

Moderation commands:

- `gitd mod block <did> [--reason <text>]`
- `gitd mod unblock <did>`
- `gitd mod lock issue <id> [--reason <reason>]`
- `gitd mod unlock issue <id>`
- `gitd mod lock pr <id> [--reason <reason>]`
- `gitd mod unlock pr <id>`
- `gitd mod hide-comment <id> [--reason <reason>]`
- `gitd mod unhide-comment <id>`
- `gitd mod delete-comment <id> [--reason <reason>]`
- `gitd mod reports`
- `gitd mod report <record-id> [--reason <reason>]`
- `gitd mod resolve-report <id>`
- `gitd mod interaction-limit <off|contributors|collaborators> [--duration <duration>]`

Issue and PR commands should stay focused on canonical records. External
records can still be accepted or ignored when a maintainer already has the
submitter DID and record ID, but discovery is explicitly out of scope for core
v1.

## Indexer Contract

The core should leave enough metadata for an optional public indexer to:

- discover public repos
- list public refs and basic repo activity
- surface public outside issue/PR records that target a repo
- observe owner-side ignore decisions
- avoid needing write access, keys, or delegated authority

No indexer-specific ranking, registration protocol, hosting model, moderation
queue policy, or reputation system belongs in this repo-level MVP plan. That
needs a separate discovery pass.

## Implementation Sequence

1. Trim PR scope.
   - Keep core protocol and CLI improvements.
   - Defer broad GitHub shim additions, Actions, pages, webhooks, security
     scanning, custom fields, and org/team breadth.

2. Add first-class moderator role.
   - Protocol role.
   - CLI add/remove/list.
   - Tests for role assignment and revocation.

3. Build the DWN-native helper path.
   - `git-remote-did` resolves DWN-only remotes to local `gitd serve` for
     clone/fetch.
   - The helper reads remote repo and bundle records via DWN `from` queries and
     maintains local bare git caches.
   - Contributor push policy is enforced for smart HTTP receive-pack commands.
   - Contributor push writes signed branch state and bundle records directly to
     the owner DWN from the contributor's helper.
   - Smart HTTP remains a local adapter, not the authoritative remote service.

4. Add branch operation/checkpoint records.
   - Contributor branch contexts under `refs/heads/users/<did-hash>/<branch>`.
   - Contributor-owned `$squash` checkpoints for those branches.
   - Maintainer-owned `$squash` checkpoints for protected/default branches.
   - Reducer tests for stale races, protected branch rejection, and maintainer
     protected branch updates.

5. Correct push authorization.
   - Contributors can push canonical non-protected branches in their namespace.
   - Maintainers can update protected/default branches.
   - Tests cover contributor branch push and protected branch rejection at the
     receive-pack command level. Pure authority tests cover contributor-owned
     branch squash, moderator rejection, and maintainer/owner protected branch
     squash. Direct DWN-write tests for maintainer protected branch squash are
     still a useful hardening follow-up.

6. Add moderation records and commands.
   - Immutable `repo/moderationEvent` records exist for blocks, locks,
     hidden/deleted comments, reports, report resolution, and interaction
     limits.
   - `gitd mod` writes these events and tests cover the command surface.
   - Push authorization rejects DIDs whose latest moderation event is `block`.
   - CLI issue/PR render paths hide tombstoned comments, and CLI comment writes
     reject locked discussions. GitHub shim/web moderation reducers are outside
     the CLI/local-helper MVP unless they become required by a repo-level flow.

7. Refine issue and PR permissions.
   - No `anyone.create` on canonical owner DWN records.
   - Contributors, moderators, and maintainers get only their intended actions.
   - Outside submissions remain actor-owned records.

8. Make DWN-native clone/fetch explicit.
   - Define the local delegate flow for reading refs/bundles from a standard
     DWN server.
   - Keep smart HTTP as an adapter, not the core authority model.

9. Update docs and tests.
   - README quick start should show repo-level roles and public repo workflow.
   - Architecture should explain edge authority and standard DWN clone/fetch.
   - Tests should exercise the full public repo contributor and moderator path.

## Drift Guardrails

Do not add new GitHub API endpoints unless they are needed by one of the v1
repo-level workflows above.

Do not add CI implementation in this phase. Merge-status records may be shaped
for future compatibility, but no runner, Actions, or check execution work should
land here.

Do not make indexer behavior authoritative. Indexers can discover and present
records; maintainers and moderators decide through signed repo records.

Do not introduce a hosted delegate service that must hold maintainer or project
keys. Delegation happens through local apps, CLI processes, or browser dapps
using the user's Enbox agent or wallet.
