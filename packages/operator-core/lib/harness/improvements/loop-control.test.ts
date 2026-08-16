/**
 * loop-control.test — loadLearningLoopControl (WI-39501).
 *
 * The snapshot semantics under test mirror routines:group-set's contract:
 *   - status is 'running' iff ANY group member is active;
 *   - heldCount counts ONLY inactive members carrying THIS group's groupPause
 *     marker — a deliberate pre-existing hold (no marker / another group's
 *     marker) is NOT part of what resume restores;
 *   - the newest groupPause stamp wins pausedAtMs/pausedBy;
 *   - spend sums the LOOP ROLES ONLY and degrades independently;
 *   - every query failure degrades to the empty snapshot — never a throw.
 */
import { describe, expect, it } from 'vitest';

import {
  LEARNING_ROUTINE_GROUP,
  LEARNING_SPEND_ROLES,
  loadLearningLoopControl,
  utcDayStart,
} from './loop-control';

type Row = Record<string, unknown>;

/** runQuery stub dispatching on the table each of the two queries reads. */
function stubRunQuery(opts: {
  routines?: Row[] | 'throw';
  spend?: Row[] | 'throw';
  capture?: { query: string; params: unknown[] }[];
}) {
  return async <T>(query: string, params: unknown[]): Promise<T[]> => {
    opts.capture?.push({ query, params });
    if (query.includes('harness_shared.routines')) {
      if (opts.routines === 'throw') throw new Error('routines query failed');
      return (opts.routines ?? []) as T[];
    }
    if (query.includes('agent_usage_samples')) {
      if (opts.spend === 'throw') throw new Error('spend query failed');
      return (opts.spend ?? []) as T[];
    }
    throw new Error(`unexpected query: ${query}`);
  };
}

describe('utcDayStart', () => {
  it('floors to UTC midnight', () => {
    const ts = Date.UTC(2026, 7, 16, 21, 4, 59, 123);
    expect(utcDayStart(ts)).toBe(Date.UTC(2026, 7, 16, 0, 0, 0, 0));
    // Midnight is a fixed point.
    expect(utcDayStart(Date.UTC(2026, 7, 16))).toBe(Date.UTC(2026, 7, 16));
  });
});

describe('loadLearningLoopControl', () => {
  const ws = 'ws-1';

  it('reports running when any member is active, and counts members', async () => {
    const snap = await loadLearningLoopControl({
      workspaceId: ws,
      runQuery: stubRunQuery({
        routines: [
          { active: true, pause: null },
          { active: true, pause: null },
          { active: false, pause: null },
        ],
      }),
    });
    expect(snap.status).toBe('running');
    expect(snap.memberCount).toBe(3);
    expect(snap.activeCount).toBe(2);
    expect(snap.heldCount).toBe(0);
    expect(snap.group).toBe(LEARNING_ROUTINE_GROUP);
  });

  it('counts ONLY this group\'s groupPause markers as held — deliberate holds stay out', async () => {
    const snap = await loadLearningLoopControl({
      workspaceId: ws,
      runQuery: stubRunQuery({
        routines: [
          // Held by the group pause — counted.
          {
            active: false,
            pause: { groupPause: LEARNING_ROUTINE_GROUP, pausedAtMs: 1000, pausedBy: 'su-early' },
          },
          {
            active: false,
            pause: { groupPause: LEARNING_ROUTINE_GROUP, pausedAtMs: 2000, pausedBy: 'su-late' },
          },
          // Deliberate individual hold (no marker) — NOT counted.
          { active: false, pause: { pausedBy: 'human' } },
          // Another group's marker — NOT counted.
          { active: false, pause: { groupPause: 'other-group', pausedAtMs: 9999, pausedBy: 'x' } },
          // No pause metadata at all — NOT counted.
          { active: false, pause: null },
        ],
      }),
    });
    expect(snap.status).toBe('paused');
    expect(snap.memberCount).toBe(5);
    expect(snap.activeCount).toBe(0);
    expect(snap.heldCount).toBe(2);
    // Newest stamp wins, and its pausedBy rides along.
    expect(snap.pausedAtMs).toBe(2000);
    expect(snap.pausedBy).toBe('su-late');
  });

  it('sums spend across loop roles, coercing string numerics, and passes the role filter', async () => {
    const capture: { query: string; params: unknown[] }[] = [];
    const nowMs = Date.UTC(2026, 7, 16, 12, 0, 0);
    const snap = await loadLearningLoopControl({
      workspaceId: ws,
      nowMs,
      runQuery: stubRunQuery({
        routines: [{ active: true, pause: null }],
        // PG SUM comes back as text — the loader must coerce.
        spend: [
          { role: 'scout', today_usd: '1.25', week_usd: '10.00' },
          { role: 'gym', today_usd: null, week_usd: '5.50' },
          { role: 'llm-testing', today_usd: 0.25, week_usd: 2.43 },
        ],
        capture,
      }),
    });
    expect(snap.spend.todayUsd).toBeCloseTo(1.5);
    expect(snap.spend.weekUsd).toBeCloseTo(17.93);
    expect(snap.spend.byRole).toHaveLength(3);
    expect(snap.spend.roles).toEqual(LEARNING_SPEND_ROLES);
    expect(snap.evaluatedAt).toBe(nowMs);

    const spendCall = capture.find((c) => c.query.includes('agent_usage_samples'));
    expect(spendCall).toBeDefined();
    // params: [workspaceId, weekStart, dayStart, roles]
    expect(spendCall!.params[0]).toBe(ws);
    expect(spendCall!.params[1]).toBe(nowMs - 7 * 24 * 60 * 60 * 1000);
    expect(spendCall!.params[2]).toBe(utcDayStart(nowMs));
    expect(spendCall!.params[3]).toEqual([...LEARNING_SPEND_ROLES]);
  });

  it('degrades a failed routines query to the empty snapshot — never a throw', async () => {
    const snap = await loadLearningLoopControl({
      workspaceId: ws,
      runQuery: stubRunQuery({ routines: 'throw', spend: [] }),
    });
    expect(snap.memberCount).toBe(0);
    expect(snap.activeCount).toBe(0);
    expect(snap.heldCount).toBe(0);
    expect(snap.status).toBe('paused');
    expect(snap.pausedAtMs).toBeNull();
  });

  it('degrades a failed spend query while keeping the routine state', async () => {
    const snap = await loadLearningLoopControl({
      workspaceId: ws,
      runQuery: stubRunQuery({
        routines: [{ active: true, pause: null }],
        spend: 'throw',
      }),
    });
    expect(snap.status).toBe('running');
    expect(snap.activeCount).toBe(1);
    expect(snap.spend.todayUsd).toBe(0);
    expect(snap.spend.weekUsd).toBe(0);
    expect(snap.spend.byRole).toEqual([]);
  });
});
