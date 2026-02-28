/**
 * Forge Issues Protocol — issue tracking with comments, labels, and status changes.
 *
 * Composes with the Forge Repo protocol via `uses` for role-based authorization.
 * Only users with a contributor, triager, or maintainer role can create issues
 * directly on the repo owner's DWN. External issue reports live on the reporter's
 * own DWN and are surfaced via indexers.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for an issue record. */
export type IssueData = {
  title : string;
  body : string;
};

/** Data shape for a comment on an issue. */
export type CommentData = {
  body: string;
};

/** Data shape for a reaction on a comment. */
export type ReactionData = {
  emoji: string;
};

/** Data shape for a label application on an issue. */
export type LabelData = {
  name : string;
  color : string;
};

/** Data shape for an issue status change event. */
export type StatusChangeData = {
  reason?: string;
};

/** Data shape for an issue assignment. */
export type AssignmentData = {
  assigneeDid : string;
  alias? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeIssuesSchemaMap = {
  issue : IssueData;
  comment : CommentData;
  reaction : ReactionData;
  label : LabelData;
  statusChange : StatusChangeData;
  assignment : AssignmentData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeIssuesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/issues',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    issue: {
      schema      : 'https://enbox.org/schemas/forge/issue',
      dataFormats : ['application/json'],
    },
    comment: {
      schema      : 'https://enbox.org/schemas/forge/comment',
      dataFormats : ['application/json'],
    },
    reaction: {
      schema      : 'https://enbox.org/schemas/forge/reaction',
      dataFormats : ['application/json'],
    },
    label: {
      schema      : 'https://enbox.org/schemas/forge/label',
      dataFormats : ['application/json'],
    },
    statusChange: {
      schema      : 'https://enbox.org/schemas/forge/status-change',
      dataFormats : ['application/json'],
    },
    assignment: {
      schema      : 'https://enbox.org/schemas/forge/assignment',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    repo: {
      $ref: 'repo:repo',

      issue: {
        $actions: [
          { who: 'anyone', can: ['create', 'read'] },
          { role: 'repo:repo/contributor', can: ['create', 'read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'read', 'update', 'delete'] },
          { role: 'repo:repo/triager', can: ['create', 'read', 'co-update'] },
          { who: 'author', of: 'repo/issue', can: ['create', 'update'] },
        ],
        $tags: {
          $requiredTags       : ['status'],
          $allowUndefinedTags : false,
          status              : { type: 'string', enum: ['open', 'closed'] },
          priority            : { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          milestone           : { type: 'string' },
        },

        comment: {
          $actions: [
            { who: 'anyone', can: ['create', 'read'] },
            { role: 'repo:repo/contributor', can: ['create', 'read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'read', 'delete'] },
            { who: 'author', of: 'repo/issue/comment', can: ['create', 'update', 'delete'] },
          ],

          reaction: {
            $actions: [
              { role: 'repo:repo/contributor', can: ['create', 'read', 'delete'] },
              { role: 'repo:repo/maintainer', can: ['create', 'read', 'delete'] },
            ],
            $tags: {
              $requiredTags       : ['emoji'],
              $allowUndefinedTags : false,
              emoji               : { type: 'string', maxLength: 10 },
            },
          },
        },

        label: {
          $immutable : true,
          $actions   : [
            { role: 'repo:repo/contributor', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
            { role: 'repo:repo/triager', can: ['create', 'delete'] },
          ],
          $tags: {
            $requiredTags       : ['name', 'color'],
            $allowUndefinedTags : false,
            name                : { type: 'string' },
            color               : { type: 'string' },
          },
        },

        statusChange: {
          $immutable : true,
          $actions   : [
            { role: 'repo:repo/contributor', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create'] },
            { role: 'repo:repo/triager', can: ['create'] },
            { who: 'author', of: 'repo/issue', can: ['create'] },
          ],
          $tags: {
            $requiredTags       : ['from', 'to'],
            $allowUndefinedTags : false,
            from                : { type: 'string', enum: ['open', 'closed'] },
            to                  : { type: 'string', enum: ['open', 'closed'] },
          },
        },

        assignment: {
          $actions: [
            { role: 'repo:repo/contributor', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
            { role: 'repo:repo/triager', can: ['create', 'delete'] },
          ],
          $tags: {
            $requiredTags       : ['assigneeDid'],
            $allowUndefinedTags : false,
            assigneeDid         : { type: 'string' },
          },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Issues protocol for use with `dwn.using()`. */
export const ForgeIssuesProtocol = defineProtocol(
  ForgeIssuesDefinition,
  {} as ForgeIssuesSchemaMap,
);
