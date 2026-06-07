// @vitest-environment node
/**
 * shouldStartDocumentRouteProgressForAnchor — the document-level click
 * predicate that decides whether an intercepted anchor click should start
 * the route-progress affordance.
 *
 * Table-driven: a baseline same-origin navigation passes, then every veto
 * flag flips it false, then the URL-comparison rules (cross-origin, same
 * path+search, hash-only change) are exercised. Pure function — node env.
 */

import { describe, expect, it } from 'vitest';
import { shouldStartDocumentRouteProgressForAnchor } from './route-progress-document';

const BASE = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isElementTarget: true,
  anchorPresent: true,
  download: false,
  targetBlank: false,
  disableProgress: false,
  targetBlocksProgress: false,
  currentHref: 'http://app.local/admin/plans?tab=ready',
  targetHref: 'http://app.local/harness/sheets',
};

describe('shouldStartDocumentRouteProgressForAnchor', () => {
  it('passes for a plain left-click same-origin navigation', () => {
    expect(shouldStartDocumentRouteProgressForAnchor(BASE)).toBe(true);
  });

  it.each([
    ['defaultPrevented', { defaultPrevented: true }],
    ['non-left button', { button: 1 }],
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
    ['non-element target', { isElementTarget: false }],
    ['no anchor', { anchorPresent: false }],
    ['download link', { download: true }],
    ['target=_blank', { targetBlank: true }],
    ['data-disable-progress', { disableProgress: true }],
    ['target blocks progress', { targetBlocksProgress: true }],
  ])('vetoes on %s', (_label, override) => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...BASE, ...override })).toBe(false);
  });

  it('vetoes a cross-origin target', () => {
    expect(
      shouldStartDocumentRouteProgressForAnchor({ ...BASE, targetHref: 'http://other.local/x' }),
    ).toBe(false);
  });

  it('vetoes a same path+search navigation (hash-only change)', () => {
    expect(
      shouldStartDocumentRouteProgressForAnchor({
        ...BASE,
        targetHref: 'http://app.local/admin/plans?tab=ready#section',
      }),
    ).toBe(false);
  });

  it('passes when only the search changes', () => {
    expect(
      shouldStartDocumentRouteProgressForAnchor({
        ...BASE,
        targetHref: 'http://app.local/admin/plans?tab=shipped',
      }),
    ).toBe(true);
  });

  it('resolves a relative target against the current href', () => {
    expect(
      shouldStartDocumentRouteProgressForAnchor({ ...BASE, targetHref: '/harness/sheets' }),
    ).toBe(true);
    expect(
      shouldStartDocumentRouteProgressForAnchor({
        ...BASE,
        targetHref: '/admin/plans?tab=ready',
      }),
    ).toBe(false);
  });
});
