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
import {
  attributeRetriageToRun,
  describeRefireBudget,
  parseInFlightRetriage,
  IN_FLIGHT_RETRIAGE_MAX_AGE_MS,
} from './in-flight-retriage';

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

  /**
   * EI-19343516395023183. Both publish sites in green-checkpoint.ts have persisted these three
   * since EI-19343532231631821 added them — and this parser, an explicit object literal, dropped
   * every one. So the fields existed on the interface, existed in Postgres, and reached NO reader:
   * `gate-verdict-freshness` and `git-pipeline-position` both went on rendering the CHARGED counter
   * alone. That is the failure this test pins.
   */
  it('⭐ carries charged/totalRefires/absoluteCeiling through — they are written by both publish sites and were silently dropped here', () => {
    const full = { ...VALID, charged: false, totalRefires: 5, absoluteCeiling: 6 };
    const v = parseInFlightRetriage(full, NOW);
    expect(v?.charged).toBe(false);
    expect(v?.totalRefires).toBe(5);
    expect(v?.absoluteCeiling).toBe(6);
  });

  it('omits the newer fields entirely for a pre-EI-19343532231631821 marker, rather than inventing a 0', () => {
    const v = parseInFlightRetriage(VALID, NOW);
    expect(v).not.toBeNull();
    expect(v).not.toHaveProperty('totalRefires');
    expect(v).not.toHaveProperty('absoluteCeiling');
    expect(v).not.toHaveProperty('charged');
  });

  it('ignores a wrong-typed newer field without rejecting the whole marker (it is optional, not required)', () => {
    const v = parseInFlightRetriage({ ...VALID, totalRefires: 'five', charged: 'no' }, NOW);
    expect(v).not.toBeNull();
    expect(v).not.toHaveProperty('totalRefires');
    expect(v).not.toHaveProperty('charged');
  });
});

describe('describeRefireBudget', () => {
  const base = { refireAttempt: 0, maxRefires: 2 };

  /**
   * The bug in one assertion. `refireAttempt` advances ONLY on a FAILED rescue, so a run whose
   * rescues all succeed sits at 0/2 forever while `totalRefires` climbs to the ceiling. Testing
   * `refireAttempt >= maxRefires` — what both call sites did — reports budget REMAINING in exactly
   * the case there is none, which is the direction that costs a caller a wasted full suite.
   */
  it('⭐ reports atCap when the ABSOLUTE CEILING is reached even though the charged budget is untouched', () => {
    const b = describeRefireBudget({ ...base, totalRefires: 6, absoluteCeiling: 6 });
    expect(b.atCap).toBe(true);
    expect(b.label).toContain('refire 6/6');
    expect(b.label).toContain('charged budget 0/2');
  });

  it('reports atCap when the CHARGED budget is spent even though the ceiling has room', () => {
    expect(describeRefireBudget({ refireAttempt: 2, maxRefires: 2, totalRefires: 2, absoluteCeiling: 6 }).atCap).toBe(true);
  });

  it('reports budget remaining when NEITHER bound is reached', () => {
    const b = describeRefireBudget({ ...base, totalRefires: 3, absoluteCeiling: 6 });
    expect(b.atCap).toBe(false);
    expect(b.label).toBe('refire 3/6 performed, charged budget 0/2 spent');
  });

  it('reports atCap when auto-refire is DISABLED (maxRefires 0) — there is no budget to have left', () => {
    expect(describeRefireBudget({ refireAttempt: 0, maxRefires: 0 }).atCap).toBe(true);
  });

  it('degrades to the charged-only reading for a pre-EI-19343532231631821 marker, rather than treating absent as 0', () => {
    const b = describeRefireBudget(base);
    expect(b.label).toBe('attempt 0/2');
    expect(b.atCap).toBe(false);
  });
});

describe('attributeRetriageToRun', () => {
  const marker = parseInFlightRetriage(VALID, NOW)!;

  it('returns null when there is no marker (= no refire in flight, the common case)', () => {
    expect(attributeRetriageToRun(null, { started_at: new Date(NOW).toISOString() })).toBeNull();
  });

  it('⭐ attributes a marker written AFTER the run started to that run', () => {
    const started = new Date(marker.observedAtMs - 60_000).toISOString();
    expect(attributeRetriageToRun(marker, { started_at: started })?.belongsToRun).toBe(true);
  });

  /**
   * The gate's run-lock is a singleton, so a marker predating the current run's start was written
   * by an earlier one. Presenting it as this run's rescue would silence a genuinely new red with
   * a stale one — the same trap Rule 4 in gate-verdict-freshness guards with `fromCandidate`.
   */
  it('⭐ REFUSES to attribute a marker written BEFORE the run started — that is an earlier run\'s', () => {
    const started = new Date(marker.observedAtMs + 60_000).toISOString();
    expect(attributeRetriageToRun(marker, { started_at: started })?.belongsToRun).toBe(false);
  });

  it('answers null (UNCONFIRMED, not false) when the run start is unreadable — absence of proof is not proof of absence', () => {
    expect(attributeRetriageToRun(marker, { started_at: null })?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, {})?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, undefined)?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, { started_at: 'not-a-date' })?.belongsToRun).toBeNull();
  });
});
