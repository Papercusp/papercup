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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatLowSeverityShare } from './admitted-composition-format';
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

  it('reports `total` — the population lowSeverityShare is a share OF', () => {
    const out = summarizeAdmittedRows([row('bug', 'major', 3), row('change', 'nit', 10), row('task', 'minor', 4)]);
    expect(out.total).toBe(17);
    // The denominator travels WITH the share, so a consumer never has to pair it with some
    // other count it happens to have. Pairing the share with a spec's PRE-floor `matched`
    // is a real defect this pins shut (it shipped once inside the degenerate-lane warning
    // itself): both numbers correct, the percentage against the wrong base.
    expect(out.total).toBe(Object.values(out.byKind).reduce((a, b) => a + b, 0));
    expect(out.total).toBe(Object.values(out.bySeverity).reduce((a, b) => a + b, 0));
  });

  it('lowSeverityShare is exactly (nit+minor)/total — the invariant a consumer relies on when quoting it', () => {
    const out = summarizeAdmittedRows([row('change', 'nit', 30), row('change', 'minor', 15), row('bug', 'major', 5)]);
    const low = (out.bySeverity.nit ?? 0) + (out.bySeverity.minor ?? 0);
    expect(out.lowSeverityShare).toBeCloseTo(low / out.total, 10);
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
    expect(out.total).toBe(0);
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

  /**
   * EI-22184028605968917 — the PROSE layer of the same defect class this file guards.
   * The structured buckets were right all along; the sentence rendered from them was not.
   */
  describe('formatLowSeverityShare — the warning must never overstate the share', () => {
    it('REGRESSION: the measured lane (2363 of 2366) no longer prints "100%" while 3 major rows are in it', () => {
      const comp = summarizeAdmittedRows([
        row('change', 'minor', 2018),
        row('change', 'nit', 345),
        row('bug', 'major', 3),
      ]);
      // The shape that produced the bug: Math.round(0.9987 * 100) === 100.
      expect(comp.total).toBe(2366);
      expect(Math.round((comp.lowSeverityShare ?? 0) * 100)).toBe(100);

      const rendered = formatLowSeverityShare(comp, 'row(s) in this lane');
      expect(rendered).toBe('2363 of 2366 row(s) in this lane (99.8%) are nit/minor severity');
      // The load-bearing assertion: the sentence cannot claim the non-low population is empty.
      expect(rendered).not.toContain('100%');
    });

    it('prints 100% ONLY when the non-low population is actually empty — it is a claim of emptiness, not a rounded number', () => {
      const allLow = summarizeAdmittedRows([row('change', 'nit', 40), row('change', 'minor', 60)]);
      expect(formatLowSeverityShare(allLow)).toBe('100 of 100 row(s) (100%) are nit/minor severity');

      // FALSIFIABILITY CONTROL: one single non-low row in a pool of 100,000 — a share that
      // rounds, floors and displays as 100.0 at any sane precision — must still not print it.
      const oneMajor = summarizeAdmittedRows([row('change', 'nit', 99_999), row('bug', 'critical', 1)]);
      expect(formatLowSeverityShare(oneMajor)).not.toContain('100%');
      expect(formatLowSeverityShare(oneMajor)).toBe('99999 of 100000 row(s) (99.9%) are nit/minor severity');
    });

    it('FLOORS rather than rounds, so "N%" is always safe to read as "at least N%"', () => {
      // 2 of 3 = 66.66…% → 66.6, never 66.7.
      const comp = summarizeAdmittedRows([row('change', 'nit', 2), row('bug', 'major', 1)]);
      expect(formatLowSeverityShare(comp)).toBe('2 of 3 row(s) (66.6%) are nit/minor severity');
    });

    it('drops a pointless trailing .0 and reports an empty pool as 0 of 0 rather than a percentage of nothing', () => {
      const half = summarizeAdmittedRows([row('change', 'minor', 5), row('bug', 'major', 5)]);
      expect(formatLowSeverityShare(half)).toBe('5 of 10 row(s) (50%) are nit/minor severity');
      expect(formatLowSeverityShare(summarizeAdmittedRows([]))).toBe('0 of 0 row(s) are nit/minor severity');
    });

    it('counts nit+minor only — an `unset` severity is unknown, never low, in the prose as in the buckets', () => {
      const comp = summarizeAdmittedRows([row('change', 'nit', 30), row('change', 'unset', 70)]);
      expect(formatLowSeverityShare(comp)).toBe('30 of 100 row(s) (30%) are nit/minor severity');
    });

    // The formatter above is only worth having if the sites that SAY this in prose route
    // through it. Both hand-rendered the same `Math.round(share * 100)` independently, so
    // fixing one would have left the other armed — and a third consumer would arrive at the
    // same expression by the same reasoning. Pin the callers, not just the function.
    it.each([
      ['work_items:claimable COMPOSITION WARNING', 'lib/agent-tools/work_items/claimable.ts'],
      ['fleet:launch-on-plan DEGENERATE LANE warning', 'lib/agent-tools/fleet_registry/launch-on-plan.ts'],
    ])('%s renders the share through formatLowSeverityShare, never a hand-rolled percentage', (_label, rel) => {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', rel), 'utf8');
      expect(source).toContain('formatLowSeverityShare');
      // Any arithmetic that turns the share into a percentage on its own is the defect.
      expect(source).not.toMatch(/Math\.(round|ceil)\s*\(\s*\(?[^)]*lowSeverityShare/);
    });
  });
});
