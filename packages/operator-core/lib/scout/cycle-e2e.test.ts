/**
 * Scout loop — P-014 full-cycle E2E (hive-creative-ideation-2026-06-08).
 *
 * The plan's acceptance test: "a full AUTONOMOUS cycle produces ≥1 Queen-greenlit
 * broad-scope idea (→ plan) + ≥1 gym-tested small idea, with NO human prompt."
 *
 * This drives the REAL composition + the REAL routing/cadence logic with an
 * injected fake `ScoutLlmCall` + fake dispatch ports — deterministic, $0, no
 * network (the per-step LLM *quality* — grounded/non-duplicate/bettable — is the
 * P-009 invariants suite + the per-step unit tests; this asserts the end-to-end
 * OUTCOME + autonomy). What is real here:
 *   • the cadence gate `shouldRunScoutCycle` (autonomy: fleet-state-triggered,
 *     never a human prompt);
 *   • the router `routeProposals` (broad→plan / testable→gym / concrete→improvement)
 *     with fake dispatch ports capturing the created artifacts;
 *   • `runScoutCycle` wiring the five steps, recording every LLM call, dropping
 *     `reject` critiques, and deriving per-idea lens provenance (P-013).
 *
 * "No human prompt" is STRUCTURAL: `runScoutCycle(deps)` and `shouldRunScoutCycle(state)`
 * take only machine inputs — there is no human-input parameter and no `askUser`
 * anywhere in the cycle; we additionally assert every recorded LLM call was issued
 * by a Scout step (not a human).
 */
import { describe, it, expect } from 'vitest';
import { runScoutCycle } from './cycle';
import type { ScoutCycleDeps } from './cycle';
import { routeProposals } from './router';
import type { RouterPorts, PlanDraftRequest, CaptureRequest, RoutingDecision } from './router';
import { shouldRunScoutCycle } from './cadence';
import type { ScoutCadenceState } from './cadence';
import type { SeedDistantResult, ScoutIdeaView } from './gym-bridge';
import type { Idea, Proposal, ScoredIdea } from './types';
import {
  makeFakeScoutLlm,
  fixtureCorpusDigest,
  fixtureCorpusEntry,
  fixtureIdea,
  fixtureScoredIdea,
  fixtureProposal,
  fixtureScoutExperiment,
  digestRefs,
} from './test-support';

/* ── A grounded broad idea + a grounded small idea, distinct lenses ────────── */

const BROAD_IDEA: Idea = fixtureIdea({
  id: 'idea-reframing-broad',
  lens: 'reframing',
  title: 'reframe lock contention as a scheduling-fairness problem',
  addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
});

const SMALL_IDEA: Idea = fixtureIdea({
  id: 'idea-constraint-small',
  lens: 'constraint-removal',
  title: 'drop the per-edit lock TTL floor',
  seedDomain: undefined,
  addressesPatternRefs: ['plan:flaky-coord-tests-2026-05-30'],
});

/** Broad → 'plan' (a cross-cutting reframe → a plan draft for Queen/owner review). */
const BROAD_PROPOSAL: Proposal = fixtureProposal({
  id: 'prop-broad',
  framing: 'lock contention is a scheduling-fairness problem, not a retry problem',
  routeHint: 'plan',
  sourceIdeaIds: [BROAD_IDEA.id],
  addressesPatternRefs: BROAD_IDEA.addressesPatternRefs,
});

/** Small/testable → 'gym' (a bounded prompt/process tweak the gym can A/B). */
const SMALL_PROPOSAL: Proposal = fixtureProposal({
  id: 'prop-small',
  framing: 'lower the lock TTL floor and measure flake rate',
  routeHint: 'gym',
  cheapExperiment: fixtureScoutExperiment({ method: 'A/B the TTL floor across 100 coord-test runs' }),
  sourceIdeaIds: [SMALL_IDEA.id],
  addressesPatternRefs: SMALL_IDEA.addressesPatternRefs,
});

/** A fake set of router dispatch ports that records what each rail dispatched. */
function makeFakeRouterPorts() {
  const planDrafts: PlanDraftRequest[] = [];
  const gymSeeded: ScoutIdeaView[][] = [];
  const captured: CaptureRequest[] = [];
  const ports: RouterPorts = {
    plansNew: async (req) => {
      planDrafts.push(req);
      return { slug: `${req.slugStem}-2026-06-08` };
    },
    gymDispatch: async (ideas) => {
      gymSeeded.push(ideas);
      const result: SeedDistantResult = {
        seeded: ideas.map((v) => ({ ideaId: v.id, nicheKey: 'module|x|low', admitted: true, distance: 1 })),
        newNiches: ['module|x|low'],
        skipped: [],
      };
      return result;
    },
    capture: async (req) => {
      captured.push(req);
      return { id: `EI-${captured.length}`, created: true };
    },
  };
  return { ports, planDrafts, gymSeeded, captured };
}

/**
 * Build cycle deps that wire fake step ports (returning the broad + small
 * fixtures) and the REAL router as the `route` port (adapted to the cycle's
 * RouteDecision shape). Each LLM-touching port issues one recorded call so the
 * no-human-prompt + cost invariants have data.
 */
function makeCycleDeps(over: {
  ideas?: Idea[];
  critiques?: ScoredIdea[];
  proposals?: Proposal[];
  routerPorts?: RouterPorts;
} = {}): { deps: ScoutCycleDeps; fakeLlm: ReturnType<typeof makeFakeScoutLlm> } {
  const fakeLlm = makeFakeScoutLlm();
  const ideas = over.ideas ?? [BROAD_IDEA, SMALL_IDEA];
  const critiques =
    over.critiques ??
    ideas.map((idea) => fixtureScoredIdea({ idea, verdict: 'keep' }));
  const proposals = over.proposals ?? [BROAD_PROPOSAL, SMALL_PROPOSAL];
  const routerPorts = over.routerPorts ?? makeFakeRouterPorts().ports;

  const deps: ScoutCycleDeps = {
    llmCall: fakeLlm.call,
    cycleId: 'cycle-e2e-1',
    readCorpus: async () => fixtureCorpusDigest(),
    readNoveltyCorpus: async () => [fixtureCorpusEntry()],
    ideate: async (_digest, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      return ideas;
    },
    critique: async (_ideas, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
      return critiques;
    },
    recombine: async (_survivors, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
      return proposals;
    },
    // REAL router as the route port — the cycle consumes router's RoutingDecision[] directly.
    route: async (props): Promise<RoutingDecision[]> => {
      const result = await routeProposals(props, routerPorts);
      return result.decisions;
    },
  };
  return { deps, fakeLlm };
}

/* ────────────────────────────────────────────────────────────────────────
 * 1. Autonomy — the cycle is triggered by FLEET STATE, never a human prompt.
 * ──────────────────────────────────────────────────────────────────────── */

describe('P-014 — autonomous cadence (no human prompt triggers a cycle)', () => {
  const baseState = (over: Partial<ScoutCadenceState> = {}): ScoutCadenceState => ({
    idleRatio: 0.1,
    frictionSignals: 0,
    lastRunAtMs: null,
    nowMs: 2_000_000_000_000,
    ...over,
  });

  it('fires on idle capacity (fleet has room to explore)', () => {
    const v = shouldRunScoutCycle(baseState({ idleRatio: 0.9 }));
    expect(v.fire).toBe(true);
    expect(v.reason).toBe('idle-capacity');
  });

  it('fires on accumulated friction even when the fleet is busy', () => {
    const v = shouldRunScoutCycle(baseState({ idleRatio: 0.05, frictionSignals: 5 }));
    expect(v.fire).toBe(true);
    expect(v.reason).toBe('friction-triggered');
  });

  it('withholds when busy and a cycle just ran (min-interval floor)', () => {
    const now = 2_000_000_000_000;
    const v = shouldRunScoutCycle(baseState({ idleRatio: 0.05, lastRunAtMs: now - 60_000, nowMs: now }));
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('min-interval');
    expect(v.retryAfterSec).toBeGreaterThan(0);
  });

  it('withholds when no trigger is met (busy, interval elapsed, below heartbeat)', () => {
    const now = 2_000_000_000_000;
    // 2h since last run: past the 1h min-interval, below the 24h heartbeat, idle below threshold.
    const v = shouldRunScoutCycle(baseState({ idleRatio: 0.1, lastRunAtMs: now - 7_200_000, nowMs: now }));
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('no-trigger');
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2. The full autonomous cycle: broad→plan + small→gym, no human prompt.
 * ──────────────────────────────────────────────────────────────────────── */

describe('P-014 — full autonomous cycle yields a broad→plan + a small→gym', () => {
  it('runs end-to-end and routes a broad idea to a plan draft and a small idea to the gym', async () => {
    const fakePorts = makeFakeRouterPorts();
    const { deps, fakeLlm } = makeCycleDeps({ routerPorts: fakePorts.ports });

    const result = await runScoutCycle(deps);

    // The cycle completed the full pipeline.
    expect(result.stop).toBe('completed');
    expect(result.ideas).toHaveLength(2);
    expect(result.proposals).toHaveLength(2);

    // ≥1 Queen-greenlit broad idea → a plan DRAFT (owner/Queen-visible; greenlight
    // = the draft existing for promotion — su-80be9's Risk-B structural answer).
    const planRoutes = result.routed.filter((r) => r.rail === 'plan');
    expect(planRoutes.length).toBeGreaterThanOrEqual(1);
    expect(fakePorts.planDrafts.length).toBeGreaterThanOrEqual(1);
    expect(planRoutes[0].routedRef).toMatch(/^plan:/);

    // ≥1 gym-tested small idea → a gym dispatch (the QD-archive seed).
    const gymRoutes = result.routed.filter((r) => r.rail === 'gym');
    expect(gymRoutes.length).toBeGreaterThanOrEqual(1);
    expect(fakePorts.gymSeeded.length).toBeGreaterThanOrEqual(1);
    expect(gymRoutes[0].routedRef).toMatch(/^gym:/);

    // P-013 provenance: each routed proposal expands to its source idea's lens —
    // distinct lenses preserved (the forced-diversity payoff carried to outcomes).
    const lenses = new Set(result.provenance.map((p) => p.lens));
    expect(result.provenance.length).toBeGreaterThanOrEqual(2);
    expect(lenses.has('reframing')).toBe(true);
    expect(lenses.has('constraint-removal')).toBe(true);

    // NO HUMAN PROMPT: every LLM call was issued by a Scout step (ideate/critique/
    // recombine/route) — the cycle is driven solely by the injected call + ports,
    // never a human. (Structurally, runScoutCycle takes no human-input parameter.)
    expect(result.calls.length).toBeGreaterThan(0);
    expect(result.calls.every((c) => ['ideate', 'critique', 'recombine', 'route'].includes(c.step))).toBe(true);
    expect(fakeLlm.count()).toBe(result.calls.length);
    expect(result.costUsd).toBe(result.calls.reduce((s, c) => s + c.costUsd, 0));
  });

  it('grounds every routed proposal in the corpus digest (no ungrounded leap ships)', async () => {
    const { deps } = makeCycleDeps();
    const result = await runScoutCycle(deps);
    const refs = new Set(digestRefs(result.digest));
    for (const proposal of result.proposals) {
      expect(proposal.addressesPatternRefs.length).toBeGreaterThan(0);
      for (const ref of proposal.addressesPatternRefs) expect(refs.has(ref)).toBe(true);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 3. Routing realism — the REAL classifier sends each rail where it belongs.
 * ──────────────────────────────────────────────────────────────────────── */

describe('P-014 — routing realism (real router): broad→plan, testable→gym, concrete→improvement', () => {
  it('dispatches each rail through its port and stamps the change-feed ref', async () => {
    const fakePorts = makeFakeRouterPorts();
    const concrete = fixtureProposal({ id: 'prop-concrete', routeHint: 'improvement', sourceIdeaIds: ['idea-x'] });
    const noHint = fixtureProposal({ id: 'prop-nohint', routeHint: undefined, sourceIdeaIds: ['idea-y'] });

    const result = await routeProposals(
      [BROAD_PROPOSAL, SMALL_PROPOSAL, concrete, noHint],
      fakePorts.ports,
    );

    expect(result.byRail.plan).toBe(1);
    expect(result.byRail.gym).toBe(1);
    // concrete (hinted) + noHint (defaults to improvement) → 2 on the improvement rail.
    expect(result.byRail.improvement).toBe(2);
    expect(result.failed).toHaveLength(0);

    const byId = new Map(result.decisions.map((d) => [d.proposalId, d]));
    expect(byId.get('prop-broad')!.routedRef).toMatch(/^plan:scout-/);
    expect(byId.get('prop-small')!.routedRef).toBe('gym:prop-small');
    expect(byId.get('prop-concrete')!.routedRef).toMatch(/^wi:EI-/);
    expect(byId.get('prop-nohint')!.followedHint).toBe(false);

    expect(fakePorts.gymSeeded[0].map((v) => v.id)).toContain('prop-small');
  });

  it('a failing dispatch sink fails only its own decision, never the batch', async () => {
    const ports: RouterPorts = {
      plansNew: async () => { throw new Error('plans:new down'); },
      gymDispatch: async (ideas) => ({ seeded: ideas.map((v) => ({ ideaId: v.id, nicheKey: 'n', admitted: true, distance: 1 })), newNiches: [], skipped: [] }),
      capture: async () => ({ id: 'EI-9', created: true }),
    };
    const result = await routeProposals([BROAD_PROPOSAL, SMALL_PROPOSAL], ports);
    expect(result.failed).toEqual(['prop-broad']); // plan sink threw
    expect(result.byRail.gym).toBe(1); // gym still dispatched
    const small = result.decisions.find((d) => d.proposalId === 'prop-small')!;
    expect(small.routedRef).toBe('gym:prop-small');
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4. Graceful early exits — the autonomous loop degrades without a human.
 * ──────────────────────────────────────────────────────────────────────── */

describe('P-014 — the cycle exits cleanly when a stage is empty (no human needed)', () => {
  it('stops at no-ideas when ideation is empty', async () => {
    const { deps } = makeCycleDeps({ ideas: [] });
    const result = await runScoutCycle(deps);
    expect(result.stop).toBe('no-ideas');
    expect(result.routed).toHaveLength(0);
  });

  it('stops at no-survivors when every idea is rejected', async () => {
    const critiques = [BROAD_IDEA, SMALL_IDEA].map((idea) => fixtureScoredIdea({ idea, verdict: 'reject' }));
    const { deps } = makeCycleDeps({ critiques });
    const result = await runScoutCycle(deps);
    expect(result.stop).toBe('no-survivors');
    expect(result.survivors).toHaveLength(0);
  });

  it('stops at no-proposals when recombine yields nothing', async () => {
    const { deps } = makeCycleDeps({ proposals: [] });
    const result = await runScoutCycle(deps);
    expect(result.stop).toBe('no-proposals');
    expect(result.routed).toHaveLength(0);
  });

  it('keeps moonshot critiques as survivors (D-005 — leaps are not over-pruned)', async () => {
    const critiques = [
      fixtureScoredIdea({ idea: BROAD_IDEA, verdict: 'moonshot' }),
      fixtureScoredIdea({ idea: SMALL_IDEA, verdict: 'reject' }),
    ];
    const { deps } = makeCycleDeps({ critiques });
    const result = await runScoutCycle(deps);
    expect(result.survivors.map((s) => s.idea.id)).toEqual([BROAD_IDEA.id]);
  });
});
