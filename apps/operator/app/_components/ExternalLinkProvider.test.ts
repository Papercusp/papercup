import { describe, it, expect } from 'vitest';
import { isExternalWebUrl } from './ExternalLinkProvider';

/**
 * isExternalWebUrl decides whether a clicked link must be handed to the OS
 * browser (true) rather than navigating the Tauri webview away from the SPA.
 * External http(s) to a non-local host on a different origin → true; everything
 * else → false. Pure, so it unit-tests without a DOM or Tauri.
 */
const APP = 'http://localhost:3055/adv?tab=insights';

describe('isExternalWebUrl', () => {
  it('true for an external https host (a GitHub PR link — the reported case)', () => {
    expect(isExternalWebUrl('https://github.com/papercupai/x/pull/12', APP)).toBe(true);
    expect(isExternalWebUrl('https://discord.gg/abc', APP)).toBe(true);
  });

  it('false for a same-origin link', () => {
    expect(isExternalWebUrl('http://localhost:3055/users/github/42', APP)).toBe(false);
    expect(isExternalWebUrl('http://localhost:3055/adv', APP)).toBe(false);
  });

  it('false for another LOCAL host/port (internal cross-port nav must not shell out)', () => {
    expect(isExternalWebUrl('http://127.0.0.1:3070/api/harness/x', APP)).toBe(false);
    expect(isExternalWebUrl('http://localhost:3170/admin', APP)).toBe(false);
  });

  it('false for non-http(s) schemes (mailto:, the papercusp:// custom scheme)', () => {
    expect(isExternalWebUrl('mailto:x@y.com', APP)).toBe(false);
    expect(isExternalWebUrl('papercusp://localhost/foo', APP)).toBe(false);
  });

  it('false for an unparseable href', () => {
    expect(isExternalWebUrl('::::', APP)).toBe(false);
    expect(isExternalWebUrl('', APP)).toBe(false);
  });

  it('works when the app itself is served from the papercusp:// origin', () => {
    const tauriApp = 'papercusp://localhost/adv';
    // external site is still external from the custom-scheme origin
    expect(isExternalWebUrl('https://github.com/a/b', tauriApp)).toBe(true);
  });
});
