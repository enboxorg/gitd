/**
 * Forge Organization Protocol — organization and team management.
 *
 * Organizations are DIDs themselves. An org DID installs the forge protocols
 * and manages repos. Organization members and teams provide sub-organization
 * grouping with their own role scoping.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for an organization record. */
export type OrgData = {
  name : string;
  description? : string;
  homepage? : string;
  avatar? : string;
};

/** Data shape for an organization member (owner or member). */
export type OrgMemberData = {
  did : string;
  alias? : string;
};

/** Data shape for a team within an organization. */
export type TeamData = {
  name : string;
  description? : string;
  privacy : 'visible' | 'secret';
};

/** Data shape for a team member. */
export type TeamMemberData = {
  did : string;
  alias? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeOrgSchemaMap = {
  org : OrgData;
  owner : OrgMemberData;
  member : OrgMemberData;
  team : TeamData;
  teamMember : TeamMemberData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeOrgDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/org',
  published : true,
  types     : {
    org: {
      schema      : 'https://enbox.org/schemas/forge/org',
      dataFormats : ['application/json'],
    },
    owner: {
      schema      : 'https://enbox.org/schemas/forge/org-member',
      dataFormats : ['application/json'],
    },
    member: {
      schema      : 'https://enbox.org/schemas/forge/org-member',
      dataFormats : ['application/json'],
    },
    team: {
      schema      : 'https://enbox.org/schemas/forge/team',
      dataFormats : ['application/json'],
    },
    teamMember: {
      schema      : 'https://enbox.org/schemas/forge/team-member',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    org: {
      $recordLimit : { max: 1, strategy: 'reject' },
      $actions     : [{ who: 'anyone', can: ['read'] }],

      owner: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },

      member: {
        $role    : true,
        $actions : [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },

      team: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'update', 'delete'] },
        ],

        teamMember: {
          $role    : true,
          $actions : [
            { who: 'anyone', can: ['read'] },
            { role: 'org/owner', can: ['create', 'delete'] },
          ],
          $tags: {
            $requiredTags       : ['did'],
            $allowUndefinedTags : false,
            did                 : { type: 'string' },
          },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Org protocol for use with `dwn.using()`. */
export const ForgeOrgProtocol = defineProtocol(
  ForgeOrgDefinition,
  {} as ForgeOrgSchemaMap,
);
