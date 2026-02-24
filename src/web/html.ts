/**
 * HTML template helpers for the read-only web UI.
 *
 * Server-rendered HTML with minimal inline CSS — no frontend framework,
 * no build step, no client-side JavaScript.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Wrap page content in a full HTML document with navigation.
 *
 * @param basePath - URL prefix for all nav links, e.g. `/did:dht:abc123`
 */
export function layout(title: string, repoName: string, body: string, basePath: string = ''): string {
  const base = basePath || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — ${esc(repoName)} — dwn-git</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6; color: #24292f; margin: 0; padding: 0; background: #f6f8fa; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 960px; margin: 0 auto; padding: 0 16px; }
    header { background: #24292f; color: #fff; padding: 12px 0; }
    header a { color: #fff; font-weight: 600; }
    header .repo-name { font-size: 1.2em; }
    nav { background: #fff; border-bottom: 1px solid #d0d7de; padding: 8px 0; }
    nav a { margin-right: 16px; padding: 4px 8px; border-radius: 6px; color: #24292f; }
    nav a:hover { background: #f3f4f6; text-decoration: none; }
    nav a.active { font-weight: 600; border-bottom: 2px solid #fd8c73; }
    main { padding: 24px 0; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
    .card h2 { margin-top: 0; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.85em; font-weight: 600; }
    .badge-open { background: #dafbe1; color: #116329; }
    .badge-closed { background: #ffd8d3; color: #82071e; }
    .badge-merged { background: #ddf4ff; color: #0550ae; }
    .badge-draft { background: #f6f8fa; color: #57606a; }
    .meta { color: #57606a; font-size: 0.9em; }
    .comment { border-left: 3px solid #d0d7de; padding-left: 12px; margin: 12px 0; }
    .empty { color: #57606a; font-style: italic; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 8px 12px; text-align: left; border-bottom: 1px solid #d0d7de; }
    th { font-weight: 600; background: #f6f8fa; }
    pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
    .wiki-body { line-height: 1.8; }
    .did-input { width: 100%; padding: 10px 14px; font-size: 1em; border: 1px solid #d0d7de;
      border-radius: 6px; font-family: monospace; }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="${base || '/'}" class="repo-name">${esc(repoName)}</a>
      <span style="color:#8b949e;margin-left:8px">dwn-git</span>
    </div>
  </header>
  <nav>
    <div class="container">
      <a href="${base}/">Overview</a>
      <a href="${base}/issues">Issues</a>
      <a href="${base}/patches">Patches</a>
      <a href="${base}/releases">Releases</a>
      <a href="${base}/wiki">Wiki</a>
    </div>
  </nav>
  <main>
    <div class="container">
      ${body}
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML special characters. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a status string as a colored badge. */
export function statusBadge(status: string): string {
  const lower = status.toLowerCase();
  let cls = 'badge';
  if (lower === 'open') { cls += ' badge-open'; }
  else if (lower === 'closed') { cls += ' badge-closed'; }
  else if (lower === 'merged') { cls += ' badge-merged'; }
  else if (lower === 'draft') { cls += ' badge-draft'; }
  return `<span class="${cls}">${esc(status.toUpperCase())}</span>`;
}

/** Format an ISO date string to a short date. */
export function shortDate(iso: string | undefined): string {
  return iso?.slice(0, 10) ?? '';
}

/** Simple markdown-like rendering: newlines to <br>, backticks to <code>. */
export function renderBody(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
