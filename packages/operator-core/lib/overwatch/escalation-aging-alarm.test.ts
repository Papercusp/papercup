import { describe, it, expect } from 'vitest';
import {
  runEscalationAgingAlarmTick,
  ESCALATION_AGING_CONDITION_KEY,
  ESCALATION_AGING_ALARM_IDENTITY,
} from './escalation-aging-alarm';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

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
    expect(result).toEqual({ aging: 0, fired: false, resolved: [] });
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
});
