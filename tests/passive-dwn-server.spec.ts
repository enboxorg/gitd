import { afterEach, describe, expect, it } from 'bun:test';

import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import {
  DataStream,
  Jws,
  ProtocolsConfigure,
  RecordsQuery,
  RecordsRead,
  RecordsWrite,
  TestDataGenerator,
} from '@enbox/dwn-sdk-js';

import { ForgeRepoDefinition } from '../src/repo.js';
import { startPassiveDwnServer } from './helpers/passive-dwn-server.js';

const BASE = resolve('__TESTDATA__/passive-dwn-server');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('passive DWN RPC server helper', () => {
  afterEach(() => {
    rmSync(BASE, { recursive: true, force: true });
  });

  it('serves standard DWN processMessage, streamed reads, and replicated apply over HTTP', async () => {
    const owner = await TestDataGenerator.generatePersona();
    const server = await startPassiveDwnServer({
      dataPath     : BASE,
      didDocuments : [didDocumentForPersona(owner)],
    });
    try {
      const rpc = new HttpDwnRpcClient();
      const info = await rpc.getServerInfo(server.url);
      expect(info.server).toBe('@enbox/dwn-server');
      expect(info.registrationRequirements).toEqual([]);

      const configure = await ProtocolsConfigure.create({
        definition : ForgeRepoDefinition,
        signer     : Jws.createSigner(owner),
      });

      const configureReply = await rpc.sendDwnRequest({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : configure.message,
      });
      expect(configureReply.status.code).toBe(202);

      const repoData = encoder.encode(JSON.stringify({
        name          : 'demo',
        defaultBranch : 'main',
        dwnEndpoints  : [server.url],
      }));
      const write = await RecordsWrite.create({
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : ForgeRepoDefinition.types.repo.schema,
        dataFormat   : 'application/json',
        data         : repoData,
        tags         : { name: 'demo', visibility: 'public' },
        signer       : Jws.createSigner(owner),
      });

      const writeReply = await rpc.sendDwnRequest({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : write.message,
        data      : DataStream.fromBytes(repoData),
      });
      expect(writeReply.status.code).toBe(202);

      const query = await RecordsQuery.create({
        signer : Jws.createSigner(owner),
        filter : {
          protocol     : ForgeRepoDefinition.protocol,
          protocolPath : 'repo',
          tags         : { name: 'demo' },
        },
      });
      const queryReply = await rpc.sendDwnRequest({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : query.message,
      });
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toHaveLength(1);

      const read = await RecordsRead.create({
        signer : Jws.createSigner(owner),
        filter : { recordId: write.message.recordId },
      });
      const readReply = await rpc.sendDwnRequest({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : read.message,
      });
      expect(readReply.status.code).toBe(200);
      expect(readReply.entry?.data).toBeDefined();
      const readBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(JSON.parse(decoder.decode(readBytes))).toEqual({
        name          : 'demo',
        defaultBranch : 'main',
        dwnEndpoints  : [server.url],
      });

      const replicatedData = encoder.encode(JSON.stringify({
        name          : 'replicated',
        defaultBranch : 'main',
        dwnEndpoints  : [server.url],
      }));
      const replicatedWrite = await RecordsWrite.create({
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : ForgeRepoDefinition.types.repo.schema,
        dataFormat   : 'application/json',
        data         : replicatedData,
        tags         : { name: 'replicated', visibility: 'public' },
        signer       : Jws.createSigner(owner),
      });

      const applyResult = await rpc.applyReplicatedMessage({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : replicatedWrite.message,
        data      : DataStream.fromBytes(replicatedData),
      });
      expect(applyResult.kind).toBe('Applied');

      const duplicateResult = await rpc.applyReplicatedMessage({
        dwnUrl    : server.url,
        targetDid : owner.did,
        message   : replicatedWrite.message,
      });
      expect(duplicateResult.kind).toBe('Duplicate');
    } finally {
      await server.stop();
    }
  });
});

function didDocumentForPersona(persona: Awaited<ReturnType<typeof TestDataGenerator.generatePersona>>): Record<string, unknown> {
  return {
    didDocument: {
      id                 : persona.did,
      verificationMethod : [{
        id           : persona.keyId,
        type         : 'JsonWebKey',
        controller   : persona.did,
        publicKeyJwk : persona.keyPair.publicJwk,
      }],
      authentication  : [persona.keyId],
      assertionMethod : [persona.keyId],
    },
  };
}
