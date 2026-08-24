/**
 * Platform-mode gate for the improvement-watchdog/triage/implement seed
 * (per-hive-learning-loops-2026-06-14 P-070). These are LAYER-3
 * platform-improvement (Class-C) loops: when the PLATFORM_IMPROVEMENT_LOOPS knob
 * is OFF (a public release before the user opts into platform mode) they seed
 * INACTIVE regardless of the --active / --arm-implement CLI levers.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { classifyRoutine } from '../../automation/catalog';
import { LEARNING_ROUTINE_GROUP } from './loop-control';
import { IMPROVEMENT_ROUTINES, resolveImprovementRoutineActive } from './seed-improvement-routines';

const LEARNING_GROUP_REPAIR_MIGRATION = new URL(
  '../../../../../libs/papercusp/libs/db/sql/942-learning-routine-group-completeness-sql.sql',
  import.meta.url,
);

const watchdog = { arm: 'safe' as const }; // improvement-watchdog / improvement-triage
const implement = { arm: 'owner' as const }; // improvement-implement (owner-gated)

describe('improvement routine membership — Learning tab Pause all', () => {
  it('seeds every improvement routine into the group controlled by learning.loopControl', () => {
    expect(IMPROVEMENT_ROUTINES.length).toBeGreaterThan(0);
    for (const routine of IMPROVEMENT_ROUTINES) {
      expect(routine.group, routine.name).toBe(LEARNING_ROUTINE_GROUP);
    }

    // The classifier deliberately puts knowledge-pack routines in Docs, but they
    // are still part of the improvement-loop control surface and must be grouped
    // with the rest of the seed set. The learning-classified members are the
    // concrete regression that previously leaked outside Pause all.
    const learningNames = IMPROVEMENT_ROUTINES.filter(
      (routine) => classifyRoutine(routine.name, null) === 'learning',
    ).map((routine) => routine.name);
    expect(learningNames).toEqual([
      'improvement-watchdog',
      'improvement-triage',
      'improvement-invalid-args-miner',
      'improvement-implement',
    ]);
  });

  it('keeps the post-617 repair migration aligned with every seeded routine name', () => {
    const sql = readFileSync(LEARNING_GROUP_REPAIR_MIGRATION, 'utf8');
    for (const routine of IMPROVEMENT_ROUTINES) {
      if (routine.name.startsWith('improvement-')) {
        expect(sql, routine.name).toContain("r.name LIKE 'improvement-%'");
      } else {
        expect(sql, routine.name).toContain(`'${routine.name}'`);
      }
    }
    expect(sql).toMatch(/SET\s+group_slug\s*=\s*'self-improvement'/i);
    expect(sql).toMatch(/IS DISTINCT FROM\s*'self-improvement'/i);
  });
});

describe('resolveImprovementRoutineActive — platform-mode gate (P-070)', () => {
  it('platform mode OFF forces EVERY routine inactive, even with --active --arm-implement', () => {
    expect(
      resolveImprovementRoutineActive(watchdog, { active: true, armImplement: true, platformLoopsOn: false }),
    ).toBe(false);
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: true, platformLoopsOn: false }),
    ).toBe(false);
  });

  it('platform mode ON preserves the existing CLI semantics for the safe (watchdog) tier', () => {
    expect(
      resolveImprovementRoutineActive(watchdog, { active: false, armImplement: false, platformLoopsOn: true }),
    ).toBe(false); // not --active ⇒ inactive
    expect(
      resolveImprovementRoutineActive(watchdog, { active: true, armImplement: false, platformLoopsOn: true }),
    ).toBe(true); // --active ⇒ live
  });

  it('platform mode ON preserves the owner-gated implement tier (needs BOTH --active + --arm-implement)', () => {
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: false, platformLoopsOn: true }),
    ).toBe(false); // --active alone is not enough for the implement routine
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: true, platformLoopsOn: true }),
    ).toBe(true); // both ⇒ live
  });
});
