# @enbox/gitd

## 0.1.1

### Patch Changes

- [#57](https://github.com/enboxorg/gitd/pull/57) [`19ac7f3`](https://github.com/enboxorg/gitd/commit/19ac7f3d29f147e8b1dc7f53225ffc63900b23fc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `--version` flag and hide password input in the terminal

- [#58](https://github.com/enboxorg/gitd/pull/58) [`7e8ce08`](https://github.com/enboxorg/gitd/commit/7e8ce08ac225d8db6f7062f63107aa395ba970d8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix process hang after one-shot CLI commands by calling process.exit(0)

## 0.1.0

### Minor Changes

- [#55](https://github.com/enboxorg/gitd/pull/55) [`31f9772`](https://github.com/enboxorg/gitd/commit/31f9772b14046b5e158aa1a37bbe2354323c93d4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Auto-detect GitHub auth from `gh` CLI and infer owner/repo from local git remotes for the migrate command

## 0.0.3

### Patch Changes

- [#52](https://github.com/enboxorg/gitd/pull/52) [`dc971e4`](https://github.com/enboxorg/gitd/commit/dc971e4e41607a09cb3f4eb5f8061981490c3b7e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add classic-level to trustedDependencies so bun runs its native postinstall script during install

## 0.0.2

### Patch Changes

- [#48](https://github.com/enboxorg/gitd/pull/48) [`c4d7575`](https://github.com/enboxorg/gitd/commit/c4d75754ce7f54c393abae5d2c3cbf19977f6f3e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Initial npm release of gitd — a decentralized forge (GitHub alternative) built on DWN protocols.
