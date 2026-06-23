import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import {
  ForgeCiDefinition,
  ForgeIssuesDefinition,
  ForgeNotificationsDefinition,
  ForgeOrgDefinition,
  ForgePatchesDefinition,
  ForgeRefsDefinition,
  ForgeRegistryDefinition,
  ForgeReleasesDefinition,
  ForgeRepoDefinition,
  ForgeSocialDefinition,
  ForgeWikiDefinition,
} from '../src/index.js';

const schemasDir = resolve(import.meta.dir, '..', 'schemas');

/** Reads and parses a JSON Schema file from the schemas directory. */
function readSchema(subdirectory: string, filename: string): Record<string, any> {
  const filePath = join(schemasDir, subdirectory, filename);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Lists all .json files in a schema subdirectory. */
function listSchemaFiles(subdirectory: string): string[] {
  return readdirSync(join(schemasDir, subdirectory)).filter((f) => f.endsWith('.json'));
}

/**
 * Collects all schema URIs from a protocol definition's `types` block.
 * Returns a map of typeName -> schemaUri for types that have a schema.
 */
function getSchemaUris(definition: { types: Record<string, any> }): Map<string, string> {
  const result = new Map<string, string>();
  for (const [typeName, typeConfig] of Object.entries(definition.types)) {
    if (typeConfig.schema) {
      result.set(typeName, typeConfig.schema);
    }
  }
  return result;
}

describe('JSON Schemas', () => {

  describe('schema file validity', () => {
    const allSubdirs = ['repo', 'refs', 'issues', 'patches', 'ci', 'releases', 'registry', 'social', 'notifications', 'wiki', 'org'];

    for (const subdir of allSubdirs) {
      const files = listSchemaFiles(subdir);
      for (const file of files) {
        it(`schemas/${subdir}/${file} should be valid JSON Schema draft-07`, () => {
          const schema = readSchema(subdir, file);
          expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
          expect(schema.$id).toBeDefined();
          expect(schema.$id).toMatch(/^https:\/\/enbox\.org\/schemas\/forge\//);
          expect(schema.type).toBe('object');
          expect(schema.title).toBeDefined();
          expect(typeof schema.title).toBe('string');
          expect(schema.additionalProperties).toBe(false);
        });
      }
    }
  });

  describe('schema $id matches protocol type schema URIs', () => {
    const protocolSchemaMap: [string, Record<string, any>, string][] = [
      ['repo', ForgeRepoDefinition, 'repo'],
      ['refs', ForgeRefsDefinition, 'refs'],
      ['issues', ForgeIssuesDefinition, 'issues'],
      ['patches', ForgePatchesDefinition, 'patches'],
      ['ci', ForgeCiDefinition, 'ci'],
      ['releases', ForgeReleasesDefinition, 'releases'],
      ['registry', ForgeRegistryDefinition, 'registry'],
      ['social', ForgeSocialDefinition, 'social'],
      ['notifications', ForgeNotificationsDefinition, 'notifications'],
      ['wiki', ForgeWikiDefinition, 'wiki'],
      ['org', ForgeOrgDefinition, 'org'],
    ];

    for (const [name, definition, subdir] of protocolSchemaMap) {
      const schemaUris = getSchemaUris(definition as { types: Record<string, any> });
      const schemaFiles = listSchemaFiles(subdir);
      const fileIds = new Map<string, string>();
      for (const file of schemaFiles) {
        const schema = readSchema(subdir, file);
        fileIds.set(schema.$id, file);
      }

      for (const [typeName, uri] of schemaUris) {
        it(`${name}/${typeName} schema URI should have a matching schema file`, () => {
          expect(fileIds.has(uri)).toBe(true);
        });
      }
    }
  });

  describe('repo schemas', () => {
    it('repo.json should require name, defaultBranch, and dwnEndpoints', () => {
      const schema = readSchema('repo', 'repo.json');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('defaultBranch');
      expect(schema.required).toContain('dwnEndpoints');
    });

    it('collaborator.json should require did', () => {
      const schema = readSchema('repo', 'collaborator.json');
      expect(schema.required).toContain('did');
    });

    it('webhook.json should require url, secret, events, and active', () => {
      const schema = readSchema('repo', 'webhook.json');
      expect(schema.required).toContain('url');
      expect(schema.required).toContain('secret');
      expect(schema.required).toContain('events');
      expect(schema.required).toContain('active');
      expect(schema.properties.deliveries).toBeDefined();
      expect(schema.properties.deliveries.additionalProperties.required).toContain('guid');
      expect(schema.properties.deliveries.additionalProperties.required).toContain('statusCode');
    });

    it('settings.json should support branchProtection as flexible object', () => {
      const schema = readSchema('repo', 'settings.json');
      expect(schema.properties.branchProtection).toBeDefined();
      expect(schema.properties.branchProtection.type).toBe('object');
    });

    it('settings.json should support repository label catalog entries', () => {
      const schema = readSchema('repo', 'settings.json');
      const labels = schema.properties.labels;
      expect(labels).toBeDefined();
      expect(labels.type).toBe('object');
      expect(labels.additionalProperties.required).toContain('name');
      expect(labels.additionalProperties.required).toContain('color');
    });

    it('settings.json should support repository milestone catalog entries', () => {
      const schema = readSchema('repo', 'settings.json');
      const milestones = schema.properties.milestones;
      expect(milestones).toBeDefined();
      expect(milestones.type).toBe('object');
      expect(milestones.additionalProperties.required).toContain('title');
      expect(milestones.additionalProperties.required).toContain('number');
      expect(milestones.additionalProperties.properties.state.enum).toEqual(['open', 'closed']);
    });

    it('settings.json should support GitHub comment reaction overlays', () => {
      const schema = readSchema('repo', 'settings.json');
      const reaction = schema.definitions.githubReaction;
      expect(reaction.required).toEqual(['id', 'userDid', 'content', 'createdAt']);
      expect(reaction.properties.content.enum).toEqual(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']);

      const commitComments = schema.properties.commitComments;
      expect(commitComments.additionalProperties.properties.reactions.additionalProperties.$ref).toBe('#/definitions/githubReaction');
      expect(schema.properties.pullReviewCommentReactions.additionalProperties.additionalProperties.$ref)
        .toBe('#/definitions/githubReaction');
    });

    it('settings.json should support repository deploy keys', () => {
      const schema = readSchema('repo', 'settings.json');
      const deployKeys = schema.properties.deployKeys;
      expect(deployKeys).toBeDefined();
      expect(deployKeys.type).toBe('object');
      expect(deployKeys.additionalProperties.required).toContain('key');
      expect(deployKeys.additionalProperties.required).toContain('readOnly');
      expect(deployKeys.additionalProperties.properties.lastUsed.type).toEqual(['string', 'null']);
    });

    it('settings.json should support repository autolinks, interaction limits, and rulesets', () => {
      const schema = readSchema('repo', 'settings.json');
      const autolinks = schema.properties.autolinks;
      expect(autolinks).toBeDefined();
      expect(autolinks.type).toBe('object');
      expect(autolinks.additionalProperties.required).toEqual(['id', 'keyPrefix', 'urlTemplate', 'isAlphanumeric']);

      const interactionLimit = schema.properties.interactionLimit;
      expect(interactionLimit).toBeDefined();
      expect(interactionLimit.required).toEqual(['limit', 'expiresAt']);
      expect(interactionLimit.properties.limit.enum).toEqual(['existing_users', 'contributors_only', 'collaborators_only']);
      expect(schema.properties.vulnerabilityAlertsEnabled.type).toBe('boolean');
      expect(schema.properties.automatedSecurityFixesEnabled.type).toBe('boolean');
      expect(schema.properties.automatedSecurityFixesPaused.type).toBe('boolean');
      expect(schema.properties.privateVulnerabilityReportingEnabled.type).toBe('boolean');
      expect(schema.properties.immutableReleasesEnabled.type).toBe('boolean');
      expect(schema.properties.customProperties.type).toBe('object');
      expect(schema.properties.customProperties.additionalProperties.oneOf[0].type).toBe('string');
      expect(schema.properties.customProperties.additionalProperties.oneOf[1].items.type).toBe('string');
      expect(schema.properties.attestations.type).toBe('object');
      expect(schema.properties.attestations.additionalProperties.required).toContain('subjectDigest');
      expect(schema.properties.attestations.additionalProperties.properties.bundle.type).toBe('object');
      expect(schema.properties.issueTypes.type).toBe('object');
      expect(schema.properties.issueTypes.additionalProperties.required).toEqual(['id', 'name', 'createdAt', 'updatedAt']);
      expect(schema.properties.transferRequest.required).toEqual(['id', 'newOwner', 'requestedBy', 'createdAt']);
      expect(schema.properties.transferRequest.properties.teamIds.items.minimum).toBe(1);

      const rulesets = schema.properties.rulesets;
      expect(rulesets).toBeDefined();
      expect(rulesets.type).toBe('object');
      expect(rulesets.additionalProperties.required).toContain('name');
      expect(rulesets.additionalProperties.required).toContain('rules');
      expect(rulesets.additionalProperties.properties.target.enum).toEqual(['branch', 'tag', 'push']);
      expect(rulesets.additionalProperties.properties.enforcement.enum).toEqual(['disabled', 'active', 'evaluate']);

      const ruleSuites = schema.properties.ruleSuites;
      expect(ruleSuites).toBeDefined();
      expect(ruleSuites.type).toBe('object');
      expect(ruleSuites.additionalProperties.required).toEqual([
        'id',
        'actorName',
        'beforeSha',
        'afterSha',
        'ref',
        'pushedAt',
        'result',
      ]);
      expect(ruleSuites.additionalProperties.properties.result.enum).toEqual(['pass', 'fail', 'bypass']);
      expect(ruleSuites.additionalProperties.properties.ruleEvaluations.items.required).toEqual([
        'ruleSource',
        'enforcement',
        'result',
        'ruleType',
      ]);
    });

    it('settings.json should support repository deployment environments', () => {
      const schema = readSchema('repo', 'settings.json');
      const environments = schema.properties.environments;
      expect(environments).toBeDefined();
      expect(environments.type).toBe('object');
      expect(environments.additionalProperties.required).toContain('id');
      expect(environments.additionalProperties.required).toContain('name');
      expect(environments.additionalProperties.properties.reviewers.items.properties.type.enum).toEqual(['User', 'Team']);
      expect(environments.additionalProperties.properties.deploymentBranchPolicy.type).toEqual(['object', 'null']);
      const variables = environments.additionalProperties.properties.variables;
      expect(variables).toBeDefined();
      expect(variables.type).toBe('object');
      expect(variables.additionalProperties.required).toEqual(['name', 'value', 'createdAt', 'updatedAt']);
      const secrets = environments.additionalProperties.properties.secrets;
      expect(secrets).toBeDefined();
      expect(secrets.type).toBe('object');
      expect(secrets.additionalProperties.required).toEqual(['name', 'encryptedValue', 'keyId', 'createdAt', 'updatedAt']);
    });

    it('settings.json should support repository Actions variables', () => {
      const schema = readSchema('repo', 'settings.json');
      const variables = schema.properties.actionsVariables;
      expect(variables).toBeDefined();
      expect(variables.type).toBe('object');
      expect(variables.additionalProperties.required).toEqual(['name', 'value', 'createdAt', 'updatedAt']);
    });

    it('settings.json should support repository Actions secrets', () => {
      const schema = readSchema('repo', 'settings.json');
      const secrets = schema.properties.actionsSecrets;
      expect(secrets).toBeDefined();
      expect(secrets.type).toBe('object');
      expect(secrets.additionalProperties.required).toEqual(['name', 'encryptedValue', 'keyId', 'createdAt', 'updatedAt']);
    });

    it('settings.json should support repository Actions caches and limits', () => {
      const schema = readSchema('repo', 'settings.json');
      const caches = schema.properties.actionsCaches;
      expect(caches).toBeDefined();
      expect(caches.type).toBe('object');
      expect(caches.additionalProperties.required).toEqual([
        'id',
        'ref',
        'key',
        'version',
        'lastAccessedAt',
        'createdAt',
        'sizeInBytes',
      ]);
      expect(caches.additionalProperties.properties.sizeInBytes.minimum).toBe(0);
      expect(schema.properties.actionsCacheRetentionLimitDays.minimum).toBe(1);
      expect(schema.properties.actionsCacheStorageLimitGb.minimum).toBe(1);
    });

    it('settings.json should support repository Actions permissions', () => {
      const schema = readSchema('repo', 'settings.json');
      const permissions = schema.properties.actionsPermissions;
      expect(permissions).toBeDefined();
      expect(permissions.required).toEqual([
        'enabled',
        'allowedActions',
        'shaPinningRequired',
        'selectedActions',
        'defaultWorkflowPermissions',
        'canApprovePullRequestReviews',
      ]);
      expect(permissions.properties.allowedActions.enum).toEqual(['all', 'local_only', 'selected']);
      expect(permissions.properties.defaultWorkflowPermissions.enum).toEqual(['read', 'write']);
      expect(permissions.properties.selectedActions.required).toEqual([
        'githubOwnedAllowed',
        'verifiedAllowed',
        'patternsAllowed',
      ]);
    });

    it('settings.json should support repository GitHub Pages state', () => {
      const schema = readSchema('repo', 'settings.json');
      const pages = schema.properties.pages;
      expect(pages).toBeDefined();
      expect(pages.required).toEqual([
        'status',
        'cname',
        'custom404',
        'source',
        'buildType',
        'public',
        'httpsEnforced',
        'createdAt',
        'updatedAt',
      ]);
      expect(pages.properties.status.enum).toEqual(['queued', 'building', 'built', 'errored']);
      expect(pages.properties.buildType.enum).toEqual(['legacy', 'workflow']);
      expect(pages.properties.source.properties.path.enum).toEqual(['/', '/docs']);
      expect(pages.properties.builds.additionalProperties.required).toEqual([
        'id',
        'status',
        'errorMessage',
        'pusherDid',
        'commit',
        'duration',
        'createdAt',
        'updatedAt',
      ]);
      expect(pages.properties.deployments.additionalProperties.required).toEqual([
        'id',
        'environment',
        'pagesBuildVersion',
        'oidcTokenHash',
        'status',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('moderation-event.json should define moderation actions and targets', () => {
      const schema = readSchema('repo', 'moderation-event.json');
      expect(schema.required).toEqual(['action', 'actorDid', 'createdAt']);
      expect(schema.properties.action.enum).toContain('block');
      expect(schema.properties.action.enum).toContain('deleteComment');
      expect(schema.properties.targetKind.enum).toContain('prComment');
      expect(schema.properties.reportStatus.enum).toEqual(['open', 'resolved', 'dismissed']);
    });

    it('settings.json should restrict mergeStrategies items to merge, squash, rebase', () => {
      const schema = readSchema('repo', 'settings.json');
      const items = schema.properties.mergeStrategies.items;
      expect(items.enum).toEqual(['merge', 'squash', 'rebase']);
    });
  });

  describe('issues schemas', () => {
    it('issue.json should require title and body', () => {
      const schema = readSchema('issues', 'issue.json');
      expect(schema.required).toContain('title');
      expect(schema.required).toContain('body');
    });

    it('comment.json should require body', () => {
      const schema = readSchema('issues', 'comment.json');
      expect(schema.required).toContain('body');
    });

    it('label.json should require name and color', () => {
      const schema = readSchema('issues', 'label.json');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('color');
    });

    it('assignment.json should require assigneeDid', () => {
      const schema = readSchema('issues', 'assignment.json');
      expect(schema.required).toContain('assigneeDid');
    });

    it('issue-dependency.json should require issueId', () => {
      const schema = readSchema('issues', 'issue-dependency.json');
      expect(schema.required).toContain('issueId');
    });

    it('issue-sub-issue.json should require issueId and priority', () => {
      const schema = readSchema('issues', 'issue-sub-issue.json');
      expect(schema.required).toContain('issueId');
      expect(schema.required).toContain('priority');
    });

    it('issue-field-value.json should require fieldId, dataType, and value', () => {
      const schema = readSchema('issues', 'issue-field-value.json');
      expect(schema.required).toContain('fieldId');
      expect(schema.required).toContain('dataType');
      expect(schema.required).toContain('value');
    });
  });

  describe('patches schemas', () => {
    it('patch.json should require title and body', () => {
      const schema = readSchema('patches', 'patch.json');
      expect(schema.required).toContain('title');
      expect(schema.required).toContain('body');
    });

    it('revision.json should require diffStat with nested structure', () => {
      const schema = readSchema('patches', 'revision.json');
      expect(schema.required).toContain('diffStat');
      expect(schema.properties.diffStat.type).toBe('object');
      expect(schema.properties.diffStat.required).toContain('additions');
      expect(schema.properties.diffStat.required).toContain('deletions');
      expect(schema.properties.diffStat.required).toContain('filesChanged');
    });

    it('merge-result.json should require mergedBy', () => {
      const schema = readSchema('patches', 'merge-result.json');
      expect(schema.required).toContain('mergedBy');
    });

    it('review-comment.json should require body', () => {
      const schema = readSchema('patches', 'review-comment.json');
      expect(schema.required).toContain('body');
    });
  });

  describe('ci schemas', () => {
    it('check-suite.json should define headBranch', () => {
      const schema = readSchema('ci', 'check-suite.json');
      expect(schema.properties.headBranch).toBeDefined();
      expect(schema.properties.headBranch.type).toBe('string');
    });

    it('check-run.json should define summary and text fields', () => {
      const schema = readSchema('ci', 'check-run.json');
      expect(schema.properties.summary).toBeDefined();
      expect(schema.properties.text).toBeDefined();
    });
  });

  describe('releases schemas', () => {
    it('release.json should require name', () => {
      const schema = readSchema('releases', 'release.json');
      expect(schema.required).toContain('name');
    });

    it('release.json should support GitHub release reactions', () => {
      const schema = readSchema('releases', 'release.json');
      const reaction = schema.definitions.releaseReaction;
      expect(reaction.required).toEqual(['id', 'userDid', 'content', 'createdAt']);
      expect(reaction.properties.content.enum).toEqual(['+1', 'laugh', 'heart', 'hooray', 'rocket', 'eyes']);
      expect(schema.properties.reactions.additionalProperties.$ref).toBe('#/definitions/releaseReaction');
    });
  });

  describe('registry schemas', () => {
    it('package.json should require name', () => {
      const schema = readSchema('registry', 'package.json');
      expect(schema.required).toContain('name');
    });

    it('package-version.json should require semver', () => {
      const schema = readSchema('registry', 'package-version.json');
      expect(schema.required).toContain('semver');
    });

    it('attestation.json should require attestorDid and claim', () => {
      const schema = readSchema('registry', 'attestation.json');
      expect(schema.required).toContain('attestorDid');
      expect(schema.required).toContain('claim');
    });
  });

  describe('social schemas', () => {
    it('star.json should require repoDid and repoRecordId', () => {
      const schema = readSchema('social', 'star.json');
      expect(schema.required).toContain('repoDid');
      expect(schema.required).toContain('repoRecordId');
    });

    it('follow.json should require targetDid', () => {
      const schema = readSchema('social', 'follow.json');
      expect(schema.required).toContain('targetDid');
    });

    it('block.json should require targetDid', () => {
      const schema = readSchema('social', 'block.json');
      expect(schema.required).toContain('targetDid');
      expect(schema.properties.blockedAt.type).toBe('string');
    });

    it('email.json should require email', () => {
      const schema = readSchema('social', 'email.json');
      expect(schema.required).toContain('email');
      expect(schema.properties.primary.type).toBe('boolean');
      expect(schema.properties.verified.type).toBe('boolean');
      expect(schema.properties.visibility.enum).toEqual(['public', 'private', null]);
    });

    it('profile.json should require did and support public profile fields', () => {
      const schema = readSchema('social', 'profile.json');
      expect(schema.required).toContain('did');
      expect(schema.properties.name.type).toEqual(['string', 'null']);
      expect(schema.properties.twitterUsername.type).toEqual(['string', 'null']);
      expect(schema.properties.hireable.type).toEqual(['boolean', 'null']);
    });

    it('social-account.json should require provider and url', () => {
      const schema = readSchema('social', 'social-account.json');
      expect(schema.required).toContain('provider');
      expect(schema.required).toContain('url');
      expect(schema.properties.createdAt.type).toBe('string');
    });

    it('gist.json should require files and support gist file content', () => {
      const schema = readSchema('social', 'gist.json');
      expect(schema.required).toContain('files');
      expect(schema.properties.files.minProperties).toBe(1);
      expect(schema.properties.files.additionalProperties.required).toContain('filename');
      expect(schema.properties.files.additionalProperties.required).toContain('content');
      expect(schema.properties.forkOfOwnerDid.type).toBe('string');
      expect(schema.properties.forkOfGistId.type).toBe('string');
    });

    it('gist-comment.json should require gistId and body', () => {
      const schema = readSchema('social', 'gist-comment.json');
      expect(schema.required).toContain('gistId');
      expect(schema.required).toContain('body');
    });

    it('gist-star.json should require ownerDid and gistId', () => {
      const schema = readSchema('social', 'gist-star.json');
      expect(schema.required).toContain('ownerDid');
      expect(schema.required).toContain('gistId');
    });

    it('gpg-key.json should require armoredPublicKey', () => {
      const schema = readSchema('social', 'gpg-key.json');
      expect(schema.required).toContain('armoredPublicKey');
      expect(schema.properties.keyId.type).toBe('string');
      expect(schema.properties.emails.items.required).toContain('email');
      expect(schema.properties.subkeys.items.required).toContain('publicKey');
    });

    it('ssh-key.json should require key', () => {
      const schema = readSchema('social', 'ssh-key.json');
      expect(schema.required).toContain('key');
      expect(schema.properties.title.type).toBe('string');
      expect(schema.properties.verified.type).toBe('boolean');
      expect(schema.properties.readOnly.type).toBe('boolean');
    });

    it('ssh-signing-key.json should require key', () => {
      const schema = readSchema('social', 'ssh-signing-key.json');
      expect(schema.required).toContain('key');
      expect(schema.properties.title.type).toBe('string');
      expect(schema.properties.createdAt.type).toBe('string');
    });

    it('activity.json should require type and summary', () => {
      const schema = readSchema('social', 'activity.json');
      expect(schema.required).toContain('type');
      expect(schema.required).toContain('summary');
    });
  });

  describe('notifications schemas', () => {
    it('notification.json should require title', () => {
      const schema = readSchema('notifications', 'notification.json');
      expect(schema.required).toContain('title');
    });
  });

  describe('wiki schemas', () => {
    it('wiki-page.json should require title and slug', () => {
      const schema = readSchema('wiki', 'wiki-page.json');
      expect(schema.required).toContain('title');
      expect(schema.required).toContain('slug');
    });

    it('wiki-history.json should require editedBy', () => {
      const schema = readSchema('wiki', 'wiki-history.json');
      expect(schema.required).toContain('editedBy');
    });
  });

  describe('refs schemas', () => {
    it('git-ref.json should require name, target, and type', () => {
      const schema = readSchema('refs', 'git-ref.json');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('target');
      expect(schema.required).toContain('type');
    });

    it('git-ref.json should restrict type to branch or tag', () => {
      const schema = readSchema('refs', 'git-ref.json');
      expect(schema.properties.type.enum).toEqual(['branch', 'tag']);
    });

    it('branch.json should require refName, ownerDid, and kind', () => {
      const schema = readSchema('refs', 'branch.json');
      expect(schema.required).toContain('refName');
      expect(schema.required).toContain('ownerDid');
      expect(schema.required).toContain('kind');
      expect(schema.properties.kind.enum).toEqual(['contributor', 'protected', 'shared']);
    });

    it('branch-state.json should support updates and checkpoints', () => {
      const schema = readSchema('refs', 'branch-state.json');
      expect(schema.required).toContain('kind');
      expect(schema.required).toContain('refName');
      expect(schema.required).toContain('actorDid');
      expect(schema.required).toContain('createdAt');
      expect(schema.properties.kind.enum).toEqual(['refUpdate', 'checkpoint']);
      expect(schema.properties.newTarget.type).toEqual(['string', 'null']);
      expect(schema.properties.target.type).toEqual(['string', 'null']);
    });
  });

  describe('org schemas', () => {
    it('org.json should require name', () => {
      const schema = readSchema('org', 'org.json');
      expect(schema.required).toContain('name');
    });

    it('org-member.json should require did', () => {
      const schema = readSchema('org', 'org-member.json');
      expect(schema.required).toContain('did');
      expect(schema.properties.public.type).toBe('boolean');
    });

    it('org-blocked-user.json should require did', () => {
      const schema = readSchema('org', 'org-blocked-user.json');
      expect(schema.required).toContain('did');
      expect(schema.properties.blockedAt.type).toBe('string');
      expect(schema.properties.blockedBy.type).toBe('string');
    });

    it('org-webhook.json should require url, secret, events, and active', () => {
      const schema = readSchema('org', 'org-webhook.json');
      expect(schema.required).toContain('url');
      expect(schema.required).toContain('secret');
      expect(schema.required).toContain('events');
      expect(schema.required).toContain('active');
      expect(schema.properties.deliveries).toBeDefined();
      expect(schema.properties.deliveries.additionalProperties.required).toContain('guid');
      expect(schema.properties.deliveries.additionalProperties.required).toContain('statusCode');
    });

    it('org-issue-field.json should require name and dataType', () => {
      const schema = readSchema('org', 'org-issue-field.json');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('dataType');
      expect(schema.properties.dataType.enum).toEqual(['text', 'single_select', 'number', 'date', 'multi_select']);
    });

    it('org-issue-type.json should require name and isEnabled', () => {
      const schema = readSchema('org', 'org-issue-type.json');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('isEnabled');
      expect(schema.properties.color.enum).toEqual(['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', null]);
    });

    it('org-custom-property.json should require propertyName and valueType', () => {
      const schema = readSchema('org', 'org-custom-property.json');
      expect(schema.required).toContain('propertyName');
      expect(schema.required).toContain('valueType');
      expect(schema.properties.valueType.enum).toEqual(['string', 'single_select', 'multi_select', 'true_false', 'url']);
    });

    it('team.json should require name', () => {
      const schema = readSchema('org', 'team.json');
      expect(schema.required).toContain('name');
      expect(schema.properties.privacy.enum).toEqual(['visible', 'secret']);
      expect(schema.properties.repositories.additionalProperties.required).toEqual(['owner', 'repo', 'permission']);
    });

    it('team-member.json should require did', () => {
      const schema = readSchema('org', 'team-member.json');
      expect(schema.required).toContain('did');
      expect(schema.properties.role.enum).toEqual(['member', 'maintainer']);
      expect(schema.properties.state.enum).toEqual(['active', 'pending']);
    });
  });
});
