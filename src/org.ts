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
  public? : boolean;
};

/** Data shape for a user blocked by an organization. */
export type OrgBlockedUserData = {
  did : string;
  blockedAt? : string;
  blockedBy? : string;
};

/** Data shape for a team within an organization. */
export type TeamData = {
  name : string;
  description? : string;
  privacy : 'visible' | 'secret';
  repositories? : Record<string, {
    owner : string;
    repo : string;
    permission : 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
  }>;
};

/** Data shape for a team member. */
export type TeamMemberData = {
  did : string;
  alias? : string;
  role? : 'member' | 'maintainer';
  state? : 'active' | 'pending';
};

/** Data shape for an organization webhook configuration. */
export type OrgWebhookDeliveryData = {
  id : number;
  guid : string;
  deliveredAt : string;
  redelivery : boolean;
  duration : number;
  status : string;
  statusCode : number;
  event : string;
  action? : string | null;
  installationId? : number | null;
  repositoryId? : number | null;
  throttledAt? : string | null;
  request? : {
    headers? : Record<string, string>;
    payload? : unknown;
  };
  response? : {
    headers? : Record<string, string>;
    payload? : unknown;
  };
};

export type OrgWebhookData = {
  url : string;
  secret : string;
  events : string[];
  active : boolean;
  deliveries? : Record<string, OrgWebhookDeliveryData>;
};

export type OrgIssueFieldOptionData = {
  id? : number;
  name : string;
  description? : string | null;
  color : 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple';
  priority : number;
};

/** Data shape for an organization-level custom issue field. */
export type OrgIssueFieldData = {
  name : string;
  description? : string | null;
  dataType : 'text' | 'single_select' | 'number' | 'date' | 'multi_select';
  visibility? : 'organization_members_only' | 'all';
  options? : OrgIssueFieldOptionData[];
};

export type OrgIssueTypeData = {
  name : string;
  description? : string | null;
  color? : 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | null;
  isEnabled : boolean;
};

export type OrgCustomPropertyData = {
  propertyName : string;
  valueType : 'string' | 'single_select' | 'multi_select' | 'true_false' | 'url';
  required? : boolean;
  defaultValue? : string | string[] | null;
  description? : string | null;
  allowedValues? : string[] | null;
  valuesEditableBy? : 'org_actors' | 'org_and_repo_actors' | null;
  requireExplicitValues? : boolean;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeOrgSchemaMap = {
  org : OrgData;
  owner : OrgMemberData;
  member : OrgMemberData;
  blockedUser : OrgBlockedUserData;
  team : TeamData;
  teamMember : TeamMemberData;
  webhook : OrgWebhookData;
  issueField : OrgIssueFieldData;
  issueType : OrgIssueTypeData;
  customProperty : OrgCustomPropertyData;
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
    blockedUser: {
      schema      : 'https://enbox.org/schemas/forge/org-blocked-user',
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
    webhook: {
      schema             : 'https://enbox.org/schemas/forge/org-webhook',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    issueField: {
      schema      : 'https://enbox.org/schemas/forge/org-issue-field',
      dataFormats : ['application/json'],
    },
    issueType: {
      schema      : 'https://enbox.org/schemas/forge/org-issue-type',
      dataFormats : ['application/json'],
    },
    customProperty: {
      schema      : 'https://enbox.org/schemas/forge/org-custom-property',
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

      blockedUser: {
        $actions: [
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

      webhook: {
        // Owner-only, encrypted at rest (webhook secrets are sensitive)
      },

      issueField: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'update', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['name', 'dataType'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          dataType            : { type: 'string', enum: ['text', 'single_select', 'number', 'date', 'multi_select'] },
        },
      },

      issueType: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'update', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['name', 'isEnabled'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          isEnabled           : { type: 'boolean' },
        },
      },

      customProperty: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'org/owner', can: ['create', 'update', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['propertyName', 'valueType'],
          $allowUndefinedTags : false,
          propertyName        : { type: 'string' },
          valueType           : { type: 'string', enum: ['string', 'single_select', 'multi_select', 'true_false', 'url'] },
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
