# DESIGN.md — DWN-Native Git Transport Specification

> **Status**: Canonical specification. All implementation work MUST conform to this document.
> If code conflicts with this spec, the code is wrong.

---

## 1. Core Principle

**The DWN is the sole source of truth for all data — git objects AND social artifacts.**

There is no remote git HTTP server. There is no `GitTransport` service in the DID document.
Git object data is stored as **bundle records** in the DWN. Git ref pointers are stored as
**ref records** in the DWN. The only service endpoint a DID needs is `DecentralizedWebNode`.

A local **bare repo cache** at `~/.enbox/repos/` is an ephemeral, rebuildable artifact
inflated from DWN bundle records. It exists purely for performance — so git operations
can run against a local filesystem repo. It can be deleted and rebuilt at any time from
the DWN.

---

## 2. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User's Machine                          │
│                                                                 │
│  ┌──────────┐     ┌────────────────────┐     ┌──────────────┐  │
│  │ Working  │────▶│  git-remote-did    │────▶│ Bare repo    │  │
│  │ Copy     │     │  (full git remote  │     │ cache        │  │
│  │ (.git/)  │     │   helper)          │     │ (~/.enbox/   │  │
│  │          │◀────│                    │◀────│  repos/)     │  │
│  └──────────┘     └────────┬───────────┘     └──────────────┘  │
│                            │                                    │
└────────────────────────────┼────────────────────────────────────┘
                             │  DWN protocol
                             │  (RecordsQuery, RecordsRead,
                             │   RecordsWrite)
                             ▼
                   ┌─────────────────────┐
                   │   Owner's DWN       │
                   │                     │
                   │  - Bundle records   │ ← git objects (packfiles)
                   │  - Ref records      │ ← branch/tag pointers
                   │  - Repo record      │ ← metadata
                   │  - Issues, patches  │ ← social layer
                   │  - Releases, wiki   │
                   │  - Roles            │ ← access control
                   └─────────────────────┘
```

### What changed from the old design

| Aspect | Old (wrong) | New (correct) |
|---|---|---|
| Clone/fetch source | Remote `gitd serve` HTTP server | Remote DWN (bundle + ref records) |
| Push target | Remote `gitd serve` HTTP server | Remote DWN (write bundle + ref records) |
| `git-remote-did` | URL redirector → `git-remote-https` | Full git remote helper (stdin/stdout protocol) |
| Push authentication | DID-signed HTTP Basic auth tokens | DWN protocol authorization (`$actions` + roles) |
| `GitTransport` DID service | Required | Does not exist |
| `gitd serve` | Required for git operations | Not needed for git operations (optional for web UI) |
| Bare repo on server | Primary data store | Does not exist; local cache only |
| Bundles in DWN | Backup / cold-start restore | Primary and only data store |

---

## 3. Data Model

### 3.1 Bundle Records (git object storage)

Bundle records store git data as `application/x-git-bundle` blobs in the `forge-repo`
protocol under the `repo/bundle` path. This is already defined in `ForgeRepoDefinition`.

```
Protocol: https://enbox.org/protocols/forge/repo
Path:     repo/bundle
Format:   application/x-git-bundle
Tags:     tipCommit (string), isFull (boolean), refCount (integer), size (integer)
Features: $squash: true — periodic compaction purges old bundles
Access:   anyone can read; maintainer can create + squash
```

**Bundle types:**

| Type | `isFull` | Contains | When created |
|---|---|---|---|
| Full | `true` | All refs + all reachable objects | First push; every N-th push (squash) |
| Incremental | `false` | Only objects not in the previous tip | Every push (except squash pushes) |

**Squash**: Every N pushes (default: 5), a full bundle is written with `squash: true`,
which atomically deletes all older bundle records. This prevents unbounded accumulation.

### 3.2 Ref Records (branch/tag pointers)

Ref records are DWN records in the `forge-refs` protocol. They are the authoritative
source for "where does branch X point?"

```
Protocol: https://enbox.org/protocols/forge/refs
Path:     repo/ref
Format:   application/json
Tags:     name (string), type (branch|tag), target (string — commit SHA)
Access:   anyone can read; maintainer can create + update + delete
```

**Data shape:**
```json
{
  "name":   "refs/heads/main",
  "target": "abc123def456...",
  "type":   "branch"
}
```

**One record per ref.** Ref records are updated in-place when a branch advances.
Creating a new branch creates a new record. Deleting a branch deletes the record.

### 3.3 Repo Record (metadata)

```
Protocol: https://enbox.org/protocols/forge/repo
Path:     repo
Format:   application/json
Data:     { name, description, defaultBranch, homepage, dwnEndpoints }
Tags:     name, visibility (public|private), defaultBranch, language, archived
```

**Note:** The `gitEndpoints` field does NOT exist. There are no git HTTP endpoints.
The only endpoints are `dwnEndpoints` (the DWN service URLs from the DID document).

---

## 4. Operations

### 4.1 Clone / Fetch

Triggered by: `git clone did::did:dht:abc/my-repo` or `git fetch`

**Flow:**

```
1. git invokes `git-remote-did <remote-name> did::did:dht:abc/my-repo`

2. git-remote-did: parse DID URL
   → { did: "did:dht:abc", repo: "my-repo" }

3. git-remote-did: resolve DID → discover DWN endpoint
   → DID document → service type "DecentralizedWebNode"
   → ["https://dwn.example.com"]

4. git sends: `capabilities` command on stdin
   git-remote-did responds: `fetch\npush\n\n`

5. git sends: `list` command
   git-remote-did:
     a. Connect to owner's DWN
     b. Query ref records: RecordsQuery {
          protocol: forge-refs,
          protocolPath: 'repo/ref',
          parentContextId: <repo-context-id>
        }
     c. Return ref list to git on stdout:
        `<sha> refs/heads/main\n<sha> refs/tags/v1.0.0\n\n`

6. git sends: `fetch <sha> <refname>` (one or more)
   git-remote-did:
     a. Ensure local cache exists at ~/.enbox/repos/<did-hash>/<repo>.git
     b. If cache is empty or missing:
        - Query DWN for latest full bundle (isFull: true, most recent)
        - Download the bundle blob
        - `git clone --bare <bundle> <cache-path>`
        - Query DWN for incremental bundles newer than the full bundle
        - For each: `git fetch <bundle> refs/*:refs/*` into the cache
     c. If cache already exists:
        - Compare local cache tip with DWN refs
        - Download only the incremental bundles needed
        - `git fetch <bundle> refs/*:refs/*` into the cache
     d. Tell git to fetch from the local cache (print nothing — objects
        are already available via the cache as a local alternate, or
        use `connect` to pipe from cache's upload-pack)

7. git completes the clone/fetch using objects from the cache.
```

**Key invariant:** The remote helper NEVER contacts an HTTP git server.
All data comes from DWN records.

### 4.2 Push (Owner / Maintainer)

Triggered by: `git push` from a DID that has the `repo/maintainer` role.

**Flow:**

```
1. git invokes `git-remote-did` for the push

2. git sends: `list for-push`
   git-remote-did:
     a. Query DWN ref records (same as fetch list)
     b. Return current refs to git

3. git sends: `push <local-ref>:<remote-ref>` (one or more)
   git-remote-did:
     a. Determine which commits are new (not in the current bundle chain)
     b. Verify fast-forward: the new tip must contain the old tip as ancestor
        - Read current ref target from DWN
        - `git merge-base --is-ancestor <old-tip> <new-tip>` locally
        - If not a fast-forward and not a force push: reject
     c. Create an incremental bundle:
        `git bundle create <tmp> <new-refs> --not <old-tips>`
     d. Write the bundle as a DWN record:
        RecordsWrite {
          protocol: forge-repo,
          protocolPath: 'repo/bundle',
          protocolRole: 'repo/maintainer',
          parentContextId: <repo-context-id>,
          dataFormat: 'application/x-git-bundle',
          tags: { tipCommit: <new-sha>, isFull: false, ... }
        }
     e. Update each ref record on DWN:
        RecordsWrite (update) {
          protocol: forge-refs,
          protocolPath: 'repo/ref',
          protocolRole: 'repo/maintainer',
          recordId: <existing-ref-record-id>,  // or create if new branch
          tags: { name: 'refs/heads/main', target: <new-sha>, type: 'branch' }
        }
     f. Check if squash is needed (every N pushes):
        If yes, create a full bundle and write with squash: true
     g. Report success to git on stdout

4. git updates local remote-tracking refs.
```

**Fast-forward enforcement:** Since there is no server-side check, the client
is responsible for verifying fast-forward before writing. A malicious client
could write a non-fast-forward bundle, but:
- Only maintainers can write bundles (DWN enforces via `$actions`)
- Maintainers are trusted (same as giving someone `--force` permission on GitHub)
- The ref record update includes the new target SHA, which other clients can verify

### 4.3 Contribute (Non-Maintainer Patch Submission)

This follows the Linux kernel / `git send-email` model, adapted for DWN.

**Flow:**

```
1. Contributor has a `repo/contributor` role on the maintainer's DWN

2. Contributor creates a patch:
   - Locally: work on a branch, commit
   - `gitd pr create "Add feature X"` (or the git-remote-did push flow writes
     a patch record instead of a bundle record)

3. The patch record is written to the MAINTAINER's DWN:
   RecordsWrite {
     protocol: forge-patches,
     protocolPath: 'repo/patch',
     protocolRole: 'repo:repo/contributor',
     parentContextId: <repo-context-id>,
     tags: { status: 'open', baseBranch: 'main', headBranch: 'feature-x', sourceDid: <contributor-did> }
     data: { title, body, number }
   }

4. A revision record with a bundle attachment is written:
   RecordsWrite {
     protocol: forge-patches,
     protocolPath: 'repo/patch/revision',
     data: { diffStat: { additions, deletions, filesChanged } }
     tags: { headCommit: <sha>, baseCommit: <sha>, commitCount: N }
   }
   + The bundle containing the contributor's commits is attached or stored
     separately and linked.

5. Maintainer reviews:
   - `gitd pr checkout <id>` — downloads the bundle from the patch/revision,
     inflates into their local cache, creates a local branch
   - Reviews code, writes review records to their own DWN

6. Maintainer merges:
   - `gitd pr merge <id>` — performs the git merge locally
   - Creates a new bundle with the merge commit
   - Writes the bundle record to their DWN (as maintainer push)
   - Updates ref records
   - Writes a mergeResult record on the patch
```

### 4.4 Fetch from Any DID (Reading Someone Else's Repo)

```
git clone did::did:dht:someone-else/their-repo
```

This works because:
- Bundle records have `{ who: 'anyone', can: ['read'] }` — public repos are world-readable
- Ref records have `{ who: 'anyone', can: ['read'] }` — anyone can list branches
- The clone flow (4.1) reads from the owner's DWN using anonymous/any-DID access
- No write access is needed for clone/fetch

---

## 5. The `git-remote-did` Helper — Full Specification

### 5.1 Binary

- **Name**: `git-remote-did`
- **Invocation**: git calls it as `git-remote-did <remote-name> <url>`
- **Protocol**: git remote helper protocol on stdin/stdout
  (see `gitremote-helpers(7)`)

### 5.2 Capabilities

```
capabilities
fetch
push
```

The helper does NOT advertise `connect` (no passthrough to an HTTP backend).

### 5.3 `list` / `list for-push`

1. Resolve DID from the remote URL
2. Discover DWN endpoint from DID document
3. Connect to remote DWN (anonymous for reads, authenticated for writes)
4. Query `forge-refs` protocol for ref records scoped to the repo context
5. Query `forge-repo` for the repo record to determine `defaultBranch`
6. Output to stdout:
   ```
   <sha> refs/heads/main
   <sha> refs/heads/feature-x
   <sha> refs/tags/v1.0.0
   @refs/heads/main HEAD
   \n
   ```

### 5.4 `fetch <sha> <ref>`

1. Determine what objects the local cache is missing
2. Query DWN for bundle records needed to fill the gap
3. Download bundle blobs, write to temp files
4. Inflate into local cache: `git fetch <bundle> refs/*:refs/*`
5. Output empty line to signal completion

### 5.5 `push +<src>:<dst>` / `push <src>:<dst>`

1. Identify new commits to push
2. Verify fast-forward (unless force push with `+` prefix)
3. Create incremental bundle
4. Write bundle record to owner's DWN (requires maintainer role)
5. Update/create ref records on owner's DWN
6. Handle squash if threshold reached
7. Output `ok <ref>` for each successful ref update

### 5.6 Agent Connection

The helper needs a connected Enbox agent to:
- Authenticate as the pusher's DID (for writes)
- Access the local DWN (for reading own data)
- Connect to remote DWNs

Connection flow:
1. Check for `GITD_PASSWORD` env var
2. If not set, prompt on `/dev/tty` (stdin/stdout are owned by git)
3. Connect to the local Enbox agent
4. Use the agent's identity for DWN operations

For **read-only** operations (clone/fetch of public repos), agent connection
may be optional — anonymous DWN reads should work without a local identity.

---

## 6. Local Bare Repo Cache

### 6.1 Location

```
~/.enbox/profiles/<profile>/repos/<did-hash-prefix>/<repo-name>.git
```

Where `<did-hash-prefix>` is the first 16 hex chars of SHA-256(DID).

### 6.2 Lifecycle

- **Created**: On first clone/fetch of a repo
- **Updated**: On subsequent fetches (incremental bundles applied)
- **Deletable**: Can be removed at any time; next fetch rebuilds from DWN
- **Not authoritative**: The DWN is the source of truth, not the cache

### 6.3 Cache Invalidation

The cache is valid when its refs match the DWN ref records. On fetch:
1. Read DWN ref records
2. Compare with cache's local refs (`git for-each-ref`)
3. If they match → cache is up to date, no bundles needed
4. If they differ → download missing bundles and apply

---

## 7. DID Document Requirements

A DID participating in gitd needs ONLY:

```json
{
  "id": "did:dht:abc123",
  "service": [
    {
      "id": "#dwn",
      "type": "DecentralizedWebNode",
      "serviceEndpoint": ["https://dwn.example.com"]
    }
  ]
}
```

There is NO `GitTransport` service. The DWN endpoint is sufficient for all
git operations (clone, fetch, push) and all social operations (issues, PRs, etc.).

---

## 8. What Does NOT Exist

These components from the old design are **eliminated**:

| Component | Why removed |
|---|---|
| `gitd serve` (git HTTP server) | DWN is the transport; no HTTP server needed |
| `GitTransport` DID service type | No HTTP endpoint to advertise |
| `git-remote-did-credential` binary | No HTTP auth tokens needed; DWN handles auth |
| Smart HTTP protocol handler | No HTTP transport |
| DID-signed push tokens | DWN protocol authorization replaces this |
| Push authenticator / signature verifier | DWN enforces `$actions` and roles natively |
| Push authorizer (DWN role query) | DWN enforces this at the record-write level |
| Daemon auto-start for git ops | No daemon needed for git operations |
| `~/.enbox/daemon.lock` | No git daemon to discover |
| Credential cache | No tokens to cache |

### What STILL exists

| Component | Why kept |
|---|---|
| `gitd daemon` (shim daemon) | Ecosystem compatibility (npm, go, oci, gh API) — unrelated to git transport |
| `gitd web` (web UI) | Reads from DWN records — transport-independent |
| All DWN protocols | The social layer is unchanged |
| All CLI commands except `serve` | DWN-native, transport-independent |
| Bundle sync/restore logic | Core to the new design — just moves from server callback to remote helper |
| Ref sync logic | Core to the new design — refs as DWN records |
| `GitBackend` (repo path management) | Manages the local cache; remove HTTP-specific methods |

---

## 9. Protocol Modifications

### 9.1 `forge-repo` (src/repo.ts)

**Change:** Remove `gitEndpoints` from `RepoData` type.

```typescript
// BEFORE (wrong):
export type RepoData = {
  name          : string;
  description?  : string;
  defaultBranch : string;
  homepage?     : string;
  dwnEndpoints  : string[];
  gitEndpoints? : string[];   // ← REMOVE THIS
};

// AFTER (correct):
export type RepoData = {
  name          : string;
  description?  : string;
  defaultBranch : string;
  homepage?     : string;
  dwnEndpoints  : string[];
};
```

**Change:** Review bundle `$actions` — contributors may need write access for
the patch-with-bundle flow. Currently only maintainers can create bundles.
This is correct for the canonical bundle chain (only maintainers push to the
repo's refs). Contributors submit patches with attached bundles via the
`forge-patches` protocol, not by writing directly to `repo/bundle`.

### 9.2 `forge-refs` (src/refs.ts)

**No changes needed.** The protocol is already correctly designed:
- Anyone can read (enables anonymous clone/fetch)
- Maintainers can create/update/delete (push authorization)
- Refs are scoped to a repo context via `$ref`

### 9.3 `forge-patches` (src/patches.ts)

**Consider:** Add a `bundle` child type under `patch/revision` so contributors
can attach their code as a bundle directly within the patch record hierarchy.
This keeps the patch self-contained — the maintainer can download the revision's
bundle to review the code. Alternatively, the revision's `headCommit`/`baseCommit`
tags may be sufficient if the contributor pushes their bundle to their OWN DWN
and the maintainer fetches from there.

---

## 10. Implementation Plan — Code Changes

### Files to REMOVE (14 files)

```
src/git-remote/service.ts           — GitTransport service type
src/git-remote/credential-helper.ts — HTTP push auth
src/git-remote/credential-main.ts   — credential helper binary
src/git-remote/credential-cache.ts  — token cache

src/git-server/server.ts            — HTTP git server
src/git-server/http-handler.ts      — smart HTTP protocol
src/git-server/auth.ts              — DID-signed push auth
src/git-server/verify.ts            — push signature verification
src/git-server/push-authorizer.ts   — DWN role check for HTTP

src/cli/commands/serve.ts           — gitd serve command
src/cli/commands/serve-lifecycle.ts  — gitd serve status/stop/restart

src/daemon/lifecycle.ts             — HTTP daemon auto-start
src/daemon/lockfile.ts              — daemon discovery lockfile
```

### Files to REWRITE (2 files)

```
src/git-remote/main.ts              — becomes full git remote helper
src/git-remote/resolve.ts           — becomes DWN endpoint resolver (not HTTP)
```

### Files to MODIFY (17 files)

```
src/git-remote/tty-prompt.ts        — minor call-site changes
src/git-remote/index.ts             — update exports

src/git-server/git-backend.ts       — remove uploadPack/receivePack; add bundle methods
src/git-server/bundle-sync.ts       — standalone function (not OnPushComplete callback)
src/git-server/bundle-restore.ts    — standalone function (not onRepoNotFound callback)
src/git-server/ref-sync.ts          — standalone function; add readRefsFromDwn()
src/git-server/did-service.ts       — remove registerGitService(); keep getDwnEndpoints()
src/git-server/index.ts             — update exports; consider renaming directory

src/cli/main.ts                     — remove serve command; remove daemon auto-start
src/cli/flags.ts                    — minor cleanup
src/cli/commands/clone.ts           — minor adjustments
src/cli/commands/init.ts            — remove gitEndpoints; update paths
src/cli/commands/setup.ts           — remove credential helper setup
src/cli/commands/migrate.ts         — update bundle/ref sync calls

src/repo.ts                         — remove gitEndpoints from RepoData
src/daemon/index.ts                 — remove lockfile/lifecycle exports
```

### Files to KEEP (37 files)

All protocol definitions, all social-layer CLI commands, agent infrastructure,
profile management, shim daemon, web UI, indexer, resolver — unchanged.

### Suggested Directory Rename

```
src/git-server/ → src/git-transport/
```

The surviving modules (git-backend, bundle-sync, bundle-restore, ref-sync,
repo-mutex, did-service) are git transport utilities, not server components.

---

## 11. Binary Changes

### Before (3 binaries)

| Binary | Purpose |
|---|---|
| `gitd` | CLI |
| `git-remote-did` | URL redirector → git-remote-https |
| `git-remote-did-credential` | HTTP push credential helper |

### After (2 binaries)

| Binary | Purpose |
|---|---|
| `gitd` | CLI |
| `git-remote-did` | Full git remote helper (DWN-native fetch + push) |

`git-remote-did-credential` is removed. Update `package.json` `bin` entries.

---

## 12. Test Implications

### Tests to REMOVE

Tests for removed components:
- `tests/git-server.spec.ts` — HTTP server tests
- `tests/git-auth.spec.ts` — push authentication tests
- `tests/push-authorizer.spec.ts` — DWN role check tests (server-side)
- `tests/verify.spec.ts` — signature verification tests
- `tests/credential-helper.spec.ts` — credential helper tests
- Parts of `tests/hardening.spec.ts` — SSRF, body size limits for git server

### Tests to REWRITE

- `tests/e2e.spec.ts` — end-to-end flow must test: DWN bundle write → cache inflate → clone
- `tests/git-remote.spec.ts` — test the new full remote helper protocol

### Tests to ADD

- Remote helper protocol tests (capabilities, list, fetch, push commands)
- DWN-native push flow: bundle creation → DWN write → ref update
- Cache management: invalidation, rebuild from DWN
- Anonymous clone of public repos (no agent needed)
- Contributor patch submission flow (bundle attached to patch record)

### Tests to KEEP

- `tests/protocols.spec.ts` — structural validation
- `tests/schemas.spec.ts` — JSON schema validation
- `tests/integration.spec.ts` — DWN integration
- `tests/cli.spec.ts` — CLI command tests (minus serve)
- `tests/bundle-sync.spec.ts` — bundle creation logic (modify trigger)
- `tests/bundle-restore.spec.ts` — bundle restore logic (modify trigger)
- `tests/ref-sync.spec.ts` — ref sync logic
- `tests/github-shim.spec.ts` — API shim
- `tests/resolver.spec.ts` — package resolver
- `tests/shims.spec.ts` — ecosystem shims
- `tests/daemon.spec.ts` — shim daemon

---

## 13. Migration Notes

### For Existing Users

If users have repos that depend on `gitd serve`:
1. Ensure all repo data is synced to DWN (bundles + refs exist as DWN records)
2. The old `GitTransport` DID service entry can be left in place (it will be ignored)
3. After updating, `git clone/fetch/push` will use DWN directly
4. `gitd serve` will no longer exist — remove from any startup scripts

### For the `package.json`

```diff
  "bin": {
    "gitd": "./dist/esm/cli/main.js",
    "git-remote-did": "./dist/esm/git-remote/main.js",
-   "git-remote-did-credential": "./dist/esm/git-remote/credential-main.js"
  },
```

---

## 14. Open Questions

### 14.1 Anonymous Fetch

Can `git clone did::did:dht:abc/repo` work without a local Enbox agent?
Public DWN records are readable by anyone. If the DWN HTTP API supports
unauthenticated reads, the remote helper could clone without an agent
connection. This would be ideal for the `git clone` experience — no setup
needed, just clone.

### 14.2 Push Without Agent

Push always requires an agent (you need a DID to sign DWN writes).
This is acceptable — you must `gitd setup` before you can push.

### 14.3 Optimistic Concurrency for Refs

DWN's `RecordsWrite` for updating a ref record does not natively support
compare-and-swap (CAS). Two concurrent pushers could both read `main → abc`,
both write `main → <their-tip>`, and the last write wins. Mitigations:
- For single-maintainer repos: not a problem (one writer)
- For multi-maintainer repos: the DWN's `dateModified` ordering provides
  last-write-wins semantics. Clients should fetch before pushing and retry
  on conflict. This is the same model as DynamoDB conditional writes.
- Future: DWN protocol-level CAS would solve this cleanly.

### 14.4 Large Repos

Very large repos may produce bundles that exceed DWN record size limits.
Mitigations:
- Incremental bundles are typically small (just the delta)
- Full bundles can be split across multiple records if needed
- The squash mechanism keeps the bundle chain bounded

### 14.5 Bundle-in-Patch vs. Separate Bundle Store for Contributors

When a contributor submits a PR, their code needs to be accessible to the
maintainer. Two options:
1. **Bundle attached to patch/revision**: Self-contained. Maintainer downloads
   the revision record and gets the code.
2. **Bundle on contributor's own DWN**: Contributor pushes to their own DWN,
   patch record includes `sourceDid`. Maintainer fetches from contributor's DWN.

Option 1 is simpler but puts the contributor's code on the maintainer's DWN
(storage cost). Option 2 is more sovereign but requires cross-DWN fetching.
Both should be supported — option 1 for small patches, option 2 for large ones.
