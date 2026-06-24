import { describe, it, expect } from 'vitest';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  CRITICAL_ROUTINE_ACTIONS,
  queueForRoutine,
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
    expect(queueForRoutine('queen')).toBe(ROUTINES_QUEUE);
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
