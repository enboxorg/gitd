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

/** Indexed issue summary. */
export type IndexedIssue = {
  did : string;
  repoRecordId : string;
  repoName : string;
  recordId : string;
  contextId : string;
  title : string;
  body : string;
  status : string;
  dateCreated : string;
  indexedAt : string;
};

/** Indexed patch summary. */
export type IndexedPatch = {
  did : string;
  repoRecordId : string;
  repoName : string;
  recordId : string;
  contextId : string;
  title : string;
  body : string;
  status : string;
  baseBranch : string;
  headBranch : string;
  dateCreated : string;
  indexedAt : string;
};

/** Indexed release summary. */
export type IndexedRelease = {
  did : string;
  repoRecordId : string;
  repoName : string;
  recordId : string;
  contextId : string;
  tagName : string;
  name : string;
  body : string;
  draft : boolean;
  prerelease : boolean;
  dateCreated : string;
  indexedAt : string;
};

/** External issue submission written on the submitter's DWN. */
export type IndexedIssueSubmission = {
  submitterDid : string;
  targetDid : string;
  targetRepoRecordId : string;
  targetRepoName : string;
  recordId : string;
  contextId : string;
  title : string;
  body : string;
  status : string;
  dateCreated : string;
  indexedAt : string;
};

/** External patch submission written on the submitter's DWN. */
export type IndexedPatchSubmission = {
  submitterDid : string;
  targetDid : string;
  targetRepoRecordId : string;
  targetRepoName : string;
  sourceDid : string;
  recordId : string;
  contextId : string;
  title : string;
  body : string;
  status : string;
  baseBranch : string;
  headBranch : string;
  dateCreated : string;
  indexedAt : string;
};

/** Owner-side decision for an external submission. */
export type IndexedSubmissionDecision = {
  ownerDid : string;
  repoRecordId : string;
  repoName : string;
  kind : 'issue' | 'patch';
  decision : 'ignored';
  submitterDid : string;
  submissionRecordId : string;
  submissionContextId : string;
  reason : string;
  dateCreated : string;
  indexedAt : string;
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

/** Star record joined with the indexed repo when available. */
export type StarredRepo = IndexedStar & { repo?: RepoWithStars };

/** User profile summary. */
export type UserProfile = {
  did : string;
  repoCount : number;
  starCount : number;
  followerCount : number;
  followingCount : number;
};

/** User search result with relevance score. */
export type UserSearchResult = UserProfile & { score: number };

/** Aggregate store counts. */
export type IndexerStats = {
  dids : number;
  repos : number;
  stars : number;
  follows : number;
  issues : number;
  patches : number;
  releases : number;
  issueSubmissions : number;
  patchSubmissions : number;
  submissionDecisions : number;
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
  /** Maximum number of indexed issues. @default 500_000 */
  maxIssues? : number;
  /** Maximum number of indexed patches. @default 500_000 */
  maxPatches? : number;
  /** Maximum number of indexed releases. @default 250_000 */
  maxReleases? : number;
  /** Maximum number of indexed external issue submissions. @default 500_000 */
  maxIssueSubmissions? : number;
  /** Maximum number of indexed external patch submissions. @default 500_000 */
  maxPatchSubmissions? : number;
  /** Maximum number of indexed owner-side submission decisions. @default 500_000 */
  maxSubmissionDecisions? : number;
};

const DEFAULT_LIMITS: Required<IndexerStoreLimits> = {
  maxDids                : 100_000,
  maxRepos               : 100_000,
  maxStars               : 500_000,
  maxFollows             : 500_000,
  maxIssues              : 500_000,
  maxPatches             : 500_000,
  maxReleases            : 250_000,
  maxIssueSubmissions    : 500_000,
  maxPatchSubmissions    : 500_000,
  maxSubmissionDecisions : 500_000,
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

  /** Issues keyed by `did:repoRecordId:recordId`. */
  private _issues = new Map<string, IndexedIssue>();

  /** Patches keyed by `did:repoRecordId:recordId`. */
  private _patches = new Map<string, IndexedPatch>();

  /** Releases keyed by `did:repoRecordId:recordId`. */
  private _releases = new Map<string, IndexedRelease>();

  /** External issue submissions keyed by `targetDid:targetRepoRecordId:submitterDid:recordId`. */
  private _issueSubmissions = new Map<string, IndexedIssueSubmission>();

  /** External patch submissions keyed by `targetDid:targetRepoRecordId:submitterDid:recordId`. */
  private _patchSubmissions = new Map<string, IndexedPatchSubmission>();

  /** Owner-side submission decisions keyed by `ownerDid:repoRecordId:kind:submitterDid:recordId`. */
  private _submissionDecisions = new Map<string, IndexedSubmissionDecision>();

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

  /** Get every DID currently visible in indexed repos, stars, and follows. */
  public getKnownDids(): string[] {
    const dids = new Set(this._dids);
    for (const repo of this._repos.values()) {
      dids.add(repo.did);
    }
    for (const star of this._stars.values()) {
      dids.add(star.starrerDid);
      dids.add(star.repoDid);
    }
    for (const follow of this._follows.values()) {
      dids.add(follow.followerDid);
      dids.add(follow.targetDid);
    }
    return [...dids];
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

  /** Get an indexed repo by owner DID and repo name. */
  public getRepoByName(did: string, name: string): IndexedRepo | undefined {
    for (const repo of this._repos.values()) {
      if (repo.did === did && repo.name === name) { return repo; }
    }
    return undefined;
  }

  /** Get an indexed repo by owner DID and record ID. */
  public getRepoByRecord(did: string, recordId: string): IndexedRepo | undefined {
    return this._repos.get(`${did}:${recordId}`);
  }

  /** Get all indexed repos. */
  public getAllRepos(): IndexedRepo[] {
    return [...this._repos.values()];
  }

  // -----------------------------------------------------------------------
  // Work item operations
  // -----------------------------------------------------------------------

  /** Upsert an indexed issue summary. Evicts oldest entry if at capacity. */
  public putIssue(issue: IndexedIssue): void {
    const key = workItemKey(issue.did, issue.repoRecordId, issue.recordId);
    if (!this._issues.has(key) && this._issues.size >= this._limits.maxIssues) {
      const oldest = this._issues.keys().next().value;
      if (oldest !== undefined) { this._issues.delete(oldest); }
    }
    this._issues.set(key, issue);
    this.addDid(issue.did);
  }

  /** List issue summaries for a repo, newest first. */
  public getIssuesForRepo(did: string, repoRecordId: string): IndexedIssue[] {
    return [...this._issues.values()]
      .filter((issue) => issue.did === did && issue.repoRecordId === repoRecordId)
      .sort(newestFirst);
  }

  /** Get one issue summary by repo and record ID. */
  public getIssueByRecord(did: string, repoRecordId: string, recordId: string): IndexedIssue | undefined {
    return this._issues.get(workItemKey(did, repoRecordId, recordId));
  }

  /** Upsert an indexed patch summary. Evicts oldest entry if at capacity. */
  public putPatch(patch: IndexedPatch): void {
    const key = workItemKey(patch.did, patch.repoRecordId, patch.recordId);
    if (!this._patches.has(key) && this._patches.size >= this._limits.maxPatches) {
      const oldest = this._patches.keys().next().value;
      if (oldest !== undefined) { this._patches.delete(oldest); }
    }
    this._patches.set(key, patch);
    this.addDid(patch.did);
  }

  /** List patch summaries for a repo, newest first. */
  public getPatchesForRepo(did: string, repoRecordId: string): IndexedPatch[] {
    return [...this._patches.values()]
      .filter((patch) => patch.did === did && patch.repoRecordId === repoRecordId)
      .sort(newestFirst);
  }

  /** Get one patch summary by repo and record ID. */
  public getPatchByRecord(did: string, repoRecordId: string, recordId: string): IndexedPatch | undefined {
    return this._patches.get(workItemKey(did, repoRecordId, recordId));
  }

  /** Upsert an indexed release summary. Evicts oldest entry if at capacity. */
  public putRelease(release: IndexedRelease): void {
    const key = workItemKey(release.did, release.repoRecordId, release.recordId);
    if (!this._releases.has(key) && this._releases.size >= this._limits.maxReleases) {
      const oldest = this._releases.keys().next().value;
      if (oldest !== undefined) { this._releases.delete(oldest); }
    }
    this._releases.set(key, release);
    this.addDid(release.did);
  }

  /** List release summaries for a repo, newest first. */
  public getReleasesForRepo(did: string, repoRecordId: string): IndexedRelease[] {
    return [...this._releases.values()]
      .filter((release) => release.did === did && release.repoRecordId === repoRecordId)
      .sort(newestFirst);
  }

  /** Get one release summary by repo and record ID. */
  public getReleaseByRecord(did: string, repoRecordId: string, recordId: string): IndexedRelease | undefined {
    return this._releases.get(workItemKey(did, repoRecordId, recordId));
  }

  /** Upsert an external issue submission. Evicts oldest entry if at capacity. */
  public putIssueSubmission(submission: IndexedIssueSubmission): void {
    const key = submissionKey(
      submission.targetDid,
      submission.targetRepoRecordId,
      submission.submitterDid,
      submission.recordId,
    );
    if (!this._issueSubmissions.has(key) && this._issueSubmissions.size >= this._limits.maxIssueSubmissions) {
      const oldest = this._issueSubmissions.keys().next().value;
      if (oldest !== undefined) { this._issueSubmissions.delete(oldest); }
    }
    this._issueSubmissions.set(key, submission);
    this.addDid(submission.submitterDid);
    this.addDid(submission.targetDid);
  }

  /** List external issue submissions for a repo, newest first. */
  public getIssueSubmissionsForRepo(did: string, repoRecordId: string): IndexedIssueSubmission[] {
    return [...this._issueSubmissions.values()]
      .filter((submission) => submission.targetDid === did && submission.targetRepoRecordId === repoRecordId)
      .filter((submission) => !this.hasSubmissionDecision('issue', did, repoRecordId, submission.submitterDid, submission.recordId))
      .sort(newestFirst);
  }

  /** Get one active external issue submission by target repo and record ID. */
  public getIssueSubmissionByRecord(did: string, repoRecordId: string, recordId: string): IndexedIssueSubmission | undefined {
    return this.getIssueSubmissionsForRepo(did, repoRecordId)
      .find((submission) => submission.recordId === recordId);
  }

  /** Upsert an external patch submission. Evicts oldest entry if at capacity. */
  public putPatchSubmission(submission: IndexedPatchSubmission): void {
    const key = submissionKey(
      submission.targetDid,
      submission.targetRepoRecordId,
      submission.submitterDid,
      submission.recordId,
    );
    if (!this._patchSubmissions.has(key) && this._patchSubmissions.size >= this._limits.maxPatchSubmissions) {
      const oldest = this._patchSubmissions.keys().next().value;
      if (oldest !== undefined) { this._patchSubmissions.delete(oldest); }
    }
    this._patchSubmissions.set(key, submission);
    this.addDid(submission.submitterDid);
    this.addDid(submission.targetDid);
  }

  /** List external patch submissions for a repo, newest first. */
  public getPatchSubmissionsForRepo(did: string, repoRecordId: string): IndexedPatchSubmission[] {
    return [...this._patchSubmissions.values()]
      .filter((submission) => submission.targetDid === did && submission.targetRepoRecordId === repoRecordId)
      .filter((submission) => !this.hasSubmissionDecision('patch', did, repoRecordId, submission.submitterDid, submission.recordId))
      .sort(newestFirst);
  }

  /** Get one active external patch submission by target repo and record ID. */
  public getPatchSubmissionByRecord(did: string, repoRecordId: string, recordId: string): IndexedPatchSubmission | undefined {
    return this.getPatchSubmissionsForRepo(did, repoRecordId)
      .find((submission) => submission.recordId === recordId);
  }

  /** Upsert an owner-side decision for an external submission. */
  public putSubmissionDecision(decision: IndexedSubmissionDecision): void {
    const key = submissionDecisionKey(
      decision.ownerDid,
      decision.repoRecordId,
      decision.kind,
      decision.submitterDid,
      decision.submissionRecordId,
    );
    if (!this._submissionDecisions.has(key) && this._submissionDecisions.size >= this._limits.maxSubmissionDecisions) {
      const oldest = this._submissionDecisions.keys().next().value;
      if (oldest !== undefined) { this._submissionDecisions.delete(oldest); }
    }
    this._submissionDecisions.set(key, decision);
    this.addDid(decision.ownerDid);
    this.addDid(decision.submitterDid);
  }

  /** Return whether an external submission has an owner-side decision. */
  public hasSubmissionDecision(
    kind: 'issue' | 'patch',
    ownerDid: string,
    repoRecordId: string,
    submitterDid: string,
    submissionRecordId: string,
  ): boolean {
    return this._submissionDecisions.has(
      submissionDecisionKey(ownerDid, repoRecordId, kind, submitterDid, submissionRecordId),
    );
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

  /** Get starred repos for a user, joined with repo metadata when indexed. */
  public getStarredReposByUser(did: string): StarredRepo[] {
    return this.getStarredByUser(did).map((star) => {
      const repo = this.getRepoByRecord(star.repoDid, star.repoRecordId);
      if (!repo) { return star; }
      return {
        ...star,
        repo: { ...repo, starCount: this.getStarCount(repo.did, repo.recordId) },
      };
    });
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

  /** Get follow records where the user is the target. */
  public getFollowersForUser(did: string): IndexedFollow[] {
    const result: IndexedFollow[] = [];
    for (const f of this._follows.values()) {
      if (f.targetDid === did) { result.push(f); }
    }
    return result;
  }

  /** Get following count for a user. */
  public getFollowingCount(did: string): number {
    let count = 0;
    for (const f of this._follows.values()) {
      if (f.followerDid === did) { count++; }
    }
    return count;
  }

  /** Get follow records created by the user. */
  public getFollowingForUser(did: string): IndexedFollow[] {
    const result: IndexedFollow[] = [];
    for (const f of this._follows.values()) {
      if (f.followerDid === did) { result.push(f); }
    }
    return result;
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

  /** Get repos owned by a DID, sorted by star count descending. */
  public getReposForDid(did: string): RepoWithStars[] {
    return this.getReposWithStars().filter((r) => r.did === did);
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
   * Search known DIDs.
   *
   * Returns profiles sorted by DID match strength, then by visible activity.
   */
  public searchUsers(query: string, limit: number = 50): UserSearchResult[] {
    const q = query.toLowerCase();
    const results: UserSearchResult[] = [];

    for (const did of this.getKnownDids()) {
      const normalized = did.toLowerCase();
      let score = 0;

      if (normalized === q) { score += 10; }
      else if (normalized.startsWith(q)) { score += 5; }
      else if (normalized.includes(q)) { score += 3; }

      if (score === 0) { continue; }

      const profile = this.getUserProfile(did);
      const activity = profile.repoCount + profile.starCount + profile.followerCount + profile.followingCount;
      results.push({ ...profile, score: score + Math.min(activity * 0.1, 5) });
    }

    return results
      .sort((a, b) => b.score - a.score || a.did.localeCompare(b.did))
      .slice(0, limit);
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
  public getStats(): IndexerStats {
    return {
      dids                : this._dids.size,
      repos               : this._repos.size,
      stars               : this._stars.size,
      follows             : this._follows.size,
      issues              : this._issues.size,
      patches             : this._patches.size,
      releases            : this._releases.size,
      issueSubmissions    : this._issueSubmissions.size,
      patchSubmissions    : this._patchSubmissions.size,
      submissionDecisions : this._submissionDecisions.size,
    };
  }

  /** Clear all data. */
  public clear(): void {
    this._repos.clear();
    this._stars.clear();
    this._follows.clear();
    this._issues.clear();
    this._patches.clear();
    this._releases.clear();
    this._issueSubmissions.clear();
    this._patchSubmissions.clear();
    this._submissionDecisions.clear();
    this._dids.clear();
    this._cursors.clear();
  }
}

function newestFirst<T extends { dateCreated: string }>(a: T, b: T): number {
  return b.dateCreated.localeCompare(a.dateCreated);
}

function workItemKey(did: string, repoRecordId: string, recordId: string): string {
  return `${did}:${repoRecordId}:${recordId}`;
}

function submissionKey(targetDid: string, repoRecordId: string, submitterDid: string, recordId: string): string {
  return `${targetDid}:${repoRecordId}:${submitterDid}:${recordId}`;
}

function submissionDecisionKey(
  ownerDid: string,
  repoRecordId: string,
  kind: 'issue' | 'patch',
  submitterDid: string,
  recordId: string,
): string {
  return `${ownerDid}:${repoRecordId}:${kind}:${submitterDid}:${recordId}`;
}
