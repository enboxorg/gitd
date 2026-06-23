#!/usr/bin/env bun
import { readFileSync } from 'node:fs';

import { connectAgent } from '../../src/cli/agent.js';
import { profileDataPath } from '../../src/profiles/config.js';

type DidCacheEntry = {
  didDocument?: { id?: string };
  didDocumentMetadata?: Record<string, unknown>;
};

const [profileName, password, docsPath] = process.argv.slice(2);

if (!profileName || !password || !docsPath) {
  console.error('Usage: cache-did-docs.ts <profile> <password> <docs-json>');
  process.exit(1);
}

try {
  const entries = JSON.parse(readFileSync(docsPath, 'utf-8')) as DidCacheEntry[];
  const ctx = await connectAgent({
    password,
    dataPath     : profileDataPath(profileName),
    sync         : 'off',
    registration : false,
  });

  const agent = ctx.enbox.agent as any;
  for (const entry of entries) {
    const did = entry.didDocument?.id;
    if (!did) { continue; }
    await agent.did.cache.set(did, {
      didDocument           : entry.didDocument,
      didDocumentMetadata   : entry.didDocumentMetadata ?? {},
      didResolutionMetadata : {},
    });
  }

  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
