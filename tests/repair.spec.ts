import { afterEach, describe, expect, it } from 'bun:test';

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { repairBareRepoHead } from '../src/cli/commands/repair.js';

const BASE = resolve('__TESTDATA__/repair');

function git(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
  });
  expect(result.status, result.stderr).toBe(0);
}

function gitOutput(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function createBareRepoWithBranch(repoName: string, branchName: string): string {
  const barePath = resolve(BASE, `${repoName}.git`);
  const workPath = resolve(BASE, `${repoName}-work`);

  git(['init', '--bare', barePath]);
  git(['init', '-b', branchName, workPath]);
  writeFileSync(resolve(workPath, 'README.md'), 'hello\n');
  git(['config', 'user.email', 'test@example.com'], workPath);
  git(['config', 'user.name', 'Test User'], workPath);
  git(['add', 'README.md'], workPath);
  git(['commit', '-m', 'initial'], workPath);
  git(['remote', 'add', 'origin', barePath], workPath);
  git(['push', '-u', 'origin', branchName], workPath);

  return barePath;
}

describe('repairBareRepoHead', () => {
  afterEach(() => {
    rmSync(BASE, { recursive: true, force: true });
  });

  it('repairs a dangling HEAD to main when main exists', () => {
    mkdirSync(BASE, { recursive: true });
    const barePath = createBareRepoWithBranch('main-repo', 'main');
    git(['--git-dir', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/master']);

    const result = repairBareRepoHead(barePath);

    expect(result.status).toBe('fixed');
    expect(gitOutput(['--git-dir', barePath, 'symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });

  it('repairs a dangling HEAD to the only branch when main and master are absent', () => {
    mkdirSync(BASE, { recursive: true });
    const barePath = createBareRepoWithBranch('trunk-repo', 'trunk');
    git(['--git-dir', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/master']);

    const result = repairBareRepoHead(barePath);

    expect(result.status).toBe('fixed');
    expect(gitOutput(['--git-dir', barePath, 'symbolic-ref', '--short', 'HEAD'])).toBe('trunk');
  });

  it('warns instead of guessing when multiple non-default branches exist', () => {
    mkdirSync(BASE, { recursive: true });
    const barePath = createBareRepoWithBranch('ambiguous-repo', 'feature-a');
    const workPath = resolve(BASE, 'ambiguous-repo-work');
    git(['checkout', '-b', 'feature-b'], workPath);
    writeFileSync(resolve(workPath, 'OTHER.md'), 'other\n');
    git(['add', 'OTHER.md'], workPath);
    git(['commit', '-m', 'other'], workPath);
    git(['push', 'origin', 'feature-b'], workPath);
    git(['--git-dir', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/missing']);

    const result = repairBareRepoHead(barePath);

    expect(result.status).toBe('warn');
    expect(gitOutput(['--git-dir', barePath, 'symbolic-ref', '--short', 'HEAD'])).toBe('missing');
  });
});
