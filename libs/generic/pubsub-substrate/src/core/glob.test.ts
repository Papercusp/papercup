/**
 * glob.test.ts — the v1 path-glob matcher for watch/notify subscriptions.
 * Pure + load-bearing: a wrong match either drops a subscriber's wake (missed
 * notification) or over-delivers (storms). Pins the v1 syntax contract:
 *   `**` matches anything incl. `/`; `*` matches anything EXCEPT `/`; everything
 *   else is literal (regex specials escaped); the match is fully anchored.
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/glob.test.ts
 */
import { describe, expect, it } from 'vitest';
import { patternToRegex, matchesPattern } from './glob';

describe('patternToRegex', () => {
  it('anchors the whole string (no substring matches)', () => {
    const re = patternToRegex('abc');
    expect(re.test('abc')).toBe(true);
    expect(re.test('xabcx')).toBe(false);
    expect(re.source).toBe('^abc$');
  });

  it('escapes regex specials so they match literally', () => {
    expect(patternToRegex('a.b').test('a.b')).toBe(true);
    expect(patternToRegex('a.b').test('axb')).toBe(false); // dot is literal, not "any char"
    expect(patternToRegex('a+b').test('a+b')).toBe(true);
    expect(patternToRegex('a(b)').test('a(b)')).toBe(true);
  });
});

describe('matchesPattern — literals', () => {
  it('matches an exact path and rejects a different one', () => {
    expect(matchesPattern('a/b/c', 'a/b/c')).toBe(true);
    expect(matchesPattern('a/b/c', 'a/b/d')).toBe(false);
  });
});

describe('matchesPattern — single star (within a segment, does not cross /)', () => {
  it('matches any chars inside one segment', () => {
    expect(matchesPattern('a/*/c', 'a/x/c')).toBe(true);
    expect(matchesPattern('a/*', 'a/anything')).toBe(true);
  });

  it('does NOT cross a slash', () => {
    expect(matchesPattern('a/*/c', 'a/x/y/c')).toBe(false);
    expect(matchesPattern('a/*', 'a/b/c')).toBe(false);
  });

  it('can match an empty segment', () => {
    expect(matchesPattern('a/*/c', 'a//c')).toBe(true);
  });
});

describe('matchesPattern — double star (crosses /)', () => {
  it('matches across slashes, including deep paths', () => {
    expect(matchesPattern('a/**', 'a/b')).toBe(true);
    expect(matchesPattern('a/**', 'a/b/c/d')).toBe(true);
    expect(matchesPattern('**', 'anything/at/all')).toBe(true);
  });

  it('a leading **/ requires the literal slash (v1 limitation)', () => {
    expect(matchesPattern('**/c', 'a/b/c')).toBe(true);
    // v1: the `/` after `**` is LITERAL, so `**/c` does NOT match a bare top-level
    // `c` (unlike real globs where `**/` collapses zero dirs). Pinned as the contract.
    expect(matchesPattern('**/c', 'c')).toBe(false);
  });

  it('still anchors the literal tail', () => {
    expect(matchesPattern('a/**', 'b/a/c')).toBe(false); // must start with a/
    expect(matchesPattern('**/c', 'a/b/cd')).toBe(false); // tail must be exactly c
  });
});

describe('matchesPattern wrapper', () => {
  it('delegates to patternToRegex().test', () => {
    expect(matchesPattern('x*', 'xyz')).toBe(patternToRegex('x*').test('xyz'));
  });
});
