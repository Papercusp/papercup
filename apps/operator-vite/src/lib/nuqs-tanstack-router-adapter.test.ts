import { describe, it, expect } from 'vitest';
import {
  composedSearchToObject,
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
 * Ours hands nuqs an UNFILTERED snapshot (all params), so the global queue's
 * composed flush output is the COMPLETE next search; `composedSearchToObject`
 * rebuilds the typed search object from it wholesale. Nothing merges over the
 * previous search — a key absent from the composed state was removed (or never
 * set) and must not survive. See the adapter header's FLUSH SCOPE note for the
 * bug this replaced (a watchKeys-scoped merge dropped removals enqueued by
 * OTHER hooks in the same flush — the plan popup that could not close).
 */

/** Simulate nuqs's globalThrottleQueue.applyPendingUpdates over our adapter:
 *  snapshot (unfiltered) + pending updates (null = delete) → composed params. */
function simulateFlush(
  currentSearch: Record<string, unknown>,
  pending: Record<string, string | null>,
): Record<string, unknown> {
  const search = searchObjectToParams(currentSearch, null);
  for (const [key, value] of Object.entries(pending)) {
    if (value === null) search.delete(key);
    else search.set(key, value);
  }
  return composedSearchToObject(search);
}

describe('flush pipeline (snapshot → pending updates → next search object)', () => {
  it('REGRESSION plan-popup close: two same-tick removals from different hooks both apply', () => {
    // reallyClose(): setView(null) [ppv hook] + setPopupPlan(null) [pplan hook]
    // drain in ONE flush. Under the old watchKeys-scoped merge, only the
    // flushing hook's key was deleted from prev and pplan survived every close.
    const next = simulateFlush(
      { tab: 'harnesses', ws: 'papercusp-workspace', opcv: 'plans', pplan: 'k-packs', ppv: 'sessions' },
      { ppv: null, pplan: null },
    );
    expect(next).toEqual({ tab: 'harnesses', ws: 'papercusp-workspace', opcv: 'plans' });
  });

  it('preserves a TanStack-native param (dock) when nuqs writes ws', () => {
    expect(simulateFlush({ dock: 1 }, { ws: 'sheets' })).toEqual({ dock: 1, ws: 'sheets' });
  });

  it('preserves the login ?switch param across a ws write', () => {
    expect(simulateFlush({ switch: 1 }, { ws: 'acme' })).toEqual({ switch: 1, ws: 'acme' });
  });

  it('applies a deletion while keeping every other param', () => {
    expect(simulateFlush({ ws: 'old', dock: 1 }, { ws: null })).toEqual({ dock: 1 });
  });

  it('replaces a stale value rather than keeping the old one', () => {
    expect(simulateFlush({ ws: 'old', dock: 1 }, { ws: 'new' })).toEqual({ ws: 'new', dock: 1 });
  });

  it('preserves unrelated nuqs-managed params not part of this flush (plq, plf)', () => {
    // The pane's search box (plq) and finished-toggle (plf) are nuqs keys of
    // OTHER hooks — the unfiltered snapshot carries them through untouched.
    expect(
      simulateFlush({ plq: 'kp', plf: true, pplan: 'k-packs' }, { pplan: null }),
    ).toEqual({ plq: 'kp', plf: true });
  });
});

describe('composedSearchToObject', () => {
  const compose = (qs: string) => composedSearchToObject(new URLSearchParams(qs));

  it('represents a repeated key as an array', () => {
    expect(compose('f=a&f=b')).toEqual({ f: ['a', 'b'] });
  });

  // ——— Type-faithful decoding (the dev-rail "closes on any inner click" bug) —
  // nuqs serializes parseAsBoolean as the STRING 'true'; handing that string to
  // TanStack's stringifier quote-wrapped it (?devRail=%22true%22) and each
  // subsequent write re-quoted it until parseAsBoolean rejected it and the
  // param snapped back to its default. The fix decodes nuqs values to the
  // TanStack-typed form that stringifies back plainly.

  it('decodes a nuqs boolean to a typed boolean (devRail=true → true, not "true")', () => {
    expect(compose('devRail=true')).toEqual({ devRail: true });
    expect(compose('devRail=false')).toEqual({ devRail: false });
  });

  it('decodes a nuqs integer to a typed number', () => {
    expect(compose('page=5')).toEqual({ page: 5 });
  });

  it('decodes a nuqs JSON object to a typed object', () => {
    expect(compose(`sel=${encodeURIComponent('{"a":1}')}`)).toEqual({ sel: { a: 1 } });
  });

  it('keeps plain words as strings', () => {
    expect(compose('devSec=fleet')).toEqual({ devSec: 'fleet' });
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
    // Filtered mode: non-listed (read-side non-watched) keys are excluded.
    expect(params.has('dock')).toBe(false);
  });

  it('null watchKeys = unfiltered — every param projects (the flush snapshot)', () => {
    const params = searchObjectToParams({ dock: 1, ws: 'x' }, null);
    expect(params.get('dock')).toBe('1');
    expect(params.get('ws')).toBe('x');
  });

  it('splits arrays into repeated keys', () => {
    const params = searchObjectToParams({ f: ['a', 'b'] }, ['f']);
    expect(params.getAll('f')).toEqual(['a', 'b']);
  });
});
