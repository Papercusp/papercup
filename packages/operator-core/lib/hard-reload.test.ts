// @vitest-environment jsdom
//
// hard-reload.test.ts — the chunk-load / stale-bundle recovery reload that must
// survive the desktop host's reload suppression. Contract: prefer the host's
// stashed genuine reload (window.__papercuspOriginalReload); if it's absent or
// throws, fall back to a cache-busted href navigation (`?_r=<ts>`) which the host
// does NOT override. A regression here means "pick up the new build" silently
// no-ops (users stuck on a broken bundle). window.location is faked so no real
// jsdom navigation fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardReload } from './hard-reload';

type FakeLoc = { href: string; reload: ReturnType<typeof vi.fn> };
let loc: FakeLoc;
const w = window as unknown as { __papercuspOriginalReload?: () => void };

beforeEach(() => {
  loc = { href: 'http://app.local/page', reload: vi.fn() };
  Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true });
  delete w.__papercuspOriginalReload;
});
afterEach(() => {
  delete w.__papercuspOriginalReload;
});

describe('hardReload', () => {
  it('prefers the host-stashed genuine reload and does not navigate', () => {
    const orig = vi.fn();
    w.__papercuspOriginalReload = orig;
    hardReload();
    expect(orig).toHaveBeenCalledTimes(1);
    expect(loc.href).toBe('http://app.local/page'); // untouched — escape hatch won
    expect(loc.reload).not.toHaveBeenCalled();
  });

  it('falls back to a cache-busted href navigation when no escape hatch is stashed', () => {
    hardReload();
    expect(loc.href).toContain('_r=');
    expect(new URL(loc.href).searchParams.get('_r')).toBeTruthy();
  });

  it('falls through to the href fallback when the stashed reload throws', () => {
    w.__papercuspOriginalReload = () => {
      throw new Error('suppressed');
    };
    hardReload();
    expect(loc.href).toContain('_r=');
  });
});
