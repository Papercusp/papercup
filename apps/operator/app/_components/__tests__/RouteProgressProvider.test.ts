/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { shouldStartDocumentRouteProgressForAnchor } from '../route-progress-document';

describe('RouteProgressProvider document capture helper', () => {
  const base = {
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
    currentHref: 'http://localhost:3070/harness?ws=default',
    targetHref: 'http://localhost:3070/support?ws=default',
  };

  it('starts progress for primary same-origin document anchor clicks', () => {
    expect(shouldStartDocumentRouteProgressForAnchor(base)).toBe(true);
  });

  it('does not start progress for modified, non-anchor, or blocked clicks', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, metaKey: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, shiftKey: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, altKey: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, button: 1 })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, isElementTarget: false })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, anchorPresent: false })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, download: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetBlank: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, disableProgress: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetBlocksProgress: true })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, defaultPrevented: true })).toBe(false);
  });

  it('does not start progress for same-page or cross-origin anchors', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: 'http://localhost:3070/harness?ws=default' })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: 'https://example.com/docs' })).toBe(false);
  });
  it('starts progress for relative same-origin anchor hrefs', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: '/support?ws=default' })).toBe(true);
  });


  it('fails closed on unsafe-scheme target hrefs', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: 'javascript:alert(1)' })).toBe(false);
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: 'data:text/plain,hi' })).toBe(false);
  });
  it('does not start progress for hash-only document anchor navigations', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: '/harness?ws=default#details' })).toBe(false);
  });
  it('does not start progress for relative hash-only document anchor navigations', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: '#details' })).toBe(false);
  });
  it('starts progress for protocol-relative same-origin anchor hrefs', () => {
    expect(shouldStartDocumentRouteProgressForAnchor({ ...base, targetHref: '//localhost:3070/support?ws=default' })).toBe(true);
  });
});
