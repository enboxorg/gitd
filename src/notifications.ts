/**
 * Forge Notifications Protocol — private notification inbox.
 *
 * Notifications are private (`published: false`). Only the DWN owner can
 * read, update (mark as read), or delete. Notification senders (e.g., repo
 * maintainers, CI bots) need a scoped permission grant to create.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a notification record. */
export type NotificationData = {
  type : string;
  title : string;
  body? : string;
  repoDid? : string;
  repoRecordId? : string;
  sourceRecordId?: string;
  url? : string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ForgeNotificationsSchemaMap = {
  notification: NotificationData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ForgeNotificationsDefinition = {
  protocol  : 'https://enbox.org/protocols/forge/notifications',
  published : false,
  types     : {
    notification: {
      schema      : 'https://enbox.org/schemas/forge/notification',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    notification: {
      // Owner-only read/update/delete.
      // Senders need a permission grant to create.
      $tags: {
        $requiredTags       : ['type', 'read'],
        $allowUndefinedTags : true,
        type                : {
          type : 'string',
          enum : ['mention', 'review_request', 'assignment', 'ci_failure', 'patch_merged', 'issue_comment', 'review'],
        },
        read           : { type: 'boolean' },
        repoDid        : { type: 'string' },
        repoRecordId   : { type: 'string' },
        sourceRecordId : { type: 'string' },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Forge Notifications protocol for use with `dwn.using()`. */
export const ForgeNotificationsProtocol = defineProtocol(
  ForgeNotificationsDefinition,
  {} as ForgeNotificationsSchemaMap,
);
