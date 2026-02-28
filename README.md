# gitd

[![CI](https://github.com/enboxorg/gitd/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/enboxorg/gitd/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/enboxorg/gitd/graph/badge.svg)](https://codecov.io/gh/enboxorg/gitd)
[![npm](https://img.shields.io/npm/v/@enbox/gitd)](https://www.npmjs.com/package/@enbox/gitd)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A decentralized git forge built on [DWN](https://github.com/enboxorg/enbox) protocols.

> **Research preview** — under active development. APIs and CLI may change without notice.

```bash
# install
curl -fsSL https://gitd.sh/install | bash

# create a repo, push code, open a PR — all addressed by DID
gitd setup
gitd init my-project
git clone did::did:dht:abc123/my-project
# ... make changes ...
git push
gitd pr create "Add feature"
gitd pr merge a1b2c3d
```

---

## Install

```bash
curl -fsSL https://gitd.sh/install | bash
```

Or via bun / npm:

```bash
bun add -g @enbox/gitd
```

This installs three binaries:

| Binary | Purpose |
|---|---|
| `gitd` | CLI — forge commands, servers, shims |
| `git-remote-did` | Git remote helper — resolves `did::` URLs |
| `git-remote-did-credential` | Credential helper — DID-signed push tokens |

## Quick Start

```bash
gitd setup                      # configure git for DID remotes
gitd init my-repo               # create repo record + bare git repo
gitd serve                      # start git transport server
git clone did::did:dht:abc/my-repo
```

## CLI Reference

### Issues

```bash
gitd issue create "Bug report"
gitd issue list
gitd issue show a1b2c3d
gitd issue comment a1b2c3d "On it"
gitd issue close a1b2c3d
```

### Pull Requests

```bash
gitd pr create "Add feature"
gitd pr list
gitd pr show a1b2c3d
gitd pr checkout a1b2c3d
gitd pr comment a1b2c3d "LGTM"
gitd pr merge a1b2c3d
```

### Releases

```bash
gitd release create v1.0.0
gitd release list
```

### CI / Check Suites

```bash
gitd ci create <commit>
gitd ci run <suite-id> lint
gitd ci update <run-id> --status completed --conclusion success
gitd ci status
```

### Packages

```bash
gitd registry publish my-pkg 1.0.0 ./pkg.tgz
gitd registry info my-pkg
gitd registry verify my-pkg 1.0.0 --trusted did:jwk:build-svc
```

### More

```bash
gitd wiki create getting-started "Getting Started"
gitd org create my-org
gitd social star <did>
gitd notification list
gitd migrate all owner/repo     # import from GitHub
gitd whoami                     # show connected DID
```

## Git Transport

`gitd serve` runs a smart HTTP git server with DID-based authentication.

- Clone and push via native git protocol
- Pushers prove DID ownership; server checks DWN role records
- Refs and git bundles sync to DWN after each push
- Repos auto-restore from DWN bundles on cold start

## Compatibility Shims

Local proxies that let existing tools talk to DWN without modification. Run them all with `gitd daemon`, or individually:

| Shim | Example |
|---|---|
| **GitHub API** | `gh repo view did:dht:abc/my-repo` |
| **npm** | `npm install --registry=http://localhost:4873 @did:dht:abc/my-pkg` |
| **Go** | `GOPROXY=http://localhost:4874 go get did.enbox.org/did:dht:abc/my-mod` |
| **OCI** | `docker pull localhost:5555/did:dht:abc/my-image:v1.0.0` |

## Web UI

Server-rendered HTML for browsing repos, issues, PRs, releases, and wiki pages. No client-side JS.

```bash
gitd web --port 3000
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for protocol and system design, or [PLAN.md](./PLAN.md) for the full roadmap.

## Development

```bash
bun install            # install dependencies
bun run build          # typecheck + compile
bun run lint           # eslint (zero warnings)
bun test .spec.ts      # run all tests
```

## License

Apache-2.0
