/**
 * Forge CI/CD Protocol — check suites, check runs, and build artifacts.
 *
 * CI bots are DID-bearing agents added as maintainers to the repository.
 * Check runs are mutable (status transitions: queued -> in_progress -> completed).
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a CI check suite. */
export type CheckSuiteData = {
  app : string;
  headBranch? : string;
};

/** Data shape for an individual check run within a suite. */
export type CheckRunData = {
  output?: {
    title : string;
    summary : string;
    text? : string;
  };
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeCiSchemaMap = {
  checkSuite : CheckSuiteData;
  checkRun : CheckRunData;
  artifact : Uint8Array;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeCiDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/ci',
  published : true,
  uses      : {
    repo: 'https://enbox.org/protocols/forge/repo',
  },
  types: {
    checkSuite: {
      schema      : 'https://enbox.org/schemas/forge/check-suite',
      dataFormats : ['application/json'],
    },
    checkRun: {
      schema      : 'https://enbox.org/schemas/forge/check-run',
      dataFormats : ['application/json'],
    },
    artifact: {
      dataFormats: ['application/octet-stream', 'application/gzip'],
    },
  },
  structure: {
    repo: {
      $ref: 'repo:repo',

      checkSuite: {
        $actions: [
          { role: 'repo:repo/contributor', can: ['read'] },
          { role: 'repo:repo/maintainer', can: ['create', 'update'] },
        ],
        $tags: {
          $requiredTags       : ['commitSha', 'status'],
          $allowUndefinedTags : false,
          commitSha           : { type: 'string' },
          status              : { type: 'string', enum: ['queued', 'in_progress', 'completed'] },
          conclusion          : { type: 'string', enum: ['success', 'failure', 'cancelled', 'skipped'] },
          branch              : { type: 'string' },
        },

        checkRun: {
          $actions: [
            { role: 'repo:repo/contributor', can: ['read'] },
            { who: 'author', of: 'repo/checkSuite', can: ['create', 'update'] },
          ],
          $tags: {
            $requiredTags       : ['name', 'status'],
            $allowUndefinedTags : false,
            name                : { type: 'string' },
            status              : { type: 'string', enum: ['queued', 'in_progress', 'completed'] },
            conclusion          : { type: 'string', enum: ['success', 'failure', 'cancelled', 'skipped'] },
          },

          artifact: {
            $actions: [
              { role: 'repo:repo/contributor', can: ['read'] },
              { who: 'author', of: 'repo/checkSuite', can: ['create'] },
            ],
          },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge CI protocol for use with `dwn.using()`. */
export const ForgeCiProtocol = defineProtocol(
  ForgeCiDefinition,
  {} as ForgeCiSchemaMap,
);
