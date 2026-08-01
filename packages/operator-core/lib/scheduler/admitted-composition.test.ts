/**
 * admitted-composition.test.ts — WI-6673.
 *
 * The guard for `admittedBreakdown`: what the claimable set is MADE OF, and the
 * `degenerate` judgement that tells a caller a large count is an observation firehose
 * rather than a workload.
 *
 * WHY this exists as its own file: the feature shipped with ZERO tests, which is the
 * SAME failure the feature itself is about — a number that looks like a measurement and
 * therefore resists suspicion. Two constants (DEGENERATE_MIN_POOL,
 * DEGENERATE_LOW_SEVERITY_SHARE) decide whether a fleet gets warned before being launched
 * at 12.5k auto-filed nits, and nothing stopped them silently regressing to values that
 * never fire. Both directions matter and both are pinned below: firing on a degenerate
 * pool, and NOT firing on a healthy one (a warning that cries wolf gets ignored, which
 * fails exactly when it matters).
 *
 * The SQL that feeds this is a plain GROUP BY covered by the DB-backed claim-ssot suites;
 * `summarizeAdmittedRows` is the pure fold carrying the judgement, so it is tested here
 * directly — no database, runs on every edit.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/admitted-composition.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeAdmittedRows,
  DEGENERATE_MIN_POOL,
  DEGENERATE_LOW_SEVERITY_SHARE,
  type AdmittedCompositionRow,
} from './get-next';

const row = (kind: string, severity: string, n: number, day: string | null = '2026-08-01'): AdmittedCompositionRow => ({
  kind,
  severity,
  day,
  n,
});

describe('summarizeAdmittedRows — composition of the admitted set (WI-6673)', () => {
  it('tallies byKind and bySeverity across the grouped rows', () => {
    const out = summarizeAdmittedRows([
      row('bug', 'major', 3),
      row('bug', 'critical', 1),
      row('change', 'nit', 10),
      row('change', 'minor', 2),
      row('task', 'minor', 4),
    ]);

    expect(out.byKind).toEqual({ bug: 4, change: 12, task: 4 });
    expect(out.bySeverity).toEqual({ major: 3, critical: 1, nit: 10, minor: 2 + 4 });
  });

  it('lowSeverityShare counts nit+minor only — major/critical/unset never count as low', () => {
    const out = summarizeAdmittedRows([
      row('change', 'nit', 6),
      row('change', 'minor', 2),
      row('bug', 'major', 1),
      row('bug', 'critical', 1),
    ]);
    // 8 low of 10 total
    expect(out.lowSeverityShare).toBeCloseTo(0.8, 10);
  });

  it('an `unset` severity is NOT low-severity — it is unknown, and guessing it low would manufacture a false degenerate verdict', () => {
    const out = summarizeAdmittedRows([row('change', 'unset', 100)]);
    expect(out.bySeverity).toEqual({ unset: 100 });
    expect(out.lowSeverityShare).toBe(0);
    expect(out.degenerate).toBe(false);
  });

  it('an empty pool reports null share, not 0 — "nothing to measure" must not read as "measured, and healthy"', () => {
    const out = summarizeAdmittedRows([]);
    expect(out.lowSeverityShare).toBeNull();
    expect(out.degenerate).toBe(false);
    expect(out.peakDay).toBeNull();
    expect(out.byKind).toEqual({});
  });

  describe('the degenerate judgement — BOTH large AND lopsided', () => {
    it('fires on the real shape that caused this: a big pool that is overwhelmingly nit/minor', () => {
      const out = summarizeAdmittedRows([
        row('change', 'nit', 11_584),
        row('change', 'minor', 980),
        row('change', 'major', 154),
        row('bug', 'major', 214),
      ]);
      expect(out.degenerate).toBe(true);
      expect(out.lowSeverityShare!).toBeGreaterThan(0.9);
    });

    it('does NOT fire on a healthy pool of the same SIZE — size alone is never the trigger', () => {
      const out = summarizeAdmittedRows([
        row('bug', 'major', 6_000),
        row('bug', 'critical', 3_000),
        row('change', 'nit', 3_000),
      ]);
      expect(out.degenerate).toBe(false);
    });

    it('does NOT fire on a SMALL pool however lopsided — a handful of nits is not a firehose', () => {
      const out = summarizeAdmittedRows([row('change', 'nit', DEGENERATE_MIN_POOL - 1)]);
      expect(out.lowSeverityShare).toBe(1);
      expect(out.degenerate).toBe(false);
    });

    it('the pool-size threshold is inclusive at DEGENERATE_MIN_POOL', () => {
      expect(summarizeAdmittedRows([row('change', 'nit', DEGENERATE_MIN_POOL)]).degenerate).toBe(true);
      expect(summarizeAdmittedRows([row('change', 'nit', DEGENERATE_MIN_POOL - 1)]).degenerate).toBe(false);
    });

    it('the share threshold is inclusive at DEGENERATE_LOW_SEVERITY_SHARE, and just under it does not fire', () => {
      // 80 low / 100 total === exactly the threshold → fires.
      const at = summarizeAdmittedRows([row('change', 'nit', 80), row('bug', 'major', 20)]);
      expect(at.lowSeverityShare).toBeCloseTo(DEGENERATE_LOW_SEVERITY_SHARE, 10);
      expect(at.degenerate).toBe(true);

      // 79 low / 100 total → just under; must NOT fire.
      const under = summarizeAdmittedRows([row('change', 'nit', 79), row('bug', 'major', 21)]);
      expect(under.degenerate).toBe(false);
    });

    it('the thresholds are the documented ones — a silent retune to values that never fire is the regression this pins', () => {
      expect(DEGENERATE_MIN_POOL).toBe(50);
      expect(DEGENERATE_LOW_SEVERITY_SHARE).toBe(0.8);
    });
  });

  describe('peakDay — the burst-filing tell', () => {
    it('reports the busiest single day and its count, summed across kinds/severities', () => {
      const out = summarizeAdmittedRows([
        row('change', 'nit', 100, '2026-07-30'),
        row('change', 'nit', 40, '2026-07-31'),
        row('bug', 'major', 5, '2026-07-31'),
        row('change', 'minor', 30, '2026-07-30'),
      ]);
      expect(out.peakDay).toEqual({ day: '2026-07-30', count: 130 });
    });

    it('rows with no day are excluded from peakDay but still counted in the totals', () => {
      const out = summarizeAdmittedRows([row('change', 'nit', 10, null), row('bug', 'major', 2, '2026-07-31')]);
      expect(out.peakDay).toEqual({ day: '2026-07-31', count: 2 });
      expect(out.byKind).toEqual({ change: 10, bug: 2 });
    });

    it('a tie breaks deterministically on the earlier day — the verdict must not flap between identical reads', () => {
      const rows = [row('change', 'nit', 7, '2026-07-31'), row('change', 'nit', 7, '2026-07-30')];
      expect(summarizeAdmittedRows(rows).peakDay).toEqual({ day: '2026-07-30', count: 7 });
      // Same tallies, reversed input order → same verdict.
      expect(summarizeAdmittedRows([...rows].reverse()).peakDay).toEqual({ day: '2026-07-30', count: 7 });
    });
  });
});
