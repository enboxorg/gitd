/**
 * In-memory indexer store — maintains materialized views of data
 * crawled from distributed DWN records.
 *
 * Each entity is keyed by a unique composite identifier (DID + recordId
 * or similar) and stored in a Map.  Aggregation methods compute star
 * counts, trending scores, search results, etc. on the fly.
 *
 * A production deployment would back this with PostgreSQL or similar,
 * but the in-memory implementation keeps the MVP dependency-free and
 * testable.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Indexed repo metadata. */
export type IndexedRepo = {
  did : string;
  recordId : string;
  contextId : string;
  name : string;
  description : string;
  defaultBranch : string;
  visibility : string;
  language : string;
  topics : string[];
  openIssues : number;
  openPatches : number;
  releaseCount : number;
  lastUpdated : string;
  indexedAt : string;
};

/** Indexed star record. */
export type IndexedStar = {
  starrerDid : string;
  repoDid : string;
  repoRecordId : string;
  dateCreated : string;
};

/** Indexed follow record. */
export type IndexedFollow = {
  followerDid : string;
  targetDid : string;
  dateCreated : string;
};

/** Crawl cursor — tracks progress per DID for incremental crawling. */
export type CrawlCursor = {
  did : string;
  lastCrawled : string;
};

/** Aggregated repo view with star count. */
export type RepoWithStars = IndexedRepo & { starCount: number };

/** Search result with relevance score. */
export type SearchResult = RepoWithStars & { score: number };

/** User profile summary. */
export type UserProfile = {
  did : string;
  repoCount : number;
  starCount : number;
  followerCount : number;
  followingCount : number;
};

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

/** Configurable size limits for the in-memory store. */
export type IndexerStoreLimits = {
  /** Maximum number of tracked DIDs. @default 100_000 */
  maxDids? : number;
  /** Maximum number of indexed repos. @default 100_000 */
  maxRepos? : number;
  /** Maximum number of indexed stars. @default 500_000 */
  maxStars? : number;
  /** Maximum number of indexed follows. @default 500_000 */
  maxFollows? : number;
};

const DEFAULT_LIMITS: Required<IndexerStoreLimits> = {
  maxDids    : 100_000,
  maxRepos   : 100_000,
  maxStars   : 500_000,
  maxFollows : 500_000,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** In-memory indexer store with configurable size limits. */
export class IndexerStore {
  /** Repos keyed by `did:recordId`. */
  private _repos = new Map<string, IndexedRepo>();

  /** Stars keyed by `starrerDid:repoDid:repoRecordId`. */
  private _stars = new Map<string, IndexedStar>();

  /** Follows keyed by `followerDid:targetDid`. */
  private _follows = new Map<string, IndexedFollow>();

  /** Known DIDs to crawl. */
  private _dids = new Set<string>();

  /** Per-DID crawl cursors. */
  private _cursors = new Map<string, CrawlCursor>();

  /** Size limits for LRU-style eviction. */
  private _limits: Required<IndexerStoreLimits>;

  public constructor(limits?: IndexerStoreLimits) {
    this._limits = { ...DEFAULT_LIMITS, ...limits };
  }

  // -----------------------------------------------------------------------
  // DID management
  // -----------------------------------------------------------------------

  /** Register a DID for crawling. Evicts oldest entry if at capacity. */
  public addDid(did: string): void {
    if (this._dids.has(did)) { this._dids.add(did); return; }
    if (this._dids.size >= this._limits.maxDids) {
      const oldest = this._dids.values().next().value;
      if (oldest !== undefined) { this._dids.delete(oldest); }
    }
    this._dids.add(did);
  }

  /** Remove a DID from the crawl list. */
  public removeDid(did: string): void {
    this._dids.delete(did);
  }

  /** Get all registered DIDs. */
  public getDids(): string[] {
    return [...this._dids];
  }

  /** Get the crawl cursor for a DID. */
  public getCursor(did: string): CrawlCursor | undefined {
    return this._cursors.get(did);
  }

  /** Update the crawl cursor for a DID. */
  public setCursor(did: string, lastCrawled: string): void {
    this._cursors.set(did, { did, lastCrawled });
  }

  // -----------------------------------------------------------------------
  // Repo operations
  // -----------------------------------------------------------------------

  /** Upsert an indexed repo. Evicts oldest entry if at capacity. */
  public putRepo(repo: IndexedRepo): void {
    const key = `${repo.did}:${repo.recordId}`;
    if (!this._repos.has(key) && this._repos.size >= this._limits.maxRepos) {
      const oldest = this._repos.keys().next().value;
      if (oldest !== undefined) { this._repos.delete(oldest); }
    }
    this._repos.set(key, repo);
    this.addDid(repo.did);
  }

  /** Get an indexed repo by DID (returns first match). */
  public getRepo(did: string): IndexedRepo | undefined {
    for (const repo of this._repos.values()) {
      if (repo.did === did) { return repo; }
    }
    return undefined;
  }

  /** Get all indexed repos. */
  public getAllRepos(): IndexedRepo[] {
    return [...this._repos.values()];
  }

  // -----------------------------------------------------------------------
  // Star operations
  // -----------------------------------------------------------------------

  /** Upsert an indexed star. Evicts oldest entry if at capacity. */
  public putStar(star: IndexedStar): void {
    const key = `${star.starrerDid}:${star.repoDid}:${star.repoRecordId}`;
    if (!this._stars.has(key) && this._stars.size >= this._limits.maxStars) {
      const oldest = this._stars.keys().next().value;
      if (oldest !== undefined) { this._stars.delete(oldest); }
    }
    this._stars.set(key, star);
    this.addDid(star.starrerDid);
  }

  /** Remove a star. */
  public removeStar(starrerDid: string, repoDid: string, repoRecordId: string): void {
    this._stars.delete(`${starrerDid}:${repoDid}:${repoRecordId}`);
  }

  /** Get star count for a repo. */
  public getStarCount(repoDid: string, repoRecordId: string): number {
    let count = 0;
    for (const star of this._stars.values()) {
      if (star.repoDid === repoDid && star.repoRecordId === repoRecordId) { count++; }
    }
    return count;
  }

  /** Get all stars for a repo. */
  public getStarsForRepo(repoDid: string, repoRecordId: string): IndexedStar[] {
    const result: IndexedStar[] = [];
    for (const star of this._stars.values()) {
      if (star.repoDid === repoDid && star.repoRecordId === repoRecordId) { result.push(star); }
    }
    return result;
  }

  /** Get all repos starred by a user. */
  public getStarredByUser(did: string): IndexedStar[] {
    const result: IndexedStar[] = [];
    for (const star of this._stars.values()) {
      if (star.starrerDid === did) { result.push(star); }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Follow operations
  // -----------------------------------------------------------------------

  /** Upsert an indexed follow. Evicts oldest entry if at capacity. */
  public putFollow(follow: IndexedFollow): void {
    const key = `${follow.followerDid}:${follow.targetDid}`;
    if (!this._follows.has(key) && this._follows.size >= this._limits.maxFollows) {
      const oldest = this._follows.keys().next().value;
      if (oldest !== undefined) { this._follows.delete(oldest); }
    }
    this._follows.set(key, follow);
    this.addDid(follow.followerDid);
    this.addDid(follow.targetDid);
  }

  /** Remove a follow. */
  public removeFollow(followerDid: string, targetDid: string): void {
    this._follows.delete(`${followerDid}:${targetDid}`);
  }

  /** Get follower count for a user. */
  public getFollowerCount(did: string): number {
    let count = 0;
    for (const f of this._follows.values()) {
      if (f.targetDid === did) { count++; }
    }
    return count;
  }

  /** Get following count for a user. */
  public getFollowingCount(did: string): number {
    let count = 0;
    for (const f of this._follows.values()) {
      if (f.followerDid === did) { count++; }
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // Aggregation queries
  // -----------------------------------------------------------------------

  /** Get repos with star counts, sorted by star count descending. */
  public getReposWithStars(): RepoWithStars[] {
    return this.getAllRepos()
      .map((r) => ({ ...r, starCount: this.getStarCount(r.did, r.recordId) }))
      .sort((a, b) => b.starCount - a.starCount);
  }

  /**
   * Trending repos — sorted by recent star activity.
   *
   * Trending is computed as the number of stars received within
   * `windowMs` (default: 7 days), weighted by recency.
   */
  public getTrending(limit: number = 20, windowMs: number = 7 * 24 * 60 * 60 * 1000): RepoWithStars[] {
    const now = Date.now();
    const cutoff = new Date(now - windowMs).toISOString();

    // Count recent stars per repo.
    const recentStars = new Map<string, number>();
    for (const star of this._stars.values()) {
      if (star.dateCreated >= cutoff) {
        const key = `${star.repoDid}:${star.repoRecordId}`;
        recentStars.set(key, (recentStars.get(key) ?? 0) + 1);
      }
    }

    return this.getReposWithStars()
      .map((r) => {
        const key = `${r.did}:${r.recordId}`;
        const recent = recentStars.get(key) ?? 0;
        return { ...r, _trending: recent };
      })
      .sort((a, b) => (b as any)._trending - (a as any)._trending || b.starCount - a.starCount)
      .slice(0, limit)
      .map(({ ...r }) => { delete (r as any)._trending; return r; });
  }

  /**
   * Search repos by name, description, topics, or language.
   *
   * Returns results sorted by relevance score.  Scoring:
   *   - Name exact match: 10
   *   - Name prefix match: 5
   *   - Name substring match: 3
   *   - Topic match: 4
   *   - Language match: 2
   *   - Description substring match: 1
   *   - Star count bonus: 0.1 per star (capped at 5)
   */
  public search(query: string, limit: number = 50): SearchResult[] {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const r of this.getReposWithStars()) {
      let score = 0;
      const name = r.name.toLowerCase();
      const desc = r.description.toLowerCase();

      if (name === q) { score += 10; }
      else if (name.startsWith(q)) { score += 5; }
      else if (name.includes(q)) { score += 3; }

      if (r.topics.some((t) => t.toLowerCase() === q)) { score += 4; }
      if (r.language.toLowerCase() === q) { score += 2; }
      if (desc.includes(q)) { score += 1; }

      // Star bonus.
      score += Math.min(r.starCount * 0.1, 5);

      if (score > 0) {
        results.push({ ...r, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Get user profile summary. */
  public getUserProfile(did: string): UserProfile {
    const repos = this.getAllRepos().filter((r) => r.did === did);
    let totalStars = 0;
    for (const r of repos) {
      totalStars += this.getStarCount(r.did, r.recordId);
    }
    return {
      did,
      repoCount      : repos.length,
      starCount      : totalStars,
      followerCount  : this.getFollowerCount(did),
      followingCount : this.getFollowingCount(did),
    };
  }

  /**
   * List repos by language, sorted by star count.
   */
  public getReposByLanguage(language: string): RepoWithStars[] {
    const lang = language.toLowerCase();
    return this.getReposWithStars()
      .filter((r) => r.language.toLowerCase() === lang);
  }

  /**
   * List repos by topic, sorted by star count.
   */
  public getReposByTopic(topic: string): RepoWithStars[] {
    const t = topic.toLowerCase();
    return this.getReposWithStars()
      .filter((r) => r.topics.some((tp) => tp.toLowerCase() === t));
  }

  /** Get store statistics. */
  public getStats(): { dids: number; repos: number; stars: number; follows: number } {
    return {
      dids    : this._dids.size,
      repos   : this._repos.size,
      stars   : this._stars.size,
      follows : this._follows.size,
    };
  }

  /** Clear all data. */
  public clear(): void {
    this._repos.clear();
    this._stars.clear();
    this._follows.clear();
    this._dids.clear();
    this._cursors.clear();
  }
}
