import { describe, expect, it } from 'bun:test';

import { PUBLIC_READER_PROFILE } from '../src/profiles/public-reader.js';
import {
  isPublicReaderCommandAllowed,
  publicReaderWriteBlockMessage,
  shouldBlockPublicReaderCommand,
} from '../src/cli/public-reader-guard.js';

describe('public reader command guard', () => {
  it('allows read-only repo commands', () => {
    expect(isPublicReaderCommandAllowed('repo', [])).toBe(true);
    expect(isPublicReaderCommandAllowed('repo', ['info'])).toBe(true);
    expect(isPublicReaderCommandAllowed('issue', ['list'])).toBe(true);
    expect(isPublicReaderCommandAllowed('pr', ['checkout', 'abc1234'])).toBe(true);
    expect(isPublicReaderCommandAllowed('release', ['show', 'v1.0.0'])).toBe(true);
  });

  it('allows local helper lifecycle for the hidden reader profile', () => {
    expect(isPublicReaderCommandAllowed('helper', ['start'])).toBe(true);
    expect(isPublicReaderCommandAllowed('helper', ['status'])).toBe(true);
    expect(isPublicReaderCommandAllowed('serve', [])).toBe(true);
    expect(isPublicReaderCommandAllowed('serve', ['--foreground'])).toBe(true);
    expect(isPublicReaderCommandAllowed('serve', ['status'])).toBe(true);
  });

  it('blocks public publishing commands for the hidden reader profile', () => {
    expect(isPublicReaderCommandAllowed('publish', ['--public-url', 'https://git.example.com'])).toBe(false);
    expect(isPublicReaderCommandAllowed('serve', ['--public-url', 'https://git.example.com'])).toBe(false);
    expect(isPublicReaderCommandAllowed('serve', ['--publish'])).toBe(false);
  });

  it('blocks write commands when the hidden reader profile is active', () => {
    expect(shouldBlockPublicReaderCommand(PUBLIC_READER_PROFILE, 'issue', ['create', 'bug'])).toBe(true);
    expect(shouldBlockPublicReaderCommand(PUBLIC_READER_PROFILE, 'pr', ['create', 'feature'])).toBe(true);
    expect(shouldBlockPublicReaderCommand(PUBLIC_READER_PROFILE, 'repo', ['add-moderator', 'did:dht:abc'])).toBe(true);
    expect(shouldBlockPublicReaderCommand('work', 'issue', ['create', 'bug'])).toBe(false);
  });

  it('explains how to switch from public-read cache to a write identity', () => {
    expect(publicReaderWriteBlockMessage('pr', ['create', 'Feature']).join('\n')).toContain('gitd auth login');
    expect(publicReaderWriteBlockMessage('pr', ['create', 'Feature']).join('\n')).toContain('gitd auth use <identity>');
    expect(publicReaderWriteBlockMessage('pr', ['create', 'Feature']).join('\n')).toContain('Then retry: gitd pr create Feature');
  });
});
