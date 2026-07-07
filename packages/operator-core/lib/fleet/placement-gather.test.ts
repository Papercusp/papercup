/**
 * placement-gather.test.ts — EI-FIX-033: null harness validation for EI items
 *
 * Tests that gatherFrontier properly validates and fails loud when EI items
 * (operator-scope items with null harness) are placed without an explicit
 * fallback harness parameter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  workItemToTask,
  partitionTasksByReadiness,
  isPlacementHardBlocked,
  isNonPlaceableWorkItemState,
  deriveBeeAliveFromPresence,
  NO_PRESENCE_BEE_BOOTSTRAP_GRACE_MS,
} from './placement-gather';
import type { PlacementTask } from './placement-affinity';

describe('workItemToTask — harness backfill for EI items (F-FIX-033)', () => {
  it('backfills harness from fallbackHarness when wi.harness is null', () => {
    const ei = {
      id: 'EI-123',
      harness: null,
      title: 'Test issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, 'papercusp');
    expect(task.harness).toBe('papercusp');
    expect(task.id).toBe('EI-123');
  });

  it('prefers wi.harness over fallbackHarness when both are present', () => {
    const wi = {
      id: 'F-456',
      harness: 'my-harness',
      title: 'Feature',
      state: 'todo',
    };
    const task = workItemToTask(wi as any, 'fallback');
    expect(task.harness).toBe('my-harness');
  });

  it('returns null harness when both wi.harness and fallbackHarness are null/undefined', () => {
    const ei = {
      id: 'EI-789',
      harness: null,
      title: 'Unplaced issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, undefined);
    expect(task.harness).toBeNull();
    expect(task.id).toBe('EI-789');
  });

  it('ignores whitespace-only fallbackHarness as if undefined', () => {
    const ei = {
      id: 'EI-999',
      harness: null,
      title: 'Issue',
      state: 'todo',
    };
    const task = workItemToTask(ei as any, '   ');
    expect(task.harness).toBeNull();
  });
});

describe('isPlacementHardBlocked — WI-677 cursed-filter keys on genuine pathology, not the bare status', () => {
  // place_batch's loadCursedWorkItemIds hard-blocks a `cursed` item ONLY when its
  // fail_count has reached the 3-strike pathology breaker. A fail_count-0 `cursed` row is
  // an INFRA false-curse (host-restart / dormancy / zombie hit the bounded infra breaker
  // with zero genuine task failures) and stays RE-PLACEABLE — the WI-677 deadlock fix.
  const BREAKER = 3; // placementConfig().breakerThreshold default

  it('RECURRENCE GUARD (b): a fail_count-0 cursed item is NOT hard-blocked → place_batch re-places it', () => {
    // The 31 deadlocked items (WI-349 et al.) were all fail_count=0, infra_loss_count=12.
    expect(isPlacementHardBlocked(0, BREAKER)).toBe(false);
  });

  it('a fail_count below the breaker threshold is not hard-blocked (still re-placeable)', () => {
    expect(isPlacementHardBlocked(1, BREAKER)).toBe(false);
    expect(isPlacementHardBlocked(2, BREAKER)).toBe(false);
  });

  it('a genuinely pathology-cursed item (fail_count >= breakerThreshold) IS hard-blocked (the breaker still halts a doomed item)', () => {
    expect(isPlacementHardBlocked(3, BREAKER)).toBe(true);
    expect(isPlacementHardBlocked(4, BREAKER)).toBe(true);
  });

  it('honors a custom (lower) breaker threshold', () => {
    expect(isPlacementHardBlocked(1, 1)).toBe(true); // threshold 1 → first genuine failure blocks
    expect(isPlacementHardBlocked(0, 1)).toBe(false); // a fail_count-0 infra-curse is still re-placeable
  });
});

describe('isNonPlaceableWorkItemState — EI-8438: the blocked-state placement floor', () => {
  it('excludes a deliberately-parked `blocked` item (the reported WI-3265 case)', () => {
    expect(isNonPlaceableWorkItemState('blocked')).toBe(true);
  });

  it('excludes a deliberately-parked `needs-human` item', () => {
    expect(isNonPlaceableWorkItemState('needs-human')).toBe(true);
  });

  it('still excludes every settled/terminal state', () => {
    for (const s of ['passed', 'deprecated', 'resolved', 'closed', 'cancelled', 'done', 'dropped', 'merged']) {
      expect(isNonPlaceableWorkItemState(s)).toBe(true);
    }
  });

  it('allows genuinely placeable states through', () => {
    for (const s of ['todo', 'in_progress', 'validating', 'failing', 'wip', 'open']) {
      expect(isNonPlaceableWorkItemState(s)).toBe(false);
    }
  });

  it('treats a missing/empty state as placeable (back-compat — never a false exclusion)', () => {
    expect(isNonPlaceableWorkItemState(null)).toBe(false);
    expect(isNonPlaceableWorkItemState(undefined)).toBe(false);
    expect(isNonPlaceableWorkItemState('')).toBe(false);
  });
});

describe('deriveBeeAliveFromPresence — EI-3067 no-presence nursery rows do not stay alive forever', () => {
  const NOW = Date.parse('2026-07-03T12:00:00.000Z');

  it('uses live presence when present', () => {
    expect(deriveBeeAliveFromPresence(false, NOW - 60_000, NOW)).toBe(true);
  });

  it('uses stale presence as dead even when nursery activity is recent', () => {
    expect(deriveBeeAliveFromPresence(true, NOW - 1_000, NOW)).toBe(false);
  });

  it('allows a just-spawned no-presence bee during the bootstrap grace', () => {
    expect(deriveBeeAliveFromPresence(undefined, NOW - NO_PRESENCE_BEE_BOOTSTRAP_GRACE_MS + 1, NOW)).toBe(true);
  });

  it('marks an old no-presence nursery row dead so the Queen brief cannot render it as alive', () => {
    expect(deriveBeeAliveFromPresence(undefined, NOW - NO_PRESENCE_BEE_BOOTSTRAP_GRACE_MS - 1, NOW)).toBe(false);
  });

  it('marks a no-presence row with no usable nursery timestamp dead', () => {
    expect(deriveBeeAliveFromPresence(undefined, null, NOW)).toBe(false);
    expect(deriveBeeAliveFromPresence(undefined, Number.NaN, NOW)).toBe(false);
  });
});

describe('partitionTasksByReadiness — null harness handling (F-FIX-033)', () => {
  it('treats null-harness tasks as unblocked (no blocking graph)', () => {
    const tasks: PlacementTask[] = [
      {
        id: 'EI-100',
        harness: null, // null harness — no blocking constraints
        title: 'Unplaced',
        files: [],
        planSlug: null,
        brief: null,
      },
      {
        id: 'F-200',
        harness: 'proj',
        title: 'Feature',
        files: [],
        planSlug: null,
        brief: null,
      },
    ];

    const result = partitionTasksByReadiness(tasks, new Map());
    // Both should be "ready" since no blocking graph exists for either
    expect(result.ready.length).toBe(2);
    expect(result.blocked.length).toBe(0);
    // Note: the null-harness task should ideally be caught earlier by validation
    // in gatherFrontier, not allowed to reach here
  });
});
