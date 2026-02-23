/**
 * Forge Package Registry Protocol — DID-scoped package publishing.
 *
 * Packages are scoped to the publisher's DID (no global namespace squatting).
 * Versions and tarballs are `$immutable` — once published, content cannot be
 * silently replaced. Third-party attestations enable build reproducibility chains.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a package record. */
export type PackageData = {
  name : string;
  description? : string;
  keywords? : string[];
  repository? : string;
};

/** Data shape for a package version record. */
export type PackageVersionData = {
  semver : string;
  engines? : Record<string, string>;
  dependencies?: Record<string, string>;
};

/** Data shape for a third-party attestation. */
export type AttestationData = {
  attestorDid : string;
  claim : string;
  sourceCommit?: string;
  sourceRepo? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeRegistrySchemaMap = {
  package : PackageData;
  version : PackageVersionData;
  tarball : Uint8Array;
  attestation : AttestationData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeRegistryDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/registry',
  published : true,
  types     : {
    package: {
      schema      : 'https://enbox.org/schemas/forge/package',
      dataFormats : ['application/json'],
    },
    version: {
      schema      : 'https://enbox.org/schemas/forge/package-version',
      dataFormats : ['application/json'],
    },
    tarball: {
      dataFormats: ['application/gzip', 'application/octet-stream'],
    },
    attestation: {
      schema      : 'https://enbox.org/schemas/forge/attestation',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    package: {
      $actions : [{ who: 'anyone', can: ['read'] }],
      // Only owner can create packages (no create in $actions = owner-only)
      $tags    : {
        $requiredTags       : ['name', 'ecosystem'],
        $allowUndefinedTags : false,
        name                : { type: 'string', maxLength: 214 },
        ecosystem           : { type: 'string', enum: ['npm', 'cargo', 'pip', 'go'] },
        description         : { type: 'string' },
      },

      version: {
        $immutable : true,
        $actions   : [
          { who: 'anyone', can: ['read'] },
          { who: 'author', of: 'package', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['semver'],
          $allowUndefinedTags : false,
          semver              : { type: 'string' },
          deprecated          : { type: 'boolean' },
        },

        tarball: {
          $immutable   : true,
          $recordLimit : { max: 1, strategy: 'reject' },
          $actions     : [
            { who: 'anyone', can: ['read'] },
            { who: 'author', of: 'package', can: ['create'] },
          ],
        },

        attestation: {
          $immutable : true,
          $actions   : [
            { who: 'anyone', can: ['read'] },
            // Third-party attestors need a permission grant from the package owner
          ],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Registry protocol for use with `dwn.using()`. */
export const ForgeRegistryProtocol = defineProtocol(
  ForgeRegistryDefinition,
  {} as ForgeRegistrySchemaMap,
);
