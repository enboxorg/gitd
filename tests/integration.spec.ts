/**
 * Integration tests for gitd forge protocols against a real in-memory DWN.
 *
 * These tests validate that protocol definitions can be installed, records can
 * be written/queried/read/deleted, roles work correctly, and cross-protocol
 * role composition functions as designed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

import type { Persona } from '@enbox/dwn-sdk-js';

import {
  DataStoreLevel,
  DataStream,
  Dwn,
  EventEmitterEventLog,
  Jws,
  MessageStoreLevel,
  ProtocolsConfigure,
  RecordsDelete,
  RecordsQuery,
  RecordsRead,
  RecordsWrite,
  ResumableTaskStoreLevel,
  StateIndexLevel,
  TestDataGenerator,
} from '@enbox/dwn-sdk-js';

import {
  ForgeCiDefinition,
  ForgeIssuesDefinition,
  ForgePatchesDefinition,
  ForgeRepoDefinition,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Creates a ProtocolsConfigure, processes it, and asserts success. */
async function installProtocol(
  dwn: Dwn, persona: Persona, definition: any,
): Promise<void> {
  const configure = await ProtocolsConfigure.create({
    definition,
    signer: Jws.createSigner(persona),
  });
  const reply = await dwn.processMessage(persona.did, configure.message);
  expect(reply.status.code).toBe(202);
}

/** Writes a record and returns the RecordsWrite message. */
async function writeRecord(
  dwn: Dwn,
  target: string,
  options: {
    author : Persona;
    protocol : string;
    protocolPath : string;
    schema? : string;
    dataFormat? : string;
    data? : Uint8Array;
    tags? : Record<string, any>;
    parentContextId?: string;
    recipient? : string;
    protocolRole? : string;
  },
): Promise<RecordsWrite> {
  const data = options.data ?? encoder.encode('{}');
  const write = await RecordsWrite.create({
    protocol        : options.protocol,
    protocolPath    : options.protocolPath,
    schema          : options.schema,
    dataFormat      : options.dataFormat ?? 'application/json',
    data,
    tags            : options.tags,
    parentContextId : options.parentContextId,
    recipient       : options.recipient,
    protocolRole    : options.protocolRole,
    signer          : Jws.createSigner(options.author),
  });
  const reply = await dwn.processMessage(
    target, write.message, { dataStream: DataStream.fromBytes(data) },
  );
  expect(reply.status.code).toBe(202);
  return write;
}

/** Queries records and returns the reply. */
async function queryRecords(
  dwn: Dwn,
  target: string,
  author: Persona,
  filter: Record<string, any>,
  protocolRole?: string,
): Promise<any> {
  const query = await RecordsQuery.create({
    signer: Jws.createSigner(author),
    filter,
    protocolRole,
  });
  const reply = await dwn.processMessage(target, query.message);
  expect(reply.status.code).toBe(200);
  return reply;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('gitd integration', () => {
  let dwn: Dwn;
  let messageStore: MessageStoreLevel;
  let dataStore: DataStoreLevel;
  let stateIndex: StateIndexLevel;
  let resumableTaskStore: ResumableTaskStoreLevel;

  // Personas
  let owner: Persona; // Repo owner (DWN tenant)
  let maintainer: Persona; // Has maintainer role
  let contributor: Persona; // Has contributor role
  let stranger: Persona; // No role

  beforeAll(async () => {
    const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
    messageStore = new MessageStoreLevel({ blockstoreLocation: '__TESTDATA__/int-msg', indexLocation: '__TESTDATA__/int-idx' });
    dataStore = new DataStoreLevel({ blockstoreLocation: '__TESTDATA__/int-data' });
    stateIndex = new StateIndexLevel({ location: '__TESTDATA__/int-state' });
    resumableTaskStore = new ResumableTaskStoreLevel({ location: '__TESTDATA__/int-tasks' });
    const eventLog = new EventEmitterEventLog();

    dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, resumableTaskStore, eventLog });
  });

  beforeEach(async () => {
    await messageStore.clear();
    await dataStore.clear();
    await stateIndex.clear();
    await resumableTaskStore.clear();

    // Create fresh personas for each test
    owner = await TestDataGenerator.generateDidKeyPersona();
    maintainer = await TestDataGenerator.generateDidKeyPersona();
    contributor = await TestDataGenerator.generateDidKeyPersona();
    stranger = await TestDataGenerator.generateDidKeyPersona();
  });

  afterAll(async () => {
    await dwn.close();
  });

  // =========================================================================
  // ForgeRepoProtocol
  // =========================================================================

  describe('forge-repo', () => {
    it('should install the protocol and create a repo record', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);

      const write = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      // Query the repo back
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
      });
      expect(reply.entries?.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(write.message.recordId);
    });

    it('should allow multiple repos (no $recordLimit)', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);

      // First repo succeeds
      const write1 = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'repo-1', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'repo-1', visibility: 'public' },
      });
      expect(write1.message.descriptor.dateCreated).toBeDefined();

      // Second repo with a different name should also succeed
      const data = encoder.encode(JSON.stringify({ name: 'repo-2', defaultBranch: 'main', dwnEndpoints: [] }));
      const write2 = await RecordsWrite.create({
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        dataFormat   : 'application/json',
        data,
        tags         : { name: 'repo-2', visibility: 'public' },
        signer       : Jws.createSigner(owner),
      });
      const reply = await dwn.processMessage(owner.did, write2.message, { dataStream: DataStream.fromBytes(data) });
      expect(reply.status.code).toBe(202);
    });

    it('should assign maintainer role and allow role-based readme write', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);

      // Create repo
      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      // Assign maintainer role to the maintainer persona
      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : maintainer.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/maintainer',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: maintainer.did, alias: 'alice' })),
        tags            : { did: maintainer.did },
        parentContextId : repo.message.contextId,
      });

      // Maintainer writes a readme using the role
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/readme',
        dataFormat      : 'text/markdown',
        data            : encoder.encode('# My Repo\n\nThis is the readme.'),
        parentContextId : repo.message.contextId,
        protocolRole    : 'repo/maintainer',
      });

      // Verify the readme exists
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo/readme',
      });
      expect(reply.entries?.length).toBe(1);
    });

    it('should allow anyone to read published repo records', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);

      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'public-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'public-repo', visibility: 'public' },
      });

      // Stranger can read the repo record (protocol is published, repo has anyone-read)
      const read = await RecordsRead.create({
        filter : { recordId: repo.message.recordId },
        signer : Jws.createSigner(stranger),
      });
      const readReply = await dwn.processMessage(owner.did, read.message);
      expect(readReply.status.code).toBe(200);
    });

    it('should assign contributor role', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);

      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      // Assign contributor role
      const roleWrite = await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : contributor.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/contributor',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: contributor.did })),
        tags            : { did: contributor.did },
        parentContextId : repo.message.contextId,
      });

      // Verify role record exists
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo/contributor',
      });
      expect(reply.entries?.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(roleWrite.message.recordId);
    });
  });

  // =========================================================================
  // ForgeIssuesProtocol (cross-protocol roles)
  // =========================================================================

  describe('forge-issues', () => {
    /** Setup helper: installs both protocols, creates repo, assigns roles. */
    async function setupRepoWithRoles(): Promise<{ repoContextId: string }> {
      // Install repo protocol first (required by issues' `uses`)
      await installProtocol(dwn, owner, ForgeRepoDefinition);
      await installProtocol(dwn, owner, ForgeIssuesDefinition);

      // Create repo
      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      // Assign maintainer role
      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : maintainer.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/maintainer',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: maintainer.did })),
        tags            : { did: maintainer.did },
        parentContextId : repo.message.contextId,
      });

      // Assign contributor role
      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : contributor.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/contributor',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: contributor.did })),
        tags            : { did: contributor.did },
        parentContextId : repo.message.contextId,
      });

      return { repoContextId: repo.message.contextId! };
    }

    it('should allow contributor to create an issue using cross-protocol role', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      // Contributor creates an issue on owner's DWN via cross-protocol role
      const issue = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Bug report', body: 'Something is broken' })),
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Verify issue was written
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeIssuesDefinition.protocol,
        protocolPath : 'repo/issue',
      });
      expect(reply.entries?.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(issue.message.recordId);
    });

    it('should allow maintainer to create an issue with full permissions', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Feature request', body: 'Please add X' })),
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeIssuesDefinition.protocol,
        protocolPath : 'repo/issue',
      });
      expect(reply.entries?.length).toBe(1);
    });

    it('should allow issue creation from anyone (open model)', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      const data = encoder.encode(JSON.stringify({ title: 'External report', body: 'Found a bug' }));
      const write = await RecordsWrite.create({
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        dataFormat      : 'application/json',
        data,
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        signer          : Jws.createSigner(stranger),
      });
      const reply = await dwn.processMessage(owner.did, write.message, { dataStream: DataStream.fromBytes(data) });
      expect(reply.status.code).toBe(202);
    });

    it('should create nested comments on issues', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      // Create issue
      const issue = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Bug', body: 'Broken' })),
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Create comment on the issue
      const comment = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue/comment',
        schema          : 'https://enbox.org/schemas/forge/comment',
        data            : encoder.encode(JSON.stringify({ body: 'I can reproduce this.' })),
        parentContextId : issue.message.contextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Query comments
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeIssuesDefinition.protocol,
        protocolPath : 'repo/issue/comment',
        contextId    : issue.message.contextId,
      });
      expect(reply.entries?.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(comment.message.recordId);
    });

    it('should enforce $immutable on label records (no updates)', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      // Create issue
      const issue = await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Bug', body: 'Broken' })),
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Create label (immutable)
      const label = await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue/label',
        schema          : 'https://enbox.org/schemas/forge/label',
        data            : encoder.encode(JSON.stringify({ name: 'bug', color: '#ff0000' })),
        tags            : { name: 'bug', color: '#ff0000' },
        parentContextId : issue.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Try to update the label — should fail ($immutable)
      const updateData = encoder.encode(JSON.stringify({ name: 'feature', color: '#00ff00' }));
      const update = await RecordsWrite.createFrom({
        recordsWriteMessage : label.message,
        data                : updateData,
        signer              : Jws.createSigner(maintainer),
        protocolRole        : 'repo:repo/maintainer',
      });
      const updateReply = await dwn.processMessage(
        owner.did, update.message, { dataStream: DataStream.fromBytes(updateData) },
      );
      expect(updateReply.status.code).not.toBe(202);
    });

    it('should create $immutable statusChange records', async () => {
      const { repoContextId } = await setupRepoWithRoles();

      const issue = await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Bug', body: 'Fixed it' })),
        tags            : { status: 'open' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Create status change (open -> closed)
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue/statusChange',
        schema          : 'https://enbox.org/schemas/forge/status-change',
        data            : encoder.encode(JSON.stringify({ reason: 'Fixed in PR #1' })),
        tags            : { from: 'open', to: 'closed' },
        parentContextId : issue.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeIssuesDefinition.protocol,
        protocolPath : 'repo/issue/statusChange',
        contextId    : issue.message.contextId,
      });
      expect(reply.entries?.length).toBe(1);
    });
  });

  // =========================================================================
  // ForgePatchesProtocol
  // =========================================================================

  describe('forge-patches', () => {
    /** Setup: installs repo + patches protocols, creates repo, assigns roles. */
    async function setupPatchesEnv(): Promise<{ repoContextId: string }> {
      await installProtocol(dwn, owner, ForgeRepoDefinition);
      await installProtocol(dwn, owner, ForgePatchesDefinition);

      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : maintainer.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/maintainer',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: maintainer.did })),
        tags            : { did: maintainer.did },
        parentContextId : repo.message.contextId,
      });

      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : contributor.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/contributor',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: contributor.did })),
        tags            : { did: contributor.did },
        parentContextId : repo.message.contextId,
      });

      return { repoContextId: repo.message.contextId! };
    }

    it('should create a patch (PR) as contributor', async () => {
      const { repoContextId } = await setupPatchesEnv();

      const patch = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch',
        schema          : 'https://enbox.org/schemas/forge/patch',
        data            : encoder.encode(JSON.stringify({ title: 'Add feature X', body: 'This adds feature X.' })),
        tags            : { status: 'open', baseBranch: 'main', headBranch: 'feature-x' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgePatchesDefinition.protocol,
        protocolPath : 'repo/patch',
      });
      expect(reply.entries?.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(patch.message.recordId);
    });

    it('should create immutable revision under a patch', async () => {
      const { repoContextId } = await setupPatchesEnv();

      const patch = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch',
        schema          : 'https://enbox.org/schemas/forge/patch',
        data            : encoder.encode(JSON.stringify({ title: 'Feature X', body: 'Adds X' })),
        tags            : { status: 'open', baseBranch: 'main' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Author creates a revision (no protocolRole — author of patch is inferred)
      await writeRecord(dwn, owner.did, {
        author       : contributor,
        protocol     : ForgePatchesDefinition.protocol,
        protocolPath : 'repo/patch/revision',
        schema       : 'https://enbox.org/schemas/forge/revision',
        data         : encoder.encode(JSON.stringify({
          diffStat: { additions: 50, deletions: 10, filesChanged: 3 },
        })),
        tags            : { headCommit: 'abc123', baseCommit: 'def456', commitCount: 1 },
        parentContextId : patch.message.contextId,
      });

      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgePatchesDefinition.protocol,
        protocolPath : 'repo/patch/revision',
        contextId    : patch.message.contextId,
      });
      expect(reply.entries?.length).toBe(1);
    });

    it('should allow maintainer to create review and merge result', async () => {
      const { repoContextId } = await setupPatchesEnv();

      const patch = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch',
        schema          : 'https://enbox.org/schemas/forge/patch',
        data            : encoder.encode(JSON.stringify({ title: 'Feature X', body: 'Adds X' })),
        tags            : { status: 'open', baseBranch: 'main' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Maintainer creates a review
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch/review',
        schema          : 'https://enbox.org/schemas/forge/review',
        data            : encoder.encode(JSON.stringify({ body: 'LGTM!' })),
        tags            : { verdict: 'approve' },
        parentContextId : patch.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Maintainer creates merge result (singleton)
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch/mergeResult',
        schema          : 'https://enbox.org/schemas/forge/merge-result',
        data            : encoder.encode(JSON.stringify({ mergedBy: maintainer.did })),
        tags            : { mergeCommit: 'deadbeef', strategy: 'squash' },
        parentContextId : patch.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Verify merge result
      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgePatchesDefinition.protocol,
        protocolPath : 'repo/patch/mergeResult',
        contextId    : patch.message.contextId,
      });
      expect(reply.entries?.length).toBe(1);
    });

    it('should enforce $recordLimit on mergeResult singleton', async () => {
      const { repoContextId } = await setupPatchesEnv();

      const patch = await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch',
        schema          : 'https://enbox.org/schemas/forge/patch',
        data            : encoder.encode(JSON.stringify({ title: 'Feature X', body: 'Adds X' })),
        tags            : { status: 'open', baseBranch: 'main' },
        parentContextId : repoContextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // First merge result succeeds
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch/mergeResult',
        schema          : 'https://enbox.org/schemas/forge/merge-result',
        data            : encoder.encode(JSON.stringify({ mergedBy: maintainer.did })),
        tags            : { mergeCommit: 'deadbeef', strategy: 'squash' },
        parentContextId : patch.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Second merge result should be rejected
      const data = encoder.encode(JSON.stringify({ mergedBy: maintainer.did }));
      const write = await RecordsWrite.create({
        protocol        : ForgePatchesDefinition.protocol,
        protocolPath    : 'repo/patch/mergeResult',
        schema          : 'https://enbox.org/schemas/forge/merge-result',
        dataFormat      : 'application/json',
        data,
        tags            : { mergeCommit: 'cafebabe', strategy: 'merge' },
        parentContextId : patch.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
        signer          : Jws.createSigner(maintainer),
      });
      const reply = await dwn.processMessage(owner.did, write.message, { dataStream: DataStream.fromBytes(data) });
      // $recordLimit exceeded — DWN rejects with non-202 status
      expect(reply.status.code).not.toBe(202);
    });
  });

  // =========================================================================
  // ForgeCiProtocol
  // =========================================================================

  describe('forge-ci', () => {
    it('should allow maintainer to create check suite and check run', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);
      await installProtocol(dwn, owner, ForgeCiDefinition);

      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'my-repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'my-repo', visibility: 'public' },
      });

      // Assign maintainer role (CI bot would be a maintainer)
      await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : maintainer.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/maintainer',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: maintainer.did })),
        tags            : { did: maintainer.did },
        parentContextId : repo.message.contextId,
      });

      // Maintainer creates check suite
      const suite = await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeCiDefinition.protocol,
        protocolPath    : 'repo/checkSuite',
        schema          : 'https://enbox.org/schemas/forge/check-suite',
        data            : encoder.encode(JSON.stringify({ headBranch: 'main' })),
        tags            : { commitSha: 'abc123', status: 'queued' },
        parentContextId : repo.message.contextId,
        protocolRole    : 'repo:repo/maintainer',
      });

      // Suite author creates check run (authorized as author of checkSuite, no protocolRole needed)
      await writeRecord(dwn, owner.did, {
        author          : maintainer,
        protocol        : ForgeCiDefinition.protocol,
        protocolPath    : 'repo/checkSuite/checkRun',
        schema          : 'https://enbox.org/schemas/forge/check-run',
        data            : encoder.encode(JSON.stringify({ summary: 'Running lint...' })),
        tags            : { name: 'lint', status: 'in_progress' },
        parentContextId : suite.message.contextId,
      });

      const reply = await queryRecords(dwn, owner.did, owner, {
        protocol     : ForgeCiDefinition.protocol,
        protocolPath : 'repo/checkSuite/checkRun',
        contextId    : suite.message.contextId,
      });
      expect(reply.entries?.length).toBe(1);
    });
  });

  // =========================================================================
  // Role revocation
  // =========================================================================

  describe('role revocation', () => {
    it('should deny access after role record is deleted', async () => {
      await installProtocol(dwn, owner, ForgeRepoDefinition);
      await installProtocol(dwn, owner, ForgeIssuesDefinition);

      const repo = await writeRecord(dwn, owner.did, {
        author       : owner,
        protocol     : ForgeRepoDefinition.protocol,
        protocolPath : 'repo',
        schema       : 'https://enbox.org/schemas/forge/repo',
        data         : encoder.encode(JSON.stringify({ name: 'repo', defaultBranch: 'main', dwnEndpoints: [] })),
        tags         : { name: 'repo', visibility: 'public' },
      });

      // Grant contributor role
      const roleRecord = await writeRecord(dwn, owner.did, {
        author          : owner,
        recipient       : contributor.did,
        protocol        : ForgeRepoDefinition.protocol,
        protocolPath    : 'repo/contributor',
        schema          : 'https://enbox.org/schemas/forge/collaborator',
        data            : encoder.encode(JSON.stringify({ did: contributor.did })),
        tags            : { did: contributor.did },
        parentContextId : repo.message.contextId,
      });

      // Contributor can create issue
      await writeRecord(dwn, owner.did, {
        author          : contributor,
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        data            : encoder.encode(JSON.stringify({ title: 'Before revoke', body: 'Works' })),
        tags            : { status: 'open' },
        parentContextId : repo.message.contextId,
        protocolRole    : 'repo:repo/contributor',
      });

      // Revoke the role (owner deletes the role record)
      const del = await RecordsDelete.create({
        recordId : roleRecord.message.recordId,
        signer   : Jws.createSigner(owner),
      });
      await dwn.processMessage(owner.did, del.message);

      // Contributor should now be rejected
      const data = encoder.encode(JSON.stringify({ title: 'After revoke', body: 'Should fail' }));
      const write = await RecordsWrite.create({
        protocol        : ForgeIssuesDefinition.protocol,
        protocolPath    : 'repo/issue',
        schema          : 'https://enbox.org/schemas/forge/issue',
        dataFormat      : 'application/json',
        data,
        tags            : { status: 'open' },
        parentContextId : repo.message.contextId,
        protocolRole    : 'repo:repo/contributor',
        signer          : Jws.createSigner(contributor),
      });
      const reply = await dwn.processMessage(owner.did, write.message, { dataStream: DataStream.fromBytes(data) });
      expect(reply.status.code).not.toBe(202);
    });
  });
});
