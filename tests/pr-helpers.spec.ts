import { describe, expect, it } from 'bun:test';

import { contributorBranchPrefix } from '../src/branch-state.js';
import {
  contributorBranchPublishPlan,
  contributorBranchRefForHead,
  formatPrMergeSummary,
  inferPrBaseBranch,
  inferPrHeadBranch,
  shouldPromptContributorBranchPublish,
  shouldPublishContributorBranch,
} from '../src/cli/commands/pr.js';

function gitFrom(outputs: Record<string, string | null>) {
  return (args: string[]): string | null => outputs[args.join('\0')] ?? null;
}

describe('PR command helpers', () => {
  it('uses an explicit base branch first', () => {
    expect(inferPrBaseBranch({
      explicitBase      : 'release/v1',
      repoDefaultBranch : 'trunk',
      git               : gitFrom({}),
    })).toBe('release/v1');
  });

  it('uses the repo record default branch before local git fallbacks', () => {
    expect(inferPrBaseBranch({
      repoDefaultBranch : 'trunk',
      git               : gitFrom({ ['config\0--get\0enbox.defaultBranch']: 'main' }),
    })).toBe('trunk');
  });

  it('uses local enbox default branch config when repo data is unavailable', () => {
    expect(inferPrBaseBranch({
      git: gitFrom({ ['config\0--get\0enbox.defaultBranch']: 'develop' }),
    })).toBe('develop');
  });

  it('normalizes origin HEAD when local repo config has no default branch', () => {
    expect(inferPrBaseBranch({
      git: gitFrom({
        ['symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD']: 'origin/trunk',
      }),
    })).toBe('trunk');
  });

  it('falls back to an existing conventional local branch', () => {
    expect(inferPrBaseBranch({
      git: gitFrom({
        ['rev-parse\0--verify\0refs/heads/master']: 'abc123',
      }),
    })).toBe('master');
  });

  it('falls back to main when no base signal exists', () => {
    expect(inferPrBaseBranch({ git: gitFrom({}) })).toBe('main');
  });

  it('infers head branch from explicit input, git context, or current branch', () => {
    expect(inferPrHeadBranch('feature/manual', null, gitFrom({}))).toBe('feature/manual');
    expect(inferPrHeadBranch(undefined, { headBranch: 'feature/context' }, gitFrom({}))).toBe('feature/context');
    expect(inferPrHeadBranch(undefined, null, gitFrom({
      ['rev-parse\0--abbrev-ref\0HEAD']: 'feature/current',
    }))).toBe('feature/current');
  });

  it('does not report detached HEAD as a PR head branch', () => {
    expect(inferPrHeadBranch(undefined, { headBranch: 'HEAD' }, gitFrom({
      ['rev-parse\0--abbrev-ref\0HEAD']: 'HEAD',
    }))).toBeUndefined();
  });

  it('maps local PR heads into the actor contributor namespace', () => {
    const did = 'did:dht:alice';
    expect(contributorBranchRefForHead(did, 'feat/demo')).toBe(
      `${contributorBranchPrefix(did)}feat/demo`,
    );
    expect(contributorBranchRefForHead(did, 'refs/heads/feat/demo')).toBe(
      `${contributorBranchPrefix(did)}feat/demo`,
    );
  });

  it('keeps already canonical contributor refs unchanged', () => {
    const did = 'did:dht:alice';
    const ref = `${contributorBranchPrefix(did)}feat/demo`;
    expect(contributorBranchRefForHead(did, ref)).toBe(ref);
    expect(contributorBranchRefForHead(did, ref.slice('refs/heads/'.length))).toBe(ref);
  });

  it('rejects unsafe contributor branch names', () => {
    expect(contributorBranchRefForHead('did:dht:alice', 'bad branch')).toBeUndefined();
    expect(contributorBranchRefForHead('did:dht:alice', '../bad')).toBeUndefined();
    expect(contributorBranchRefForHead('did:dht:alice', 'HEAD')).toBeUndefined();
  });

  it('builds the contributor branch publish command', () => {
    const did = 'did:dht:alice';
    const ref = `${contributorBranchPrefix(did)}feat/demo`;

    expect(contributorBranchPublishPlan(did, 'feat/demo')).toEqual({
      remote      : 'origin',
      refName     : ref,
      refspec     : `HEAD:${ref}`,
      commandText : `git push origin HEAD:${ref}`,
    });
  });

  it('prompts to publish contributor branches only in interactive undecided sessions', () => {
    const plan = contributorBranchPublishPlan('did:dht:alice', 'feat/demo');

    expect(shouldPromptContributorBranchPublish({
      plan,
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    })).toBe(true);

    expect(shouldPromptContributorBranchPublish({
      plan,
      pushRequested : true,
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
    })).toBe(false);

    expect(shouldPromptContributorBranchPublish({
      plan,
      noPush      : true,
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    })).toBe(false);

    expect(shouldPromptContributorBranchPublish({
      plan,
      stdinIsTTY  : false,
      stdoutIsTTY : true,
    })).toBe(false);
  });

  it('uses the interactive contributor branch publish confirmation result', async () => {
    const plan = contributorBranchPublishPlan('did:dht:alice', 'feat/demo');
    expect(plan).toBeDefined();

    const confirmed = await shouldPublishContributorBranch({
      plan,
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    }, async () => true);
    expect(confirmed).toBe(true);

    const declined = await shouldPublishContributorBranch({
      plan,
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    }, async () => false);
    expect(declined).toBe(false);
  });

  it('formats a maintainer merge preflight summary', () => {
    expect(formatPrMergeSummary({
      id          : 'abc1234',
      title       : 'Add feature',
      actorDid    : 'did:dht:maintainer',
      ownerDid    : 'did:dht:owner',
      repoName    : 'demo',
      baseBranch  : 'main',
      headBranch  : 'feature',
      strategy    : 'squash',
      commitCount : 2,
    })).toEqual([
      'Merging PR abc1234: Add feature',
      '  Repo:     did:dht:owner/demo',
      '  Actor:    did:dht:maintainer',
      '  Base:     main',
      '  Head:     feature',
      '  Strategy: squash',
      '  Commits:  2 commits',
    ]);
  });
});
