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
dwn-git init my-repo              # Create a repo record + bare git repo
dwn-git serve                     # Start git transport server with ref sync + bundle sync

dwn-git issue create "Bug report" # Create issue #1 with sequential numbering
dwn-git issue show 1              # Show issue details + comments
dwn-git issue comment 1 "On it"  # Add a comment
dwn-git issue close 1             # Close an issue
dwn-git issue reopen 1            # Reopen a closed issue
dwn-git issue list                # List all issues

dwn-git patch create "Add X"     # Create a patch (pull request) with sequential numbering
dwn-git patch show 1              # Show patch details + reviews
dwn-git patch comment 1 "LGTM"  # Add a review comment
dwn-git patch merge 1             # Merge a patch
dwn-git patch close 2             # Close without merging
dwn-git patch reopen 2            # Reopen a closed patch
dwn-git patch list                # List all patches

dwn-git repo info                 # Show repo metadata + collaborators
dwn-git repo add-collaborator <did> maintainer
dwn-git repo remove-collaborator <did>

dwn-git log                       # Activity feed (recent issues + patches)
dwn-git setup                     # Configure git for DID-based remotes
dwn-git clone did:dht:abc/repo   # Clone via DID resolution
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
bun install @enbox/dwn-git
```

### Sub-path Exports

```typescript
// Protocol definitions and types
import { ForgeRepoProtocol, ForgeIssuesProtocol } from '@enbox/dwn-git';

// Git transport server
import { createGitServer, createBundleSyncer, restoreFromBundles } from '@enbox/dwn-git/git-server';

// Git remote helper utilities
import { parseDidUrl, resolveGitEndpoint } from '@enbox/dwn-git/git-remote';
```

## Development

```bash
bun install            # Install dependencies
bun run build          # Build (clean + tsc)
bun run lint           # Lint (ESLint, zero warnings)
bun run lint:fix       # Auto-fix lint issues
bun test               # Run all tests (453 tests)
```

## Status

**Phase 2 complete** — working MVP with CLI, git transport, DID-signed push auth, ref mirroring, bundle storage, and 453 tests (1147 assertions). See PLAN.md Section 12 for the full roadmap.

## License

Apache-2.0
