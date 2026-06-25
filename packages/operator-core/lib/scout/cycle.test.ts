/**
 * Scout loop — `runScoutCycle` composition tests (hive-creative-ideation-2026-06-08, the P-003…P-007 seam).
 *
 * The cycle is pure orchestration over injected ports, so these tests use FAKE
 * ports + su-b6c3f's shared `./test-support` fakes (no network, $0). They pin
 * the composition's own invariants — the wiring, the survivor filter, the
 * per-idea provenance derivation (via ce4bd's `decisionsToProvenance`), the
 * budget short-circuits, and the no-human-prompt guarantee — independently of
 * any peer's step implementation.
 *
 * Run from inside the package: `cd packages/operator-core && npx vitest run lib/scout/cycle`.
 */
import { describe, it, expect } from 'vitest';
import {
  makeFakeScoutLlm,
  fixtureCorpusDigest,
  fixtureIdeasAllLenses,
  FIXTURE_PATTERN_REFS,
} from './test-support';
import type { CorpusEntry } from './critique-core';
import type { RoutingDecision } from './router';
import type { Idea, Proposal, ScoredIdea } from './types';
import {
  runScoutCycle,
  selectSurvivors,
  type ScoutCycleDeps,
  type ScoutCyclePorts,
} from './cycle';

/* ── fixture builders ─────────────────────────────────────────────────── */

const NOVELTY_CORPUS: CorpusEntry[] = [
  { ref: 'plan:lock-contention-2026-06-01', kind: 'plan', text: 'lock contention re-queue' },
];

function scoredFrom(idea: Idea, verdict: ScoredIdea['verdict']): ScoredIdea {
  return { idea, novelty: 0.8, feasibility: 0.7, noveltyMatches: [], verdict, notes: `${verdict} note` };
}

function proposalFrom(id: string, sourceIdeaIds: string[], over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    framing: 'framing',
    mechanism: 'mechanism',
    whyNew: 'why-new',
    bet: 'the bet',
    cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 'f' },
    sourceIdeaIds,
    addressesPatternRefs: [FIXTURE_PATTERN_REFS[4]],
    ...over,
  };
}

/** A per-proposal routing decision (ce4bd's shape) the fake route port returns. */
function decisionFor(p: Proposal, rail: RoutingDecision['rail']): RoutingDecision {
  return {
    proposalId: p.id,
    sourceIdeaIds: [...p.sourceIdeaIds],
    rail,
    reason: `routed → ${rail}`,
    followedHint: false,
    title: p.framing,
    routedRef: `${rail === 'improvement' ? 'wi' : rail}:${p.id}`,
  };
}

/**
 * Build a full set of fake ports + a recording fake LLM. Each LLM-touching port
 * calls `ctx.llmCall` so the cycle's recorder + cost accounting are exercised.
 * Knobs let each test shape the per-step output + observe what the ports saw.
 */
function makeDeps(opts: {
  ideas?: Idea[];
  verdicts?: ScoredIdea['verdict'][]; // one per idea (default: all 'keep')
  proposals?: (scored: ScoredIdea[]) => Proposal[];
  routed?: (proposals: Proposal[]) => RoutingDecision[];
  costUsd?: number;
  limits?: ScoutCycleDeps['limits'];
  onPhase?: ScoutCycleDeps['onPhase'];
} = {}): {
  deps: ScoutCycleDeps;
  seen: { maxIdeators?: number; critiqueCorpus?: CorpusEntry[]; recombineInput?: ScoredIdea[] };
} {
  const ideas = opts.ideas ?? fixtureIdeasAllLenses();
  const fake = makeFakeScoutLlm({ costUsd: opts.costUsd ?? 0.01 });
  const seen: { maxIdeators?: number; critiqueCorpus?: CorpusEntry[]; recombineInput?: ScoredIdea[] } = {};

  const ports: ScoutCyclePorts = {
    readCorpus: async () => fixtureCorpusDigest(),
    readNoveltyCorpus: async () => NOVELTY_CORPUS,
    ideate: async (_digest, ctx) => {
      seen.maxIdeators = ctx.maxIdeators;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      return typeof ctx.maxIdeators === 'number' ? ideas.slice(0, ctx.maxIdeators) : ideas;
    },
    critique: async (ins, ctx) => {
      seen.critiqueCorpus = ctx.corpus;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
      return ins.map((idea, i) => scoredFrom(idea, opts.verdicts?.[i] ?? 'keep'));
    },
    recombine: async (scored, ctx) => {
      seen.recombineInput = scored;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
      if (opts.proposals) return opts.proposals(scored);
      const survivors = selectSurvivors(scored);
      // one fused proposal over all surviving ideas (the realistic recombine output)
      return survivors.length ? [proposalFrom('P-1', survivors.map((s) => s.idea.id))] : [];
    },
    route: async (proposals) =>
      opts.routed ? opts.routed(proposals) : proposals.map((p) => decisionFor(p, 'plan')),
  };

  return { deps: { ...ports, llmCall: fake.call, limits: opts.limits, ...(opts.onPhase ? { onPhase: opts.onPhase } : {}) }, seen };
}

/* ── happy path ───────────────────────────────────────────────────────── */

describe('runScoutCycle — full pass', () => {
  it('completes the digest→ideate→critique→recombine→route pipeline', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('completed');
    expect(r.digest.recurringFriction.length).toBeGreaterThan(0);
    expect(r.ideas).toHaveLength(4); // one per lens
    expect(r.scored).toHaveLength(4);
    expect(r.survivors).toHaveLength(4); // default all 'keep'
    expect(r.proposals).toHaveLength(1);
    expect(r.routed).toHaveLength(1);
    expect(r.routed[0]).toMatchObject({ proposalId: 'P-1', rail: 'plan', routedRef: 'plan:P-1' });
  });

  it('records every LLM call across the three spending steps and sums cost', async () => {
    const { deps } = makeDeps({ costUsd: 0.02 });
    const r = await runScoutCycle(deps);

    // ideate + critique + recombine each call once; route spends no LLM.
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']);
    expect(r.costUsd).toBeCloseTo(0.06, 5);
  });

  it('reports the active phase before each awaited cycle step', async () => {
    const phases: string[] = [];
    const { deps } = makeDeps({ onPhase: (phase) => phases.push(phase) });
    await runScoutCycle(deps);
    expect(phases).toEqual(['read-corpus', 'ideate', 'read-novelty-corpus', 'critique', 'recombine', 'route']);
  });

  it('feeds the novelty corpus to the critique step and the budget cap to ideate', async () => {
    const { deps, seen } = makeDeps({ limits: { maxIdeators: 2 } });
    const r = await runScoutCycle(deps);

    expect(seen.maxIdeators).toBe(2);
    expect(seen.critiqueCorpus).toEqual(NOVELTY_CORPUS);
    expect(r.ideas).toHaveLength(2); // clamped by maxIdeators
  });

  it('passes ALL scored ideas to recombine (the port filters survivors internally)', async () => {
    const { deps, seen } = makeDeps({ verdicts: ['keep', 'reject', 'moonshot', 'reject'] });
    await runScoutCycle(deps);
    expect(seen.recombineInput).toHaveLength(4); // not pre-filtered to survivors
  });
});

/* ── survivor selection (D-005) ───────────────────────────────────────── */

describe('selectSurvivors', () => {
  it('keeps keep + moonshot, drops reject', () => {
    const ideas = fixtureIdeasAllLenses();
    const scored = [
      scoredFrom(ideas[0], 'keep'),
      scoredFrom(ideas[1], 'reject'),
      scoredFrom(ideas[2], 'moonshot'),
      scoredFrom(ideas[3], 'reject'),
    ];
    expect(selectSurvivors(scored).map((s) => s.verdict)).toEqual(['keep', 'moonshot']);
  });
});

/* ── per-idea lens provenance (P-013 / D-009) ─────────────────────────── */

describe('runScoutCycle — provenance (P-013)', () => {
  it('attaches one provenance row per source idea of the routed proposal, carrying its lens', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);
    // 1 proposal fusing all 4 surviving ideas → 4 provenance rows, one per lens.
    expect(r.provenance).toHaveLength(4);
    expect(new Set(r.provenance.map((p) => p.lens))).toEqual(
      new Set(['analogical', 'first-principles', 'reframing', 'constraint-removal']),
    );
    for (const row of r.provenance) {
      expect(row.rail).toBe('plan');
      expect(row.routedRef).toBe('plan:P-1');
    }
  });

  it('carries the cycleId onto each provenance row when set', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle({ ...deps, cycleId: 'cyc-42' });
    expect(r.provenance.every((p) => p.cycleId === 'cyc-42')).toBe(true);
  });
});

/* ── short-circuits + budget (D-010) ──────────────────────────────────── */

describe('runScoutCycle — early exits', () => {
  it('stops at no-ideas when the ideators return nothing', async () => {
    const { deps } = makeDeps({ ideas: [] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-ideas');
    expect(r.proposals).toHaveLength(0);
  });

  it('stops at no-survivors when every idea is rejected', async () => {
    const { deps } = makeDeps({ verdicts: ['reject', 'reject', 'reject', 'reject'] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-survivors');
    expect(r.survivors).toHaveLength(0);
    expect(r.proposals).toHaveLength(0);
  });

  it('stops at no-proposals when recombine yields nothing', async () => {
    const { deps } = makeDeps({ proposals: () => [] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-proposals');
    expect(r.routed).toHaveLength(0);
  });

  it('halts at budget-exhausted once spend exceeds maxCostUsd (before recombine)', async () => {
    // ideate costs 0.01 > cap 0.005 → stop right after ideate, before critique.
    const { deps } = makeDeps({ costUsd: 0.01, limits: { maxCostUsd: 0.005 } });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('budget-exhausted');
    expect(r.calls.map((c) => c.step)).toEqual(['ideate']); // never reached critique
    expect(r.proposals).toHaveLength(0);
  });
});

/* ── autonomy: no human prompt entered the loop (D-010) ────────────────── */

describe('runScoutCycle — prompt-free autonomy', () => {
  it('issues only model calls with user/assistant roles — no human-input step', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const call of r.calls) {
      for (const m of call.messages) {
        expect(['user', 'assistant']).toContain(m.role);
      }
    }
    // The cycle's only input is `deps` (an injected llmCall + ports); there is
    // no human-input parameter and no human-gated step — autonomy is structural.
  });
});
