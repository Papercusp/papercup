/**
 * In-flight call registry (EI-21548894457555139).
 *
 * The registry exists to answer "is this agent executing right now, or idle?" while
 * a handler is still running. These tests pin the properties a leader-brief consumer
 * depends on — and, most importantly, the SELF-HEALING property: a start with no
 * matching settle must not report as a running call forever. A leaked entry is worse
 * than a missing one, because it asserts work that is not happening, which is the
 * same class of misinformation the registry was built to remove.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetInFlightCallsForTest,
  beginInFlightCall,
  endInFlightCall,
  getLongCallsInFlight,
  listInFlightCalls,
} from './in-flight-calls';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

beforeEach(() => __resetInFlightCallsForTest());

describe('in-flight registry — the basic question', () => {
  it('reports a call that has run past the threshold, with its age', () => {
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'c1', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });

    const long = getLongCallsInFlight(5 * SEC, t0 + 90 * SEC);

    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ ownerId: 'su-aaa', toolName: 'testing:run', ageSec: 90 });
  });

  it('stays silent for the overwhelming majority of calls, which settle fast', () => {
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'c1', toolName: 'work_items:get', ownerId: 'su-aaa', startedAt: t0 });

    // 40ms in, threshold 5s: nothing to report. Exception-only is the whole design —
    // a brief that named every call would be unreadable.
    expect(getLongCallsInFlight(5 * SEC, t0 + 40)).toEqual([]);
  });

  it('stops reporting a call once it settles', () => {
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'c1', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });
    expect(getLongCallsInFlight(5 * SEC, t0 + 60 * SEC)).toHaveLength(1);

    endInFlightCall('c1');

    expect(getLongCallsInFlight(5 * SEC, t0 + 60 * SEC)).toEqual([]);
  });

  it('orders longest-running first — the order a reader triages in', () => {
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'young', toolName: 'a:b', ownerId: 'su-a', startedAt: t0 + 50 * SEC });
    beginInFlightCall({ callId: 'old', toolName: 'c:d', ownerId: 'su-b', startedAt: t0 });

    const long = getLongCallsInFlight(SEC, t0 + 100 * SEC);

    expect(long.map((c) => c.toolName)).toEqual(['c:d', 'a:b']);
  });
});

describe('in-flight registry — correlation', () => {
  it('settles ONE of an agent’s concurrent same-tool calls, not both', () => {
    // The reason callId exists. Settling by (ownerId, toolName) would close both here,
    // reporting the still-running call as finished.
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'c1', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });
    beginInFlightCall({ callId: 'c2', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });

    endInFlightCall('c1');

    const long = getLongCallsInFlight(SEC, t0 + 60 * SEC);
    expect(long).toHaveLength(1);
    expect(listInFlightCalls(t0 + 60 * SEC).map((c) => c.callId)).toEqual(['c2']);
  });

  it('tolerates a settle for an id it never opened', () => {
    // A `replayed` call returns before dispatch, so it settles with no start event.
    // That must be a no-op, not an error.
    expect(() => endInFlightCall('never-seen')).not.toThrow();
    expect(() => endInFlightCall(undefined)).not.toThrow();
  });
});

describe('in-flight registry — a missed settle must self-heal', () => {
  it('stops believing an entry that never settled, instead of reporting it forever', () => {
    // The dispatcher does NOT guarantee a settle for every start: recordTelemetry
    // returns early for a non-gate-denial call with no window key, so recordInvocation
    // — where the settle lands — is never reached. Without an age bound that entry
    // would assert a running call indefinitely.
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'leaked', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });

    // Still believed inside the window: a genuinely long call must not be erased.
    expect(getLongCallsInFlight(SEC, t0 + 55 * MIN)).toHaveLength(1);

    // Past the ceiling it is dropped — and actually evicted, not merely filtered.
    expect(getLongCallsInFlight(SEC, t0 + 3 * HOUR)).toEqual([]);
    expect(listInFlightCalls(t0 + 3 * HOUR)).toEqual([]);
  });

  it('does not erase a real long-running call inside the believable window', () => {
    // Calibration for the test above: if the ceiling were tightened to something like
    // "a few minutes", this assertion fails — which is the point. A full affected-tests
    // suite dispatched through testing:run really does run for the better part of an
    // hour, and erasing it would delete exactly the signal this registry is for.
    const t0 = 1_000_000;
    beginInFlightCall({ callId: 'slow', toolName: 'testing:run', ownerId: 'su-aaa', startedAt: t0 });

    const long = getLongCallsInFlight(5 * SEC, t0 + 55 * MIN);

    expect(long).toHaveLength(1);
    expect(long[0].ageSec).toBe(55 * 60);
  });
});
