import { describe, expect, it } from 'bun:test';

import {
  commandNeedsIdentity,
  firstIdentityPermissionSummary,
  hasAmbientIdentitySelection,
  shouldPromptForFirstIdentitySetup,
} from '../src/cli/identity-wizard.js';

describe('first-run identity wizard helpers', () => {
  it('identifies commands that need an identity', () => {
    expect(commandNeedsIdentity('init')).toBe(true);
    expect(commandNeedsIdentity('pr')).toBe(true);
    expect(commandNeedsIdentity('mod')).toBe(true);
    expect(commandNeedsIdentity('helper')).toBe(true);
    expect(commandNeedsIdentity('clone')).toBe(false);
    expect(commandNeedsIdentity('setup')).toBe(false);
  });

  it('prompts for a fresh interactive write command', () => {
    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo'],
      env           : {},
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(true);
  });

  it('does not prompt when automation provides the password', () => {
    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo'],
      env           : { GITD_PASSWORD: 'secret' },
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(false);
  });

  it('does not prompt when an identity already exists or is selected explicitly', () => {
    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo'],
      env           : {},
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 1,
    })).toBe(false);

    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo'],
      profileFlag   : 'work',
      env           : {},
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(false);
  });

  it('does not prompt in non-interactive sessions or read-only clone commands', () => {
    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo'],
      env           : {},
      stdinIsTTY    : false,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(false);

    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'clone',
      args          : ['did:dht:abc/demo'],
      env           : {},
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(false);
  });

  it('prompts for init metadata-only creation because it still writes repo records', () => {
    expect(shouldPromptForFirstIdentitySetup({
      commandName   : 'init',
      args          : ['demo', '--no-local'],
      env           : {},
      stdinIsTTY    : true,
      stdoutIsTTY   : true,
      identityCount : 0,
    })).toBe(true);
  });

  it('respects ambient profile environment variables', () => {
    expect(hasAmbientIdentitySelection(undefined, { GITD_PROFILE: 'work' })).toBe(true);
    expect(hasAmbientIdentitySelection(undefined, { ENBOX_PROFILE: 'work' })).toBe(true);
    expect(hasAmbientIdentitySelection('work', {})).toBe(true);
    expect(hasAmbientIdentitySelection(undefined, {})).toBe(false);
  });

  it('formats a permission summary in user-facing identity language', () => {
    expect(firstIdentityPermissionSummary('pr')).toEqual([
      'gitd needs an identity to continue with `gitd pr`.',
      'It will use this identity to sign gitd records and local Git operations.',
      'The local helper session can be inspected with `gitd auth sessions` and revoked with `gitd auth revoke helper`.',
    ]);
  });
});
