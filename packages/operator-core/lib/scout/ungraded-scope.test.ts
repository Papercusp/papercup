/**
 * ungraded-scope.test.ts — pins THE definition of "ungraded" (P-010) and guards
 * against a fourth one appearing.
 *
 * The bug this covers was not arithmetic. Three surfaces each counted correctly and
 * disagreed by ~70x because each fixed the origin/terminality/epoch axes differently.
 * So these tests assert the AXES, one at a time and independently falsifiable — a test
 * that only checked a total would have passed against every one of the three wrong
 * readings.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyUngraded,
  summarizeUngraded,
  type UngradedRowLike,
} from './ungraded-scope';

const EPOCH = Date.parse('2026-07-11T00:00:00Z');
const AFTER = EPOCH + 86_400_000;
const BEFORE = EPOCH - 86_400_000;

const row = (over: Partial<UngradedRowLike> = {}): UngradedRowLike => ({
  origin: 'su-ideate',
  humanGrade: null,
  outcome: null,
  routedAtMs: AFTER,
  ...over,
});

describe('classifyUngraded — the three axes, each independently falsifiable', () => {
  it('CALIBRATION: an ungraded, open, post-epoch row is actionable', () => {
    // If this ever fails, the buckets below are all passing vacuously.
    expect(classifyUngraded(row(), { epochMs: EPOCH })).toBe('actionable');
  });

  it('axis GRADED: a row with a grade is never actionable, however open or recent', () => {
    expect(classifyUngraded(row({ humanGrade: 4 }), { epochMs: EPOCH })).toBe('graded');
    // grade 0 is a REAL grade, not a missing one — the classic falsy-vs-null trap
    expect(classifyUngraded(row({ humanGrade: 0 }), { epochMs: EPOCH })).toBe('graded');
  });

  it('axis TERMINALITY: a settled artifact is excluded, "pending" is not', () => {
    expect(classifyUngraded(row({ outcome: 'shipped' }), { epochMs: EPOCH })).toBe('terminal');
    expect(classifyUngraded(row({ outcome: 'dropped' }), { epochMs: EPOCH })).toBe('terminal');
    expect(classifyUngraded(row({ outcome: 'pending' }), { epochMs: EPOCH })).toBe('actionable');
  });

  it('axis EPOCH: D-013 is forward-only — a pre-epoch row is excluded even while open', () => {
    expect(classifyUngraded(row({ routedAtMs: BEFORE }), { epochMs: EPOCH })).toBe('pre-epoch');
    expect(classifyUngraded(row({ routedAtMs: EPOCH }), { epochMs: EPOCH })).toBe('actionable');
  });

  it('a missing/NaN clock is excluded rather than counted — never act blind on no timestamp', () => {
    expect(classifyUngraded(row({ routedAtMs: Number.NaN }), { epochMs: EPOCH })).toBe('pre-epoch');
  });

  it('ORIGIN never changes the bucket — it partitions the census, it does not exclude', () => {
    // The axis that produced the mislabel: scout rows are a different POPULATION, not a
    // different eligibility. Conflating the two is what turned 15 into "1,082 su filings".
    for (const origin of ['su-ideate', 'scout', 'drill']) {
      expect(classifyUngraded(row({ origin }), { epochMs: EPOCH })).toBe('actionable');
    }
  });
});

describe('summarizeUngraded', () => {
  const rows = [
    { origin: 'scout', actionable: 595, all_ungraded: 1088, pre_epoch: 8, terminal: 485 },
    { origin: 'su-ideate', actionable: 15, all_ungraded: 15, pre_epoch: 0, terminal: 0 },
    { origin: 'drill', actionable: 0, all_ungraded: 0, pre_epoch: 0, terminal: 0 },
  ];

  it('keeps each origin separately addressable instead of summing them into one scalar', () => {
    const b = summarizeUngraded(rows, EPOCH);
    expect(b.actionableByOrigin['su-ideate']).toBe(15);
    expect(b.actionableByOrigin.scout).toBe(595);
    expect(b.actionable).toBe(610);
  });

  it('ACCOUNTS for the gap: allUngraded === actionable + preEpoch + terminal', () => {
    // The invariant that makes the 15-vs-1,103 discrepancy explainable rather than
    // alarming. If a future axis is added and not accounted for, this fails.
    const b = summarizeUngraded(rows, EPOCH);
    expect(b.allUngraded).toBe(b.actionable + b.excluded.preEpoch + b.excluded.terminal);
  });

  it('carries the epoch it was taken against, so a stored census stays interpretable', () => {
    expect(summarizeUngraded(rows, EPOCH).epochMs).toBe(EPOCH);
  });

  it('an empty read is a real zero, not a crash', () => {
    const b = summarizeUngraded([], EPOCH);
    expect(b).toMatchObject({ actionable: 0, allUngraded: 0 });
  });
});

/**
 * RECURRENCE GUARD. The drift did not arrive as one bad commit — it arrived as three
 * independent files each writing the predicate inline, none of them wrong on its own.
 * Nothing structural stopped a fourth, so this does.
 */
describe('P-010 recurrence guard: one definition, not four', () => {
  /**
   * Scans ALL of operator-core/lib, not just scout/. That scope is the whole point:
   * the surface that actually drifted was `system-health/compute.ts`, in a different
   * directory from the definition it disagreed with. A guard confined to scout/ would
   * have passed cleanly through the incident it exists to prevent.
   */
  const libRoot = join(__dirname, '..');

  /** Files allowed to write the predicate themselves, each for a stated reason. */
  const SANCTIONED: Record<string, string> = {
    'scout/ungraded-scope.ts': 'this module IS the definition',
    'scout/ungraded-filings-watchdog.ts':
      'selects ROWS to nudge on (its own ORDER/LIMIT/batch cap), not a census',
    'watchdog/status.ts':
      'su-ideate ELIGIBILITY against the watchdog threshold, not a population count; ' +
      'shares the watchdog config so it cannot drift from it independently',
  };

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '_retired') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(full);
    }
    return acc;
  };

  it('no module outside the sanctioned set defines "ungraded" for itself', () => {
    const offenders = walk(libRoot)
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // Only flag it inside a SQL template — prose describing the definition is fine.
        return /human_grade IS NULL/.test(src) && /sql</.test(src);
      })
      .map((f) => f.slice(libRoot.length + 1).split(/[\\/]/).join('/'))
      .sort();

    expect(
      offenders,
      'these modules define "ungraded" themselves instead of calling readUngradedBreakdown ' +
        'from scout/ungraded-scope.ts. That is exactly how one workspace reported 15, 1,103 ' +
        'and "1,082 su filings" for the same question on the same day. If a new one is ' +
        'legitimate, add it to SANCTIONED with the reason it is not a census.',
    ).toEqual(Object.keys(SANCTIONED).sort());
  });

  it('CALIBRATION: the scan actually reaches outside scout/ (else the guard is vacuous)', () => {
    // Pins the fix to this guard's own blind spot: system-health/ must be in range, or
    // the assertion above proves nothing about the file that caused the incident.
    const scanned = walk(libRoot).map((f) => f.slice(libRoot.length + 1));
    expect(scanned.some((f) => f.includes('system-health'))).toBe(true);
    expect(scanned.length).toBeGreaterThan(100);
  });
});
