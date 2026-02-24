/**
 * Forge Wiki Protocol — collaborative documentation with edit history.
 *
 * Wiki pages are mutable (updated in place). Each edit creates an `$immutable`
 * `pageHistory` record capturing the diff, providing a permanent audit trail.
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

/** Data shape for a wiki page (body is markdown, stored as data payload). */
export type PageData = {
  slug : string;
  title : string;
};

/** Data shape for a wiki page history entry. */
export type PageHistoryData = {
  editedBy : string;
  summary? : string;
  diff? : string;
  previousCid?: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeWikiSchemaMap = {
  page : PageData;
  pageHistory : PageHistoryData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeWikiDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/wiki',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    page: {
      schema      : 'https://enbox.org/schemas/forge/wiki-page',
      dataFormats : ['text/markdown'],
    },
    pageHistory: {
      schema      : 'https://enbox.org/schemas/forge/wiki-history',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    repo: {
      $ref: 'repo:repo',

      page: {
        $actions: [
          { who: 'anyone', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'update', 'delete'] },
          { role: 'repo:repo/contributor', can: ['create', 'update'] },
        ],
        $tags: {
          $requiredTags       : ['slug', 'title'],
          $allowUndefinedTags : false,
          slug                : { type: 'string' },
          title               : { type: 'string' },
        },

        pageHistory: {
          $immutable : true,
          $actions   : [
            { who: 'anyone', can: ['read'] },
            { role: 'repo:repo/maintainer', can: ['create'] },
            { role: 'repo:repo/contributor', can: ['create'] },
          ],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Wiki protocol for use with `dwn.using()`. */
export const ForgeWikiProtocol = defineProtocol(
  ForgeWikiDefinition,
  {} as ForgeWikiSchemaMap,
);
