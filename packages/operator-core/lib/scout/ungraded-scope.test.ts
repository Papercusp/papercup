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
  epochMsForOrigin,
  summarizeUngraded,
  DEFAULT_UNGRADED_EPOCH_POLICY,
  SCOUT_UNGRADED_EPOCH_MS,
  SU_IDEATE_UNGRADED_EPOCH_MS,
  type UngradedEpochPolicy,
  type UngradedRowLike,
} from './ungraded-scope';

const EPOCH = Date.parse('2026-07-11T00:00:00Z');
const AFTER = EPOCH + 86_400_000;
const BEFORE = EPOCH - 86_400_000;

/**
 * A SINGLE-floor policy: every origin falls back to one epoch. This is exactly the
 * pre-D-014 behaviour, kept so the three original axes stay testable in isolation from
 * the per-origin floor — an axis test that also varied the floor would stop being
 * independently falsifiable, which is the property this file is built on.
 */
const flat = (epochMs: number): UngradedEpochPolicy => ({ byOrigin: {}, fallbackMs: epochMs });

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
    expect(classifyUngraded(row(), { policy: flat(EPOCH) })).toBe('actionable');
  });

  it('axis GRADED: a row with a grade is never actionable, however open or recent', () => {
    expect(classifyUngraded(row({ humanGrade: 4 }), { policy: flat(EPOCH) })).toBe('graded');
    // grade 0 is a REAL grade, not a missing one — the classic falsy-vs-null trap
    expect(classifyUngraded(row({ humanGrade: 0 }), { policy: flat(EPOCH) })).toBe('graded');
  });

  it('axis TERMINALITY: a settled artifact is excluded, "pending" is not', () => {
    expect(classifyUngraded(row({ outcome: 'shipped' }), { policy: flat(EPOCH) })).toBe('terminal');
    expect(classifyUngraded(row({ outcome: 'dropped' }), { policy: flat(EPOCH) })).toBe('terminal');
    expect(classifyUngraded(row({ outcome: 'pending' }), { policy: flat(EPOCH) })).toBe('actionable');
  });

  it('axis EPOCH: D-013 is forward-only — a pre-epoch row is excluded even while open', () => {
    expect(classifyUngraded(row({ routedAtMs: BEFORE }), { policy: flat(EPOCH) })).toBe('pre-epoch');
    expect(classifyUngraded(row({ routedAtMs: EPOCH }), { policy: flat(EPOCH) })).toBe('actionable');
  });

  it('a missing/NaN clock is excluded rather than counted — never act blind on no timestamp', () => {
    expect(classifyUngraded(row({ routedAtMs: Number.NaN }), { policy: flat(EPOCH) })).toBe('pre-epoch');
  });

  it('ORIGIN never changes the bucket UNDER A SHARED FLOOR — it partitions the census', () => {
    // The axis that produced the mislabel: scout rows are a different POPULATION, not a
    // different eligibility. Conflating the two is what turned 15 into "1,082 su filings".
    // NOTE (D-014): this now says "under a shared floor" for a reason. Origin is no
    // longer inert — it SELECTS the floor (see the per-origin describe below). What
    // remained true, and is what actually prevented the 70x mislabel, is the accounting
    // invariant: every row still lands in exactly one of the four buckets.
    for (const origin of ['su-ideate', 'scout', 'drill']) {
      expect(classifyUngraded(row({ origin }), { policy: flat(EPOCH) })).toBe('actionable');
    }
  });
});

/**
 * D-014. The single-epoch read was not arithmetically wrong either — it applied one
 * producer's floor to every producer, which drew scout's line in a place chosen for the
 * su-ideate corpus and left 592 rows in an "actionable" backlog nobody had decided to own.
 */
describe('D-014 per-origin epoch floor', () => {
  it('CALIBRATION: the two shipped floors are distinct, else every test below is vacuous', () => {
    expect(SU_IDEATE_UNGRADED_EPOCH_MS).toBe(Date.parse('2026-07-11T00:00:00Z'));
    expect(SCOUT_UNGRADED_EPOCH_MS).toBe(Date.parse('2026-08-12T00:00:00Z'));
    expect(SCOUT_UNGRADED_EPOCH_MS).toBeGreaterThan(SU_IDEATE_UNGRADED_EPOCH_MS);
  });

  it('THE BUG THIS FIXES: one timestamp, two producers, two verdicts', () => {
    // 2026-07-20 — after the su-ideate floor, before scout's. Under the single-epoch read
    // BOTH were 'actionable'; that is the whole 592-row backlog in one assertion.
    const t = Date.parse('2026-07-20T00:00:00Z');
    const policy = DEFAULT_UNGRADED_EPOCH_POLICY;
    expect(classifyUngraded(row({ origin: 'su-ideate', routedAtMs: t }), { policy })).toBe('actionable');
    expect(classifyUngraded(row({ origin: 'scout', routedAtMs: t }), { policy })).toBe('pre-epoch');
  });

  it('an unknown origin gets the FALLBACK, never silent exclusion behind another floor', () => {
    const policy = DEFAULT_UNGRADED_EPOCH_POLICY;
    expect(epochMsForOrigin(policy, 'a-producer-added-next-quarter')).toBe(policy.fallbackMs);
    // And the fallback is the OLDEST floor on purpose: a new producer must over-count
    // (visible, recoverable) rather than vanish behind someone else's cut (invisible).
    expect(policy.fallbackMs).toBeLessThanOrEqual(Math.min(...Object.values(policy.byOrigin)));
  });

  it('a non-finite floor falls back instead of poisoning every comparison against it', () => {
    // `routedAtMs < NaN` is false, so a NaN floor would silently mark EVERY row
    // actionable — the failure mode that looks like a healthy census.
    const broken: UngradedEpochPolicy = { byOrigin: { scout: Number.NaN }, fallbackMs: EPOCH };
    expect(epochMsForOrigin(broken, 'scout')).toBe(EPOCH);
    expect(classifyUngraded(row({ origin: 'scout', routedAtMs: BEFORE }), { policy: broken })).toBe('pre-epoch');
  });
});

describe('summarizeUngraded', () => {
  const rows = [
    { origin: 'scout', actionable: 595, all_ungraded: 1088, pre_epoch: 8, terminal: 485 },
    { origin: 'su-ideate', actionable: 15, all_ungraded: 15, pre_epoch: 0, terminal: 0 },
    { origin: 'drill', actionable: 0, all_ungraded: 0, pre_epoch: 0, terminal: 0 },
  ];

  it('keeps each origin separately addressable instead of summing them into one scalar', () => {
    const b = summarizeUngraded(rows, flat(EPOCH));
    expect(b.actionableByOrigin['su-ideate']).toBe(15);
    expect(b.actionableByOrigin.scout).toBe(595);
    expect(b.actionable).toBe(610);
  });

  it('ACCOUNTS for the gap: allUngraded === actionable + preEpoch + terminal', () => {
    // The invariant that makes the 15-vs-1,103 discrepancy explainable rather than
    // alarming. If a future axis is added and not accounted for, this fails.
    const b = summarizeUngraded(rows, flat(EPOCH));
    expect(b.allUngraded).toBe(b.actionable + b.excluded.preEpoch + b.excluded.terminal);
  });

  it('carries the POLICY it was taken against, so a stored census stays interpretable', () => {
    // D-014: one number cannot describe a multi-origin census any more, so the whole
    // floor set travels with it. A census stored with only "the epoch" is a wrong answer
    // to "which line was drawn here" for every origin but one.
    const policy = DEFAULT_UNGRADED_EPOCH_POLICY;
    const b = summarizeUngraded(rows, policy);
    expect(b.policy).toBe(policy);
    expect(epochMsForOrigin(b.policy, 'scout')).toBe(SCOUT_UNGRADED_EPOCH_MS);
    expect(epochMsForOrigin(b.policy, 'su-ideate')).toBe(SU_IDEATE_UNGRADED_EPOCH_MS);
  });

  it('an empty read is a real zero, not a crash', () => {
    const b = summarizeUngraded([], flat(EPOCH));
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
  };
  // P-001 (agent-review-filing-rail-and-class-aggregation-2026-09-05): this set used to
  // hold three entries. `scout/ungraded-filings-watchdog.ts` and `watchdog/status.ts`
  // each wrote the predicate for a stated reason — "row selection, not a census" and
  // "eligibility, not a population count" — and BOTH reasons were true and both files
  // still drifted, because each one silently scoped itself to origin='su-ideate' while
  // the census governed every producer. Measured 2026-09-02 (EI-22180311569503146): the
  // rail acted on 22 of 1,675 actionable rows and agent-review's 1,397 had no consumer.
  // A sanctioned exception whose reason is about the SHAPE of the read (rows vs counts)
  // does not protect the AXES, which is what actually drifts. Both now call this module,
  // so the exception list is the definition itself and nothing else. Do not re-add an
  // entry here to make a widened read compile; add the read to ungraded-scope.ts.

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
