/**
 * Forge Repository Protocol — foundational protocol for repository management.
 *
 * Defines repository metadata, collaborator roles (maintainer, triager,
 * contributor), and repo-level resources (readme, license, topics, settings,
 * webhooks). Other forge protocols compose with this via `uses` to leverage
 * role-based authorization.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a repository record. */
export type RepoData = {
  name : string;
  description? : string;
  defaultBranch : string;
  homepage? : string;
  dwnEndpoints : string[];
  gitEndpoints? : string[];
};

/** Data shape for a collaborator role record (maintainer, triager, contributor). */
export type CollaboratorData = {
  did : string;
  alias? : string;
};

/** Data shape for a repository topic tag. */
export type TopicData = {
  name: string;
};

/** Data shape for repository settings. */
export type SettingsData = {
  branchProtection? : Record<string, { requiredReviews?: number; requiredChecks?: string[] }>;
  mergeStrategies? : ('merge' | 'squash' | 'rebase')[];
  autoDeleteBranch? : boolean;
};

/** Data shape for a webhook configuration. */
export type WebhookData = {
  url : string;
  secret : string;
  events : string[];
  active : boolean;
};

/**
 * Data shape for a git bundle record.
 *
 * The record payload is the raw git bundle binary (`application/x-git-bundle`).
 * Queryable metadata (tipCommit, isFull, etc.) is stored in record tags.
 */
export type BundleData = Uint8Array;

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeRepoSchemaMap = {
  repo : RepoData;
  bundle : BundleData;
  settings : SettingsData;
  readme : string;
  license : string;
  maintainer : CollaboratorData;
  triager : CollaboratorData;
  contributor : CollaboratorData;
  topic : TopicData;
  webhook : WebhookData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeRepoDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/repo',
  published : true,
  types     : {
    repo: {
      schema      : 'https://enbox.org/schemas/forge/repo',
      dataFormats : ['application/json'],
    },
    settings: {
      schema      : 'https://enbox.org/schemas/forge/settings',
      dataFormats : ['application/json'],
    },
    readme: {
      dataFormats: ['text/markdown', 'text/plain'],
    },
    license: {
      dataFormats: ['text/plain'],
    },
    maintainer: {
      schema      : 'https://enbox.org/schemas/forge/collaborator',
      dataFormats : ['application/json'],
    },
    triager: {
      schema      : 'https://enbox.org/schemas/forge/collaborator',
      dataFormats : ['application/json'],
    },
    contributor: {
      schema      : 'https://enbox.org/schemas/forge/collaborator',
      dataFormats : ['application/json'],
    },
    topic: {
      schema      : 'https://enbox.org/schemas/forge/topic',
      dataFormats : ['application/json'],
    },
    bundle: {
      dataFormats: ['application/x-git-bundle'],
    },
    webhook: {
      schema             : 'https://enbox.org/schemas/forge/webhook',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    repo: {
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['name', 'visibility'],
        $allowUndefinedTags : false,
        name                : { type: 'string', maxLength: 100 },
        visibility          : { type: 'string', enum: ['public', 'private'] },
        defaultBranch       : { type: 'string' },
        language            : { type: 'string' },
        archived            : { type: 'boolean' },
      },

      maintainer: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },

      triager: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },

      contributor: {
        $role    : true,
        $actions : [{ who: 'anyone', can: ['read'] }],
        $tags    : {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },

      bundle: {
        $squash  : true,
        $actions : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create', 'squash'] },
        ],
        $tags: {
          $requiredTags       : ['tipCommit', 'isFull'],
          $allowUndefinedTags : false,
          tipCommit           : { type: 'string' },
          isFull              : { type: 'boolean' },
          refCount            : { type: 'integer' },
          size                : { type: 'integer' },
        },
      },

      readme: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create', 'update'] },
        ],
      },

      license: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $actions     : [{ who: 'anyone', can: ['read'] }],
      },

      topic: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['name'],
          $allowUndefinedTags : false,
          name                : { type: 'string', maxLength: 50 },
        },
      },

      settings: {
        $recordLimit: { max: 1, strategy: 'reject' },
        // Owner-only: no $actions = only the DWN tenant can read/write
      },

      webhook: {
        // Owner-only, encrypted at rest (webhook secrets are sensitive)
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Repo protocol for use with `dwn.using()`. */
export const ForgeRepoProtocol = defineProtocol(
  ForgeRepoDefinition,
  {} as ForgeRepoSchemaMap,
);
