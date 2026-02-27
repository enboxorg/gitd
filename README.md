# gitd

> **Research preview** — this project is under active development and not yet ready for production use. APIs, protocols, and CLI commands may change without notice.

A decentralized forge (GitHub alternative) built on [DWN](https://github.com/enboxorg/enbox) protocols. Git is already decentralized — `gitd` decentralizes the rest: issues, pull requests, code review, CI status, releases, package registry, and social features.

## Why

GitHub centralizes the social layer around git: identity, access control, issue tracking, code review, package hosting, and discovery all depend on a single provider. `gitd` replaces that layer with DWN protocols, where:

- **Identity is self-sovereign** — DIDs replace GitHub usernames. Portable across providers.
- **Every user owns their data** — your issues, stars, and contributions live on your DWN, not a central server.
- **Access control is protocol-level** — roles (maintainer, triager, contributor) are DWN records with cryptographic authorization.
- **Git transport is DID-addressed** — `git clone did::did:dht:abc123/my-repo` resolves via the DID document.
- **Packages are DID-scoped** — no global namespace squatting, cryptographic provenance by default.
- **Repos are self-healing** — git bundles stored as DWN records enable any host to restore a repo on demand.

## Install

```bash
curl -fsSL https://gitd.sh/install | bash
```

Installs prebuilt binaries for Linux, macOS, and Windows (Git Bash/WSL). Three binaries are installed:

| Binary | Purpose |
|---|---|
| `gitd` | Main CLI — forge commands, servers, shims |
| `git-remote-did` | Git remote helper — resolves `did::` URLs to git endpoints |
| `git-remote-did-credential` | Git credential helper — generates DID-signed push tokens |

```bash
# Or install via bun/npm
bun add -g @enbox/gitd
```

## CLI

```bash
# Setup & transport
gitd setup                     # Configure git for DID-based remotes
gitd clone did:dht:abc/repo    # Clone via DID resolution
gitd init my-repo              # Create a repo record + bare git repo
gitd serve                     # Start git transport server

# Issues
gitd issue create "Bug report"
gitd issue show 1
gitd issue comment 1 "On it"
gitd issue close 1
gitd issue list

# Pull requests (alias: gitd patch)
gitd pr create "Add feature"
gitd pr show 1
gitd pr comment 1 "LGTM"
gitd pr merge 1
gitd pr list

# Releases
gitd release create v1.0.0
gitd release show v1.0.0
gitd release list

# CI / Check suites
gitd ci create <commit>
gitd ci run <suite-id> lint
gitd ci update <run-id> --status completed --conclusion success
gitd ci status

# Package registry
gitd registry publish my-pkg 1.0.0 ./pkg.tgz
gitd registry info my-pkg
gitd registry verify my-pkg 1.0.0 --trusted did:jwk:build-svc

# Wiki, orgs, social, notifications
gitd wiki create getting-started "Getting Started"
gitd org create my-org
gitd social star <did>
gitd notification list

# GitHub migration
gitd migrate all owner/repo    # Import repo, issues, PRs, releases

# Web UI & services
gitd web                       # Read-only web UI
gitd indexer                   # Repo discovery + search service
gitd daemon                    # Unified shim daemon (GitHub API, npm, Go, OCI)
gitd whoami                    # Show connected DID
```

## Git Transport

- **Smart HTTP server** — `git clone` and `git push` via native git protocol
- **DID-signed push auth** — pushers prove DID ownership, server checks DWN role records
- **Ref mirroring** — branch/tag refs sync to DWN records after each push
- **Bundle sync** — git bundles sync to DWN records after each push (full, incremental, and squash)
- **Cold-start restore** — repos auto-restore from DWN bundles when a host has no local copy

## Web UI

Server-rendered HTML interface for browsing any DWN-enabled git repo. Enter a DID to browse their repos, issues, patches, releases, and wiki pages. No client-side JavaScript.

```bash
gitd web --port 3000
```

## Compatibility Shims

Local proxy servers that translate native tool protocols into DWN queries, so existing tools work without modification:

- **GitHub API** (`gitd github-api`) — GitHub REST API v3 compatible; works with `gh` CLI, VS Code extensions, CI systems
- **npm** (`gitd shim npm`) — `npm install --registry=http://localhost:4873 @did:dht:abc/my-pkg`
- **Go** (`gitd shim go`) — `GOPROXY=http://localhost:4874 go get did.enbox.org/did:dht:abc/my-mod`
- **OCI/Docker** (`gitd shim oci`) — `docker pull localhost:5555/did:dht:abc/my-image:v1.0.0`

Run all shims in one process with `gitd daemon`, or start them individually.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a high-level overview of protocols, transport, and system design. See [PLAN.md](./PLAN.md) for the full implementation plan with detailed protocol definitions and roadmap.

## Development

```bash
bun install            # Install dependencies
bun run build          # Build (clean + tsc)
bun run lint           # Lint (ESLint, zero warnings)
bun test .spec.ts      # Run all tests
```

## License

Apache-2.0
