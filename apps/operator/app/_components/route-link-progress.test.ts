// @vitest-environment node
/**
 * shouldStartRouteProgressForClick — the <Link>-level click predicate
 * (route-link-progress). Same veto table as the document-level anchor
 * predicate minus the anchor-discovery flags (isElementTarget /
 * anchorPresent), which the Link wrapper guarantees by construction.
 * Pure function — node env.
 */

import { describe, expect, it } from 'vitest';
import { shouldStartRouteProgressForClick } from './route-link-progress';

const BASE = {
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
  currentHref: 'http://app.local/admin/plans?tab=ready',
  targetHref: 'http://app.local/harness/sheets',
};

describe('shouldStartRouteProgressForClick', () => {
  it('passes for a plain left-click same-origin navigation', () => {
    expect(shouldStartRouteProgressForClick(BASE)).toBe(true);
  });

  it.each([
    ['defaultPrevented', { defaultPrevented: true }],
    ['non-left button', { button: 2 }],
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
    ['download link', { download: true }],
    ['target=_blank', { targetBlank: true }],
    ['data-disable-progress', { disableProgress: true }],
    ['target blocks progress', { targetBlocksProgress: true }],
  ])('vetoes on %s', (_label, override) => {
    expect(shouldStartRouteProgressForClick({ ...BASE, ...override })).toBe(false);
  });

  it('vetoes a cross-origin target', () => {
    expect(shouldStartRouteProgressForClick({ ...BASE, targetHref: 'https://app.local/x' })).toBe(
      false,
    ); // protocol differs → different origin
  });

  it('vetoes a same path+search navigation (hash-only change)', () => {
    expect(
      shouldStartRouteProgressForClick({
        ...BASE,
        targetHref: 'http://app.local/admin/plans?tab=ready#anchor',
      }),
    ).toBe(false);
  });

  it('passes when only the search changes', () => {
    expect(
      shouldStartRouteProgressForClick({
        ...BASE,
        targetHref: 'http://app.local/admin/plans?tab=done',
      }),
    ).toBe(true);
  });
});
