import { describe, expect, it, vi } from 'vitest';

import { createCache } from '@papercusp/cache';
import type { DecisionClient, DecisionOutcome, QuestionMap } from '@papercusp/decision-model';

import {
  JEV_MEMORY_ADMIT_THRESHOLD,
  JEV_MEMORY_CACHE_TTL_MS,
  JEV_MEMORY_CONSUMER,
  JEV_MEMORY_ENCODING,
  JEV_MEMORY_MIN_WAIT_MS,
  JEV_MEMORY_NO_WAIT_PORTS,
  JEV_MEMORY_VARIANT,
  jevMemoryCacheKey,
  jevMemoryWaitMs,
  runJevMemoryGate,
  type JevMemoryGateDeps,
} from './jev-memory-gate';
import { JEV_MEMORY_TIMEOUT_MS } from './jev-settings';

const CANDS = [
  { id: 'mem-a', text: 'the deploy runs from papercup-release' },
  { id: 'mem-b', text: 'Avi prefers terse status reports' },
];

function answered(pYes: Record<string, number>): DecisionOutcome<QuestionMap> {
  const answers = Object.fromEntries(Object.entries(pYes).map(([id, p]) => [id, { type: 'yesNo', pYes: p }]));
  return { kind: 'answered', model: 'jev-1.13.0', answers, usage: { inputTokens: 100, outputTokens: 0 }, latencyMs: 150, attempts: 1 } as unknown as DecisionOutcome<QuestionMap>;
}

/** A non-generic stand-in for DecisionClient.decide; the gate only ever passes a yes/no QuestionMap. */
type DecideFn = (
  request: { readonly questions: Readonly<Record<string, unknown>> },
  options?: {
    readonly consumer?: string;
    readonly subjectIds?: readonly string[];
    readonly timeoutMs?: number;
    readonly surface?: string;
  },
) => Promise<DecisionOutcome<QuestionMap>>;

function harness(effective: 'off' | 'shadow' | 'on', decide: DecideFn) {
  const decideSpy = vi.fn(decide);
  const clientFactory = vi.fn(() => ({ decide: decideSpy }) as unknown as DecisionClient);
  const resolve = vi.fn(async () => ({ effective }));
  const deps: JevMemoryGateDeps = { resolve, client: clientFactory };
  return { deps, decideSpy, clientFactory, resolve };
}

describe('runJevMemoryGate — effective off (D-009 zero-call pin)', () => {
  it('makes zero decision calls and never builds a client when the effective mode is off', async () => {
    const h = harness('off', async () => answered({ m1: 1, m2: 1 }));
    const r = await runJevMemoryGate({ workspaceId: 'ws', message: 'where does deploy run', candidates: CANDS }, h.deps);
    expect(r).toEqual({ effective: 'off' });
    expect(h.resolve).toHaveBeenCalledWith('ws');
    expect(h.clientFactory).not.toHaveBeenCalled();
    expect(h.decideSpy).not.toHaveBeenCalled();
  });

  it('treats an unreadable setting as Off, not as consent to call out', async () => {
    const h = harness('on', async () => answered({ m1: 1, m2: 1 }));
    const deps: JevMemoryGateDeps = { ...h.deps, resolve: async () => Promise.reject(new Error('pg down')) };
    expect(await runJevMemoryGate({ message: 'x', candidates: CANDS }, deps)).toEqual({ effective: 'off' });
    expect(h.decideSpy).not.toHaveBeenCalled();
  });
});

describe('runJevMemoryGate — Log only (shadow)', () => {
  it('fires ONE request labelled memory-injection with memory ids, and does not wait for it', async () => {
    const never = new Promise<DecisionOutcome<QuestionMap>>(() => undefined);
    const h = harness('shadow', () => never);
    const r = await runJevMemoryGate({ message: 'where does deploy run', candidates: CANDS }, h.deps);
    expect(r).toEqual({ effective: 'shadow', fired: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.decideSpy).toHaveBeenCalledTimes(1);
    const [request, options] = h.decideSpy.mock.calls[0];
    expect(options).toEqual({ consumer: JEV_MEMORY_CONSUMER, timeoutMs: JEV_MEMORY_TIMEOUT_MS, subjectIds: ['mem-a', 'mem-b'] });
    expect(Object.keys(request.questions)).toEqual(['m1', 'm2']);
  });

  it('swallows an unexpected client fault so it can never reach the turn', async () => {
    const h = harness('shadow', async () => {
      throw new Error('boom');
    });
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps);
      await new Promise((r) => setTimeout(r, 10));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('fires nothing when there is nothing to judge', async () => {
    const h = harness('shadow', async () => answered({}));
    expect(await runJevMemoryGate({ message: 'q', candidates: [] }, h.deps)).toEqual({ effective: 'shadow', fired: false });
    await Promise.resolve();
    expect(h.decideSpy).not.toHaveBeenCalled();
  });
});

describe('runJevMemoryGate — On', () => {
  it(`keeps a candidate exactly when P(yes) >= ${JEV_MEMORY_ADMIT_THRESHOLD}`, async () => {
    const below = Math.round((JEV_MEMORY_ADMIT_THRESHOLD - 0.01) * 100) / 100;
    const h = harness('on', async () => answered({ m1: JEV_MEMORY_ADMIT_THRESHOLD, m2: below }));
    const r = await runJevMemoryGate({ message: 'where does deploy run', candidates: CANDS }, h.deps);
    expect(r).toEqual({
      effective: 'on',
      outcome: 'answered',
      scores: [JEV_MEMORY_ADMIT_THRESHOLD, below],
      keep: [true, false],
      model: 'jev-1.13.0',
    });
  });

  it('labels its ledger calls memory-injection by default, and lets the weekly monitor relabel them', async () => {
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.9 }));
    await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps);
    await runJevMemoryGate({ message: 'q', candidates: CANDS, consumer: 'memory-bench' }, h.deps);
    expect(h.decideSpy.mock.calls.map((c) => c[1]?.consumer)).toEqual([JEV_MEMORY_CONSUMER, 'memory-bench']);
  });

  it('reports the model the provider says answered, not the pinned id', async () => {
    const h = harness('on', async () => ({ ...(answered({ m1: 0.9, m2: 0.1 }) as object), model: 'jev-1.14.0' }) as never);
    const r = await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps);
    expect(r).toMatchObject({ outcome: 'answered', model: 'jev-1.14.0' });
  });

  it('uses the D-004 operating point: v2-content, instructions encoding, P(yes) >= 0.35', async () => {
    // D-004 (jev-performance-improvements-2026-09-30) measured exactly this triple;
    // changing any value voids those numbers until the admission and robustness
    // benches are re-run (see the constants' doc comment).
    expect(JEV_MEMORY_VARIANT).toBe('v2-content');
    expect(JEV_MEMORY_ENCODING).toBe('instructions');
    expect(JEV_MEMORY_ADMIT_THRESHOLD).toBe(0.35);
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.9 }));
    await runJevMemoryGate({ message: 'where does deploy run', candidates: CANDS }, h.deps);
    const request = h.decideSpy.mock.calls[0][0] as { questions: Record<string, { question?: string }> };
    const asked = JSON.stringify(request.questions);
    // instructions encoding: each memory's text is inside its own question
    expect(asked).toContain(CANDS[0].text);
    expect(asked).toContain(CANDS[1].text);
  });

  it('fails open with the reason on an inconclusive outcome (timeout, no key, …)', async () => {
    const h = harness('on', async () => ({ kind: 'inconclusive', reason: 'timeout', latencyMs: 400, attempts: 1 }) as DecisionOutcome<QuestionMap>);
    expect(await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps)).toEqual({ effective: 'on', outcome: 'inconclusive', reason: 'timeout' });
  });

  it('fails open on a malformed answer rather than keeping a partial score list', async () => {
    const h = harness('on', async () => answered({ m1: 0.9 }));
    expect(await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps)).toMatchObject({ outcome: 'inconclusive', reason: 'malformed-response' });
  });

  it('fails open when the client throws', async () => {
    const h = harness('on', async () => {
      throw new Error('socket hang up');
    });
    expect(await runJevMemoryGate({ message: 'q', candidates: CANDS }, h.deps)).toEqual({
      effective: 'on',
      outcome: 'inconclusive',
      reason: 'error: socket hang up',
    });
  });

  it('never asks about an empty memory, and keeps it aligned (kept) in the result', async () => {
    const h = harness('on', async () => answered({ m1: 0.1 }));
    const r = await runJevMemoryGate({ message: 'q', candidates: [{ id: 'blank', text: '  ' }, CANDS[1]] }, h.deps);
    expect(Object.keys(h.decideSpy.mock.calls[0][0].questions)).toEqual(['m1']);
    expect(r).toEqual({ effective: 'on', outcome: 'answered', scores: [1, 0.1], keep: [true, false], model: 'jev-1.13.0' });
  });
});

describe('runJevMemoryGate — repeat answers are reused (WI-10004485)', () => {
  function cached(effective: 'shadow' | 'on', decide: DecideFn) {
    const h = harness(effective, decide);
    const cache = createCache();
    return { ...h, deps: { ...h.deps, cache: () => cache } satisfies JevMemoryGateDeps };
  }

  it('answers an exact repeat from the cache, in any candidate order, without a second call', async () => {
    const h = cached('on', async () => answered({ m1: 0.9, m2: 0.1 }));
    const first = await runJevMemoryGate({ workspaceId: 'ws', message: 'where does deploy run', candidates: CANDS }, h.deps);
    const again = await runJevMemoryGate({ workspaceId: 'ws', message: 'where does deploy run', candidates: [CANDS[1], CANDS[0]] }, h.deps);
    expect(h.decideSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ effective: 'on', outcome: 'answered', scores: [0.9, 0.1], keep: [true, false], model: 'jev-1.13.0' });
    // Scores follow the memory, not the position.
    expect(again).toEqual({ effective: 'on', outcome: 'answered', scores: [0.1, 0.9], keep: [false, true], model: 'jev-1.13.0', cached: true });
  });

  it('asks again when the message, a memory text, or the workspace differs', async () => {
    const h = cached('on', async () => answered({ m1: 0.9, m2: 0.1 }));
    await runJevMemoryGate({ workspaceId: 'ws', message: 'where does deploy run', candidates: CANDS }, h.deps);
    await runJevMemoryGate({ workspaceId: 'ws', message: 'who prefers terse reports', candidates: CANDS }, h.deps);
    await runJevMemoryGate({ workspaceId: 'ws', message: 'where does deploy run', candidates: [{ ...CANDS[0], text: 'edited text' }, CANDS[1]] }, h.deps);
    await runJevMemoryGate({ workspaceId: 'other-ws', message: 'where does deploy run', candidates: CANDS }, h.deps);
    expect(h.decideSpy).toHaveBeenCalledTimes(4);
    expect(jevMemoryCacheKey('m', CANDS)).toBe(jevMemoryCacheKey('m', [CANDS[1], CANDS[0]]));
    expect(jevMemoryCacheKey('m', CANDS)).not.toBe(jevMemoryCacheKey('m ', CANDS));
  });

  it('never caches an inconclusive answer: the next identical turn asks again', async () => {
    let call = 0;
    const h = cached('on', async () =>
      ++call === 1 ? ({ kind: 'inconclusive', reason: 'timeout', latencyMs: 400, attempts: 1 } as DecisionOutcome<QuestionMap>) : answered({ m1: 0.9, m2: 0.9 }),
    );
    expect(await runJevMemoryGate({ workspaceId: 'ws', message: 'q', candidates: CANDS }, h.deps)).toEqual({
      effective: 'on',
      outcome: 'inconclusive',
      reason: 'timeout',
    });
    expect(await runJevMemoryGate({ workspaceId: 'ws', message: 'q', candidates: CANDS }, h.deps)).toMatchObject({ outcome: 'answered' });
    expect(h.decideSpy).toHaveBeenCalledTimes(2);
  });

  it('Log only: a repeat sends no request and says so', async () => {
    const h = cached('shadow', async () => answered({ m1: 0.9, m2: 0.1 }));
    expect(await runJevMemoryGate({ workspaceId: 'ws', message: 'q', candidates: CANDS }, h.deps)).toEqual({ effective: 'shadow', fired: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(await runJevMemoryGate({ workspaceId: 'ws', message: 'q', candidates: CANDS }, h.deps)).toEqual({
      effective: 'shadow',
      fired: false,
      cached: true,
    });
    expect(h.decideSpy).toHaveBeenCalledTimes(1);
  });

  it('runs in production on the operator cache with the documented TTL', () => {
    expect(JEV_MEMORY_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('runJevMemoryGate — per-port policy (WI-10004485)', () => {
  it('runs On as Log only on a no-wait port: the request fires, nothing waits, nothing is dropped', async () => {
    expect([...JEV_MEMORY_NO_WAIT_PORTS]).toEqual(['mid-turn']);
    const never = new Promise<DecisionOutcome<QuestionMap>>(() => undefined);
    const h = harness('on', () => never);
    const r = await runJevMemoryGate({ message: 'where does deploy run', candidates: CANDS, port: 'mid-turn' }, h.deps);
    expect(r).toEqual({ effective: 'shadow', fired: true });
    expect(h.decideSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['turn-start', 'initialize', undefined])('waits for the answer on port %s', async (port) => {
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.1 }));
    const r = await runJevMemoryGate({ message: 'q', candidates: CANDS, ...(port ? { port } : {}) }, h.deps);
    expect(r).toMatchObject({ effective: 'on', outcome: 'answered', keep: [true, false] });
  });

  it('never turns Log only into On on any port', async () => {
    const h = harness('shadow', async () => answered({ m1: 0.9, m2: 0.1 }));
    expect(await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'turn-start' }, h.deps)).toEqual({ effective: 'shadow', fired: true });
  });
});

describe('runJevMemoryGate — the wait fits the caller’s wall (WI-10004485 step C)', () => {
  it('waits the full cap with no wall, what is left of the wall up to the cap, and not at all below the floor', () => {
    // The cap must clear the slowest healthy-provider answer measured from a quiet
    // process on 2026-10-01 (639 ms); 400 ms timed out 2.3% of healthy answers.
    expect(JEV_MEMORY_TIMEOUT_MS).toBeGreaterThan(639);
    expect(jevMemoryWaitMs(undefined)).toBe(JEV_MEMORY_TIMEOUT_MS);
    expect(jevMemoryWaitMs(Number.NaN)).toBe(JEV_MEMORY_TIMEOUT_MS);
    expect(jevMemoryWaitMs(JEV_MEMORY_TIMEOUT_MS + 5_000)).toBe(JEV_MEMORY_TIMEOUT_MS);
    expect(jevMemoryWaitMs(500.9)).toBe(500);
    expect(jevMemoryWaitMs(JEV_MEMORY_MIN_WAIT_MS)).toBe(JEV_MEMORY_MIN_WAIT_MS);
    expect(jevMemoryWaitMs(JEV_MEMORY_MIN_WAIT_MS - 1)).toBeNull();
    expect(jevMemoryWaitMs(-200)).toBeNull();
  });

  it('On waits under what is left of the wall, and the call runs under that same bound', async () => {
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.1 }));
    const r = await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'turn-start', budgetMs: 500 }, h.deps);
    expect(r).toMatchObject({ effective: 'on', outcome: 'answered', keep: [true, false] });
    expect(h.decideSpy.mock.calls[0][1]?.timeoutMs).toBe(500);
  });

  it('On does not wait when less than the floor is left: it runs Log only under the full cap', async () => {
    const never = new Promise<DecisionOutcome<QuestionMap>>(() => undefined);
    const h = harness('on', () => never);
    const r = await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'turn-start', budgetMs: JEV_MEMORY_MIN_WAIT_MS - 1 }, h.deps);
    expect(r).toEqual({ effective: 'shadow', fired: true });
    expect(h.decideSpy.mock.calls[0][1]?.timeoutMs).toBe(JEV_MEMORY_TIMEOUT_MS);
  });

  it('Log only on a waiting port measures under the bound On would wait', async () => {
    const h = harness('shadow', async () => answered({ m1: 0.9, m2: 0.1 }));
    await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'turn-start', budgetMs: 600 }, h.deps);
    expect(h.decideSpy.mock.calls[0][1]?.timeoutMs).toBe(600);
  });

  it('a no-wait port always runs under the full cap: nothing waits there, whatever the wall', async () => {
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.1 }));
    await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'mid-turn', budgetMs: 300 }, h.deps);
    expect(h.decideSpy.mock.calls[0][1]?.timeoutMs).toBe(JEV_MEMORY_TIMEOUT_MS);
  });

  it('records the surface with every call, and records none when the caller passes none', async () => {
    const h = harness('on', async () => answered({ m1: 0.9, m2: 0.9 }));
    await runJevMemoryGate({ message: 'q', candidates: CANDS, port: 'turn-start', surface: 'turn-start' }, h.deps);
    await runJevMemoryGate({ message: 'q2', candidates: CANDS }, h.deps);
    expect(h.decideSpy.mock.calls[0][1]?.surface).toBe('turn-start');
    expect(h.decideSpy.mock.calls[1][1]).not.toHaveProperty('surface');
  });
});
