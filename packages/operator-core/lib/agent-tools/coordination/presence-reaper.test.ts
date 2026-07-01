/**
 * presence-reaper.test.ts — pure-fn unit coverage for `planPresenceReap`
 * (presence-coord-unification-2026-07-01 P-004, WI-1347).
 *
 * The IO seam (`reapEndedPresenceRows`, including its real `fetchWakeability` +
 * DELETE against `harness_shared.coord_presence`) is covered against real PG in
 * presence-reaper.integration.test.ts; here we pin the keep/cut boundary of the
 * pure planner — the same "never reap a wakeable row, however stale" invariant
 * `deriveSessionState` enforces for the READ side (presence-wakeability.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { planPresenceReap, type PresenceReapCandidate } from './presence-reaper';

const NOW = 1_000_000_000_000;
const TTL = 4 * 60 * 60 * 1000; // 4h, the default
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const row = (ownerId: string, heartbeatAgoMs: number): PresenceReapCandidate => ({
  ownerId,
  heartbeatAt: ago(heartbeatAgoMs),
});

describe('planPresenceReap (WI-1347 pure planner)', () => {
  it('reaps an ended (not wakeable) row whose heartbeat is past the TTL', () => {
    const r = row('su-dead', TTL + 1000);
    expect(planPresenceReap([r], new Set(), NOW, TTL)).toEqual(['su-dead']);
  });

  it('NEVER reaps a wakeable row, however stale its heartbeat', () => {
    // parked: stale heartbeat but a live standing wake await — the ideal
    // dispatch target, must survive indefinitely regardless of age.
    const r = row('su-parked', 100 * TTL);
    expect(planPresenceReap([r], new Set(['su-parked']), NOW, TTL)).toEqual([]);
  });

  it('does NOT reap an ended row still inside its grace window (heartbeat age < ttl)', () => {
    const r = row('su-just-ended', TTL - 1000);
    expect(planPresenceReap([r], new Set(), NOW, TTL)).toEqual([]);
  });

  it('TTL boundary: strictly under the TTL survives, exactly at the TTL is reaped', () => {
    const justUnder = row('su-under', TTL - 1);
    const atTtl = row('su-at', TTL);
    const out = planPresenceReap([justUnder, atTtl], new Set(), NOW, TTL);
    expect(out).toEqual(['su-at']);
  });

  it('skips a row with an unparseable heartbeat timestamp rather than guessing', () => {
    const bad: PresenceReapCandidate = { ownerId: 'su-bad', heartbeatAt: 'not-a-date' };
    expect(planPresenceReap([bad], new Set(), NOW, TTL)).toEqual([]);
  });

  it('partitions a mixed roster correctly', () => {
    const dead = row('dead', TTL + 60_000);
    const parked = row('parked', 100 * TTL);
    const fresh = row('fresh', 60_000);
    const live = row('live', 60_000);
    const out = planPresenceReap(
      [dead, parked, fresh, live],
      new Set(['parked', 'live']),
      NOW,
      TTL,
    );
    expect(out).toEqual(['dead']);
  });

  it('empty roster ⇒ nothing to reap', () => {
    expect(planPresenceReap([], new Set(), NOW, TTL)).toEqual([]);
  });
});
