#!/usr/bin/env bun
import { connectAgent } from '../../src/cli/agent.js';
import { profileDataPath, upsertProfile } from '../../src/profiles/config.js';

const [profileName, password] = process.argv.slice(2);

if (!profileName || !password) {
  console.error('Usage: profile-bootstrap.ts <profile> <password>');
  process.exit(1);
}

try {
  const result = await connectAgent({
    password,
    dataPath     : profileDataPath(profileName),
    sync         : 'off',
    registration : false,
  });

  upsertProfile(profileName, {
    name      : profileName,
    did       : result.did,
    createdAt : new Date().toISOString(),
  });

  const agent = result.enbox.agent as any;
  const localDid = result.did === agent.agentDid?.uri
    ? agent.agentDid
    : await agent.did.get({ didUri: result.did, tenant: agent.agentDid?.uri });
  const portableDid = localDid ? await localDid.export() : undefined;

  console.log(JSON.stringify({
    profile             : profileName,
    did                 : result.did,
    didDocument         : portableDid?.document,
    didDocumentMetadata : portableDid?.metadata,
  }));
  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
