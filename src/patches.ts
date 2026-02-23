/**
 * Forge Patches Protocol — pull requests, code review, and merge tracking.
 *
 * A "patch" is a proposed change (equivalent to a GitHub PR). Each patch
 * tracks revisions (force-pushes), reviews (approve/reject/comment),
 * inline review comments, status transitions, and merge results.
 *
 * Composes with the Forge Repo protocol via `uses` for role-based authorization.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a patch (pull request) record. */
export type PatchData = {
  title : string;
  body : string;
  number? : number;
};

/** Data shape for a revision (force-push snapshot). */
export type RevisionData = {
  description? : string;
  diffStat : { additions: number; deletions: number; filesChanged: number };
};

/** Data shape for a code review. */
export type ReviewData = {
  body?: string;
};

/** Data shape for an inline review comment. */
export type ReviewCommentData = {
  body : string;
  diffHunk? : string;
};

/** Data shape for a patch status change event. */
export type PatchStatusChangeData = {
  reason?: string;
};

/** Data shape for a merge result. */
export type MergeResultData = {
  mergedBy: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgePatchesSchemaMap = {
  patch : PatchData;
  revision : RevisionData;
  review : ReviewData;
  reviewComment : ReviewCommentData;
  statusChange : PatchStatusChangeData;
  mergeResult : MergeResultData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgePatchesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/patches',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    patch: {
      schema      : 'https://enbox.org/schemas/forge/patch',
      dataFormats : ['application/json'],
    },
    revision: {
      schema      : 'https://enbox.org/schemas/forge/revision',
      dataFormats : ['application/json'],
    },
    review: {
      schema      : 'https://enbox.org/schemas/forge/review',
      dataFormats : ['application/json'],
    },
    reviewComment: {
      schema      : 'https://enbox.org/schemas/forge/review-comment',
      dataFormats : ['application/json'],
    },
    statusChange: {
      schema      : 'https://enbox.org/schemas/forge/patch-status-change',
      dataFormats : ['application/json'],
    },
    mergeResult: {
      schema      : 'https://enbox.org/schemas/forge/merge-result',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    patch: {
      $actions: [
        { role: 'repo:repo/contributor', can: ['create', 'read'] },
        { role: 'repo:repo/maintainer', can: ['create', 'read', 'update', 'delete'] },
        { who: 'author', of: 'patch', can: ['update'] },
      ],
      $tags: {
        $requiredTags       : ['status', 'repoRecordId', 'baseBranch'],
        $allowUndefinedTags : false,
        status              : { type: 'string', enum: ['draft', 'open', 'closed', 'merged'] },
        repoRecordId        : { type: 'string' },
        baseBranch          : { type: 'string' },
        headBranch          : { type: 'string' },
        sourceDid           : { type: 'string' },
      },

      revision: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { who: 'author', of: 'patch', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['headCommit', 'baseCommit'],
          $allowUndefinedTags : false,
          headCommit          : { type: 'string' },
          baseCommit          : { type: 'string' },
          commitCount         : { type: 'integer', minimum: 1 },
        },
      },

      review: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['create', 'read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'read'] },
        ],
        $tags: {
          $requiredTags       : ['verdict'],
          $allowUndefinedTags : false,
          verdict             : { type: 'string', enum: ['approve', 'reject', 'comment'] },
          revisionRecordId    : { type: 'string' },
        },

        reviewComment: {
          $actions: [
            { role: 'repo:repo/contributor', can: ['create', 'read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'read'] },
          ],
          $tags: {
            $allowUndefinedTags : true,
            path                : { type: 'string' },
            line                : { type: 'integer' },
            side                : { type: 'string', enum: ['left', 'right'] },
          },
        },
      },

      statusChange: {
        $immutable : true,
        $actions   : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
          { who: 'author', of: 'patch', can: ['create'] },
        ],
      },

      mergeResult: {
        $immutable   : true,
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['mergeCommit', 'strategy'],
          $allowUndefinedTags : false,
          mergeCommit         : { type: 'string' },
          strategy            : { type: 'string', enum: ['merge', 'squash', 'rebase'] },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Patches protocol for use with `dwn.using()`. */
export const ForgePatchesProtocol = defineProtocol(
  ForgePatchesDefinition,
  {} as ForgePatchesSchemaMap,
);
