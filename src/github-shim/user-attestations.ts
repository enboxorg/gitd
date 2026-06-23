/**
 * GitHub API shim — user-scoped artifact attestation endpoints.
 *
 * Aggregates repository attestation records for repositories owned by a DID.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { JsonResponse } from './helpers.js';
import type { RepoEntry } from './repos.js';
import type { RepositoryAttestationData, SettingsData } from '../repo.js';

import { listRepoEntries } from './repos.js';
import {
  buildApiUrl,
  buildLinkHeader,
  fromOpt,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
  numericId,
  paginate,
  parsePagination,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

type SettingsRecord = {
  update : (options: { data: SettingsData }) => Promise<{ status: { code: number; detail?: string } }>;
};

type RepoSettingsLookup = {
  entry : RepoEntry;
  record? : SettingsRecord;
  settings : SettingsData;
};

type StoredAttestation = RepoSettingsLookup & {
  key : string;
  attestation : RepositoryAttestationData;
};

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSubjectDigest(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const normalized = value.trim().toLowerCase();
  return SHA256_DIGEST_PATTERN.test(normalized) ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSubjectDigests(body: unknown): string[] | JsonResponse {
  if (!isObject(body) || !Array.isArray(body.subject_digests) || body.subject_digests.length === 0) {
    return jsonValidationError('Validation Failed: subject_digests must be a non-empty array.');
  }

  const digests: string[] = [];
  for (const value of body.subject_digests) {
    const digest = normalizeSubjectDigest(value);
    if (!digest) {
      return jsonValidationError('Validation Failed: subject_digests must contain sha256:<64 hex characters> values.');
    }
    digests.push(digest);
  }
  return [...new Set(digests)];
}

function attestationEntries(settings: SettingsData): Array<[string, RepositoryAttestationData]> {
  return Object.entries(settings.attestations ?? {})
    .filter((entry): entry is [string, RepositoryAttestationData] => {
      const attestation = entry[1];
      return Boolean(attestation) && Number.isInteger(attestation.id);
    })
    .sort((left, right) => left[1].id - right[1].id || left[0].localeCompare(right[0]));
}

async function listOwnerRepos(ctx: AgentContext, targetDid: string): Promise<RepoEntry[]> {
  try {
    return await listRepoEntries(ctx, targetDid);
  } catch {
    return [];
  }
}

async function getRepoSettings(
  ctx: AgentContext, targetDid: string, entry: RepoEntry,
): Promise<RepoSettingsLookup> {
  try {
    const { records } = await ctx.repo.records.query('repo/settings' as any, {
      from   : fromOpt(ctx, targetDid),
      filter : { contextId: entry.repo.contextId },
    } as any);
    const record = records[0] as (SettingsRecord & { data: { json: () => Promise<SettingsData> } }) | undefined;
    if (!record) { return { entry, settings: {} }; }
    const settings = await record.data.json();
    return { entry, record, settings: settings ?? {} };
  } catch {
    return { entry, settings: {} };
  }
}

async function listOwnerSettings(ctx: AgentContext, targetDid: string): Promise<RepoSettingsLookup[]> {
  const lookups: RepoSettingsLookup[] = [];
  for (const entry of await listOwnerRepos(ctx, targetDid)) {
    lookups.push(await getRepoSettings(ctx, targetDid, entry));
  }
  return lookups;
}

async function collectUserAttestations(ctx: AgentContext, targetDid: string): Promise<StoredAttestation[]> {
  const stored: StoredAttestation[] = [];
  for (const lookup of await listOwnerSettings(ctx, targetDid)) {
    for (const [key, attestation] of attestationEntries(lookup.settings)) {
      stored.push({ ...lookup, key, attestation });
    }
  }
  return stored.sort((left, right) => (
    left.attestation.id - right.attestation.id
    || left.entry.name.localeCompare(right.entry.name)
  ));
}

function matchesPredicate(attestation: RepositoryAttestationData, predicateType: string | null): boolean {
  return !predicateType || attestation.predicateType === predicateType;
}

function buildAttestationResponse(
  stored: StoredAttestation, targetDid: string, baseUrl: string,
): Record<string, unknown> {
  return {
    id             : stored.attestation.id,
    repository_id  : numericId(`${targetDid}/${stored.entry.name}`),
    repository_url : `${baseUrl}/repos/${targetDid}/${stored.entry.name}`,
    subject_digest : stored.attestation.subjectDigest,
    predicate_type : stored.attestation.predicateType ?? null,
    bundle         : stored.attestation.bundle,
    created_at     : toISODate(stored.attestation.createdAt),
  };
}

function attestationsEnvelope(
  attestations: StoredAttestation[], targetDid: string, url: URL, path: string,
): JsonResponse {
  const baseUrl = buildApiUrl(url);
  const pagination = parsePagination(url);
  const paged = paginate(attestations, pagination);
  const linkHeader = buildLinkHeader(baseUrl, path, pagination.page, pagination.perPage, attestations.length);
  const headers: Record<string, string> = {};
  if (linkHeader) { headers.Link = linkHeader; }
  return jsonOk({
    attestations: paged.map(attestation => buildAttestationResponse(attestation, targetDid, baseUrl)),
  }, headers);
}

async function deleteMatchingAttestations(
  ctx: AgentContext, targetDid: string, matches: (attestation: RepositoryAttestationData) => boolean,
): Promise<StoredAttestation[] | JsonResponse> {
  const deleted: StoredAttestation[] = [];
  for (const lookup of await listOwnerSettings(ctx, targetDid)) {
    const entries = attestationEntries(lookup.settings).filter(([, attestation]) => matches(attestation));
    if (entries.length === 0) { continue; }
    if (!lookup.record) {
      return jsonValidationError('Failed to update repository settings: attestation settings record is missing.');
    }

    const attestations = { ...(lookup.settings.attestations ?? {}) };
    for (const [key, attestation] of entries) {
      deleted.push({ ...lookup, key, attestation });
      delete attestations[key];
    }

    const nextSettings: SettingsData = { ...lookup.settings, attestations };
    if (Object.keys(attestations).length === 0) {
      delete nextSettings.attestations;
    }

    const { status } = await lookup.record.update({ data: nextSettings });
    if (status.code >= 300) {
      return jsonValidationError(`Failed to update repository settings: ${status.detail}`);
    }
  }
  return deleted;
}

function deletedAttestationsResponse(deleted: StoredAttestation[], targetDid: string, url: URL): JsonResponse {
  if (deleted.length === 0) {
    return jsonNotFound('Artifact attestations not found.');
  }

  const baseUrl = buildApiUrl(url);
  return jsonOk({
    attestations: deleted.map(attestation => buildAttestationResponse(attestation, targetDid, baseUrl)),
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleBulkListUserAttestations(
  ctx: AgentContext, targetDid: string, body: unknown, url: URL,
): Promise<JsonResponse> {
  const subjectDigests = parseSubjectDigests(body);
  if ('status' in subjectDigests) { return subjectDigests; }

  const wanted = new Set(subjectDigests);
  const predicateType = isObject(body) && typeof body.predicate_type === 'string' ? body.predicate_type : null;
  const attestations = (await collectUserAttestations(ctx, targetDid))
    .filter(stored => wanted.has(stored.attestation.subjectDigest))
    .filter(stored => matchesPredicate(stored.attestation, predicateType));

  return attestationsEnvelope(attestations, targetDid, url, `/users/${targetDid}/attestations/bulk-list`);
}

export async function handleBulkDeleteUserAttestations(
  ctx: AgentContext, targetDid: string, body: unknown, url: URL,
): Promise<JsonResponse> {
  const subjectDigests = parseSubjectDigests(body);
  if ('status' in subjectDigests) { return subjectDigests; }

  const wanted = new Set(subjectDigests);
  const deleted = await deleteMatchingAttestations(
    ctx, targetDid, attestation => wanted.has(attestation.subjectDigest),
  );
  if ('status' in deleted) { return deleted; }
  return deletedAttestationsResponse(deleted, targetDid, url);
}

export async function handleDeleteUserAttestationsBySubjectDigest(
  ctx: AgentContext, targetDid: string, encodedSubjectDigest: string, url: URL,
): Promise<JsonResponse> {
  const subjectDigest = normalizeSubjectDigest(decodeRouteParam(encodedSubjectDigest));
  if (!subjectDigest) {
    return jsonValidationError('Validation Failed: subject_digest must be sha256:<64 hex characters>.');
  }

  const deleted = await deleteMatchingAttestations(
    ctx, targetDid, attestation => attestation.subjectDigest === subjectDigest,
  );
  if ('status' in deleted) { return deleted; }
  return deletedAttestationsResponse(deleted, targetDid, url);
}

export async function handleDeleteUserAttestationById(
  ctx: AgentContext, targetDid: string, attestationId: string, url: URL,
): Promise<JsonResponse> {
  const id = Number.parseInt(attestationId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return jsonNotFound(`Artifact attestation '${attestationId}' not found.`);
  }

  const deleted = await deleteMatchingAttestations(
    ctx, targetDid, attestation => attestation.id === id,
  );
  if ('status' in deleted) { return deleted; }
  return deletedAttestationsResponse(deleted, targetDid, url);
}

export async function handleListUserAttestations(
  ctx: AgentContext, targetDid: string, encodedSubjectDigest: string, url: URL,
): Promise<JsonResponse> {
  const subjectDigest = normalizeSubjectDigest(decodeRouteParam(encodedSubjectDigest));
  if (!subjectDigest) {
    return jsonValidationError('Validation Failed: subject_digest must be sha256:<64 hex characters>.');
  }

  const predicateType = url.searchParams.get('predicate_type');
  const attestations = (await collectUserAttestations(ctx, targetDid))
    .filter(stored => stored.attestation.subjectDigest === subjectDigest)
    .filter(stored => matchesPredicate(stored.attestation, predicateType));

  return attestationsEnvelope(
    attestations, targetDid, url, `/users/${targetDid}/attestations/${encodeURIComponent(subjectDigest)}`,
  );
}
