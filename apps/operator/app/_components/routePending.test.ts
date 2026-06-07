// @vitest-environment jsdom
/**
 * routePending — the module-level route-pending store behind the app's
 * route-progress affordances (RouteProgressTopBar / link-progress hooks).
 *
 * Covers:
 *  - `normalizeRouteHref`: trailing-slash strip (but '/' survives), search +
 *    hash preserved, absolute URLs reduced to path+search+hash, unparseable
 *    input returned verbatim;
 *  - `routePendingTargetFromHref`: '/harness' + '/harness/*' → 'harness',
 *    everything else (incl. '/harnesses') → 'generic';
 *  - `routeHrefFromProp`: string / {pathname,search,hash} / junk → null;
 *  - begin/finish lifecycle: <html data-route-pending data-route-pending-target>
 *    attributes, getRoutePendingHref/Target, listener notification +
 *    unsubscribe;
 *  - `scheduleRoutePendingClear` min-visible-time semantics: generic routes
 *    clear immediately (0ms floor), harness routes hold for the 360ms floor
 *    measured from beginRoutePending (via a controlled performance.now), and
 *    a second schedule while one is queued is a no-op.
 *
 * Module-level state is reset by finishing the pending route after each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginRoutePending,
  finishRoutePending,
  getRoutePendingHref,
  getRoutePendingTarget,
  normalizeRouteHref,
  routeHrefFromProp,
  routePendingTargetFromHref,
  scheduleRoutePendingClear,
  subscribeRoutePending,
} from './routePending';

let nowValue = 0;

beforeEach(() => {
  vi.useFakeTimers();
  nowValue = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => nowValue);
});

afterEach(() => {
  finishRoutePending();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('normalizeRouteHref', () => {
  it('strips trailing slashes from non-root paths', () => {
    expect(normalizeRouteHref('/a/b/')).toBe('/a/b');
    expect(normalizeRouteHref('/a/b///')).toBe('/a/b');
  });

  it('keeps the bare root path', () => {
    expect(normalizeRouteHref('/')).toBe('/');
  });

  it('preserves search and hash', () => {
    expect(normalizeRouteHref('/plans/?tab=ready#top')).toBe('/plans?tab=ready#top');
  });

  it('reduces an absolute URL to path+search+hash', () => {
    expect(normalizeRouteHref('http://example.com/x/y?q=1#h')).toBe('/x/y?q=1#h');
  });

  it('returns unparseable input verbatim', () => {
    expect(normalizeRouteHref('http://[')).toBe('http://[');
  });
});

describe('routePendingTargetFromHref', () => {
  it.each([
    ['/harness', 'harness'],
    ['/harness/', 'harness'],
    ['/harness/sheets', 'harness'],
    ['/harness/sheets?tab=tests', 'harness'],
    ['/harnesses', 'generic'],
    ['/admin/plans', 'generic'],
    ['/', 'generic'],
  ])('%s → %s', (href, expected) => {
    expect(routePendingTargetFromHref(href)).toBe(expected);
  });
});

describe('routeHrefFromProp', () => {
  it('normalizes a string href', () => {
    expect(routeHrefFromProp('/a/b/')).toBe('/a/b');
  });

  it('assembles pathname + search + hash from an object href', () => {
    expect(routeHrefFromProp({ pathname: '/a', search: '?q=1', hash: '#h' })).toBe('/a?q=1#h');
  });

  it('tolerates a pathname-only object', () => {
    expect(routeHrefFromProp({ pathname: '/only' })).toBe('/only');
  });

  it('returns null for non-href values', () => {
    expect(routeHrefFromProp(null)).toBeNull();
    expect(routeHrefFromProp(42)).toBeNull();
    expect(routeHrefFromProp({ search: '?q' })).toBeNull();
  });
});

describe('begin/finish lifecycle', () => {
  it('beginRoutePending sets the html attributes + the normalized href', () => {
    beginRoutePending('/harness/sheets/');
    expect(getRoutePendingHref()).toBe('/harness/sheets');
    expect(getRoutePendingTarget()).toBe('harness');
    expect(document.documentElement.getAttribute('data-route-pending')).toBe('true');
    expect(document.documentElement.getAttribute('data-route-pending-target')).toBe('harness');
  });

  it('finishRoutePending clears state + attributes', () => {
    beginRoutePending('/admin');
    finishRoutePending();
    expect(getRoutePendingHref()).toBeNull();
    expect(getRoutePendingTarget()).toBeNull();
    expect(document.documentElement.hasAttribute('data-route-pending')).toBe(false);
    expect(document.documentElement.hasAttribute('data-route-pending-target')).toBe(false);
  });

  it('notifies subscribers on begin and finish; unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRoutePending(listener);
    beginRoutePending('/admin');
    expect(listener).toHaveBeenCalledTimes(1);
    finishRoutePending();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    beginRoutePending('/admin');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleRoutePendingClear — min-visible floors', () => {
  it('clears a generic route immediately (0ms floor)', () => {
    beginRoutePending('/admin');
    scheduleRoutePendingClear();
    expect(getRoutePendingHref()).toBe('/admin');
    vi.advanceTimersByTime(0);
    expect(getRoutePendingHref()).toBeNull();
  });

  it('holds a harness route until 360ms have elapsed since begin', () => {
    nowValue = 1000;
    beginRoutePending('/harness/sheets');
    nowValue = 1100; // 100ms elapsed → 260ms remaining
    scheduleRoutePendingClear();
    vi.advanceTimersByTime(259);
    expect(getRoutePendingHref()).toBe('/harness/sheets');
    vi.advanceTimersByTime(1);
    expect(getRoutePendingHref()).toBeNull();
  });

  it('clears immediately when the harness floor has already elapsed', () => {
    nowValue = 0;
    beginRoutePending('/harness/sheets');
    nowValue = 5000;
    scheduleRoutePendingClear();
    vi.advanceTimersByTime(0);
    expect(getRoutePendingHref()).toBeNull();
  });

  it('is a no-op without a pending route', () => {
    expect(() => scheduleRoutePendingClear()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not stack a second timer while one is queued', () => {
    nowValue = 0;
    beginRoutePending('/harness/sheets');
    scheduleRoutePendingClear();
    scheduleRoutePendingClear();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('beginRoutePending cancels a queued clear (rapid renavigation)', () => {
    nowValue = 0;
    beginRoutePending('/harness/a');
    scheduleRoutePendingClear();
    beginRoutePending('/harness/b');
    vi.advanceTimersByTime(10_000);
    // the old timer was cancelled; the new pending route survives
    expect(getRoutePendingHref()).toBe('/harness/b');
  });
});
