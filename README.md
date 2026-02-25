# gitd

A decentralized forge (GitHub alternative) built on [DWN](https://github.com/enboxorg/enbox) protocols. Git is already decentralized — `gitd` decentralizes the rest: issues, pull requests, code review, CI status, releases, package registry, and social features.

## Thesis

GitHub centralizes the social layer around git: identity, access control, issue tracking, code review, package hosting, and discovery all depend on a single provider. `gitd` replaces that layer with DWN protocols, where:

- **Identity is self-sovereign** — DIDs replace GitHub usernames. Portable across providers.
- **Every user owns their namespace** — your issues, stars, and contributions live on your DWN, not a central server.
- **Access control is protocol-level** — roles (maintainer, triager, contributor) are DWN records with cryptographic authorization.
- **Git transport is DID-addressed** — `git clone did::did:dht:abc123/my-repo` resolves via the DID document.
- **Packages are DID-scoped** — no global namespace squatting, cryptographic provenance by default.
- **Repos are self-healing** — git bundles stored as DWN records enable any host to restore a repo on demand.

## What Works Today

`gitd` has a working MVP covering the full lifecycle:

### CLI (`gitd`)

```bash
# Setup & transport
gitd setup                     # Configure git for DID-based remotes
gitd clone did:dht:abc/repo   # Clone via DID resolution
gitd init my-repo              # Create a repo record + bare git repo
gitd serve                     # Start git transport server with ref sync + bundle sync

# Repository management
gitd repo info                 # Show repo metadata + collaborators
gitd repo add-collaborator <did> maintainer
gitd repo remove-collaborator <did>

# Issues (sequential numbering)
gitd issue create "Bug report" # Create issue #1
gitd issue show 1              # Show issue details + comments
gitd issue comment 1 "On it"  # Add a comment
gitd issue close 1             # Close an issue
gitd issue reopen 1            # Reopen a closed issue
gitd issue list                # List all issues

# Patches (pull requests)
gitd patch create "Add X"     # Create patch #1
gitd patch show 1              # Show patch details + reviews
gitd patch comment 1 "LGTM"  # Add a review comment
gitd patch merge 1             # Merge a patch
gitd patch close 2             # Close without merging
gitd patch reopen 2            # Reopen a closed patch
gitd patch list                # List all patches

# Releases
gitd release create v1.0.0    # Create a release
gitd release show v1.0.0      # Show release details + assets
gitd release list              # List releases

# CI / Check suites
gitd ci create <commit>       # Create a check suite
gitd ci run <suite-id> lint   # Add a check run to a suite
gitd ci update <run-id> --status completed --conclusion success
gitd ci status                 # Show latest CI status
gitd ci show <suite-id>       # Show suite details + runs
gitd ci list                   # List recent check suites

# Package registry
gitd registry publish my-pkg 1.0.0 ./pkg.tgz
gitd registry info my-pkg     # Show package details
gitd registry versions my-pkg # List published versions
gitd registry list             # List all packages
gitd registry yank my-pkg 1.0.0

# Attestations & verification
gitd registry attest my-pkg 1.0.0 --claim reproducible-build
gitd registry attestations my-pkg 1.0.0
gitd registry verify my-pkg 1.0.0 --trusted did:jwk:build-svc

# Package resolution & trust chain
gitd registry resolve did:dht:abc/my-pkg@1.0.0
gitd registry verify-deps did:dht:abc/my-pkg@1.0.0 --trusted did:jwk:ci

# Wiki
gitd wiki create getting-started "Getting Started" --body "# Welcome"
gitd wiki show getting-started
gitd wiki edit getting-started --body "# Updated"
gitd wiki list

# Organizations & teams
gitd org create my-org        # Create an organization
gitd org info                  # Show org details + members + teams
gitd org add-member <did>     # Add a member
gitd org add-owner <did>      # Add an owner
gitd org team create backend  # Create a team

# Social
gitd social star <did>        # Star a repo
gitd social stars              # List starred repos
gitd social follow <did>      # Follow a user
gitd social following          # List followed users

# Notifications
gitd notification list         # List notifications
gitd notification list --unread
gitd notification read <id>   # Mark as read
gitd notification clear        # Clear read notifications

# GitHub migration
gitd migrate all owner/repo   # Import repo, issues, PRs, releases from GitHub
gitd migrate issues owner/repo
gitd migrate pulls owner/repo
gitd migrate releases owner/repo

# Web UI
gitd web                       # Start read-only web UI on port 8080
gitd web --port 3000           # Custom port

# Indexer (repo discovery + aggregation)
gitd indexer                   # Start indexer on port 8090
gitd indexer --seed <did>      # Discover DIDs from a seed user
gitd indexer --interval 30     # Crawl every 30 seconds

# Unified daemon — all shims in one process
gitd daemon                    # Start all shims with default ports
gitd daemon --only github,npm  # Only start specific shims
gitd daemon --disable oci      # Disable specific shims
gitd daemon --config cfg.json  # Use a config file
gitd daemon --list             # List available shim adapters

# Individual shims (standalone mode)
gitd github-api                # GitHub API shim on port 8181
gitd shim npm                  # npm registry shim on port 4873
gitd shim go                   # Go module proxy on port 4874
gitd shim oci                  # OCI/Docker registry on port 5555

# Activity & identity
gitd log                       # Activity feed (recent issues + patches)
gitd whoami                    # Show connected DID
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
- Start with `gitd web [--port <port>]` (default: 8080, configurable via `GITD_WEB_PORT`)

### GitHub Migration

- `gitd migrate all owner/repo` — import repo metadata, issues, pull requests, and releases
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
- Start with `gitd indexer [--port <port>] [--interval <sec>] [--seed <did>]`

### GitHub API Compatibility Shim

- HTTP server that translates GitHub REST API v3 requests into DWN queries and writes
- Allows existing GitHub-compatible tools (VS Code extensions, `gh` CLI, CI systems) to interact with DWN data
- DID is used as the GitHub "owner" in URLs: `GET /repos/:did/:repo/issues`
- 18 endpoints (10 read, 8 write):
  - **Read (GET)**: repo info, issues (list/detail/comments), pulls (list/detail/reviews), releases (list/by-tag), user profile
  - **Write**: create/update issues, create issue comments, create/update/merge pull requests, create pull reviews, create releases
- GitHub-compatible response shapes: numeric IDs, pagination (`Link` header, `per_page`), rate limit headers
- CORS enabled, `X-GitHub-Media-Type: github.v3` header
- Start with `gitd github-api [--port <port>]` (default: 8181, configurable via `GITD_GITHUB_API_PORT`)

### Attestation System

- Third-party build verification via `$immutable` attestation records
- Attestors (CI services, auditors) create signed claims about package versions
- Claims include `reproducible-build`, `code-review`, `security-audit`, etc.
- Optional `sourceCommit` and `sourceRepo` fields link attestations to specific builds
- `gitd registry attest <name> <version> --claim <claim>` to create attestations
- `gitd registry attestations <name> <version>` to list all attestations
- `gitd registry verify <name> <version> [--trusted <did>,...]` to verify integrity

### Package Resolver & Trust Chain

- Resolves DID-scoped packages from remote DWNs: `did:dht:abc123/my-pkg@1.0.0`
- Resolution flow: resolve DID -> query package -> query version -> fetch tarball
- Verification checks: package exists, publisher match, version author, tarball integrity, attestations
- Recursive dependency trust chain validation with cycle detection and depth limiting
- `gitd registry resolve <did>/<name>@<version>` to resolve and inspect a remote package
- `gitd registry verify-deps <did>/<name>@<version>` to build and verify the full dependency tree
- No central authority — the entire chain is verifiable via DIDs and DWN record signatures

### Package Manager Shims

Local HTTP proxy servers that speak native package manager protocols, resolving DID-scoped packages from DWN records. Each shim acts as a translation layer between standard tooling and the decentralized registry.

**npm registry shim** (`gitd shim npm`):
- Serves the npm registry HTTP API on localhost (default port 4873)
- Works with `npm install`, `bun install`, `yarn add`, `pnpm add`
- DID-scoped packages via npm scopes: `npm install --registry=http://localhost:4873 @did:dht:abc123/my-pkg`
- Endpoints: packument (all versions), version metadata, tarball download
- Includes DWN provenance metadata in `_dwn` fields

**Go module proxy shim** (`gitd shim go`):
- Serves the GOPROXY protocol on localhost (default port 4874)
- Module paths: `GOPROXY=http://localhost:4874 go get did.enbox.org/did:dht:abc123/my-mod@v1.0.0`
- Endpoints: `/@v/list`, `/@v/{ver}.info`, `/@v/{ver}.mod`, `/@v/{ver}.zip`, `/@latest`
- Generates `go.mod` files with DID-scoped dependency mappings

**OCI/Docker registry shim** (`gitd shim oci`):
- Serves the OCI Distribution Spec v2 on localhost (default port 5555)
- Works with `docker pull`, `podman pull`, and any OCI-compatible tool
- Image naming: `docker pull localhost:5555/did:dht:abc123/my-image:v1.0.0`
- Endpoints: `/v2/` version check, manifests (by tag or digest), blobs, tags list
- Content-addressable: manifests include SHA-256 digest headers

### Unified Daemon

Run all ecosystem shims in a single process with `gitd daemon`. Each shim runs on its own port and speaks the native protocol of its ecosystem — no custom plugins or wrappers needed.

- **Plugin architecture**: `ShimAdapter` interface makes adding new ecosystems trivial (implement one file, register it)
- **Config-driven**: optional `gitd.daemon.json` to set ports and enable/disable shims
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
curl -fsSL https://raw.githubusercontent.com/enboxorg/gitd/main/install.sh | bash
```

The installer works on Linux, macOS, and Windows (Git Bash/WSL). It installs
the latest prebuilt release binaries (`gitd`, `git-remote-did`, and
`git-remote-did-credential`).

```bash
# Manual install (if you prefer to run steps yourself)
bun add -g @enbox/gitd
```

### Sub-path Exports

```typescript
// Protocol definitions and types
import { ForgeRepoProtocol, ForgeIssuesProtocol } from '@enbox/gitd';

// Git transport server
import { createGitServer, createBundleSyncer, restoreFromBundles } from '@enbox/gitd/git-server';

// Git remote helper utilities
import { parseDidUrl, resolveGitEndpoint } from '@enbox/gitd/git-remote';

// Indexer service
import { IndexerStore, IndexerCrawler, handleApiRequest } from '@enbox/gitd/indexer';

// GitHub API compatibility shim
import { handleShimRequest, startShimServer } from '@enbox/gitd/github-shim';

// Package resolver and trust chain
import { resolveFullPackage, verifyPackageVersion, buildTrustChain } from '@enbox/gitd/resolver';

// Package manager shims
import { handleNpmRequest, startNpmShim } from '@enbox/gitd/shims/npm';
import { handleGoProxyRequest, startGoShim } from '@enbox/gitd/shims/go';
import { handleOciRequest, startOciShim } from '@enbox/gitd/shims/oci';
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
- **Bearer token auth** — optional `GITD_API_TOKEN` for API write endpoints (constant-time comparison)
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
