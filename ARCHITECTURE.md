# Architecture

This document provides a high-level overview of how `gitd` works. For detailed protocol definitions, schema layouts, and the implementation roadmap, see [PLAN.md](./PLAN.md).

## Design Principles

1. **Everyone owns their namespace** — you write to your own DWN, not someone else's. Contributions are scoped by the contributor's DID. No global write access means no spam by design.

2. **Git stays git** — git objects use git's native transport protocol (smart HTTP). DWN handles the social layer. The two are connected by the DID document, which advertises both DWN endpoints and git transport endpoints.

3. **Composable protocols** — rather than one monolithic protocol, `gitd` uses independent protocol definitions (repo, issues, patches, CI, releases, registry, social, etc.). Each handles one domain and references others via `uses` for cross-protocol role authorization.

4. **Immutability where it matters** — status changes, reviews, release assets, and package versions use `$immutable` records that cannot be silently edited, providing the same auditability guarantees as git's content-addressed storage.

5. **Indexers bridge the gaps** — features that require global aggregation (star counts, cross-DWN search, trending repos) are handled by indexer services. Multiple competing indexers can exist — no single indexer is authoritative.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        User's Machine                       │
│                                                             │
│  ┌──────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ gitd │  │ git-remote-  │  │ git-remote-did-          │  │
│  │ CLI  │  │ did          │  │ credential               │  │
│  └──┬───┘  └──────┬───────┘  └────────────┬─────────────┘  │
│     │             │                        │                │
│     │    ┌────────┴────────────────────────┘                │
│     │    │  Git invokes these automatically                 │
│     │    │  for did:: remotes                               │
└─────┼────┼──────────────────────────────────────────────────┘
      │    │
      │    │  DID resolution
      │    ▼
┌─────┴────────────────────┐     ┌──────────────────────────┐
│     DWN Service          │     │   Git Transport Server   │
│                          │     │   (gitd serve)           │
│  - Forge protocols       │     │                          │
│  - Identity & roles      │◄───►│  - Smart HTTP            │
│  - Issues, patches, etc. │     │  - DID-signed push auth  │
│  - Bundles & refs        │     │  - Ref mirroring to DWN  │
│  - Registry packages     │     │  - Bundle sync to DWN    │
└──────────────────────────┘     └──────────────────────────┘
```

## Protocols

`gitd` defines a set of DWN protocols under the `https://enbox.org/protocols/forge/` namespace. Each protocol is self-contained with its own types, schemas, and authorization rules.

| Protocol | Purpose |
|---|---|
| **forge-repo** | Repository metadata, collaborator roles, bundles, settings |
| **forge-refs** | Git ref records (branches, tags) for DWN subscriptions |
| **forge-issues** | Issues, comments, labels, status changes |
| **forge-patches** | Pull requests, revisions, reviews, merge results |
| **forge-ci** | Check suites, check runs, artifacts |
| **forge-releases** | Release management, immutable assets |
| **forge-registry** | Package publishing, versions, tarballs, attestations |
| **forge-social** | Stars, follows, activity feeds |
| **forge-notifications** | Personal notification inbox |
| **forge-wiki** | Collaborative documentation pages |
| **forge-org** | Organizations, teams, membership |

### Role-Based Authorization

The repo protocol defines three roles: **maintainer**, **triager**, and **contributor**. Other protocols reference these roles via `uses` to control who can do what. For example, only maintainers can merge patches, but triagers can close issues.

Roles are DWN records with `$role: true`, which means the DWN enforces authorization natively — no application-level permission checks needed.

### Cross-Protocol References

Protocols that relate to a specific repository (issues, patches, CI, releases, wiki) compose with `forge-repo` using DWN's `$ref` mechanism. This links records to a repository via `parentContextId` without duplicating data.

## Git Transport

### DID-Addressed Remotes

```
git clone did::did:dht:abc123/my-repo
```

When git encounters a `did::` remote URL:

1. `git-remote-did` is invoked (git discovers it by the `did` scheme name)
2. The DID document is resolved to find the `GitTransport` service endpoint
3. `git-remote-https` is exec'd with the resolved HTTPS URL

### Push Authentication

When pushing to a DID-addressed remote:

1. `git-remote-did-credential` is invoked as a git credential helper
2. It creates a signed push token using the local Web5 agent's identity
3. The git transport server verifies the signature and checks the pusher's DWN role

### Bundle Sync

After each push, the git transport server:

1. Mirrors branch/tag refs to DWN records (enables subscriptions and offline discovery)
2. Creates git bundles and stores them as DWN records (full, incremental, and squash bundles)
3. On cold start, if no local repo exists, it restores from the latest DWN bundles automatically

## Compatibility Layer

`gitd` includes proxy servers ("shims") that speak native tool protocols and translate them into DWN operations:

| Shim | Protocol | Use Case |
|---|---|---|
| GitHub API | REST API v3 | `gh` CLI, VS Code extensions, CI systems |
| npm | npm registry HTTP API | `npm install`, `bun add`, `yarn add` |
| Go | GOPROXY protocol | `go get`, `go mod download` |
| OCI | OCI Distribution Spec v2 | `docker pull`, `podman pull` |

All shims can run as standalone servers or together via `gitd daemon`.

## Indexer

The indexer crawls DWN records across the network and builds materialized views for discovery:

- **DID discovery** — follows the social graph (stars + follows) to find users and repos
- **Search** — full-text search by name, description, topic, or language
- **Aggregation** — star counts, trending repos, user profiles
- **REST API** — query endpoints for search, trending, user profiles, and stats

Indexers are read-only consumers of published DWN data. Anyone can run one. Multiple indexers can coexist and compete on quality.

## Directory Structure

```
src/
├── cli/              # CLI entry point and subcommands
│   ├── main.ts       # gitd binary entry point
│   └── commands/     # One file per subcommand
├── git-remote/       # git-remote-did and credential helper
├── git-server/       # Smart HTTP server, bundle sync, auth
├── web/              # Read-only web UI (server-rendered HTML)
├── daemon/           # Unified shim daemon with adapter interface
├── github-shim/      # GitHub REST API v3 compatibility
├── shims/            # Package manager shims (npm, go, oci)
├── indexer/          # Indexer service (crawler + REST API)
├── resolver/         # Package resolution and trust chain
└── protocols/        # DWN protocol definitions and schemas
```
