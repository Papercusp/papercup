import { describe, it, expect } from 'vitest';
import { mergeNuqsSearchParams } from './nuqs-tanstack-router-adapter';

/**
 * Regression coverage for the nuqs ↔ TanStack-Router search-param clobber.
 *
 * The stock `nuqs/adapters/tanstack-router` adapter rebuilds the whole query
 * string from ONLY the nuqs-watched keys, so any param managed by TanStack
 * Router's native typed search (`validateSearch` + `Route.useSearch()`) — e.g.
 * `?dock=1` on /harness/$slug, `?switch=1` on /login — was dropped on EVERY
 * nuqs write. The WorkspaceSwitcher mount effect writes `?ws=<active>` via
 * nuqs on load, which clobbered those params (≈18 e2e specs).
 *
 * `mergeNuqsSearchParams` is the fix: a nuqs write merges its watched-key
 * state OVER the full current URL search, preserving non-watched params.
 */
describe('mergeNuqsSearchParams', () => {
  const merge = (current: string, watch: string[], next: string) =>
    mergeNuqsSearchParams(current, watch, new URLSearchParams(next));

  it('preserves a TanStack-native param (dock) when nuqs writes ws — the bug', () => {
    const out = merge('?dock=1', ['ws'], 'ws=sheets');
    expect(out.get('dock')).toBe('1');
    expect(out.get('ws')).toBe('sheets');
  });

  it('preserves the login ?switch param across a ws write', () => {
    const out = merge('?switch=1', ['ws', 'wsSwitch'], 'ws=acme');
    expect(out.get('switch')).toBe('1');
    expect(out.get('ws')).toBe('acme');
  });

  it('applies a nuqs deletion (watched key gone) but keeps non-watched params', () => {
    const out = merge('?ws=old&dock=1', ['ws'], '');
    expect(out.get('ws')).toBeNull();
    expect(out.get('dock')).toBe('1');
  });

  it('replaces the stale watched value rather than duplicating it', () => {
    const out = merge('?ws=old&dock=1', ['ws'], 'ws=new');
    expect(out.getAll('ws')).toEqual(['new']);
    expect(out.get('dock')).toBe('1');
  });

  it('preserves a non-watched array param', () => {
    const out = merge('?tag=a&tag=b&dock=1', ['ws'], 'ws=x');
    expect(out.getAll('tag')).toEqual(['a', 'b']);
    expect(out.get('dock')).toBe('1');
    expect(out.get('ws')).toBe('x');
  });

  it('applies a watched array param (repeated keys) over non-watched params', () => {
    const out = merge('?dock=1', ['f'], 'f=a&f=b');
    expect(out.getAll('f')).toEqual(['a', 'b']);
    expect(out.get('dock')).toBe('1');
  });

  it('is a no-op-ish round trip when nuqs re-writes only its own watched keys', () => {
    const out = merge('?ws=a&dock=1&panel=prs', ['ws'], 'ws=a');
    expect(out.get('ws')).toBe('a');
    expect(out.get('dock')).toBe('1');
    expect(out.get('panel')).toBe('prs');
  });
});
