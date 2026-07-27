/**
 * Dark learning-target audit (plan gym-real-fitness-signal-2026-07-27, P-012).
 *
 * The property under test is VISIBILITY, not correctness of arming: a registered target
 * that produces no signal must be REPORTED, whatever the reason. The real-signal gym sat
 * dark for weeks precisely because "not armed" is not an error, fires no gate, and so
 * appeared nowhere.
 */
import { describe, expect, it } from 'vitest';
import { auditDarkLearningTargets, type DarkAuditAutoloopRow } from './dark-target-audit';
import type { LearningGymTarget } from './learning-targets';

const target = (
  key: string,
  signals: string[] = ['drillResolveRate'],
  promptSurface = 'prompt-override',
): LearningGymTarget =>
  ({
    key,
    title: `${key} title`,
    role: 'worker',
    blueprintId: 'implement',
    promptSurface,
    signals,
    drillClasses: ['*'],
    rationale: 'because',
  }) as unknown as LearningGymTarget;

const row = (over: Partial<DarkAuditAutoloopRow> = {}): DarkAuditAutoloopRow => ({
  harnessSlug: 'papercusp',
  enabled: true,
  budgetUsd: 50,
  lastCycleAt: 1_700_000_000_000,
  ...over,
});

const onPapercusp = () => 'papercusp';

describe('auditDarkLearningTargets', () => {
  it('reports the ACTUAL live state: the D-001 dark default (enabled:false) is dark', () => {
    const a = auditDarkLearningTargets({
      rows: [row({ enabled: false, budgetUsd: null, lastCycleAt: null })],
      resolveHarness: onPapercusp,
      targets: [target('implement-worker')],
    });
    expect(a.dark).toHaveLength(1);
    expect(a.dark[0]!.reason).toBe('disabled');
    expect(a.dark[0]!.detail).toContain('drillResolveRate'); // names the signal it WOULD produce
    expect(a.headline).toContain('1 of 1 autoloop-eligible learning target(s) produce NO signal');
    expect(a.liveKeys).toEqual([]);
  });

  it('distinguishes the four ways a target produces no signal', () => {
    const cases: Array<[DarkAuditAutoloopRow[] | 'none', string]> = [
      ['none', 'unregistered'],
      [[row({ enabled: false })], 'disabled'],
      [[row({ budgetUsd: null })], 'unbudgeted'],
      [[row({ budgetUsd: 0 })], 'unbudgeted'],
      [[row({ lastCycleAt: null })], 'never-ran'],
    ];
    for (const [rows, expected] of cases) {
      const a = auditDarkLearningTargets({
        rows: rows === 'none' ? [] : rows,
        resolveHarness: onPapercusp,
        targets: [target('implement-worker')],
      });
      expect(a.dark[0]?.reason, `case ${expected}`).toBe(expected);
    }
  });

  it('an UNRESOLVABLE harness counts as dark, not as excused', () => {
    // A missing prerequisite (e.g. PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS unset) must
    // surface — silently skipping such a target is how one hides.
    const a = auditDarkLearningTargets({
      rows: [row()],
      resolveHarness: () => null,
      targets: [target('implement-worker')],
    });
    expect(a.dark[0]!.reason).toBe('unregistered');
  });

  it('is SILENT only when a target is armed, budgeted AND has actually run', () => {
    const a = auditDarkLearningTargets({
      rows: [row()],
      resolveHarness: onPapercusp,
      targets: [target('implement-worker')],
    });
    expect(a.dark).toEqual([]);
    expect(a.headline).toBe('');
    expect(a.liveKeys).toEqual(['implement-worker']);
  });

  it('orders findings most-severe first so a wake report leads with the worst', () => {
    const a = auditDarkLearningTargets({
      rows: [
        { harnessSlug: 'h-disabled', enabled: false, budgetUsd: 50, lastCycleAt: 1 },
        { harnessSlug: 'h-neverran', enabled: true, budgetUsd: 50, lastCycleAt: null },
      ],
      resolveHarness: (t) =>
        t.key === 'implement-worker' ? 'h-neverran' : t.key === 'triage-classifier' ? 'h-disabled' : null,
      targets: [target('implement-worker'), target('triage-classifier'), target('scout-ideators')],
    });
    // unregistered (scout-ideators) → disabled (triage) → never-ran (implement)
    expect(a.dark.map((d) => d.reason)).toEqual(['unregistered', 'disabled', 'never-ran']);
    expect(a.registered).toBe(3);
  });

  it('EXCLUDES targets with no prompt-override surface instead of crying wolf', () => {
    // The triage classifier is a persona and the Scout ideators are code-constructed
    // lenses: seed-learning-gym-targets.ts gives them NO autoloop row by design, so
    // flagging them dark would be a false alarm — but they must still be listed, so
    // "excluded by design" never looks like "quietly missing".
    const a = auditDarkLearningTargets({
      rows: [row()],
      resolveHarness: onPapercusp,
      targets: [
        target('implement-worker'),
        target('triage-classifier', ['triageAccuracy'], 'persona'),
        target('scout-ideators', ['mttsh'], 'code-constructed'),
      ],
    });
    expect(a.dark).toEqual([]); // implement-worker is armed; the other two are excluded
    expect(a.notAutoloopEligible).toEqual(['triage-classifier', 'scout-ideators']);
    expect(a.registered).toBe(1); // the denominator counts only eligible targets
    expect(a.headline).toBe('');
  });

  it('the headline explains WHY silence was the bug, so a reader cannot dismiss it', () => {
    const a = auditDarkLearningTargets({
      rows: [],
      resolveHarness: onPapercusp,
      targets: [target('implement-worker')],
    });
    expect(a.headline).toContain('fires no gate');
  });
});
