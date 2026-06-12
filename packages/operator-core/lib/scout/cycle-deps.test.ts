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
import { makeFakeScoutLlm, fixtureProposal } from './test-support';
import { GRADER_FEEDBACK_HEADING, type GradedIdeaView } from './ideator-feedback-priming';
import type { StateOfHiveReaders } from './corpus-digest';
import type { CorpusEntry } from './critique-core';
import type { ArchiveEliteView, ArchivePort } from './gym-bridge';
import type { PlanDraftCreator } from './router-deps';
import type { CorpusDigest, ScoutLlmCall } from './types';

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
