/**
 * Scout loop — `buildScoutCycleDeps` wiring tests (hive-creative-ideation-2026-06-08).
 *
 * These pin the PROD-WIRING this file uniquely owns — that each injected port is
 * bound to the right backend with options threaded through — WITHOUT re-driving
 * the full LLM pipeline (that's b6c3f's `cycle-e2e.test.ts`) or re-testing each
 * step module (their owners' suites). So: fake readers + the real `routeProposals`
 * with an injected ctx-bound plan creator, asserting the assembly + the ctx seam.
 *
 * Run from inside the package: `cd packages/operator-core && npx vitest run lib/scout/cycle-deps`.
 */
import { describe, it, expect } from 'vitest';
import { buildScoutCycleDeps, rosterForBudget } from './cycle-deps';
import { ScoutIdeatorsTransportError } from './ideators';
import { resolveScoutConfig } from './config';
import { makeFakeScoutLlm, fixtureProposal } from './test-support';
import { GRADER_FEEDBACK_HEADING, type GradedIdeaView } from './ideator-feedback-priming';
import type { StateOfHiveReaders } from './corpus-digest';
import type { CorpusEntry } from './critique-core';
import type { ArchiveEliteView, ArchivePort } from './gym-bridge';
import type { PlanDraftCreator } from './router-deps';
import type { CorpusDigest, Idea, ScoutLlmCall } from './types';

const EMPTY_READERS: StateOfHiveReaders = {
  completions: async () => [],
  reverts: async () => [],
  friction: async () => [],
  spend: async () => [],
  deferrals: async () => [],
};

const NOVELTY: CorpusEntry[] = [{ ref: 'plan:prior', kind: 'plan', text: 'a prior plan' }];

/** A never-exercised archive stub (the tests route to plan/improvement, not gym). */
const STUB_ARCHIVE = {} as ArchivePort;

function build(over: Partial<Parameters<typeof buildScoutCycleDeps>[0]> = {}) {
  const planDrafts: Array<{ slug: string; title: string }> = [];
  const createPlanDraft: PlanDraftCreator = async ({ slug, title }) => {
    planDrafts.push({ slug, title });
    return { slug };
  };
  const deps = buildScoutCycleDeps({
    harnessSlug: 'papercup',
    llmCall: makeFakeScoutLlm().call,
    createPlanDraft,
    archive: STUB_ARCHIVE,
    cycleId: 'cyc-deps-1',
    stateOfHiveReaders: EMPTY_READERS,
    digestOptions: { nowMs: 1_700_000_000_000 },
    noveltyCorpus: async () => NOVELTY,
    ...over,
  });
  return { deps, planDrafts };
}

describe('buildScoutCycleDeps — assembly', () => {
  it('returns deps with every port + passthrough llmCall / limits / cycleId', () => {
    const { deps } = build({ limits: { maxIdeators: 2, maxCostUsd: 1 } });
    for (const port of ['readCorpus', 'readNoveltyCorpus', 'ideate', 'critique', 'recombine', 'route'] as const) {
      expect(typeof deps[port]).toBe('function');
    }
    expect(deps.cycleId).toBe('cyc-deps-1');
    expect(deps.limits).toEqual({ maxIdeators: 2, maxCostUsd: 1 });
    expect(typeof deps.llmCall).toBe('function');
  });

  it('readCorpus delegates to the injected state-of-Hive readers → a CorpusDigest', async () => {
    const { deps } = build();
    const digest = await deps.readCorpus();
    for (const lane of ['recurringFriction', 'timeTokenSinks', 'chronicDeferrals', 'capabilityGaps'] as const) {
      expect(Array.isArray(digest[lane])).toBe(true);
    }
  });

  it('readNoveltyCorpus delegates to the injected reader', async () => {
    const { deps } = build();
    await expect(deps.readNoveltyCorpus()).resolves.toEqual(NOVELTY);
  });
});

describe('buildScoutCycleDeps — route wiring (ctx-bound plan creator)', () => {
  it('routes a broad proposal through the injected createPlanDraft → routedRef plan:<slug>', async () => {
    const { deps, planDrafts } = build();
    const proposal = fixtureProposal({ id: 'prop-broad', routeHint: 'plan', framing: 'a cross-cutting reframe' });

    const decisions = await deps.route([proposal]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].rail).toBe('plan');
    expect(decisions[0].routedRef).toMatch(/^plan:/);
    expect(decisions[0].proposalId).toBe('prop-broad');
    // The ctx-bound creator was actually invoked (the honest ctx seam).
    expect(planDrafts).toHaveLength(1);
    expect(decisions[0].routedRef).toBe(`plan:${planDrafts[0].slug}`);
  });
});

describe('buildScoutCycleDeps — ideate priming concat (C-4, scout-idea-grading P-005)', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  const GYM_HEADING = '## Gym stepping-stones';
  const ELITE: ArchiveEliteView = {
    nicheKey: 'module|sync|low',
    coords: { scope: 'module', domain: 'sync', risk: 'low' },
    candidateId: 'cand-1',
    fitness: 0.8,
    descriptor: { coords: { scope: 'module', domain: 'sync', risk: 'low' }, features: [0.5, 0.5, 1 / 3, 0] },
    source: 'gym',
  };
  const GRADED: GradedIdeaView[] = [
    {
      lens: 'reframing',
      ideaId: 'idea-g1',
      title: 'Speculative plan drafts',
      humanGrade: 5,
      humanFeedback: 'exactly the right altitude',
      gradedBy: 'owner',
      gradedAt: '2026-06-12T10:00:00.000Z',
    },
  ];

  /** A capturing fake LLM: records each ideator's user prompt, returns one valid idea. */
  function capturingLlm(): { seen: string[]; llmCall: ScoutLlmCall } {
    const seen: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      seen.push(opts.messages.map((m) => m.content).join('\n'));
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    return { seen, llmCall };
  }

  it('grader feedback reaches EVERY ideator prompt, concatenated BELOW the gym stepping-stones', async () => {
    const { deps } = build({
      archive: { listElites: () => [ELITE], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => GRADED,
    });
    const { seen, llmCall } = capturingLlm();
    const ideas = await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(ideas.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2); // one per budget-clamped lens
    for (const prompt of seen) {
      const gymIdx = prompt.indexOf(GYM_HEADING);
      const graderIdx = prompt.indexOf(GRADER_FEEDBACK_HEADING);
      expect(gymIdx).toBeGreaterThan(-1);
      expect(graderIdx).toBeGreaterThan(gymIdx); // grader block sits BELOW the stones
      expect(prompt).toContain('- [★5 · Owner · reframing] Speculative plan drafts: exactly the right altitude');
    }
  });

  it('with no gym stones, the grader block still primes every ideator on its own', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => GRADED,
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    for (const prompt of seen) {
      expect(prompt).not.toContain(GYM_HEADING);
      expect(prompt).toContain(GRADER_FEEDBACK_HEADING);
    }
  });

  it('with nothing graded and no stones, prompts carry no priming block (clean cold start)', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => [],
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    for (const prompt of seen) {
      expect(prompt).not.toContain(GYM_HEADING);
      expect(prompt).not.toContain(GRADER_FEEDBACK_HEADING);
    }
  });
});

describe('buildScoutCycleDeps — P-010 per-blueprint scout framing', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  // Hermetic ideate inputs: empty archive + empty grader reader ⇒ no PG, no priming.
  const HERMETIC = {
    archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as ArchivePort,
    graderFeedbackReader: async () => [] as GradedIdeaView[],
  };
  const WORK = {
    ideatorMission: 'You are a SCOUT for a WORK hive that ships deliverables.',
    criticMission: 'You are TWO critics judging an idea proposed for a WORK hive.',
  };

  /** Capturing fake recording each call's SYSTEM prompt; returns the shape each step needs. */
  function capturingSystems(): { systems: string[]; llmCall: ScoutLlmCall } {
    const systems: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      const system = opts.system ?? '';
      systems.push(system);
      const json = system.includes('NOVELTY critic')
        ? { conceptualNovelty: 0.9, feasibility: 0.9, rationale: 'ok' }
        : { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] };
      return { text: '', json, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    };
    return { systems, llmCall };
  }

  it('threads framing.ideatorMission into every ideator system prompt', async () => {
    const { deps } = build({ ...HERMETIC, scoutConfig: resolveScoutConfig({ framing: WORK }) });
    const { systems, llmCall } = capturingSystems();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(systems).toHaveLength(2);
    for (const sys of systems) {
      expect(sys).toContain(WORK.ideatorMission);
      expect(sys).not.toContain('multi-agent coding platform');
      expect(sys).toContain('addressesPatternRefs'); // engine output contract preserved
    }
  });

  it('threads framing.criticMission into the critic system prompt', async () => {
    const { deps } = build({ scoutConfig: resolveScoutConfig({ framing: WORK }) });
    const { systems, llmCall } = capturingSystems();
    const i: Idea = { id: 'i1', lens: 'first-principles', title: 'x', body: 'y', mechanism: 'z', addressesPatternRefs: [] };
    await deps.critique([i], { llmCall, corpus: [] });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(WORK.criticMission);
    expect(systems[0]).not.toContain('multi-agent coding platform');
    expect(systems[0]).toContain('FEASIBILITY critic'); // engine mechanism preserved
  });

  it('default config (no framing override) keeps the coding-platform framing', async () => {
    const { deps } = build(HERMETIC); // no scoutConfig ⇒ DEFAULT_SCOUT_CONFIG
    const { systems, llmCall } = capturingSystems();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 1 });
    expect(systems[0]).toContain('multi-agent coding platform');
  });
});

describe('buildScoutCycleDeps — transport-death observability (P-002)', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  const HERMETIC = {
    archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as ArchivePort,
    graderFeedbackReader: async () => [] as GradedIdeaView[],
  };

  it('throws ScoutIdeatorsTransportError when EVERY ideator LLM call fails and 0 ideas result', async () => {
    const { deps } = build(HERMETIC);
    const throwingLlm: ScoutLlmCall = async () => {
      throw new Error('gateway 401: upstream stall');
    };
    await expect(deps.ideate(DIGEST, { llmCall: throwingLlm, maxIdeators: 2 })).rejects.toThrow(
      ScoutIdeatorsTransportError,
    );
    await expect(deps.ideate(DIGEST, { llmCall: throwingLlm, maxIdeators: 2 })).rejects.toThrow(
      /all 2 ideator LLM call\(s\) failed/,
    );
  });

  it('does NOT throw when ideators run fine but genuinely produce no ideas (resolves to [])', async () => {
    const { deps } = build(HERMETIC);
    const emptyLlm: ScoutLlmCall = async () => ({
      text: '',
      json: { ideas: [] },
      costUsd: 0.01,
      inputTokens: 1,
      outputTokens: 1,
    });
    await expect(deps.ideate(DIGEST, { llmCall: emptyLlm, maxIdeators: 2 })).resolves.toEqual([]);
  });

  it('does NOT throw on a PARTIAL failure — one dead ideator never kills the batch', async () => {
    const { deps } = build(HERMETIC);
    let n = 0;
    const flakyLlm: ScoutLlmCall = async () => {
      n += 1;
      if (n === 1) throw new Error('one ideator 429');
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0.01,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const ideas = await deps.ideate(DIGEST, { llmCall: flakyLlm, maxIdeators: 2 });
    expect(ideas.length).toBeGreaterThan(0);
  });
});

describe('rosterForBudget', () => {
  it('runs all lenses when the budget is undefined or ≥ the lens count', () => {
    expect(rosterForBudget(undefined)).toEqual({});
    expect(rosterForBudget(4)).toEqual({});
    expect(rosterForBudget(99)).toEqual({});
  });

  it('clamps to the first N lenses below the lens count, never below one', () => {
    expect(rosterForBudget(2)).toEqual({ lenses: ['analogical', 'first-principles'] });
    expect(rosterForBudget(1)).toEqual({ lenses: ['analogical'] });
    expect(rosterForBudget(0)).toEqual({ lenses: ['analogical'] });
  });
});
