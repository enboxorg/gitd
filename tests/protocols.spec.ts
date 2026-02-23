import { describe, expect, it } from 'bun:test';

import {
  ForgeCiDefinition,
  ForgeCiProtocol,
  ForgeIssuesDefinition,
  ForgeIssuesProtocol,
  ForgeNotificationsDefinition,
  ForgeNotificationsProtocol,
  ForgeOrgDefinition,
  ForgeOrgProtocol,
  ForgePatchesDefinition,
  ForgePatchesProtocol,
  ForgeRegistryDefinition,
  ForgeRegistryProtocol,
  ForgeReleasesDefinition,
  ForgeReleasesProtocol,
  ForgeRepoDefinition,
  ForgeRepoProtocol,
  ForgeSocialDefinition,
  ForgeSocialProtocol,
  ForgeWikiDefinition,
  ForgeWikiProtocol,
} from '../src/index.js';

describe('@enbox/dwn-git', () => {

  // =========================================================================
  // ForgeRepoProtocol
  // =========================================================================

  describe('ForgeRepoProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeRepoDefinition.protocol).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should be a published protocol', () => {
      expect(ForgeRepoDefinition.published).toBe(true);
    });

    it('should define all expected types', () => {
      expect(ForgeRepoDefinition.types.repo).toBeDefined();
      expect(ForgeRepoDefinition.types.settings).toBeDefined();
      expect(ForgeRepoDefinition.types.readme).toBeDefined();
      expect(ForgeRepoDefinition.types.license).toBeDefined();
      expect(ForgeRepoDefinition.types.maintainer).toBeDefined();
      expect(ForgeRepoDefinition.types.triager).toBeDefined();
      expect(ForgeRepoDefinition.types.contributor).toBeDefined();
      expect(ForgeRepoDefinition.types.topic).toBeDefined();
      expect(ForgeRepoDefinition.types.webhook).toBeDefined();
    });

    it('should mark maintainer, triager, and contributor as roles', () => {
      expect(ForgeRepoDefinition.structure.repo.maintainer.$role).toBe(true);
      expect(ForgeRepoDefinition.structure.repo.triager.$role).toBe(true);
      expect(ForgeRepoDefinition.structure.repo.contributor.$role).toBe(true);
    });

    it('should enforce $recordLimit on repo singleton', () => {
      expect(ForgeRepoDefinition.structure.repo.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should enforce $recordLimit on readme and license singletons', () => {
      expect(ForgeRepoDefinition.structure.repo.readme.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
      expect(ForgeRepoDefinition.structure.repo.license.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should require name and visibility tags on repo', () => {
      expect(ForgeRepoDefinition.structure.repo.$tags?.$requiredTags).toContain('name');
      expect(ForgeRepoDefinition.structure.repo.$tags?.$requiredTags).toContain('visibility');
      expect(ForgeRepoDefinition.structure.repo.$tags?.$allowUndefinedTags).toBe(false);
    });

    it('should restrict visibility tag to public and private', () => {
      const visibility = ForgeRepoDefinition.structure.repo.$tags?.visibility as { enum: string[] };
      expect(visibility.enum).toEqual(['public', 'private']);
    });

    it('should require did tag on role records', () => {
      expect(ForgeRepoDefinition.structure.repo.maintainer.$tags?.$requiredTags).toContain('did');
      expect(ForgeRepoDefinition.structure.repo.triager.$tags?.$requiredTags).toContain('did');
      expect(ForgeRepoDefinition.structure.repo.contributor.$tags?.$requiredTags).toContain('did');
    });

    it('should require encryption on webhook type', () => {
      expect(ForgeRepoDefinition.types.webhook.encryptionRequired).toBe(true);
    });

    it('should allow anyone to read repo records', () => {
      const actions = ForgeRepoDefinition.structure.repo.$actions;
      const anyoneAction = actions!.find((a) => a.who === 'anyone');
      expect(anyoneAction).toBeDefined();
      expect(anyoneAction!.can).toContain('read');
    });

    it('should nest settings, readme, license, topic, webhook under repo', () => {
      expect(ForgeRepoDefinition.structure.repo.settings).toBeDefined();
      expect(ForgeRepoDefinition.structure.repo.readme).toBeDefined();
      expect(ForgeRepoDefinition.structure.repo.license).toBeDefined();
      expect(ForgeRepoDefinition.structure.repo.topic).toBeDefined();
      expect(ForgeRepoDefinition.structure.repo.webhook).toBeDefined();
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeRepoProtocol.definition).toBe(ForgeRepoDefinition);
    });
  });

  // =========================================================================
  // ForgeIssuesProtocol
  // =========================================================================

  describe('ForgeIssuesProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeIssuesDefinition.protocol).toBe('https://enbox.org/protocols/forge/issues');
    });

    it('should be a published protocol', () => {
      expect(ForgeIssuesDefinition.published).toBe(true);
    });

    it('should compose with Forge Repo via uses', () => {
      expect(ForgeIssuesDefinition.uses).toBeDefined();
      expect(ForgeIssuesDefinition.uses!.repo).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should define all expected types', () => {
      expect(ForgeIssuesDefinition.types.issue).toBeDefined();
      expect(ForgeIssuesDefinition.types.comment).toBeDefined();
      expect(ForgeIssuesDefinition.types.reaction).toBeDefined();
      expect(ForgeIssuesDefinition.types.label).toBeDefined();
      expect(ForgeIssuesDefinition.types.statusChange).toBeDefined();
      expect(ForgeIssuesDefinition.types.assignment).toBeDefined();
    });

    it('should require status and repoRecordId tags on issue', () => {
      const tags = ForgeIssuesDefinition.structure.issue.$tags;
      expect(tags?.$requiredTags).toContain('status');
      expect(tags?.$requiredTags).toContain('repoRecordId');
      expect(tags?.$allowUndefinedTags).toBe(false);
    });

    it('should restrict issue status to open and closed', () => {
      const status = ForgeIssuesDefinition.structure.issue.$tags?.status as { enum: string[] };
      expect(status.enum).toEqual(['open', 'closed']);
    });

    it('should nest comment, label, statusChange, and assignment under issue', () => {
      expect(ForgeIssuesDefinition.structure.issue.comment).toBeDefined();
      expect(ForgeIssuesDefinition.structure.issue.label).toBeDefined();
      expect(ForgeIssuesDefinition.structure.issue.statusChange).toBeDefined();
      expect(ForgeIssuesDefinition.structure.issue.assignment).toBeDefined();
    });

    it('should nest reaction under comment (3-level nesting)', () => {
      expect(ForgeIssuesDefinition.structure.issue.comment.reaction).toBeDefined();
    });

    it('should mark label and statusChange as $immutable', () => {
      expect(ForgeIssuesDefinition.structure.issue.label.$immutable).toBe(true);
      expect(ForgeIssuesDefinition.structure.issue.statusChange.$immutable).toBe(true);
    });

    it('should use cross-protocol repo roles', () => {
      const actions = ForgeIssuesDefinition.structure.issue.$actions!;
      const contributorAction = actions.find((a) => a.role === 'repo:repo/contributor');
      const maintainerAction = actions.find((a) => a.role === 'repo:repo/maintainer');
      expect(contributorAction).toBeDefined();
      expect(maintainerAction).toBeDefined();
    });

    it('should allow issue author to update their own issue', () => {
      const actions = ForgeIssuesDefinition.structure.issue.$actions!;
      const authorAction = actions.find((a) => a.who === 'author' && a.of === 'issue');
      expect(authorAction).toBeDefined();
      expect(authorAction!.can).toContain('update');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeIssuesProtocol.definition).toBe(ForgeIssuesDefinition);
    });
  });

  // =========================================================================
  // ForgePatchesProtocol
  // =========================================================================

  describe('ForgePatchesProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgePatchesDefinition.protocol).toBe('https://enbox.org/protocols/forge/patches');
    });

    it('should be a published protocol', () => {
      expect(ForgePatchesDefinition.published).toBe(true);
    });

    it('should compose with Forge Repo via uses', () => {
      expect(ForgePatchesDefinition.uses!.repo).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should define all expected types', () => {
      expect(ForgePatchesDefinition.types.patch).toBeDefined();
      expect(ForgePatchesDefinition.types.revision).toBeDefined();
      expect(ForgePatchesDefinition.types.review).toBeDefined();
      expect(ForgePatchesDefinition.types.reviewComment).toBeDefined();
      expect(ForgePatchesDefinition.types.statusChange).toBeDefined();
      expect(ForgePatchesDefinition.types.mergeResult).toBeDefined();
    });

    it('should require status, repoRecordId, and baseBranch tags on patch', () => {
      const tags = ForgePatchesDefinition.structure.patch.$tags;
      expect(tags?.$requiredTags).toContain('status');
      expect(tags?.$requiredTags).toContain('repoRecordId');
      expect(tags?.$requiredTags).toContain('baseBranch');
    });

    it('should restrict patch status to draft, open, closed, merged', () => {
      const status = ForgePatchesDefinition.structure.patch.$tags?.status as { enum: string[] };
      expect(status.enum).toEqual(['draft', 'open', 'closed', 'merged']);
    });

    it('should nest revision, review, statusChange, and mergeResult under patch', () => {
      expect(ForgePatchesDefinition.structure.patch.revision).toBeDefined();
      expect(ForgePatchesDefinition.structure.patch.review).toBeDefined();
      expect(ForgePatchesDefinition.structure.patch.statusChange).toBeDefined();
      expect(ForgePatchesDefinition.structure.patch.mergeResult).toBeDefined();
    });

    it('should nest reviewComment under review (3-level nesting)', () => {
      expect(ForgePatchesDefinition.structure.patch.review.reviewComment).toBeDefined();
    });

    it('should mark revision, review, statusChange, and mergeResult as $immutable', () => {
      expect(ForgePatchesDefinition.structure.patch.revision.$immutable).toBe(true);
      expect(ForgePatchesDefinition.structure.patch.review.$immutable).toBe(true);
      expect(ForgePatchesDefinition.structure.patch.statusChange.$immutable).toBe(true);
      expect(ForgePatchesDefinition.structure.patch.mergeResult.$immutable).toBe(true);
    });

    it('should enforce $recordLimit on mergeResult singleton', () => {
      expect(ForgePatchesDefinition.structure.patch.mergeResult.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should restrict review verdict to approve, reject, comment', () => {
      const verdict = ForgePatchesDefinition.structure.patch.review.$tags?.verdict as { enum: string[] };
      expect(verdict.enum).toEqual(['approve', 'reject', 'comment']);
    });

    it('should restrict mergeResult strategy to merge, squash, rebase', () => {
      const strategy = ForgePatchesDefinition.structure.patch.mergeResult.$tags?.strategy as { enum: string[] };
      expect(strategy.enum).toEqual(['merge', 'squash', 'rebase']);
    });

    it('should allow patch author to create revisions and status changes', () => {
      const revisionActions = ForgePatchesDefinition.structure.patch.revision.$actions!;
      const authorRevision = revisionActions.find((a) => a.who === 'author' && a.of === 'patch');
      expect(authorRevision).toBeDefined();
      expect(authorRevision!.can).toContain('create');

      const statusActions = ForgePatchesDefinition.structure.patch.statusChange.$actions!;
      const authorStatus = statusActions.find((a) => a.who === 'author' && a.of === 'patch');
      expect(authorStatus).toBeDefined();
      expect(authorStatus!.can).toContain('create');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgePatchesProtocol.definition).toBe(ForgePatchesDefinition);
    });
  });

  // =========================================================================
  // ForgeCiProtocol
  // =========================================================================

  describe('ForgeCiProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeCiDefinition.protocol).toBe('https://enbox.org/protocols/forge/ci');
    });

    it('should be a published protocol', () => {
      expect(ForgeCiDefinition.published).toBe(true);
    });

    it('should compose with Forge Repo via uses', () => {
      expect(ForgeCiDefinition.uses!.repo).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should define checkSuite, checkRun, and artifact types', () => {
      expect(ForgeCiDefinition.types.checkSuite).toBeDefined();
      expect(ForgeCiDefinition.types.checkRun).toBeDefined();
      expect(ForgeCiDefinition.types.artifact).toBeDefined();
    });

    it('should require commitSha, status, and repoRecordId tags on checkSuite', () => {
      const tags = ForgeCiDefinition.structure.checkSuite.$tags;
      expect(tags?.$requiredTags).toContain('commitSha');
      expect(tags?.$requiredTags).toContain('status');
      expect(tags?.$requiredTags).toContain('repoRecordId');
    });

    it('should restrict checkSuite status to queued, in_progress, completed', () => {
      const status = ForgeCiDefinition.structure.checkSuite.$tags?.status as { enum: string[] };
      expect(status.enum).toEqual(['queued', 'in_progress', 'completed']);
    });

    it('should restrict checkSuite conclusion to success, failure, cancelled, skipped', () => {
      const conclusion = ForgeCiDefinition.structure.checkSuite.$tags?.conclusion as { enum: string[] };
      expect(conclusion.enum).toEqual(['success', 'failure', 'cancelled', 'skipped']);
    });

    it('should nest checkRun under checkSuite and artifact under checkRun (3-level)', () => {
      expect(ForgeCiDefinition.structure.checkSuite.checkRun).toBeDefined();
      expect(ForgeCiDefinition.structure.checkSuite.checkRun.artifact).toBeDefined();
    });

    it('should accept binary formats for artifact', () => {
      expect(ForgeCiDefinition.types.artifact.dataFormats).toContain('application/octet-stream');
      expect(ForgeCiDefinition.types.artifact.dataFormats).toContain('application/gzip');
    });

    it('should allow checkSuite author to create checkRuns and artifacts', () => {
      const runActions = ForgeCiDefinition.structure.checkSuite.checkRun.$actions!;
      const authorRun = runActions.find((a) => a.who === 'author' && a.of === 'checkSuite');
      expect(authorRun).toBeDefined();
      expect(authorRun!.can).toContain('create');

      const artifactActions = ForgeCiDefinition.structure.checkSuite.checkRun.artifact.$actions!;
      const authorArtifact = artifactActions.find((a) => a.who === 'author' && a.of === 'checkSuite');
      expect(authorArtifact).toBeDefined();
      expect(authorArtifact!.can).toContain('create');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeCiProtocol.definition).toBe(ForgeCiDefinition);
    });
  });

  // =========================================================================
  // ForgeReleasesProtocol
  // =========================================================================

  describe('ForgeReleasesProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeReleasesDefinition.protocol).toBe('https://enbox.org/protocols/forge/releases');
    });

    it('should be a published protocol', () => {
      expect(ForgeReleasesDefinition.published).toBe(true);
    });

    it('should compose with Forge Repo via uses', () => {
      expect(ForgeReleasesDefinition.uses!.repo).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should define release, asset, and signature types', () => {
      expect(ForgeReleasesDefinition.types.release).toBeDefined();
      expect(ForgeReleasesDefinition.types.asset).toBeDefined();
      expect(ForgeReleasesDefinition.types.signature).toBeDefined();
    });

    it('should require tagName and repoRecordId tags on release', () => {
      const tags = ForgeReleasesDefinition.structure.release.$tags;
      expect(tags?.$requiredTags).toContain('tagName');
      expect(tags?.$requiredTags).toContain('repoRecordId');
    });

    it('should nest asset and signature under release', () => {
      expect(ForgeReleasesDefinition.structure.release.asset).toBeDefined();
      expect(ForgeReleasesDefinition.structure.release.signature).toBeDefined();
    });

    it('should mark asset and signature as $immutable', () => {
      expect(ForgeReleasesDefinition.structure.release.asset.$immutable).toBe(true);
      expect(ForgeReleasesDefinition.structure.release.signature.$immutable).toBe(true);
    });

    it('should enforce $recordLimit on signature singleton', () => {
      expect(ForgeReleasesDefinition.structure.release.signature.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should allow anyone to read releases, assets, and signatures', () => {
      const releaseActions = ForgeReleasesDefinition.structure.release.$actions!;
      expect(releaseActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const assetActions = ForgeReleasesDefinition.structure.release.asset.$actions!;
      expect(assetActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const sigActions = ForgeReleasesDefinition.structure.release.signature.$actions!;
      expect(sigActions.find((a) => a.who === 'anyone')!.can).toContain('read');
    });

    it('should support PGP signature format', () => {
      expect(ForgeReleasesDefinition.types.signature.dataFormats).toContain('application/pgp-signature');
    });

    it('should use maintainer role for release management', () => {
      const actions = ForgeReleasesDefinition.structure.release.$actions!;
      const maintainerAction = actions.find((a) => a.role === 'repo:repo/maintainer');
      expect(maintainerAction).toBeDefined();
      expect(maintainerAction!.can).toContain('create');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeReleasesProtocol.definition).toBe(ForgeReleasesDefinition);
    });
  });

  // =========================================================================
  // ForgeRegistryProtocol
  // =========================================================================

  describe('ForgeRegistryProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeRegistryDefinition.protocol).toBe('https://enbox.org/protocols/forge/registry');
    });

    it('should be a published protocol', () => {
      expect(ForgeRegistryDefinition.published).toBe(true);
    });

    it('should be a standalone protocol (no uses)', () => {
      expect(ForgeRegistryDefinition.uses).toBeUndefined();
    });

    it('should define package, version, tarball, and attestation types', () => {
      expect(ForgeRegistryDefinition.types.package).toBeDefined();
      expect(ForgeRegistryDefinition.types.version).toBeDefined();
      expect(ForgeRegistryDefinition.types.tarball).toBeDefined();
      expect(ForgeRegistryDefinition.types.attestation).toBeDefined();
    });

    it('should require name and ecosystem tags on package', () => {
      const tags = ForgeRegistryDefinition.structure.package.$tags;
      expect(tags?.$requiredTags).toContain('name');
      expect(tags?.$requiredTags).toContain('ecosystem');
    });

    it('should restrict ecosystem to npm, cargo, pip, go', () => {
      const ecosystem = ForgeRegistryDefinition.structure.package.$tags?.ecosystem as { enum: string[] };
      expect(ecosystem.enum).toEqual(['npm', 'cargo', 'pip', 'go']);
    });

    it('should nest version under package and tarball/attestation under version (3-level)', () => {
      expect(ForgeRegistryDefinition.structure.package.version).toBeDefined();
      expect(ForgeRegistryDefinition.structure.package.version.tarball).toBeDefined();
      expect(ForgeRegistryDefinition.structure.package.version.attestation).toBeDefined();
    });

    it('should mark version, tarball, and attestation as $immutable', () => {
      expect(ForgeRegistryDefinition.structure.package.version.$immutable).toBe(true);
      expect(ForgeRegistryDefinition.structure.package.version.tarball.$immutable).toBe(true);
      expect(ForgeRegistryDefinition.structure.package.version.attestation.$immutable).toBe(true);
    });

    it('should enforce $recordLimit on tarball singleton', () => {
      expect(ForgeRegistryDefinition.structure.package.version.tarball.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should allow anyone to read packages, versions, tarballs, and attestations', () => {
      const pkgActions = ForgeRegistryDefinition.structure.package.$actions!;
      expect(pkgActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const versionActions = ForgeRegistryDefinition.structure.package.version.$actions!;
      expect(versionActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const tarballActions = ForgeRegistryDefinition.structure.package.version.tarball.$actions!;
      expect(tarballActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const attestActions = ForgeRegistryDefinition.structure.package.version.attestation.$actions!;
      expect(attestActions.find((a) => a.who === 'anyone')!.can).toContain('read');
    });

    it('should allow package author to create versions and tarballs', () => {
      const versionActions = ForgeRegistryDefinition.structure.package.version.$actions!;
      const authorVersion = versionActions.find((a) => a.who === 'author' && a.of === 'package');
      expect(authorVersion).toBeDefined();
      expect(authorVersion!.can).toContain('create');

      const tarballActions = ForgeRegistryDefinition.structure.package.version.tarball.$actions!;
      const authorTarball = tarballActions.find((a) => a.who === 'author' && a.of === 'package');
      expect(authorTarball).toBeDefined();
      expect(authorTarball!.can).toContain('create');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeRegistryProtocol.definition).toBe(ForgeRegistryDefinition);
    });
  });

  // =========================================================================
  // ForgeSocialProtocol
  // =========================================================================

  describe('ForgeSocialProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeSocialDefinition.protocol).toBe('https://enbox.org/protocols/forge/social');
    });

    it('should be a published protocol', () => {
      expect(ForgeSocialDefinition.published).toBe(true);
    });

    it('should be a standalone protocol (no uses)', () => {
      expect(ForgeSocialDefinition.uses).toBeUndefined();
    });

    it('should define star, follow, and activity types', () => {
      expect(ForgeSocialDefinition.types.star).toBeDefined();
      expect(ForgeSocialDefinition.types.follow).toBeDefined();
      expect(ForgeSocialDefinition.types.activity).toBeDefined();
    });

    it('should have all types at the top level (flat structure)', () => {
      expect(ForgeSocialDefinition.structure.star).toBeDefined();
      expect(ForgeSocialDefinition.structure.follow).toBeDefined();
      expect(ForgeSocialDefinition.structure.activity).toBeDefined();
    });

    it('should require repoDid and repoRecordId tags on star', () => {
      const tags = ForgeSocialDefinition.structure.star.$tags;
      expect(tags?.$requiredTags).toContain('repoDid');
      expect(tags?.$requiredTags).toContain('repoRecordId');
    });

    it('should require targetDid tag on follow', () => {
      const tags = ForgeSocialDefinition.structure.follow.$tags;
      expect(tags?.$requiredTags).toContain('targetDid');
    });

    it('should restrict activity type to expected events', () => {
      const activityType = ForgeSocialDefinition.structure.activity.$tags?.type as { enum: string[] };
      expect(activityType.enum).toContain('push');
      expect(activityType.enum).toContain('issue_open');
      expect(activityType.enum).toContain('patch_merge');
      expect(activityType.enum).toContain('release');
      expect(activityType.enum).toContain('star');
    });

    it('should allow undefined tags on activity', () => {
      expect(ForgeSocialDefinition.structure.activity.$tags?.$allowUndefinedTags).toBe(true);
    });

    it('should allow anyone to read star, follow, and activity', () => {
      const starActions = ForgeSocialDefinition.structure.star.$actions!;
      expect(starActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const followActions = ForgeSocialDefinition.structure.follow.$actions!;
      expect(followActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const activityActions = ForgeSocialDefinition.structure.activity.$actions!;
      expect(activityActions.find((a) => a.who === 'anyone')!.can).toContain('read');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeSocialProtocol.definition).toBe(ForgeSocialDefinition);
    });
  });

  // =========================================================================
  // ForgeNotificationsProtocol
  // =========================================================================

  describe('ForgeNotificationsProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeNotificationsDefinition.protocol).toBe('https://enbox.org/protocols/forge/notifications');
    });

    it('should be a private (not published) protocol', () => {
      expect(ForgeNotificationsDefinition.published).toBe(false);
    });

    it('should be a standalone protocol (no uses)', () => {
      expect(ForgeNotificationsDefinition.uses).toBeUndefined();
    });

    it('should define only notification type', () => {
      expect(ForgeNotificationsDefinition.types.notification).toBeDefined();
      expect(Object.keys(ForgeNotificationsDefinition.types)).toHaveLength(1);
    });

    it('should require type and read tags on notification', () => {
      const tags = ForgeNotificationsDefinition.structure.notification.$tags;
      expect(tags?.$requiredTags).toContain('type');
      expect(tags?.$requiredTags).toContain('read');
    });

    it('should restrict notification type to expected events', () => {
      const notifType = ForgeNotificationsDefinition.structure.notification.$tags?.type as { enum: string[] };
      expect(notifType.enum).toContain('mention');
      expect(notifType.enum).toContain('review_request');
      expect(notifType.enum).toContain('assignment');
      expect(notifType.enum).toContain('ci_failure');
      expect(notifType.enum).toContain('patch_merged');
    });

    it('should use boolean type for read tag', () => {
      const readTag = ForgeNotificationsDefinition.structure.notification.$tags?.read as { type: string };
      expect(readTag.type).toBe('boolean');
    });

    it('should allow undefined tags on notification for extensibility', () => {
      expect(ForgeNotificationsDefinition.structure.notification.$tags?.$allowUndefinedTags).toBe(true);
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeNotificationsProtocol.definition).toBe(ForgeNotificationsDefinition);
    });
  });

  // =========================================================================
  // ForgeWikiProtocol
  // =========================================================================

  describe('ForgeWikiProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeWikiDefinition.protocol).toBe('https://enbox.org/protocols/forge/wiki');
    });

    it('should be a published protocol', () => {
      expect(ForgeWikiDefinition.published).toBe(true);
    });

    it('should compose with Forge Repo via uses', () => {
      expect(ForgeWikiDefinition.uses!.repo).toBe('https://enbox.org/protocols/forge/repo');
    });

    it('should define page and pageHistory types', () => {
      expect(ForgeWikiDefinition.types.page).toBeDefined();
      expect(ForgeWikiDefinition.types.pageHistory).toBeDefined();
    });

    it('should require slug, title, and repoRecordId tags on page', () => {
      const tags = ForgeWikiDefinition.structure.page.$tags;
      expect(tags?.$requiredTags).toContain('slug');
      expect(tags?.$requiredTags).toContain('title');
      expect(tags?.$requiredTags).toContain('repoRecordId');
    });

    it('should nest pageHistory under page', () => {
      expect(ForgeWikiDefinition.structure.page.pageHistory).toBeDefined();
    });

    it('should mark pageHistory as $immutable', () => {
      expect(ForgeWikiDefinition.structure.page.pageHistory.$immutable).toBe(true);
    });

    it('should use markdown format for pages', () => {
      expect(ForgeWikiDefinition.types.page.dataFormats).toContain('text/markdown');
    });

    it('should allow anyone to read pages and page history', () => {
      const pageActions = ForgeWikiDefinition.structure.page.$actions!;
      expect(pageActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const historyActions = ForgeWikiDefinition.structure.page.pageHistory.$actions!;
      expect(historyActions.find((a) => a.who === 'anyone')!.can).toContain('read');
    });

    it('should use cross-protocol repo roles for page management', () => {
      const pageActions = ForgeWikiDefinition.structure.page.$actions!;
      const maintainer = pageActions.find((a) => a.role === 'repo:repo/maintainer');
      const contributor = pageActions.find((a) => a.role === 'repo:repo/contributor');
      expect(maintainer).toBeDefined();
      expect(contributor).toBeDefined();
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeWikiProtocol.definition).toBe(ForgeWikiDefinition);
    });
  });

  // =========================================================================
  // ForgeOrgProtocol
  // =========================================================================

  describe('ForgeOrgProtocol', () => {
    it('should have the correct protocol URI', () => {
      expect(ForgeOrgDefinition.protocol).toBe('https://enbox.org/protocols/forge/org');
    });

    it('should be a published protocol', () => {
      expect(ForgeOrgDefinition.published).toBe(true);
    });

    it('should be a standalone protocol (no uses)', () => {
      expect(ForgeOrgDefinition.uses).toBeUndefined();
    });

    it('should define org, owner, member, team, and teamMember types', () => {
      expect(ForgeOrgDefinition.types.org).toBeDefined();
      expect(ForgeOrgDefinition.types.owner).toBeDefined();
      expect(ForgeOrgDefinition.types.member).toBeDefined();
      expect(ForgeOrgDefinition.types.team).toBeDefined();
      expect(ForgeOrgDefinition.types.teamMember).toBeDefined();
    });

    it('should enforce $recordLimit on org singleton', () => {
      expect(ForgeOrgDefinition.structure.org.$recordLimit).toEqual({ max: 1, strategy: 'reject' });
    });

    it('should mark owner, member, and teamMember as roles', () => {
      expect(ForgeOrgDefinition.structure.org.owner.$role).toBe(true);
      expect(ForgeOrgDefinition.structure.org.member.$role).toBe(true);
      expect(ForgeOrgDefinition.structure.org.team.teamMember.$role).toBe(true);
    });

    it('should require did tag on owner, member, and teamMember', () => {
      expect(ForgeOrgDefinition.structure.org.owner.$tags?.$requiredTags).toContain('did');
      expect(ForgeOrgDefinition.structure.org.member.$tags?.$requiredTags).toContain('did');
      expect(ForgeOrgDefinition.structure.org.team.teamMember.$tags?.$requiredTags).toContain('did');
    });

    it('should nest owner, member, and team under org', () => {
      expect(ForgeOrgDefinition.structure.org.owner).toBeDefined();
      expect(ForgeOrgDefinition.structure.org.member).toBeDefined();
      expect(ForgeOrgDefinition.structure.org.team).toBeDefined();
    });

    it('should nest teamMember under team (3-level nesting)', () => {
      expect(ForgeOrgDefinition.structure.org.team.teamMember).toBeDefined();
    });

    it('should use internal owner role for managing members and teams', () => {
      const memberActions = ForgeOrgDefinition.structure.org.member.$actions!;
      const ownerMember = memberActions.find((a) => a.role === 'org/owner');
      expect(ownerMember).toBeDefined();
      expect(ownerMember!.can).toContain('create');
      expect(ownerMember!.can).toContain('delete');

      const teamActions = ForgeOrgDefinition.structure.org.team.$actions!;
      const ownerTeam = teamActions.find((a) => a.role === 'org/owner');
      expect(ownerTeam).toBeDefined();
      expect(ownerTeam!.can).toContain('create');
    });

    it('should allow anyone to read all org records', () => {
      const orgActions = ForgeOrgDefinition.structure.org.$actions!;
      expect(orgActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const ownerActions = ForgeOrgDefinition.structure.org.owner.$actions!;
      expect(ownerActions.find((a) => a.who === 'anyone')!.can).toContain('read');

      const memberActions = ForgeOrgDefinition.structure.org.member.$actions!;
      expect(memberActions.find((a) => a.who === 'anyone')!.can).toContain('read');
    });

    it('should wrap definition via defineProtocol()', () => {
      expect(ForgeOrgProtocol.definition).toBe(ForgeOrgDefinition);
    });
  });

  // =========================================================================
  // Cross-cutting protocol design invariants
  // =========================================================================

  describe('cross-cutting invariants', () => {
    const allDefinitions = [
      ForgeRepoDefinition,
      ForgeIssuesDefinition,
      ForgePatchesDefinition,
      ForgeCiDefinition,
      ForgeReleasesDefinition,
      ForgeRegistryDefinition,
      ForgeSocialDefinition,
      ForgeNotificationsDefinition,
      ForgeWikiDefinition,
      ForgeOrgDefinition,
    ];

    it('should have 10 unique protocol URIs under the forge namespace', () => {
      const uris = allDefinitions.map((d) => d.protocol);
      const uniqueUris = new Set(uris);
      expect(uniqueUris.size).toBe(10);
      for (const uri of uris) {
        expect(uri).toMatch(/^https:\/\/enbox\.org\/protocols\/forge\//);
      }
    });

    it('should use https://enbox.org/schemas/forge/ for all schema URIs', () => {
      for (const def of allDefinitions) {
        for (const [, typeConfig] of Object.entries(def.types)) {
          if ('schema' in typeConfig && typeConfig.schema !== undefined) {
            expect(typeConfig.schema).toMatch(/^https:\/\/enbox\.org\/schemas\/forge\//);
          }
        }
      }
    });

    it('should only reference repo protocol in uses declarations', () => {
      const repoUri = 'https://enbox.org/protocols/forge/repo';
      for (const def of allDefinitions) {
        if (def.uses !== undefined) {
          for (const [, uri] of Object.entries(def.uses)) {
            expect(uri).toBe(repoUri);
          }
        }
      }
    });

    it('should have notifications as the only private protocol', () => {
      const privateProtocols = allDefinitions.filter((d) => d.published === false);
      expect(privateProtocols).toHaveLength(1);
      expect(privateProtocols[0].protocol).toBe('https://enbox.org/protocols/forge/notifications');
    });

    it('should have all Protocol wrappers referencing their definitions', () => {
      const pairs: [any, any][] = [
        [ForgeRepoProtocol, ForgeRepoDefinition],
        [ForgeIssuesProtocol, ForgeIssuesDefinition],
        [ForgePatchesProtocol, ForgePatchesDefinition],
        [ForgeCiProtocol, ForgeCiDefinition],
        [ForgeReleasesProtocol, ForgeReleasesDefinition],
        [ForgeRegistryProtocol, ForgeRegistryDefinition],
        [ForgeSocialProtocol, ForgeSocialDefinition],
        [ForgeNotificationsProtocol, ForgeNotificationsDefinition],
        [ForgeWikiProtocol, ForgeWikiDefinition],
        [ForgeOrgProtocol, ForgeOrgDefinition],
      ];
      for (const [protocol, definition] of pairs) {
        expect(protocol.definition).toBe(definition);
      }
    });
  });
});
