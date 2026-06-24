# gitd

[![CI](https://github.com/enboxorg/gitd/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/enboxorg/gitd/actions/workflows/ci.yml)
[![Coverage](https://coveralls.io/repos/github/enboxorg/gitd/badge.svg?branch=main)](https://coveralls.io/github/enboxorg/gitd?branch=main)
[![npm](https://img.shields.io/npm/v/@enbox/gitd)](https://www.npmjs.com/package/@enbox/gitd)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A decentralized git forge built on [DWN](https://github.com/enboxorg/enbox) protocols.

> **Research preview** — under active development. APIs and CLI may change without notice.

```bash
# install
curl -fsSL https://gitd.sh/install | bash

# read a public repo, no identity setup needed
gitd clone did:dht:abc123/my-project

# create a repo, push code, open a PR — all addressed by DID
gitd auth login
gitd init my-project
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

The installer installs the published `@enbox/gitd` package with Bun, configures
Git's DID remote helper, and bootstraps Bun first if it is not already
available. After it finishes, `gitd clone did:dht:<owner>/<repo>` can read a
public repo without identity setup. Run `gitd auth login` when you want to
create repos, push, open PRs, or write issues.

Or install directly with Bun:

```bash
bun add -g @enbox/gitd
```

This installs three commands:

| Binary | Purpose |
|---|---|
| `gitd` | CLI — forge commands, servers, shims |
| `git-remote-did` | Git remote helper — resolves `did::` URLs |
| `git-remote-did-credential` | Credential helper — DID-signed push tokens |

## Quick Start

```bash
gitd clone did:dht:abc/my-repo  # read a public repo
gitd auth login                 # create or unlock an identity for writes
gitd init my-repo               # create repo record + bare git repo
gitd helper status              # local helper should auto-start as needed
gitd auth sessions              # inspect the active helper session
gitd auth reset default         # archive a broken local identity profile
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
gitd pr create "Add feature" --push   # also publish contributor branch
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

`gitd helper` manages the local Git/DWN helper that native Git uses for DID
remotes. It normally starts automatically when `gitd init`, `gitd clone`,
`git push`, or `git fetch` needs it.

`gitd helper status` shows the active profile, DID, repo cache path, local
capabilities, expiry policy, and repos this helper session has seen. `gitd auth
sessions` shows the same helper as a local Enbox session; `gitd auth revoke
helper` stops it.

If a local identity profile is broken or you forgot its unlock password, use
`gitd auth reset <identity>` to remove it from gitd config and move its local
profile data into `~/.enbox/profile-backups`.

Use `gitd clone did:dht:<owner>/<repo>` for the friendlier clone path. On a
fresh machine, public clones use a hidden local public-read cache instead of
asking you to create an identity. Native Git also works with
`git clone did::did:dht:<owner>/<repo>` for public DWN-backed repos; `gitd
clone` is still the best first clone path because it records repo context and
can print clearer recovery hints.

If you later want to write from a repo cloned through the public-read cache,
run `gitd auth login` and then `gitd auth use <identity>` inside that repo.
Read-only commands continue to work without the write identity.

`gitd publish --public-url <url>` runs the public smart HTTP Git transport with
DID-based authentication and registers a `GitTransport` endpoint.
`gitd serve --public-url <url>` is the lower-level equivalent. Bare `gitd
serve` remains a compatibility alias for starting the local helper, but normal
local Git work should use `gitd helper` or rely on automatic startup.

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
| **Go** | `GOPROXY=http://localhost:4874 go get did.enbox.id/did:dht:abc/my-mod` |
| **OCI** | `docker pull localhost:5555/did:dht:abc/my-image:v1.0.0` |

## Web UI

Server-rendered HTML for browsing repos, issues, PRs, releases, and wiki pages. No client-side JS.

```bash
gitd web --port 3000
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for protocol and system design,
[PLAN.md](./PLAN.md) for the full roadmap, or
[REPO_LEVEL_MVP_PLAN.md](./REPO_LEVEL_MVP_PLAN.md) for the focused public
repo-level GitHub replacement plan and E2E MVP contract. See
[UX_MVP_PLAN.md](./UX_MVP_PLAN.md) for the target Git/GH-like CLI experience.

## Development

```bash
bun install            # install dependencies
bun run build          # typecheck + compile
bun run lint           # eslint (zero warnings)
bun test .spec.ts      # run all tests
```

## License

Apache-2.0
