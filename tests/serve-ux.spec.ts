import { describe, expect, it } from 'bun:test';

import {
  serveLocalHelperAliasLines,
  serveUsesPublicTransport,
  shouldStartLocalHelperFromServe,
} from '../src/cli/serve-ux.js';

describe('serve UX routing', () => {
  it('treats bare serve as a local helper compatibility alias', () => {
    expect(shouldStartLocalHelperFromServe([], {})).toBe(true);
  });

  it('does not intercept public transport serve invocations', () => {
    expect(serveUsesPublicTransport(['--public-url', 'https://git.example.com'], {})).toBe(true);
    expect(shouldStartLocalHelperFromServe(['--public-url', 'https://git.example.com'], {})).toBe(false);
    expect(shouldStartLocalHelperFromServe([], { GITD_PUBLIC_URL: 'https://git.example.com' })).toBe(false);
  });

  it('lets foreground and background daemon serve paths pass through', () => {
    expect(shouldStartLocalHelperFromServe(['--foreground'], {})).toBe(false);
    expect(shouldStartLocalHelperFromServe([], { GITD_DAEMON_BACKGROUND: '1' })).toBe(false);
  });

  it('does not intercept public URL checks', () => {
    expect(serveUsesPublicTransport(['--check'], {})).toBe(true);
    expect(shouldStartLocalHelperFromServe(['--check'], {})).toBe(false);
  });

  it('prints local helper wording for the compatibility alias', () => {
    const lines = serveLocalHelperAliasLines(true, 9418);
    expect(lines.join('\n')).toContain('compatibility alias');
    expect(lines.join('\n')).toContain('gitd helper start');
    expect(lines.join('\n')).toContain('Local helper started on port 9418.');
  });
});
