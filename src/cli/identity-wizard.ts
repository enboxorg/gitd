/**
 * First-run identity setup prompts for commands that need write authority.
 *
 * The CLI can still create the default profile implicitly for scripts that set
 * `GITD_PASSWORD`, but humans should see an explicit identity setup flow before
 * the first repo/issue/PR/moderation command.
 *
 * @module
 */

import * as p from '@clack/prompts';

import { connectAgent } from './agent.js';
import { flagValue } from './flags.js';
import { listProfiles, profileDataPath } from '../profiles/config.js';
import {
  normalizeIdentityNameInput,
  suggestIdentityName,
  validateIdentityNameInput,
} from './commands/auth.js';
import { printImplicitRecoveryPhrase, recordConnectedProfile } from './profile-session.js';

const IDENTITY_COMMANDS = new Set([
  'init',
  'repo',
  'issue',
  'pr',
  'patch',
  'mod',
  'helper',
  'publish',
  'serve',
  'release',
  'ci',
  'registry',
  'wiki',
  'org',
  'social',
  'notification',
  'migrate',
  'web',
  'daemon',
  'indexer',
  'github-api',
  'shim',
  'whoami',
]);

export type FirstIdentityPromptOptions = {
  commandName : string;
  args?: readonly string[];
  profileFlag?: string;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  identityCount?: number;
};

export type FirstIdentitySetup = {
  profileName : string;
  dataPath : string;
  password : string;
  recoveryPhrase?: string;
};

export function commandNeedsIdentity(commandName: string): boolean {
  return IDENTITY_COMMANDS.has(commandName);
}

export function hasAmbientIdentitySelection(
  profileFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(profileFlag || env.GITD_PROFILE || env.ENBOX_PROFILE);
}

export function shouldPromptForFirstIdentitySetup(options: FirstIdentityPromptOptions): boolean {
  if (!commandNeedsIdentity(options.commandName)) { return false; }
  if (options.env?.GITD_PASSWORD) { return false; }
  if (hasAmbientIdentitySelection(options.profileFlag, options.env)) { return false; }
  if (options.identityCount !== 0) { return false; }
  if (!options.stdinIsTTY || !options.stdoutIsTTY) { return false; }
  return true;
}

export function firstIdentityPermissionSummary(commandName: string): string[] {
  const action = commandName === 'whoami'
    ? 'show your active DID'
    : `continue with \`gitd ${commandName}\``;
  return [
    `gitd needs an identity to ${action}.`,
    'It will use this identity to sign gitd records and local Git operations.',
    'The local helper session can be inspected with `gitd auth sessions` and revoked with `gitd auth revoke helper`.',
  ];
}

export async function maybePromptForFirstIdentitySetup(
  commandName: string,
  args: string[],
  profileFlag = flagValue(args, '--profile'),
): Promise<FirstIdentitySetup | undefined> {
  const existingProfiles = listProfiles();
  if (!shouldPromptForFirstIdentitySetup({
    commandName,
    args,
    profileFlag,
    env           : process.env,
    stdinIsTTY    : process.stdin.isTTY,
    stdoutIsTTY   : process.stdout.isTTY,
    identityCount : existingProfiles.length,
  })) {
    return undefined;
  }

  p.intro('First identity');
  for (const line of firstIdentityPermissionSummary(commandName)) {
    p.log.info(line);
  }

  const defaultName = suggestIdentityName(existingProfiles);
  const action = await p.select({
    message : 'How would you like to set up this identity?',
    options : [
      { value: 'create', label: 'Create a new identity' },
      { value: 'import', label: 'Import from recovery phrase' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Cancelled.');
    process.exit(130);
  }

  const name = await p.text({
    message      : 'Name this identity:',
    defaultValue : defaultName,
    placeholder  : defaultName,
    validate(val) {
      return validateIdentityNameInput(val, existingProfiles, defaultName);
    },
  });

  if (p.isCancel(name)) {
    p.cancel('Cancelled.');
    process.exit(130);
  }

  const password = await p.password({
    message: 'Create a password to unlock gitd:',
    validate(val) {
      if (!val || (val as string).length < 4) { return 'Password must be at least 4 characters.'; }
    },
  });

  if (p.isCancel(password)) {
    p.cancel('Cancelled.');
    process.exit(130);
  }

  let recoveryPhrase: string | undefined;
  if (action === 'import') {
    const phrase = await p.text({
      message     : 'Enter your 12-word recovery phrase:',
      placeholder : 'abandon ability able about above absent ...',
      validate(val) {
        if (!val) { return 'Recovery phrase is required.'; }
        const words = val.trim().split(/\s+/);
        if (words.length !== 12) { return 'Recovery phrase must be exactly 12 words.'; }
      },
    });

    if (p.isCancel(phrase)) {
      p.cancel('Cancelled.');
      process.exit(130);
    }

    recoveryPhrase = (phrase as string).trim();
  }

  const profileName = normalizeIdentityNameInput(name as string, defaultName);
  return {
    profileName,
    dataPath : profileDataPath(profileName),
    password : password as string,
    ...(recoveryPhrase ? { recoveryPhrase } : {}),
  };
}

export async function createFirstIdentityFromSetup(setup: FirstIdentitySetup): Promise<void> {
  const ctx = await connectAgent({
    password       : setup.password,
    dataPath       : setup.dataPath,
    recoveryPhrase : setup.recoveryPhrase,
    sync           : 'off',
  });

  try {
    const recordedProfile = recordConnectedProfile(setup.profileName, ctx.did);
    if (recordedProfile.created && ctx.recoveryPhrase) {
      printImplicitRecoveryPhrase(recordedProfile.name, ctx.recoveryPhrase);
      console.log('');
    }
  } finally {
    try {
      await ctx.close?.();
    } catch (err) {
      console.error(`[agent] Could not release local identity resources: ${(err as Error).message}`);
    }
  }
}
