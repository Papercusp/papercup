import { describe, it, expect, vi } from 'vitest';
import {
  runEscalationAgingAlarmTick,
  ESCALATION_AGING_CONDITION_KEY,
  ESCALATION_AGING_ALARM_IDENTITY,
} from './escalation-aging-alarm';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';
import {
  selectStaleEscalations,
  SELF_RECONCILING_META_KEY,
  type StaleEscalationInput,
} from '../attention/reconcile-escalations';
import type { SystemHealth } from '../system-health/types';

function healthWithAging(aging: number): SystemHealth {
  return {
    workspaceId: 'ws-shared',
    evaluatedAt: Date.now(),
    overall: 'ok',
    crossMonitor: { queenAlive: true, overwatchAlive: null },
    panels: {
      escalations: {
        key: 'escalations',
        label: 'Escalations',
        status: 'ok',
        summary: 'ok',
        metrics: [],
        data: { aging },
      },
    } as unknown as SystemHealth['panels'],
  };
}

function healthWithUnknownEscalations(): SystemHealth {
  const health = healthWithAging(0);
  return {
    ...health,
    panels: {
      ...health.panels,
      escalations: {
        ...health.panels.escalations,
        status: 'unknown',
        data: null,
        error: 'collector unavailable',
      },
    },
  };
}

/** A minimal in-memory escalation store mirroring the append-only open/resolve log
 *  (same shape condition-staleness-alarm.test.ts uses). */
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
        from: ESCALATION_AGING_ALARM_IDENTITY.ownerId,
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

describe('runEscalationAgingAlarmTick (EI-16151)', () => {
  it('reads the shared SystemHealth snapshot on a request-worker hit', async () => {
    const store = makeStore();
    const result = await runEscalationAgingAlarmTick({
      readSharedHealth: async () => healthWithAging(42),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });

    expect(result.aging).toBe(42);
    expect(result.fired).toBe(true);
    expect(store.openCount()).toBe(1);
  });

  it('treats a missing/stale shared snapshot as unknown and does not reconcile', async () => {
    const listOpen = vi.fn(async () => [] as EscalationRecord[]);
    const result = await runEscalationAgingAlarmTick({
      readSharedHealth: async () => null,
      listOpen,
    });

    expect(result).toEqual({ aging: null, fired: false, resolved: [] });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it('treats an unreadable escalation panel as unknown rather than a false zero/all-clear', async () => {
    const listOpen = vi.fn(async () => [] as EscalationRecord[]);
    const result = await runEscalationAgingAlarmTick({
      readSharedHealth: async () => healthWithUnknownEscalations(),
      listOpen,
    });

    expect(result).toEqual({ aging: null, fired: false, resolved: [] });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it('aging === 0 → no escalation, no-op', async () => {
    const store = makeStore();
    const result = await runEscalationAgingAlarmTick({
      readAging: async () => 0,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result).toEqual({ aging: 0, fired: false, resolved: [] });
    expect(store.openCount()).toBe(0);
  });

  it('aging > 0 with none open → escalates exactly once, keyed by the canonical conditionKey', async () => {
    const store = makeStore();
    const result = await runEscalationAgingAlarmTick({
      readAging: async () => 42,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result.fired).toBe(true);
    expect(result.aging).toBe(42);
    expect(store.openCount()).toBe(1);
    const [rec] = await store.listOpen();
    expect((rec as unknown as Record<string, unknown>).subjectSignature).toBe(
      ESCALATION_AGING_CONDITION_KEY,
    );
    expect(rec.summary).toContain('42');
  });

  it('EI-16151 core fix: repeated ticks with a DIFFERENT live count never fork a second row', async () => {
    const store = makeStore();
    const deps = {
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    };
    await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 326 });
    await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 331 });
    const third = await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 337 });
    expect(third.fired).toBe(false); // already reporting — no new row this tick
    expect(store.openCount()).toBe(1); // exactly one row survives, not one per tick
  });

  it('aging returns to 0 → resolves the open row', async () => {
    const store = makeStore();
    const deps = {
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    };
    await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 5 });
    expect(store.openCount()).toBe(1);
    const cleared = await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 0 });
    expect(cleared.resolved).toHaveLength(1);
    expect(store.openCount()).toBe(0);
  });

  it('re-opens (fires again) after a clear-then-reaging cycle', async () => {
    const store = makeStore();
    const deps = {
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    };
    await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 5 });
    await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 0 });
    const reopened = await runEscalationAgingAlarmTick({ ...deps, readAging: async () => 3 });
    expect(reopened.fired).toBe(true);
    expect(store.openCount()).toBe(1);
  });

  it('a readAging failure fails soft — never throws, never fires', async () => {
    const store = makeStore();
    const result = await runEscalationAgingAlarmTick({
      readAging: async () => {
        throw new Error('boom');
      },
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    expect(result).toEqual({ aging: null, fired: false, resolved: [] });
    expect(store.openCount()).toBe(0);
  });

  it('a listOpen failure fails soft (treats as no open rows) rather than throwing', async () => {
    const store = makeStore();
    const result = await runEscalationAgingAlarmTick({
      readAging: async () => 7,
      escalate: store.escalate,
      listOpen: async () => {
        throw new Error('boom');
      },
      resolve: store.resolve,
    });
    // Fails open: treats as "no rows visible" and still fires — never silently
    // swallows a genuine aging backlog because a transient read glitched.
    expect(result.fired).toBe(true);
  });

  it('an escalate failure fails soft — never throws', async () => {
    const result = await runEscalationAgingAlarmTick({
      readAging: async () => 7,
      escalate: async () => {
        throw new Error('boom');
      },
      listOpen: async () => [],
      resolve: async () => {},
    });
    expect(result.fired).toBe(false);
    expect(result.aging).toBe(7);
  });

  // ── WI-36214: the row this alarm opens must SURVIVE the attention TTL sweep ──
  //
  // COUPLING test, not a unit test: it takes the record this alarm actually
  // emits and feeds it to the real selector. The two halves of the fix live in
  // different modules, so a unit test on either side alone would stay green if
  // the marker were renamed, dropped from the meta bag, or no longer honoured.
  //
  // WHY IT MATTERS: this alarm skips re-firing while one of its rows is open
  // (the `openRows.length > 0` branch) and resolves that row itself when the
  // count clears — so a sweep that GC's the row does not tidy a duplicate, it
  // re-arms the alarm on a still-true condition. Measured 6 resolve→re-fire
  // pairs in 14 days, ~2 days apart, each announced as a resolution.
  it('emits a row the idle-TTL sweep will NOT garbage-collect (WI-36214)', async () => {
    const store = makeStore();
    await runEscalationAgingAlarmTick({
      readAging: async () => 357,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
    });
    const [emitted] = await store.listOpen();
    expect(emitted).toBeDefined();

    // Age the emitted row well past the sweep's TTL and run the REAL selector.
    const nowMs = Date.parse(emitted!.ts) + 30 * 24 * 60 * 60 * 1000;
    const stale = selectStaleEscalations(
      [emitted as unknown as StaleEscalationInput],
      { nowMs, ttlMs: 2 * 24 * 60 * 60 * 1000 },
    );
    expect(stale).toEqual([]);

    // CALIBRATION: the same row WITHOUT the marker is swept — proving the
    // assertion above turns on the marker, not on some other property of the
    // row (its sender, its lack of options, its age).
    const { [SELF_RECONCILING_META_KEY]: _marker, ...unmarked } = emitted as unknown as Record<
      string,
      unknown
    >;
    expect(
      selectStaleEscalations([unmarked as unknown as StaleEscalationInput], {
        nowMs,
        ttlMs: 2 * 24 * 60 * 60 * 1000,
      }),
    ).toHaveLength(1);
  });
});
