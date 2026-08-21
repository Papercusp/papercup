import { describe, expect, it, vi } from 'vitest';
import type { ScoutLlmCall } from '../scout/types';
import { dreamRunId, runDreamCycle, type DreamCycleDeps } from './dream-cycle';
import type { DreamRun } from './dream-run-store';
import type { DreamFragment, DreamFragmentPair } from './fragment-sampler';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const fragment = (id: string, kind: DreamFragment['kind']): DreamFragment => ({
  id,
  kind,
  ref: `${kind}:${id}`,
  text: `evidence from ${id}`,
  createdAt: new Date(NOW).toISOString(),
  harness: 'papercusp',
  embedding: [1, 0],
});
const pair: DreamFragmentPair = {
  anchor: fragment('recent', 'observation'),
  partner: fragment('remote', 'memory'),
  pairing: 'banded',
  similarity: 0.6,
};

function dreamRun(overrides: Partial<DreamRun> = {}): DreamRun {
  return {
    workspaceId: 'ws-1',
    runId: 'cycle-1:dream:1',
    cycleId: 'cycle-1',
    potSlug: 'papercusp',
    mode: 'manual',
    status: 'running',
    fragmentRefs: [],
    fragmentKinds: [],
    pairing: null,
    similarity: null,
    dreamerModel: null,
    reviewerModel: null,
    dreamUsage: null,
    reviewUsage: null,
    outcome: null,
    review: null,
    routedRef: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: null,
    startedAt: new Date(NOW).toISOString(),
    completedAt: null,
    spendRecordedAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function deps(overrides: Partial<DreamCycleDeps> = {}): DreamCycleDeps {
  return {
    llmCall: vi.fn(async () => {
      throw new Error('llmCall should be replaced by the injected dream/review seams');
    }) as ScoutLlmCall,
    preflight: vi.fn(async () => ({
      allow: true as const,
      loopId: 'dream:papercusp',
      cycleRemainingUsd: 1,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 5,
      rollingLoopCount: 0,
    })),
    loadSources: vi.fn(async () => ({
      fragments: [pair.anchor, pair.partner],
      census: { observations: 1, workItems: 0, memories: 1, stats: 0, indexed: 2, embedded: 2 },
      harnessScopes: ['harness:papercusp'],
      embeddingMode: 'test',
    })),
    readCorpus: vi.fn(async () => []),
    beginRun: vi.fn(async ({ runId, cycleId }) => ({ created: true, run: dreamRun({ runId, cycleId }) })),
    recordSelection: vi.fn(async ({ runId }) =>
      dreamRun({
        runId,
        fragmentRefs: [pair.anchor.ref, pair.partner.ref],
        fragmentKinds: [pair.anchor.kind, pair.partner.kind],
        pairing: pair.pairing,
        similarity: pair.similarity,
        dreamerModel: 'claude-haiku-4-5',
      }),
    ),
    finalizeRun: vi.fn(async (input) => {
      const usage = [input.dreamUsage, input.reviewUsage].filter((value) => value != null);
      return dreamRun({
        runId: input.runId,
        status: input.status,
        routedRef: input.routedRef ?? null,
        dreamUsage: input.dreamUsage ?? null,
        reviewUsage: input.reviewUsage ?? null,
        costUsd: usage.reduce((sum, value) => sum + value.costUsd, 0),
        completedAt: new Date(NOW).toISOString(),
      });
    }),
    recordSpend: vi.fn(async (run) => ({ recorded: run.costUsd > 0, costUsd: run.costUsd })),
    samplePair: vi.fn(() => pair),
    now: () => NOW,
    ...overrides,
  };
}

const INPUT = {
  workspaceId: 'ws-1',
  potSlug: 'papercusp',
  mode: 'manual' as const,
  cycleId: 'cycle-1',
  cycle: { maxDreamsPerCycle: 1, timeoutMs: 5_000 },
};

describe('dreamRunId', () => {
  it('derives replay-stable bounded attempt ids', () => {
    expect(dreamRunId('cycle-1', 0)).toBe('cycle-1:dream:1');
    expect(dreamRunId('cycle-1', 2)).toBe('cycle-1:dream:3');
    expect(() => dreamRunId('', 0)).toThrow('cycleId');
    expect(() => dreamRunId('cycle-1', -1)).toThrow('non-negative integer');
  });
});

describe('runDreamCycle', () => {
  it('returns without reading sources when the governor refuses', async () => {
    const loadSources = vi.fn();
    const d = deps({
      preflight: vi.fn(async () => ({
        allow: false as const,
        loopId: 'dream:papercusp',
        reason: 'rolling-cap-exceeded' as const,
        cycleRemainingUsd: 1,
        rollingSpentUsd: 5,
        rollingRemainingUsd: 0,
        rollingLoopCount: 1,
      })),
      loadSources,
    });

    await expect(runDreamCycle(INPUT, d)).resolves.toMatchObject({
      fired: false,
      reason: 'governor-refused',
      governorReason: 'rolling-cap-exceeded',
      attempts: 0,
    });
    expect(loadSources).not.toHaveBeenCalled();
  });

  it('persists a no-pair terminal result without making a model call', async () => {
    const dream = vi.fn();
    const review = vi.fn();
    const sink = vi.fn();
    const d = deps({ samplePair: vi.fn(() => null), dream, review, sink });

    await expect(runDreamCycle(INPUT, d)).resolves.toMatchObject({
      fired: true,
      reason: 'no-pair',
      attempts: 1,
      accepted: 0,
      runs: [{ runId: 'cycle-1:dream:1', status: 'no-pair', replayed: false }],
    });
    expect(d.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'cycle-1:dream:1', status: 'no-pair' }),
    );
    expect(dream).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it('runs dreamer, independent review, existing sink, finalize, and spend accounting once', async () => {
    const dream = vi.fn(async () => ({
      verdict: 'insight' as const,
      insight: {
        text: 'Use a completion watermark to suppress repeated recovery wakes.',
        requiresA: 'A supplies the repeated wake symptom.',
        requiresB: 'B supplies the watermark mechanism.',
        actionable: 'Replay two wake events and assert only one recovery.',
      },
      usage: { model: 'claude-haiku-4-5', costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
    }));
    const review = vi.fn(async () => ({
      verdict: 'accept' as const,
      stage: 'grader' as const,
      scores: { dependence: 2 as const, actionability: 2 as const, novelty: 1 as const },
      note: 'Both fragments are required.',
      priorMatches: [],
      usage: { model: 'claude-opus-5', costUsd: 0.02, inputTokens: 200, outputTokens: 30 },
    }));
    const sink = vi.fn(async () => ({
      sunk: true as const,
      ideaId: 'dream:cycle-1:dream:1',
      workItemId: 'WI-DREAM',
      routedRef: 'wi:WI-DREAM',
      sourceRefs: [pair.anchor.ref, pair.partner.ref],
      created: true,
    }));
    const d = deps({ dream, review, sink });

    await expect(runDreamCycle(INPUT, d)).resolves.toMatchObject({
      fired: true,
      reason: 'completed',
      attempts: 1,
      accepted: 1,
      costUsd: 0.03,
      newSpendUsd: 0.03,
      runs: [{ status: 'accepted', routedRef: 'wi:WI-DREAM', replayed: false }],
    });
    expect(d.recordSelection).toHaveBeenCalledBefore(d.finalizeRun as ReturnType<typeof vi.fn>);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ dreamRunId: 'cycle-1:dream:1' }));
    expect(d.recordSpend).toHaveBeenCalledTimes(1);
  });

  it('replays a terminal row without another model or sink call and without double-counting new spend', async () => {
    const terminal = dreamRun({
      status: 'accepted',
      fragmentRefs: [pair.anchor.ref, pair.partner.ref],
      fragmentKinds: [pair.anchor.kind, pair.partner.kind],
      costUsd: 0.03,
      routedRef: 'wi:WI-DREAM',
      completedAt: new Date(NOW).toISOString(),
      spendRecordedAt: new Date(NOW).toISOString(),
    });
    const dream = vi.fn();
    const review = vi.fn();
    const sink = vi.fn();
    const d = deps({
      beginRun: vi.fn(async () => ({ created: false, run: terminal })),
      recordSpend: vi.fn(async () => ({
        recorded: false,
        costUsd: 0.03,
        reason: 'already-recorded' as const,
      })),
      dream,
      review,
      sink,
    });

    await expect(runDreamCycle(INPUT, d)).resolves.toMatchObject({
      attempts: 1,
      accepted: 1,
      costUsd: 0.03,
      newSpendUsd: 0,
      runs: [{ status: 'accepted', replayed: true }],
    });
    expect(dream).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(d.finalizeRun).not.toHaveBeenCalled();
  });
});
