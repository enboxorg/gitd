# dwn-git

A decentralized forge (GitHub alternative) built on [DWN](https://github.com/enboxorg/enbox) protocols. Git is already decentralized — `dwn-git` decentralizes the rest: issues, pull requests, code review, CI status, releases, package registry, and social features.

## Thesis

GitHub centralizes the social layer around git: identity, access control, issue tracking, code review, package hosting, and discovery all depend on a single provider. `dwn-git` replaces that layer with DWN protocols, where:

- **Identity is self-sovereign** — DIDs replace GitHub usernames. Portable across providers.
- **Every user owns their namespace** — your issues, stars, and contributions live on your DWN, not a central server.
- **Access control is protocol-level** — roles (maintainer, triager, contributor) are DWN records with cryptographic authorization.
- **Git transport is DID-addressed** — `git clone did::did:dht:abc123/my-repo` resolves via the DID document.
- **Packages are DID-scoped** — no global namespace squatting, cryptographic provenance by default.
- **Repos are self-healing** — git bundles stored as DWN records enable any host to restore a repo on demand.

## What Works Today

`dwn-git` has a working MVP covering the full lifecycle:

### CLI (`dwn-git`)

```bash
# Setup & transport
dwn-git setup                     # Configure git for DID-based remotes
dwn-git clone did:dht:abc/repo   # Clone via DID resolution
dwn-git init my-repo              # Create a repo record + bare git repo
dwn-git serve                     # Start git transport server with ref sync + bundle sync

# Repository management
dwn-git repo info                 # Show repo metadata + collaborators
dwn-git repo add-collaborator <did> maintainer
dwn-git repo remove-collaborator <did>

# Issues (sequential numbering)
dwn-git issue create "Bug report" # Create issue #1
dwn-git issue show 1              # Show issue details + comments
dwn-git issue comment 1 "On it"  # Add a comment
dwn-git issue close 1             # Close an issue
dwn-git issue reopen 1            # Reopen a closed issue
dwn-git issue list                # List all issues

# Patches (pull requests)
dwn-git patch create "Add X"     # Create patch #1
dwn-git patch show 1              # Show patch details + reviews
dwn-git patch comment 1 "LGTM"  # Add a review comment
dwn-git patch merge 1             # Merge a patch
dwn-git patch close 2             # Close without merging
dwn-git patch reopen 2            # Reopen a closed patch
dwn-git patch list                # List all patches

# Releases
dwn-git release create v1.0.0    # Create a release
dwn-git release show v1.0.0      # Show release details + assets
dwn-git release list              # List releases

# CI / Check suites
dwn-git ci create <commit>       # Create a check suite
dwn-git ci run <suite-id> lint   # Add a check run to a suite
dwn-git ci update <run-id> --status completed --conclusion success
dwn-git ci status                 # Show latest CI status
dwn-git ci show <suite-id>       # Show suite details + runs
dwn-git ci list                   # List recent check suites

# Package registry
dwn-git registry publish my-pkg 1.0.0 ./pkg.tgz
dwn-git registry info my-pkg     # Show package details
dwn-git registry versions my-pkg # List published versions
dwn-git registry list             # List all packages
dwn-git registry yank my-pkg 1.0.0

# Attestations & verification
dwn-git registry attest my-pkg 1.0.0 --claim reproducible-build
dwn-git registry attestations my-pkg 1.0.0
dwn-git registry verify my-pkg 1.0.0 --trusted did:jwk:build-svc

# Package resolution & trust chain
dwn-git registry resolve did:dht:abc/my-pkg@1.0.0
dwn-git registry verify-deps did:dht:abc/my-pkg@1.0.0 --trusted did:jwk:ci

# Wiki
dwn-git wiki create getting-started "Getting Started" --body "# Welcome"
dwn-git wiki show getting-started
dwn-git wiki edit getting-started --body "# Updated"
dwn-git wiki list

# Organizations & teams
dwn-git org create my-org        # Create an organization
dwn-git org info                  # Show org details + members + teams
dwn-git org add-member <did>     # Add a member
dwn-git org add-owner <did>      # Add an owner
dwn-git org team create backend  # Create a team

# Social
dwn-git social star <did>        # Star a repo
dwn-git social stars              # List starred repos
dwn-git social follow <did>      # Follow a user
dwn-git social following          # List followed users

# Notifications
dwn-git notification list         # List notifications
dwn-git notification list --unread
dwn-git notification read <id>   # Mark as read
dwn-git notification clear        # Clear read notifications

# GitHub migration
dwn-git migrate all owner/repo   # Import repo, issues, PRs, releases from GitHub
dwn-git migrate issues owner/repo
dwn-git migrate pulls owner/repo
dwn-git migrate releases owner/repo

# Web UI
dwn-git web                       # Start read-only web UI on port 8080
dwn-git web --port 3000           # Custom port

# Indexer (repo discovery + aggregation)
dwn-git indexer                   # Start indexer on port 8090
dwn-git indexer --seed <did>      # Discover DIDs from a seed user
dwn-git indexer --interval 30     # Crawl every 30 seconds

# Unified daemon — all shims in one process
dwn-git daemon                    # Start all shims with default ports
dwn-git daemon --only github,npm  # Only start specific shims
dwn-git daemon --disable oci      # Disable specific shims
dwn-git daemon --config cfg.json  # Use a config file
dwn-git daemon --list             # List available shim adapters

# Individual shims (standalone mode)
dwn-git github-api                # GitHub API shim on port 8181
dwn-git shim npm                  # npm registry shim on port 4873
dwn-git shim go                   # Go module proxy on port 4874
dwn-git shim oci                  # OCI/Docker registry on port 5555

# Activity & identity
dwn-git log                       # Activity feed (recent issues + patches)
dwn-git whoami                    # Show connected DID
```

### Git Transport

- **Smart HTTP server** — serves `git clone`, `git push` via native git protocol
- **DID-signed push auth** — pushers prove DID ownership, server checks DWN role records
- **Ref mirroring** — branch/tag refs sync to DWN records after each push (enables subscriptions)
- **Bundle sync** — git bundles sync to DWN records after each push (full + incremental + squash)
- **Cold-start restore** — repos auto-restore from DWN bundles when a host has no local copy

### Git Remote Helper

- `git-remote-did` — resolves `did::` URLs to git endpoints via DID document service discovery
- `git-remote-did-credential` — generates DID-signed push tokens for authentication

### Web UI

- Read-only server-rendered HTML interface — no client-side JavaScript, no build step
- **Browse ANY DWN-enabled git repo** by entering a DID — works as a universal viewer
- Landing page at `/` with DID input form; all routes are DID-scoped: `/:did/`, `/:did/issues`, etc.
- Routes: `/:did` (overview), `/:did/issues`, `/:did/issues/:n`, `/:did/patches`, `/:did/patches/:n`, `/:did/releases`, `/:did/wiki`, `/:did/wiki/:slug`
- Remote DWN queries use the SDK's `from` parameter — resolved via the target DID's service endpoints
- Start with `dwn-git web [--port <port>]` (default: 8080, configurable via `DWN_GIT_WEB_PORT`)

### GitHub Migration

- `dwn-git migrate all owner/repo` — import repo metadata, issues, pull requests, and releases
- Supports pagination, error handling, and author attribution
- GitHub author info embedded in body as `[migrated from GitHub — @username]` prefix

### Indexer Service

- Crawls distributed DWN records and builds materialized views for discovery and aggregation
- **DID discovery** — follows the social graph (stars + follows) to find new users and repos
- **Repo search** — full-text search by name, description, topic, or language
- **Star aggregation** — counts stars across DWNs (stars live on each starrer's DWN)
- **Trending repos** — ranked by recent star activity within a time window
- **User profiles** — repo count, total stars received, follower/following counts
- **REST API** — `/api/repos`, `/api/repos/search?q=`, `/api/repos/trending`, `/api/users/:did`, `/api/stats`
- Start with `dwn-git indexer [--port <port>] [--interval <sec>] [--seed <did>]`

### GitHub API Compatibility Shim

- HTTP server that translates GitHub REST API v3 requests into DWN queries and writes
- Allows existing GitHub-compatible tools (VS Code extensions, `gh` CLI, CI systems) to interact with DWN data
- DID is used as the GitHub "owner" in URLs: `GET /repos/:did/:repo/issues`
- 18 endpoints (10 read, 8 write):
  - **Read (GET)**: repo info, issues (list/detail/comments), pulls (list/detail/reviews), releases (list/by-tag), user profile
  - **Write**: create/update issues, create issue comments, create/update/merge pull requests, create pull reviews, create releases
- GitHub-compatible response shapes: numeric IDs, pagination (`Link` header, `per_page`), rate limit headers
- CORS enabled, `X-GitHub-Media-Type: github.v3` header
- Start with `dwn-git github-api [--port <port>]` (default: 8181, configurable via `DWN_GIT_GITHUB_API_PORT`)

### Attestation System

- Third-party build verification via `$immutable` attestation records
- Attestors (CI services, auditors) create signed claims about package versions
- Claims include `reproducible-build`, `code-review`, `security-audit`, etc.
- Optional `sourceCommit` and `sourceRepo` fields link attestations to specific builds
- `dwn-git registry attest <name> <version> --claim <claim>` to create attestations
- `dwn-git registry attestations <name> <version>` to list all attestations
- `dwn-git registry verify <name> <version> [--trusted <did>,...]` to verify integrity

### Package Resolver & Trust Chain

- Resolves DID-scoped packages from remote DWNs: `did:dht:abc123/my-pkg@1.0.0`
- Resolution flow: resolve DID -> query package -> query version -> fetch tarball
- Verification checks: package exists, publisher match, version author, tarball integrity, attestations
- Recursive dependency trust chain validation with cycle detection and depth limiting
- `dwn-git registry resolve <did>/<name>@<version>` to resolve and inspect a remote package
- `dwn-git registry verify-deps <did>/<name>@<version>` to build and verify the full dependency tree
- No central authority — the entire chain is verifiable via DIDs and DWN record signatures

### Package Manager Shims

Local HTTP proxy servers that speak native package manager protocols, resolving DID-scoped packages from DWN records. Each shim acts as a translation layer between standard tooling and the decentralized registry.

**npm registry shim** (`dwn-git shim npm`):
- Serves the npm registry HTTP API on localhost (default port 4873)
- Works with `npm install`, `bun install`, `yarn add`, `pnpm add`
- DID-scoped packages via npm scopes: `npm install --registry=http://localhost:4873 @did:dht:abc123/my-pkg`
- Endpoints: packument (all versions), version metadata, tarball download
- Includes DWN provenance metadata in `_dwn` fields

**Go module proxy shim** (`dwn-git shim go`):
- Serves the GOPROXY protocol on localhost (default port 4874)
- Module paths: `GOPROXY=http://localhost:4874 go get did.enbox.org/did:dht:abc123/my-mod@v1.0.0`
- Endpoints: `/@v/list`, `/@v/{ver}.info`, `/@v/{ver}.mod`, `/@v/{ver}.zip`, `/@latest`
- Generates `go.mod` files with DID-scoped dependency mappings

**OCI/Docker registry shim** (`dwn-git shim oci`):
- Serves the OCI Distribution Spec v2 on localhost (default port 5555)
- Works with `docker pull`, `podman pull`, and any OCI-compatible tool
- Image naming: `docker pull localhost:5555/did:dht:abc123/my-image:v1.0.0`
- Endpoints: `/v2/` version check, manifests (by tag or digest), blobs, tags list
- Content-addressable: manifests include SHA-256 digest headers

### Unified Daemon

Run all ecosystem shims in a single process with `dwn-git daemon`. Each shim runs on its own port and speaks the native protocol of its ecosystem — no custom plugins or wrappers needed.

- **Plugin architecture**: `ShimAdapter` interface makes adding new ecosystems trivial (implement one file, register it)
- **Config-driven**: optional `dwn-git.daemon.json` to set ports and enable/disable shims
- **CLI flags**: `--only github,npm` to run a subset, `--disable oci` to exclude, `--list` to see all adapters
- **Health checks**: every adapter's server responds to `GET /health` with `{ status: 'ok', shim: '<id>' }`
- **Graceful shutdown**: SIGINT/SIGTERM stops all servers cleanly
- **4 built-in adapters**: GitHub API, npm registry, Go module proxy, OCI/Docker registry
- **Extensible**: future adapters (Maven, Cargo/crates.io, PyPI, etc.) implement `ShimAdapter` and plug in

```json
{
  "shims": {
    "github": { "enabled": true, "port": 8181 },
    "npm":    { "enabled": true, "port": 4873 },
    "go":     { "enabled": true, "port": 4874 },
    "oci":    { "enabled": true, "port": 5555 }
  }
}
```

## Architecture

See [PLAN.md](./PLAN.md) for the full architecture document covering:

- Prior art analysis (Radicle, ForgeFed, git-bug)
- 11 composable DWN protocol definitions (repo, refs, issues, patches, CI, releases, registry, social, notifications, wiki, org)
- DID-addressed git remotes and transport
- Decentralized bundle storage (`$squash`, encryption model, cold-start restore)
- DID-scoped package registry
- Namespace-based contribution model (no spam by design)
- Indexer integration patterns
- Identity and access control
- Technical challenges and mitigations
- Implementation roadmap with phased milestones

## Protocols

| Protocol | URI | Purpose |
|---|---|---|
| `forge-repo` | `forge/repo` | Repository metadata, collaborator roles, bundles, settings |
| `forge-refs` | `forge/refs` | Git ref records (branches, tags) for DWN subscriptions |
| `forge-issues` | `forge/issues` | Issues, comments, labels, status changes, assignments |
| `forge-patches` | `forge/patches` | Pull requests, revisions, reviews, merge results |
| `forge-ci` | `forge/ci` | Check suites, check runs, artifacts |
| `forge-releases` | `forge/releases` | Release management, immutable assets, signatures |
| `forge-registry` | `forge/registry` | Package publishing, versions, tarballs, attestations |
| `forge-social` | `forge/social` | Stars, follows, activity feeds |
| `forge-notifications` | `forge/notifications` | Personal notification inbox |
| `forge-wiki` | `forge/wiki` | Collaborative documentation pages |
| `forge-org` | `forge/org` | Organizations, teams, team membership |

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/enboxorg/dwn-git/main/install.sh | bash
```

The installer works on Linux, macOS, and Windows (Git Bash/WSL). It installs
the latest prebuilt release binaries (`dwn-git`, `git-remote-did`, and
`git-remote-did-credential`).

```bash
# Manual install (if you prefer to run steps yourself)
bun add -g @enbox/dwn-git
```

### Sub-path Exports

```typescript
// Protocol definitions and types
import { ForgeRepoProtocol, ForgeIssuesProtocol } from '@enbox/dwn-git';

// Git transport server
import { createGitServer, createBundleSyncer, restoreFromBundles } from '@enbox/dwn-git/git-server';

// Git remote helper utilities
import { parseDidUrl, resolveGitEndpoint } from '@enbox/dwn-git/git-remote';

// Indexer service
import { IndexerStore, IndexerCrawler, handleApiRequest } from '@enbox/dwn-git/indexer';

// GitHub API compatibility shim
import { handleShimRequest, startShimServer } from '@enbox/dwn-git/github-shim';

// Package resolver and trust chain
import { resolveFullPackage, verifyPackageVersion, buildTrustChain } from '@enbox/dwn-git/resolver';

// Package manager shims
import { handleNpmRequest, startNpmShim } from '@enbox/dwn-git/shims/npm';
import { handleGoProxyRequest, startGoShim } from '@enbox/dwn-git/shims/go';
import { handleOciRequest, startOciShim } from '@enbox/dwn-git/shims/oci';
```

## Development

```bash
bun install            # Install dependencies
bun run build          # Build (clean + tsc)
bun run lint           # Lint (ESLint, zero warnings)
bun run lint:fix       # Auto-fix lint issues
bun test               # Run all tests
```

## Security Hardening

Production-hardened with 10 security fixes across all server-facing code:

- **Path traversal protection** — repo names validated, resolved paths confined to base directory
- **Request body size limits** — 1 MB JSON / 50 MB git packs, returns 413 on overflow
- **Bearer token auth** — optional `DWN_GIT_API_TOKEN` for API write endpoints (constant-time comparison)
- **SSRF protection** — DID-resolved URLs blocked from private/loopback IP ranges
- **DID resolution timeouts** — 30s timeout prevents hanging on malicious endpoints
- **XSS protection** — all HTML output escaped in web UI error pages
- **Nonce replay protection** — push auth tokens tracked with TTL eviction
- **Indexer size limits** — configurable caps with FIFO eviction (default 100K repos)
- **Health endpoints** — `GET /health` on all servers for monitoring
- **Port validation** — CLI rejects invalid `--port` values with clear errors

See PLAN.md Section 14 for full details.

## Status

**All phases complete + production hardened** — working MVP with CLI commands for all 11 protocols, git transport, DID-signed push auth, ref mirroring, bundle storage, package registry with attestation system and dependency trust chain verification, GitHub migration tool, read-only web UI, indexer service, GitHub API compatibility shim (read + write), package manager shims (npm, Go, OCI/Docker), unified daemon with `ShimAdapter` plugin architecture, and comprehensive security hardening. 871+ tests across 21 test files. See PLAN.md Section 12 for the full roadmap.

## License

Apache-2.0
