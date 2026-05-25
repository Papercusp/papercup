/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { getRoutePendingTarget, normalizeRouteHref, routeHrefFromProp, routePendingTargetFromHref } from '../routePending';

describe('routePending helpers', () => {
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
});
