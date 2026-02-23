/**
 * Forge Social Protocol — stars, follows, and activity feeds.
 *
 * Stars and follows live on the actor's DWN, not the target's. This preserves
 * data sovereignty: your social graph is yours. Aggregate counts (e.g., "how
 * many stars does this repo have?") are computed by indexers.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a star record (lives on the starrer's DWN). */
export type StarData = {
  repoDid : string;
  repoRecordId : string;
  repoName? : string;
};

/** Data shape for a follow record (lives on the follower's DWN). */
export type FollowData = {
  targetDid : string;
  alias? : string;
};

/** Data shape for an activity feed entry. */
export type ActivityData = {
  type : string;
  repoDid? : string;
  repoRecordId? : string;
  recordId? : string;
  summary? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeSocialSchemaMap = {
  star : StarData;
  follow : FollowData;
  activity : ActivityData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeSocialDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/social',
  published : true,
  types     : {
    star: {
      schema      : 'https://enbox.org/schemas/forge/star',
      dataFormats : ['application/json'],
    },
    follow: {
      schema      : 'https://enbox.org/schemas/forge/follow',
      dataFormats : ['application/json'],
    },
    activity: {
      schema      : 'https://enbox.org/schemas/forge/activity',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    star: {
      // Stars live on the STARRER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['repoDid', 'repoRecordId'],
        $allowUndefinedTags : false,
        repoDid             : { type: 'string' },
        repoRecordId        : { type: 'string' },
      },
    },
    follow: {
      // Follows live on the FOLLOWER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['targetDid'],
        $allowUndefinedTags : false,
        targetDid           : { type: 'string' },
      },
    },
    activity: {
      // Activity feed on the actor's DWN — public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['type'],
        $allowUndefinedTags : true,
        type                : {
          type : 'string',
          enum : ['push', 'issue_open', 'issue_close', 'patch_open', 'patch_merge', 'release', 'star', 'fork'],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Social protocol for use with `dwn.using()`. */
export const ForgeSocialProtocol = defineProtocol(
  ForgeSocialDefinition,
  {} as ForgeSocialSchemaMap,
);
