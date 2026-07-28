import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toIsoTimestamp } from './adv-sessions';

const SOURCE = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');

/**
 * WI-6589 — `first_seen_at` must stay a BIRTH, so nothing may bump it.
 *
 * This is a source-level guard rather than a behavioural one on purpose: the bug
 * it prevents is invisible to any unit test that seeds rows itself. The old
 * floor read `MIN(started_at)`, and `started_at` IS bumped in place by four
 * resume/re-anchor paths in this file — so production kept exactly one row per
 * coord owner and MIN === MAX === the latest launch. A test that seeds two rows
 * for one owner asserts a shape production cannot produce and passes while the
 * system is broken (measured: 6,957 targeted messages across 78 owners sat below
 * their computed floor). The only durable invariant is the one enforced here:
 * `first_seen_at` is written at INSERT and never again.
 */
describe('adv_sessions birth timestamp (WI-6589)', () => {
  it('the coord-owner birth floor reads first_seen_at, never the bumped started_at', () => {
    expect(SOURCE).toMatch(/SELECT MIN\(first_seen_at\) AS started_at/);
    expect(SOURCE).not.toMatch(/SELECT MIN\(started_at\)/);
  });

  it('no UPDATE statement in this module touches first_seen_at', () => {
    const offending = SOURCE.split('UPDATE harness_shared.adv_sessions')
      .slice(1)
      // Each fragment runs to the end of its tagged-template literal.
      .map((tail) => tail.slice(0, tail.indexOf('`')))
      .filter((stmt) => stmt.includes('first_seen_at'));
    expect(offending).toEqual([]);
  });

  it('recordAdvSession leaves first_seen_at to its column DEFAULT', () => {
    // Naming it in the INSERT would let a caller pass a value, which is the same
    // hole by another route.
    const inserts = SOURCE.split('INSERT INTO harness_shared.adv_sessions')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('`')));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.filter((stmt) => stmt.includes('first_seen_at'))).toEqual([]);
  });
});

describe('toIsoTimestamp', () => {
  it('passes Date objects through to ISO', () => {
    const value = new Date('2026-05-24T20:38:01.608Z');
    expect(toIsoTimestamp(value)).toBe('2026-05-24T20:38:01.608Z');
  });

  it('normalizes postgres text timestamps to ISO', () => {
    expect(toIsoTimestamp('2026-05-24 16:38:01.608162-04')).toBe('2026-05-24T20:38:01.608Z');
  });

  it('returns null for nullish values', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
  });

  it('throws on invalid timestamps', () => {
    expect(() => toIsoTimestamp('not-a-timestamp')).toThrow(/invalid timestamp/i);
  });
});
