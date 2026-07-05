import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateStaleConditions,
  runConditionStalenessTick,
  _resetConditionStalenessDebounce,
} from './condition-staleness-alarm';
import type { ConditionState } from '../agent-tools/coordination/tools/conditions';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

function mkState(over: Partial<ConditionState> = {}): ConditionState {
  return {
    condition_key: 'git-sync-stall:papercusp',
    open: true,
    from: 'system-watchdog',
    category: 'severe-event',
    first_seen: '2026-07-05T00:00:00.000Z',
    last_seen: '2026-07-05T00:00:00.000Z',
    alarm_count: 1,
    latest_summary: 'git-sync stalled',
    resolved_at: null,
    resolved_summary: null,
    ...over,
  };
}

describe('evaluateStaleConditions (pure)', () => {
  it('an OPEN condition younger than staleMs → no signal', () => {
    const now = Date.parse('2026-07-05T00:10:00.000Z'); // 10min old
    expect(evaluateStaleConditions([mkState()], now, 45 * 60_000)).toEqual([]);
  });

  it('an OPEN condition older than staleMs → one stale-condition signal, keyed by condition_key', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min old
    const sigs = evaluateStaleConditions([mkState()], now, 45 * 60_000);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].key).toBe('stale-condition:git-sync-stall:papercusp');
    expect(sigs[0].conditionKey).toBe('git-sync-stall:papercusp');
    expect(sigs[0].severity).toBe('advisory');
    expect(sigs[0].summary).toContain('60m');
    expect(sigs[0].summary).toContain('git-sync stalled');
  });

  it('a RESOLVED condition never fires, regardless of age', () => {
    const now = Date.parse('2026-07-06T00:00:00.000Z'); // 1 day old
    const sigs = evaluateStaleConditions(
      [mkState({ open: false, resolved_at: '2026-07-05T00:05:00.000Z' })],
      now,
      45 * 60_000,
    );
    expect(sigs).toEqual([]);
  });

  it('an unparseable first_seen is skipped rather than throwing', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    expect(() => evaluateStaleConditions([mkState({ first_seen: 'not-a-date' })], now, 0)).not.toThrow();
    expect(evaluateStaleConditions([mkState({ first_seen: 'not-a-date' })], now, 0)).toEqual([]);
  });

  it('multiple stale conditions each get their own signal', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    const sigs = evaluateStaleConditions(
      [mkState({ condition_key: 'a' }), mkState({ condition_key: 'b' })],
      now,
      45 * 60_000,
    );
    expect(sigs.map((s) => s.conditionKey).sort()).toEqual(['a', 'b']);
  });
});

describe('runConditionStalenessTick — durable dedup + auto-resolve (mirrors liveness-alarm EI-2146 shape)', () => {
  beforeEach(() => _resetConditionStalenessDebounce());

  /** A minimal in-memory escalation store mirroring the append-only open/resolve log. */
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
          from: 'system:condition-staleness-alarm',
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

  it('(a) a repeat firing of the same signature opens NO second escalation — even across a worker restart', async () => {
    const store = makeStore();
    const stale = [mkState()];
    const deps = {
      readStates: async () => stale,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const first = await runConditionStalenessTick(deps);
    expect(first.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);

    // Simulate a worker restart: in-memory debounce wiped. Durable dedup off the
    // open escalation log must still collapse the repeat — no second row.
    _resetConditionStalenessDebounce();
    const second = await runConditionStalenessTick(deps);
    expect(second.fired).toEqual([]);
    expect(store.openCount()).toBe(1);
  });

  it('(b) a condition that RESOLVES auto-resolves its open reminder, then re-fires only if it re-opens and goes stale again', async () => {
    const store = makeStore();
    let resolved = false;
    let now = Date.parse('2026-07-05T01:00:00.000Z');
    const deps = {
      readStates: async () => [resolved ? mkState({ open: false, resolved_at: '2026-07-05T00:30:00.000Z' }) : mkState()],
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => now,
      staleMs: 45 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const t1 = await runConditionStalenessTick(deps);
    expect(t1.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);

    resolved = true;
    now += 60_000;
    const t2 = await runConditionStalenessTick(deps);
    expect(t2.resolved.length).toBe(1);
    expect(store.openCount()).toBe(0);

    // Re-open + go stale again fires fresh, proving recovery cleared the cooldown.
    resolved = false;
    now += 60_000;
    const t3 = await runConditionStalenessTick(deps);
    expect(t3.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);
  });

  it('a read failure degrades to a no-op tick, never throws', async () => {
    const deps = {
      readStates: async () => {
        throw new Error('db unavailable');
      },
    };
    await expect(runConditionStalenessTick(deps)).resolves.toEqual({ fired: [], signals: [], resolved: [] });
  });

  it('an escalate failure never crashes the tick (best-effort)', async () => {
    const deps = {
      readStates: async () => [mkState()],
      escalate: async () => {
        throw new Error('send failed');
      },
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
    };
    const r = await runConditionStalenessTick(deps);
    // Still reported as a signal + a fire attempt, even though the send itself failed.
    expect(r.signals.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
  });
});
