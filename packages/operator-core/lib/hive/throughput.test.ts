/**
 * throughput.test.ts — the PURE half of hive throughput instrumentation
 * (queen-autonomous-execution-2026-06-13, B-11 / P-050).
 *
 * Deterministic coverage of `computeHiveThroughput` (the six metrics) and
 * `detectThroughputBreaches` (the FB-21 audit-as-sensors predicate). Zero PG,
 * zero clock — every input is supplied, so these are the durable definition of
 * "the instrumentation measures the loop correctly" and double as the
 * deterministic backing for the B-11/P-051 loop-contract invariants.
 */
import { describe, it, expect } from 'vitest';
import {
  computeHiveThroughput,
  detectThroughputBreaches,
  type HiveSpawnSnapshot,
  type HiveThroughputInput,
} from './throughput';

const NOW = 1_000_000_000_000; // fixed epoch-ms
const MIN = 60_000;
const STUCK = 10 * MIN;

function spawn(over: Partial<HiveSpawnSnapshot> = {}): HiveSpawnSnapshot {
  return {
    status: 'running',
    startedAtMs: NOW - MIN,
    finishedAtMs: null,
    durationMs: null,
    heartbeatAtMs: NOW, // fresh by default
    ...over,
  };
}

function input(over: Partial<HiveThroughputInput> = {}): HiveThroughputInput {
  return {
    nowMs: NOW,
    frontierDepth: 0,
    ceiling: 16,
    running: 0,
    spawns: [],
    lastTickAtMs: null,
    stuckThresholdMs: STUCK,
    ...over,
  };
}

describe('computeHiveThroughput — busy / cap / utilization', () => {
  it('utilization is running/ceiling, clamped to [0,1]', () => {
    expect(computeHiveThroughput(input({ ceiling: 16, running: 4 })).utilization).toBe(0.25);
    expect(computeHiveThroughput(input({ ceiling: 16, running: 16 })).utilization).toBe(1);
    // over-subscribed (reclaim lag) never exceeds 1
    expect(computeHiveThroughput(input({ ceiling: 4, running: 9 })).utilization).toBe(1);
  });

  it('a zero ceiling yields 0 utilization, never NaN/Infinity', () => {
    const m = computeHiveThroughput(input({ ceiling: 0, running: 3 }));
    expect(m.utilization).toBe(0);
    expect(Number.isFinite(m.utilization)).toBe(true);
  });

  it('busy and cap are non-negative integers', () => {
    const m = computeHiveThroughput(input({ ceiling: -2, running: -5 }));
    expect(m.beesBusy).toBe(0);
    expect(m.beesCap).toBe(0);
  });
});

describe('computeHiveThroughput — placements per wake (windowing)', () => {
  it('first tick (no lastTickAt) counts every in-window spawn', () => {
    const m = computeHiveThroughput(
      input({ lastTickAtMs: null, spawns: [spawn(), spawn(), spawn({ status: 'done' })] }),
    );
    expect(m.placements).toBe(3);
  });

  it('subsequent ticks count only spawns started since the previous tick', () => {
    const last = NOW - 5 * MIN;
    const m = computeHiveThroughput(
      input({
        lastTickAtMs: last,
        spawns: [
          spawn({ startedAtMs: NOW - 10 * MIN }), // before last tick — not new
          spawn({ startedAtMs: NOW - 2 * MIN }), // after — new placement
          spawn({ startedAtMs: NOW - MIN }), // after — new placement
        ],
      }),
    );
    expect(m.placements).toBe(2);
  });
});

describe('computeHiveThroughput — completed + MTTC', () => {
  it('MTTC is the mean duration over done spawns in the window', () => {
    const m = computeHiveThroughput(
      input({
        spawns: [
          spawn({ status: 'done', finishedAtMs: NOW, durationMs: 2 * MIN }),
          spawn({ status: 'done', finishedAtMs: NOW, durationMs: 4 * MIN }),
          spawn({ status: 'running' }), // ignored
          spawn({ status: 'failed', finishedAtMs: NOW, durationMs: 99 * MIN }), // not 'done' — ignored
        ],
      }),
    );
    expect(m.completed).toBe(2);
    expect(m.mttcMs).toBe(3 * MIN);
  });

  it('falls back to finished−started when duration_ms is absent', () => {
    const m = computeHiveThroughput(
      input({ spawns: [spawn({ status: 'done', startedAtMs: NOW - 6 * MIN, finishedAtMs: NOW, durationMs: null })] }),
    );
    expect(m.mttcMs).toBe(6 * MIN);
  });

  it('MTTC is null when nothing completed (no divide-by-zero)', () => {
    const m = computeHiveThroughput(input({ spawns: [spawn({ status: 'running' })] }));
    expect(m.completed).toBe(0);
    expect(m.mttcMs).toBeNull();
  });

  it('completion windowing respects lastTickAt', () => {
    const last = NOW - 3 * MIN;
    const m = computeHiveThroughput(
      input({
        lastTickAtMs: last,
        spawns: [
          spawn({ status: 'done', finishedAtMs: NOW - 5 * MIN, durationMs: MIN }), // before — not counted
          spawn({ status: 'done', finishedAtMs: NOW - MIN, durationMs: MIN }), // after — counted
        ],
      }),
    );
    expect(m.completed).toBe(1);
  });
});

describe('computeHiveThroughput — stuck count', () => {
  it('a running bee with a stale heartbeat is stuck', () => {
    const m = computeHiveThroughput(
      input({
        spawns: [
          spawn({ status: 'running', heartbeatAtMs: NOW - 12 * MIN }), // stale → stuck
          spawn({ status: 'running', heartbeatAtMs: NOW - MIN }), // fresh → ok
        ],
      }),
    );
    expect(m.stuckCount).toBe(1);
  });

  it('a finished bee is never stuck, however old', () => {
    const m = computeHiveThroughput(
      input({ spawns: [spawn({ status: 'done', heartbeatAtMs: NOW - 99 * MIN, finishedAtMs: NOW })] }),
    );
    expect(m.stuckCount).toBe(0);
  });

  it('a missing heartbeat falls back to started_at for staleness', () => {
    const m = computeHiveThroughput(
      input({ spawns: [spawn({ status: 'running', heartbeatAtMs: null, startedAtMs: NOW - 20 * MIN })] }),
    );
    expect(m.stuckCount).toBe(1);
  });
});

describe('computeHiveThroughput — frontier + question rungs', () => {
  it('frontier depth is clamped to a non-negative integer', () => {
    expect(computeHiveThroughput(input({ frontierDepth: 7 })).frontierDepth).toBe(7);
    expect(computeHiveThroughput(input({ frontierDepth: -3 })).frontierDepth).toBe(0);
  });

  it('question rungs default to an empty map (no ladder data yet — B-10/B-17)', () => {
    expect(computeHiveThroughput(input()).questionRungs).toEqual({});
    expect(computeHiveThroughput(input({ questionRungs: { 'bee-self': 3, owner: 1 } })).questionRungs).toEqual({
      'bee-self': 3,
      owner: 1,
    });
  });
});

describe('detectThroughputBreaches — FB-21 audit-as-sensors', () => {
  const healthy = computeHiveThroughput(input({ ceiling: 16, running: 4, frontierDepth: 2 }));

  it('a healthy loop (slack + no stuck) raises no breach', () => {
    expect(detectThroughputBreaches(healthy, 'papercup')).toEqual([]);
  });

  it('saturation WITH queued work raises a starvation breach', () => {
    const m = computeHiveThroughput(input({ ceiling: 8, running: 8, frontierDepth: 5 }));
    const breaches = detectThroughputBreaches(m, 'papercup');
    expect(breaches.map((b) => b.kind)).toContain('starvation');
    expect(breaches.find((b) => b.kind === 'starvation')?.watchdogKey).toBe('governor-starvation:papercup');
  });

  it('saturation at an owner maxBees cap is expected and does not raise starvation', () => {
    const m = computeHiveThroughput(input({ ceiling: 3, running: 3, frontierDepth: 5 }));
    const breaches = detectThroughputBreaches(m, 'papercup', { ownerMaxBees: 3, systemCeiling: 16 });
    expect(breaches.some((b) => b.kind === 'starvation')).toBe(false);
  });

  it('saturation still raises starvation when owner maxBees is not lowering the system ceiling', () => {
    const m = computeHiveThroughput(input({ ceiling: 3, running: 3, frontierDepth: 5 }));
    const breaches = detectThroughputBreaches(m, 'papercup', { ownerMaxBees: 3, systemCeiling: 3 });
    expect(breaches.some((b) => b.kind === 'starvation')).toBe(true);
  });

  it('saturation with an EMPTY frontier is fine — nothing waiting, no breach', () => {
    const m = computeHiveThroughput(input({ ceiling: 8, running: 8, frontierDepth: 0 }));
    expect(detectThroughputBreaches(m, 'papercup').some((b) => b.kind === 'starvation')).toBe(false);
  });

  it('a stuck bee raises a stuck breach (error severity, stable key)', () => {
    const m = computeHiveThroughput(
      input({ running: 2, ceiling: 16, spawns: [spawn({ status: 'running', heartbeatAtMs: NOW - 30 * MIN })] }),
    );
    const stuck = detectThroughputBreaches(m, 'papercup').find((b) => b.kind === 'stuck');
    expect(stuck).toBeTruthy();
    expect(stuck?.severity).toBe('error');
    expect(stuck?.watchdogKey).toBe('orphaned-spawn:papercup:throughput');
  });

  it('both breaches can fire at once, each with its own key (cross-tick dedup)', () => {
    const m = computeHiveThroughput(
      input({
        ceiling: 4,
        running: 4,
        frontierDepth: 9,
        spawns: [spawn({ status: 'running', heartbeatAtMs: NOW - 30 * MIN })],
      }),
    );
    const keys = detectThroughputBreaches(m, 'papercup').map((b) => b.watchdogKey).sort();
    expect(keys).toEqual(['governor-starvation:papercup', 'orphaned-spawn:papercup:throughput']);
  });
});
