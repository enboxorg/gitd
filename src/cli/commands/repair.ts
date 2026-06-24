/**
 * `gitd repair` — safe local repair for common setup/helper problems.
 *
 * This command intentionally avoids mutating repo data. It repairs the local
 * command wrappers, Git credential helper configuration, and stale/corrupt
 * helper lockfiles. It also repairs dangling bare-repo HEAD refs when an
 * existing default branch can be inferred safely.
 *
 * @module
 */

import type { Dirent } from 'node:fs';

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { repairGitdDwnSqliteStore } from '../dwn-sqlite.js';
import { setupCommand } from './setup.js';

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { flagValue, resolveReposPath } from '../flags.js';
import { lockfilePath, readLockfile } from '../../daemon/lockfile.js';
import { profileDataPath, resolveProfile } from '../../profiles/config.js';

export async function repairCommand(args: string[]): Promise<void> {
  const profileFlag = flagValue(args, '--profile');
  const profileName = resolveProfile(profileFlag) ?? profileFlag;
  const binDir = flagValue(args, '--bin-dir');
  const reposPath = resolveReposPath(args, profileName);

  console.log('Repairing gitd local setup...');
  console.log('');

  await setupCommand([
    ...(binDir ? ['--bin-dir', binDir] : []),
  ]);

  console.log('');
  repairLockfile(undefined, 'legacy/global helper lockfile');
  if (profileName) {
    repairLockfile(profileName, `profile "${profileName}" helper lockfile`);
  }

  console.log('');
  await repairDwnSqlite(profileName);

  console.log('');
  repairBareRepoHeads(reposPath);

  console.log('');
  console.log('Repair complete.');
  console.log('Next: gitd doctor');
}

function repairLockfile(profileName: string | undefined, label: string): void {
  const path = lockfilePath(profileName);
  const existed = existsSync(path);
  const lock = readLockfile(profileName);

  if (lock) {
    console.log(`  [ok] ${label} is active on port ${lock.port}`);
    return;
  }

  if (!existed) {
    console.log(`  [ok] ${label} not present`);
    return;
  }

  if (!existsSync(path)) {
    console.log(`  [fixed] removed stale ${label}`);
    return;
  }

  try {
    unlinkSync(path);
    console.log(`  [fixed] removed invalid ${label}`);
  } catch (err) {
    console.log(`  [warn] could not remove ${label}: ${(err as Error).message}`);
  }
}

async function repairDwnSqlite(profileName: string | undefined): Promise<void> {
  if (!profileName) {
    console.log('  [ok] DWN SQLite store skipped; no active identity');
    return;
  }

  try {
    const result = await repairGitdDwnSqliteStore(profileDataPath(profileName));
    if (result.status === 'missing') {
      console.log(`  [ok] DWN SQLite store not present at ${result.dbPath}`);
      return;
    }

    if (result.status === 'fixed') {
      console.log(`  [fixed] DWN SQLite migrations applied: ${result.appliedMigrations.join(', ')}`);
      return;
    }

    console.log(`  [ok] DWN SQLite migrations current at ${result.dbPath}`);
  } catch (err) {
    console.log(`  [warn] DWN SQLite repair failed: ${(err as Error).message}`);
  }
}

type HeadRepairResult = {
  status : 'ok' | 'fixed' | 'warn';
  detail : string;
};

export function repairBareRepoHead(repoPath: string): HeadRepairResult {
  if (!existsSync(join(repoPath, 'HEAD'))) {
    return { status: 'warn', detail: `not a bare repo: ${repoPath}` };
  }

  if (gitHeadResolves(repoPath)) {
    return { status: 'ok', detail: `${repoPath} HEAD resolves` };
  }

  const branch = inferBareRepoHeadBranch(repoPath);
  if (!branch) {
    return { status: 'warn', detail: `${repoPath} HEAD is dangling and no clear branch exists` };
  }

  const result = spawnSync('git', ['--git-dir', repoPath, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
    stdio   : ['ignore', 'pipe', 'pipe'],
    timeout : 5_000,
  });

  if (result.status !== 0) {
    const message = result.stderr?.toString().trim() || 'unknown error';
    return { status: 'warn', detail: `${repoPath} could not set HEAD to ${branch}: ${message}` };
  }

  return { status: 'fixed', detail: `${repoPath} HEAD -> refs/heads/${branch}` };
}

function repairBareRepoHeads(reposPath: string): void {
  const repos = findBareRepos(reposPath);
  if (repos.length === 0) {
    console.log(`  [ok] no bare repos found under ${reposPath}`);
    return;
  }

  for (const repoPath of repos) {
    const result = repairBareRepoHead(repoPath);
    console.log(`  [${result.status}] ${result.detail}`);
  }
}

function findBareRepos(basePath: string): string[] {
  if (!existsSync(basePath)) { return []; }

  const repos: string[] = [];
  for (const ownerEntry of safeReadDir(basePath)) {
    const ownerPath = join(basePath, ownerEntry.name);
    if (!ownerEntry.isDirectory()) { continue; }

    for (const repoEntry of safeReadDir(ownerPath)) {
      if (!repoEntry.isDirectory() || !repoEntry.name.endsWith('.git')) { continue; }
      const repoPath = join(ownerPath, repoEntry.name);
      if (existsSync(join(repoPath, 'HEAD'))) {
        repos.push(repoPath);
      }
    }
  }

  return repos.sort();
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function gitHeadResolves(repoPath: string): boolean {
  const result = spawnSync('git', ['--git-dir', repoPath, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    stdio   : ['ignore', 'pipe', 'pipe'],
    timeout : 5_000,
  });
  return result.status === 0;
}

function inferBareRepoHeadBranch(repoPath: string): string | undefined {
  const branches = listBareRepoBranches(repoPath);
  if (branches.includes('main')) { return 'main'; }
  if (branches.includes('master')) { return 'master'; }
  if (branches.length === 1) { return branches[0]; }
  return undefined;
}

function listBareRepoBranches(repoPath: string): string[] {
  const result = spawnSync('git', ['--git-dir', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
    timeout  : 5_000,
  });
  if (result.status !== 0) { return []; }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
