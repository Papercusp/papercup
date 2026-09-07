import { describe, it, expect } from 'vitest';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_FLEET_CONTROL_QUEUE,
  ROUTINES_LOOP_QUEUE,
  ROUTINES_RELEASE_QUEUE,
  ROUTINES_TRIGGERS_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  FLEET_CONTROL_ACTIONS,
  TRIGGER_POLL_ACTIONS,
  HEAVY_ROUTINE_ACTIONS,
  queueForRoutine,
  shouldFireUnderPoolShed,
} from './routines-queue-classification';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/**
 * 2026-06-23 routines-queue-starvation fix: git-sync must land on the protected `routines-critical` lane so
 * a saturated shared `routines` queue (long routines holding every slot) can never starve it (the 7h
 * deploy-freeze). EI-21386288922867645 adds a separate latency-isolated loop lane after a five-minute loop
 * sat behind the shared queue for ~11 minutes. Long/unknown system actions and agent roles still default to
 * the shared queue, so neither protected lane can be silently occupied by a new arbitrary routine.
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

describe('queueForRoutine — the latency-isolated loop lane', () => {
  it('routes the exact materialized loop-wake target to routines-loop', () => {
    expect(LOOP_WAKE_TARGET_ROLE).toBe('system:loop-wake');
    expect(queueForRoutine(LOOP_WAKE_TARGET_ROLE)).toBe(ROUTINES_LOOP_QUEUE);
  });

  it('keeps near-miss target names on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:loop-wake-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-loop-wake')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('loop-wake')).toBe(ROUTINES_QUEUE);
  });
});

describe('queueForRoutine — the fleet-control lane (EI-22526486100493483)', () => {
  it('routes every fleet-control action to its own serial lane', () => {
    expect([...FLEET_CONTROL_ACTIONS]).toEqual(['fleet-headcount-governor']);
    for (const action of FLEET_CONTROL_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_FLEET_CONTROL_QUEUE);
    }
  });

  it('keeps near-miss and unrelated long actions on the shared lane', () => {
    expect(queueForRoutine('system:fleet-headcount-governor-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-fleet-headcount-governor')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:blueprint-run')).toBe(ROUTINES_QUEUE);
  });

  it('does not widen the critical pool-pressure floor', () => {
    expect(shouldFireUnderPoolShed('system:fleet-headcount-governor')).toBe(false);
    expect(CRITICAL_ROUTINE_ACTIONS.has('fleet-headcount-governor')).toBe(false);
  });
});

describe('queueForRoutine — operator-home release-finalizer lane (EI-21446637172005297)', () => {
  it('routes the operator-home green-checkpoint away from four saturated subject-hive slots', () => {
    const home = operatorHomeHarnessSlug();
    expect(queueForRoutine('system:green-checkpoint', home)).toBe(ROUTINES_RELEASE_QUEUE);

    for (const subjectHive of ['sidestage', 'calendar', 'thornbury-iphone', 'hello-world-3']) {
      expect(queueForRoutine('system:green-checkpoint', subjectHive)).toBe(ROUTINES_QUEUE);
    }
  });

  it('does not widen the dedicated lane to other home-hive work or near-miss actions', () => {
    const home = operatorHomeHarnessSlug();
    expect(queueForRoutine('system:gym-cycle', home)).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:green-checkpoint-status', home)).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('green-checkpoint', home)).toBe(ROUTINES_QUEUE);
  });

  it('keeps an unscoped green-checkpoint on the shared lane (fail closed)', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
  });
});

describe('queueForRoutine — bounded heavy/background lane (EI-22469496587311452)', () => {
  it('routes the exact gitnexus reindex action to the serial heavy lane', () => {
    expect([...HEAVY_ROUTINE_ACTIONS]).toEqual(['gitnexus-reindex']);
    expect(queueForRoutine('system:gitnexus-reindex')).toBe(ROUTINES_HEAVY_QUEUE);
  });

  it('keeps near-miss and non-system targets on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:gitnexus-reindex-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-gitnexus-reindex')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('gitnexus-reindex')).toBe(ROUTINES_QUEUE);
  });

  it('does not widen the critical pool-pressure floor', () => {
    expect(shouldFireUnderPoolShed('system:gitnexus-reindex')).toBe(false);
    expect(CRITICAL_ROUTINE_ACTIONS.has('gitnexus-reindex')).toBe(false);
  });
});

/**
 * WI-41662: external-source polls starved 4–18min EVERY HOUR behind green-checkpoint's ~25m
 * hourly fire on the shared queue (13 stalls in one measured day, onset clock-locked to :14–:16
 * past the hour, both Google polls freezing and resuming together while git-sync's dedicated
 * lane ran through). These polls are quick and per-minute, and their latency IS the product
 * behaviour, so they get a bounded lane on the same principle as routines-loop.
 */
describe('queueForRoutine — the external-source poll lane (WI-41662)', () => {
  it('routes EVERY trigger-poll action to the dedicated lane', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_TRIGGERS_QUEUE);
    }
  });

  it('routes the measured-starved polls specifically (the regression this lane exists for)', () => {
    expect(queueForRoutine('system:google-gmail-poll')).toBe(ROUTINES_TRIGGERS_QUEUE);
    expect(queueForRoutine('system:google-calendar-poll')).toBe(ROUTINES_TRIGGERS_QUEUE);
  });

  it('keeps the LONG routine that starved them OFF this lane — else the starvation returns inside it', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:gym-cycle')).toBe(ROUTINES_QUEUE);
  });

  it('keeps near-miss names on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:google-gmail-poll-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-pr-poll')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('google-gmail-poll')).toBe(ROUTINES_QUEUE);
  });

  it('does NOT widen the critical floor — a poll still sheds under PG-pool pressure', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(shouldFireUnderPoolShed(`system:${action}`)).toBe(false);
    }
  });

  it('the poll lane and the critical lane are disjoint sets', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(CRITICAL_ROUTINE_ACTIONS.has(action)).toBe(false);
    }
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
    expect(shouldFireUnderPoolShed(LOOP_WAKE_TARGET_ROLE)).toBe(false);
    expect(shouldFireUnderPoolShed('mug')).toBe(false);
    expect(shouldFireUnderPoolShed('worker')).toBe(false);
    expect(shouldFireUnderPoolShed('')).toBe(false);
  });

  it('SHEDS a near-miss name that merely contains a critical action (exact match, no false floor)', () => {
    expect(shouldFireUnderPoolShed('system:git-sync-status')).toBe(false);
    expect(shouldFireUnderPoolShed('system:pre-git-sync')).toBe(false);
  });

  it('is exactly the protected-lane predicate (floor === critical queue)', () => {
    for (const role of ['system:git-sync', LOOP_WAKE_TARGET_ROLE, 'system:green-checkpoint', 'mug', '']) {
      expect(shouldFireUnderPoolShed(role)).toBe(
        queueForRoutine(role) === ROUTINES_CRITICAL_QUEUE,
      );
    }
  });
});
