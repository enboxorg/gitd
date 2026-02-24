/**
 * Git backend — wraps Git CLI commands for bare repository management.
 *
 * Provides a thin abstraction over `git init --bare`, `git upload-pack`, and
 * `git receive-pack` for use by the smart HTTP transport handler.
 *
 * All repositories are stored as bare repos under a configurable base
 * directory, organized by DID:  `<basePath>/<did-hash>/<repo-name>.git`
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { existsSync, mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a GitBackend instance. */
export type GitBackendOptions = {
  /**
   * Base directory for storing bare repositories.
   * Repos are stored as `<basePath>/<did-hash>/<repo>.git`
   */
  basePath: string;
};

/** Readable stream from a git subprocess. */
export type GitProcess = {
  /** The subprocess stdout (pack data). */
  stdout: ReadableStream<Uint8Array>;

  /** The subprocess stdin for writing request data. */
  stdin: WritableStream<Uint8Array>;

  /** Promise that resolves with the exit code when the process completes. */
  exitCode: Promise<number>;
};

// ---------------------------------------------------------------------------
// GitBackend
// ---------------------------------------------------------------------------

/**
 * Manages bare git repositories on the filesystem and spawns git subprocess
 * for smart HTTP transport.
 */
export class GitBackend {
  private readonly _basePath: string;

  public constructor(options: GitBackendOptions) {
    this._basePath = options.basePath;
  }

  /** Get the base path for all repositories. */
  public get basePath(): string {
    return this._basePath;
  }

  /**
   * Compute the filesystem path for a repository.
   *
   * @param did - The DID of the repository owner
   * @param repo - The repository name
   * @returns Absolute path to the bare repo directory
   */
  public repoPath(did: string, repo: string): string {
    const didHash = hashDid(did);
    return join(this._basePath, didHash, `${repo}.git`);
  }

  /**
   * Check whether a repository exists on disk.
   *
   * @param did - The DID of the repository owner
   * @param repo - The repository name
   */
  public exists(did: string, repo: string): boolean {
    const path = this.repoPath(did, repo);
    return existsSync(join(path, 'HEAD'));
  }

  /**
   * Initialize a new bare repository.
   *
   * @param did - The DID of the repository owner
   * @param repo - The repository name
   * @returns The path to the new bare repository
   * @throws If `git init --bare` fails
   */
  public async initRepo(did: string, repo: string): Promise<string> {
    const path = this.repoPath(did, repo);
    mkdirSync(path, { recursive: true });

    const exitCode = await runGit(['init', '--bare', path]);
    if (exitCode !== 0) {
      throw new Error(`git init --bare failed with exit code ${exitCode} for ${path}`);
    }

    return path;
  }

  /**
   * Spawn `git upload-pack` for fetch/clone operations.
   *
   * @param did - The DID of the repository owner
   * @param repo - The repository name
   * @returns A GitProcess with stdin/stdout streams for the subprocess
   * @throws If the repository does not exist
   */
  public uploadPack(did: string, repo: string): GitProcess {
    this._assertRepoExists(did, repo);
    const path = this.repoPath(did, repo);
    return spawnGitService('upload-pack', path);
  }

  /**
   * Spawn `git receive-pack` for push operations.
   *
   * @param did - The DID of the repository owner
   * @param repo - The repository name
   * @returns A GitProcess with stdin/stdout streams for the subprocess
   * @throws If the repository does not exist
   */
  public receivePack(did: string, repo: string): GitProcess {
    this._assertRepoExists(did, repo);
    const path = this.repoPath(did, repo);
    return spawnGitService('receive-pack', path);
  }

  /** Throw if the repo doesn't exist on disk. */
  private _assertRepoExists(did: string, repo: string): void {
    if (!this.exists(did, repo)) {
      throw new Error(`Repository not found: ${did}/${repo}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash a DID to a short filesystem-safe directory name. */
function hashDid(did: string): string {
  return createHash('sha256').update(did).digest('hex').slice(0, 16);
}

/** Run a git command and return the exit code. */
async function runGit(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'pipe' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 128));
  });
}

/**
 * Spawn a git service subprocess (upload-pack or receive-pack) and return
 * web-standard ReadableStream/WritableStream wrappers around its stdio.
 */
function spawnGitService(service: 'upload-pack' | 'receive-pack', repoPath: string): GitProcess {
  const child = spawn('git', [service, '--stateless-rpc', repoPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller): void {
      child.stdout!.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      child.stdout!.on('end', () => controller.close());
      child.stdout!.on('error', (err) => controller.error(err));
    },
  });

  const stdin = new WritableStream<Uint8Array>({
    write(chunk): void {
      child.stdin!.write(chunk);
    },
    close(): void {
      child.stdin!.end();
    },
    abort(): void {
      child.stdin!.destroy();
    },
  });

  const exitCode = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 128));
  });

  return { stdout, stdin, exitCode };
}
