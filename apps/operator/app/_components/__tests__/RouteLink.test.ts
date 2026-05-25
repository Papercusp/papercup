/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { shouldStartRouteProgressForClick } from '../route-link-progress';

describe('RouteLink click progress decision', () => {
  const base = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    download: false,
    targetBlank: false,
    disableProgress: false,
    targetBlocksProgress: false,
    currentHref: 'http://localhost:3070/harness?ws=default',
    targetHref: 'http://localhost:3070/support?ws=default',
  };

  it('starts progress for primary same-origin navigations', () => {
    expect(shouldStartRouteProgressForClick(base)).toBe(true);
  });

  it('does not start progress for modified clicks, downloads, or blocked targets', () => {
    expect(shouldStartRouteProgressForClick({ ...base, metaKey: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, shiftKey: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, altKey: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, button: 1 })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, download: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, targetBlank: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, disableProgress: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, targetBlocksProgress: true })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, defaultPrevented: true })).toBe(false);
  });

  it('does not start progress for same-page or cross-origin navigations', () => {
    expect(shouldStartRouteProgressForClick({ ...base, targetHref: 'http://localhost:3070/harness?ws=default' })).toBe(false);
    expect(shouldStartRouteProgressForClick({ ...base, targetHref: 'https://example.com/docs' })).toBe(false);
  });
});
