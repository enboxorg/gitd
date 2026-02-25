/**
 * `gitd auth` — identity and profile management.
 *
 * Usage:
 *   gitd auth                          Show current identity info
 *   gitd auth login                    Create or import an identity
 *   gitd auth list                     List all profiles
 *   gitd auth use <profile>            Set profile for current repo
 *   gitd auth use <profile> --global   Set default profile
 *   gitd auth export [profile]         Export portable identity
 *   gitd auth import                   Import from recovery phrase
 *   gitd auth logout [profile]         Remove a profile
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import * as p from '@clack/prompts';

import { connectAgent } from '../agent.js';
import {
  enboxHome,
  listProfiles,
  profileDataPath,
  readConfig,
  resolveProfile,
  setGitConfigProfile,
  upsertProfile,
  writeConfig,
} from '../../profiles/config.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

/**
 * The auth command can run without a pre-existing AgentContext (for `login`,
 * `list`), but some sub-commands need one (for `export`).  We accept
 * ctx as optional and connect lazily when needed.
 */
export async function authCommand(ctx: AgentContext | null, args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'login': return authLogin();
    case 'list': return authList();
    case 'use': return authUse(args.slice(1));
    case 'logout': return authLogout(args.slice(1));
    default: return authInfo(ctx);
  }
}

// ---------------------------------------------------------------------------
// auth (no subcommand) — show current identity
// ---------------------------------------------------------------------------

async function authInfo(ctx: AgentContext | null): Promise<void> {
  const config = readConfig();
  const profileName = resolveProfile();

  if (!profileName || !config.profiles[profileName]) {
    p.log.warn('No identity configured. Run `gitd auth login` to get started.');
    return;
  }

  const entry = config.profiles[profileName];

  p.log.info(`Profile:    ${profileName}${config.defaultProfile === profileName ? ' (default)' : ''}`);
  p.log.info(`DID:        ${entry.did}`);
  p.log.info(`Created:    ${entry.createdAt}`);
  p.log.info(`Data:       ${profileDataPath(profileName)}`);

  if (ctx) {
    p.log.info(`Connected:  ${ctx.did}`);
  }
}

// ---------------------------------------------------------------------------
// auth login — create or import identity
// ---------------------------------------------------------------------------

async function authLogin(): Promise<void> {
  p.intro('Identity setup');

  const action = await p.select({
    message : 'What would you like to do?',
    options : [
      { value: 'create', label: 'Create a new identity' },
      { value: 'import', label: 'Import from recovery phrase' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Cancelled.');
    return;
  }

  const name = await p.text({
    message     : 'Name this profile:',
    placeholder : 'personal',
    validate(val) {
      if (!val?.trim()) { return 'Profile name is required.'; }
      if (!/^[a-zA-Z0-9_-]+$/.test(val)) { return 'Only letters, numbers, hyphens, and underscores.'; }
      const existing = listProfiles();
      if (existing.includes(val)) { return `Profile "${val}" already exists.`; }
    },
  });

  if (p.isCancel(name)) {
    p.cancel('Cancelled.');
    return;
  }

  const profileName = (name as string).trim();

  const password = await p.password({
    message: 'Choose a password for your vault:',
    validate(val) {
      if (!val || (val as string).length < 4) { return 'Password must be at least 4 characters.'; }
    },
  });

  if (p.isCancel(password)) {
    p.cancel('Cancelled.');
    return;
  }

  let recoveryInput: string | undefined;

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
      return;
    }

    recoveryInput = (phrase as string).trim();
  }

  const spin = p.spinner();
  spin.start('Creating identity...');

  try {
    const dataPath = profileDataPath(profileName);
    const result = await connectAgent({
      password       : password as string,
      dataPath,
      recoveryPhrase : recoveryInput,
    });

    // Save profile metadata.
    upsertProfile(profileName, {
      name      : profileName,
      did       : result.did,
      createdAt : new Date().toISOString(),
    });

    spin.stop('Identity created!');

    p.log.success(`DID:     ${result.did}`);
    p.log.success(`Profile: ${profileName} (${dataPath})`);

    if (result.recoveryPhrase) {
      p.log.warn('');
      p.log.warn('Your recovery phrase (write this down!):');
      p.log.warn(`  ${result.recoveryPhrase}`);
      p.log.warn('');
      p.log.warn('This phrase can recover your identity if you lose your password.');
      p.log.warn('Store it securely — it will NOT be shown again.');
    }
  } catch (err) {
    spin.stop('Failed.');
    p.log.error(`Failed to create identity: ${(err as Error).message}`);
    process.exit(1);
  }

  p.outro('You\'re all set! Run `gitd whoami` to verify.');
}

// ---------------------------------------------------------------------------
// auth list — list all profiles
// ---------------------------------------------------------------------------

function authList(): void {
  const config = readConfig();
  const names = Object.keys(config.profiles);

  if (names.length === 0) {
    p.log.warn('No profiles found. Run `gitd auth login` to create one.');
    return;
  }

  p.log.info(`Profiles (${enboxHome()}):\n`);

  for (const name of names) {
    const entry = config.profiles[name];
    const isDefault = config.defaultProfile === name ? '  (default)' : '';
    p.log.info(`  ${name}${isDefault}`);
    p.log.info(`    DID:     ${entry.did}`);
    p.log.info(`    Created: ${entry.createdAt}`);
  }
}

// ---------------------------------------------------------------------------
// auth use — set active profile
// ---------------------------------------------------------------------------

async function authUse(args: string[]): Promise<void> {
  const name = args[0];
  const isGlobal = args.includes('--global');

  if (!name) {
    p.log.error('Usage: gitd auth use <profile> [--global]');
    process.exit(1);
  }

  const config = readConfig();
  if (!config.profiles[name]) {
    p.log.error(`Profile "${name}" not found. Run \`gitd auth list\` to see available profiles.`);
    process.exit(1);
  }

  if (isGlobal) {
    config.defaultProfile = name;
    writeConfig(config);
    p.log.success(`Default profile set to "${name}".`);
  } else {
    try {
      setGitConfigProfile(name);
      p.log.success(`Profile "${name}" set for this repository.`);
    } catch {
      p.log.error('Not in a git repository. Use --global to set the default profile.');
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// auth logout — remove a profile
// ---------------------------------------------------------------------------

async function authLogout(args: string[]): Promise<void> {
  let name = args[0];

  if (!name) {
    name = resolveProfile() ?? '';
  }

  if (!name) {
    p.log.error('No profile specified and no default profile found.');
    process.exit(1);
  }

  const config = readConfig();
  if (!config.profiles[name]) {
    p.log.error(`Profile "${name}" not found.`);
    process.exit(1);
  }

  const confirm = await p.confirm({
    message: `Remove profile "${name}"? This will delete all local data for this identity.`,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Cancelled.');
    return;
  }

  // Remove from config (we don't delete the data directory — user can do that).
  delete config.profiles[name];
  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.defaultProfile = remaining[0] ?? '';
  }
  writeConfig(config);

  p.log.success(`Profile "${name}" removed.`);
  p.log.info(`Data directory preserved at: ${profileDataPath(name)}`);
  p.log.info('Delete it manually if you want to free disk space.');
}
