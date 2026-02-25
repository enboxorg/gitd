# Changesets

This project uses [changesets](https://github.com/changesets/changesets) for version management and npm publishing.

## Adding a changeset

When you make a change that should be released, run:

```bash
bun changeset
```

This will prompt you to select the package and the semver bump type (patch, minor, major), then create a markdown file in this directory describing the change.

## How it works

1. PRs include changeset files describing what changed
2. On merge to `main`, the release workflow creates a "Version Packages" PR that bumps versions and updates changelogs
3. When the "Version Packages" PR is merged, the workflow publishes to npm and creates a GitHub Release (which triggers binary artifact builds)
