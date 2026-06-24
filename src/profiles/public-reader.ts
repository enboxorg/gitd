/**
 * Hidden public-read profile support.
 *
 * Public clone/fetch still needs a local helper while the DWN APIs require a
 * local agent. This module stores a generated unlock secret for a throwaway
 * reader profile without adding it to the user's normal identity list.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { enboxHome, resolveProfile } from './config.js';

export const PUBLIC_READER_PROFILE = 'public-reader';

type PublicReaderState = {
  version : 1;
  profileName : typeof PUBLIC_READER_PROFILE;
  password : string;
  createdAt : string;
  did? : string;
};

export type PublicReaderPassword = {
  password : string;
  created : boolean;
};

export function publicReaderStatePath(): string {
  return join(enboxHome(), 'public-reader.json');
}

export function readPublicReaderState(): PublicReaderState | undefined {
  const path = publicReaderStatePath();
  if (!existsSync(path)) { return undefined; }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PublicReaderState>;
    if (
      parsed.version === 1
      && parsed.profileName === PUBLIC_READER_PROFILE
      && typeof parsed.password === 'string'
      && parsed.password.length > 0
      && typeof parsed.createdAt === 'string'
    ) {
      return parsed as PublicReaderState;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function getOrCreatePublicReaderPassword(now = new Date()): PublicReaderPassword {
  const existing = readPublicReaderState();
  if (existing) {
    return { password: existing.password, created: false };
  }

  const password = `gitd-reader-${randomBytes(32).toString('hex')}`;
  writePublicReaderState({
    version     : 1,
    profileName : PUBLIC_READER_PROFILE,
    password,
    createdAt   : now.toISOString(),
  });
  return { password, created: true };
}

export function recordPublicReaderDid(did: string): void {
  const existing = readPublicReaderState();
  if (!existing) { return; }

  writePublicReaderState({ ...existing, did });
}

export function readPublicReaderPasswordForActiveProfile(profileName = resolveProfile() ?? undefined): string | undefined {
  if (profileName !== PUBLIC_READER_PROFILE) { return undefined; }
  return readPublicReaderState()?.password;
}

function writePublicReaderState(state: PublicReaderState): void {
  const path = publicReaderStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms/filesystems that support POSIX modes.
  }
}
