/**
 * partitionHeartbeatCandidatesByLiveness — the heartbeat-loop /proc-liveness
 * filter (EI-493: "bees exit without releasing nursery slots — manual Queen
 * fleet:cancel required each wave to free ceiling headroom"). Pins: a
 * tracked id with no recorded pid yet still heartbeats (the childStartTimer
 * admission window already guards that case elsewhere); a tracked id whose
 * recorded pid reads alive still heartbeats; only a tracked id whose recorded
 * pid is confirmed /proc-dead is dropped so its row can go heartbeat-stale
 * and be swept by the existing reclaimOrphanedSpawns sweep instead of
 * requiring a manual fleet:cancel forever.
 */
import { describe, test, expect } from 'vitest';
import { partitionHeartbeatCandidatesByLiveness } from './operator-spawn';

describe('partitionHeartbeatCandidatesByLiveness', () => {
  test('an id with no recorded pid yet is treated as alive (child-start window, guarded elsewhere)', () => {
    const { alive, dead } = partitionHeartbeatCandidatesByLiveness(
      ['s-no-pid-yet'],
      new Map(),
      () => false, // even an isAlive that would say "dead" never runs — no pid to check
    );
    expect(alive).toEqual(['s-no-pid-yet']);
    expect(dead).toEqual([]);
  });

  test('an id whose recorded pid reads alive stays alive', () => {
    const pids = new Map([['s-live', 4242]]);
    const { alive, dead } = partitionHeartbeatCandidatesByLiveness(['s-live'], pids, (pid) => pid === 4242);
    expect(alive).toEqual(['s-live']);
    expect(dead).toEqual([]);
  });

  test('an id whose recorded pid is confirmed /proc-dead is dropped to dead — the EI-493 leak fix', () => {
    const pids = new Map([['s-leaked', 9999]]);
    const { alive, dead } = partitionHeartbeatCandidatesByLiveness(['s-leaked'], pids, () => false);
    expect(alive).toEqual([]);
    expect(dead).toEqual(['s-leaked']);
  });

  test('a mixed batch splits correctly, preserving input order within each bucket', () => {
    const pids = new Map([
      ['s-dead-1', 1],
      ['s-alive', 2],
      ['s-dead-2', 3],
    ]);
    const isAlive = (pid: number) => pid === 2;
    const { alive, dead } = partitionHeartbeatCandidatesByLiveness(
      ['s-dead-1', 's-alive', 's-no-pid', 's-dead-2'],
      pids,
      isAlive,
    );
    expect(alive).toEqual(['s-alive', 's-no-pid']);
    expect(dead).toEqual(['s-dead-1', 's-dead-2']);
  });

  test('the liveness check is passed the "spawn" kind (strict invoke-once cmdline check, not "launch")', () => {
    const pids = new Map([['s-x', 7]]);
    let seenKind: string | undefined;
    partitionHeartbeatCandidatesByLiveness(['s-x'], pids, (_pid, kind) => {
      seenKind = kind;
      return true;
    });
    expect(seenKind).toBe('spawn');
  });
});
