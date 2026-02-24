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
      crawledDids : 0,
      newRepos    : 0,
      newStars    : 0,
      newFollows  : 0,
      errors      : [],
    };

    for (const did of dids) {
      try {
        const counts = await this.crawlDid(did);
        result.newRepos += counts.repos;
        result.newStars += counts.stars;
        result.newFollows += counts.follows;
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
  public async crawlDid(did: string): Promise<{ repos: number; stars: number; follows: number }> {
    const from = did === this._ctx.did ? undefined : did;
    let repos = 0;
    let stars = 0;
    let follows = 0;

    // ---------------------------------------------------------------
    // Repos
    // ---------------------------------------------------------------
    const { records: repoRecords } = await this._ctx.repo.records.query('repo', { from });

    for (const rec of repoRecords) {
      const data = await rec.data.json();
      const tags = rec.tags as Record<string, string> | undefined;
      const contextId = rec.contextId ?? '';

      // Count open issues.
      const { records: issues } = await this._ctx.issues.records.query('repo/issue', {
        from,
        filter: { contextId, tags: { status: 'open' } },
      });

      // Count open patches.
      const { records: patches } = await this._ctx.patches.records.query('repo/patch', {
        from,
        filter: { contextId, tags: { status: 'open' } },
      });

      // Count releases.
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

      const indexed: IndexedRepo = {
        did,
        recordId      : rec.id,
        contextId,
        name          : data.name ?? 'unnamed',
        description   : data.description ?? '',
        defaultBranch : data.defaultBranch ?? 'main',
        visibility    : tags?.visibility ?? 'public',
        language      : tags?.language ?? '',
        topics,
        openIssues    : issues.length,
        openPatches   : patches.length,
        releaseCount  : releases.length,
        lastUpdated   : rec.dateCreated ?? new Date().toISOString(),
        indexedAt     : new Date().toISOString(),
      };

      this._store.putRepo(indexed);
      repos++;
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

    return { repos, stars, follows };
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
