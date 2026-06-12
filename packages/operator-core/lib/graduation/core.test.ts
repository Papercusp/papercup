/**
 * core.test.ts — graduation evidence counting (self-learning-frontier
 * P-045/P-046 / FB-19). Pure, no IO. Pins the P-046 counting rules:
 *
 *   - a clean pass = auto-dispatched + evidenced + decay-VERIFIED + no
 *     gym/EKG regression inside its recurrence window;
 *   - recurrence, missing evidence, or an in-window regression RESETS the
 *     consecutive streak; in-window passes neither count nor reset;
 *   - human-lane resolutions are skipped entirely;
 *   - the never-graduate protected set (loop/auth/deploy/budgets) is never
 *     eligible regardless of streak — the FB-22 invariant surface;
 *   - eligibility tiers (n10, n20 …) key the report dedup;
 *   - the owner report NEVER proposes an automatic autoKinds edit.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGraduationReport,
  computeGraduationStandings,
  DEFAULT_GRADUATION_POLICY,
  findingClassOf,
  GRADUATION_REPORT_CLASS,
  graduationWatchdogKey,
  isNeverGraduateClass,
  type GraduationEvidenceItem,
  type RegressionEvent,
} from './core';

const DAY = 86_400_000;
const T0 = 1_750_000_000_000;
const NOW = T0 + 120 * DAY;

let seq = 0;
function item(over: Partial<GraduationEvidenceItem> = {}): GraduationEvidenceItem {
  seq += 1;
  return {
    id: `EI-${100 + seq}`,
    findingClass: 'negative-space:resolution-gap',
    resolvedAtMs: T0 + seq * DAY,
    lifecycle: 'verified',
    autoDispatched: true,
    hasEvidence: true,
    ...over,
  };
}

function cleanRun(n: number, cls = 'negative-space:resolution-gap'): GraduationEvidenceItem[] {
  return Array.from({ length: n }, () => item({ findingClass: cls }));
}

describe('findingClassOf (P-044 class identity with fallbacks)', () => {
  it('prefers payload.findingClass', () => {
    expect(
      findingClassOf({ findingClass: 'regret:process-counterfactual', watchdogKey: 'regret:run-9', kind: 'bug' }),
    ).toBe('regret:process-counterfactual');
  });
  it('falls back to the watchdog signal family, then ideaType, then kind', () => {
    expect(findingClassOf({ watchdogKey: 'flake:lib/foo.test.ts', kind: 'bug' })).toBe('flake:unclassified');
    expect(findingClassOf({ ideaType: 'code-bug', kind: 'bug' })).toBe('code-bug:unclassified');
    expect(findingClassOf({ kind: 'change' })).toBe('change:unclassified');
    expect(findingClassOf({})).toBe('unknown:unclassified');
  });
});

describe('computeGraduationStandings — the counting rules', () => {
  it('counts consecutive clean verified auto-passes toward the threshold', () => {
    const [s] = computeGraduationStandings(cleanRun(10), [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(10);
    expect(s.eligible).toBe(true);
    expect(s.eligibleTier).toBe(10);
  });

  it('below threshold ⇒ not eligible', () => {
    const [s] = computeGraduationStandings(cleanRun(9), [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(9);
    expect(s.eligible).toBe(false);
    expect(s.eligibleTier).toBeNull();
  });

  it('a recurrence RESETS the streak (consecutive, not cumulative)', () => {
    const items = [...cleanRun(6), item({ lifecycle: 'recurred' }), ...cleanRun(4)];
    const [s] = computeGraduationStandings(items, [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(4);
    expect(s.totalRecurred).toBe(1);
    expect(s.eligible).toBe(false);
  });

  it('an auto-resolved pass WITHOUT evidence resets the streak (a dirty pass)', () => {
    const items = [...cleanRun(8), item({ hasEvidence: false }), ...cleanRun(3)];
    const [s] = computeGraduationStandings(items, [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(3);
    expect(s.totalDirty).toBe(1);
  });

  it('a gym/EKG regression inside a pass window resets the streak', () => {
    const items = cleanRun(12);
    // Land a regression inside the 7th pass's 14d window.
    const regressions: RegressionEvent[] = [
      { atMs: items[6].resolvedAtMs + 3 * DAY, source: 'ekg', label: 'major fleet-EKG shift (medianGapMs)' },
    ];
    const [s] = computeGraduationStandings(items, regressions, DEFAULT_GRADUATION_POLICY, NOW);
    // Passes 1..7 all have the event inside [resolvedAt, resolvedAt+14d]
    // (their windows overlap), so the streak restarts after the last dirty one.
    expect(s.cleanStreak).toBeLessThan(12);
    expect(s.totalDirty).toBeGreaterThan(0);
    const dirty = s.passes.filter((p) => p.verdict === 'window-regression');
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty[0].regressions?.[0].source).toBe('ekg');
  });

  it('a regression OUTSIDE every window leaves the streak intact', () => {
    const items = cleanRun(10);
    const regressions: RegressionEvent[] = [
      { atMs: items[9].resolvedAtMs + 30 * DAY, source: 'gym', label: 'gym champion regressed' },
    ];
    const [s] = computeGraduationStandings(items, regressions, DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(10);
    expect(s.eligible).toBe(true);
  });

  it("an 'applied' pass still in (or awaiting) its decay window neither counts nor resets", () => {
    const items = [...cleanRun(10), item({ lifecycle: 'applied', resolvedAtMs: NOW - 2 * DAY })];
    const [s] = computeGraduationStandings(items, [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(10);
    expect(s.pendingWindow).toBe(1);
    expect(s.eligible).toBe(true);
  });

  it('human-lane resolutions are skipped — neither pass nor counter-evidence', () => {
    const items = [...cleanRun(10), item({ autoDispatched: false, lifecycle: 'recurred' })];
    const [s] = computeGraduationStandings(items, [], DEFAULT_GRADUATION_POLICY, NOW);
    // The human-lane recurrence does NOT reset the auto streak.
    expect(s.cleanStreak).toBe(10);
    expect(s.totalRecurred).toBe(0);
  });

  it('classes are counted independently and sorted strongest-first', () => {
    const items = [...cleanRun(11, 'negative-space:resolution-gap'), ...cleanRun(3, 'flake:unclassified')];
    const standings = computeGraduationStandings(items, [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(standings.map((s) => s.findingClass)).toEqual([
      'negative-space:resolution-gap',
      'flake:unclassified',
    ]);
    expect(standings[0].eligible).toBe(true);
    expect(standings[1].eligible).toBe(false);
  });

  it('passes are ordered by resolution time, not input order', () => {
    const a = item({ lifecycle: 'recurred' }); // earliest
    const rest = cleanRun(10);
    a.resolvedAtMs = rest[0].resolvedAtMs - 5 * DAY;
    const [s] = computeGraduationStandings([...rest, a], [], DEFAULT_GRADUATION_POLICY, NOW);
    // The early recurrence sits BEFORE the clean run — streak stays 10.
    expect(s.cleanStreak).toBe(10);
  });
});

describe('the never-graduate protected set (P-046 / FB-22 invariant surface)', () => {
  it.each([
    'deploy:rollback-edge',
    'auth:session-rotation',
    'release:gate-tuning',
    'budget:cap-resize',
    'flags:default-flip',
    'migration:schema-change',
    'git-sync:cadence',
    'graduation:eligibility-report',
    'governor:budget-edit',
    'locks:ttl-tuning',
  ])('%s is never eligible regardless of streak', (cls) => {
    expect(isNeverGraduateClass(cls)).toBe(true);
    const [s] = computeGraduationStandings(cleanRun(50, cls), [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s.cleanStreak).toBe(50);
    expect(s.neverGraduate).toBe(true);
    expect(s.eligible).toBe(false);
    expect(s.eligibleTier).toBeNull();
  });

  it('an ordinary miner class is not in the protected set', () => {
    expect(isNeverGraduateClass('negative-space:resolution-gap')).toBe(false);
    expect(isNeverGraduateClass('regret:process-counterfactual')).toBe(false);
  });

  it("the tracker's own report class is protected (reflexive — the loop never graduates itself)", () => {
    expect(isNeverGraduateClass(GRADUATION_REPORT_CLASS)).toBe(true);
  });
});

describe('report identity + content', () => {
  it('watchdog keys are tiered so a rejected n10 ask re-files only at n20 (doubled evidence)', () => {
    expect(graduationWatchdogKey('flake:unclassified', 10)).toBe('graduation:flake:unclassified:n10');
    expect(graduationWatchdogKey('flake:unclassified', 20)).toBe('graduation:flake:unclassified:n20');
    const [s20] = computeGraduationStandings(cleanRun(20), [], DEFAULT_GRADUATION_POLICY, NOW);
    expect(s20.eligibleTier).toBe(20);
  });

  it('the owner report is a ratification ASK — never an automatic autoKinds edit', () => {
    const [s] = computeGraduationStandings(cleanRun(10), [], DEFAULT_GRADUATION_POLICY, NOW);
    const report = buildGraduationReport(s);
    expect(report.title).toContain('negative-space:resolution-gap');
    expect(report.title).toContain('10 consecutive clean auto-passes');
    expect(report.body).toContain('NEVER automatic');
    expect(report.body).toContain('Owner ratification ask');
    expect(report.body).toContain('policy.ts');
    expect(report.watchdogKey).toBe('graduation:negative-space:resolution-gap:n10');
  });
});
