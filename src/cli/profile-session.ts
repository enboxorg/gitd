/**
 * Helpers for resolving and recording the identity profile used by one CLI run.
 *
 * `connectAgent()` can create an agent store on first use, but profile metadata
 * lives in gitd's config file. These helpers keep first-run commands such as
 * `gitd init` aligned with `gitd auth login`: the implicit first identity is
 * named `default`, stored in config, and available to helper discovery.
 *
 * @module
 */

import { profileDataPath, readConfig, resolveProfile, upsertProfile } from '../profiles/config.js';
import { PUBLIC_READER_PROFILE, recordPublicReaderDid } from '../profiles/public-reader.js';

const DEFAULT_IDENTITY_NAME = 'default';

export type CommandProfile = {
  name : string;
  dataPath : string;
};

export type RecordedProfile = {
  created : boolean;
  name : string;
};

export function resolveCommandProfile(flagProfile?: string): CommandProfile {
  const resolved = resolveProfile(flagProfile);
  if (resolved) {
    return { name: resolved, dataPath: profileDataPath(resolved) };
  }

  const config = readConfig();
  const names = Object.keys(config.profiles);
  if (names.length > 1) {
    throw new Error(
      `Multiple identities are configured and none is selected. Run \`gitd auth use <identity> --global\` or pass \`--profile <identity>\`.`,
    );
  }

  return {
    name     : DEFAULT_IDENTITY_NAME,
    dataPath : profileDataPath(DEFAULT_IDENTITY_NAME),
  };
}

export function recordConnectedProfile(profileName: string, did: string): RecordedProfile {
  if (profileName === PUBLIC_READER_PROFILE) {
    recordPublicReaderDid(did);
    return { created: false, name: profileName };
  }

  const config = readConfig();
  const existing = config.profiles[profileName];

  upsertProfile(profileName, {
    name      : profileName,
    did,
    createdAt : existing?.createdAt ?? new Date().toISOString(),
  });

  return { created: !existing, name: profileName };
}

export function implicitRecoveryPhraseMessage(profileName: string, recoveryPhrase: string): string[] {
  return [
    `Created identity "${profileName}".`,
    '',
    'Recovery phrase:',
    `  ${recoveryPhrase}`,
    '',
    'Store it securely. It will not be shown again.',
  ];
}

export function printImplicitRecoveryPhrase(profileName: string, recoveryPhrase: string): void {
  for (const line of implicitRecoveryPhraseMessage(profileName, recoveryPhrase)) {
    console.log(line);
  }
}
