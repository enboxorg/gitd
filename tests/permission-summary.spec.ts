import { describe, expect, it } from 'bun:test';

import { formatModerationEventSummary } from '../src/cli/commands/mod.js';
import { formatRoleChangeSummary } from '../src/cli/commands/repo.js';

describe('permission summaries', () => {
  it('formats role grant summaries', () => {
    expect(formatRoleChangeSummary({
      action    : 'grant',
      actorDid  : 'did:dht:owner',
      ownerDid  : 'did:dht:owner',
      repoName  : 'demo',
      role      : 'moderator',
      targetDid : 'did:dht:mod',
    })).toEqual([
      'Granting moderator role',
      '  Repo:   did:dht:owner/demo',
      '  Actor:  did:dht:owner',
      '  Target: did:dht:mod',
    ]);
  });

  it('formats moderation action summaries', () => {
    expect(formatModerationEventSummary({
      action   : 'block',
      actorDid : 'did:dht:moderator',
      ownerDid : 'did:dht:owner',
      repoName : 'demo',
      target   : 'did:dht:spammer',
      reason   : 'spam',
    })).toEqual([
      'Moderation: block',
      '  Repo:   did:dht:owner/demo',
      '  Actor:  did:dht:moderator',
      '  Target: did:dht:spammer',
      '  Reason: spam',
    ]);
  });
});
