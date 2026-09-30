import { describe, expect, it, vi } from 'vitest';

import type { DecisionClient, DecisionOutcome, QuestionMap } from '@papercusp/decision-model';

import {
  JEV_MEMORY_ADMIT_THRESHOLD,
  JEV_MEMORY_CONSUMER,
  JEV_MEMORY_ENCODING,
  runJevMemoryGate,
  type JevMemoryGateDeps,
} from './jev-memory-gate';

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
  options?: { readonly consumer?: string; readonly subjectIds?: readonly string[] },
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
    expect(options).toEqual({ consumer: JEV_MEMORY_CONSUMER, subjectIds: ['mem-a', 'mem-b'] });
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

  it('uses the D-013 operating point: instructions encoding, P(yes) >= 0.3', async () => {
    // D-013 measured exactly this pair; changing either value voids those numbers
    // until P-004 and P-005 are re-run (see the constants' doc comment).
    expect(JEV_MEMORY_ENCODING).toBe('instructions');
    expect(JEV_MEMORY_ADMIT_THRESHOLD).toBe(0.3);
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
