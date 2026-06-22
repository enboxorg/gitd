/**
 * GitHub custom media-type helpers for Markdown body fields.
 *
 * @module
 */

import { renderMarkdownText } from './meta.js';

export type BodyMediaKind = 'raw' | 'text' | 'html' | 'full';

export function renderMarkdownPlainText(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) { return ''; }
      return trimmed
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*-\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1');
    })
    .filter(Boolean)
    .join('\n');
}

export function applyBodyMedia(
  response: Record<string, unknown>, body: string | null, mediaKind?: BodyMediaKind | null,
): Record<string, unknown> {
  const kind = mediaKind ?? 'raw';
  if (kind === 'raw' || kind === 'full') {
    response.body = body;
  }
  if (kind === 'text' || kind === 'full') {
    response.body_text = body === null ? null : renderMarkdownPlainText(body);
  }
  if (kind === 'html' || kind === 'full') {
    response.body_html = body === null ? null : renderMarkdownText(body);
  }
  return response;
}
