import { describe, it, expect } from 'vitest';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  CRITICAL_ROUTINE_ACTIONS,
  queueForRoutine,
  shouldFireUnderPoolShed,
} from './routines-queue-classification';

/**
 * 2026-06-23 routines-queue-starvation fix: git-sync must land on the protected `routines-critical` lane so
 * a saturated shared `routines` queue (long routines holding every slot) can never starve it (the 7h
 * deploy-freeze). Everything else — agent-role spawns, loops, long/unknown system actions — defaults to the
 * shared queue so a new routine can never silently starve the protected lane.
 */
describe('queueForRoutine — the protected git-sync lane', () => {
  it('routes the critical system action (git-sync) to the protected lane', () => {
    expect(queueForRoutine('system:git-sync')).toBe(ROUTINES_CRITICAL_QUEUE);
  });

  it('routes EVERY critical action in the set to the protected lane', () => {
    for (const action of CRITICAL_ROUTINE_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_CRITICAL_QUEUE);
    }
  });

  it('routes a LONG system action (green-checkpoint, gym, blueprint-run) to the shared queue', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:gym-cycle')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:blueprint-run')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:idle-session-reaper')).toBe(ROUTINES_QUEUE);
  });

  it('routes an agent-role routine (non-system target) to the shared queue', () => {
    expect(queueForRoutine('mug')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('worker')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('')).toBe(ROUTINES_QUEUE);
  });

  it('a NON-critical system action whose name merely CONTAINS a critical one is NOT protected (exact match)', () => {
    expect(queueForRoutine('system:git-sync-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-git-sync')).toBe(ROUTINES_QUEUE);
  });

  it('the protected set is deliberately minimal — only git-sync today', () => {
    expect([...CRITICAL_ROUTINE_ACTIONS]).toEqual(['git-sync']);
  });
});

/**
 * EI-11171 critical-routine floor: when routinesTickImpl sheds on critical PG-pool starvation it
 * must still fire the protected critical-queue routine (git-sync) — the old bare `return` skipped
 * the whole fire loop and silently re-armed the 7h git-sync-starvation freeze class. This predicate
 * is the floor: exactly the protected lane fires under a shed; everything else sheds with the sweeps.
 */
describe('shouldFireUnderPoolShed — the critical-routine floor (EI-11171)', () => {
  it('FIRES git-sync under a shed (the must-never-starve floor)', () => {
    expect(shouldFireUnderPoolShed('system:git-sync')).toBe(true);
  });

  it('FIRES every protected critical action under a shed', () => {
    for (const action of CRITICAL_ROUTINE_ACTIONS) {
      expect(shouldFireUnderPoolShed(`system:${action}`)).toBe(true);
    }
  });

  it('SHEDS every non-critical routine (long system actions, agent roles) under a shed', () => {
    expect(shouldFireUnderPoolShed('system:green-checkpoint')).toBe(false);
    expect(shouldFireUnderPoolShed('system:gym-cycle')).toBe(false);
    expect(shouldFireUnderPoolShed('system:blueprint-run')).toBe(false);
    expect(shouldFireUnderPoolShed('mug')).toBe(false);
    expect(shouldFireUnderPoolShed('worker')).toBe(false);
    expect(shouldFireUnderPoolShed('')).toBe(false);
  });

  it('SHEDS a near-miss name that merely contains a critical action (exact match, no false floor)', () => {
    expect(shouldFireUnderPoolShed('system:git-sync-status')).toBe(false);
    expect(shouldFireUnderPoolShed('system:pre-git-sync')).toBe(false);
  });

  it('is exactly the protected-lane predicate (floor === critical queue)', () => {
    for (const role of ['system:git-sync', 'system:green-checkpoint', 'mug', '']) {
      expect(shouldFireUnderPoolShed(role)).toBe(
        queueForRoutine(role) === ROUTINES_CRITICAL_QUEUE,
      );
    }
  });
});
