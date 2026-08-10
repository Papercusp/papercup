import { describe, it, expect } from 'vitest';
import {
  decideTscRedCleared,
  cleanRunsAfter,
  tscRedPathOf,
  TSC_RED_MIN_CLEAN_RUNS,
  type TscRunHeartbeat,
} from './tsc-red-cleared-resolve';

const KEY = 'tsc-new-file-red::packages/operator-core/lib/foo.ts';
const LAST_SEEN = 1_700_000_000;

/** Heartbeats at the given offsets (seconds) from the last sighting. */
const beats = (...offsets: number[]): TscRunHeartbeat[] =>
  offsets.map((o) => ({ ts: LAST_SEEN + o, project: 'operator-core', verdict: 'ok', standingCount: 0 }));

const decide = (over: Partial<Parameters<typeof decideTscRedCleared>[1]> = {}, opts = {}) =>
  decideTscRedCleared(KEY, { lastSeenSec: LAST_SEEN, heartbeats: beats(60, 120), fileExists: true, ...over }, opts);

describe('tscRedPathOf', () => {
  it('extracts the path from a tsc-new-file-red key and rejects every other source', () => {
    expect(tscRedPathOf(KEY)).toBe('packages/operator-core/lib/foo.ts');
    expect(tscRedPathOf('red-test:packages/operator-core/lib/foo.test.ts')).toBeNull();
    expect(tscRedPathOf('smoke-fail:papercup')).toBeNull();
    expect(tscRedPathOf(undefined)).toBeNull();
  });
});

describe('cleanRunsAfter', () => {
  it('counts only heartbeats STRICTLY newer than the last sighting', () => {
    // The tie is the load-bearing case: the gate writes its heartbeat and its observations
    // in the same one-second tick, so a heartbeat AT the sighting may BE the run that saw it.
    expect(cleanRunsAfter(beats(-60, 0, 60), LAST_SEEN)).toBe(1);
    expect(cleanRunsAfter([], LAST_SEEN)).toBe(0);
  });
});

describe('decideTscRedCleared — the refusals', () => {
  it('REFUSES when no run has completed since the last sighting (the vacuity case)', () => {
    // THE guard this module exists for. "No evidence the file is red" and "evidence the file
    // is not red" are byte-identical in a store that only records reds — so with no run after
    // the last sighting there is nothing to distinguish a fixed file from a DEAD SAMPLER, and
    // a naive implementation closes the entire backlog the moment the gate stops running.
    const noBeats = decide({ heartbeats: [] });
    expect(noBeats.resolve).toBe(false);
    expect(noBeats.reason).toMatch(/no-runs-since-last-sighting/);
    expect(noBeats.cleanRuns).toBe(0);

    // Same refusal when runs exist but ALL predate the sighting — a stale sampler reading is
    // not evidence either, however many rows it has.
    const staleBeats = decide({ heartbeats: beats(-600, -300, -60) });
    expect(staleBeats.resolve).toBe(false);
    expect(staleBeats.reason).toMatch(/no-runs-since-last-sighting/);
  });

  it('REFUSES a single post-sighting run — one compile can be a coalesced replay', () => {
    const d = decide({ heartbeats: beats(60) });
    expect(d.resolve).toBe(false);
    expect(d.reason).toMatch(/insufficient-clean-runs \(1<2\)/);
    expect(d.cleanRuns).toBe(1);
  });

  it('REFUSES when the file is gone from the tree — deleted/renamed is ambiguous', () => {
    const d = decide({ fileExists: false });
    expect(d.resolve).toBe(false);
    expect(d.reason).toMatch(/file-absent-from-tree/);
  });

  it('REFUSES when nothing dates the red, so there is no "after" to measure', () => {
    expect(decide({ lastSeenSec: null }).resolve).toBe(false);
    expect(decide({ lastSeenSec: null }).reason).toMatch(/no-sighting-in-retention/);
  });

  it('REFUSES any watchdog key that is not a tsc-new-file-red', () => {
    const d = decideTscRedCleared('red-test:packages/operator-core/lib/foo.test.ts', {
      lastSeenSec: LAST_SEEN,
      heartbeats: beats(60, 120, 180),
      fileExists: true,
    });
    expect(d.resolve).toBe(false);
    expect(d.reason).toBe('not-tsc-new-file-red');
  });
});

describe('decideTscRedCleared — the positive path', () => {
  it('resolves on N post-sighting clean runs and attaches REAL completion evidence', () => {
    const d = decide();
    expect(d.resolve).toBe(true);
    expect(d.cleanRuns).toBe(2);
    expect(d.evidence?.verifiedHow).toBe('already-passing');
    expect(d.evidence?.addedTests).toBe(false);
    // The evidence must state the measurement, not merely assert the conclusion — this is the
    // difference between a completion record and a dedup marker.
    expect(d.evidence?.testsRun).toMatch(/2 compile\(s\) completed after the last sighting/);
    expect(d.completionRef).toMatch(/measured absence of the red, NOT mere absence of signal/);
  });

  it('honours a caller-supplied minCleanRuns floor in both directions', () => {
    expect(decide({ heartbeats: beats(60) }, { minCleanRuns: 1 }).resolve).toBe(true);
    expect(decide({ heartbeats: beats(60, 120) }, { minCleanRuns: 3 }).resolve).toBe(false);
  });

  it('defaults to a floor above 1', () => {
    // Pinned: dropping this to 1 would admit a single coalesced replay as proof.
    expect(TSC_RED_MIN_CLEAN_RUNS).toBeGreaterThan(1);
  });
});
