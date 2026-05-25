import { describe, expect, it } from 'vitest';
import { resolveNotifyActionTarget, shouldInvokeNotifyActionCallback } from '../notify';

describe('notify action target resolution', () => {
  it('routes same-origin app paths through client navigation', () => {
    expect(resolveNotifyActionTarget('/support')).toEqual({ kind: 'client', href: '/support' });
    expect(resolveNotifyActionTarget('/settings/operator?tab=voice')).toEqual({ kind: 'client', href: '/settings/operator?tab=voice' });
  });

  it('routes external and same-origin absolute URLs appropriately', () => {
    expect(resolveNotifyActionTarget('https://example.com/docs')).toEqual({ kind: 'external', href: 'https://example.com/docs' });
    expect(resolveNotifyActionTarget('http://localhost:3070/support?ws=default', 'http://localhost:3070')).toEqual({
      kind: 'client',
      href: '/support?ws=default',
    });
  });

  it('returns none when no href is supplied', () => {
    expect(resolveNotifyActionTarget(undefined)).toEqual({ kind: 'none', href: null });
  });

  it('fails closed on unsafe or malformed hrefs', () => {
    expect(resolveNotifyActionTarget('javascript:alert(1)')).toEqual({ kind: 'none', href: null });
    expect(resolveNotifyActionTarget('data:text/plain,hi')).toEqual({ kind: 'none', href: null });
    expect(resolveNotifyActionTarget('not a url')).toEqual({ kind: 'none', href: null });
  });
  it('reports whether a toast action callback should be invoked', () => {
    expect(shouldInvokeNotifyActionCallback(undefined)).toBe(false);
    expect(shouldInvokeNotifyActionCallback({})).toBe(false);
    expect(shouldInvokeNotifyActionCallback({ onClick: () => {} })).toBe(true);
  });
});
