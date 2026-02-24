# CLAUDE.md — Agent Instructions for dwn-git

## Workflow: Git Worktrees

All work MUST be done in fresh git worktrees. Never work directly on `main`.

### Starting work

1. Ensure an issue exists (or create one) for the work being done.
2. Create a fresh worktree from the latest `main`:
   ```sh
   git fetch origin
   git worktree add ../dwn-git-<short-name> -b <branch-name> origin/main
   ```
   Branch naming: `feat/<topic>`, `fix/<topic>`, or `chore/<topic>`.
3. Work inside the worktree directory for all changes.

### Before asking to move forward

Every PR must pass all of these before requesting review:

```sh
bun run build          # Zero TypeScript errors
bun test .spec.ts      # All tests pass
bun run lint           # Zero ESLint warnings/errors (--max-warnings 0)
```

All new or changed behavior must have corresponding tests. Do not skip tests.

### Submitting work

1. Commit with clear, conventional commit messages (`feat:`, `fix:`, `refactor:`, `chore:`, `test:`, `docs:`).
2. Push the branch and open a PR with `gh pr create`. The PR body must include:
   - A summary of what changed and why.
   - Confirmation that build, test, and lint all pass.
3. Do NOT ask to move forward until the PR is open and all checks pass.

### After merge

1. Delete the worktree and the local branch:
   ```sh
   git worktree remove ../dwn-git-<short-name>
   git branch -d <branch-name>
   ```
2. New work starts in a new fresh worktree. Never reuse old worktrees.

## Project Context

- **Language**: TypeScript (ESM-only, `"type": "module"`).
- **Runtime**: Bun.
- **Build**: `bun run build` (`tsc` via `build:esm`).
- **Test**: `bun test .spec.ts`.
- **Lint**: `bun run lint` (ESLint with `@typescript-eslint`, `@stylistic`, `--max-warnings 0`).
- **SDK**: Uses `@enbox/api`, `@enbox/crypto`, `@enbox/dids`, `@enbox/dwn-sdk-js`. Never reference `@web5/*` or `tbddev.org`.
- **Exports**: Single entry point via `./dist/esm/index.js`. CLI binaries: `dwn-git`, `git-remote-did`, `git-remote-did-credential`.
- **Style**: Explicit return types required (`@typescript-eslint/explicit-function-return-type`). Colon-aligned key-spacing. Single quotes. Semicolons required.

## Rules

- No workarounds. Fix root causes.
- No monkey-patching SDK internals.
- No hardcoded DIDs or gateway URLs in source code. Use env vars.
- No committing secrets (`.env`, credentials, private keys).
- Keep PRs focused. One concern per PR.
