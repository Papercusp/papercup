import { describe, it, expect } from 'vitest';
import {
  computeCancelledRoutineFireSignals,
  runRoutineFireCancellationAlarmTick,
  routineFireCancellationConditionKey,
  ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY,
  type RoutineFireCounts,
} from './routine-fire-cancellation-alarm';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

/** A minimal in-memory escalation store mirroring the append-only open/resolve log
 *  (same shape escalation-aging-alarm.test.ts / condition-staleness-alarm.test.ts use). */
function makeStore() {
  const opens: EscalationRecord[] = [];
  const resolvedIds = new Set<string>();
  let seq = 0;
  return {
    escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
      seq += 1;
      opens.push({
        ts: new Date(seq * 1000).toISOString(),
        msg_id: `esc-${seq}`,
        from: ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY.ownerId,
        to: ['human'],
        kind: 'escalation',
        severity: input.severity,
        summary: input.summary,
        resolved: null,
        ...(input.meta ?? {}),
      } as unknown as EscalationRecord);
    },
    listOpen: async (): Promise<EscalationRecord[]> => opens.filter((e) => !resolvedIds.has(e.msg_id)),
    resolve: async (msg_id: string) => {
      resolvedIds.add(msg_id);
    },
    openCount: () => opens.filter((e) => !resolvedIds.has(e.msg_id)).length,
  };
}

describe('computeCancelledRoutineFireSignals (pure)', () => {
  it('no rows → no signals', () => {
    expect(computeCancelledRoutineFireSignals([])).toEqual([]);
  });

  it('a routine with fires but zero cancellations is not flagged', () => {
    const rows: RoutineFireCounts[] = [{ routineId: 'rt_a', ok: 10, cancelled: 0 }];
    expect(computeCancelledRoutineFireSignals(rows)).toEqual([]);
  });

  it('a routine with zero total fires is not flagged (nothing to measure)', () => {
    const rows: RoutineFireCounts[] = [{ routineId: 'rt_a', ok: 0, cancelled: 0 }];
    expect(computeCancelledRoutineFireSignals(rows)).toEqual([]);
  });

  it('rate exactly at the threshold is NOT flagged — only strictly over', () => {
    // 1 ok, 1 cancelled -> rate 0.5, default threshold 0.5: not > 0.5
    const rows: RoutineFireCounts[] = [{ routineId: 'rt_a', ok: 1, cancelled: 1 }];
    expect(computeCancelledRoutineFireSignals(rows)).toEqual([]);
  });

  it('rate over the threshold is flagged, with rate computed correctly', () => {
    // 0 ok, 3 cancelled -> rate 1.0 (the sync_read_audit case from the item)
    const rows: RoutineFireCounts[] = [{ routineId: 'rt_papercusp_sync_read_audit', ok: 0, cancelled: 3 }];
    const signals = computeCancelledRoutineFireSignals(rows);
    expect(signals).toEqual([
      { routineId: 'rt_papercusp_sync_read_audit', ok: 0, cancelled: 3, total: 3, rate: 1 },
    ]);
  });

  it('a custom rateThreshold is honoured', () => {
    // 8 ok, 2 cancelled -> rate 0.2: flagged at threshold 0.1, not at default 0.5
    const rows: RoutineFireCounts[] = [{ routineId: 'rt_a', ok: 8, cancelled: 2 }];
    expect(computeCancelledRoutineFireSignals(rows)).toEqual([]);
    expect(computeCancelledRoutineFireSignals(rows, { rateThreshold: 0.1 })).toHaveLength(1);
  });

  it('sorts worst rate first, ties broken by absolute cancelled count', () => {
    const rows: RoutineFireCounts[] = [
      { routineId: 'rt_low_rate', ok: 1, cancelled: 4 }, // rate 0.8
      { routineId: 'rt_tie_a', ok: 0, cancelled: 5 }, // rate 1.0, cancelled 5
      { routineId: 'rt_tie_b', ok: 0, cancelled: 9 }, // rate 1.0, cancelled 9
    ];
    const signals = computeCancelledRoutineFireSignals(rows);
    expect(signals.map((s) => s.routineId)).toEqual(['rt_tie_b', 'rt_tie_a', 'rt_low_rate']);
  });

  it('flags multiple independent routines in one pass', () => {
    const rows: RoutineFireCounts[] = [
      { routineId: 'rt_a', ok: 0, cancelled: 3 },
      { routineId: 'rt_b', ok: 10, cancelled: 0 }, // healthy, not flagged
      { routineId: 'rt_c', ok: 1, cancelled: 2 }, // rate 0.667, flagged
    ];
    const signals = computeCancelledRoutineFireSignals(rows);
    expect(signals.map((s) => s.routineId).sort()).toEqual(['rt_a', 'rt_c']);
  });
});

describe('runRoutineFireCancellationAlarmTick', () => {
  it('no signals → no-op, no escalation', async () => {
    const store = makeStore();
    const result = await runRoutineFireCancellationAlarmTick({
      readCounts: async () => [],
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result).toEqual({ signals: [], fired: [], resolved: [] });
    expect(store.openCount()).toBe(0);
  });

  it('a flagged routine escalates exactly once, keyed by the canonical conditionKey', async () => {
    const store = makeStore();
    const result = await runRoutineFireCancellationAlarmTick({
      readCounts: async () => [{ routineId: 'rt_papercusp_sync_read_audit', ok: 0, cancelled: 3 }],
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result.fired).toEqual(['rt_papercusp_sync_read_audit']);
    expect(store.openCount()).toBe(1);
    const [rec] = await store.listOpen();
    expect((rec as unknown as Record<string, unknown>).subjectSignature).toBe(
      routineFireCancellationConditionKey('rt_papercusp_sync_read_audit'),
    );
    expect(rec.summary).toContain('rt_papercusp_sync_read_audit');
    expect(rec.summary).toContain('3/3');
  });

  it('repeated ticks with a still-cancelling routine never fork a second row', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen, resolve: store.resolve };
    const counts = async (): Promise<RoutineFireCounts[]> => [
      { routineId: 'rt_papercusp_sync_read_audit', ok: 0, cancelled: 3 },
    ];
    await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: counts });
    await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: counts });
    const third = await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: counts });
    expect(third.fired).toEqual([]); // already reporting — no new row this tick
    expect(store.openCount()).toBe(1); // exactly one row survives, not one per tick
  });

  it('rate drops back at/under threshold → auto-resolves the open row', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen, resolve: store.resolve };
    await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
    });
    expect(store.openCount()).toBe(1);
    // Recovers: now mostly healthy fires (rate 0.2, at/under the 0.5 default threshold).
    const cleared = await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [{ routineId: 'rt_a', ok: 8, cancelled: 2 }],
    });
    expect(cleared.resolved).toHaveLength(1);
    expect(store.openCount()).toBe(0);
  });

  it('rate drops back to zero cancellations (routine absent from the read) → auto-resolves', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen, resolve: store.resolve };
    await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
    });
    expect(store.openCount()).toBe(1);
    // Fully healed: the HAVING clause in the real query means a routine with zero
    // recent cancellations simply stops appearing in the read at all.
    const cleared = await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: async () => [] });
    expect(cleared.resolved).toHaveLength(1);
    expect(store.openCount()).toBe(0);
  });

  it('re-fires (re-opens) after a clear-then-recancel cycle', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen, resolve: store.resolve };
    await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
    });
    await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: async () => [] });
    const reopened = await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 4 }],
    });
    expect(reopened.fired).toEqual(['rt_a']);
    expect(store.openCount()).toBe(1);
  });

  it('flags and dedups multiple routines INDEPENDENTLY — not a single global row', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen, resolve: store.resolve };
    const bothCancelling = async (): Promise<RoutineFireCounts[]> => [
      { routineId: 'rt_a', ok: 0, cancelled: 3 },
      { routineId: 'rt_b', ok: 1, cancelled: 5 },
    ];
    const first = await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: bothCancelling });
    expect(first.fired.sort()).toEqual(['rt_a', 'rt_b']);
    expect(store.openCount()).toBe(2);

    // Re-tick with the same two still cancelling: neither re-fires (dedup per-routine).
    const second = await runRoutineFireCancellationAlarmTick({ ...deps, readCounts: bothCancelling });
    expect(second.fired).toEqual([]);
    expect(store.openCount()).toBe(2);

    // rt_a heals, rt_b keeps cancelling and a brand-new rt_c starts cancelling:
    // rt_a's row resolves, rt_b's stays open untouched, rt_c gets its own new row.
    const third = await runRoutineFireCancellationAlarmTick({
      ...deps,
      readCounts: async () => [
        { routineId: 'rt_b', ok: 1, cancelled: 5 },
        { routineId: 'rt_c', ok: 0, cancelled: 2 },
      ],
    });
    expect(third.resolved).toHaveLength(1);
    expect(third.fired).toEqual(['rt_c']);
    expect(store.openCount()).toBe(2); // rt_b (still open) + rt_c (new) — rt_a resolved away
    const openIds = (await store.listOpen()).map(
      (r) => (r as unknown as Record<string, unknown>).subjectSignature,
    );
    expect(openIds.sort()).toEqual(
      [routineFireCancellationConditionKey('rt_b'), routineFireCancellationConditionKey('rt_c')].sort(),
    );
  });

  it('a readCounts failure fails soft — never throws, reports empty', async () => {
    const store = makeStore();
    const result = await runRoutineFireCancellationAlarmTick({
      readCounts: async () => {
        throw new Error('boom');
      },
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result).toEqual({ signals: [], fired: [], resolved: [] });
    expect(store.openCount()).toBe(0);
  });

  it('a listOpen failure fails soft (treats as no open rows) and still fires', async () => {
    const store = makeStore();
    const result = await runRoutineFireCancellationAlarmTick({
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
      escalate: store.escalate,
      listOpen: async () => {
        throw new Error('boom');
      },
      resolve: store.resolve,
    });
    // Fails open: treats as "no rows visible" and still fires — never silently
    // swallows a genuine cancellation signal because a transient read glitched.
    expect(result.fired).toEqual(['rt_a']);
  });

  it('an escalate failure fails soft — never throws', async () => {
    const result = await runRoutineFireCancellationAlarmTick({
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
      escalate: async () => {
        throw new Error('boom');
      },
      listOpen: async () => [],
      resolve: async () => {},
    });
    expect(result.fired).toEqual([]);
    expect(result.signals).toHaveLength(1);
  });

  it('a resolve failure fails soft — never throws, and the row is left open (not lost)', async () => {
    const store = makeStore();
    const deps = { escalate: store.escalate, listOpen: store.listOpen };
    await runRoutineFireCancellationAlarmTick({
      ...deps,
      resolve: store.resolve,
      readCounts: async () => [{ routineId: 'rt_a', ok: 0, cancelled: 3 }],
    });
    expect(store.openCount()).toBe(1);
    const result = await runRoutineFireCancellationAlarmTick({
      ...deps,
      resolve: async () => {
        throw new Error('boom');
      },
      readCounts: async () => [],
    });
    expect(result.resolved).toEqual([]);
    expect(store.openCount()).toBe(1); // the failed resolve did not silently drop the row
  });
});
