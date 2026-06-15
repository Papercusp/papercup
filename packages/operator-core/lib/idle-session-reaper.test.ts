import { describe, it, expect } from 'vitest';
import {
  planIdleSessionReap,
  IDLE_SESSION_GRACE_MS,
  type ReapableSession,
} from './idle-session-reaper';

const NOW = 1_000_000_000_000;
const old = (agoMs: number): number => NOW - agoMs;
const session = (id: number, coordOwnerId: string | null, startedAtMs: number): ReapableSession => ({
  id,
  coordOwnerId,
  startedAtMs,
});

describe('planIdleSessionReap (P-011 idle-session reaper — slice 1: dead-process ghosts)', () => {
  it('reaps an open session whose owner is dead (not protected) and past the grace floor', () => {
    const s = session(1, 'su-dead', old(2 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(), // owner not live → dead process
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([s]);
    expect(plan.keptLive).toHaveLength(0);
  });

  it('NEVER reaps a session whose owner is live/claim/wake-protected, however old', () => {
    const s = session(2, 'su-live', old(100 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(['su-live']),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptLive).toEqual([s]);
  });

  it('NEVER reaps a brand-new session inside the grace floor (its first presence beat may not have landed)', () => {
    const s = session(3, 'su-new', old(IDLE_SESSION_GRACE_MS - 1));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(), // not yet present — but too new to judge
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptFresh).toEqual([s]);
  });

  it('NEVER reaps a session with no coord_owner_id (no liveness key to prove it dead)', () => {
    const s = session(4, null, old(100 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptNoOwner).toEqual([s]);
  });

  it('grace boundary: just under the floor is kept-fresh; exactly at the floor is reapable (strict <)', () => {
    const justUnder = session(5, 'su-x', old(IDLE_SESSION_GRACE_MS - 1)); // delta < grace → fresh
    const atFloor = session(6, 'su-y', old(IDLE_SESSION_GRACE_MS)); // delta === grace, NOT < grace → reap
    const plan = planIdleSessionReap({
      sessions: [justUnder, atFloor],
      protectedOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.keptFresh).toEqual([justUnder]);
    expect(plan.reap).toEqual([atFloor]);
  });

  it('partitions a mixed batch correctly', () => {
    const dead = session(10, 'dead', old(5 * IDLE_SESSION_GRACE_MS));
    const live = session(11, 'live', old(5 * IDLE_SESSION_GRACE_MS));
    const fresh = session(12, 'fresh', old(60_000));
    const noOwner = session(13, null, old(5 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [dead, live, fresh, noOwner],
      protectedOwners: new Set(['live']),
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([dead]);
    expect(plan.keptLive).toEqual([live]);
    expect(plan.keptFresh).toEqual([fresh]);
    expect(plan.keptNoOwner).toEqual([noOwner]);
  });
});
