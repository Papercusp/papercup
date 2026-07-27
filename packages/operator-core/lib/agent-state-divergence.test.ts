/**
 * Tests for P-010's intent↔action divergence detector.
 *
 * Structured like `agent-facts/conflicts.test.ts` (its P-011 sibling): the
 * seeded positives first, then — at equal length, deliberately — what is
 * NOT a divergence, because every false positive here is a notification sent to
 * an agent that did nothing wrong, and that is how a detector earns being muted.
 */
import { describe, it, expect } from 'vitest';
import {
  detectIntentActionDivergence,
  deliverableKinds,
  digestArgs,
  explainZero,
  isFailureStatus,
  isStructuralZero,
  toolNamespace,
  DIVERGENCE_LIMIT,
  SAMPLING_LOOKAHEAD_CALLS,
  SAMPLING_WINDOW_MS,
  type DivergenceCall,
} from './agent-state-divergence';

const T0 = Date.parse('2026-07-27T12:00:00.000Z');

/** A call with sane defaults; every test overrides only what it is about. */
function call(over: Partial<DivergenceCall> & { id: number }): DivergenceCall {
  return {
    ownerId: 'su-a',
    toolName: 'work_items:claim',
    status: 'ok',
    invokedAt: new Date(T0 + over.id * 1000).toISOString(),
    ...over,
  };
}

describe('the stamped leg — goal drift inside one intent declaration', () => {
  it('flags two distinct goals under a single intent id', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2' }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('goal-drift-within-intent');
    expect(out.divergences[0].intentEventId).toBe(100);
    expect(out.divergences[0].a.goalRef).toBe('WI-1');
    expect(out.divergences[0].b.goalRef).toBe('WI-2');
    expect(out.structuralZero).toBeNull();
  });

  it('reports THREE goals as two findings against the first, not n squared', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2' }),
      call({ id: 3, intentEventId: 100, goalRef: 'WI-3' }),
    ]);
    expect(out.divergences).toHaveLength(2);
    expect(out.divergences.every((d) => d.a.goalRef === 'WI-1')).toBe(true);
  });

  it('never crosses owners, even on the same intent id', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, ownerId: 'su-a', intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, ownerId: 'su-b', intentEventId: 100, goalRef: 'WI-2' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });
});

describe('what is deliberately NOT a divergence', () => {
  it('several intent ids under ONE goal — the normal re-declare-on-wake shape', () => {
    // agent-state-stamp.ts: an agent re-declares intent on every wake via
    // coord:orient while holding the same claim throughout. Flagging this would
    // fire on every long-running agent, every wake.
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 101, goalRef: 'WI-1' }),
      call({ id: 3, intentEventId: 102, goalRef: 'WI-1' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a goal ref going null — that is a deliberate clear on release', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: null }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a retry with IDENTICAL args — a plain retry, declaration and action agree', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 1 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('args that differ only in KEY ORDER are the same args', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1, b: 2 } }),
      call({ id: 2, status: 'ok', args: { b: 2, a: 1 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a failure followed by a DIFFERENT namespace is not a fallback', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error' }),
      call({ id: 2, toolName: 'plans:get' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a successful call followed by anything is never sampled', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'ok' }),
      call({ id: 2, toolName: 'work_items:list' }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.failuresSeen).toBe(0);
  });

  it('does NOT invent a retry finding when args were never supplied', () => {
    // A null digest means "cannot tell". Calling that a change would manufacture
    // signal out of a gap in the input.
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error' }),
      call({ id: 2, status: 'ok' }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.failuresSampled).toBe(1);
  });
});

describe('the sampling legs — live without any stamp', () => {
  it('flags a retry with changed args', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { path: 'a.ts' } }),
      call({ id: 2, status: 'ok', args: { path: 'b.ts' } }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('retry-with-changed-args');
  });

  it('flags a same-namespace verb fallback after a failure', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error' }),
      call({ id: 2, toolName: 'work_items:claim_next' }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('tool-fallback-after-failure');
    expect(out.divergences[0].detail).toContain('work_items');
  });

  it('fires with a ZERO stamp fill rate — the state of the fleet today', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error' }),
      call({ id: 2, toolName: 'work_items:claim_next' }),
    ]);
    expect(out.coverage.stampFillRate).toBe(0);
    expect(out.divergences).toHaveLength(1);
  });

  it('stops looking after SAMPLING_LOOKAHEAD_CALLS', () => {
    const calls = [call({ id: 1, toolName: 'work_items:claim', status: 'error' })];
    for (let i = 0; i < SAMPLING_LOOKAHEAD_CALLS; i += 1) {
      calls.push(call({ id: i + 2, toolName: 'plans:get' }));
    }
    // The same-namespace fallback sits just beyond the lookahead.
    calls.push(call({ id: 99, toolName: 'work_items:claim_next' }));
    expect(detectIntentActionDivergence(calls).divergences).toHaveLength(0);
  });

  it('stops looking after SAMPLING_WINDOW_MS, so a wake boundary is not spanned', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error', invokedAt: new Date(T0).toISOString() }),
      call({
        id: 2,
        toolName: 'work_items:claim_next',
        invokedAt: new Date(T0 + SAMPLING_WINDOW_MS + 1).toISOString(),
      }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('treats each failure status as a failure', () => {
    for (const s of ['error', 'invalid-input', 'timeout', 'refused', 'denied']) {
      expect(isFailureStatus(s)).toBe(true);
    }
    expect(isFailureStatus('ok')).toBe(false);
    expect(isFailureStatus(null)).toBe(false);
  });
});

describe('coverage says WHICH zero it is', () => {
  it('no calls at all', () => {
    const out = detectIntentActionDivergence([]);
    expect(out.structuralZero).toBe('no-calls');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
  });

  it('calls exist but nothing stamped and nothing failed — nothing was compared', () => {
    const out = detectIntentActionDivergence([call({ id: 1 }), call({ id: 2 })]);
    expect(out.structuralZero).toBe('nothing-comparable');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    expect(out.coverage.stampFillRate).toBe(0);
  });

  it('sampling ran, stamped legs could not — a PARTIAL answer, not a clean bill', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 1 } }),
    ]);
    expect(out.structuralZero).toBe('stamped-legs-empty');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    expect(explainZero('stamped-legs-empty')).toContain('stampFillRate is 0');
  });

  it('a healthy single-goal agent reports REAL agreement, not a structural zero', () => {
    // The regression this guards: counting only DIVERGENT buckets as comparable
    // would report a clean agent as "nothing examined".
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-1' }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(1);
    expect(out.structuralZero).toBe('agreement');
    expect(isStructuralZero(out.structuralZero)).toBe(false);
  });

  it('reports the stamp fill rate as the P-015 measurement', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2 }),
      call({ id: 3 }),
      call({ id: 4 }),
    ]);
    expect(out.coverage.stampFillRate).toBe(0.25);
    expect(out.coverage.stampedCalls).toBe(1);
    expect(out.coverage.callsExamined).toBe(4);
  });

  it('every zero reason has an explanation', () => {
    for (const r of ['no-calls', 'nothing-comparable', 'stamped-legs-empty', 'agreement'] as const) {
      expect(explainZero(r).length).toBeGreaterThan(20);
    }
  });
});

describe('deliverableKinds — the per-leg notification gate', () => {
  it('offers nothing when neither leg ran', () => {
    const out = detectIntentActionDivergence([call({ id: 1 })]);
    expect(deliverableKinds(out.coverage)).toEqual([]);
  });

  it('offers ONLY the sampling kinds while the stamp is undeployed', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 2 } }),
    ]);
    expect(deliverableKinds(out.coverage)).toEqual([
      'retry-with-changed-args',
      'tool-fallback-after-failure',
    ]);
  });

  it('adds the stamped kind once stamped calls appear', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1', status: 'error', args: { a: 1 } }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', status: 'ok', args: { a: 2 } }),
    ]);
    expect(deliverableKinds(out.coverage)).toContain('goal-drift-within-intent');
  });
});

describe('helpers', () => {
  it('toolNamespace splits on the first colon only', () => {
    expect(toolNamespace('work_items:claim')).toBe('work_items');
    expect(toolNamespace('gitnexus.query')).toBe('');
    expect(toolNamespace(':leading')).toBe('');
  });

  it('digestArgs returns null for absent, and is stable for objects', () => {
    expect(digestArgs(undefined)).toBeNull();
    expect(digestArgs({ a: 1, b: 2 })).toBe(digestArgs({ b: 2, a: 1 }));
    expect(digestArgs({ a: 1 })).not.toBe(digestArgs({ a: 2 }));
  });

  it('digestArgs survives a cycle instead of throwing inside a detector', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(digestArgs(cyclic)).toBeNull();
  });
});

describe('bounds and determinism', () => {
  it('caps findings at DIVERGENCE_LIMIT but keeps counts complete', () => {
    const calls: DivergenceCall[] = [];
    for (let i = 0; i < DIVERGENCE_LIMIT + 10; i += 1) {
      calls.push(call({ id: i * 2 + 1, ownerId: `su-${i}`, toolName: 'work_items:claim', status: 'error' }));
      calls.push(call({ id: i * 2 + 2, ownerId: `su-${i}`, toolName: 'work_items:claim_next' }));
    }
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences).toHaveLength(DIVERGENCE_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.coverage.failuresSeen).toBe(DIVERGENCE_LIMIT + 10);
  });

  it('is deterministic and order-independent', () => {
    const calls = [
      call({ id: 3, intentEventId: 100, goalRef: 'WI-2' }),
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, toolName: 'work_items:claim', status: 'error' }),
    ];
    const a = detectIntentActionDivergence(calls);
    const b = detectIntentActionDivergence([...calls].reverse());
    expect(a).toEqual(b);
  });

  it('tolerates an unparseable timestamp without throwing', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, invokedAt: 'not-a-date', status: 'error' }),
      call({ id: 2, invokedAt: 'also-not-a-date' }),
    ]);
    expect(out.coverage.callsExamined).toBe(2);
  });
});
