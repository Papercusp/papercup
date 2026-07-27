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
  RETRY_THRASH_THRESHOLD,
  THRASH_WINDOW_MS,
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

  it('a ONE-OFF failure the agent then fixed — self-correction, not divergence', () => {
    // 456 of 601 real failure groups in 24h are exactly this shape.
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'invalid-input', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 2 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.failuresSeen).toBe(1);
  });

  it('TWO failures — still inside normal correction', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'invalid-input', args: { a: 1 } }),
      call({ id: 2, status: 'invalid-input', args: { a: 2 } }),
      call({ id: 3, status: 'ok', args: { a: 3 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.thrashRuns).toBe(0);
  });

  it('failures spread across DIFFERENT tools are a bad minute, not a flail', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error' }),
      call({ id: 2, toolName: 'plans:get', status: 'error' }),
      call({ id: 3, toolName: 'facts:assert', status: 'error' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a successful call is never counted as a failure', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'ok' }),
      call({ id: 2, toolName: 'work_items:list' }),
    ]);
    expect(out.coverage.failuresSeen).toBe(0);
  });
});

describe('the sampling leg — live without any stamp', () => {
  /** N failures of one tool, `gapMs` apart, with optionally-varying args. */
  function flail(n: number, opts: { gapMs?: number; sameArgs?: boolean } = {}): DivergenceCall[] {
    const gap = opts.gapMs ?? 1000;
    return Array.from({ length: n }, (_, i) =>
      call({
        id: i + 1,
        toolName: 'work_items:claim',
        status: 'invalid-input',
        invokedAt: new Date(T0 + i * gap).toISOString(),
        args: opts.sameArgs ? { a: 1 } : { a: i },
      }),
    );
  }

  it('flags an unconverged run at exactly the threshold', () => {
    const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD));
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('unconverged-retry-loop');
    expect(out.divergences[0].retryLoop?.attempts).toBe(RETRY_THRASH_THRESHOLD);
    expect(out.coverage.thrashRuns).toBe(1);
  });

  it('does NOT flag one attempt below the threshold', () => {
    const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD - 1));
    expect(out.divergences).toHaveLength(0);
  });

  it('fires with a ZERO stamp fill rate — the state of the fleet today', () => {
    const out = detectIntentActionDivergence(flail(3));
    expect(out.coverage.stampFillRate).toBe(0);
    expect(out.divergences).toHaveLength(1);
  });

  it('counts changed-args transitions — P-010\'s first named trigger, as evidence', () => {
    const out = detectIntentActionDivergence(flail(3));
    expect(out.divergences[0].retryLoop?.argsChangedTransitions).toBe(2);
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(0);
  });

  it('calls out IDENTICAL retries, which cannot succeed for a deterministic refusal', () => {
    const out = detectIntentActionDivergence(flail(3, { sameArgs: true }));
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(2);
    expect(out.divergences[0].detail).toContain('IDENTICAL args');
  });

  it('records a same-namespace fallback inside the run — the second named trigger', () => {
    const calls = flail(3);
    calls.splice(1, 0, call({ id: 50, toolName: 'work_items:claim_next', invokedAt: new Date(T0 + 500).toISOString() }));
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences[0].retryLoop?.fallbackObserved).toBe(true);
    expect(out.divergences[0].detail).toContain('fallback');
  });

  it('does not treat a different NAMESPACE as a fallback', () => {
    const calls = flail(3);
    calls.splice(1, 0, call({ id: 50, toolName: 'plans:get', invokedAt: new Date(T0 + 500).toISOString() }));
    expect(detectIntentActionDivergence(calls).divergences[0].retryLoop?.fallbackObserved).toBe(false);
  });

  it('splits runs that straddle THRASH_WINDOW_MS rather than merging them', () => {
    // Two failures, a long gap, then two more: neither side reaches 3.
    const calls = [
      ...flail(2),
      call({ id: 10, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: new Date(T0 + THRASH_WINDOW_MS + 1).toISOString(), args: { a: 9 } }),
      call({ id: 11, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: new Date(T0 + THRASH_WINDOW_MS + 2000).toISOString(), args: { a: 10 } }),
    ];
    expect(detectIntentActionDivergence(calls).divergences).toHaveLength(0);
  });

  it('never merges two owners into one run', () => {
    const calls = [
      ...flail(2),
      call({ id: 20, ownerId: 'su-b', toolName: 'work_items:claim', status: 'invalid-input', args: { a: 7 } }),
    ];
    expect(detectIntentActionDivergence(calls).divergences).toHaveLength(0);
  });

  it('treats each failure status as a failure, including role-not-allowed', () => {
    for (const s of ['error', 'invalid-input', 'timeout', 'refused', 'denied', 'role-not-allowed']) {
      expect(isFailureStatus(s)).toBe(true);
    }
    expect(isFailureStatus('ok')).toBe(false);
    expect(isFailureStatus(null)).toBe(false);
  });

  it('does not invent changed-args evidence when args were never supplied', () => {
    const calls = Array.from({ length: 3 }, (_, i) =>
      call({ id: i + 1, toolName: 'work_items:claim', status: 'error', invokedAt: new Date(T0 + i * 1000).toISOString() }),
    );
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].retryLoop?.argsChangedTransitions).toBe(0);
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(0);
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

  it('offers ONLY the sampling kind while the stamp is undeployed', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 2 } }),
    ]);
    expect(deliverableKinds(out.coverage)).toEqual(['unconverged-retry-loop']);
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
    const runs = DIVERGENCE_LIMIT + 10;
    const calls: DivergenceCall[] = [];
    for (let i = 0; i < runs; i += 1) {
      for (let k = 0; k < RETRY_THRASH_THRESHOLD; k += 1) {
        calls.push(
          call({
            id: i * 10 + k,
            ownerId: `su-${i}`,
            toolName: 'work_items:claim',
            status: 'error',
            invokedAt: new Date(T0 + k * 1000).toISOString(),
            args: { a: k },
          }),
        );
      }
    }
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences).toHaveLength(DIVERGENCE_LIMIT);
    expect(out.truncated).toBe(true);
    // Counts stay COMPLETE even though the list was cut.
    expect(out.coverage.thrashRuns).toBe(runs);
    expect(out.coverage.failuresSeen).toBe(runs * RETRY_THRASH_THRESHOLD);
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
