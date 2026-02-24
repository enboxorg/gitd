/**
 * `dwn-git repo` — repository management commands.
 *
 * Usage:
 *   dwn-git repo info                           Show repository metadata
 *   dwn-git repo add-collaborator <did> <role>  Grant a role
 *   dwn-git repo remove-collaborator <did>      Revoke a collaborator role
 *
 * Roles: maintainer, triager, contributor
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';
import { getRepoContextId } from '../repo-context.js';

// ---------------------------------------------------------------------------
// Valid roles
// ---------------------------------------------------------------------------

const VALID_ROLES = ['maintainer', 'triager', 'contributor'] as const;
type Role = typeof VALID_ROLES[number];

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function repoCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'info': return repoInfo(ctx);
    case 'add-collaborator': return addCollaborator(ctx, rest);
    case 'remove-collaborator': return removeCollaborator(ctx, rest);
    default:
      console.error('Usage: dwn-git repo <info|add-collaborator|remove-collaborator>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// repo info
// ---------------------------------------------------------------------------

async function repoInfo(ctx: AgentContext): Promise<void> {
  const { records } = await ctx.repo.records.query('repo');

  if (records.length === 0) {
    console.error('No repository found. Run `dwn-git init <name>` first.');
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
    const { records: collabs } = await ctx.repo.records.query(`repo/${role}` as any);
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
// repo add-collaborator
// ---------------------------------------------------------------------------

async function addCollaborator(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];
  const role = args[1] as Role | undefined;
  const alias = flagValue(args, '--alias') ?? flagValue(args, '-a');

  if (!did || !role) {
    console.error('Usage: dwn-git repo add-collaborator <did> <role> [--alias <name>]');
    console.error(`  Roles: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  if (!VALID_ROLES.includes(role)) {
    console.error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  const repoContextId = await getRepoContextId(ctx);

  const { status, record } = await ctx.repo.records.create(`repo/${role}` as any, {
    data            : { did, alias: alias ?? '' },
    tags            : { did },
    parentContextId : repoContextId,
    recipient       : did,
  });

  if (status.code >= 300) {
    console.error(`Failed to add collaborator: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added ${role}: ${did}`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// repo remove-collaborator
// ---------------------------------------------------------------------------

async function removeCollaborator(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];

  if (!did) {
    console.error('Usage: dwn-git repo remove-collaborator <did>');
    process.exit(1);
  }

  let found = false;

  for (const role of VALID_ROLES) {
    const { records: collabs } = await ctx.repo.records.query(`repo/${role}` as any, {
      filter: { tags: { did } },
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


