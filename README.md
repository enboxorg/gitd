# dwn-git

A decentralized forge (GitHub alternative) built on [DWN](https://github.com/enboxorg/enbox) protocols. Git is already decentralized — `dwn-git` decentralizes the rest: issues, pull requests, code review, CI status, releases, package registry, and social features.

## Thesis

GitHub centralizes the social layer around git: identity, access control, issue tracking, code review, package hosting, and discovery all depend on a single provider. `dwn-git` replaces that layer with DWN protocols, where:

- **Identity is self-sovereign** — DIDs replace GitHub usernames. Portable across providers.
- **Every user owns their namespace** — your issues, stars, and contributions live on your DWN, not a central server.
- **Access control is protocol-level** — roles (maintainer, triager, contributor) are DWN records with cryptographic authorization.
- **Git transport is DID-addressed** — `git remote add origin did:dht:abc123` resolves via the DID document.
- **Packages are DID-scoped** — no global namespace squatting, cryptographic provenance by default.

## Architecture

See [PLAN.md](./PLAN.md) for the full architecture document covering:

- Prior art analysis (Radicle, ForgeFed, git-bug)
- 10 composable DWN protocol definitions (repo, issues, patches, CI, releases, registry, social, notifications, wiki, org)
- DID-addressed git remotes and transport
- DID-scoped package registry
- Namespace-based contribution model (no spam by design)
- Indexer integration patterns
- Identity and access control
- Technical challenges and mitigations
- Implementation roadmap with phased milestones

## Status

**Phase: Design** — protocol definitions and architecture are being refined. No implementation yet.

## License

Apache-2.0
