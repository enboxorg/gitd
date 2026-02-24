/**
 * Route handlers for the read-only web UI.
 *
 * Each handler queries DWN records via the AgentContext and returns
 * an HTML string.  The server module maps URL paths to these handlers.
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

async function getRepoRecord(ctx: AgentContext): Promise<RepoInfo | null> {
  const { records } = await ctx.repo.records.query('repo');
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

function repoName(repo: { name: string } | null): string {
  return repo?.name ?? 'dwn-git';
}

// ---------------------------------------------------------------------------
// GET / — repo overview
// ---------------------------------------------------------------------------

export async function overviewPage(ctx: AgentContext): Promise<string> {
  const repo = await getRepoRecord(ctx);

  if (!repo) {
    return layout('Overview', 'dwn-git', '<div class="card"><p class="empty">No repository found. Run <code>dwn-git init</code> to create one.</p></div>');
  }

  // Count issues.
  const { records: issues } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId },
  });
  const openIssues = issues.filter((r) => (r.tags as Record<string, string> | undefined)?.status === 'open').length;

  // Count patches.
  const { records: patches } = await ctx.patches.records.query('repo/patch', {
    filter: { contextId: repo.contextId },
  });
  const openPatches = patches.filter((r) => (r.tags as Record<string, string> | undefined)?.status === 'open').length;

  // Count releases.
  const { records: releases } = await ctx.releases.records.query('repo/release' as any, {
    filter: { contextId: repo.contextId },
  });

  const html = `
    <div class="card">
      <h2>${esc(repo.name)}</h2>
      ${repo.description ? `<p>${esc(repo.description)}</p>` : ''}
      <p class="meta">
        Default branch: <strong>${esc(repo.defaultBranch)}</strong>
        &middot; Visibility: <strong>${esc(repo.visibility)}</strong>
        &middot; DID: <code>${esc(ctx.did)}</code>
      </p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
      <div class="card">
        <h3><a href="/issues">Issues</a></h3>
        <p style="font-size:2em;margin:0">${issues.length}</p>
        <p class="meta">${openIssues} open</p>
      </div>
      <div class="card">
        <h3><a href="/patches">Patches</a></h3>
        <p style="font-size:2em;margin:0">${patches.length}</p>
        <p class="meta">${openPatches} open</p>
      </div>
      <div class="card">
        <h3><a href="/releases">Releases</a></h3>
        <p style="font-size:2em;margin:0">${releases.length}</p>
      </div>
    </div>`;

  return layout('Overview', repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /issues — issues list
// ---------------------------------------------------------------------------

export async function issuesListPage(ctx: AgentContext): Promise<string> {
  const repo = await getRepoRecord(ctx);
  if (!repo) { return layout('Issues', 'dwn-git', '<p class="empty">No repository found.</p>'); }

  const { records } = await ctx.issues.records.query('repo/issue', {
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Issues', repoName(repo), '<div class="card"><p class="empty">No issues yet.</p></div>');
  }

  let rows = '';
  for (const rec of records) {
    const data = await rec.data.json();
    const tags = rec.tags as Record<string, string> | undefined;
    const num = data.number ?? tags?.number ?? '?';
    const status = tags?.status ?? 'open';
    rows += `<tr>
      <td><a href="/issues/${esc(String(num))}">#${esc(String(num))}</a></td>
      <td><a href="/issues/${esc(String(num))}">${esc(data.title)}</a></td>
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

  return layout('Issues', repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /issues/:number — issue detail
// ---------------------------------------------------------------------------

export async function issueDetailPage(ctx: AgentContext, number: string): Promise<string | null> {
  const repo = await getRepoRecord(ctx);
  if (!repo) { return null; }

  const { records } = await ctx.issues.records.query('repo/issue', {
    filter: { contextId: repo.contextId, tags: { number } },
  });

  if (records.length === 0) { return null; }

  const rec = records[0];
  const data = await rec.data.json();
  const tags = rec.tags as Record<string, string> | undefined;
  const status = tags?.status ?? 'open';

  // Fetch comments.
  const { records: comments } = await ctx.issues.records.query('repo/issue/comment' as any, {
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
    <p><a href="/issues">&larr; Back to issues</a></p>`;

  return layout(`Issue #${number}`, repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /patches — patches list
// ---------------------------------------------------------------------------

export async function patchesListPage(ctx: AgentContext): Promise<string> {
  const repo = await getRepoRecord(ctx);
  if (!repo) { return layout('Patches', 'dwn-git', '<p class="empty">No repository found.</p>'); }

  const { records } = await ctx.patches.records.query('repo/patch', {
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Patches', repoName(repo), '<div class="card"><p class="empty">No patches yet.</p></div>');
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
      <td><a href="/patches/${esc(String(num))}">#${esc(String(num))}</a></td>
      <td><a href="/patches/${esc(String(num))}">${esc(data.title)}</a></td>
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

  return layout('Patches', repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /patches/:number — patch detail
// ---------------------------------------------------------------------------

export async function patchDetailPage(ctx: AgentContext, number: string): Promise<string | null> {
  const repo = await getRepoRecord(ctx);
  if (!repo) { return null; }

  const { records } = await ctx.patches.records.query('repo/patch', {
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
    <p><a href="/patches">&larr; Back to patches</a></p>`;

  return layout(`Patch #${number}`, repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /releases — releases list
// ---------------------------------------------------------------------------

export async function releasesListPage(ctx: AgentContext): Promise<string> {
  const repo = await getRepoRecord(ctx);
  if (!repo) { return layout('Releases', 'dwn-git', '<p class="empty">No repository found.</p>'); }

  const { records } = await ctx.releases.records.query('repo/release' as any, {
    filter   : { contextId: repo.contextId },
    dateSort : DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Releases', repoName(repo), '<div class="card"><p class="empty">No releases yet.</p></div>');
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
  return layout('Releases', repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /wiki — wiki list
// ---------------------------------------------------------------------------

export async function wikiListPage(ctx: AgentContext): Promise<string> {
  const repo = await getRepoRecord(ctx);

  const { records } = await ctx.wiki.records.query('repo/page' as any, {
    dateSort: DateSort.CreatedDescending,
  });

  if (records.length === 0) {
    return layout('Wiki', repoName(repo), '<div class="card"><p class="empty">No wiki pages yet.</p></div>');
  }

  let rows = '';
  for (const rec of records) {
    const tags = rec.tags as Record<string, string> | undefined;
    const slug = tags?.slug ?? '';
    const title = tags?.title ?? slug;
    rows += `<tr>
      <td><a href="/wiki/${esc(slug)}">${esc(title)}</a></td>
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

  return layout('Wiki', repoName(repo), html);
}

// ---------------------------------------------------------------------------
// GET /wiki/:slug — wiki page detail
// ---------------------------------------------------------------------------

export async function wikiDetailPage(ctx: AgentContext, slug: string): Promise<string | null> {
  const repo = await getRepoRecord(ctx);

  const { records } = await ctx.wiki.records.query('repo/page' as any, {
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
    <p><a href="/wiki">&larr; Back to wiki</a></p>`;

  return layout(title, repoName(repo), html);
}
