/**
 * Forge Git Refs Protocol — mirrors git branch/tag refs as DWN records.
 *
 * This protocol provides a DWN-native view of git ref pointers (branches, tags)
 * so that other DWN participants can subscribe to ref changes via
 * `RecordsSubscribe`. The actual git object data stays in git — these records
 * only track the ref name → commit SHA mapping.
 *
 * Uses `$ref` to compose with the Repo protocol for role-based authorization:
 * only maintainers can update refs in the repo owner's DWN.
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

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeRefsSchemaMap = {
  ref: GitRefData;
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
          $requiredTags       : ['name', 'type'],
          $allowUndefinedTags : false,
          name                : { type: 'string' },
          type                : { type: 'string', enum: ['branch', 'tag'] },
          target              : { type: 'string' },
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
