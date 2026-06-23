import type { AgentContext } from './agent.js';

import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { DataStream, type MessageSigner } from '@enbox/dwn-sdk-js';
import { getDwnEndpoints } from '../git-server/did-service.js';

/** Send a locally composed `store:false` record to another DID. */
export async function sendRecordToTarget(
  ctx: AgentContext,
  record: any,
  targetDid: string,
  label = 'record',
): Promise<void> {
  if (ctx.sendRecord) {
    await ctx.sendRecord(record, targetDid);
    return;
  }

  const dwnEndpoints = configuredDwnEndpoints(ctx);
  if (dwnEndpoints.length > 0) {
    for (const endpoint of dwnEndpoints) {
      await applyRecordToDwnEndpoint(endpoint, targetDid, record, label);
    }
    return;
  }

  const status = await record.send(targetDid);
  if (status.code >= 300) {
    throw new Error(`Failed to send ${label}: ${status.code} ${status.detail ?? ''}`.trim());
  }
}

/** Apply a raw DWN message to every configured local/passive endpoint. */
export async function applyMessageToTargetEndpoints(
  ctx: AgentContext,
  targetDid: string,
  message: any,
  label = 'message',
  data?: BodyInit,
): Promise<void> {
  const dwnEndpoints = configuredDwnEndpoints(ctx);
  if (dwnEndpoints.length === 0) {
    throw new Error(`No DWN endpoint configured for ${label}`);
  }

  for (const endpoint of dwnEndpoints) {
    await applyMessageToDwnEndpoint(endpoint, targetDid, message, label, data);
  }
}

/** Process an incoming DWN message on every configured local/passive endpoint. */
export async function processMessageOnTargetEndpoints(
  ctx: AgentContext,
  targetDid: string,
  message: any,
  label = 'message',
  data?: BodyInit,
): Promise<void> {
  const dwnEndpoints = configuredDwnEndpoints(ctx);
  if (dwnEndpoints.length === 0) {
    throw new Error(`No DWN endpoint configured for ${label}`);
  }

  if (process.env.GITD_DEBUG === '1') {
    console.error(`[dwn-process] ${label}: endpoints=${dwnEndpoints.join(',')}`);
  }

  for (const endpoint of dwnEndpoints) {
    await processMessageOnDwnEndpoint(endpoint, targetDid, message, label, data);
  }
}

/** Apply a raw DWN message directly to a known DWN endpoint. */
export async function applyMessageToDwnEndpoint(
  dwnUrl: string,
  targetDid: string,
  message: any,
  label = 'message',
  data?: BodyInit,
): Promise<void> {
  const result = await new HttpDwnRpcClient().applyReplicatedMessage({
    dwnUrl,
    targetDid,
    message,
    ...(data ? { data } : {}),
    signal    : AbortSignal.timeout(15_000),
    timeoutMs : 15_000,
  });

  if (process.env.GITD_DEBUG === '1') {
    console.error(`[dwn-apply] ${label}: ${result.kind}`);
  }

  if (result.kind === 'Applied' || result.kind === 'Duplicate' || result.kind === 'Superseded') {
    return;
  }

  if (result.kind === 'Incomplete') {
    const missing = result.missing.map((entry) => entry.type).join(', ');
    throw new Error(`Failed to apply ${label}: missing dependencies (${missing})`);
  }

  throw new Error(`Failed to apply ${label}: ${result.kind}${'reason' in result ? ` ${result.reason}` : ''}`);
}

/** Send a raw DWN message through the normal processMessage entry point. */
export async function processMessageOnDwnEndpoint(
  dwnUrl: string,
  targetDid: string,
  message: any,
  label = 'message',
  data?: BodyInit,
): Promise<void> {
  const reply = await new HttpDwnRpcClient().sendDwnRequest({
    dwnUrl,
    targetDid,
    message,
    ...(data ? { data } : {}),
    signal    : AbortSignal.timeout(15_000),
    timeoutMs : 15_000,
  });

  if (process.env.GITD_DEBUG === '1') {
    console.error(`[dwn-process] ${label}: ${reply.status.code} ${reply.status.detail ?? ''}`.trim());
  }

  if (reply.status.code >= 300) {
    throw new Error(`Failed to process ${label}: ${reply.status.code} ${reply.status.detail ?? ''}`.trim());
  }
}

/** Apply a record directly to a known DWN endpoint without DID endpoint resolution. */
export async function applyRecordToDwnEndpoint(
  dwnUrl: string,
  targetDid: string,
  record: any,
  label = 'record',
): Promise<void> {
  const rawMessage = record.rawMessage;
  const isWrite = rawMessage?.descriptor?.interface === 'Records'
    && rawMessage?.descriptor?.method === 'Write';
  const data = isWrite && (record.dataSize ?? 0) > 0
    ? await record.data.blob()
    : undefined;

  await applyMessageToDwnEndpoint(dwnUrl, targetDid, rawMessage, label, data);
}

/** Build a DWN SDK signer backed by the active Enbox wallet identity. */
export async function messageSignerForContext(ctx: AgentContext): Promise<MessageSigner> {
  const agent = (ctx.enbox as any).agent;
  const agentDid = agent?.agentDid;
  const bearerDid = ctx.did === agentDid?.uri
    ? agentDid
    : await agent?.did?.get?.({ didUri: ctx.did, tenant: agentDid?.uri });

  if (!bearerDid) {
    throw new Error(`Unable to load signer for ${ctx.did}`);
  }

  const signer = await bearerDid.getSigner();

  return {
    keyId     : signer.keyId,
    algorithm : signer.algorithm,
    sign: (content: Uint8Array) => signer.sign({ data: content }),
  };
}

export function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function bodyInit(bytes: Uint8Array): BodyInit {
  return DataStream.fromBytes(bytes) as BodyInit;
}

export function configuredDwnEndpoints(ctx: AgentContext): string[] {
  const fromDid = ctx.enbox ? getDwnEndpoints(ctx.enbox) : [];
  const fromEnv = [
    ...(process.env.GITD_DWN_ENDPOINTS ?? '')
      .split(',')
      .map((endpoint) => endpoint.trim())
      .filter(Boolean),
    ...(process.env.GITD_DWN_ENDPOINT ? [process.env.GITD_DWN_ENDPOINT] : []),
  ];

  return Array.from(new Set([...fromDid, ...fromEnv]));
}
