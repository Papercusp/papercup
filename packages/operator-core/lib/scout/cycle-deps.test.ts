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
import type { StateOfHiveReaders } from './corpus-digest';
import type { CorpusEntry } from './critique-core';
import type { ArchivePort } from './gym-bridge';
import type { PlanDraftCreator } from './router-deps';

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
