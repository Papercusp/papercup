// @vitest-environment jsdom
/**
 * nuqs-tanstack-router-adapter.test.tsx — the pure round-trip helpers at the
 * heart of the custom nuqs↔TanStack-Router adapter. These encode two shipped
 * regressions: the type-faithful decode ("clicking the dev rail closes it" —
 * values must NOT accrete JSON quotes) and the watched-key merge that preserves
 * TanStack's native typed params + applies nuqs deletions.
 *
 * Pure functions only — no router/provider wiring — so this is deterministic
 * and DOM-free apart from the global URLSearchParams.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeQueryValue,
  searchObjectToParams,
  applyNuqsToSearch,
} from './nuqs-tanstack-router-adapter';

describe('decodeQueryValue — type-faithful nuqs→TanStack decode', () => {
  it('decodes canonical booleans to real booleans (not the quoted strings)', () => {
    expect(decodeQueryValue('true')).toBe(true);
    expect(decodeQueryValue('false')).toBe(false);
  });

  it('decodes canonical numbers to real numbers', () => {
    expect(decodeQueryValue('42')).toBe(42);
    expect(decodeQueryValue('0')).toBe(0);
    expect(decodeQueryValue('-5')).toBe(-5);
    expect(decodeQueryValue('3.14')).toBe(3.14);
  });

  it('keeps plain strings as strings', () => {
    expect(decodeQueryValue('hello')).toBe('hello');
    expect(decodeQueryValue('')).toBe('');
  });

  it('keeps a numeric-looking string that would not round-trip (1e2 ≠ 100)', () => {
    // The documented anti-case: the literal string "1e2" must NOT become 100,
    // because String(100) !== "1e2".
    expect(decodeQueryValue('1e2')).toBe('1e2');
  });

  it('decodes a JSON object string back to an object that re-encodes identically', () => {
    expect(decodeQueryValue('{"a":1}')).toEqual({ a: 1 });
  });

  it('does NOT strip quotes off an already-quoted legacy value (no round-trip)', () => {
    // '"true"' would JSON.parse to the string 'true', which re-encodes to
    // 'true' ≠ '"true"', so the guard keeps the raw input verbatim.
    expect(decodeQueryValue('"true"')).toBe('"true"');
  });
});

describe('searchObjectToParams — typed search → nuqs URLSearchParams', () => {
  it('keeps only the watched keys', () => {
    const p = searchObjectToParams({ a: 1, b: 2 }, ['a']);
    expect(p.get('a')).toBe('1');
    expect(p.has('b')).toBe(false);
  });

  it('stringifies scalars and booleans', () => {
    const p = searchObjectToParams({ n: 42, flag: true, off: false }, ['n', 'flag', 'off']);
    expect(p.get('n')).toBe('42');
    expect(p.get('flag')).toBe('true');
    expect(p.get('off')).toBe('false');
  });

  it('expands arrays into repeated keys', () => {
    const p = searchObjectToParams({ tags: ['x', 'y'] }, ['tags']);
    expect(p.getAll('tags')).toEqual(['x', 'y']);
  });

  it('JSON-stringifies plain objects', () => {
    const p = searchObjectToParams({ o: { a: 1 } }, ['o']);
    expect(p.get('o')).toBe('{"a":1}');
  });

  it('drops an unwatched key even when present in the search object', () => {
    const p = searchObjectToParams({ dock: '1', ws: 'team' }, ['ws']);
    expect(p.has('dock')).toBe(false);
    expect(p.get('ws')).toBe('team');
  });
});

describe('applyNuqsToSearch — watched-key merge over the validated search', () => {
  it("preserves TanStack's native typed params nuqs does not watch", () => {
    const next = applyNuqsToSearch(
      { dock: 1, foo: 'bar' },
      ['foo'],
      new URLSearchParams('foo=baz'),
    );
    expect(next).toEqual({ dock: 1, foo: 'baz' });
  });

  it('applies a nuqs deletion by dropping the watched key', () => {
    const next = applyNuqsToSearch(
      { foo: 'x', keep: 9 },
      ['foo'],
      new URLSearchParams(''),
    );
    expect(next).toEqual({ keep: 9 });
    expect('foo' in next).toBe(false);
  });

  it('decodes overlaid values to their typed form (true, not "true")', () => {
    const next = applyNuqsToSearch({}, ['flag', 'n'], new URLSearchParams('flag=true&n=42'));
    expect(next.flag).toBe(true);
    expect(next.n).toBe(42);
  });

  it('groups repeated watched keys into an array', () => {
    const next = applyNuqsToSearch({}, ['tag'], new URLSearchParams('tag=a&tag=b'));
    expect(next.tag).toEqual(['a', 'b']);
  });

  it('overlays nuqs state on top of a stale watched value in prev', () => {
    const next = applyNuqsToSearch(
      { sel: 'old', other: 'untouched' },
      ['sel'],
      new URLSearchParams('sel=new'),
    );
    expect(next).toEqual({ sel: 'new', other: 'untouched' });
  });
});
