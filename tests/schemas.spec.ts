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
    });

    it('settings.json should support branchProtection as flexible object', () => {
      const schema = readSchema('repo', 'settings.json');
      expect(schema.properties.branchProtection).toBeDefined();
      expect(schema.properties.branchProtection.type).toBe('object');
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
  });

  describe('org schemas', () => {
    it('org.json should require name', () => {
      const schema = readSchema('org', 'org.json');
      expect(schema.required).toContain('name');
    });

    it('org-member.json should require did', () => {
      const schema = readSchema('org', 'org-member.json');
      expect(schema.required).toContain('did');
    });

    it('team.json should require name', () => {
      const schema = readSchema('org', 'team.json');
      expect(schema.required).toContain('name');
    });

    it('team-member.json should require did', () => {
      const schema = readSchema('org', 'team-member.json');
      expect(schema.required).toContain('did');
    });
  });
});
