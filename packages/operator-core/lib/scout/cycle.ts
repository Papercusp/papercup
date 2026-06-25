/**
 * Scout loop — the end-to-end cycle composition (hive-creative-ideation-2026-06-08, the P-003…P-007 seam).
 *
 * `runScoutCycle` is the single entrypoint that wires the five Scout steps into
 * one autonomous, prompt-free pass:
 *
 *   corpus synthesis (P-003) → divergent generation (P-004) → adversarial
 *   critics (P-005) → debate + recombine (P-006) → routing (P-007).
 *
 * It is **pure orchestration over injected ports** — it owns no step's logic and
 * converges on the swarm's canonical contracts (`./types`, ce4bd's
 * {@link RoutingDecision} + {@link decisionsToProvenance}, su-80be9's
 * {@link RoutedIdeaProvenance}) rather than forking parallel types. So:
 *  - it unit-tests with fakes + `./test-support` (no network, $0, deterministic);
 *  - it couples to no peer's *implementation*, only their published contracts;
 *  - it is the entrypoint the verification lane drives (su-b6c3f P-014 / su-e8630
 *    P-009, contract invariant 7) and the cadence/budget layer wraps (su-80be9
 *    P-008: `tick → shouldRunScoutCycle → budget gate → runScoutCycle → routed`).
 *
 * Design rules carried from the plan's ratified decisions:
 *  - **Injected LLM (D-004 / gym:judge pattern):** every step takes the same
 *    {@link ScoutLlmCall}; the cycle wraps it in a recorder so spend + the
 *    "no human-authored prompt entered the loop" invariant (D-010) read from
 *    one place ({@link ScoutCycleResult.calls}).
 *  - **Survivors (D-005):** `keep` + `moonshot` proceed, `reject` is dropped (the
 *    recombine port re-filters internally; the cycle also surfaces `survivors`
 *    for observability + a no-survivors short-circuit, and the two agree).
 *  - **Per-cycle budget (D-010):** an optional `limits.maxCostUsd` halts the
 *    cycle before the next LLM-spending step — a belt to su-80be9's pre-fire
 *    budget-gate suspenders.
 *
 * PROVENANCE (P-013, D-009): a {@link Proposal} *fuses* multiple source ideas
 * (`sourceIdeaIds[]`), and the creative `lens` lives on {@link Idea}. The router
 * dispatches once per proposal (ce4bd's `routeProposals` is per-proposal) and the
 * cycle expands each routed decision to per-idea lens provenance via ce4bd's
 * {@link decisionsToProvenance}, supplying a lens resolver over its own ideas —
 * the canonical rows su-80be9's `recordRoutedIdea` ledger persists.
 */
import type {
  CorpusDigest,
  Idea,
  Proposal,
  ScoredIdea,
  ScoutLlmCall,
} from './types';
import type { CorpusEntry } from './critique-core';
import type { RoutingDecision } from './router';
import type { RoutedIdeaProvenance } from './outcome-feedback';

/* ────────────────────────────────────────────────────────────────────────
 * Budget + observability
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Per-cycle limits (D-010). su-80be9's P-008 budget layer constructs these from
 * its per-cycle cap; the cycle reports actual spend back in
 * {@link ScoutCycleResult.costUsd} so the next-cycle decision reads real cost.
 */
export interface ScoutCycleLimits {
  /** Cap the ideator roster size (passed to the ideate port). */
  maxIdeators?: number;
  /** Halt the cycle before the next LLM-spending step once cumulative spend exceeds this. */
  maxCostUsd?: number;
}

/** The LLM-spending steps (also the `ScoutCallRecord.step` tags). Routing spends no LLM. */
export type ScoutStep = 'ideate' | 'critique' | 'recombine';

/** The full cycle phases surfaced to the scheduler for timeout diagnostics. */
export type ScoutCyclePhase =
  | 'runner-bootstrap'
  | 'gateway-env'
  | 'llm-client-import'
  | 'resolve-archive'
  | 'build-cycle-deps'
  | 'run-cycle'
  | 'read-corpus'
  | 'ideate'
  | 'read-novelty-corpus'
  | 'critique'
  | 'recombine'
  | 'route';

/**
 * A recorded LLM invocation — the single place the no-human-prompt invariant
 * (D-010) and cost accounting read from. The cycle wraps the injected
 * {@link ScoutLlmCall} so every step's call lands here regardless of which peer
 * built the step.
 */
export interface ScoutCallRecord {
  /** Which step issued the call (provenance for the audit). */
  step: ScoutStep;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseFormat?: 'text' | 'json';
  costUsd: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Ports — one per Scout step, injected so the cycle owns no step's logic.
 * ──────────────────────────────────────────────────────────────────────── */

/** Options every LLM-touching port receives (the recorder-wrapped call). */
export interface ScoutStepCtx {
  llmCall: ScoutLlmCall;
}

export interface ScoutCyclePorts {
  /** P-003 (su-7a8ee): synthesize the "state of the Hive" digest (the grounded substrate). */
  readCorpus: () => Promise<CorpusDigest>;
  /** Search-first novelty corpus for the critics (prior plans/decisions/ideas/dropped-improvements). */
  readNoveltyCorpus: () => Promise<CorpusEntry[]>;
  /** P-004 (su-797a5): divergent generation → grounded ideas. `maxIdeators` clamps the roster (budget). */
  ideate: (digest: CorpusDigest, ctx: ScoutStepCtx & { maxIdeators?: number }) => Promise<Idea[]>;
  /** P-005 (su-d1170): adversarial novelty (search-first vs `corpus`) + feasibility critics → scored ideas. */
  critique: (ideas: Idea[], ctx: ScoutStepCtx & { corpus: CorpusEntry[] }) => Promise<ScoredIdea[]>;
  /** P-006 (su-d1170): debate + recombine survivors → proposals (the port filters verdict≠reject internally). */
  recombine: (scored: ScoredIdea[], ctx: ScoutStepCtx) => Promise<Proposal[]>;
  /** P-007 (su-ce4bd): route + dispatch each proposal once → per-proposal decisions (with `routedRef`). */
  route: (proposals: Proposal[]) => Promise<RoutingDecision[]>;
}

export interface ScoutCycleDeps extends ScoutCyclePorts {
  /** The injected LLM call (the gym:judge pattern; faked in tests). */
  llmCall: ScoutLlmCall;
  /** Optional per-cycle limits (D-010). */
  limits?: ScoutCycleLimits;
  /** Opaque cycle id for provenance/audit (su-80be9 stamps the ledger with it). */
  cycleId?: string;
  /** Best-effort phase reporter used by the scheduler's timeout/error diagnostics. */
  onPhase?: (phase: ScoutCyclePhase) => void;
}

/** Why the cycle stopped — `completed` is the full pass; the rest are early exits. */
export type ScoutCycleStop =
  | 'completed'
  | 'empty-digest'
  | 'no-ideas'
  | 'no-survivors'
  | 'no-proposals'
  | 'budget-exhausted';

/**
 * EI-303: a digest with zero meta-patterns in every lane is an empty substrate —
 * nothing exists to ground an idea in, so running the ideator roster over it is
 * pure spend (a fresh/quiet hive paid the full 4-lens roster just to exit
 * 'no-ideas'). `headline`/`generatedAt` don't count; only patterns ground ideas.
 */
export function digestIsEmpty(digest: CorpusDigest): boolean {
  return (
    digest.recurringFriction.length === 0 &&
    digest.timeTokenSinks.length === 0 &&
    digest.chronicDeferrals.length === 0 &&
    digest.capabilityGaps.length === 0
  );
}

/**
 * The full result of one Scout cycle. Carries every intermediate stage so the
 * P-009 invariants suite can assert at each boundary (grounded / forced-diversity
 * / non-duplicate / bettable) and P-014 can assert the full-cycle outcome.
 * Superset of contract invariant 7's `{ digest, ideas, proposals, routed }`.
 */
export interface ScoutCycleResult {
  cycleId?: string;
  digest: CorpusDigest;
  ideas: Idea[];
  /** Every idea after the critics (P-005). */
  scored: ScoredIdea[];
  /** keep + moonshot (reject dropped) — the proposals' source pool (D-005). */
  survivors: ScoredIdea[];
  proposals: Proposal[];
  /** Per-proposal routing decisions (ce4bd's canonical shape, with `routedRef`). */
  routed: RoutingDecision[];
  /** Per-idea lens provenance for P-013 (ce4bd's `decisionsToProvenance` over the cycle's ideas). */
  provenance: RoutedIdeaProvenance[];
  /** Every LLM call the cycle issued, in order (no-human-prompt + cost). */
  calls: ScoutCallRecord[];
  /** Total LLM spend this cycle (sum of `calls[].costUsd`). */
  costUsd: number;
  /** Why the cycle ended. */
  stop: ScoutCycleStop;
}

/* ────────────────────────────────────────────────────────────────────────
 * The composition
 * ──────────────────────────────────────────────────────────────────────── */

/** keep + moonshot survive (D-005); reject is pruned. */
export function selectSurvivors(scored: ScoredIdea[]): ScoredIdea[] {
  return scored.filter((s) => s.verdict !== 'reject');
}

/**
 * Expand the per-proposal routing decisions into per-idea lens provenance rows
 * (P-013 / D-009) — the canonical {@link RoutedIdeaProvenance} su-80be9's
 * `recordRoutedIdea` ledger persists. A {@link Proposal} fuses several ideas, so
 * EVERY contributing lens earns attribution for the routed artifact's outcome.
 * Decisions that never dispatched (`routedRef` unset) and source ideas whose lens
 * can't be resolved are skipped — there is nothing to attribute. The cycle owns
 * this expansion because it (not the router) holds the ideas → lens mapping.
 */
export function deriveProvenance(
  routed: readonly RoutingDecision[],
  ideas: readonly Idea[],
  cycleId?: string,
): RoutedIdeaProvenance[] {
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const out: RoutedIdeaProvenance[] = [];
  for (const d of routed) {
    if (!d.routedRef) continue;
    // Defensive: a decision missing sourceIdeaIds (an incomplete edge/mock path —
    // the real router always sets it, router.ts) yields no attribution rather than
    // crashing the whole cycle (matches the skip-non-attributable philosophy below).
    for (const ideaId of d.sourceIdeaIds ?? []) {
      const idea = ideaById.get(ideaId);
      if (!idea) continue;
      out.push({
        ideaId,
        lens: idea.lens,
        rail: d.rail,
        routedRef: d.routedRef,
        ...(cycleId ? { cycleId } : {}),
        ...(d.title ? { title: d.title } : {}),
        // The P-013 pattern-attribution key — without this the ledger's
        // addresses_pattern_refs column is NULL through the tick path.
        ...(idea.addressesPatternRefs.length > 0
          ? { addressesPatternRefs: [...idea.addressesPatternRefs] }
          : {}),
      });
    }
  }
  return out;
}

/**
 * Run one full Scout cycle. Prompt-free: the only input is `deps` (an injected
 * LLM call + step ports); there is NO human-input parameter and the cycle never
 * prompts a human — autonomy is structural (D-010). Returns the digest, the
 * ideas, the scored ideas + survivors, the proposals, the routing decisions, the
 * per-idea provenance, and the recorded spend.
 */
export async function runScoutCycle(deps: ScoutCycleDeps): Promise<ScoutCycleResult> {
  const calls: ScoutCallRecord[] = [];
  let currentStep: ScoutStep = 'ideate';
  const markPhase = (phase: ScoutCyclePhase): void => {
    deps.onPhase?.(phase);
  };

  // Wrap the injected call so every step's LLM use is recorded once (cost +
  // the no-human-prompt invariant), tagged with the step that issued it.
  const recordingLlm: ScoutLlmCall = async (opts) => {
    const result = await deps.llmCall(opts);
    calls.push({
      step: currentStep,
      system: opts.system,
      messages: opts.messages,
      responseFormat: opts.responseFormat,
      costUsd: result.costUsd,
    });
    return result;
  };

  const spent = () => calls.reduce((sum, c) => sum + c.costUsd, 0);
  const overBudget = () => {
    const cap = deps.limits?.maxCostUsd;
    return cap != null && spent() > cap;
  };

  const finish = (
    stop: ScoutCycleStop,
    partial: {
      digest: CorpusDigest;
      ideas?: Idea[];
      scored?: ScoredIdea[];
      survivors?: ScoredIdea[];
      proposals?: Proposal[];
      routed?: RoutingDecision[];
      provenance?: RoutedIdeaProvenance[];
    },
  ): ScoutCycleResult => ({
    cycleId: deps.cycleId,
    digest: partial.digest,
    ideas: partial.ideas ?? [],
    scored: partial.scored ?? [],
    survivors: partial.survivors ?? [],
    proposals: partial.proposals ?? [],
    routed: partial.routed ?? [],
    provenance: partial.provenance ?? [],
    calls,
    costUsd: spent(),
    stop,
  });

  // 1. Corpus synthesis (P-003) — the grounded substrate. No LLM cost attributed
  //    to the cycle (the digest reader owns its own budget upstream).
  markPhase('read-corpus');
  const digest = await deps.readCorpus();

  // EI-305: a zero cap means NO spend — halt before the first costed step.
  // (The between-steps gate below uses strict `spent > cap`, which a
  // 0-spent/0-cap start would pass.)
  if (deps.limits?.maxCostUsd != null && deps.limits.maxCostUsd <= 0) {
    return finish('budget-exhausted', { digest });
  }

  // EI-303: an empty (fresh/quiet-hive) digest grounds nothing — exit before
  // paying the ideator roster.
  if (digestIsEmpty(digest)) {
    return finish('empty-digest', { digest });
  }

  // 2. Divergent generation (P-004).
  markPhase('ideate');
  currentStep = 'ideate';
  const ideas = await deps.ideate(digest, {
    llmCall: recordingLlm,
    maxIdeators: deps.limits?.maxIdeators,
  });
  if (ideas.length === 0) return finish('no-ideas', { digest, ideas });
  if (overBudget()) return finish('budget-exhausted', { digest, ideas });

  // 3. Adversarial critics (P-005) — search-first novelty vs the corpus + feasibility.
  markPhase('read-novelty-corpus');
  currentStep = 'critique';
  const corpus = await deps.readNoveltyCorpus();
  markPhase('critique');
  const scored = await deps.critique(ideas, { llmCall: recordingLlm, corpus });
  const survivors = selectSurvivors(scored);
  if (survivors.length === 0) return finish('no-survivors', { digest, ideas, scored, survivors });
  if (overBudget()) return finish('budget-exhausted', { digest, ideas, scored, survivors });

  // 4. Debate + recombine survivors → proposals (P-006). The port re-filters
  //    verdict≠reject internally (su-d1170's recombineProposals), so passing all
  //    `scored` is safe + matches its published wiring.
  markPhase('recombine');
  currentStep = 'recombine';
  const proposals = await deps.recombine(scored, { llmCall: recordingLlm });
  if (proposals.length === 0) {
    return finish('no-proposals', { digest, ideas, scored, survivors, proposals });
  }

  // 5. Route + dispatch each proposal once (P-007); expand to per-idea lens
  //    provenance (P-013) over our ideas (the cycle holds the idea→lens map).
  markPhase('route');
  const routed = await deps.route(proposals);
  const provenance = deriveProvenance(routed, ideas, deps.cycleId);

  return finish('completed', {
    digest,
    ideas,
    scored,
    survivors,
    proposals,
    routed,
    provenance,
  });
}
