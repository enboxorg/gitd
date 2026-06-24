/**
 * `gitd auth` — identity and profile management.
 *
 * Usage:
 *   gitd auth                          Show current identity info
 *   gitd auth login                    Create or import an identity
 *   gitd auth list                     List all identities
 *   gitd auth switch <identity>        Set default identity
 *   gitd auth use <identity>           Set identity for current repo
 *   gitd auth use <identity> --global  Set default identity
 *   gitd auth sessions                 List active local helper sessions
 *   gitd auth revoke helper            Revoke the active helper session
 *   gitd auth reset [identity]         Archive and remove local identity state
 *   gitd auth export [identity]        Export portable identity
 *   gitd auth import                   Import from recovery phrase
 *   gitd auth logout [identity]        Remove an identity
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

import * as p from '@clack/prompts';

import { connectAgent } from '../agent.js';
import { flagValue } from '../flags.js';
import { daemonStatus, stopDaemon } from '../../daemon/lifecycle.js';
import {
  enboxHome,
  listProfiles,
  profileDataPath,
  profilesDir,
  readConfig,
  resolveProfile,
  setGitConfigProfile,
  upsertProfile,
  writeConfig,
} from '../../profiles/config.js';
import { forgetVaultSecret, rememberVaultSecret } from '../../auth/vault-password.js';

const DEFAULT_IDENTITY_NAME = 'default';

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
    case 'switch': return authSwitch(args.slice(1));
    case 'use': return authUse(args.slice(1));
    case 'sessions': return authSessions(args.slice(1));
    case 'revoke': return authRevoke(args.slice(1));
    case 'reset': return authReset(args.slice(1));
    case 'logout': return authLogout(args.slice(1));
    default: return authInfo(ctx);
  }
}

type AuthSessionStatus = ReturnType<typeof daemonStatus>;

function authExpiryLabel(policy: string | undefined): string | undefined {
  if (policy === 'helper-lifetime') { return 'when helper stops'; }
  return policy;
}

function authRepoContextLine(context: NonNullable<AuthSessionStatus['repoContexts']>[number]): string {
  const branch = context.defaultBranch ? ` (${context.defaultBranch})` : '';
  const path = context.path ? ` at ${context.path}` : '';
  return `${context.ownerDid}/${context.repo}${branch}${path}`;
}

export function formatAuthSessionsStatus(
  status: AuthSessionStatus,
  fallbackProfileName?: string,
): string[] {
  if (!status.running) {
    return [
      'No active helper session.',
      'Run `gitd helper start` to start one.',
    ];
  }

  const lines = [
    'Active helper session',
    `  ID:      ${status.sessionId ?? 'helper'}`,
    `  Profile: ${status.profileName ?? fallbackProfileName ?? 'default'}`,
  ];

  if (status.ownerDid) {
    lines.push(`  DID:     ${status.ownerDid}`);
  }
  if (status.port) {
    lines.push(`  Port:    ${status.port}`);
  }
  if (status.reposPath) {
    lines.push(`  Repos:   ${status.reposPath}`);
  }
  if (status.capabilities?.length) {
    lines.push('  Capabilities:');
    for (const capability of status.capabilities) {
      lines.push(`    - ${capability}`);
    }
  } else if (status.dwnHelper) {
    lines.push('  Capabilities: dwn-restore');
  }
  const expiry = authExpiryLabel(status.expiryPolicy);
  if (expiry) {
    lines.push(`  Expires: ${expiry}`);
  }
  if (status.repoContexts?.length) {
    lines.push('  Seen repos:');
    for (const context of status.repoContexts) {
      lines.push(`    - ${authRepoContextLine(context)}`);
    }
  }

  lines.push('  Revoke:  gitd auth revoke helper');
  return lines;
}

function authProfileName(args: string[]): string | undefined {
  return resolveProfile(flagValue(args, '--profile')) ?? undefined;
}

export function firstAuthPositionalArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--profile=')) { continue; }
    if (arg === '--profile') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) { return arg; }
  }
  return undefined;
}

function authSessions(args: string[]): void {
  const profileName = authProfileName(args);
  for (const line of formatAuthSessionsStatus(daemonStatus({ profileName }), profileName)) {
    console.log(line);
  }
}

function authRevoke(args: string[]): void {
  const target = firstAuthPositionalArg(args);
  const profileName = authProfileName(args);
  const status = daemonStatus({ profileName });

  if (!target) {
    p.log.error('Usage: gitd auth revoke helper');
    process.exit(1);
  }

  if (target !== 'helper' && target !== status.sessionId) {
    p.log.error(`Unknown helper session "${target}". Run \`gitd auth sessions\`.`);
    process.exit(1);
  }

  const stopped = stopDaemon({ profileName });
  if (stopped) {
    p.log.success('Helper session revoked.');
  } else {
    p.log.warn('No active helper session.');
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

  p.log.info(`Identity:   ${profileName}${config.defaultProfile === profileName ? ' (default)' : ''}`);
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
  const existingProfiles = listProfiles();
  const defaultName = suggestIdentityName(existingProfiles);

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
    message      : 'Name this identity:',
    defaultValue : defaultName,
    placeholder  : defaultName,
    validate(val) {
      return validateIdentityNameInput(val, existingProfiles, defaultName);
    },
  });

  if (p.isCancel(name)) {
    p.cancel('Cancelled.');
    return;
  }

  const profileName = normalizeIdentityNameInput(name as string, defaultName);

  const password = await p.password({
    message: 'Create a password to unlock gitd:',
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
  spin.start(action === 'import' ? 'Importing identity...' : 'Creating identity...');

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

    // Persist the unlock secret so later commands restore without a prompt.
    await rememberVaultSecret(profileName, { password: password as string, source: 'explicit' });

    spin.stop('Identity created!');

    p.log.success(`DID:      ${result.did}`);
    p.log.success(`Identity: ${profileName}`);
    p.log.info(`Data:     ${dataPath}`);

    if (result.recoveryPhrase) {
      p.log.warn('');
      p.log.warn('Your recovery phrase (write this down!):');
      p.log.warn(`  ${result.recoveryPhrase}`);
      p.log.warn('');
      p.log.warn('This phrase can recover your identity if you lose your password.');
      p.log.warn('Store it securely — it will NOT be shown again.');
    }

    try {
      await result.close?.();
    } catch (closeErr) {
      p.log.warn(`Identity was created, but local resources could not be released cleanly: ${(closeErr as Error).message}`);
    }
  } catch (err) {
    spin.stop('Failed.');
    p.log.error(`Failed to ${action === 'import' ? 'import' : 'create'} identity: ${(err as Error).message}`);
    process.exit(1);
  }

  p.outro('Identity ready. Run `gitd whoami` to verify.');
}

export function suggestIdentityName(existingProfiles: readonly string[]): string {
  if (!existingProfiles.includes(DEFAULT_IDENTITY_NAME)) {
    return DEFAULT_IDENTITY_NAME;
  }

  let index = 2;
  while (existingProfiles.includes(`identity-${index}`)) {
    index++;
  }
  return `identity-${index}`;
}

export function normalizeIdentityNameInput(value: string | undefined, defaultName: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultName;
}

export function validateIdentityNameInput(
  value: string | undefined,
  existingProfiles: readonly string[],
  defaultName = suggestIdentityName(existingProfiles),
): string | undefined {
  const normalized = normalizeIdentityNameInput(value, defaultName);
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) { return 'Only letters, numbers, hyphens, and underscores.'; }
  if (existingProfiles.includes(normalized)) { return `Identity "${normalized}" already exists.`; }
  return undefined;
}

// ---------------------------------------------------------------------------
// auth list — list all identities
// ---------------------------------------------------------------------------

function authList(): void {
  const config = readConfig();
  const names = Object.keys(config.profiles);

  if (names.length === 0) {
    p.log.warn('No identities found. Run `gitd auth login` to create one.');
    return;
  }

  p.log.info(`Identities (${enboxHome()}):\n`);

  for (const name of names) {
    const entry = config.profiles[name];
    const isDefault = config.defaultProfile === name ? '  (default)' : '';
    p.log.info(`  ${name}${isDefault}`);
    p.log.info(`    DID:     ${entry.did}`);
    p.log.info(`    Created: ${entry.createdAt}`);
  }
}

export function setDefaultIdentity(name: string): string {
  const config = readConfig();
  if (!config.profiles[name]) {
    throw new Error(`Identity "${name}" not found. Run \`gitd auth list\` to see available identities.`);
  }

  config.defaultProfile = name;
  writeConfig(config);
  return `Default identity set to "${name}".`;
}

type ResetIdentityResult = {
  name : string;
  backupPath? : string;
  defaultProfile? : string;
};

export function resetIdentityLocally(
  name: string,
  now = new Date(),
): ResetIdentityResult {
  const config = readConfig();
  if (!config.profiles[name]) {
    throw new Error(`Identity "${name}" not found. Run \`gitd auth list\` to see available identities.`);
  }

  const backupPath = archiveIdentityDirectory(name, now);

  delete config.profiles[name];
  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.defaultProfile = remaining[0] ?? '';
  }
  writeConfig(config);

  return {
    name,
    ...(backupPath ? { backupPath } : {}),
    ...(config.defaultProfile ? { defaultProfile: config.defaultProfile } : {}),
  };
}

function archiveIdentityDirectory(name: string, now: Date): string | undefined {
  const source = join(profilesDir(), name);
  if (!existsSync(source)) {
    return undefined;
  }

  const backupRoot = join(enboxHome(), 'profile-backups');
  mkdirSync(backupRoot, { recursive: true });

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  let target = join(backupRoot, `${safeName}-${timestamp}`);
  let suffix = 2;
  while (existsSync(target)) {
    target = join(backupRoot, `${safeName}-${timestamp}-${suffix}`);
    suffix++;
  }

  renameSync(source, target);
  return target;
}

// ---------------------------------------------------------------------------
// auth switch — set global default identity
// ---------------------------------------------------------------------------

async function authSwitch(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    p.log.error('Usage: gitd auth switch <identity>');
    process.exit(1);
  }

  try {
    p.log.success(setDefaultIdentity(name));
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// auth reset — archive local identity state
// ---------------------------------------------------------------------------

async function authReset(args: string[]): Promise<void> {
  const name = firstAuthPositionalArg(args) ?? resolveProfile() ?? '';
  const yes = args.includes('--yes') || args.includes('-y');

  if (!name) {
    p.log.error('No identity specified and no default identity found.');
    p.log.info('Usage: gitd auth reset [identity] [--yes]');
    process.exit(1);
  }

  if (!yes) {
    const confirmed = await p.confirm({
      message: `Reset identity "${name}"? Local profile data will be moved to a backup.`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      return;
    }
  }

  stopDaemon({ profileName: name });

  try {
    const result = resetIdentityLocally(name);
    await forgetVaultSecret(name);
    p.log.success(`Identity "${result.name}" reset.`);
    if (result.backupPath) {
      p.log.info(`Backup: ${result.backupPath}`);
    } else {
      p.log.info('No local profile directory existed to back up.');
    }
    if (result.defaultProfile) {
      p.log.info(`Default identity is now "${result.defaultProfile}".`);
    } else {
      p.log.info('No default identity is configured.');
    }
    p.log.info('Run `gitd auth login` to create or import an identity.');
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// auth use — set active identity
// ---------------------------------------------------------------------------

async function authUse(args: string[]): Promise<void> {
  const name = args[0];
  const isGlobal = args.includes('--global');

  if (!name) {
    p.log.error('Usage: gitd auth use <identity> [--global]');
    process.exit(1);
  }

  const config = readConfig();
  if (!config.profiles[name]) {
    p.log.error(`Identity "${name}" not found. Run \`gitd auth list\` to see available identities.`);
    process.exit(1);
  }

  if (isGlobal) {
    p.log.success(setDefaultIdentity(name));
  } else {
    try {
      setGitConfigProfile(name);
      p.log.success(`Identity "${name}" set for this repository.`);
    } catch {
      p.log.error('Not in a git repository. Use --global to set the default identity.');
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// auth logout — remove an identity
// ---------------------------------------------------------------------------

async function authLogout(args: string[]): Promise<void> {
  let name = args[0];

  if (!name) {
    name = resolveProfile() ?? '';
  }

  if (!name) {
    p.log.error('No identity specified and no default identity found.');
    process.exit(1);
  }

  const config = readConfig();
  if (!config.profiles[name]) {
    p.log.error(`Identity "${name}" not found.`);
    process.exit(1);
  }

  const confirm = await p.confirm({
    message: `Remove identity "${name}"? This keeps local data on disk unless you delete it manually.`,
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
  await forgetVaultSecret(name);

  p.log.success(`Identity "${name}" removed.`);
  p.log.info(`Data directory preserved at: ${profileDataPath(name)}`);
  p.log.info('Delete it manually if you want to free disk space.');
}
