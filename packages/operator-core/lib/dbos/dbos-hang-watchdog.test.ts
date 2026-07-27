/**
 * dbos-hang-watchdog.test.ts — the pure sweep evaluator (EI-18754773151573358): a
 * workflow whose recovery_attempts advances between two sweeps while its max
 * operation_outputs.function_id does not is a hang being loyally re-run by DBOS,
 * not slow progress.
 */
import { describe, expect, it } from 'vitest';
import { evaluateHangSweep, type HangCandidate, type HangTrackedState } from './dbos-hang-watchdog';

function candidate(overrides: Partial<HangCandidate> = {}): HangCandidate {
  return {
    workflowUuid: 'wf-1',
    name: 'routineFire',
    recoveryAttempts: 3,
    maxFunctionId: 7,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe('evaluateHangSweep (EI-18754773151573358)', () => {
  it('never alarms on first sight — records a baseline only', () => {
    const out = evaluateHangSweep([candidate()], new Map(), 100_000);
    expect(out.alerts).toEqual([]);
    expect(out.nextState.get('wf-1')).toEqual({
      recoveryAttempts: 3,
      maxFunctionId: 7,
      alreadyLogged: false,
    });
  });

  it('alarms when recovery_attempts advances but max function_id does not (the smoking gun)', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 2, maxFunctionId: 7, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 3, maxFunctionId: 7, createdAtMs: 1_000 })], prev, 601_000);
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0]).toMatchObject({
      workflowUuid: 'wf-1',
      recoveryAttempts: 3,
      priorRecoveryAttempts: 2,
      maxFunctionId: 7,
      ageMs: 600_000,
    });
    expect(out.nextState.get('wf-1')!.alreadyLogged).toBe(true);
  });

  it('does NOT alarm when function_id advances alongside recovery_attempts (real progress)', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 2, maxFunctionId: 7, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 3, maxFunctionId: 8 })], prev, 100_000);
    expect(out.alerts).toEqual([]);
  });

  it('does NOT alarm when recovery_attempts has not advanced yet (no new event to judge)', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 3, maxFunctionId: 7, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 3, maxFunctionId: 7 })], prev, 100_000);
    expect(out.alerts).toEqual([]);
    expect(out.nextState.get('wf-1')!.alreadyLogged).toBe(false);
  });

  it('treats "never checkpointed a single step, ever" (both null) as no progress — still alarms once recovered again', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 2, maxFunctionId: null, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 3, maxFunctionId: null })], prev, 100_000);
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].maxFunctionId).toBeNull();
  });

  it('logs a stuck hang only ONCE per episode, not every sweep it stays stuck', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 3, maxFunctionId: 7, alreadyLogged: true }],
    ]);
    // Another recovery happens, still no progress — already flagged, no re-alarm.
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 4, maxFunctionId: 7 })], prev, 100_000);
    expect(out.alerts).toEqual([]);
    expect(out.nextState.get('wf-1')!.alreadyLogged).toBe(true);
  });

  it('reports recovery when a previously-stuck workflow finally advances', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 3, maxFunctionId: 7, alreadyLogged: true }],
    ]);
    const out = evaluateHangSweep([candidate({ recoveryAttempts: 3, maxFunctionId: 9 })], prev, 100_000);
    expect(out.alerts).toEqual([]);
    expect(out.recovered).toEqual(['wf-1']);
    expect(out.nextState.get('wf-1')!.alreadyLogged).toBe(false);
  });

  it('reports recovery when a previously-stuck workflow disappears from the candidate set (completed/GC\'d)', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-1', { recoveryAttempts: 3, maxFunctionId: 7, alreadyLogged: true }],
      ['wf-2', { recoveryAttempts: 2, maxFunctionId: 1, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep([], prev, 100_000);
    expect(out.recovered).toEqual(['wf-1']); // wf-2 was never flagged, so no note
    expect(out.nextState.size).toBe(0);
  });

  it('handles several independent workflows in one sweep without cross-contamination', () => {
    const prev = new Map<string, HangTrackedState>([
      ['wf-stuck', { recoveryAttempts: 2, maxFunctionId: 3, alreadyLogged: false }],
      ['wf-healthy', { recoveryAttempts: 2, maxFunctionId: 3, alreadyLogged: false }],
    ]);
    const out = evaluateHangSweep(
      [
        candidate({ workflowUuid: 'wf-stuck', recoveryAttempts: 3, maxFunctionId: 3 }),
        candidate({ workflowUuid: 'wf-healthy', recoveryAttempts: 3, maxFunctionId: 4 }),
      ],
      prev,
      100_000,
    );
    expect(out.alerts.map((a) => a.workflowUuid)).toEqual(['wf-stuck']);
  });
});
