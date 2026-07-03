/**
 * scorecard-freshness.test.ts — P-014b emission-freshness
 * (plan-templates-and-rubric-v2-2026-06-20 P-014 / D-005).
 *
 * Hermetic: listScorecards (P-013) is injected via the deps seam, so these pin the freshness LOGIC
 * (fresh / partial-only / stale, the complete-requires-rubricResolved rule, newest-first selection)
 * without PG. The underlying read has its own suite.
 */
import { describe, it, expect } from 'vitest';
import {
  checkScorecardFreshness,
  interpretOverwatchEmission,
  type OverwatchEmissionContext,
} from './scorecard-freshness';
import type { ScorecardRow, ListScorecardsFilter } from './scorecards';

function row(p: Partial<ScorecardRow> & { issueId: string; createdAt: string }): ScorecardRow {
  return {
    createdBy: 's-overwatch',
    rubricRef: 'hive-coordination-health',
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    rubricResolved: true,
    synthesized: false,
    ...p,
  };
}

const SINCE = '2026-06-20T12:00:00.000Z';
/** A deps seam returning a fixed scorecard set (newest-first, as listScorecards guarantees). */
const withRows = (rows: ScorecardRow[]) => ({ listScorecards: async () => rows });

describe('checkScorecardFreshness — P-014b emission-freshness', () => {
  it('FRESH: a complete scorecard landed in-window (the mandate is met)', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE },
      withRows([
        row({ issueId: 'EI-1', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 13, missingKeys: [], rubricResolved: true }),
      ]),
    );
    expect(r.status).toBe('fresh');
    expect(r.complete).toBe(true);
    expect(r.emitted).toBe(true);
    expect(r.lastCompleteAt).toBe('2026-06-20T13:00:00.000Z');
    expect(r.latestMissingKeys).toEqual([]);
  });

  it('PARTIAL-ONLY: scorecards landed but ALL incomplete — the silent truncation becomes visible', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE },
      withRows([
        // newest-first
        row({ issueId: 'EI-2', createdAt: '2026-06-20T13:30:00.000Z', nKeys: 3, missingKeys: ['wake', 'federation'], rubricResolved: true }),
        row({ issueId: 'EI-3', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 4, missingKeys: ['federation'], rubricResolved: true }),
      ]),
    );
    expect(r.status).toBe('partial-only');
    expect(r.complete).toBe(false);
    expect(r.emitted).toBe(true);
    expect(r.count).toBe(2);
    expect(r.partialCount).toBe(2);
    expect(r.latestMissingKeys).toEqual(['wake', 'federation']); // the NEWEST scorecard's gap
    expect(r.lastEmittedAt).toBe('2026-06-20T13:30:00.000Z');
    expect(r.lastCompleteAt).toBeNull();
  });

  it('STALE: nothing landed in-window — the silent emission gap becomes visible', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE },
      withRows([]),
    );
    expect(r.status).toBe('stale');
    expect(r.emitted).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.count).toBe(0);
    expect(r.lastEmittedAt).toBeNull();
    expect(r.lastCompleteAt).toBeNull();
    expect(r.latestMissingKeys).toEqual([]);
  });

  it('FRESH picks the newest COMPLETE even when a later partial follows an earlier complete', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE },
      withRows([
        row({ issueId: 'EI-5', createdAt: '2026-06-20T14:00:00.000Z', nKeys: 2, missingKeys: ['wake'], rubricResolved: true }), // newest, partial
        row({ issueId: 'EI-6', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 13, missingKeys: [], rubricResolved: true }), // older, complete
      ]),
    );
    expect(r.status).toBe('fresh'); // a complete one exists in-window
    expect(r.complete).toBe(true);
    expect(r.partialCount).toBe(1);
    expect(r.lastCompleteAt).toBe('2026-06-20T13:00:00.000Z');
    expect(r.lastEmittedAt).toBe('2026-06-20T14:00:00.000Z'); // newest emission (the partial)
    expect(r.latestMissingKeys).toEqual(['wake']);
  });

  it('does NOT count an UNRESOLVED-rubric scorecard as complete (empty missingKeys but rubricResolved=false)', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'unknown-rubric', since: SINCE },
      withRows([
        row({ issueId: 'EI-7', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 2, missingKeys: [], rubricResolved: false }),
      ]),
    );
    expect(r.emitted).toBe(true);
    expect(r.complete).toBe(false); // unresolved → not a confirmable complete
    expect(r.partialCount).toBe(0); // not confirmed-incomplete either
    expect(r.status).toBe('partial-only'); // emitted but no confirmed-complete
  });

  it('EXCLUDES the synthesized floor by default — a floor-only window reads STALE so the agent skip stays visible', async () => {
    const rows = [
      row({
        issueId: 'EI-FLOOR',
        createdAt: '2026-06-20T13:00:00.000Z',
        nKeys: 13,
        missingKeys: [],
        rubricResolved: true,
        synthesized: true,
      }),
    ];
    // The seam honors the filter exactly as the real listScorecards does.
    const seam = {
      listScorecards: async (f?: ListScorecardsFilter) =>
        f?.includeSynthesized ? rows : rows.filter((r) => !r.synthesized),
    };
    const byDefault = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE },
      seam,
    );
    expect(byDefault.status).toBe('stale'); // the floor does NOT satisfy the agent mandate

    const including = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', since: SINCE, includeSynthesized: true },
      seam,
    );
    expect(including.status).toBe('fresh'); // counted only when explicitly asked
  });

  it('defaults `since` to a lookback window when omitted', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'hive-coordination-health', lookbackMs: 60_000 },
      withRows([]),
    );
    expect(typeof r.since).toBe('string');
    expect(r.status).toBe('stale');
  });
});

describe('interpretOverwatchEmission — WI-1724 self-interpreting freshness verdict', () => {
  // A live, started, currently-firing loop (the "should be emitting" baseline).
  const liveLoop: OverwatchEmissionContext = {
    flagEnabled: true,
    started: true,
    loopAlive: true,
    loopStale: false,
    lastRunAt: '2026-07-03T04:00:00.000Z',
  };

  it('FRESH ⇒ verdict fresh, non-actionable (regardless of loop state)', () => {
    const r = interpretOverwatchEmission('fresh', liveLoop);
    expect(r.verdict).toBe('fresh');
    expect(r.actionable).toBe(false);
  });

  it('stale + flag OFF ⇒ overwatch-disabled, NON-actionable (staleness expected — the false-alarm case)', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: false,
      started: false,
      loopAlive: false,
      loopStale: false,
      lastRunAt: null,
    });
    expect(r.verdict).toBe('overwatch-disabled');
    expect(r.actionable).toBe(false);
  });

  it('stale + enabled but NOT started ⇒ overwatch-not-started, NON-actionable', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: false,
      loopAlive: false,
      loopStale: false,
      lastRunAt: null,
    });
    expect(r.verdict).toBe('overwatch-not-started');
    expect(r.actionable).toBe(false);
  });

  it('stale + started+enabled + loop STALE ⇒ loop-dead, ACTIONABLE (revive the loop — the WI-1724 root case)', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: true,
      loopAlive: false,
      loopStale: true,
      lastRunAt: '2026-07-02T21:07:19.000Z',
    });
    expect(r.verdict).toBe('loop-dead');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('2026-07-02T21:07:19.000Z'); // surfaces the last-run time
  });

  it('stale + started+enabled + loop never fired ⇒ loop-dead (lastRunAt null renders "never")', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: true,
      loopAlive: false,
      loopStale: false, // neither alive nor stale (defensive) still reads as a dead loop
      lastRunAt: null,
    });
    expect(r.verdict).toBe('loop-dead');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('never');
  });

  it('stale + live loop ⇒ agent-skipping, ACTIONABLE (loop fires but agent emits nothing — D-005)', () => {
    const r = interpretOverwatchEmission('stale', liveLoop);
    expect(r.verdict).toBe('agent-skipping');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('SKIPPING');
  });

  it('partial-only + live loop ⇒ agent-skipping with the TRUNCATION note', () => {
    const r = interpretOverwatchEmission('partial-only', liveLoop);
    expect(r.verdict).toBe('agent-skipping');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('TRUNCATING');
  });

  it('precedence: a disabled flag wins even if the loop looks stale', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: false,
      started: true,
      loopAlive: false,
      loopStale: true,
      lastRunAt: '2026-07-02T21:07:19.000Z',
    });
    expect(r.verdict).toBe('overwatch-disabled');
    expect(r.actionable).toBe(false);
  });
});
