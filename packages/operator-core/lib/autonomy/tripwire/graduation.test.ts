/**
 * Unit tests for the autonomy graduation engine (B-16 / P-082, D-005).
 */
import { describe, it, expect } from 'vitest';
import type { AutonomyCategory } from '../categories';
import type { AutonomyCategoryPolicy } from '../policy';
import {
  buildAutonomyGraduationReport,
  computeAutonomyStandings,
  computeCategoryGraduationTargets,
  earnedLevelForStreak,
  gradKey,
  parseGradKey,
  tripwireEvidenceItems,
  DEFAULT_AUTONOMY_GRADUATION_POLICY,
} from './graduation';
import type { TripwireRow } from './store';

const POLICY = DEFAULT_AUTONOMY_GRADUATION_POLICY;

function row(over: Partial<TripwireRow> & { status: TripwireRow['status']; armedAtMs: number }): TripwireRow {
  return {
    id: `tw-${over.armedAtMs}`,
    workspaceId: 'default',
    category: 'implementation',
    findingClass: 'work_items:create',
    action: 'work_items:create',
    riskTier: 'low',
    reversibility: 'reversible',
    revertHandle: { kind: 'config-edit' },
    decision: null,
    decisionId: null,
    tripReason: null,
    windowUntilMs: over.armedAtMs + 86_400_000,
    resolvedAtMs: over.status === 'armed' ? null : over.armedAtMs + 86_400_000,
    revertedAtMs: null,
    resolvedBy: over.status === 'armed' ? null : 'sweep',
    ...over,
  };
}

function policy(over: Partial<AutonomyCategoryPolicy> & { category: AutonomyCategory }): AutonomyCategoryPolicy {
  return {
    ceiling: 'never-auto',
    locked: false,
    graduatedLevel: 'never-auto',
    thresholdOverrides: {},
    ownerOverride: null,
    ...over,
  };
}

function cleanRows(category: AutonomyCategory, findingClass: string, n: number): TripwireRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({ id: `tw-${category}-${i}`, category, findingClass, action: findingClass, status: 'cleared', armedAtMs: 1000 + i * 1000 }),
  );
}

/** A tripped (recurred) tripwire — real negative evidence (resolves earlier than cleanRows so it leads). */
function trippedRow(category: AutonomyCategory, findingClass: string, armedAtMs = 500): TripwireRow {
  return row({
    id: `tw-${category}-trip-${armedAtMs}`,
    category,
    findingClass,
    action: findingClass,
    status: 'tripped',
    tripReason: 'gym-regression',
    armedAtMs,
  });
}

describe('gradKey / parseGradKey', () => {
  it('round-trips a composite (category, class) key', () => {
    const k = gradKey('implementation', 'work_items:create');
    expect(parseGradKey(k)).toEqual({ category: 'implementation', findingClass: 'work_items:create' });
  });
});

describe('earnedLevelForStreak', () => {
  it('earns one ceiling-rank per completed threshold tier, clamped to the ceiling', () => {
    expect(earnedLevelForStreak(0, 10, 'critical')).toBe('never-auto');
    expect(earnedLevelForStreak(9, 10, 'critical')).toBe('never-auto');
    expect(earnedLevelForStreak(10, 10, 'critical')).toBe('trivial');
    expect(earnedLevelForStreak(20, 10, 'critical')).toBe('low');
    // Clamped to the owner ceiling, never above.
    expect(earnedLevelForStreak(50, 10, 'trivial')).toBe('trivial');
    expect(earnedLevelForStreak(50, 10, 'never-auto')).toBe('never-auto');
  });
});

describe('tripwireEvidenceItems', () => {
  it('maps status → lifecycle and a composite findingClass', () => {
    const items = tripwireEvidenceItems([
      row({ status: 'cleared', armedAtMs: 1 }),
      row({ status: 'tripped', armedAtMs: 2 }),
      row({ status: 'armed', armedAtMs: 3 }),
      row({ status: 'reverted', armedAtMs: 4 }),
    ]);
    expect(items.map((i) => i.lifecycle)).toEqual(['verified', 'recurred', 'applied', 'recurred']);
    expect(items[0]!.findingClass).toBe('implementation::work_items:create');
    expect(items.every((i) => i.autoDispatched && i.hasEvidence)).toBe(true);
  });
});

describe('computeAutonomyStandings', () => {
  it('counts a trailing clean streak; a trip resets it', () => {
    const standings = computeAutonomyStandings(cleanRows('implementation', 'work_items:create', 10), POLICY, 1e15);
    expect(standings).toHaveLength(1);
    expect(standings[0]!.cleanStreak).toBe(10);
    expect(standings[0]!.eligible).toBe(true);
    expect(standings[0]!.eligibleTier).toBe(10);
  });

  it('a tripped row in the middle resets the trailing streak', () => {
    const rows = [
      ...cleanRows('implementation', 'c', 5),
      row({ id: 'trip', category: 'implementation', findingClass: 'c', action: 'c', status: 'tripped', armedAtMs: 1000 + 5 * 1000 + 500 }),
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: `after-${i}`, category: 'implementation', findingClass: 'c', action: 'c', status: 'cleared', armedAtMs: 1000 + 6000 + i * 1000 }),
      ),
    ];
    const s = computeAutonomyStandings(rows, POLICY, 1e15)[0]!;
    expect(s.cleanStreak).toBe(3); // only the 3 after the trip
    expect(s.eligible).toBe(false);
  });
});

describe('computeCategoryGraduationTargets', () => {
  it('raises a category within its ceiling when a class earns it', () => {
    const standings = computeAutonomyStandings(cleanRows('implementation', 'work_items:create', 10), POLICY, 1e15);
    const policies = new Map([['implementation', policy({ category: 'implementation', ceiling: 'low' })]]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.targetGraduatedLevel).toBe('trivial'); // 10 passes = rank 1, ≤ ceiling 'low'
    expect(t!.shouldWrite).toBe(true);
  });

  it('never raises a category whose ceiling is never-auto (no change)', () => {
    const standings = computeAutonomyStandings(cleanRows('implementation', 'c', 30), POLICY, 1e15);
    const policies = new Map([['implementation', policy({ category: 'implementation', ceiling: 'never-auto' })]]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.targetGraduatedLevel).toBe('never-auto');
    expect(t!.shouldWrite).toBe(false);
  });

  it('never graduates a locked/protected category', () => {
    const standings = computeAutonomyStandings(cleanRows('release-deploy', 'deploy:run', 30), POLICY, 1e15);
    const policies = new Map([['release-deploy', policy({ category: 'release-deploy', ceiling: 'high', locked: true })]]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.shouldWrite).toBe(false);
    expect(t!.reason).toMatch(/locked|protected/);
  });

  it('honors the owner pin (frozen graduated_level)', () => {
    const standings = computeAutonomyStandings(cleanRows('implementation', 'c', 20), POLICY, 1e15);
    const policies = new Map([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', ownerOverride: { pinned: true } })],
    ]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.shouldWrite).toBe(false);
    expect(t!.reason).toMatch(/pinned/);
  });

  it('reconciles DOWN after a TRIP shrank the streak below the stored level', () => {
    // A trip (real negative evidence), then 10 clean passes (trailing streak earns
    // 'trivial') — the stored graduated_level is 'low'. Because there WAS a trip,
    // reconcile DOWN to the evidence-consistent level (demote stays alive).
    const standings = computeAutonomyStandings(
      [trippedRow('implementation', 'c'), ...cleanRows('implementation', 'c', 10)],
      POLICY,
      1e15,
    );
    const policies = new Map([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })],
    ]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.targetGraduatedLevel).toBe('trivial');
    expect(t!.shouldWrite).toBe(true);
    expect(t!.reason).toMatch(/reconcile|shrank|trip/);
  });

  it('EI-513 grace: HOLDS the owner level (no demote) when target<current with NO trip (cold start)', () => {
    // 10 clean passes earn 'trivial'; the owner armed graduated_level='low'; there
    // has been NO trip — the streak is short only because the category is freshly
    // armed + still accruing. Reconciling DOWN here is the cold-start DEADLOCK
    // (it would reset the owner grant toward never-auto before the Queen can earn
    // it). Must HOLD 'low' and write nothing.
    const standings = computeAutonomyStandings(cleanRows('implementation', 'c', 10), POLICY, 1e15);
    const policies = new Map([
      ['implementation', policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' })],
    ]);
    const [t] = computeCategoryGraduationTargets(standings, policies as never, POLICY);
    expect(t!.shouldWrite).toBe(false);
    expect(t!.reason).toMatch(/grace|hold|freshly armed/i);
  });
});

describe('buildAutonomyGraduationReport', () => {
  it('builds an owner ratification ask keyed per (category, class, tier)', () => {
    const s = computeAutonomyStandings(cleanRows('implementation', 'work_items:create', 10), POLICY, 1e15)[0]!;
    const report = buildAutonomyGraduationReport(s, 'low', POLICY);
    expect(report.category).toBe('implementation');
    expect(report.findingClass).toBe('work_items:create');
    expect(report.watchdogKey).toBe('autonomy-graduation:implementation:work_items:create:n10');
    expect(report.body).toMatch(/never automatic/i);
    expect(report.body).toMatch(/raise the \*\*ceiling\*\*/i);
  });
});
