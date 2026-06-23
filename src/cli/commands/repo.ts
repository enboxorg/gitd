/**
 * `gitd repo` — repository management commands.
 *
 * Usage:
 *   gitd repo info                           Show repository metadata
 *   gitd repo add-moderator <did>            Grant moderator role
 *   gitd repo remove-moderator <did>         Revoke moderator role
 *   gitd repo add-contributor <did>          Grant contributor role
 *   gitd repo remove-contributor <did>       Revoke contributor role
 *   gitd repo add-collaborator <did> <role>  Grant a role
 *   gitd repo remove-collaborator <did>      Revoke a collaborator role
 *
 * Roles: maintainer, moderator, contributor, viewer. Legacy triager is still
 * accepted by add-collaborator for compatibility.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';
import type { RepoContext } from '../repo-context.js';

import { getDwnEndpoints } from '../../git-server/did-service.js';
import { applyMessageToDwnEndpoint, applyRecordToDwnEndpoint } from '../record-send.js';
import { flagValue, resolveRepoName } from '../flags.js';
import { getRepoContext, getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Valid roles
// ---------------------------------------------------------------------------

const PRIMARY_ROLES = ['maintainer', 'moderator', 'contributor', 'viewer'] as const;
const COMPATIBILITY_ROLES = ['triager'] as const;
const VALID_ROLES = [...PRIMARY_ROLES, ...COMPATIBILITY_ROLES] as const;
type Role = typeof VALID_ROLES[number];

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function repoCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'info': return repoInfo(ctx, rest);
    case 'list': return repoList(ctx);
    case 'add-moderator': return addRole(ctx, rest, 'moderator');
    case 'remove-moderator': return removeRole(ctx, rest, 'moderator');
    case 'add-contributor': return addRole(ctx, rest, 'contributor');
    case 'remove-contributor': return removeRole(ctx, rest, 'contributor');
    case 'add-collaborator': return addCollaborator(ctx, rest);
    case 'remove-collaborator': return removeCollaborator(ctx, rest);
    default:
      console.error('Usage: gitd repo <info|list|add-moderator|remove-moderator|add-contributor|remove-contributor|add-collaborator|remove-collaborator>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// repo info
// ---------------------------------------------------------------------------

async function repoInfo(ctx: AgentContext, args: string[]): Promise<void> {
  const repoName = resolveRepoName(args);

  // If a repo name is resolved, look up that specific repo.
  // Otherwise fall back to single-repo auto-detection.
  const { records } = repoName
    ? await ctx.repo.records.query('repo', { filter: { tags: { name: repoName } } })
    : await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.error(repoName
      ? `Repository "${repoName}" not found. Run \`gitd init ${repoName}\` first.`
      : 'No repository found. Run `gitd init <name>` first.');
    process.exit(1);
  }

  if (!repoName && records.length > 1) {
    console.error('Multiple repositories exist. Specify one with --repo <name>.');
    console.error('Use `gitd repo list` to see all repositories.');
    process.exit(1);
  }

  const record = records[0];
  const data = await record.data.json();

  console.log(`Repository: ${data.name}`);
  console.log(`  DID:            ${ctx.did}`);
  console.log(`  Record ID:      ${record.id}`);
  console.log(`  Context ID:     ${record.contextId}`);
  console.log(`  Default Branch: ${data.defaultBranch}`);
  if (data.description) {
    console.log(`  Description:    ${data.description}`);
  }
  if (data.dwnEndpoints?.length > 0) {
    console.log(`  DWN Endpoints:  ${data.dwnEndpoints.join(', ')}`);
  }
  if (data.gitEndpoints && data.gitEndpoints.length > 0) {
    console.log(`  Git Endpoints:  ${data.gitEndpoints.join(', ')}`);
  }

  // List collaborators per role.
  for (const role of VALID_ROLES) {
    const { records: collabs } = await ctx.repo.records.query(`repo/${role}` as any, {
      filter: { contextId: record.contextId },
    });
    if (collabs.length > 0) {
      console.log(`\n  ${role}s:`);
      for (const collab of collabs) {
        const collabData = await collab.data.json();
        const alias = collabData.alias ? ` (${collabData.alias})` : '';
        console.log(`    - ${collabData.did}${alias}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// repo list
// ---------------------------------------------------------------------------

async function repoList(ctx: AgentContext): Promise<void> {
  const { records } = await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.log('No repositories found. Run `gitd init <name>` to create one.');
    return;
  }

  console.log(`Repositories (${records.length}):\n`);
  for (const record of records) {
    const data = await record.data.json();
    const tags = record.tags as Record<string, string> | undefined;
    const vis = tags?.visibility ?? 'public';
    console.log(`  ${data.name}`);
    console.log(`    ${vis}  branch: ${data.defaultBranch}  id: ${record.id}`);
  }
}

// ---------------------------------------------------------------------------
// repo add-collaborator
// ---------------------------------------------------------------------------

async function addCollaborator(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];
  const role = args[1] as Role | undefined;

  if (!did || !role) {
    console.error('Usage: gitd repo add-collaborator <did> <role> [--alias <name>]');
    console.error(`  Roles: ${PRIMARY_ROLES.join(', ')} (legacy: ${COMPATIBILITY_ROLES.join(', ')})`);
    process.exit(1);
  }

  if (!VALID_ROLES.includes(role)) {
    console.error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  await addRole(ctx, args, role);
}

async function addRole(ctx: AgentContext, args: string[], role: Role): Promise<void> {
  const did = args[0];
  const alias = flagValue(args, '--alias') ?? flagValue(args, '-a');

  if (!did) {
    console.error(`Usage: gitd repo add-${role} <did> [--alias <name>]`);
    process.exit(1);
  }

  const repo = await getRepoContext(ctx, resolveRepoName(args));

  const { status, record } = await ctx.repo.records.create(`repo/${role}` as any, {
    data            : { did, alias: alias ?? '' },
    tags            : { did },
    parentContextId : repo.contextId,
    recipient       : did,
    ...(repo.visibility === 'public' ? { published: true } : {}),
  });

  if (status.code >= 300) {
    if (status.detail?.includes('ProtocolAuthorizationDuplicateRoleRecipient')) {
      const existing = await findRoleGrant(ctx, repo, role, did);
      if (existing) {
        await publishRoleGrant(ctx, repo, existing, role);
        console.log(`Added ${role}: ${did}`);
        console.log(`  Record ID: ${existing.id}`);
        return;
      }
    }
    console.error(`Failed to add collaborator: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create collaborator record');}

  await publishRoleGrant(ctx, repo, record, role);

  console.log(`Added ${role}: ${did}`);
  console.log(`  Record ID: ${record.id}`);
}

async function findRoleGrant(
  ctx: AgentContext,
  repo: RepoContext,
  role: Role,
  did: string,
): Promise<any | undefined> {
  const { records } = await ctx.repo.records.query(`repo/${role}` as any, {
    filter: {
      contextId : repo.contextId,
      tags      : { did },
    },
  });
  return records[0];
}

async function publishRoleGrant(
  ctx: AgentContext,
  repo: RepoContext,
  roleRecord: any,
  role: Role,
): Promise<void> {
  if (repo.visibility !== 'public') {
    return;
  }

  const dwnEndpoints = getDwnEndpoints(ctx.enbox);
  if (dwnEndpoints.length === 0) {
    return;
  }

  const { records: repoRecords } = await ctx.repo.records.query('repo', {
    filter: { tags: { name: repo.name } },
  });
  const repoRecord = repoRecords.find((record: any) => record.id === repo.recordId) ?? repoRecords[0];
  if (!repoRecord) {
    console.warn(`Warning: could not publish ${role} grant: repo record not found locally.`);
    return;
  }

  const protocolResult = await ctx.repo.configure({ encryption: true });
  for (const endpoint of dwnEndpoints) {
    try {
      if (protocolResult.protocol) {
        await applyMessageToDwnEndpoint(endpoint, ctx.did, protocolResult.protocol.toJSON(), 'repo protocol');
      }
      await applyRecordToDwnEndpoint(endpoint, ctx.did, repoRecord, 'repo record');
      await applyRecordToDwnEndpoint(endpoint, ctx.did, roleRecord, `${role} grant`);
    } catch (err) {
      console.warn(`Warning: could not publish ${role} grant to ${endpoint}: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// repo remove-collaborator
// ---------------------------------------------------------------------------

async function removeCollaborator(ctx: AgentContext, args: string[]): Promise<void> {
  return removeRole(ctx, args);
}

async function removeRole(ctx: AgentContext, args: string[], onlyRole?: Role): Promise<void> {
  const did = args[0];

  if (!did) {
    const usage = onlyRole
      ? `Usage: gitd repo remove-${onlyRole} <did>`
      : 'Usage: gitd repo remove-collaborator <did>';
    console.error(usage);
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx, resolveRepoName(args));
  let found = false;

  for (const role of onlyRole ? [onlyRole] : VALID_ROLES) {
    const { records: collabs } = await ctx.repo.records.query(`repo/${role}` as any, {
      filter: { contextId: repoContextId, tags: { did } },
    });

    for (const collab of collabs) {
      const { status } = await collab.delete();
      if (status.code < 300) {
        console.log(`Removed ${role} role for ${did} (recordId: ${collab.id})`);
        found = true;
      }
    }
  }

  if (!found) {
    console.error(`No collaborator roles found for DID: ${did}`);
    process.exit(1);
  }
}
