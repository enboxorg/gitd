/**
 * Route handlers for the read-only web UI.
 *
 * Each handler queries DWN records via the AgentContext, targeting either
 * the local DWN or a remote DWN identified by `targetDid`.  When
 * `targetDid` differs from `ctx.did`, the `from` parameter is passed to
 * every query so the request is forwarded to the remote DWN endpoint
 * resolved from the target's DID document.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';

import { DateSort } from '@enbox/dwn-sdk-js';

import { esc, layout, renderBody, shortDate, statusBadge } from './html.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RepoInfo = {
  name: string; description: string; defaultBranch: string;
  contextId: string; visibility: string;
};

/**
 * Build the `from` option for a query.  When the target is the local
 * agent's own DID we omit `from` (local query); otherwise we set it so
 * the SDK routes the message to the remote DWN.
 */
function fromOpt(ctx: AgentContext, targetDid: string): string | undefined {
  return targetDid === ctx.did ? undefined : targetDid;
}

async function getRepoRecord(
  ctx: AgentContext, targetDid: string, repoName: string,
): Promise<RepoInfo | null> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', {
    from,
    filter: { tags: { name: repoName } },
  });
  if (records.length === 0) { return null; }
  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, string> | undefined;
  return {
    name          : data.name ?? 'unnamed',
    description   : data.description ?? '',
    defaultBranch : data.defaultBranch ?? 'main',
    contextId     : rec.contextId ?? '',
    visibility    : tags?.visibility ?? 'public',
  };
}

/** List all repos for a DID. */
export async function repoListPage(ctx: AgentContext, targetDid: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const { records } = await ctx.repo.records.query('repo', { from });

  if (records.length === 0) {
    return layout('Repositories', 'gitd',
      '<div class="card"><p class="empty">No repositories found for this DID.</p></div>', basePath);
  }

  let rows = '';
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const vis = tags?.visibility ?? 'public';
    const name = data.name ?? 'unnamed';
    rows += `<tr>
      <td><a href="${basePath}/${esc(name)}">${esc(name)}</a></td>
      <td>${esc(data.description ?? '')}</td>
      <td class="meta">${esc(vis)}</td>
      <td class="meta">${esc(data.defaultBranch ?? 'main')}</td>
    </tr>`;
  }

  const html = `
    <div class="card">
      <h2>Repositories (${records.length})</h2>
      <table>
        <tr><th>Name</th><th>Description</th><th>Visibility</th><th>Branch</th></tr>
        ${rows}
      </table>
    </div>`;

  return layout('Repositories', 'gitd', html, basePath);
}

function repoTitle(repo: { name: string } | null): string {
  return repo?.name ?? 'gitd';
}

// ---------------------------------------------------------------------------
// GET /:did — repo overview
// ---------------------------------------------------------------------------

export async function overviewPage(ctx: AgentContext, targetDid: string, repoName: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);

  if (!repo) {
    return layout('Overview', 'gitd', '<div class="card"><p class="empty">No repository found for this DID.</p></div>', basePath);
  }

  // Count issues.
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId },
  });
  const openIssues = issues.filter(
    (r) => (r.tags as Record<string, string> | undefined)?.status === 'open',
  ).length;

  // Count patches.
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId },
  });
  const openPatches = patches.filter(
    (r) => (r.tags as Record<string, string> | undefined)?.status === 'open',
  ).length;

  // Count releases.
  const { records: releases } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter: { contextId: repo.contextId },
  });

  const html = `
    <div class="card">
      <h2>${esc(repo.name)}</h2>
      ${repo.description ? `<p>${esc(repo.description)}</p>` : ''}
      <p class="meta">
        Default branch: <strong>${esc(repo.defaultBranch)}</strong>
        &middot; Visibility: <strong>${esc(repo.visibility)}</strong>
        &middot; DID: <code>${esc(targetDid)}</code>
      </p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
      <div class="card">
        <h3><a href="${basePath}/issues">Issues</a></h3>
        <p style="font-size:2em;margin:0">${issues.length}</p>
        <p class="meta">${openIssues} open</p>
      </div>
      <div class="card">
        <h3><a href="${basePath}/patches">Patches</a></h3>
        <p style="font-size:2em;margin:0">${patches.length}</p>
        <p class="meta">${openPatches} open</p>
      </div>
      <div class="card">
        <h3><a href="${basePath}/releases">Releases</a></h3>
        <p style="font-size:2em;margin:0">${releases.length}</p>
      </div>
    </div>`;

  return layout('Overview', repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/issues — issues list
// ---------------------------------------------------------------------------

export async function issuesListPage(ctx: AgentContext, targetDid: string, repoName: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return layout('Issues', 'gitd', '<p class="empty">No repository found.</p>', basePath); }

  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Issues', repoTitle(repo), '<div class="card"><p class="empty">No issues yet.</p></div>', basePath);
  }

  let rows = '';
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const num = data.number ?? tags?.number ?? '?';
    const status = tags?.status ?? 'open';
    rows += `<tr>
      <td><a href="${basePath}/issues/${esc(String(num))}">#${esc(String(num))}</a></td>
      <td><a href="${basePath}/issues/${esc(String(num))}">${esc(data.title)}</a></td>
      <td>${statusBadge(status)}</td>
      <td class="meta">${shortDate(rec.dateCreated)}</td>
    </tr>`;
  }

  const html = `
    <div class="card">
      <h2>Issues (${records.length})</h2>
      <table>
        <tr><th>#</th><th>Title</th><th>Status</th><th>Created</th></tr>
        ${rows}
      </table>
    </div>`;

  return layout('Issues', repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/issues/:number — issue detail
// ---------------------------------------------------------------------------

export async function issueDetailPage(
  ctx: AgentContext, targetDid: string, repoName: string, basePath: string, number: string,
): Promise<string | null> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return null; }

  const { records } = await ctx.issues.records.query('repo/issue', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, string> | undefined;
  const status = tags?.status ?? 'open';

  // Fetch comments.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
    from,
    filter   : { contextId: rec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  let commentsHtml = '';
  for (const comment of comments) {
    const cData = await comment.data.json();
    commentsHtml += `<div class="comment">
      <p class="meta">${shortDate(comment.dateCreated)}</p>
      <p>${renderBody(cData.body ?? '')}</p>
    </div>`;
  }

  const html = `
    <div class="card">
      <h2>Issue #${esc(number)}: ${esc(data.title)} ${statusBadge(status)}</h2>
      <p class="meta">Created ${shortDate(rec.dateCreated)}</p>
      ${data.body ? `<div style="margin-top:16px">${renderBody(data.body)}</div>` : ''}
    </div>
    ${comments.length > 0 ? `
      <div class="card">
        <h3>Comments (${comments.length})</h3>
        ${commentsHtml}
      </div>
    ` : ''}
    <p><a href="${basePath}/issues">&larr; Back to issues</a></p>`;

  return layout(`Issue #${number}`, repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/patches — patches list
// ---------------------------------------------------------------------------

export async function patchesListPage(ctx: AgentContext, targetDid: string, repoName: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return layout('Patches', 'gitd', '<p class="empty">No repository found.</p>', basePath); }

  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Patches', repoTitle(repo), '<div class="card"><p class="empty">No patches yet.</p></div>', basePath);
  }

  let rows = '';
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const num = data.number ?? tags?.number ?? '?';
    const status = tags?.status ?? 'open';
    const base = tags?.baseBranch ?? '';
    const head = tags?.headBranch ?? '';
    rows += `<tr>
      <td><a href="${basePath}/patches/${esc(String(num))}">#${esc(String(num))}</a></td>
      <td><a href="${basePath}/patches/${esc(String(num))}">${esc(data.title)}</a></td>
      <td>${statusBadge(status)}</td>
      <td class="meta">${esc(base)}${head ? ` &larr; ${esc(head)}` : ''}</td>
      <td class="meta">${shortDate(rec.dateCreated)}</td>
    </tr>`;
  }

  const html = `
    <div class="card">
      <h2>Patches (${records.length})</h2>
      <table>
        <tr><th>#</th><th>Title</th><th>Status</th><th>Branches</th><th>Created</th></tr>
        ${rows}
      </table>
    </div>`;

  return layout('Patches', repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/patches/:number — patch detail
// ---------------------------------------------------------------------------

export async function patchDetailPage(
  ctx: AgentContext, targetDid: string, repoName: string, basePath: string, number: string,
): Promise<string | null> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return null; }

  const { records } = await ctx.patches.records.query('repo/patch', {
    from,
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, string> | undefined;
  const status = tags?.status ?? 'open';
  const base = tags?.baseBranch ?? '';
  const head = tags?.headBranch ?? '';

  // Fetch reviews.
  const { records: reviews } = await ctx.patches.records.query('repo/patch/review' as any, {
    from,
    filter   : { contextId: rec.contextId },
    dateSort : DateSort.CreatedAscending,
  });

  let reviewsHtml = '';
  for (const review of reviews) {
    const rData = await review.data.json();
    const rTags = review.tags as Record<string, string> | undefined;
    const verdict = rTags?.verdict ?? 'comment';
    reviewsHtml += `<div class="comment">
      <p class="meta">${statusBadge(verdict)} ${shortDate(review.dateCreated)}</p>
      ${rData.body ? `<p>${renderBody(rData.body)}</p>` : ''}
    </div>`;
  }

  const html = `
    <div class="card">
      <h2>Patch #${esc(number)}: ${esc(data.title)} ${statusBadge(status)}</h2>
      <p class="meta">
        ${esc(base)}${head ? ` &larr; ${esc(head)}` : ''}
        &middot; Created ${shortDate(rec.dateCreated)}
      </p>
      ${data.body ? `<div style="margin-top:16px">${renderBody(data.body)}</div>` : ''}
    </div>
    ${reviews.length > 0 ? `
      <div class="card">
        <h3>Reviews (${reviews.length})</h3>
        ${reviewsHtml}
      </div>
    ` : ''}
    <p><a href="${basePath}/patches">&larr; Back to patches</a></p>`;

  return layout(`Patch #${number}`, repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/releases — releases list
// ---------------------------------------------------------------------------

export async function releasesListPage(ctx: AgentContext, targetDid: string, repoName: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);
  if (!repo) { return layout('Releases', 'gitd', '<p class="empty">No repository found.</p>', basePath); }

  const { records } = await ctx.releases.records.query('repo/release' as any, {
    from,
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Releases', repoTitle(repo), '<div class="card"><p class="empty">No releases yet.</p></div>', basePath);
  }

  let cards = '';
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, unknown> | undefined;
    const tagName = tags?.tagName as string ?? '';
    const prerelease = tags?.prerelease === true;
    const draft = tags?.draft === true;

    const flags: string[] = [];
    if (prerelease) { flags.push(statusBadge('pre-release')); }
    if (draft) { flags.push(statusBadge('draft')); }

    cards += `<div class="card">
      <h3>${esc(tagName)} ${data.name && data.name !== tagName ? `&mdash; ${esc(data.name)}` : ''} ${flags.join(' ')}</h3>
      <p class="meta">${shortDate(rec.dateCreated)}</p>
      ${data.body ? `<p>${renderBody(data.body)}</p>` : ''}
    </div>`;
  }

  const html = `<h2>Releases (${records.length})</h2>${cards}`;
  return layout('Releases', repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/wiki — wiki list
// ---------------------------------------------------------------------------

export async function wikiListPage(ctx: AgentContext, targetDid: string, repoName: string, basePath: string): Promise<string> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);

  const { records } = await ctx.wiki.records.query('repo/page' as any, {
    from,
    dateSort: DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Wiki', repoTitle(repo), '<div class="card"><p class="empty">No wiki pages yet.</p></div>', basePath);
  }

  let rows = '';
  for (const rec of records) {
    const tags = rec.tags as Record<string, string> | undefined;
    const slug = tags?.slug ?? '';
    const title = tags?.title ?? slug;
    rows += `<tr>
      <td><a href="${basePath}/wiki/${esc(slug)}">${esc(title)}</a></td>
      <td class="meta">${shortDate(rec.dateCreated)}</td>
    </tr>`;
  }

  const html = `
    <div class="card">
      <h2>Wiki (${records.length})</h2>
      <table>
        <tr><th>Page</th><th>Created</th></tr>
        ${rows}
      </table>
    </div>`;

  return layout('Wiki', repoTitle(repo), html, basePath);
}

// ---------------------------------------------------------------------------
// GET /:did/wiki/:slug — wiki page detail
// ---------------------------------------------------------------------------

export async function wikiDetailPage(
  ctx: AgentContext, targetDid: string, repoName: string, basePath: string, slug: string,
): Promise<string | null> {
  const from = fromOpt(ctx, targetDid);
  const repo = await getRepoRecord(ctx, targetDid, repoName);

  const { records } = await ctx.wiki.records.query('repo/page' as any, {
    from,
    filter: { tags: { slug } },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const tags = rec.tags as Record<string, string> | undefined;
  const title = tags?.title ?? slug;
  const blob = await rec.data.blob();
  const body = await blob.text();

  const html = `
    <div class="card">
      <h2>${esc(title)}</h2>
      <p class="meta">Last updated: ${shortDate(rec.dateCreated)}</p>
      <div class="wiki-body" style="margin-top:16px">${renderBody(body)}</div>
    </div>
    <p><a href="${basePath}/wiki">&larr; Back to wiki</a></p>`;

  return layout(title, repoTitle(repo), html, basePath);
}
