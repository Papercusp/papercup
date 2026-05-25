/**
 * @vitest-environment jsdom
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
} from '../routePending';

describe('routePending helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.removeAttribute('data-route-pending');
    document.documentElement.removeAttribute('data-route-pending-target');
    finishRoutePending();
  });

  afterEach(() => {
    vi.useRealTimers();
    finishRoutePending();
  });

  it('normalizes trailing slashes while preserving search/hash', () => {
    expect(normalizeRouteHref('/support/?ws=default#faq')).toBe('/support?ws=default#faq');
    expect(normalizeRouteHref('http://localhost:3070/harness/sheets/?tab=files')).toBe('/harness/sheets?tab=files');
  });

  it('classifies harness routes separately from generic routes', () => {
    expect(routePendingTargetFromHref('/harness')).toBe('harness');
    expect(routePendingTargetFromHref('/harness/sheets?ws=default')).toBe('harness');
    expect(routePendingTargetFromHref('/support')).toBe('generic');
  });

  it('extracts hrefs from string and pathname-like props', () => {
    expect(routeHrefFromProp('/support?ws=default')).toBe('/support?ws=default');
    expect(routeHrefFromProp({ pathname: '/settings/operator/' })).toBe('/settings/operator');
    expect(routeHrefFromProp({ pathname: 42 })).toBeNull();
  });

  it('defaults getRoutePendingTarget to null before any route is pending', () => {
    expect(getRoutePendingTarget()).toBeNull();
  });

  it('tracks and clears the current pending route with DOM attributes', () => {
    beginRoutePending('/harness/sheets?ws=default');

    expect(getRoutePendingHref()).toBe('/harness/sheets?ws=default');
    expect(getRoutePendingTarget()).toBe('harness');
    expect(document.documentElement.getAttribute('data-route-pending')).toBe('true');
    expect(document.documentElement.getAttribute('data-route-pending-target')).toBe('harness');

    finishRoutePending();

    expect(getRoutePendingHref()).toBeNull();
    expect(getRoutePendingTarget()).toBeNull();
    expect(document.documentElement.hasAttribute('data-route-pending')).toBe(false);
    expect(document.documentElement.hasAttribute('data-route-pending-target')).toBe(false);
  });

  it('clears pending state after the scheduled timer fires', () => {
    beginRoutePending('/support?ws=default');
    scheduleRoutePendingClear();

    vi.runAllTimers();

    expect(getRoutePendingHref()).toBeNull();
    expect(getRoutePendingTarget()).toBeNull();
  });
  it('notifies subscribers on begin and finish transitions', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRoutePending(listener);

    beginRoutePending('/support?ws=default');
    expect(listener).toHaveBeenCalledTimes(1);

    finishRoutePending();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
