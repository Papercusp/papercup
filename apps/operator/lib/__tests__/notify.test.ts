import { describe, expect, it } from 'vitest';
import { resolveNotifyActionTarget } from '../notify';

describe('notify action target resolution', () => {
  it('routes same-origin app paths through client navigation', () => {
    expect(resolveNotifyActionTarget('/support')).toEqual({ kind: 'client', href: '/support' });
    expect(resolveNotifyActionTarget('/settings/operator?tab=voice')).toEqual({ kind: 'client', href: '/settings/operator?tab=voice' });
  });

  it('routes absolute URLs through external open handling', () => {
    expect(resolveNotifyActionTarget('https://example.com/docs')).toEqual({ kind: 'external', href: 'https://example.com/docs' });
  });

  it('returns none when no href is supplied', () => {
    expect(resolveNotifyActionTarget(undefined)).toEqual({ kind: 'none', href: null });
  });
});
