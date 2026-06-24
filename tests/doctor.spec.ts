import { describe, expect, it } from 'bun:test';

import { parseDoctorDidRemote } from '../src/cli/commands/doctor.js';

describe('doctor helpers', () => {
  it('parses native did remotes', () => {
    expect(parseDoctorDidRemote('did::did:dht:abc123/demo')).toEqual({
      did  : 'did:dht:abc123',
      repo : 'demo',
    });
  });

  it('parses short did remotes', () => {
    expect(parseDoctorDidRemote('did::dht:abc123/demo')).toEqual({
      did  : 'did:dht:abc123',
      repo : 'demo',
    });
  });

  it('ignores non-DID remotes', () => {
    expect(parseDoctorDidRemote('https://example.com/repo.git')).toBeNull();
  });
});
