import { describe, it, expect } from 'vitest';
import {
  applyNuqsToSearch,
  decodeQueryValue,
  searchObjectToParams,
} from './nuqs-tanstack-router-adapter';

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

  // ——— Type-faithful decoding (the dev-rail "closes on any inner click" bug) —
  // nuqs serializes parseAsBoolean as the STRING 'true'; handing that string to
  // TanStack's stringifier quote-wrapped it (?devRail=%22true%22) and each
  // subsequent write re-quoted it until parseAsBoolean rejected it and the
  // param snapped back to its default. The fix decodes nuqs values to the
  // TanStack-typed form that stringifies back plainly.

  it('decodes a nuqs boolean to a typed boolean (devRail=true → true, not "true")', () => {
    expect(apply({}, ['devRail'], 'devRail=true')).toEqual({ devRail: true });
    expect(apply({}, ['devRail'], 'devRail=false')).toEqual({ devRail: false });
  });

  it('decodes a nuqs integer to a typed number', () => {
    expect(apply({}, ['page'], 'page=5')).toEqual({ page: 5 });
  });

  it('decodes a nuqs JSON object to a typed object', () => {
    expect(apply({}, ['sel'], `sel=${encodeURIComponent('{"a":1}')}`)).toEqual({
      sel: { a: 1 },
    });
  });

  it('keeps plain words as strings', () => {
    expect(apply({}, ['devSec'], 'devSec=fleet')).toEqual({ devSec: 'fleet' });
  });
});

describe('decodeQueryValue', () => {
  it('decodes canonical scalars to their typed form', () => {
    expect(decodeQueryValue('true')).toBe(true);
    expect(decodeQueryValue('false')).toBe(false);
    expect(decodeQueryValue('42')).toBe(42);
    expect(decodeQueryValue('-3.25')).toBe(-3.25);
    expect(decodeQueryValue('null')).toBe(null);
  });

  it('keeps non-JSON strings as-is', () => {
    expect(decodeQueryValue('fleet')).toBe('fleet');
    expect(decodeQueryValue('')).toBe('');
    expect(decodeQueryValue('undefined')).toBe('undefined');
  });

  it('round-trip guard: a string that decodes lossily stays a string', () => {
    // JSON.parse('1e2') === 100, which re-encodes as '100' ≠ '1e2' — the
    // original string must survive (TanStack's own string-symmetry quoting
    // then preserves it in the URL).
    expect(decodeQueryValue('1e2')).toBe('1e2');
    expect(decodeQueryValue('5.0')).toBe('5.0');
    // An already-quoted (legacy poisoned) value must not decode either — its
    // decode ('true') would re-encode differently. The snapshot path heals it.
    expect(decodeQueryValue('"true"')).toBe('"true"');
  });

  it('round-trips with searchObjectToParams (identity for nuqs read-back)', () => {
    for (const raw of ['true', 'false', '5', 'fleet', '1e2', '{"a":1}', 'null', '']) {
      const decoded = decodeQueryValue(raw);
      const back = searchObjectToParams({ k: decoded }, ['k']);
      expect(back.get('k')).toBe(raw);
    }
  });
});

describe('searchObjectToParams', () => {
  it('projects typed values to the strings nuqs parsers expect', () => {
    const params = searchObjectToParams(
      { devRail: true, page: 5, devSec: 'fleet', sel: { a: 1 }, dock: 1 },
      ['devRail', 'page', 'devSec', 'sel'],
    );
    expect(params.get('devRail')).toBe('true');
    expect(params.get('page')).toBe('5');
    expect(params.get('devSec')).toBe('fleet');
    expect(params.get('sel')).toBe('{"a":1}');
    // Non-watched (TanStack-native) keys are excluded.
    expect(params.has('dock')).toBe(false);
  });

  it('splits arrays into repeated keys', () => {
    const params = searchObjectToParams({ f: ['a', 'b'] }, ['f']);
    expect(params.getAll('f')).toEqual(['a', 'b']);
  });
});
