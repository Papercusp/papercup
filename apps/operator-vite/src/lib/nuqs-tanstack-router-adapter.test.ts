import { describe, it, expect } from 'vitest';
import { applyNuqsToSearch } from './nuqs-tanstack-router-adapter';

/**
 * Regression coverage for the nuqs ↔ TanStack-Router search interplay.
 *
 * The stock `nuqs/adapters/tanstack-router` adapter rebuilds the URL as a
 * string from only the nuqs-watched keys, so params owned by TanStack's
 * native typed search (`?dock=1` on /harness/$slug, `?switch=1` on /login)
 * were dropped on every nuqs write — and its string-`to` form double-encodes.
 *
 * `applyNuqsToSearch` is the fix: nuqs's watched-key state laid over the
 * current *validated* search object, handed to TanStack's functional search
 * updater so TanStack serializes once and non-nuqs params survive.
 */
describe('applyNuqsToSearch', () => {
  const apply = (prev: Record<string, unknown>, watch: string[], next: string) =>
    applyNuqsToSearch(prev, watch, new URLSearchParams(next));

  it('preserves a TanStack-native param (dock) when nuqs writes ws — the bug', () => {
    expect(apply({ dock: '1' }, ['ws'], 'ws=sheets')).toEqual({ dock: '1', ws: 'sheets' });
  });

  it('preserves the login ?switch param across a ws write', () => {
    expect(apply({ switch: '1' }, ['ws', 'wsSwitch'], 'ws=acme')).toEqual({
      switch: '1',
      ws: 'acme',
    });
  });

  it('applies a nuqs deletion (watched key gone) but keeps non-watched params', () => {
    expect(apply({ ws: 'old', dock: '1' }, ['ws'], '')).toEqual({ dock: '1' });
  });

  it('replaces the stale watched value rather than keeping the old one', () => {
    expect(apply({ ws: 'old', dock: '1' }, ['ws'], 'ws=new')).toEqual({ ws: 'new', dock: '1' });
  });

  it('preserves unrelated nuqs-managed params on /adv (tab, slug)', () => {
    expect(apply({ tab: 'harnesses', slug: 'papercup' }, ['ws', 'tab', 'slug'], 'tab=harnesses&slug=papercup&ws=x')).toEqual({
      tab: 'harnesses',
      slug: 'papercup',
      ws: 'x',
    });
  });

  it('represents a repeated watched key as an array', () => {
    expect(apply({ dock: '1' }, ['f'], 'f=a&f=b')).toEqual({ dock: '1', f: ['a', 'b'] });
  });

  it('does not duplicate a key already present in prev (no string-append loop)', () => {
    // tab is both in prev and re-written by nuqs — must end as a single value.
    expect(apply({ tab: 'harnesses', dock: '1' }, ['tab'], 'tab=prs')).toEqual({
      tab: 'prs',
      dock: '1',
    });
  });
});
