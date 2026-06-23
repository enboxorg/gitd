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
  subscribed? : boolean;
  ignored? : boolean;
};

/** Data shape for a follow record (lives on the follower's DWN). */
export type FollowData = {
  targetDid : string;
  alias? : string;
};

/** Data shape for a user blocked by the local actor. */
export type BlockData = {
  targetDid : string;
  blockedAt? : string;
};

/** Data shape for an SSH public key owned by the local actor. */
export type SshKeyData = {
  title? : string;
  key : string;
  createdAt? : string;
  verified? : boolean;
  readOnly? : boolean;
};

/** Data shape for an SSH signing public key owned by the local actor. */
export type SshSigningKeyData = {
  title? : string;
  key : string;
  createdAt? : string;
};

/** Email address attached to a GPG public key. */
export type GpgKeyEmailData = {
  email : string;
  verified? : boolean;
};

/** GPG subkey metadata. */
export type GpgSubkeyData = {
  id? : number;
  primaryKeyId? : number;
  keyId? : string;
  publicKey : string;
  emails? : GpgKeyEmailData[];
  canSign? : boolean;
  canEncryptComms? : boolean;
  canEncryptStorage? : boolean;
  canCertify? : boolean;
  createdAt? : string;
  expiresAt? : string | null;
  revoked? : boolean;
};

/** Data shape for a GPG public key owned by the local actor. */
export type GpgKeyData = {
  name? : string;
  armoredPublicKey : string;
  publicKey? : string;
  keyId? : string;
  emails? : GpgKeyEmailData[];
  subkeys? : GpgSubkeyData[];
  canSign? : boolean;
  canEncryptComms? : boolean;
  canEncryptStorage? : boolean;
  canCertify? : boolean;
  createdAt? : string;
  expiresAt? : string | null;
  revoked? : boolean;
};

/** Data shape for an email address owned by the local actor. */
export type EmailData = {
  email : string;
  primary? : boolean;
  verified? : boolean;
  visibility? : 'public' | 'private' | null;
  createdAt? : string;
};

/** Public profile metadata owned by the local actor. */
export type ProfileData = {
  did : string;
  name? : string | null;
  email? : string | null;
  blog? : string;
  twitterUsername? : string | null;
  company? : string | null;
  location? : string | null;
  hireable? : boolean | null;
  bio? : string | null;
  createdAt? : string;
  updatedAt? : string;
};

/** Data shape for a social account profile URL owned by the local actor. */
export type SocialAccountData = {
  provider : string;
  url : string;
  createdAt? : string;
};

/** File content embedded in a gist record. */
export type GistFileData = {
  filename : string;
  content : string;
  type? : string;
  language? : string | null;
};

/** Data shape for a GitHub-compatible gist owned by the local actor. */
export type GistData = {
  description? : string;
  public? : boolean;
  files : Record<string, GistFileData>;
  forkOfOwnerDid? : string;
  forkOfGistId? : string;
  forkedAt? : string;
  createdAt? : string;
  updatedAt? : string;
};

/** Data shape for a comment on a GitHub-compatible gist. */
export type GistCommentData = {
  gistId : string;
  body : string;
  userDid? : string;
  createdAt? : string;
  updatedAt? : string;
};

/** Data shape for a gist star owned by the local actor. */
export type GistStarData = {
  ownerDid : string;
  gistId : string;
  createdAt? : string;
};

/** Data shape for an activity feed entry. */
export type ActivityData = {
  type : string;
  repoDid? : string;
  repoRecordId? : string;
  repoName? : string;
  recordId? : string;
  summary? : string;
  ref? : string;
  head? : string;
  before? : string;
  tagName? : string;
  public? : boolean;
  payload? : Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeSocialSchemaMap = {
  star : StarData;
  follow : FollowData;
  block : BlockData;
  sshKey : SshKeyData;
  sshSigningKey : SshSigningKeyData;
  gpgKey : GpgKeyData;
  email : EmailData;
  profile : ProfileData;
  socialAccount : SocialAccountData;
  gist : GistData;
  gistComment : GistCommentData;
  gistStar : GistStarData;
  activity : ActivityData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeSocialDefinition = {
  protocol  : 'https://enbox.id/protocols/forge/social',
  published : true,
  types     : {
    star: {
      schema      : 'https://enbox.id/schemas/forge/star',
      dataFormats : ['application/json'],
    },
    follow: {
      schema      : 'https://enbox.id/schemas/forge/follow',
      dataFormats : ['application/json'],
    },
    block: {
      schema      : 'https://enbox.id/schemas/forge/block',
      dataFormats : ['application/json'],
    },
    sshKey: {
      schema      : 'https://enbox.id/schemas/forge/ssh-key',
      dataFormats : ['application/json'],
    },
    sshSigningKey: {
      schema      : 'https://enbox.id/schemas/forge/ssh-signing-key',
      dataFormats : ['application/json'],
    },
    gpgKey: {
      schema      : 'https://enbox.id/schemas/forge/gpg-key',
      dataFormats : ['application/json'],
    },
    email: {
      schema      : 'https://enbox.id/schemas/forge/email',
      dataFormats : ['application/json'],
    },
    profile: {
      schema      : 'https://enbox.id/schemas/forge/profile',
      dataFormats : ['application/json'],
    },
    socialAccount: {
      schema      : 'https://enbox.id/schemas/forge/social-account',
      dataFormats : ['application/json'],
    },
    gist: {
      schema      : 'https://enbox.id/schemas/forge/gist',
      dataFormats : ['application/json'],
    },
    gistComment: {
      schema      : 'https://enbox.id/schemas/forge/gist-comment',
      dataFormats : ['application/json'],
    },
    gistStar: {
      schema      : 'https://enbox.id/schemas/forge/gist-star',
      dataFormats : ['application/json'],
    },
    activity: {
      schema      : 'https://enbox.id/schemas/forge/activity',
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
    block: {
      // Blocks live on the BLOCKER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['targetDid'],
        $allowUndefinedTags : false,
        targetDid           : { type: 'string' },
      },
    },
    sshKey: {
      // SSH keys live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['key'],
        $allowUndefinedTags : false,
        key                 : { type: 'string' },
      },
    },
    sshSigningKey: {
      // SSH signing keys live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['key'],
        $allowUndefinedTags : false,
        key                 : { type: 'string' },
      },
    },
    gpgKey: {
      // GPG keys live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['keyId'],
        $allowUndefinedTags : false,
        keyId               : { type: 'string' },
      },
    },
    email: {
      // Email records live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['email'],
        $allowUndefinedTags : false,
        email               : { type: 'string' },
      },
    },
    profile: {
      // Profile records live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['did'],
        $allowUndefinedTags : false,
        did                 : { type: 'string' },
      },
    },
    socialAccount: {
      // Social account records live on the OWNER's DWN — owner-only write, public read
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['url'],
        $allowUndefinedTags : false,
        url                 : { type: 'string' },
      },
    },
    gist: {
      // Gists live on the OWNER's DWN — public read, owner-only write.
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['visibility'],
        $allowUndefinedTags : false,
        visibility          : { type: 'string', enum: ['public', 'secret'] },
        forkOfOwnerDid      : { type: 'string' },
        forkOfGistId        : { type: 'string' },
      },
    },
    gistComment: {
      // Gist comments live on the COMMENTER's DWN — owner-only write, public read.
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['gistId'],
        $allowUndefinedTags : false,
        gistId              : { type: 'string' },
      },
    },
    gistStar: {
      // Gist stars live on the STARRER's DWN — owner-only write, public read.
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        $requiredTags       : ['ownerDid', 'gistId'],
        $allowUndefinedTags : false,
        ownerDid            : { type: 'string' },
        gistId              : { type: 'string' },
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
