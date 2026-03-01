/**
 * `gitd org` — organization and team management.
 *
 * Usage:
 *   gitd org create <name> [--description <text>]
 *   gitd org info
 *   gitd org add-member <did> [--alias <name>]
 *   gitd org remove-member <did>
 *   gitd org list-members
 *   gitd org add-owner <did> [--alias <name>]
 *   gitd org team create <name> [--description <text>] [--privacy <visible|secret>]
 *   gitd org team list
 *   gitd org team add-member <team-name> <did>
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { flagValue } from '../flags.js';

// ---------------------------------------------------------------------------
// Sub-command dispatch
// ---------------------------------------------------------------------------

export async function orgCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return orgCreate(ctx, rest);
    case 'info': return orgInfo(ctx, rest);
    case 'add-member': return orgAddMember(ctx, rest);
    case 'remove-member': return orgRemoveMember(ctx, rest);
    case 'list-members': return orgListMembers(ctx, rest);
    case 'add-owner': return orgAddOwner(ctx, rest);
    case 'team': return orgTeam(ctx, rest);
    default:
      console.error('Usage: gitd org <create|info|add-member|remove-member|list-members|add-owner|team>');
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrgRecord(ctx: AgentContext): Promise<any> {
  const { records } = await ctx.org.records.query('org');
  if (records.length === 0) {
    console.error('No organization found. Run `gitd org create <name>` first.');
    process.exit(1);
  }
  return records[0];
}

// ---------------------------------------------------------------------------
// org create
// ---------------------------------------------------------------------------

async function orgCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? '';

  if (!name) {
    console.error('Usage: gitd org create <name> [--description <text>]');
    process.exit(1);
  }

  // Check if org already exists (singleton).
  const { records: existing } = await ctx.org.records.query('org');
  if (existing.length > 0) {
    console.error('Organization already exists. Only one org per DWN is allowed.');
    process.exit(1);
  }

  const { status, record } = await ctx.org.records.create('org', {
    data: { name, description },
  });

  if (status.code >= 300) {
    console.error(`Failed to create organization: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create organization record');}

  console.log(`Created organization: ${name}`);
  console.log(`  Record ID: ${record.id}`);
}

// ---------------------------------------------------------------------------
// org info
// ---------------------------------------------------------------------------

async function orgInfo(ctx: AgentContext, _args: string[]): Promise<void> {
  const org = await getOrgRecord(ctx);
  const data = await org.data.json();
  const date = org.dateCreated?.slice(0, 10) ?? '';

  console.log(`Organization: ${data.name}`);
  if (data.description) { console.log(`  Description: ${data.description}`); }
  console.log(`  DID:     ${ctx.did}`);
  console.log(`  Created: ${date}`);
  console.log(`  ID:      ${org.id}`);

  // List owners.
  const { records: owners } = await ctx.org.records.query('org/owner' as any, {
    filter: { contextId: org.contextId },
  });
  if (owners.length > 0) {
    console.log('');
    console.log(`  Owners (${owners.length}):`);
    for (const o of owners) {
      const oData = await o.data.json();
      console.log(`    ${oData.did}${oData.alias ? ` (${oData.alias})` : ''}`);
    }
  }

  // List members.
  const { records: members } = await ctx.org.records.query('org/member' as any, {
    filter: { contextId: org.contextId },
  });
  if (members.length > 0) {
    console.log('');
    console.log(`  Members (${members.length}):`);
    for (const m of members) {
      const mData = await m.data.json();
      console.log(`    ${mData.did}${mData.alias ? ` (${mData.alias})` : ''}`);
    }
  }

  // List teams.
  const { records: teams } = await ctx.org.records.query('org/team' as any, {
    filter: { contextId: org.contextId },
  });
  if (teams.length > 0) {
    console.log('');
    console.log(`  Teams (${teams.length}):`);
    for (const t of teams) {
      const tData = await t.data.json();
      console.log(`    ${tData.name}${tData.description ? ` — ${tData.description}` : ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// org add-member
// ---------------------------------------------------------------------------

async function orgAddMember(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];
  const alias = flagValue(args, '--alias');

  if (!did) {
    console.error('Usage: gitd org add-member <did> [--alias <name>]');
    process.exit(1);
  }

  const org = await getOrgRecord(ctx);

  const { status } = await ctx.org.records.create('org/member' as any, {
    data            : { did, alias },
    tags            : { did },
    parentContextId : org.contextId,
    recipient       : did,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add member: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added member: ${did}${alias ? ` (${alias})` : ''}`);
}

// ---------------------------------------------------------------------------
// org remove-member
// ---------------------------------------------------------------------------

async function orgRemoveMember(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];
  if (!did) {
    console.error('Usage: gitd org remove-member <did>');
    process.exit(1);
  }

  const org = await getOrgRecord(ctx);

  const { records } = await ctx.org.records.query('org/member' as any, {
    filter: {
      contextId : org.contextId,
      tags      : { did },
    },
  });

  if (records.length === 0) {
    console.error(`Member ${did} not found.`);
    process.exit(1);
  }

  const { status } = await records[0].delete();
  if (status.code >= 300) {
    console.error(`Failed to remove member: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Removed member: ${did}`);
}

// ---------------------------------------------------------------------------
// org list-members
// ---------------------------------------------------------------------------

async function orgListMembers(ctx: AgentContext, _args: string[]): Promise<void> {
  const org = await getOrgRecord(ctx);

  const { records: owners } = await ctx.org.records.query('org/owner' as any, {
    filter: { contextId: org.contextId },
  });

  const { records: members } = await ctx.org.records.query('org/member' as any, {
    filter: { contextId: org.contextId },
  });

  if (owners.length === 0 && members.length === 0) {
    console.log('No members found.');
    return;
  }

  if (owners.length > 0) {
    console.log(`Owners (${owners.length}):`);
    for (const o of owners) {
      const oData = await o.data.json();
      console.log(`  ${oData.did}${oData.alias ? ` (${oData.alias})` : ''} [owner]`);
    }
  }

  if (members.length > 0) {
    console.log(`Members (${members.length}):`);
    for (const m of members) {
      const mData = await m.data.json();
      console.log(`  ${mData.did}${mData.alias ? ` (${mData.alias})` : ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// org add-owner
// ---------------------------------------------------------------------------

async function orgAddOwner(ctx: AgentContext, args: string[]): Promise<void> {
  const did = args[0];
  const alias = flagValue(args, '--alias');

  if (!did) {
    console.error('Usage: gitd org add-owner <did> [--alias <name>]');
    process.exit(1);
  }

  const org = await getOrgRecord(ctx);

  const { status } = await ctx.org.records.create('org/owner' as any, {
    data            : { did, alias },
    tags            : { did },
    parentContextId : org.contextId,
    recipient       : did,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add owner: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added owner: ${did}${alias ? ` (${alias})` : ''}`);
}

// ---------------------------------------------------------------------------
// org team sub-commands
// ---------------------------------------------------------------------------

async function orgTeam(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create': return teamCreate(ctx, rest);
    case 'list':
    case 'ls': return teamList(ctx, rest);
    case 'add-member': return teamAddMember(ctx, rest);
    default:
      console.error('Usage: gitd org team <create|list|add-member>');
      process.exit(1);
  }
}

async function teamCreate(ctx: AgentContext, args: string[]): Promise<void> {
  const name = args[0];
  const description = flagValue(args, '--description') ?? '';
  const privacy = flagValue(args, '--privacy') ?? 'visible';

  if (!name) {
    console.error('Usage: gitd org team create <name> [--description <text>] [--privacy <visible|secret>]');
    process.exit(1);
  }

  const org = await getOrgRecord(ctx);

  const { status, record } = await ctx.org.records.create('org/team' as any, {
    data            : { name, description, privacy },
    parentContextId : org.contextId,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to create team: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  if (!record) {throw new Error('Failed to create team record');}

  console.log(`Created team: ${name}`);
  console.log(`  Team ID: ${record.id}`);
}

async function teamList(ctx: AgentContext, _args: string[]): Promise<void> {
  const org = await getOrgRecord(ctx);

  const { records } = await ctx.org.records.query('org/team' as any, {
    filter: { contextId: org.contextId },
  });

  if (records.length === 0) {
    console.log('No teams found.');
    return;
  }

  console.log(`Teams (${records.length}):\n`);
  for (const rec of records) {
    const data = await rec.data.json();
    console.log(`  ${data.name}${data.description ? ` — ${data.description}` : ''} [${data.privacy ?? 'visible'}]`);
    console.log(`    id: ${rec.id}`);
  }
}

async function teamAddMember(ctx: AgentContext, args: string[]): Promise<void> {
  const teamName = args[0];
  const did = args[1];

  if (!teamName || !did) {
    console.error('Usage: gitd org team add-member <team-name> <did>');
    process.exit(1);
  }

  const org = await getOrgRecord(ctx);

  // Find the team by name.
  const { records: teams } = await ctx.org.records.query('org/team' as any, {
    filter: { contextId: org.contextId },
  });

  let foundTeam: any;
  for (const t of teams) {
    const d = await t.data.json();
    if (d.name === teamName) { foundTeam = t; break; }
  }

  if (!foundTeam) {
    console.error(`Team "${teamName}" not found.`);
    process.exit(1);
  }

  const { status } = await ctx.org.records.create('org/team/teamMember' as any, {
    data            : { did },
    tags            : { did },
    parentContextId : foundTeam.contextId,
    recipient       : did,
  } as any);

  if (status.code >= 300) {
    console.error(`Failed to add team member: ${status.code} ${status.detail}`);
    process.exit(1);
  }

  console.log(`Added ${did} to team "${teamName}".`);
}
