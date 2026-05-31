/**
 * Coverage for notify's pure action-target resolution: client (same-origin path)
 * vs external (cross-origin) vs none (non-http / unparseable), plus the
 * onClick-callback predicate. The sonner/React rendering path is out of scope.
 */
import { describe, expect, it } from 'vitest';
import { resolveNotifyActionTarget, shouldInvokeNotifyActionCallback } from './notify';

describe('resolveNotifyActionTarget', () => {
  it('returns none for an absent href', () => {
    expect(resolveNotifyActionTarget(undefined)).toEqual({ kind: 'none', href: null });
  });

  it('treats a leading-slash path as a client navigation', () => {
    expect(resolveNotifyActionTarget('/harness?ws=default')).toEqual({
      kind: 'client',
      href: '/harness?ws=default',
    });
  });

  it('treats a same-origin absolute URL as client (path+search+hash)', () => {
    expect(resolveNotifyActionTarget('http://localhost:3070/a?b=1#c', 'http://localhost:3070')).toEqual({
      kind: 'client',
      href: '/a?b=1#c',
    });
  });

  it('normalizes a trailing-slash currentOrigin before comparing', () => {
    expect(resolveNotifyActionTarget('http://localhost:3070/x', 'http://localhost:3070/')).toEqual({
      kind: 'client',
      href: '/x',
    });
  });

  it('treats a cross-origin URL as external', () => {
    expect(resolveNotifyActionTarget('https://example.com/p', 'http://localhost:3070')).toEqual({
      kind: 'external',
      href: 'https://example.com/p',
    });
  });

  it('rejects non-http(s) schemes as none', () => {
    expect(resolveNotifyActionTarget('mailto:a@b.c')).toEqual({ kind: 'none', href: null });
    expect(resolveNotifyActionTarget('javascript:alert(1)')).toEqual({ kind: 'none', href: null });
    expect(resolveNotifyActionTarget('data:text/html,x')).toEqual({ kind: 'none', href: null });
  });

  it('returns none for an unparseable href', () => {
    expect(resolveNotifyActionTarget('http://')).toEqual({ kind: 'none', href: null });
  });
});

describe('shouldInvokeNotifyActionCallback', () => {
  it('true only when an onClick function is present', () => {
    expect(shouldInvokeNotifyActionCallback({ onClick: () => {} })).toBe(true);
    expect(shouldInvokeNotifyActionCallback({})).toBe(false);
    expect(shouldInvokeNotifyActionCallback(undefined)).toBe(false);
  });
});
