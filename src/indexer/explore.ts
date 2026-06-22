/**
 * Server-rendered Explore UI for the indexer.
 *
 * The indexer API remains JSON under /api. These pages make the same
 * materialized views browsable for humans.
 *
 * @module
 */

import type {
  IndexedIssue,
  IndexedIssueSubmission,
  IndexedPatch,
  IndexedPatchSubmission,
  IndexedRelease,
  IndexedRepo,
  IndexerStore,
  RepoWithStars,
  UserProfile,
  UserSearchResult,
} from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExploreResponse = {
  status : number;
  body : string;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleExploreRequest(store: IndexerStore, url: URL): ExploreResponse {
  const path = url.pathname;

  if (path === '/' || path === '') {
    return html(200, layout('Explore', homePage(store)));
  }

  if (path === '/repos') {
    return html(200, layout('Repositories', reposPage(store, url)));
  }

  const submissionItemMatch = path.match(
    /^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/submissions\/(issues|patches)\/([^/]+)$/,
  );
  if (submissionItemMatch) {
    const repo = store.getRepoByName(submissionItemMatch[1], decodeURIComponent(submissionItemMatch[2]));
    if (!repo) { return notFound('Repository not found'); }

    const collection = submissionItemMatch[3];
    const recordId = decodeURIComponent(submissionItemMatch[4]);
    if (collection === 'issues') {
      const submission = store.getIssueSubmissionByRecord(repo.did, repo.recordId, recordId);
      return submission
        ? html(200, layout(submission.title, issueSubmissionDetailPage(repo, submission)))
        : notFound('Issue submission not found');
    }
    const submission = store.getPatchSubmissionByRecord(repo.did, repo.recordId, recordId);
    return submission
      ? html(200, layout(submission.title, patchSubmissionDetailPage(repo, submission)))
      : notFound('Patch submission not found');
  }

  const submissionCollectionMatch = path.match(
    /^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/submissions\/(issues|patches)$/,
  );
  if (submissionCollectionMatch) {
    const repo = store.getRepoByName(submissionCollectionMatch[1], decodeURIComponent(submissionCollectionMatch[2]));
    if (!repo) { return notFound('Repository not found'); }
    return html(200, layout('External submissions', repoSubmissionPage(store, repo, submissionCollectionMatch[3])));
  }

  const repoItemMatch = path.match(
    /^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/(issues|patches|releases)\/([^/]+)$/,
  );
  if (repoItemMatch) {
    const repo = store.getRepoByName(repoItemMatch[1], decodeURIComponent(repoItemMatch[2]));
    if (!repo) { return notFound('Repository not found'); }

    const collection = repoItemMatch[3];
    const recordId = decodeURIComponent(repoItemMatch[4]);
    if (collection === 'issues') {
      const issue = store.getIssueByRecord(repo.did, repo.recordId, recordId);
      return issue ? html(200, layout(issue.title, issueDetailPage(repo, issue))) : notFound('Issue not found');
    }
    if (collection === 'patches') {
      const patch = store.getPatchByRecord(repo.did, repo.recordId, recordId);
      return patch ? html(200, layout(patch.title, patchDetailPage(repo, patch))) : notFound('Patch not found');
    }

    const release = store.getReleaseByRecord(repo.did, repo.recordId, recordId);
    return release ? html(200, layout(release.name, releaseDetailPage(repo, release))) : notFound('Release not found');
  }

  const repoCollectionMatch =
    path.match(/^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)\/(issues|patches|releases)$/);
  if (repoCollectionMatch) {
    const repo = store.getRepoByName(repoCollectionMatch[1], decodeURIComponent(repoCollectionMatch[2]));
    if (!repo) { return notFound('Repository not found'); }
    return html(200, layout(collectionTitle(repoCollectionMatch[3]), repoCollectionPage(store, repo, repoCollectionMatch[3])));
  }

  const repoMatch = path.match(/^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9._-]+)$/);
  if (repoMatch) {
    const repo = store.getRepoByName(repoMatch[1], decodeURIComponent(repoMatch[2]));
    if (!repo) { return notFound('Repository not found'); }
    return html(200, layout(repo.name, repoDetailPage(store, repo)));
  }

  if (path === '/users') {
    return html(200, layout('Users', usersPage(store, url)));
  }

  const userMatch = path.match(/^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/);
  if (userMatch) {
    return html(200, layout(shortDid(userMatch[1]), userDetailPage(store, userMatch[1])));
  }

  return notFound('Page not found');
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function homePage(store: IndexerStore): string {
  const trending = store.getTrending(10);
  const repos = store.getReposWithStars().slice(0, 10);

  return `
    <section>
      <div class="toolbar">
        <form action="/repos" method="get">
          <label for="repo-q">Repositories</label>
          <div class="search-row">
            <input id="repo-q" name="q" type="search" placeholder="repo, topic, language">
            <button type="submit">Search</button>
          </div>
        </form>
        <form action="/users" method="get">
          <label for="user-q">Users</label>
          <div class="search-row">
            <input id="user-q" name="q" type="search" placeholder="did:jwk:...">
            <button type="submit">Search</button>
          </div>
        </form>
      </div>
    </section>
    <section>
      <h2>Trending</h2>
      ${repoTable(trending)}
    </section>
    <section>
      <h2>Repositories</h2>
      ${repoTable(repos)}
    </section>`;
}

function reposPage(store: IndexerStore, url: URL): string {
  const q = url.searchParams.get('q')?.trim();
  const language = url.searchParams.get('language')?.trim();
  const topic = url.searchParams.get('topic')?.trim();

  let repos: RepoWithStars[];
  if (q) {
    repos = store.search(q);
  } else if (language) {
    repos = store.getReposByLanguage(language);
  } else if (topic) {
    repos = store.getReposByTopic(topic);
  } else {
    repos = store.getReposWithStars();
  }

  return `
    <section>
      <div class="page-heading">
        <h1>Repositories</h1>
        <form action="/repos" method="get" class="compact-search">
          <input name="q" type="search" value="${esc(q ?? '')}" placeholder="repo, topic, language">
          <button type="submit">Search</button>
        </form>
      </div>
      ${repoTable(repos)}
    </section>`;
}

function repoDetailPage(store: IndexerStore, repo: IndexedRepo): string {
  const starCount = store.getStarCount(repo.did, repo.recordId);
  const stars = store.getStarsForRepo(repo.did, repo.recordId);
  const issues = store.getIssuesForRepo(repo.did, repo.recordId);
  const patches = store.getPatchesForRepo(repo.did, repo.recordId);
  const releases = store.getReleasesForRepo(repo.did, repo.recordId);
  const issueSubmissions = store.getIssueSubmissionsForRepo(repo.did, repo.recordId);
  const patchSubmissions = store.getPatchSubmissionsForRepo(repo.did, repo.recordId);

  return `
    <section>
      <p class="crumb"><a href="/repos">Repositories</a> / <a href="${userPath(repo.did)}">${esc(shortDid(repo.did))}</a></p>
      <h1>${esc(repo.name)}</h1>
      ${repo.description ? `<p>${esc(repo.description)}</p>` : ''}
      <dl class="facts">
        <div><dt>DID</dt><dd><a href="${userPath(repo.did)}"><code>${esc(repo.did)}</code></a></dd></div>
        <div><dt>Default branch</dt><dd>${esc(repo.defaultBranch)}</dd></div>
        <div><dt>Visibility</dt><dd>${esc(repo.visibility)}</dd></div>
        <div><dt>Language</dt><dd>${esc(repo.language || '-')}</dd></div>
        <div><dt>Stars</dt><dd>${starCount}</dd></div>
        <div><dt>Issues</dt><dd>${repo.openIssues} open</dd></div>
        <div><dt>Patches</dt><dd>${repo.openPatches} open</dd></div>
        <div><dt>Releases</dt><dd>${repo.releaseCount}</dd></div>
      </dl>
      <p><code>gitd clone ${esc(repo.did)}/${esc(repo.name)}</code></p>
    </section>
    <section>
      <h2><a href="${repoPath(repo)}/issues">Issues</a></h2>
      ${issueTable(issues.slice(0, 10), repo)}
    </section>
    <section>
      <h2><a href="${repoPath(repo)}/patches">Patches</a></h2>
      ${patchTable(patches.slice(0, 10), repo)}
    </section>
    <section>
      <h2><a href="${repoPath(repo)}/releases">Releases</a></h2>
      ${releaseTable(releases.slice(0, 10), repo)}
    </section>
    <section>
      <h2><a href="${repoPath(repo)}/submissions/issues">External Issues</a></h2>
      ${issueSubmissionTable(issueSubmissions.slice(0, 10), repo)}
    </section>
    <section>
      <h2><a href="${repoPath(repo)}/submissions/patches">External Patches</a></h2>
      ${patchSubmissionTable(patchSubmissions.slice(0, 10), repo)}
    </section>
    <section>
      <h2>Topics</h2>
      ${repo.topics.length > 0 ? topicList(repo.topics) : '<p class="empty">No topics indexed.</p>'}
    </section>
    <section>
      <h2>Stars</h2>
      ${stars.length > 0 ? userList(stars.map(star => profileFromDid(store, star.starrerDid))) : '<p class="empty">No stars indexed.</p>'}
    </section>`;
}

function repoCollectionPage(store: IndexerStore, repo: IndexedRepo, collection: string): string {
  const crumb = `
    <p class="crumb">
      <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a>
    </p>`;

  if (collection === 'issues') {
    return `${crumb}<section><h1>Issues</h1>${issueTable(store.getIssuesForRepo(repo.did, repo.recordId), repo)}</section>`;
  }
  if (collection === 'patches') {
    return `${crumb}<section><h1>Patches</h1>${patchTable(store.getPatchesForRepo(repo.did, repo.recordId), repo)}</section>`;
  }
  return `${crumb}<section><h1>Releases</h1>${releaseTable(store.getReleasesForRepo(repo.did, repo.recordId), repo)}</section>`;
}

function repoSubmissionPage(store: IndexerStore, repo: IndexedRepo, collection: string): string {
  const crumb = `
    <p class="crumb">
      <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a>
    </p>`;

  if (collection === 'issues') {
    const submissions = store.getIssueSubmissionsForRepo(repo.did, repo.recordId);
    return `${crumb}<section><h1>External Issues</h1>${issueSubmissionTable(submissions, repo)}</section>`;
  }
  const submissions = store.getPatchSubmissionsForRepo(repo.did, repo.recordId);
  return `${crumb}<section><h1>External Patches</h1>${patchSubmissionTable(submissions, repo)}</section>`;
}

function issueSubmissionDetailPage(repo: IndexedRepo, submission: IndexedIssueSubmission): string {
  return `
    <section>
      <p class="crumb">
        <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a> /
        <a href="${repoPath(repo)}/submissions/issues">External Issues</a>
      </p>
      <h1>${esc(submission.title)}</h1>
      <dl class="facts">
        <div><dt>Status</dt><dd>${status(submission.status)}</dd></div>
        <div><dt>Submitter</dt><dd>
          <a href="${userPath(submission.submitterDid)}"><code>${esc(shortDid(submission.submitterDid))}</code></a>
        </dd></div>
        <div><dt>Created</dt><dd>${shortDate(submission.dateCreated)}</dd></div>
        <div><dt>Source record</dt><dd><code>${esc(submission.recordId)}</code></dd></div>
      </dl>
      ${bodyBlock(submission.body)}
      <div class="commands">
        <code>gitd issue accept ${esc(submission.submitterDid)} ${esc(submission.recordId)}</code>
        <code>gitd issue ignore ${esc(submission.submitterDid)} ${esc(submission.recordId)}</code>
      </div>
    </section>`;
}

function patchSubmissionDetailPage(repo: IndexedRepo, submission: IndexedPatchSubmission): string {
  return `
    <section>
      <p class="crumb">
        <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a> /
        <a href="${repoPath(repo)}/submissions/patches">External Patches</a>
      </p>
      <h1>${esc(submission.title)}</h1>
      <dl class="facts">
        <div><dt>Status</dt><dd>${status(submission.status)}</dd></div>
        <div><dt>Submitter</dt><dd>
          <a href="${userPath(submission.submitterDid)}"><code>${esc(shortDid(submission.submitterDid))}</code></a>
        </dd></div>
        <div><dt>Base</dt><dd>${esc(submission.baseBranch || '-')}</dd></div>
        <div><dt>Head</dt><dd>${esc(submission.headBranch || '-')}</dd></div>
        <div><dt>Created</dt><dd>${shortDate(submission.dateCreated)}</dd></div>
        <div><dt>Source record</dt><dd><code>${esc(submission.recordId)}</code></dd></div>
      </dl>
      ${bodyBlock(submission.body)}
      <div class="commands">
        <code>gitd pr accept ${esc(submission.submitterDid)} ${esc(submission.recordId)}</code>
        <code>gitd pr ignore ${esc(submission.submitterDid)} ${esc(submission.recordId)}</code>
      </div>
    </section>`;
}

function issueDetailPage(repo: IndexedRepo, issue: IndexedIssue): string {
  return `
    <section>
      <p class="crumb">
        <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a> /
        <a href="${repoPath(repo)}/issues">Issues</a>
      </p>
      <h1>${esc(issue.title)}</h1>
      <dl class="facts">
        <div><dt>Status</dt><dd>${status(issue.status)}</dd></div>
        <div><dt>Created</dt><dd>${shortDate(issue.dateCreated)}</dd></div>
        <div><dt>Record</dt><dd><code>${esc(issue.recordId)}</code></dd></div>
      </dl>
      ${bodyBlock(issue.body)}
    </section>`;
}

function patchDetailPage(repo: IndexedRepo, patch: IndexedPatch): string {
  return `
    <section>
      <p class="crumb">
        <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a> /
        <a href="${repoPath(repo)}/patches">Patches</a>
      </p>
      <h1>${esc(patch.title)}</h1>
      <dl class="facts">
        <div><dt>Status</dt><dd>${status(patch.status)}</dd></div>
        <div><dt>Base</dt><dd>${esc(patch.baseBranch || '-')}</dd></div>
        <div><dt>Head</dt><dd>${esc(patch.headBranch || '-')}</dd></div>
        <div><dt>Created</dt><dd>${shortDate(patch.dateCreated)}</dd></div>
        <div><dt>Record</dt><dd><code>${esc(patch.recordId)}</code></dd></div>
      </dl>
      ${bodyBlock(patch.body)}
    </section>`;
}

function releaseDetailPage(repo: IndexedRepo, release: IndexedRelease): string {
  return `
    <section>
      <p class="crumb">
        <a href="/repos">Repositories</a> / <a href="${repoPath(repo)}">${esc(repo.name)}</a> /
        <a href="${repoPath(repo)}/releases">Releases</a>
      </p>
      <h1>${esc(release.name)}</h1>
      <dl class="facts">
        <div><dt>Tag</dt><dd><code>${esc(release.tagName || '-')}</code></dd></div>
        <div><dt>Status</dt><dd>${releaseState(release).map(flag => status(flag)).join(' ')}</dd></div>
        <div><dt>Created</dt><dd>${shortDate(release.dateCreated)}</dd></div>
        <div><dt>Record</dt><dd><code>${esc(release.recordId)}</code></dd></div>
      </dl>
      ${bodyBlock(release.body)}
    </section>`;
}

function usersPage(store: IndexerStore, url: URL): string {
  const q = url.searchParams.get('q')?.trim();
  const users = q
    ? store.searchUsers(q)
    : store.getKnownDids()
      .map(did => profileFromDid(store, did))
      .sort(sortProfiles);

  return `
    <section>
      <div class="page-heading">
        <h1>Users</h1>
        <form action="/users" method="get" class="compact-search">
          <input name="q" type="search" value="${esc(q ?? '')}" placeholder="did:jwk:...">
          <button type="submit">Search</button>
        </form>
      </div>
      ${userList(users)}
    </section>`;
}

function userDetailPage(store: IndexerStore, did: string): string {
  const profile = store.getUserProfile(did);
  const repos = store.getReposForDid(did);
  const starred = store.getStarredReposByUser(did).map(star => star.repo).filter(Boolean) as RepoWithStars[];
  const followers = store.getFollowersForUser(did).map(follow => profileFromDid(store, follow.followerDid));
  const following = store.getFollowingForUser(did).map(follow => profileFromDid(store, follow.targetDid));

  return `
    <section>
      <p class="crumb"><a href="/users">Users</a></p>
      <h1><code>${esc(did)}</code></h1>
      <dl class="facts">
        <div><dt>Repositories</dt><dd>${profile.repoCount}</dd></div>
        <div><dt>Stars</dt><dd>${profile.starCount}</dd></div>
        <div><dt>Followers</dt><dd>${profile.followerCount}</dd></div>
        <div><dt>Following</dt><dd>${profile.followingCount}</dd></div>
      </dl>
    </section>
    <section>
      <h2>Repositories</h2>
      ${repoTable(repos)}
    </section>
    <section>
      <h2>Starred</h2>
      ${repoTable(starred)}
    </section>
    <section>
      <h2>Followers</h2>
      ${userList(followers)}
    </section>
    <section>
      <h2>Following</h2>
      ${userList(following)}
    </section>`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function repoTable(repos: RepoWithStars[]): string {
  if (repos.length === 0) {
    return '<p class="empty">No repositories indexed.</p>';
  }

  const rows = repos.map(repo => `
    <tr>
      <td><a href="${repoPath(repo)}">${esc(repo.name)}</a></td>
      <td><a href="${userPath(repo.did)}">${esc(shortDid(repo.did))}</a></td>
      <td>${esc(repo.language || '-')}</td>
      <td>${repo.starCount}</td>
      <td>${repo.openIssues}</td>
      <td>${repo.openPatches}</td>
    </tr>`).join('');

  return `
    <table>
      <thead><tr><th>Repository</th><th>Owner</th><th>Language</th><th>Stars</th><th>Issues</th><th>Patches</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function userList(users: Array<UserProfile | UserSearchResult>): string {
  if (users.length === 0) {
    return '<p class="empty">No users indexed.</p>';
  }

  const rows = users.map(user => `
    <tr>
      <td><a href="${userPath(user.did)}"><code>${esc(user.did)}</code></a></td>
      <td>${user.repoCount}</td>
      <td>${user.starCount}</td>
      <td>${user.followerCount}</td>
      <td>${user.followingCount}</td>
    </tr>`).join('');

  return `
    <table>
      <thead><tr><th>DID</th><th>Repos</th><th>Stars</th><th>Followers</th><th>Following</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function issueTable(issues: IndexedIssue[], repo?: IndexedRepo): string {
  if (issues.length === 0) {
    return '<p class="empty">No issues indexed.</p>';
  }

  const rows = issues.map(issue => {
    const title = repo ? `<a href="${issuePath(repo, issue)}">${esc(issue.title)}</a>` : esc(issue.title);
    return `
      <tr>
        <td>${status(issue.status)}</td>
        <td>${title}</td>
        <td class="muted">${shortDate(issue.dateCreated)}</td>
      </tr>`;
  }).join('');

  return `
    <table>
      <thead><tr><th>Status</th><th>Issue</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function patchTable(patches: IndexedPatch[], repo?: IndexedRepo): string {
  if (patches.length === 0) {
    return '<p class="empty">No patches indexed.</p>';
  }

  const rows = patches.map(patch => {
    const title = repo ? `<a href="${patchPath(repo, patch)}">${esc(patch.title)}</a>` : esc(patch.title);
    return `
      <tr>
        <td>${status(patch.status)}</td>
        <td>${title}</td>
        <td class="muted">${esc(patch.baseBranch || '-')}</td>
        <td class="muted">${esc(patch.headBranch || '-')}</td>
        <td class="muted">${shortDate(patch.dateCreated)}</td>
      </tr>`;
  }).join('');

  return `
    <table>
      <thead><tr><th>Status</th><th>Patch</th><th>Base</th><th>Head</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function releaseTable(releases: IndexedRelease[], repo?: IndexedRepo): string {
  if (releases.length === 0) {
    return '<p class="empty">No releases indexed.</p>';
  }

  const rows = releases.map(release => {
    const name = repo ? `<a href="${releasePath(repo, release)}">${esc(release.name)}</a>` : esc(release.name);
    return `
      <tr>
        <td>${esc(release.tagName || '-')}</td>
        <td>${name}</td>
        <td>${releaseState(release).map(flag => status(flag)).join(' ')}</td>
        <td class="muted">${shortDate(release.dateCreated)}</td>
      </tr>`;
  }).join('');

  return `
    <table>
      <thead><tr><th>Tag</th><th>Release</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function issueSubmissionTable(submissions: IndexedIssueSubmission[], repo?: IndexedRepo): string {
  if (submissions.length === 0) {
    return '<p class="empty">No external issue submissions indexed.</p>';
  }

  const rows = submissions.map(submission => {
    const title = repo ? `<a href="${issueSubmissionPath(repo, submission)}">${esc(submission.title)}</a>` : esc(submission.title);
    return `
      <tr>
        <td>${status(submission.status)}</td>
        <td>${title}</td>
        <td><a href="${userPath(submission.submitterDid)}"><code>${esc(shortDid(submission.submitterDid))}</code></a></td>
        <td><code>${esc(shortId(submission.recordId))}</code></td>
        <td class="muted">${shortDate(submission.dateCreated)}</td>
      </tr>`;
  }).join('');

  return `
    <table>
      <thead><tr><th>Status</th><th>Issue</th><th>Submitter</th><th>Record</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function patchSubmissionTable(submissions: IndexedPatchSubmission[], repo?: IndexedRepo): string {
  if (submissions.length === 0) {
    return '<p class="empty">No external patch submissions indexed.</p>';
  }

  const rows = submissions.map(submission => {
    const title = repo ? `<a href="${patchSubmissionPath(repo, submission)}">${esc(submission.title)}</a>` : esc(submission.title);
    return `
      <tr>
        <td>${status(submission.status)}</td>
        <td>${title}</td>
        <td><a href="${userPath(submission.submitterDid)}"><code>${esc(shortDid(submission.submitterDid))}</code></a></td>
        <td class="muted">${esc(submission.baseBranch || '-')}</td>
        <td class="muted">${esc(submission.headBranch || '-')}</td>
        <td><code>${esc(shortId(submission.recordId))}</code></td>
        <td class="muted">${shortDate(submission.dateCreated)}</td>
      </tr>`;
  }).join('');

  return `
    <table>
      <thead><tr><th>Status</th><th>Patch</th><th>Submitter</th><th>Base</th><th>Head</th><th>Record</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function topicList(topics: string[]): string {
  return `<p>${topics.map(topic => `<a class="pill" href="/repos?topic=${encodeURIComponent(topic)}">${esc(topic)}</a>`).join(' ')}</p>`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} - gitd indexer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #24292f; background: #f6f8fa; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header { background: #24292f; color: #fff; }
    header .container { display: flex; align-items: center; gap: 18px; min-height: 52px; }
    header a { color: #fff; font-weight: 600; }
    nav a { color: #d0d7de; font-weight: 500; margin-right: 14px; }
    main { padding: 24px 0 40px; }
    .container { max-width: 1120px; margin: 0 auto; padding: 0 16px; }
    section { margin-bottom: 28px; }
    h1, h2 { margin: 0 0 14px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #d0d7de; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
    input { width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font: inherit; }
    button {
      min-height: 38px; padding: 8px 14px; border: 1px solid #1f883d; border-radius: 6px;
      background: #1f883d; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #1a7f37; }
    .toolbar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .toolbar form, .page-heading { background: #fff; border: 1px solid #d0d7de; padding: 16px; }
    .toolbar label { display: block; margin-bottom: 8px; font-weight: 600; }
    .search-row, .compact-search { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .page-heading { display: grid; grid-template-columns: 1fr minmax(280px, 420px); gap: 16px; align-items: center; }
    .facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
    .facts div { background: #fff; border: 1px solid #d0d7de; padding: 12px; }
    .facts dt { color: #57606a; font-size: 0.86em; }
    .facts dd { margin: 4px 0 0; font-weight: 600; overflow-wrap: anywhere; }
    .body { white-space: pre-wrap; background: #fff; border: 1px solid #d0d7de; padding: 16px; }
    .commands { display: grid; gap: 8px; margin-top: 16px; }
    .commands code { display: block; padding: 10px 12px; background: #fff; border: 1px solid #d0d7de; overflow-x: auto; }
    .empty, .crumb, .muted { color: #57606a; }
    .pill { display: inline-block; padding: 3px 8px; margin: 0 4px 6px 0; border-radius: 999px; background: #ddf4ff; color: #0550ae; }
    .status { display: inline-block; padding: 2px 7px; border: 1px solid #d0d7de; border-radius: 999px; font-size: 0.86em; }
    @media (max-width: 760px) {
      .toolbar, .page-heading, .facts { grid-template-columns: 1fr; }
      .search-row, .compact-search { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/">gitd indexer</a>
      <nav>
        <a href="/repos">Repositories</a>
        <a href="/users">Users</a>
        <a href="/api/stats">API</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="container">${body}</div>
  </main>
</body>
</html>`;
}

function notFound(message: string): ExploreResponse {
  return html(404, layout(message, `<section><h1>${esc(message)}</h1><p><a href="/">Explore</a></p></section>`));
}

function html(status: number, body: string): ExploreResponse {
  return { status, body };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profileFromDid(store: IndexerStore, did: string): UserProfile {
  return store.getUserProfile(did);
}

function sortProfiles(a: UserProfile, b: UserProfile): number {
  const activityA = a.repoCount + a.starCount + a.followerCount + a.followingCount;
  const activityB = b.repoCount + b.starCount + b.followerCount + b.followingCount;
  return activityB - activityA || a.did.localeCompare(b.did);
}

function collectionTitle(collection: string): string {
  return collection[0].toUpperCase() + collection.slice(1);
}

function repoPath(repo: { did: string; name: string }): string {
  return `/repos/${repo.did}/${encodeURIComponent(repo.name)}`;
}

function issuePath(repo: IndexedRepo, issue: IndexedIssue): string {
  return `${repoPath(repo)}/issues/${encodeURIComponent(issue.recordId)}`;
}

function patchPath(repo: IndexedRepo, patch: IndexedPatch): string {
  return `${repoPath(repo)}/patches/${encodeURIComponent(patch.recordId)}`;
}

function releasePath(repo: IndexedRepo, release: IndexedRelease): string {
  return `${repoPath(repo)}/releases/${encodeURIComponent(release.recordId)}`;
}

function issueSubmissionPath(repo: IndexedRepo, submission: IndexedIssueSubmission): string {
  return `${repoPath(repo)}/submissions/issues/${encodeURIComponent(submission.recordId)}`;
}

function patchSubmissionPath(repo: IndexedRepo, submission: IndexedPatchSubmission): string {
  return `${repoPath(repo)}/submissions/patches/${encodeURIComponent(submission.recordId)}`;
}

function userPath(did: string): string {
  return `/users/${did}`;
}

function shortId(recordId: string): string {
  return recordId.length > 12 ? `${recordId.slice(0, 12)}...` : recordId;
}

function shortDid(did: string): string {
  const parts = did.split(':');
  const suffix = parts.at(-1) ?? did;
  return `${parts.slice(0, 2).join(':')}:${suffix.slice(0, 12)}`;
}

function shortDate(value: string): string {
  return value ? value.slice(0, 10) : '-';
}

function status(value: string): string {
  return `<span class="status">${esc(value)}</span>`;
}

function releaseState(release: IndexedRelease): string[] {
  const flags = [release.draft ? 'draft' : '', release.prerelease ? 'pre-release' : ''].filter(Boolean);
  return flags.length > 0 ? flags : ['published'];
}

function bodyBlock(body: string): string {
  return body ? `<div class="body">${esc(body)}</div>` : '<p class="empty">No description indexed.</p>';
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
