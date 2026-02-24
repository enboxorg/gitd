/**
 * Forge Releases Protocol — release management with immutable assets.
 *
 * Release assets use `$immutable` to guarantee supply chain integrity:
 * once a binary is published, its data cannot be silently replaced.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a release record. */
export type ReleaseData = {
  name : string;
  body? : string;
};

/** Data shape for a release asset metadata. */
export type AssetData = {
  filename : string;
  contentType : string;
  size : number;
};

/** Data shape for a release signature. */
export type SignatureData = {
  algorithm : string;
  publicKey? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeReleasesSchemaMap = {
  release : ReleaseData;
  asset : Uint8Array;
  signature : SignatureData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeReleasesDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/releases',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    release: {
      schema      : 'https://enbox.org/schemas/forge/release',
      dataFormats : ['application/json'],
    },
    asset: {
      dataFormats: ['application/octet-stream', 'application/gzip', 'application/zip', 'application/x-tar'],
    },
    signature: {
      dataFormats: ['application/pgp-signature', 'application/json'],
    },
  },
  structure: {
    repo: {
      $ref: 'repo:repo',

      release: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'update', 'delete'] },
        ],
        $tags: {
          $requiredTags       : ['tagName'],
          $allowUndefinedTags : false,
          tagName             : { type: 'string' },
          commitSha           : { type: 'string' },
          prerelease          : { type: 'boolean' },
          draft               : { type: 'boolean' },
        },

        asset: {
          $immutable : true,
          $actions   : [
            { who: 'anyone', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create', 'delete'] },
          ],
          $tags: {
            $requiredTags       : ['filename', 'contentType'],
            $allowUndefinedTags : false,
            filename            : { type: 'string' },
            contentType         : { type: 'string' },
            size                : { type: 'integer' },
          },
        },

        signature: {
          $immutable   : true,
          $recordLimit : { max: 1, strategy: 'reject' },
          $actions     : [
            { who: 'anyone', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create'] },
          ],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Releases protocol for use with `dwn.using()`. */
export const ForgeReleasesProtocol = defineProtocol(
  ForgeReleasesDefinition,
  {} as ForgeReleasesSchemaMap,
);
