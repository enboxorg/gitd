/**
 * DWN record crawler — queries remote DWNs to build the indexer's
 * materialized views.
 *
 * Uses the `from` parameter on TypedWeb5 queries so the SDK routes
 * each request to the target DID's DWN endpoint (resolved from their
 * DID document).  All queried records are `published: true` and have
 * `{ who: 'anyone', can: ['read'] }`, so no permission grants are
 * needed.
 *
 * The crawler operates incrementally — it tracks the last crawl
 * timestamp per DID and only processes records created after that
 * point.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { IndexedRepo, IndexerStore } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for a crawl run. */
export type CrawlOptions = {
  /** Maximum DIDs to crawl per run. */
  maxDids? : number;
  /** Crawl only these DIDs (overrides store DID list). */
  dids? : string[];
};

/** Result of a crawl run. */
export type CrawlResult = {
  crawledDids : number;
  newRepos : number;
  newStars : number;
  newFollows : number;
  newIssues : number;
  newPatches : number;
  newReleases : number;
  newIssueSubmissions : number;
  newPatchSubmissions : number;
  newSubmissionDecisions : number;
  errors : { did: string; error: string }[];
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

/** Crawls DWN records from registered DIDs and populates the store. */
export class IndexerCrawler {
  private readonly _ctx : AgentContext;
  private readonly _store : IndexerStore;

  public constructor(ctx: AgentContext, store: IndexerStore) {
    this._ctx = ctx;
    this._store = store;
  }

  /**
   * Run a single crawl pass over all registered DIDs.
   *
   * For each DID, queries repos, stars, and follows.  Errors on
   * individual DIDs are captured and returned, not thrown.
   */
  public async crawl(options?: CrawlOptions): Promise<CrawlResult> {
    const dids = (options?.dids ?? this._store.getDids()).slice(0, options?.maxDids);
    const result: CrawlResult = {
      crawledDids            : 0,
      newRepos               : 0,
      newStars               : 0,
      newFollows             : 0,
      newIssues              : 0,
      newPatches             : 0,
      newReleases            : 0,
      newIssueSubmissions    : 0,
      newPatchSubmissions    : 0,
      newSubmissionDecisions : 0,
      errors                 : [],
    };

    for (const did of dids) {
      try {
        const counts = await this.crawlDid(did);
        result.newRepos += counts.repos;
        result.newStars += counts.stars;
        result.newFollows += counts.follows;
        result.newIssues += counts.issues;
        result.newPatches += counts.patches;
        result.newReleases += counts.releases;
        result.newIssueSubmissions += counts.issueSubmissions;
        result.newPatchSubmissions += counts.patchSubmissions;
        result.newSubmissionDecisions += counts.submissionDecisions;
        result.crawledDids++;
        this._store.setCursor(did, new Date().toISOString());
      } catch (err) {
        result.errors.push({ did, error: (err as Error).message });
      }
    }

    return result;
  }

  /**
   * Crawl a single DID — queries repos, stars, follows, and repo
   * metadata (issues, patches, releases counts).
   */
  public async crawlDid(did: string): Promise<{
    repos: number; stars: number; follows: number;
    issues: number; patches: number; releases: number;
    issueSubmissions: number; patchSubmissions: number; submissionDecisions: number;
  }> {
    const from = did === this._ctx.did ? undefined : did;
    let repos = 0;
    let stars = 0;
    let follows = 0;
    let indexedIssues = 0;
    let indexedPatches = 0;
    let indexedReleases = 0;
    let indexedIssueSubmissions = 0;
    let indexedPatchSubmissions = 0;
    let indexedSubmissionDecisions = 0;

    // ---------------------------------------------------------------
    // Repos
    // ---------------------------------------------------------------
    const { records: repoRecords } = await this._ctx.repo.records.query('repo', { from });

    for (const rec of repoRecords) {
      const data = await rec.data.json();
      const tags = rec.tags as Record<string, string> | undefined;
      const contextId = rec.contextId ?? '';

      // Fetch issues.
      const { records: issues } = await this._ctx.issues.records.query('repo/issue', {
        from,
        filter: { contextId },
      });

      // Fetch patches.
      const { records: patches } = await this._ctx.patches.records.query('repo/patch', {
        from,
        filter: { contextId },
      });

      // Fetch releases.
      const { records: releases } = await this._ctx.releases.records.query('repo/release' as any, {
        from,
        filter: { contextId },
      });

      // Fetch topics.
      const { records: topicRecords } = await this._ctx.repo.records.query('repo/topic' as any, {
        from,
        filter: { contextId },
      });
      const topics: string[] = [];
      for (const t of topicRecords) {
        const tTags = t.tags as Record<string, string> | undefined;
        if (tTags?.name) { topics.push(tTags.name); }
      }

      const { records: submissionDecisions } = await this._ctx.repo.records.query('repo/submissionDecision' as any, {
        from,
        filter: { contextId },
      });

      const repoName = data.name ?? 'unnamed';
      const indexedAt = new Date().toISOString();
      const indexed: IndexedRepo = {
        did,
        recordId      : rec.id,
        contextId,
        name          : repoName,
        description   : data.description ?? '',
        defaultBranch : data.defaultBranch ?? 'main',
        visibility    : tags?.visibility ?? 'public',
        language      : tags?.language ?? '',
        topics,
        openIssues    : issues.filter(recordHasOpenStatus).length,
        openPatches   : patches.filter(recordHasOpenStatus).length,
        releaseCount  : releases.length,
        lastUpdated   : rec.dateCreated ?? new Date().toISOString(),
        indexedAt,
      };

      this._store.putRepo(indexed);

      for (const decision of submissionDecisions) {
        const decisionTags = decision.tags as Record<string, unknown> | undefined;
        const kind = submissionKind(decisionTags?.kind);
        const decisionValue = stringOr(decisionTags?.decision, '');
        const submitterDid = stringOr(decisionTags?.submitterDid, '');
        const submissionRecordId = stringOr(decisionTags?.submissionRecordId, '');
        if (!kind || decisionValue !== 'ignored' || !submitterDid || !submissionRecordId) { continue; }

        const decisionData = await decision.data.json();
        this._store.putSubmissionDecision({
          ownerDid            : did,
          repoRecordId        : rec.id,
          repoName,
          kind,
          decision            : 'ignored',
          submitterDid,
          submissionRecordId,
          submissionContextId : stringOr(decisionTags?.submissionContextId, stringOr(decisionData.submissionContextId, '')),
          reason              : stringOr(decisionData.reason, ''),
          dateCreated         : decision.dateCreated ?? '',
          indexedAt,
        });
        indexedSubmissionDecisions++;
      }

      for (const issue of issues) {
        const issueData = await issue.data.json();
        const issueTags = issue.tags as Record<string, unknown> | undefined;
        this._store.putIssue({
          did,
          repoRecordId : rec.id,
          repoName,
          recordId     : issue.id,
          contextId    : issue.contextId ?? '',
          title        : stringOr(issueData.title, 'Untitled issue'),
          body         : stringOr(issueData.body, ''),
          status       : stringOr(issueTags?.status, 'open'),
          dateCreated  : issue.dateCreated ?? '',
          indexedAt,
        });
        indexedIssues++;
      }

      for (const patch of patches) {
        const patchData = await patch.data.json();
        const patchTags = patch.tags as Record<string, unknown> | undefined;
        this._store.putPatch({
          did,
          repoRecordId : rec.id,
          repoName,
          recordId     : patch.id,
          contextId    : patch.contextId ?? '',
          title        : stringOr(patchData.title, 'Untitled patch'),
          body         : stringOr(patchData.body, ''),
          status       : stringOr(patchTags?.status, 'open'),
          baseBranch   : stringOr(patchTags?.baseBranch, ''),
          headBranch   : stringOr(patchTags?.headBranch, ''),
          dateCreated  : patch.dateCreated ?? '',
          indexedAt,
        });
        indexedPatches++;
      }

      for (const release of releases) {
        const releaseData = await release.data.json();
        const releaseTags = release.tags as Record<string, unknown> | undefined;
        const tagName = stringOr(releaseTags?.tagName, stringOr(releaseData.tagName, ''));
        this._store.putRelease({
          did,
          repoRecordId : rec.id,
          repoName,
          recordId     : release.id,
          contextId    : release.contextId ?? '',
          tagName,
          name         : stringOr(releaseData.name, tagName || 'Untitled release'),
          body         : stringOr(releaseData.body, ''),
          draft        : booleanTag(releaseTags?.draft),
          prerelease   : booleanTag(releaseTags?.prerelease),
          dateCreated  : release.dateCreated ?? '',
          indexedAt,
        });
        indexedReleases++;
      }

      repos++;
    }

    // ---------------------------------------------------------------
    // External issue and patch submissions (on this user's DWN)
    // ---------------------------------------------------------------
    const submissionIndexedAt = new Date().toISOString();
    const { records: issueSubmissions } = await this._ctx.issues.records.query('repo/issue', { from });

    for (const issue of issueSubmissions) {
      const issueTags = issue.tags as Record<string, unknown> | undefined;
      const target = targetRepo(issueTags);
      if (!target) { continue; }

      const issueData = await issue.data.json();
      this._store.putIssueSubmission({
        submitterDid       : did,
        targetDid          : target.did,
        targetRepoRecordId : target.repoRecordId,
        targetRepoName     : target.name || this._store.getRepoByRecord(target.did, target.repoRecordId)?.name || '',
        recordId           : issue.id,
        contextId          : issue.contextId ?? '',
        title              : stringOr(issueData.title, 'Untitled issue'),
        body               : stringOr(issueData.body, ''),
        status             : stringOr(issueTags?.status, 'open'),
        dateCreated        : issue.dateCreated ?? '',
        indexedAt          : submissionIndexedAt,
      });
      indexedIssueSubmissions++;
    }

    const { records: patchSubmissions } = await this._ctx.patches.records.query('repo/patch', { from });

    for (const patch of patchSubmissions) {
      const patchTags = patch.tags as Record<string, unknown> | undefined;
      const target = targetRepo(patchTags);
      if (!target) { continue; }

      const patchData = await patch.data.json();
      this._store.putPatchSubmission({
        submitterDid       : did,
        targetDid          : target.did,
        targetRepoRecordId : target.repoRecordId,
        targetRepoName     : target.name || this._store.getRepoByRecord(target.did, target.repoRecordId)?.name || '',
        sourceDid          : stringOr(patchTags?.sourceDid, did),
        recordId           : patch.id,
        contextId          : patch.contextId ?? '',
        title              : stringOr(patchData.title, 'Untitled patch'),
        body               : stringOr(patchData.body, ''),
        status             : stringOr(patchTags?.status, 'open'),
        baseBranch         : stringOr(patchTags?.baseBranch, ''),
        headBranch         : stringOr(patchTags?.headBranch, ''),
        dateCreated        : patch.dateCreated ?? '',
        indexedAt          : submissionIndexedAt,
      });
      indexedPatchSubmissions++;
    }

    // ---------------------------------------------------------------
    // Stars (on this user's DWN)
    // ---------------------------------------------------------------
    const { records: starRecords } = await this._ctx.social.records.query('star', { from });

    for (const rec of starRecords) {
      const tags = rec.tags as Record<string, string> | undefined;
      if (tags?.repoDid && tags?.repoRecordId) {
        this._store.putStar({
          starrerDid   : did,
          repoDid      : tags.repoDid,
          repoRecordId : tags.repoRecordId,
          dateCreated  : rec.dateCreated ?? '',
        });
        stars++;

        // Discover new DIDs from star targets.
        this._store.addDid(tags.repoDid);
      }
    }

    // ---------------------------------------------------------------
    // Follows (on this user's DWN)
    // ---------------------------------------------------------------
    const { records: followRecords } = await this._ctx.social.records.query('follow', { from });

    for (const rec of followRecords) {
      const tags = rec.tags as Record<string, string> | undefined;
      if (tags?.targetDid) {
        this._store.putFollow({
          followerDid : did,
          targetDid   : tags.targetDid,
          dateCreated : rec.dateCreated ?? '',
        });
        follows++;

        // Discover new DIDs from follow targets.
        this._store.addDid(tags.targetDid);
      }
    }

    return {
      repos,
      stars,
      follows,
      issues              : indexedIssues,
      patches             : indexedPatches,
      releases            : indexedReleases,
      issueSubmissions    : indexedIssueSubmissions,
      patchSubmissions    : indexedPatchSubmissions,
      submissionDecisions : indexedSubmissionDecisions,
    };
  }

  /**
   * Discover DIDs by following the social graph from a seed DID.
   *
   * Queries stars and follows for the seed DID, adds discovered DIDs
   * to the store, and optionally recurses to a given depth.
   */
  public async discover(seedDid: string, depth: number = 1): Promise<string[]> {
    const discovered = new Set<string>();
    const queue = [seedDid];
    let currentDepth = 0;

    while (queue.length > 0 && currentDepth < depth) {
      const batch = [...queue];
      queue.length = 0;

      for (const did of batch) {
        if (discovered.has(did)) { continue; }
        discovered.add(did);
        this._store.addDid(did);

        try {
          const from = did === this._ctx.did ? undefined : did;

          // Stars reveal repo owner DIDs.
          const { records: starRecords } = await this._ctx.social.records.query('star', { from });
          for (const rec of starRecords) {
            const tags = rec.tags as Record<string, string> | undefined;
            if (tags?.repoDid && !discovered.has(tags.repoDid)) {
              queue.push(tags.repoDid);
            }
          }

          // Follows reveal user DIDs.
          const { records: followRecords } = await this._ctx.social.records.query('follow', { from });
          for (const rec of followRecords) {
            const tags = rec.tags as Record<string, string> | undefined;
            if (tags?.targetDid && !discovered.has(tags.targetDid)) {
              queue.push(tags.targetDid);
            }
          }
        } catch {
          // Skip unreachable DIDs.
        }
      }

      currentDepth++;
    }

    return [...discovered];
  }

  /**
   * Start a periodic crawl loop.  Crawls all DIDs, then waits
   * `intervalMs` before the next pass.  Returns a cleanup function
   * to stop the loop.
   */
  public startLoop(intervalMs: number = 60_000): () => void {
    let running = true;

    const loop = async (): Promise<void> => {
      while (running) {
        try {
          const result = await this.crawl();
          const stats = this._store.getStats();
          console.log(
            `[indexer] Crawled ${result.crawledDids} DIDs: `
            + `${result.newRepos} repos, ${result.newStars} stars, ${result.newFollows} follows`
            + `, ${result.newIssues} issues, ${result.newPatches} patches, ${result.newReleases} releases`
            + `, ${result.newIssueSubmissions} issue submissions, ${result.newPatchSubmissions} patch submissions`
            + (result.errors.length > 0 ? ` (${result.errors.length} errors)` : '')
            + ` | Total: ${stats.dids} DIDs, ${stats.repos} repos, ${stats.stars} stars`,
          );
        } catch (err) {
          console.error(`[indexer] Crawl error: ${(err as Error).message}`);
        }

        // Wait for the next cycle.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          const check = setInterval(() => {
            if (!running) { clearTimeout(timer); clearInterval(check); resolve(); }
          }, 500);
        });
      }
    };

    loop();

    return (): void => { running = false; };
  }
}

function recordHasOpenStatus(record: { tags?: unknown }): boolean {
  const tags = record.tags as Record<string, unknown> | undefined;
  return tags?.status === 'open';
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanTag(value: unknown): boolean {
  return value === true || value === 'true';
}

function targetRepo(tags: Record<string, unknown> | undefined): { did: string; repoRecordId: string; name: string } | null {
  const did = stringOr(tags?.repoDid, '');
  const repoRecordId = stringOr(tags?.repoRecordId, '');
  if (!did || !repoRecordId) { return null; }
  return {
    did,
    repoRecordId,
    name: stringOr(tags?.repoName, ''),
  };
}

function submissionKind(value: unknown): 'issue' | 'patch' | undefined {
  return value === 'issue' || value === 'patch' ? value : undefined;
}
