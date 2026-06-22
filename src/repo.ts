/**
 * Forge Repository Protocol — foundational protocol for repository management.
 *
 * Defines repository metadata, collaborator roles (maintainer, triager,
 * contributor, viewer), and repo-level resources (readme, license, topics, settings,
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
  hasIssues? : boolean;
  hasProjects? : boolean;
  hasWiki? : boolean;
  hasDownloads? : boolean;
  hasPullRequests? : boolean;
  isTemplate? : boolean;
  allowSquashMerge? : boolean;
  allowMergeCommit? : boolean;
  allowRebaseMerge? : boolean;
  allowAutoMerge? : boolean;
  allowForking? : boolean;
  deleteBranchOnMerge? : boolean;
  webCommitSignoffRequired? : boolean;
  pullRequestCreationPolicy? : 'all' | 'collaborators_only';
  forkedFromDid? : string;
  forkedFromRepoName? : string;
  forkedFromRecordId? : string;
};

/** Data shape for a collaborator role record (maintainer, triager, contributor, viewer). */
export type CollaboratorData = {
  did : string;
  alias? : string;
};

/** Data shape for a repository topic tag. */
export type TopicData = {
  name: string;
};

/** Owner-side decision for an external issue or patch submission. */
export type SubmissionDecisionData = {
  kind : 'issue' | 'patch';
  decision : 'ignored';
  submitterDid : string;
  submissionRecordId : string;
  submissionContextId? : string;
  reason? : string;
  decidedBy : string;
  decidedAt : string;
};

export type RepositoryRulesetStateData = {
  id: number;
  name: string;
  target: 'branch' | 'tag' | 'push';
  enforcement: 'disabled' | 'active' | 'evaluate';
  bypassActors?: Record<string, unknown>[];
  conditions?: Record<string, unknown>;
  rules: Array<Record<string, unknown> & { type: string }>;
  versionId: number;
  createdAt: string;
  updatedAt: string;
};

export type RepositoryRulesetData = RepositoryRulesetStateData & {
  history?: Record<string, {
    versionId: number;
    actorDid: string;
    updatedAt: string;
    state: RepositoryRulesetStateData;
  }>;
};

export type RepositoryRuleSuiteData = {
  id: number;
  actorId?: number;
  actorName: string;
  beforeSha: string;
  afterSha: string;
  ref: string;
  repositoryId?: number;
  repositoryName?: string;
  pushedAt: string;
  result: 'pass' | 'fail' | 'bypass';
  evaluationResult?: 'pass' | 'fail' | 'bypass' | null;
  ruleEvaluations?: Array<{
    ruleSource: Record<string, unknown> & { type: string; id?: number; name?: string };
    enforcement: 'disabled' | 'active' | 'evaluate';
    result: 'pass' | 'fail' | 'bypass';
    ruleType: string;
    details?: string;
  }>;
};

export type RepositoryCustomPropertyValue = string | string[];

export type RepositoryAttestationData = {
  id: number;
  subjectDigest: string;
  predicateType?: string;
  bundle: Record<string, unknown>;
  createdAt: string;
};

export type RepositoryIssueTypeData = {
  id: number;
  name: string;
  description?: string | null;
  color?: string | null;
  isEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RepositoryTransferRequestData = {
  id: number;
  newOwner: string;
  newName?: string;
  teamIds?: number[];
  requestedBy: string;
  createdAt: string;
};

export type CodeScanningInstanceData = {
  ref: string;
  analysisKey: string;
  category: string;
  environment?: string;
  state: 'open' | 'closed' | 'dismissed' | 'fixed';
  commitSha: string;
  message?: Record<string, unknown>;
  location?: Record<string, unknown>;
  classifications?: string[];
};

export type CodeScanningAlertData = {
  number: number;
  state: 'open' | 'closed' | 'dismissed' | 'fixed';
  rule: Record<string, unknown> & { id: string; severity?: string; name?: string; description?: string };
  tool: Record<string, unknown> & { name: string; guid?: string | null; version?: string | null };
  mostRecentInstance: CodeScanningInstanceData;
  instances?: CodeScanningInstanceData[];
  createdAt: string;
  updatedAt: string;
  dismissedAt?: string | null;
  dismissedBy?: string | null;
  dismissedReason?: 'false positive' | 'won\'t fix' | 'used in tests' | null;
  dismissedComment?: string | null;
  fixedAt?: string | null;
  assignees?: string[];
};

export type SecretScanningLocationData = {
  type: string;
  details: Record<string, unknown>;
};

export type SecretScanningScanData = {
  type: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  patternSlug?: string;
  patternScope?: string;
};

export type SecretScanningScanHistoryData = {
  incrementalScans?: SecretScanningScanData[];
  backfillScans?: SecretScanningScanData[];
  patternUpdateScans?: SecretScanningScanData[];
  customPatternBackfillScans?: SecretScanningScanData[];
  genericSecretsBackfillScans?: SecretScanningScanData[];
};

export type SecretScanningPushProtectionBypassData = {
  placeholderId: string;
  tokenType: string;
  reason?: 'false_positive' | 'used_in_tests' | 'will_fix_later';
  expireAt?: string;
  createdAt?: string;
  createdBy?: string;
  alertNumber?: number;
};

export type SecretScanningAlertData = {
  number: number;
  state: 'open' | 'resolved';
  secretType: string;
  secretTypeDisplayName?: string;
  secret: string;
  provider?: string;
  providerSlug?: string;
  createdAt: string;
  updatedAt: string;
  resolution?: 'false_positive' | 'wont_fix' | 'revoked' | 'pattern_edited' | 'pattern_deleted' | 'used_in_tests' | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionComment?: string | null;
  validity?: 'active' | 'inactive' | 'unknown';
  publiclyLeaked?: boolean;
  multiRepo?: boolean;
  isBase64Encoded?: boolean;
  pushProtectionBypassed?: boolean;
  pushProtectionBypassedBy?: string | null;
  pushProtectionBypassedAt?: string | null;
  pushProtectionBypassRequestReviewer?: string | null;
  pushProtectionBypassRequestReviewerComment?: string | null;
  pushProtectionBypassRequestComment?: string | null;
  pushProtectionBypassRequestHtmlUrl?: string | null;
  firstLocationDetected?: Record<string, unknown> | null;
  hasMoreLocations?: boolean;
  assignedTo?: string | null;
  locations?: SecretScanningLocationData[];
};

export type RepositorySecurityAdvisoryData = {
  ghsaId: string;
  cveId?: string | null;
  summary: string;
  description: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  state: 'triage' | 'draft' | 'published' | 'closed';
  authorDid: string;
  publisherDid?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
  closedAt?: string | null;
  withdrawnAt?: string | null;
  submission?: Record<string, unknown> | null;
  vulnerabilities?: Array<Record<string, unknown>>;
  cvssSeverities?: Record<string, unknown>;
  cweIds?: string[];
  cwes?: Array<Record<string, unknown>>;
  credits?: Array<Record<string, unknown>>;
  creditsDetailed?: Array<Record<string, unknown>>;
  collaboratingUsers?: string[];
  collaboratingTeams?: Array<Record<string, unknown>>;
  privateFork?: Record<string, unknown> | null;
  cveRequestedAt?: string | null;
};

export type DependabotAlertData = {
  number: number;
  state: 'auto_dismissed' | 'dismissed' | 'fixed' | 'open';
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifestPath: string;
    scope?: 'development' | 'runtime' | string;
  };
  securityAdvisory: Record<string, unknown>;
  securityVulnerability?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  dismissedAt?: string | null;
  dismissedBy?: string | null;
  dismissedReason?: 'fix_started' | 'inaccurate' | 'no_bandwidth' | 'not_used' | 'tolerable_risk' | null;
  dismissedComment?: string | null;
  fixedAt?: string | null;
  assignees?: string[];
};

export type BranchProtectionRestrictionsData = {
  apps: string[];
  teams: string[];
  users: string[];
};

export type BranchProtectionRuleData = {
  allowDeletions?: boolean;
  allowForcePushes?: boolean;
  allowForkSyncing?: boolean;
  blockCreations?: boolean;
  dismissStaleReviews?: boolean;
  reviewBypassAllowances?: BranchProtectionRestrictionsData;
  reviewDismissalRestrictions?: BranchProtectionRestrictionsData;
  enforceAdmins?: boolean;
  lockBranch?: boolean;
  restrictions?: BranchProtectionRestrictionsData;
  requiredConversationResolution?: boolean;
  requiredChecksStrict?: boolean;
  requiredLinearHistory?: boolean;
  requireCodeOwnerReviews?: boolean;
  requireLastPushApproval?: boolean;
  requiredSignatures?: boolean;
  requiredReviews?: number;
  requiredCheckApps?: Record<string, number | null>;
  requiredChecks?: string[];
};

/** Data shape for repository settings. */
export type SettingsData = {
  branchProtection? : Record<string, BranchProtectionRuleData>;
  labels? : Record<string, { name: string; color: string; description?: string | null; createdAt?: string; updatedAt?: string }>;
  milestones? : Record<string, { title: string; number: number; state?: 'open' | 'closed'; description?: string | null; dueOn?: string | null; createdAt?: string; updatedAt?: string; closedAt?: string | null }>;
  commitComments? : Record<string, {
    id: number;
    body: string;
    commitId: string;
    path?: string | null;
    position?: number | null;
    line?: number | null;
    userDid: string;
    createdAt: string;
    updatedAt: string;
  }>;
  deployments? : Record<string, {
    id: number;
    sha: string;
    ref: string;
    task: string;
    payload?: unknown;
    originalEnvironment: string;
    environment: string;
    description?: string | null;
    creatorDid: string;
    transientEnvironment?: boolean;
    productionEnvironment?: boolean;
    createdAt: string;
    updatedAt: string;
    statuses?: Record<string, {
      id: number;
      state: 'error' | 'failure' | 'inactive' | 'in_progress' | 'queued' | 'pending' | 'success';
      targetUrl?: string;
      logUrl?: string;
      description?: string;
      environment: string;
      environmentUrl?: string;
      creatorDid: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
  environments? : Record<string, {
    id: number;
    name: string;
    createdAt: string;
    updatedAt: string;
    waitTimer?: number;
    preventSelfReview?: boolean;
    reviewers?: Array<{
      type: 'User' | 'Team';
      id: number;
    }>;
    deploymentBranchPolicy?: {
      protectedBranches: boolean;
      customBranchPolicies: boolean;
    } | null;
    variables?: Record<string, {
      name: string;
      value: string;
      createdAt: string;
      updatedAt: string;
    }>;
    secrets?: Record<string, {
      name: string;
      encryptedValue: string;
      keyId: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
  deployKeys? : Record<string, {
    id: number;
    key: string;
    title: string;
    readOnly: boolean;
    verified?: boolean;
    addedBy?: string | null;
    lastUsed?: string | null;
    enabled?: boolean;
    createdAt: string;
  }>;
  autolinks? : Record<string, {
    id: number;
    keyPrefix: string;
    urlTemplate: string;
    isAlphanumeric: boolean;
  }>;
  interactionLimit? : {
    limit: 'existing_users' | 'contributors_only' | 'collaborators_only';
    expiresAt: string;
  };
  vulnerabilityAlertsEnabled? : boolean;
  automatedSecurityFixesEnabled? : boolean;
  automatedSecurityFixesPaused? : boolean;
  privateVulnerabilityReportingEnabled? : boolean;
  immutableReleasesEnabled? : boolean;
  customProperties? : Record<string, RepositoryCustomPropertyValue>;
  attestations? : Record<string, RepositoryAttestationData>;
  issueTypes? : Record<string, RepositoryIssueTypeData>;
  codeScanningAlerts? : Record<string, CodeScanningAlertData>;
  dependabotAlerts? : Record<string, DependabotAlertData>;
  secretScanningAlerts? : Record<string, SecretScanningAlertData>;
  secretScanningScanHistory? : SecretScanningScanHistoryData;
  secretScanningPushProtectionBypasses? : Record<string, SecretScanningPushProtectionBypassData>;
  securityAdvisories? : Record<string, RepositorySecurityAdvisoryData>;
  transferRequest? : RepositoryTransferRequestData;
  rulesets? : Record<string, RepositoryRulesetData>;
  ruleSuites? : Record<string, RepositoryRuleSuiteData>;
  actionsWorkflows? : Record<string, {
    id: number;
    name: string;
    path: string;
    state: 'active' | 'disabled_manually';
    createdAt: string;
    updatedAt: string;
  }>;
  actionsVariables? : Record<string, {
    name: string;
    value: string;
    createdAt: string;
    updatedAt: string;
  }>;
  actionsSecrets? : Record<string, {
    name: string;
    encryptedValue: string;
    keyId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  actionsCaches? : Record<string, {
    id: number;
    ref: string;
    key: string;
    version: string;
    lastAccessedAt: string;
    createdAt: string;
    sizeInBytes: number;
  }>;
  actionsCacheRetentionLimitDays? : number;
  actionsCacheStorageLimitGb? : number;
  actionsPermissions? : {
    enabled: boolean;
    allowedActions: 'all' | 'local_only' | 'selected';
    shaPinningRequired: boolean;
    selectedActions: {
      githubOwnedAllowed: boolean;
      verifiedAllowed: boolean;
      patternsAllowed: string[];
    };
    defaultWorkflowPermissions: 'read' | 'write';
    canApprovePullRequestReviews: boolean;
  };
  pages? : {
    status: 'queued' | 'building' | 'built' | 'errored';
    cname: string | null;
    custom404: boolean;
    source: { branch: string; path: '/' | '/docs' } | null;
    buildType: 'legacy' | 'workflow';
    public: boolean;
    httpsEnforced: boolean;
    createdAt: string;
    updatedAt: string;
    builds?: Record<string, {
      id: number;
      status: 'queued' | 'building' | 'built' | 'errored';
      errorMessage: string | null;
      pusherDid: string;
      commit: string;
      duration: number;
      createdAt: string;
      updatedAt: string;
    }>;
    deployments?: Record<string, {
      id: string;
      artifactId?: number;
      artifactUrl?: string;
      environment: string;
      pagesBuildVersion: string;
      oidcTokenHash: string;
      status: 'pending' | 'succeed' | 'failed' | 'cancelled';
      createdAt: string;
      updatedAt: string;
    }>;
  };
  mergeStrategies? : ('merge' | 'squash' | 'rebase')[];
  autoDeleteBranch? : boolean;
};

/** Data shape for a webhook configuration. */
export type WebhookDeliveryData = {
  id : number;
  guid : string;
  deliveredAt : string;
  redelivery : boolean;
  duration : number;
  status : string;
  statusCode : number;
  event : string;
  action? : string | null;
  installationId? : number | null;
  repositoryId? : number | null;
  throttledAt? : string | null;
  request? : {
    headers? : Record<string, string>;
    payload? : unknown;
  };
  response? : {
    headers? : Record<string, string>;
    payload? : unknown;
  };
};

export type WebhookData = {
  url : string;
  secret : string;
  events : string[];
  active : boolean;
  deliveries? : Record<string, WebhookDeliveryData>;
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
  viewer : CollaboratorData;
  topic : TopicData;
  submissionDecision : SubmissionDecisionData;
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
    viewer: {
      schema      : 'https://enbox.org/schemas/forge/collaborator',
      dataFormats : ['application/json'],
    },
    topic: {
      schema      : 'https://enbox.org/schemas/forge/topic',
      dataFormats : ['application/json'],
    },
    submissionDecision: {
      schema      : 'https://enbox.org/schemas/forge/submission-decision',
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
        forkedFromDid       : { type: 'string' },
        forkedFromRepoName  : { type: 'string' },
        forkedFromRecordId  : { type: 'string' },
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

      viewer: {
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

      submissionDecision: {
        $immutable : true,
        $actions   : [
          { who: 'anyone', can: ['read'] },
          { role: 'repo/maintainer', can: ['create'] },
        ],
        $tags: {
          $requiredTags       : ['kind', 'decision', 'submitterDid', 'submissionRecordId'],
          $allowUndefinedTags : false,
          kind                : { type: 'string', enum: ['issue', 'patch'] },
          decision            : { type: 'string', enum: ['ignored'] },
          submitterDid        : { type: 'string' },
          submissionRecordId  : { type: 'string' },
          submissionContextId : { type: 'string' },
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
