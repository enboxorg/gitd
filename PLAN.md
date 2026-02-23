# dwn-git: Architecture & Implementation Plan

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Prior Art](#2-prior-art)
3. [Design Principles](#3-design-principles)
4. [Protocol Architecture](#4-protocol-architecture)
   - 4.1 [Repository Protocol](#41-repository-protocol-forge-repo)
   - 4.2 [Issues Protocol](#42-issues-protocol-forge-issues)
   - 4.3 [Patches Protocol](#43-patches-protocol-forge-patches)
   - 4.4 [CI/CD Protocol](#44-cicd-protocol-forge-ci)
   - 4.5 [Releases Protocol](#45-releases-protocol-forge-releases)
   - 4.6 [Package Registry Protocol](#46-package-registry-protocol-forge-registry)
   - 4.7 [Social Protocol](#47-social-protocol-forge-social)
   - 4.8 [Notifications Protocol](#48-notifications-protocol-forge-notifications)
   - 4.9 [Wiki Protocol](#49-wiki-protocol-forge-wiki)
   - 4.10 [Organization Protocol](#410-organization-protocol-forge-org)
5. [DID-Addressed Git Remotes](#5-did-addressed-git-remotes)
6. [DID-Scoped Package Registry](#6-did-scoped-package-registry)
7. [Namespace-Based Contribution Model](#7-namespace-based-contribution-model)
8. [Indexer Integration](#8-indexer-integration)
9. [Identity & Access Control](#9-identity--access-control)
10. [Technical Challenges & Mitigations](#10-technical-challenges--mitigations)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Directory Structure](#12-directory-structure)

---

## 1. Problem Statement

Git is decentralized. GitHub is not.

GitHub centralizes five layers on top of git that don't need to be centralized:

| Layer | GitHub's approach | dwn-git approach |
|---|---|---|
| **Identity** | GitHub usernames, bound to github.com | DIDs (self-sovereign, portable) |
| **Access control** | GitHub org/team/collaborator ACLs | DWN protocol roles with cryptographic auth |
| **Social artifacts** | Issues, PRs, reviews stored on GitHub servers | DWN records on the repo owner's DWN |
| **Package hosting** | npm/GitHub Packages, global namespace | DID-scoped packages, `$immutable` guarantees |
| **Discovery** | GitHub search, trending, explore | Indexer services (decentralized, competitive) |

The goal: replace GitHub's centralized social layer with DWN protocols, while keeping git's native transport for code. Every user owns their data. Every contribution is cryptographically signed. No single point of failure or control.

---

## 2. Prior Art

### Radicle (radicle.xyz)

The most mature attempt at decentralizing the forge.

**Architecture**: All social artifacts (issues, patches/PRs) are stored inside the Git repo as "Collaborative Objects" (COBs) under `refs/cobs/`. COBs are CRDTs — concurrent edits form a DAG that is reduced in topological order. Identity uses `did:key` (Ed25519). Replication uses a custom gossip protocol over Noise XK.

**What works**: Storing social artifacts in Git is elegant — you get replication, integrity, and offline-first for free. The CRDT-over-DAG approach handles concurrent edits cleanly.

**What doesn't work**:
- No encryption at rest — only "private repos" via allow-list replication, not actual encryption
- No fine-grained access control — you seed the whole repo or you don't. No "read issues but not code" or "triage role vs. maintainer"
- Discovery relies on gossip with well-connected seed nodes. No DHT or global resolution
- No organization/team structure — individual-delegate-centric
- No package registry or CI integration at the protocol level

### ForgeFed (ActivityPub extension)

Federation via ActivityPub. Forgejo (Gitea fork) is implementing it.

**What works**: Leverages the fediverse ecosystem. Cross-server issue creation works.

**What doesn't**: It's federation, not decentralization. Server operators control identity and availability. If your instance goes down, your identity goes with it. Not offline-first. No encryption.

### git-bug / git-appraise

Tools that store issue/review data inside Git repositories. Validate the "social artifacts in Git" approach but don't address identity, discovery, or access control.

### What DWN Brings That's New

| Capability | Radicle | ForgeFed | DWN |
|---|---|---|---|
| Identity | `did:key` | Server-bound URIs | `did:dht` / `did:jwk` (rotatable, with services) |
| Discovery | Gossip + seed nodes | WebFinger | DID resolution to DWN service endpoints |
| Access control | Delegate threshold | Server-level ACL | Protocol-level `$actions` with roles, per-record |
| Encryption | None | None | Record-level JWE (`encryptionRequired`) |
| Offline-first | Yes (Git) | No | Yes (DWN sync engine) |
| Extensibility | COB types | ActivityPub vocab | Protocol definitions (composable via `uses`) |

---

## 3. Design Principles

### 3.1 Everyone owns their namespace

The fundamental rule: **you write to your own DWN, not someone else's.** Alice creates issues on her DWN tagged with Bob's repo DID. Bob's DWN only accepts writes from users he's explicitly granted roles to (maintainer, triager, contributor). This eliminates spam by design — there is no `{ who: 'anyone', can: ['create'] }` on any writable protocol path.

External contributions (from strangers) follow one of these patterns:
- **Permission grants**: Bob issues a scoped, revocable grant to Alice's DID after she requests access
- **Submissions inbox**: A protocol path with `$recordLimit` and proof-of-work, where anyone can propose but the owner curates
- **Indexer-mediated**: Alice writes to her DWN, the indexer surfaces it to Bob, Bob "accepts" by writing a corresponding record to his own DWN

### 3.2 Composable protocols

Rather than one monolithic protocol, `dwn-git` uses 10 composable protocols. Each handles one domain (repo, issues, patches, etc.) and references the others via `uses` for cross-protocol role authorization. This mirrors how `@enbox/protocols` composes `ListsDefinition` with `SocialGraphDefinition`.

### 3.3 Immutability where it matters

`$immutable` is used aggressively for audit trails: status changes, reviews, revisions, release assets, package versions. These records cannot be silently edited — if you need to change your mind, you create a new record. This provides the same guarantees as git's content-addressed storage, extended to social artifacts.

### 3.4 Git stays git

Git objects use Git's native transport protocol (smart HTTP). DWN handles the social layer. The two are connected by the DID — the DID document advertises both DWN endpoints and git transport endpoints. This is pragmatic: git's pack protocol is highly optimized and battle-tested. Storing git objects as DWN records would sacrifice all that performance for no real benefit.

### 3.5 Indexers bridge the gaps

Features that require global aggregation (star counts, cross-DWN search, trending repos, external contributions) are handled by indexer services. Indexers crawl published DWN records, build materialized views, and expose APIs. Multiple competing indexers can exist — no single indexer is authoritative. The DWN protocols support indexers in three ways:
- **Read-only**: Indexers query published DWN records
- **Write-back**: The DWN owner grants an indexer a scoped write permission to populate curated views
- **Compute modules** (future): Periodic computation that runs on the DWN itself

---

## 4. Protocol Architecture

All protocols use the `https://enbox.org/protocols/forge/` namespace. Each protocol definition follows the `@enbox/protocols` pattern: data types, SchemaMap, raw `ProtocolDefinition`, and typed protocol via `defineProtocol()`.

### 4.1 Repository Protocol (`forge-repo`)

The foundational protocol. Defines repository metadata, collaborator roles, and repo-level resources.

```typescript
export const ForgeRepoDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/repo',
  published : true,
  types     : {
    repo         : { schema: 'https://enbox.org/schemas/forge/repo',         dataFormats: ['application/json'] },
    settings     : { schema: 'https://enbox.org/schemas/forge/settings',     dataFormats: ['application/json'] },
    readme       : { dataFormats: ['text/markdown', 'text/plain'] },
    license      : { dataFormats: ['text/plain'] },
    maintainer   : { schema: 'https://enbox.org/schemas/forge/collaborator', dataFormats: ['application/json'] },
    triager      : { schema: 'https://enbox.org/schemas/forge/collaborator', dataFormats: ['application/json'] },
    contributor  : { schema: 'https://enbox.org/schemas/forge/collaborator', dataFormats: ['application/json'] },
    topic        : { schema: 'https://enbox.org/schemas/forge/topic',        dataFormats: ['application/json'] },
    webhook      : { schema: 'https://enbox.org/schemas/forge/webhook',      dataFormats: ['application/json'], encryptionRequired: true },
  },
  structure: {
    repo: {
      $recordLimit : { max: 1, strategy: 'reject' },
      $actions     : [{ who: 'anyone', can: ['read'] }],
      $tags: {
        $requiredTags       : ['name', 'visibility'],
        $allowUndefinedTags : false,
        name                : { type: 'string', maxLength: 100 },
        visibility          : { type: 'string', enum: ['public', 'private'] },
        defaultBranch       : { type: 'string' },
        language            : { type: 'string' },
        archived            : { type: 'boolean' },
      },

      maintainer: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
      },
      triager: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
      },
      contributor: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
      },
      readme: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create', 'update'] },
        ],
      },
      license: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [{ who: 'anyone', can: ['read'] }],
      },
      topic: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create', 'delete'] },
        ],
        $tags: { $requiredTags: ['name'], $allowUndefinedTags: false, name: { type: 'string', maxLength: 50 } },
      },
      settings: {
        $recordLimit : { max: 1, strategy: 'reject' },
        // Owner-only (no $actions for non-owner = owner-only)
      },
      webhook: {
        // Owner-only, encrypted at rest (webhook secrets are sensitive)
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Data shapes:**

```typescript
export type RepoData = {
  name          : string;
  description?  : string;
  defaultBranch : string;
  homepage?     : string;
  dwnEndpoints  : string[];   // DWN URLs for social artifacts
  gitEndpoints? : string[];   // Git transport URLs (smart HTTP)
};

export type CollaboratorData = {
  did    : string;
  alias? : string;
};
```

**Key decisions:**
- **Repo is a singleton** (`$recordLimit: { max: 1 }`). Updated in place for description changes.
- **Three role tiers**: maintainer (full write), triager (issue management), contributor (patches/wiki). Mirrors GitHub's permission model.
- **Webhook uses `encryptionRequired: true`** — webhook URLs and secrets are sensitive.
- **Tags enable querying** — filter repos by language, visibility, archive status.

### 4.2 Issues Protocol (`forge-issues`)

```typescript
export const ForgeIssuesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/issues',
  published : true,
  uses      : { repo: 'https://enbox.org/protocols/forge/repo' },
  types     : {
    issue        : { schema: 'https://enbox.org/schemas/forge/issue',         dataFormats: ['application/json'] },
    comment      : { schema: 'https://enbox.org/schemas/forge/comment',       dataFormats: ['application/json'] },
    reaction     : { schema: 'https://enbox.org/schemas/forge/reaction',      dataFormats: ['application/json'] },
    label        : { schema: 'https://enbox.org/schemas/forge/label',         dataFormats: ['application/json'] },
    statusChange : { schema: 'https://enbox.org/schemas/forge/status-change', dataFormats: ['application/json'] },
    assignment   : { schema: 'https://enbox.org/schemas/forge/assignment',    dataFormats: ['application/json'] },
  },
  structure: {
    issue: {
      $actions: [
        { role: 'repo:repo/contributor', can: ['create', 'read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'read', 'update', 'delete'] },
        { role: 'repo:repo/triager', can: ['read', 'update'] },
        { who: 'author', of: 'issue', can: ['update'] },
      ],
      $tags: {
        $requiredTags       : ['status', 'repoRecordId'],
        $allowUndefinedTags : false,
        status              : { type: 'string', enum: ['open', 'closed'] },
        repoRecordId        : { type: 'string' },
        priority            : { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestone           : { type: 'string' },
      },

      comment: {
        $actions: [
          { role: 'repo:repo/contributor', can: ['create', 'read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'read', 'delete'] },
          { who: 'author', of: 'issue/comment', can: ['update', 'delete'] },
        ],

        reaction: {
          $actions: [
            { role: 'repo:repo/contributor', can: ['create', 'read', 'delete'] },
            { role: 'repo:repo/maintainer', can: ['create', 'read', 'delete'] },
          ],
          $tags: {
            $requiredTags       : ['emoji'],
            $allowUndefinedTags : false,
            emoji               : { type: 'string', maxLength: 10 },
          },
        },
      },

      label: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
          { role: 'repo:repo/triager', can: ['create', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['name', 'color'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          color               : { type: 'string' },
        },
      },

      statusChange: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
          { role: 'repo:repo/triager', can: ['create'] },
          { who: 'author', of: 'issue', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['from', 'to'],
          $allowUndefinedTags : false,
          from                : { type: 'string', enum: ['open', 'closed'] },
          to                  : { type: 'string', enum: ['open', 'closed'] },
        },
      },

      assignment: {
        $actions: [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
          { role: 'repo:repo/triager', can: ['create', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['assigneeDid'],
          $allowUndefinedTags : false,
          assigneeDid         : { type: 'string' },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Data shapes:**

```typescript
export type IssueData = {
  title  : string;
  body   : string;     // Markdown
  number : number;     // Human-friendly sequential number (owner-assigned)
};

export type CommentData = { body: string };

export type StatusChangeData = { reason?: string };
```

**Key decisions:**
- **No `{ who: 'anyone', can: ['create'] }`** — only users with a contributor or maintainer role can create issues directly on the repo owner's DWN. External issue reports live on the reporter's own DWN (see [Section 7](#7-namespace-based-contribution-model)).
- **`statusChange` and `label` are `$immutable`** — these are audit events, not editable records.
- **`repoRecordId` tag** links issues to a specific repo context, enabling filtered queries.
- **Cross-protocol roles** via `repo:repo/maintainer` reference the forge-repo protocol.

### 4.3 Patches Protocol (`forge-patches`)

Pull requests, code review, and merge tracking.

```typescript
export const ForgePatchesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/patches',
  published : true,
  uses      : { repo: 'https://enbox.org/protocols/forge/repo' },
  types     : {
    patch         : { schema: 'https://enbox.org/schemas/forge/patch',              dataFormats: ['application/json'] },
    revision      : { schema: 'https://enbox.org/schemas/forge/revision',           dataFormats: ['application/json'] },
    review        : { schema: 'https://enbox.org/schemas/forge/review',             dataFormats: ['application/json'] },
    reviewComment : { schema: 'https://enbox.org/schemas/forge/review-comment',     dataFormats: ['application/json'] },
    statusChange  : { schema: 'https://enbox.org/schemas/forge/patch-status-change', dataFormats: ['application/json'] },
    mergeResult   : { schema: 'https://enbox.org/schemas/forge/merge-result',       dataFormats: ['application/json'] },
  },
  structure: {
    patch: {
      $actions: [
        { role: 'repo:repo/contributor', can: ['create', 'read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'read', 'update', 'delete'] },
        { who: 'author', of: 'patch', can: ['update'] },
      ],
      $tags: {
        $requiredTags       : ['status', 'repoRecordId', 'baseBranch'],
        $allowUndefinedTags : false,
        status              : { type: 'string', enum: ['draft', 'open', 'closed', 'merged'] },
        repoRecordId        : { type: 'string' },
        baseBranch          : { type: 'string' },
        headBranch          : { type: 'string' },
        sourceDid           : { type: 'string' },  // For cross-DWN patches: author's DID
      },

      revision: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { who: 'author', of: 'patch', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['headCommit', 'baseCommit'],
          $allowUndefinedTags : false,
          headCommit          : { type: 'string' },
          baseCommit          : { type: 'string' },
          commitCount         : { type: 'integer', minimum: 1 },
        },
      },

      review: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['create', 'read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'read'] },
        ],
        $tags: {
          $requiredTags       : ['verdict'],
          $allowUndefinedTags : false,
          verdict             : { type: 'string', enum: ['approve', 'reject', 'comment'] },
          revisionRecordId    : { type: 'string' },
        },

        reviewComment: {
          $actions: [
            { role: 'repo:repo/contributor', can: ['create', 'read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'read'] },
          ],
          $tags: {
            $allowUndefinedTags : true,
            path                : { type: 'string' },
            line                : { type: 'integer' },
            side                : { type: 'string', enum: ['left', 'right'] },
          },
        },
      },

      statusChange: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
          { who: 'author', of: 'patch', can: ['create'] },
        ],
      },

      mergeResult: {
        $immutable   : true,
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['mergeCommit', 'strategy'],
          $allowUndefinedTags : false,
          mergeCommit         : { type: 'string' },
          strategy            : { type: 'string', enum: ['merge', 'squash', 'rebase'] },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Data shapes:**

```typescript
export type PatchData = {
  title   : string;
  body    : string;     // Markdown
  number  : number;
};

export type RevisionData = {
  description? : string;  // "Addressed review feedback"
  diffStat     : { additions: number; deletions: number; filesChanged: number };
};

export type ReviewData = { body?: string };

export type ReviewCommentData = {
  body      : string;
  diffHunk? : string;  // Diff hunk context for rendering
};

export type MergeResultData = { mergedBy: string };
```

**Key decisions:**
- **`revision` is `$immutable`** — each force-push creates a new revision. Reviewers need to see what they reviewed.
- **`review` is `$immutable`** — verdicts cannot be silently changed. Submit a new review to change your mind.
- **`mergeResult` has `$recordLimit: { max: 1 }`** — a patch can only be merged once.
- **`reviewComment` supports inline code review** via `path`/`line`/`side` tags.
- **Cross-DWN patches** use `sourceDid` to indicate where the branch lives (the fork author's DWN).

### 4.4 CI/CD Protocol (`forge-ci`)

```typescript
export const ForgeCiDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/ci',
  published : true,
  uses      : { repo: 'https://enbox.org/protocols/forge/repo' },
  types     : {
    checkSuite : { schema: 'https://enbox.org/schemas/forge/check-suite', dataFormats: ['application/json'] },
    checkRun   : { schema: 'https://enbox.org/schemas/forge/check-run',   dataFormats: ['application/json'] },
    artifact   : { dataFormats: ['application/octet-stream', 'application/gzip'] },
  },
  structure: {
    checkSuite: {
      $actions: [
        { role: 'repo:repo/contributor', can: ['read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'update'] },
      ],
      $tags: {
        $requiredTags       : ['commitSha', 'status', 'repoRecordId'],
        $allowUndefinedTags : false,
        commitSha           : { type: 'string' },
        status              : { type: 'string', enum: ['queued', 'in_progress', 'completed'] },
        conclusion          : { type: 'string', enum: ['success', 'failure', 'cancelled', 'skipped'] },
        repoRecordId        : { type: 'string' },
        branch              : { type: 'string' },
      },

      checkRun: {
        $actions: [
          { role: 'repo:repo/contributor', can: ['read'] },
          { who: 'author', of: 'checkSuite', can: ['create', 'update'] },
        ],
        $tags: {
          $requiredTags       : ['name', 'status'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          status              : { type: 'string', enum: ['queued', 'in_progress', 'completed'] },
          conclusion          : { type: 'string', enum: ['success', 'failure', 'cancelled', 'skipped'] },
        },

        artifact: {
          $actions : [
            { role: 'repo:repo/contributor', can: ['read'] },
            { who: 'author', of: 'checkSuite', can: ['create'] },
          ],
          $size: { max: 104857600 },  // 100MB per artifact
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Key insight**: CI bots are DID-bearing agents. A CI provider has its own DID and is added as a `maintainer` to the repo. The bot writes `checkSuite` and `checkRun` records. This is analogous to GitHub Apps with installation-scoped permissions.

**Check runs are mutable** (status transitions: `queued` -> `in_progress` -> `completed`). This is one of the few places where mutable records are needed.

### 4.5 Releases Protocol (`forge-releases`)

```typescript
export const ForgeReleasesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/releases',
  published : true,
  uses      : { repo: 'https://enbox.org/protocols/forge/repo' },
  types     : {
    release   : { schema: 'https://enbox.org/schemas/forge/release', dataFormats: ['application/json'] },
    asset     : { dataFormats: ['application/octet-stream', 'application/gzip', 'application/zip', 'application/x-tar'] },
    signature : { dataFormats: ['application/pgp-signature', 'application/json'] },
  },
  structure: {
    release: {
      $actions: [
        { who: 'anyone', can: ['read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'update', 'delete'] },
      ],
      $tags: {
        $requiredTags       : ['tagName', 'repoRecordId'],
        $allowUndefinedTags : false,
        tagName             : { type: 'string' },
        repoRecordId        : { type: 'string' },
        commitSha           : { type: 'string' },
        prerelease          : { type: 'boolean' },
        draft               : { type: 'boolean' },
      },

      asset: {
        $immutable : true,   // Published binaries must not be silently replaced (supply chain security)
        $actions   : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['filename', 'contentType'],
          $allowUndefinedTags : false,
          filename            : { type: 'string' },
          contentType         : { type: 'string' },
          size                : { type: 'integer' },
        },
      },

      signature: {
        $immutable   : true,
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
        ],
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

`$immutable` on `asset` is critical for supply chain security. Once a release binary is published, its data cannot be mutated. Deletion is still possible (via `$actions`), but the content integrity is guaranteed while the record exists.

### 4.6 Package Registry Protocol (`forge-registry`)

```typescript
export const ForgeRegistryDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/registry',
  published : true,
  types     : {
    package     : { schema: 'https://enbox.org/schemas/forge/package',         dataFormats: ['application/json'] },
    version     : { schema: 'https://enbox.org/schemas/forge/package-version', dataFormats: ['application/json'] },
    tarball     : { dataFormats: ['application/gzip', 'application/octet-stream'] },
    attestation : { schema: 'https://enbox.org/schemas/forge/attestation',     dataFormats: ['application/json'] },
  },
  structure: {
    package: {
      $actions: [{ who: 'anyone', can: ['read'] }],
      // Only owner can create packages (no create in $actions = owner-only)
      $tags: {
        $requiredTags       : ['name', 'ecosystem'],
        $allowUndefinedTags : false,
        name                : { type: 'string', maxLength: 214 },
        ecosystem           : { type: 'string', enum: ['npm', 'cargo', 'pip', 'go'] },
        description         : { type: 'string' },
      },

      version: {
        $immutable : true,    // Once published, version metadata is permanent
        $actions   : [
          { who: 'anyone', can: ['read'] },
          { who: 'author', of: 'package', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['semver'],
          $allowUndefinedTags : false,
          semver              : { type: 'string' },
          deprecated          : { type: 'boolean' },
        },

        tarball: {
          $immutable   : true,   // Package bytes are permanent
          $recordLimit : { max: 1, strategy: 'reject' },
          $actions     : [
            { who: 'anyone', can: ['read'] },
            { who: 'author', of: 'package', can: ['create'] },
          ],
        },

        attestation: {
          $immutable : true,
          $actions   : [
            { who: 'anyone', can: ['read'] },
            // Third-party attestors need a permission grant from the package owner
          ],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Advantages over npm:**
- **No registry takeover**: the publisher's DID owns the package. No one can unpublish your package from your DWN.
- **No name squatting**: names are scoped to DIDs. `did:dht:alice/utils` and `did:dht:bob/utils` coexist.
- **Cryptographic provenance**: every version is signed by the publisher's DID. No separate signing ceremony.
- **`$immutable` guarantees**: published versions cannot be mutated. The protocol enforces it.

### 4.7 Social Protocol (`forge-social`)

```typescript
export const ForgeSocialDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/social',
  published : true,
  types     : {
    star     : { schema: 'https://enbox.org/schemas/forge/star',     dataFormats: ['application/json'] },
    follow   : { schema: 'https://enbox.org/schemas/forge/follow',   dataFormats: ['application/json'] },
    activity : { schema: 'https://enbox.org/schemas/forge/activity', dataFormats: ['application/json'] },
  },
  structure: {
    star: {
      // Stars live on the STARRER's DWN, not the repo owner's.
      // Owner-only (you star repos on your own DWN)
      $tags: {
        $requiredTags       : ['repoDid', 'repoRecordId'],
        $allowUndefinedTags : false,
        repoDid             : { type: 'string' },
        repoRecordId        : { type: 'string' },
      },
    },
    follow: {
      // Follows live on the FOLLOWER's DWN
      $tags: {
        $requiredTags       : ['targetDid'],
        $allowUndefinedTags : false,
        targetDid           : { type: 'string' },
      },
    },
    activity: {
      // Activity feed on the actor's DWN
      $actions: [{ who: 'anyone', can: ['read'] }],
      $tags: {
        $requiredTags       : ['type'],
        $allowUndefinedTags : true,
        type                : {
          type : 'string',
          enum : ['push', 'issue_open', 'issue_close', 'patch_open', 'patch_merge', 'release', 'star', 'fork'],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

**Key insight**: Stars and follows live on the actor's DWN, not the target's. This means "how many stars does this repo have?" requires an indexer to aggregate across DWNs. This is a deliberate trade-off: data sovereignty over convenience. Indexers solve the aggregation problem.

### 4.8 Notifications Protocol (`forge-notifications`)

```typescript
export const ForgeNotificationsDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/notifications',
  published : false,   // Private — notifications are personal
  types     : {
    notification: { schema: 'https://enbox.org/schemas/forge/notification', dataFormats: ['application/json'] },
  },
  structure: {
    notification: {
      // Only the DWN owner can read/update/delete.
      // Trusted agents (maintainers of repos you contribute to) get permission grants to create.
      $tags: {
        $requiredTags       : ['type', 'read'],
        $allowUndefinedTags : true,
        type                : {
          type : 'string',
          enum : ['mention', 'review_request', 'assignment', 'ci_failure', 'patch_merged', 'issue_comment', 'review'],
        },
        read                : { type: 'boolean' },
        repoDid             : { type: 'string' },
        repoRecordId        : { type: 'string' },
        sourceRecordId      : { type: 'string' },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

`published: false` — notifications are private to the owner. Notification senders (e.g., the repo's DWN when someone is mentioned) need a scoped permission grant.

### 4.9 Wiki Protocol (`forge-wiki`)

```typescript
export const ForgeWikiDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/wiki',
  published : true,
  uses      : { repo: 'https://enbox.org/protocols/forge/repo' },
  types     : {
    page        : { schema: 'https://enbox.org/schemas/forge/wiki-page',    dataFormats: ['text/markdown'] },
    pageHistory : { schema: 'https://enbox.org/schemas/forge/wiki-history', dataFormats: ['application/json'] },
  },
  structure: {
    page: {
      $actions: [
        { who: 'anyone', can: ['read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'update', 'delete'] },
        { role: 'repo:repo/contributor', can: ['create', 'update'] },
      ],
      $tags: {
        $requiredTags       : ['slug', 'title', 'repoRecordId'],
        $allowUndefinedTags : false,
        slug                : { type: 'string' },
        title               : { type: 'string' },
        repoRecordId        : { type: 'string' },
      },

      pageHistory: {
        $immutable : true,
        $actions   : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
          { role: 'repo:repo/contributor', can: ['create'] },
        ],
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

Wiki pages are mutable (updated in place), but each edit creates an `$immutable` `pageHistory` record capturing the diff.

### 4.10 Organization Protocol (`forge-org`)

```typescript
export const ForgeOrgDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/org',
  published : true,
  types     : {
    org        : { schema: 'https://enbox.org/schemas/forge/org',         dataFormats: ['application/json'] },
    owner      : { schema: 'https://enbox.org/schemas/forge/org-member',  dataFormats: ['application/json'] },
    member     : { schema: 'https://enbox.org/schemas/forge/org-member',  dataFormats: ['application/json'] },
    team       : { schema: 'https://enbox.org/schemas/forge/team',        dataFormats: ['application/json'] },
    teamMember : { schema: 'https://enbox.org/schemas/forge/team-member', dataFormats: ['application/json'] },
  },
  structure: {
    org: {
      $recordLimit : { max: 1, strategy: 'reject' },
      $actions     : [{ who: 'anyone', can: ['read'] }],

      owner: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
      },

      member: {
        $role    : true,
        $actions : [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'delete'] },
        ],
        $tags: { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
      },

      team: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'update', 'delete'] },
        ],

        teamMember: {
          $role    : true,
          $actions : [
            { who: 'anyone', can: ['read'] },
            { role: 'org/owner', can: ['create', 'delete'] },
          ],
          $tags: { $requiredTags: ['did'], $allowUndefinedTags: false, did: { type: 'string' } },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;
```

Organizations are DIDs themselves. An org DID installs the forge protocols and manages repos. Teams provide sub-organization grouping with their own role scoping.

---

## 5. DID-Addressed Git Remotes

### Flow: `git remote add origin did:dht:abc123`

A **git-remote-helper** (named `git-remote-did`, invoked by Git when it sees the `did://` scheme):

**Step 1 — DID Resolution:**

```
did:dht:abc123
  -> resolve DID document
  -> find service of type "DecentralizedWebNode"
  -> find service of type "GitTransport"
  -> extract endpoints
```

The DID document signals git capability via a dedicated service type:

```json
{
  "id": "did:dht:abc123",
  "service": [
    {
      "id": "#dwn",
      "type": "DecentralizedWebNode",
      "serviceEndpoint": ["https://dwn1.example.com"]
    },
    {
      "id": "#git",
      "type": "GitTransport",
      "serviceEndpoint": ["https://dwn1.example.com/git"]
    }
  ]
}
```

**Step 2 — Locate Repository:**

Query the DWN for the repo record:

```
RecordsQuery {
  protocol     : 'https://enbox.org/protocols/forge/repo',
  protocolPath : 'repo',
  filter       : { tags: { name: '<repo-name>' } }
}
```

**Step 3 — Git Transport (hybrid approach):**

Git objects use **native git smart HTTP protocol** to the `GitTransport` endpoint. Social artifacts (issues, PRs, reviews) live in DWN records. This is pragmatic — git's pack protocol is highly optimized.

```
did:dht:abc123
  -> /git/abc123/info/refs (smart HTTP git)     <- git objects
  -> /dwn (JSON-RPC DWN messages)               <- social artifacts
```

**Step 4 — Push Authentication:**

```
git push
  -> git-remote-did connects to GitTransport endpoint
  -> server sends nonce challenge
  -> helper signs nonce with user's DID Ed25519 key
  -> server verifies: is this DID a 'repo/maintainer' for this repo?
  -> if yes, accept the push via git smart HTTP
```

The DID **is** the identity for authorization. No SSH keys, no personal access tokens — just cryptographic proof of DID ownership.

### Git Refs as DWN Records (optional optimization)

While git objects stay in native git storage, **branch ref pointers** can be mirrored as lightweight DWN records:

```typescript
// Track branch heads for subscription-based push notifications
types: {
  ref: { schema: 'https://enbox.org/schemas/forge/git-ref', dataFormats: ['application/json'] }
}
// Data: { name: "refs/heads/main", target: "abc123def...", type: "branch" }
```

This gives DWN's subscription system visibility into branch updates (real-time notifications when someone pushes to main), while keeping object storage efficient.

---

## 6. DID-Scoped Package Registry

### Resolution Flow

```
npm install did:dht:abc123/my-package@1.0.0
```

A custom npm resolver:

1. **Resolve DID**: `did:dht:abc123` -> DWN endpoints
2. **Query package**: `RecordsQuery { protocol: 'forge/registry', protocolPath: 'package', tags: { name: 'my-package', ecosystem: 'npm' } }`
3. **Query version**: `RecordsQuery { protocolPath: 'package/version', parentId: <package-record-id>, tags: { semver: '1.0.0' } }`
4. **Fetch tarball**: `RecordsRead { protocolPath: 'package/version/tarball', parentId: <version-record-id> }`

### Package Signing

Every DWN record is already signed by the author's DID. The tarball record's `authorization` field proves the publisher's identity cryptographically.

For additional verification, `attestation` records allow third-party co-signing:

```typescript
{
  attestorDid  : 'did:dht:build-service-xyz',
  claim        : 'reproducible-build',
  sourceCommit : 'abc123...',
  sourceRepo   : 'did:dht:abc123/repo-record-id',
}
```

### Dependency Resolution

```json
{
  "dependencies": {
    "did:dht:abc123/utils": "^1.0.0",
    "did:dht:def456/crypto-lib": "~2.3.0"
  }
}
```

The resolver builds a trust chain: resolve each DID, verify tarball signatures match the DID, check attestation records for build reproducibility. The entire chain is verifiable without any central authority.

---

## 7. Namespace-Based Contribution Model

### The Problem

GitHub allows anyone to open an issue or PR on any public repo. In DWN, unrestricted write access to someone else's DWN is a security risk (spam, abuse, storage exhaustion).

### The Solution: Write to Your Own DWN

```
Alice's DWN                            Bob's DWN (repo owner)
+-----------------------+              +-----------------------+
| issue record          |              | issue records         |
|   tagged with:        |   indexer    |   from maintainers    |
|   repoDid: bob        | ----------> |   and triagers        |
|   repoRecordId: xyz   |   surfaces  |                       |
+-----------------------+              +-----------------------+
```

**For trusted collaborators** (maintainers, triagers, contributors): They have role records on Bob's DWN and write directly. This is the fast path — no indexer needed.

**For external contributors** (strangers): They write to their own DWN, tagged with the target repo's DID and recordId. An indexer surfaces these to the repo owner. The owner can:
- **Accept**: write a corresponding record to their own DWN, linking to the original
- **Ignore**: the external issue stays on the reporter's DWN but isn't visible in the repo's canonical view
- **Grant access**: promote the stranger to contributor role for future direct writes

**For submission inboxes** (optional): A protocol path with `$recordLimit` and proof-of-work requirements where controlled writes from non-role-holders are accepted. This is a middle ground for repos that want to be more open without being fully permissionless.

### Benefits

- **No spam by design** — you can't flood someone else's DWN
- **Data sovereignty** — your contributions live on your DWN, even if the repo owner ignores them
- **Natural reputation** — indexers can surface contributions from known/reputable DIDs first
- **Graceful degradation** — works without indexers (direct role-based writes), indexers just improve discovery

---

## 8. Indexer Integration

Indexers are services that crawl published DWN records and build materialized views. They solve aggregation problems that don't have a protocol-level answer.

### Three Integration Patterns

**Pattern 1 — Read-only indexing**: The indexer queries published (`published: true`) DWN records. No write access needed. Covers: repo discovery, star counts, cross-DWN search, trending repos, external contribution surfacing.

**Pattern 2 — Write-back**: The DWN owner grants the indexer a scoped permission to write curated views into the DWN. Example: an indexer that aggregates star counts writes a `starCount` record to Bob's DWN so Bob's UI can display it without querying the indexer at runtime.

**Pattern 3 — Compute modules (future)**: Periodic computation that runs on the DWN itself. Example: every hour, a compute module counts stars from subscribed indexers and updates a local aggregate. This is a future DWN capability, not yet implemented.

### What Indexers Solve

| Problem | Indexer solution |
|---|---|
| "How many stars does this repo have?" | Crawl star records across DWNs, maintain count |
| "Find repos about X topic" | Crawl repo records with topic tags, build search index |
| "Show me external issues for my repo" | Crawl issue records tagged with my repo's DID |
| "Trending repos this week" | Track activity records, compute trending score |
| "Who depends on my package?" | Crawl package.json / dependency records |

### Indexer Ecosystem

Multiple competing indexers can exist — no single indexer is authoritative. Users choose which indexers to trust (similar to choosing a search engine). The DWN protocols don't depend on any specific indexer.

---

## 9. Identity & Access Control

### Role Model

| Role | Protocol Path | Capabilities |
|---|---|---|
| Owner | DWN tenant (implicit) | Full control over all records |
| Maintainer | `repo/maintainer` (`$role: true`) | Push, merge, manage issues/PRs, releases, CI |
| Triager | `repo/triager` (`$role: true`) | Manage issues (label, assign, close), but cannot push or merge |
| Contributor | `repo/contributor` (`$role: true`) | Create issues, submit patches, edit wiki |
| Reader | `anyone` with `read` action | Read all published records |

### Role Assignment

The repo owner writes a role record with the collaborator's DID as recipient:

```typescript
// Owner grants maintainer role to Alice
await agent.dwn.processRequest({
  author       : ownerDid,
  target       : ownerDid,
  messageType  : DwnInterface.RecordsWrite,
  messageParams: {
    protocol        : 'https://enbox.org/protocols/forge/repo',
    protocolPath    : 'repo/maintainer',
    parentContextId : repoContextId,
    recipient       : aliceDid,
    dataFormat      : 'application/json',
    tags            : { did: aliceDid },
  },
  dataStream: new Blob([JSON.stringify({ did: aliceDid, alias: 'alice' })]),
});
```

Alice invokes this role via `protocolRole: 'repo/maintainer'` on subsequent operations.

### Fork Relationships

1. Alice creates a `repo` record on her own DWN with a `forkedFrom` tag pointing to Bob's DID/repo
2. She clones the git data to her own DWN-adjacent git server
3. She can push to her fork freely
4. To propose changes back, she creates a `patch` record on Bob's DWN (requires contributor role or permission grant)

### Cross-DWN Pull Requests

Alice (contributor on Bob's repo) writes a `patch` record to Bob's DWN:

```typescript
await agent.dwn.processRequest({
  author       : aliceDid,
  target       : bobDid,          // Writing to Bob's DWN
  messageType  : DwnInterface.RecordsWrite,
  messageParams: {
    protocol        : 'https://enbox.org/protocols/forge/patches',
    protocolPath    : 'patch',
    protocolRole    : 'repo:repo/contributor',
    dataFormat      : 'application/json',
    tags            : {
      status       : 'open',
      repoRecordId : bobsRepoRecordId,
      baseBranch   : 'main',
      headBranch   : 'feature-x',
      sourceDid    : aliceDid,
    },
  },
  dataStream: new Blob([JSON.stringify({ title: 'Add feature X', body: '...' })]),
});
```

Bob's client uses `sourceDid` to resolve Alice's DWN and fetch the git branch for review. Reviews and comments happen on Bob's DWN (where the patch lives).

---

## 10. Technical Challenges & Mitigations

### 10.1 Sequential Issue/PR Numbers

GitHub issues have sequential numbers (#1, #2, ...). In a decentralized system with concurrent creation (even offline), sequential numbering requires coordination.

**Mitigation**: The repo owner assigns sequential numbers. The owner's DWN is the single writer for the `number` field. This creates a minor bottleneck but is acceptable — issue number assignment is low-frequency and the owner's DWN is always the authority for their repo.

### 10.2 Large File Storage

DWN records support arbitrary data sizes via streaming. For a git LFS equivalent: LFS pointers in the git repo reference DWN record IDs. Binary data lives as records in a `forge-lfs` protocol with `$size` constraints.

### 10.3 Performance at Scale

The core bottleneck: querying thousands of records. Mitigations:
- **Tag-based filtering** pushes selectivity into the DWN (`tags: { status: 'open', repoRecordId: '...' }`)
- **Pagination** with cursors for large result sets
- **`RecordsCount`** for efficient counting without fetching full records
- **`RecordsSubscribe`** for real-time updates (no polling)
- **Client-side caching** with subscription-based invalidation

### 10.4 Real-Time Collaboration

DWN subscriptions (`RecordsSubscribe` over WebSocket) provide event notification when records are written. This is sufficient for forge use cases:
- New issue comment appeared: subscription delivers the event
- CI status changed: subscription delivers the update
- PR was merged: subscription delivers the event

All of these tolerate 100-500ms latency. Sub-second collaborative editing (Google Docs style, Figma cursors) would require ~16-50ms round-trip, which DWN's message processing pipeline doesn't support. But this is a v3+ concern (live code editing) — not needed for any core forge feature.

### 10.5 Global Discovery

No "explore" page without an indexing service. This is a solved problem with indexers (Section 8). Multiple competing indexers can provide discovery. Initially, a single "official" indexer can bootstrap the ecosystem, similar to how npmjs.com bootstrapped npm.

### 10.6 Ecosystem Compatibility

Tools like VS Code, JetBrains IDEs, and `gh` CLI assume GitHub's REST/GraphQL API. Options:
- **Centralized shim** (temporary): a service that translates GitHub API calls to DWN protocol queries. Lets existing tools work during migration.
- **Native integrations** (long-term): VS Code extension, CLI tool (`dwn-git`), web UI
- **Some won't matter**: many GitHub-specific features (Actions YAML, Dependabot) are deeply coupled to GitHub's infrastructure. These get replaced by DWN-native equivalents, not shimmed.

### 10.7 Migration from GitHub

A migration tool:
1. Import repo metadata -> create `repo` record
2. Import issues -> create `issue` records with `comment` children
3. Import PRs -> create `patch` records with `review`/`revision` children
4. Map GitHub usernames to DIDs (claim-based: "I am @alice on GitHub, here's my DID")
5. Import releases -> create `release` records with `asset` children
6. Set up git remote -> push git objects to the DWN-adjacent git server

---

## 11. Implementation Roadmap

### Phase 0: Protocols & Scaffolding (current)

- [x] Architecture document (this file)
- [ ] TypeScript protocol definitions for all 10 protocols
- [ ] JSON Schema files for each record type
- [ ] Structural tests (protocol URIs, types, roles, tags, directives)
- [ ] Package setup (bun, TypeScript, ESLint, build)

### Phase 1: Core Protocols (MVP)

The smallest useful forge — repos, issues, patches.

- [ ] **forge-repo**: repo CRUD, collaborator role management
- [ ] **forge-issues**: issue CRUD, comments, labels, status changes
- [ ] **forge-patches**: PR CRUD, revisions, reviews, merge results
- [ ] Integration tests against a real DWN instance
- [ ] CLI prototype: `dwn-git init`, `dwn-git issue create`, `dwn-git patch create`

### Phase 2: Git Transport

The most novel component.

- [ ] **git-remote-did**: git remote helper that resolves DIDs to git endpoints
- [ ] **GitTransport service type**: DID document service registration
- [ ] **DWN server git sidecar**: smart HTTP git transport alongside DWN
- [ ] **Push authentication**: DID-signed challenge/response
- [ ] **git ref mirroring**: branch heads as DWN records for subscriptions

### Phase 3: Extended Protocols

- [ ] **forge-ci**: check suites, check runs, artifacts
- [ ] **forge-releases**: release management, immutable assets
- [ ] **forge-wiki**: collaborative documentation
- [ ] **forge-org**: organization/team management
- [ ] **forge-social**: stars, follows, activity feeds
- [ ] **forge-notifications**: inbox management

### Phase 4: Package Registry

- [ ] **forge-registry**: package publishing, version management, tarballs
- [ ] **Attestation system**: third-party build verification
- [ ] **npm resolver**: `npm install did:dht:abc123/pkg@1.0.0`
- [ ] **Dependency verification**: trust chain validation

### Phase 5: Ecosystem

- [ ] **Indexer service**: repo discovery, star aggregation, external contribution surfacing
- [ ] **Web UI**: read-only repo/issue/PR viewer
- [ ] **VS Code extension**: native IDE integration
- [ ] **GitHub migration tool**: import repos, issues, PRs from GitHub
- [ ] **GitHub API compatibility shim** (optional)

---

## 12. Directory Structure

```
dwn-git/
├── PLAN.md                     # This document
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
├── eslint.config.cjs
├── src/
│   ├── index.ts                # Barrel re-export of all protocols
│   ├── repo.ts                 # ForgeRepoDefinition + types
│   ├── issues.ts               # ForgeIssuesDefinition + types
│   ├── patches.ts              # ForgePatchesDefinition + types
│   ├── ci.ts                   # ForgeCiDefinition + types
│   ├── releases.ts             # ForgeReleasesDefinition + types
│   ├── registry.ts             # ForgeRegistryDefinition + types
│   ├── social.ts               # ForgeSocialDefinition + types
│   ├── notifications.ts        # ForgeNotificationsDefinition + types
│   ├── wiki.ts                 # ForgeWikiDefinition + types
│   └── org.ts                  # ForgeOrgDefinition + types
├── schemas/                    # JSON Schema files for each record type
│   ├── repo/
│   ├── issues/
│   ├── patches/
│   ├── ci/
│   ├── releases/
│   ├── registry/
│   ├── social/
│   ├── notifications/
│   ├── wiki/
│   └── org/
└── tests/
    ├── tsconfig.json
    └── protocols.spec.ts       # Structural validation tests
```
