/**
 * EI-18669342433807110 — a stale-candidate auto-refire in progress, made visible.
 *
 * `parseInFlightRetriage` is the pure half (PG-free): it decides whether a raw
 * `gate_health.inFlightRetriage` value read back from Postgres is trustworthy right now. The write
 * side (`recordInFlightRetriage`) is a thin best-effort SQL merge, exercised live by
 * green-checkpoint-real-deps.test.ts / manual verification, not unit-tested here (no PG in this
 * suite) — see gate-verdict-freshness.test.ts's "Rule 4" block for how a parsed marker feeds the
 * freshness verdict a reader actually acts on.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/in-flight-retriage.test.ts
 */
import { describe, expect, it } from 'vitest';
import { parseInFlightRetriage, IN_FLIGHT_RETRIAGE_MAX_AGE_MS } from './in-flight-retriage';

const NOW = Date.parse('2026-07-26T02:00:00Z');

const VALID = {
  fromCandidate: '30f88df7abcd',
  refiringCandidate: '221dc407abcd',
  refireAttempt: 1,
  maxRefires: 2,
  failingFiles: ['a.test.ts', 'b.test.ts'],
  observedAtMs: NOW - 60_000, // 1 minute ago — fresh
};

describe('parseInFlightRetriage', () => {
  it('⭐ parses a fresh, well-formed marker', () => {
    const v = parseInFlightRetriage(VALID, NOW);
    expect(v).toEqual(VALID);
  });

  it('returns null for a missing marker (the common case — no refire running)', () => {
    expect(parseInFlightRetriage(undefined, NOW)).toBeNull();
    expect(parseInFlightRetriage(null, NOW)).toBeNull();
  });

  it('returns null for a non-object', () => {
    expect(parseInFlightRetriage('not-an-object', NOW)).toBeNull();
    expect(parseInFlightRetriage(42, NOW)).toBeNull();
  });

  it('returns null when a required field is missing or the wrong type (malformed/old-shape blob)', () => {
    expect(parseInFlightRetriage({ ...VALID, fromCandidate: undefined }, NOW)).toBeNull();
    expect(parseInFlightRetriage({ ...VALID, refireAttempt: '1' }, NOW)).toBeNull();
    expect(parseInFlightRetriage({ ...VALID, observedAtMs: undefined }, NOW)).toBeNull();
  });

  it('defaults failingFiles to [] when absent or non-string-array, rather than rejecting the whole marker', () => {
    const { failingFiles, ...rest } = VALID;
    expect(parseInFlightRetriage(rest, NOW)?.failingFiles).toEqual([]);
    expect(parseInFlightRetriage({ ...VALID, failingFiles: 'oops' }, NOW)?.failingFiles).toEqual([]);
    expect(parseInFlightRetriage({ ...VALID, failingFiles: ['ok.ts', 42] }, NOW)?.failingFiles).toEqual(['ok.ts']);
  });

  it('⭐ rejects an ABANDONED marker (older than IN_FLIGHT_RETRIAGE_MAX_AGE_MS) — a crashed run must not wedge every future read into "still refiring" forever', () => {
    const abandoned = { ...VALID, observedAtMs: NOW - IN_FLIGHT_RETRIAGE_MAX_AGE_MS - 1 };
    expect(parseInFlightRetriage(abandoned, NOW)).toBeNull();
  });

  it('accepts a marker right at the boundary (not yet abandoned)', () => {
    const boundary = { ...VALID, observedAtMs: NOW - IN_FLIGHT_RETRIAGE_MAX_AGE_MS + 1 };
    expect(parseInFlightRetriage(boundary, NOW)).not.toBeNull();
  });
});
