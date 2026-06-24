import { describe, expect, it } from 'bun:test';

import { issueCommandPositionals, issueCommentInputs, issueCreateInputs } from '../src/cli/commands/issue.js';
import { positionalArgs, shouldPromptForMissingInput } from '../src/cli/command-input.js';
import { repoCommandPositionals, repoRoleInputs } from '../src/cli/commands/repo.js';

describe('command wizard input helpers', () => {
  it('extracts positionals without treating flag values as positionals', () => {
    expect(positionalArgs([
      '--repo',
      'demo',
      'did:dht:alice',
      '--alias',
      'Alice',
      'contributor',
    ], new Set(['--alias', '--repo']))).toEqual(['did:dht:alice', 'contributor']);

    expect(positionalArgs(['--repo=demo', 'Title', '--', '--literal'], new Set(['--repo']))).toEqual([
      'Title',
      '--literal',
    ]);
  });

  it('only prompts for missing input in an interactive terminal', () => {
    expect(shouldPromptForMissingInput(undefined, {
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    })).toBe(true);
    expect(shouldPromptForMissingInput('value', {
      stdinIsTTY  : true,
      stdoutIsTTY : true,
    })).toBe(false);
    expect(shouldPromptForMissingInput(undefined, {
      stdinIsTTY  : false,
      stdoutIsTTY : true,
    })).toBe(false);
  });

  it('parses issue create and comment inputs around repo/owner flags', () => {
    expect(issueCommandPositionals([
      '--repo',
      'demo',
      '--owner',
      'did:dht:owner',
      'Bug report',
      '--body',
      'Broken',
    ])).toEqual(['Bug report']);

    expect(issueCreateInputs([
      '--body',
      'Broken',
      '--repo',
      'demo',
      'Bug report',
    ])).toEqual({
      title : 'Bug report',
      body  : 'Broken',
    });

    expect(issueCommentInputs([
      '--repo',
      'demo',
      'abc1234',
      'Looks',
      'good',
      '--owner',
      'did:dht:owner',
    ])).toEqual({
      id   : 'abc1234',
      body : 'Looks good',
    });
  });

  it('parses repo role inputs around alias and repo flags', () => {
    expect(repoCommandPositionals([
      '--repo',
      'demo',
      'did:dht:alice',
      '--alias',
      'Alice',
      'maintainer',
    ])).toEqual(['did:dht:alice', 'maintainer']);

    expect(repoRoleInputs([
      '--repo',
      'demo',
      'did:dht:alice',
      'contributor',
      '--alias',
      'Alice',
    ])).toEqual({
      did  : 'did:dht:alice',
      role : 'contributor',
    });
  });
});
