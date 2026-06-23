import type { DidDocument, DidResolutionOptions, DidResolutionResult, DidResolver } from '@enbox/dids';
import type { JsonRpcId } from '@enbox/dwn-clients';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dialect } from '@enbox/dwn-sql-store';

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Kysely } from 'kysely';
import {
  DataStream,
  DurableEventLog,
  Dwn,
  EventEmitterWakePublisher,
  Message,
} from '@enbox/dwn-sdk-js';
import {
  DidDht,
  DidJwk,
  DidKey,
  DidWeb,
  UniversalResolver,
} from '@enbox/dids';
import {
  createBunSqliteDatabase,
  DataStoreSql,
  MessageStoreSql,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
} from '@enbox/dwn-sql-store';

export type SeedDidDocument = {
  didDocument: DidDocument;
  didDocumentMetadata?: Record<string, unknown>;
};

export type PassiveDwnServer = {
  url: string;
  port: number;
  addDidDocument: (entry: SeedDidDocument) => void;
  stop: () => Promise<void>;
};

export async function startPassiveDwnServer(options: {
  dataPath: string;
  didDocuments?: Iterable<SeedDidDocument>;
}): Promise<PassiveDwnServer> {
  mkdirSync(options.dataPath, { recursive: true });

  const didResolver = new SeededDidResolver(options.didDocuments ?? []);
  const dwn = await createPassiveDwn(options.dataPath, didResolver);
  const server = createServer((req, res) => {
    handleRequest(dwn, req, res).catch((err) => {
      sendJson(res, 500, {
        jsonrpc : '2.0',
        id      : null,
        error   : {
          code    : -32603,
          message : (err as Error).message,
        },
      });
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url  : `http://127.0.0.1:${port}`,
    port,
    addDidDocument: (entry) => { didResolver.add(entry); },
    stop : async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await dwn.close();
    },
  };
}

async function createPassiveDwn(
  dataPath: string,
  didResolver: DidResolver,
): Promise<Dwn> {
  const sqliteDb = createBunSqliteDatabase(join(dataPath, 'dwn.sqlite'));
  const dialect: Dialect = new SqliteDialect({ database: async () => sqliteDb });
  const migrationDb = new Kysely<Record<string, unknown>>({ dialect });
  await runDwnStoreMigrations(migrationDb, dialect);

  const wakePublisher = new EventEmitterWakePublisher();
  const messageStore = new MessageStoreSql(dialect, wakePublisher);
  const dataStore = new DataStoreSql(dialect);
  const resumableTaskStore = new ResumableTaskStoreSql(dialect);
  const eventLog = new DurableEventLog(messageStore, wakePublisher);

  return Dwn.create({
    dataStore,
    messageStore,
    resumableTaskStore,
    eventLog,
    didResolver,
  });
}

class SeededDidResolver implements DidResolver {
  private readonly documents = new Map<string, SeedDidDocument>();
  private readonly fallback = new UniversalResolver({
    didResolvers : [DidDht, DidJwk, DidKey, DidWeb],
  });

  constructor(didDocuments: Iterable<SeedDidDocument>) {
    for (const entry of didDocuments) {
      this.add(entry);
    }
  }

  add(entry: SeedDidDocument): void {
    this.documents.set(entry.didDocument.id, entry);
  }

  async resolve(didUrl: string, options?: DidResolutionOptions): Promise<DidResolutionResult> {
    const did = didUrl.split(/[?#]/, 1)[0];
    const entry = this.documents.get(did);
    if (entry) {
      return {
        didDocument           : entry.didDocument,
        didDocumentMetadata   : entry.didDocumentMetadata ?? {},
        didResolutionMetadata : {},
      };
    }

    return this.fallback.resolve(didUrl, options);
  }
}

async function handleRequest(
  dwn: Dwn,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url?.split('?')[0] === '/info') {
    sendJson(res, 200, {
      maxFileSize              : 250_000_000,
      maxInFlight              : 64,
      registrationRequirements : [],
      server                   : '@enbox/dwn-server',
      sdkVersion               : 'test',
      url                      : requestBaseUrl(req),
      version                  : 'test',
      webSocketSupport         : false,
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const requestHeader = req.headers['dwn-request'];
  const requestText = Array.isArray(requestHeader) ? requestHeader[0] : requestHeader;
  if (!requestText) {
    sendJson(res, 400, { error: 'missing dwn-request header' });
    return;
  }

  const rpcRequest = JSON.parse(requestText) as {
    id?: JsonRpcId;
    method?: string;
    params?: { target?: string; message?: any };
  };
  const data = await readBody(req);
  const dataStream = data.byteLength > 0 ? DataStream.fromBytes(data) : undefined;
  const target = rpcRequest.params?.target;
  const message = rpcRequest.params?.message;
  if (!target || !message) {
    sendJsonRpcError(res, rpcRequest.id ?? null, -32602, 'missing target or message');
    return;
  }

  if (rpcRequest.method === 'dwn.processMessage') {
    debugDwn('process start', target, message);
    const reply = await withDwnTimeout(
      dwn.processMessage(target, message, dataStream ? { dataStream } : undefined),
      'processMessage',
      target,
      message,
    );
    debugDwn(`process done status=${reply.status?.code ?? '<none>'}`, target, message);
    await sendProcessMessageReply(res, rpcRequest.id ?? null, reply);
    return;
  }

  if (rpcRequest.method === 'dwn.applyReplicatedMessage') {
    debugDwn('apply start', target, message);
    const result = await withDwnTimeout(
      dwn.applyReplicatedMessage(target, message, dataStream ? { dataStream } : undefined),
      'applyReplicatedMessage',
      target,
      message,
    );
    debugDwn(`apply done kind=${result.kind ?? '<none>'}`, target, message);
    sendJson(res, 200, {
      jsonrpc : '2.0',
      id      : rpcRequest.id ?? null,
      result  : { result },
    });
    return;
  }

  sendJsonRpcError(res, rpcRequest.id ?? null, -32601, `unsupported method: ${rpcRequest.method ?? ''}`);
}

async function withDwnTimeout<T>(
  promise: Promise<T>,
  operation: string,
  target: string,
  message: any,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${operation} timed out for ${describeDwnMessage(target, message)}`));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timeout) { clearTimeout(timeout); }
  }
}

function debugDwn(event: string, target: string, message: any): void {
  if (process.env.GITD_PASSIVE_DWN_DEBUG !== '1') {
    return;
  }
  console.error(`[passive-dwn] ${event} ${describeDwnMessage(target, message)}`);
}

function describeDwnMessage(target: string, message: any): string {
  const descriptor = message?.descriptor ?? {};
  let author = '<anonymous>';
  try {
    author = Message.getSigner(message) ?? '<anonymous>';
  } catch {
    // Anonymous messages and malformed debug inputs can still be described.
  }

  return [
    `target=${target}`,
    `interface=${descriptor.interface ?? '<none>'}`,
    `method=${descriptor.method ?? '<none>'}`,
    `protocol=${descriptor.protocol ?? '<none>'}`,
    `path=${descriptor.protocolPath ?? '<none>'}`,
    `author=${author}`,
  ].join(' ');
}

async function sendProcessMessageReply(
  res: ServerResponse,
  id: JsonRpcId,
  reply: any,
): Promise<void> {
  const { reply: serializableReply, dataStream } = extractReplyDataStream(reply);
  const envelope = {
    jsonrpc : '2.0',
    id,
    result  : { reply: serializableReply },
  };

  if (dataStream) {
    const bytes = await DataStream.toBytes(dataStream);
    res.writeHead(200, {
      'content-type' : 'application/octet-stream',
      'dwn-response' : JSON.stringify(envelope),
    });
    res.end(Buffer.from(bytes));
    return;
  }

  sendJson(res, 200, envelope);
}

function extractReplyDataStream(reply: any): { reply: any; dataStream?: ReadableStream<Uint8Array> } {
  if (reply.entry?.data) {
    return {
      reply: {
        ...reply,
        entry: {
          ...reply.entry,
          data: undefined,
        },
      },
      dataStream: reply.entry.data,
    };
  }

  if (reply.record?.data) {
    return {
      reply: {
        ...reply,
        record: {
          ...reply.record,
          data: undefined,
        },
      },
      dataStream: reply.record.data,
    };
  }

  return { reply };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJsonRpcError(
  res: ServerResponse,
  id: JsonRpcId,
  code: number,
  message: string,
): void {
  sendJson(res, 200, {
    jsonrpc : '2.0',
    id,
    error   : { code, message },
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
