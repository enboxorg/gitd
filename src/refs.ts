/**
 * Forge Git Refs Protocol — branch-owned git state as DWN records.
 *
 * This protocol provides a DWN-native branch log for repo-level git state.
 * Contributors own and compact their own branch state, while maintainers own
 * protected/canonical branches such as `refs/heads/main`.
 *
 * The legacy `repo/ref` record remains as a mutable mirror for existing shim
 * and migration code. New helper code should write branch records plus
 * `$squash`-enabled `repo/branch/state` checkpoints.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a git ref record (branch or tag pointer). */
export type GitRefData = {
  /** Full ref name, e.g. `refs/heads/main` or `refs/tags/v1.0.0`. */
  name: string;

  /** The commit SHA-1 (or SHA-256) this ref points to. */
  target: string;

  /** Ref type discriminator. */
  type: 'branch' | 'tag';

  /** For annotated tags, the tagger/committer info. */
  tagger?: string;

  /** For annotated tags, the tag message. */
  message?: string;
};

/** Branch ownership class. */
export type BranchKind = 'contributor' | 'protected' | 'shared';

/** Stable metadata for a branch log. The target lives in branch state records. */
export type BranchData = {
  /** Full branch ref name, e.g. `refs/heads/main`. */
  refName : string;

  /** DID that owns this branch log. */
  ownerDid : string;

  /** Whether this branch is contributor-owned, protected, or shared. */
  kind : BranchKind;

  /** Optional ISO timestamp for local helper reconciliation. */
  createdAt? : string;
};

/** Append-only branch ref update. */
export type BranchRefUpdateData = {
  kind : 'refUpdate';
  refName : string;
  oldTarget? : string | null;
  newTarget : string | null;
  actorDid : string;
  bundleRecordId? : string;
  force? : boolean;
  nonce? : string;
  createdAt : string;
};

/** Authoritative branch checkpoint, usually replacing prior sibling state via `$squash`. */
export type BranchCheckpointData = {
  kind : 'checkpoint';
  refName : string;
  target : string | null;
  actorDid : string;
  acceptedStateRecordId? : string;
  acceptedAt : string;
  createdAt : string;
};

/** Branch state records are either deltas or compacting checkpoints. */
export type BranchStateData = BranchRefUpdateData | BranchCheckpointData;

/** Raw git bundle bytes associated with a branch update/checkpoint. */
export type BranchBundleData = Uint8Array;

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeRefsSchemaMap = {
  ref : GitRefData;
  branch : BranchData;
  state : BranchStateData;
  bundle : BranchBundleData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeRefsDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/refs',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    ref: {
      schema      : 'https://enbox.org/schemas/forge/git-ref',
      dataFormats : ['application/json'],
    },
    branch: {
      schema      : 'https://enbox.org/schemas/forge/branch',
      dataFormats : ['application/json'],
    },
    state: {
      schema      : 'https://enbox.org/schemas/forge/branch-state',
      dataFormats : ['application/json'],
    },
    bundle: {
      dataFormats: ['application/x-git-bundle'],
    },
  },
  structure: {
    repo: {
      $ref : 'repo:repo',
      ref  : {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'update', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['name', 'type', 'target'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          type                : { type: 'string', enum: ['branch', 'tag'] },
          target              : { type: 'string' },
        },
      },
      branch: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/contributor', can: ['create', 'read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'read', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['refName', 'ownerDid', 'kind'],
          $allowUndefinedTags : false,
          refName             : { type: 'string' },
          ownerDid            : { type: 'string' },
          kind                : { type: 'string', enum: ['contributor', 'protected', 'shared'] },
        },

        state: {
          $squash  : true,
          $actions : [
            { who: 'anyone', can: ['read'] },
            { who: 'author', of: 'repo/branch', can: ['create', 'squash'] },
            { role: 'repo:repo/maintainer', can: ['create', 'squash'] },
          ],
          $tags: {
            $requiredTags         : ['kind', 'refName'],
            $allowUndefinedTags   : false,
            kind                  : { type: 'string', enum: ['refUpdate', 'checkpoint'] },
            refName               : { type: 'string' },
            oldTarget             : { type: 'string' },
            newTarget             : { type: 'string' },
            target                : { type: 'string' },
            actorDid              : { type: 'string' },
            bundleRecordId        : { type: 'string' },
            acceptedStateRecordId : { type: 'string' },
          },
        },

        bundle: {
          $squash  : true,
          $actions : [
            { who: 'anyone', can: ['read'] },
            { who: 'author', of: 'repo/branch', can: ['create', 'squash'] },
            { role: 'repo:repo/maintainer', can: ['create', 'squash'] },
          ],
          $tags: {
            $requiredTags       : ['kind', 'refName', 'tipCommit'],
            $allowUndefinedTags : false,
            kind                : { type: 'string', enum: ['incremental', 'checkpoint'] },
            refName             : { type: 'string' },
            tipCommit           : { type: 'string' },
            baseCommit          : { type: 'string' },
            size                : { type: 'integer' },
          },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Refs protocol for use with `web5.using()`. */
export const ForgeRefsProtocol = defineProtocol(
  ForgeRefsDefinition,
  {} as ForgeRefsSchemaMap,
);
