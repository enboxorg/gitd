/**
 * Preflight check tests — git dependency detection and version parsing.
 */
import { describe, expect, it } from 'bun:test';

import { checkGit, parseGitVersion } from '../src/cli/preflight.js';

import type { GitCheck } from '../src/cli/preflight.js';

// ---------------------------------------------------------------------------
// parseGitVersion
// ---------------------------------------------------------------------------

describe('parseGitVersion', () => {
  it('should parse standard git version output', () => {
    expect(parseGitVersion('git version 2.39.2')).toBe('2.39.2');
  });

  it('should parse Windows git version output', () => {
    expect(parseGitVersion('git version 2.39.2.windows.1')).toBe('2.39.2');
  });

  it('should parse Apple Git version output', () => {
    expect(parseGitVersion('git version 2.39.2 (Apple Git-143)')).toBe('2.39.2');
  });

  it('should parse old git version', () => {
    expect(parseGitVersion('git version 1.8.3')).toBe('1.8.3');
  });

  it('should return null for unparseable output', () => {
    expect(parseGitVersion('not a version string')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseGitVersion('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkGit (live — runs against the real system)
// ---------------------------------------------------------------------------

describe('checkGit', () => {
  it('should detect the system git installation', () => {
    // This test runs in CI / dev environments where git is always present.
    const result: GitCheck = checkGit();

    expect(result.installed).toBe(true);
    expect(result.version).not.toBeNull();
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);

    // Any modern git should meet the 2.28.0 minimum.
    expect(result.meetsMinimum).toBe(true);
  });
});
