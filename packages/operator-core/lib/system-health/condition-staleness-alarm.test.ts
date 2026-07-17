import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateStaleConditions,
  runConditionStalenessTick,
  selectReconcilableConditions,
  selectAbsentConditions,
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
    open_since: '2026-07-05T00:00:00.000Z',
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

  it('EI-10653: a FLAPPING condition freshly reopened is judged by open_since, not first_seen', () => {
    // first alarm 1967m ago (the reported symptom), but it recovered many times
    // and only reopened 3m ago → open_since is recent → NOT stuck-open.
    const now = Date.parse('2026-07-05T00:00:00.000Z');
    const flapping = mkState({
      condition_key: 'infra-liveness:panel:infra',
      first_seen: new Date(now - 1967 * 60_000).toISOString(),
      open_since: new Date(now - 3 * 60_000).toISOString(),
      last_seen: new Date(now - 3 * 60_000).toISOString(),
      resolved_at: new Date(now - 8 * 60_000).toISOString(),
      alarm_count: 40,
    });
    // Anchoring on open_since (3m) → below the 45m stale bar → no reminder.
    expect(evaluateStaleConditions([flapping], now, 45 * 60_000)).toEqual([]);
    // Anchoring on the OLD first_seen would (wrongly) have fired — pin that the
    // regression is real: same state, but if we pretend open_since == first_seen
    // it does trip the bar.
    expect(
      evaluateStaleConditions([mkState({ ...flapping, open_since: flapping.first_seen })], now, 45 * 60_000),
    ).toHaveLength(1);
  });

  it('EI-10653: a genuinely-stuck (never-recovered) condition still fires — open_since == first_seen', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min continuously open
    const stuck = mkState({
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
      resolved_at: null,
    });
    expect(evaluateStaleConditions([stuck], now, 45 * 60_000)).toHaveLength(1);
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

  it('an unparseable open-episode anchor is skipped rather than throwing', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    // The age anchor is now open_since (EI-10653); an unparseable one is skipped.
    const bad = mkState({ open_since: 'not-a-date' });
    expect(() => evaluateStaleConditions([bad], now, 0)).not.toThrow();
    expect(evaluateStaleConditions([bad], now, 0)).toEqual([]);
    // Fallback path: open_since null → first_seen used; an unparseable one is skipped too.
    const badFallback = mkState({ open_since: null, first_seen: 'not-a-date' });
    expect(evaluateStaleConditions([badFallback], now, 0)).toEqual([]);
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

  it('EI-15182: an OPEN+stale condition whose last_seen has also gone SIGNAL-ABSENT never fires — regardless of family', () => {
    // first_seen/open_since/last_seen all pinned to the same very-old instant:
    // stuck open per staleMs (60min > 45min), AND last_seen is 60min old —
    // beyond a 45min absenceMs — so nobody has re-observed this signal recently.
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    const goneQuiet = mkState({ condition_key: 'git-sync-stall:dummy-pot-0707' });
    expect(evaluateStaleConditions([goneQuiet], now, 45 * 60_000, 45 * 60_000)).toEqual([]);
  });

  it('EI-15182: an OPEN+stale condition with a RECENT last_seen still fires (absenceMs alone does not suppress an actively-observed signal)', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min since open_since
    const activelyFiring = mkState({
      condition_key: 'embed-exhaustion:openai_billing',
      last_seen: new Date(now - 60_000).toISOString(), // re-alarmed 1min ago
    });
    // staleMs=45min (still stuck open), absenceMs=90min (last_seen 1min old, well within it).
    const sigs = evaluateStaleConditions([activelyFiring], now, 45 * 60_000, 90 * 60_000);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].conditionKey).toBe('embed-exhaustion:openai_billing');
  });
});

describe('selectAbsentConditions (pure — EI-15182 guard #3, family-agnostic)', () => {
  it('an OPEN condition whose last_seen exceeds absenceMs is absent', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [
      mkState({ condition_key: 'single-primary:split-brain-primary', last_seen: '2026-07-11T02:13:00.000Z' }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual(['single-primary:split-brain-primary']);
  });

  it('an OPEN condition whose last_seen is within absenceMs is NOT absent', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [mkState({ last_seen: new Date(now - 30 * 60_000).toISOString() })];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual([]);
  });

  it('an already-RESOLVED condition is never flagged absent, even with an ancient last_seen', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [
      mkState({ open: false, resolved_at: '2026-07-11T00:00:00.000Z', last_seen: '2026-07-11T00:00:00.000Z' }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual([]);
  });

  it('covers every family — not just infra-liveness', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const stale = '2026-07-11T00:10:00.000Z';
    const states = [
      mkState({ condition_key: 'git-sync-stall:dummy-pot-0707', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'git-sync-stall:quartermaster-hive', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'embed-exhaustion:daily_cap', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'infra-liveness:pg-restarted', last_seen: stale, open_since: stale, first_seen: stale }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000).sort()).toEqual([
      'embed-exhaustion:daily_cap',
      'git-sync-stall:dummy-pot-0707',
      'git-sync-stall:quartermaster-hive',
      'infra-liveness:pg-restarted',
    ]);
  });
});

describe('selectReconcilableConditions (pure — EI-14072 guard #2)', () => {
  it('an OPEN condition whose key is verified healthy (true) is reconcilable', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', true]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual(['infra-liveness:panel:overwatch']);
  });

  it('an OPEN condition verified UNhealthy (false) is left alone', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', false]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual([]);
  });

  it('an OPEN condition with NO health entry (unknown/unchecked family) is left alone — fail-open', () => {
    const states = [mkState({ condition_key: 'git-sync-stall:papercusp' })];
    expect(selectReconcilableConditions(states, new Map())).toEqual([]);
  });

  it('an already-RESOLVED condition is never reconciled, even if marked healthy', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch', open: false, resolved_at: '2026-07-05T00:05:00.000Z' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', true]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual([]);
  });

  it('multiple open+healthy keys are all reconciled', () => {
    const states = [
      mkState({ condition_key: 'infra-liveness:panel:overwatch' }),
      mkState({ condition_key: 'infra-liveness:panel:bees' }),
      mkState({ condition_key: 'infra-liveness:dead-routines', open: false, resolved_at: 'x' }),
    ];
    const healthByKey = new Map([
      ['infra-liveness:panel:overwatch', true],
      ['infra-liveness:panel:bees', true],
      ['infra-liveness:dead-routines', true],
    ]);
    expect(selectReconcilableConditions(states, healthByKey).sort()).toEqual([
      'infra-liveness:panel:bees',
      'infra-liveness:panel:overwatch',
    ]);
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
    await expect(runConditionStalenessTick(deps)).resolves.toEqual({
      fired: [],
      signals: [],
      resolved: [],
      reconciled: [],
    });
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

  it('EI-14072 guard #2: an open+stale infra-liveness row with a VERIFIED-healthy signal is reconciled — broadcast fires, and it is NOT also flagged stale this same tick', async () => {
    const broadcasts: Array<{ conditionKeys: string[]; summary: string }> = [];
    const stuck = mkState({
      condition_key: 'infra-liveness:panel:overwatch',
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
    });
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('escalate should NOT be called for a reconciled key');
      },
      now: () => Date.parse('2026-07-05T01:00:00.000Z'), // 60min open — would be stale
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) =>
        new Map(keys.map((k) => [k, true])), // verified healthy
      broadcastResolvedMany: async (input: { conditionKeys: string[]; summary: string }) => {
        broadcasts.push(input);
        return true;
      },
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.reconciled).toEqual(['infra-liveness:panel:overwatch']);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.conditionKeys).toEqual(['infra-liveness:panel:overwatch']);
    // The reconciled key must NOT also earn a staleness reminder in the same tick.
    expect(r.signals).toEqual([]);
    expect(r.fired).toEqual([]);
  });

  it('EI-14072 guard #2: an open+stale infra-liveness row whose signal is VERIFIED unhealthy is left open and still fires the staleness reminder', async () => {
    const stuck = mkState({
      condition_key: 'infra-liveness:panel:overwatch',
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
    });
    const escalated: string[] = [];
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async (input: { summary: string }) => {
        escalated.push(input.summary);
      },
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) => new Map(keys.map((k) => [k, false])),
      broadcastResolvedMany: async () => {
        throw new Error('must not be called — nothing verified healthy');
      },
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.reconciled).toEqual([]);
    expect(r.fired.map((s) => s.key)).toEqual(['stale-condition:infra-liveness:panel:overwatch']);
    expect(escalated).toHaveLength(1);
  });

  it('EI-14072 guard #2: a non-infra-liveness key is never passed to readHealthByKey (family-scoped)', async () => {
    const seenKeys: string[][] = [];
    const stuck = mkState({ condition_key: 'git-sync-stall:papercusp' });
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {},
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) => {
        seenKeys.push([...keys]);
        return new Map();
      },
    };
    await runConditionStalenessTick(deps);
    expect(seenKeys).toEqual([[]]);
  });
});
