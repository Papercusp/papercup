/**
 * Scout loop — the end-to-end cycle composition (hive-creative-ideation-2026-06-08, P-006…P-008 seam).
 *
 * `runScoutCycle` is the single entrypoint that wires the five Scout steps into
 * one autonomous, prompt-free pass:
 *
 *   corpus synthesis (P-003) → divergent generation (P-004) → adversarial
 *   critics (P-005) → debate + recombine (P-006) → routing (P-007).
 *
 * It is **pure orchestration over injected ports** — it imports only the shared
 * contract from `./types` and never the concrete step modules, so:
 *  - it unit-tests with fakes + `./test-support` (no network, $0, deterministic);
 *  - it couples to no peer's file (each step is a port, wired in `./cycle-deps`
 *    once the implementations land);
 *  - it is the entrypoint the verification lane drives (b6c3f P-014 / e8630
 *    P-009, contract invariant 7) and the cadence/budget layer wraps (su-80be9
 *    P-008: `tick → shouldRunScoutCycle → budget gate → runScoutCycle → routed`).
 *
 * Design rules carried from the plan's ratified decisions:
 *  - **Injected LLM (D-004 / gym:judge pattern):** every step takes the same
 *    {@link ScoutLlmCall}; the cycle wraps it in a recorder so spend + the
 *    "no human-authored prompt entered the loop" invariant (D-010) read from
 *    one place ({@link ScoutCycleResult.calls}).
 *  - **Survivors only (D-005):** `reject` critiques are dropped before
 *    recombine; `keep` + `moonshot` proceed (the moonshot bucket survives so
 *    the leaps aren't over-pruned).
 *  - **Per-cycle budget (D-010):** an optional `limits.maxCostUsd` halts the
 *    cycle before the next LLM-spending step rather than running unbounded —
 *    a belt to su-80be9's pre-fire budget-gate suspenders.
 */
import type {
  CorpusDigest,
  CreativeLens,
  Critique,
  Idea,
  Proposal,
  ScoutLlmCall,
} from './types';

/* ────────────────────────────────────────────────────────────────────────
 * Routing contract (P-007, su-ce4bd) — the shape the cycle consumes + returns.
 * su-ce4bd's `./router` aligns its decision output to this; the side-effecting
 * dispatch (plans:new / gym / improvements:capture) is an injected port INSIDE
 * the route step, so the cycle stays write-free + testable.
 * ──────────────────────────────────────────────────────────────────────── */

/** Which downstream rail a proposal routes to (D-007). */
export type ScoutRail = 'plan' | 'gym' | 'improvement';

/**
 * One routing decision for one proposal (P-007 output). `routedRef` is the
 * change-feed ref of the artifact the dispatch created — `"plan:<slug>"` /
 * `"gym:<proposal-id>"` / `"wi:<issue-id>"` — the exact shape su-80be9's
 * P-013 ledger keys on.
 */
export interface RouteDecision {
  /** The {@link Proposal.id} this decision is for. */
  proposalId: string;
  /** The rail the proposal was dispatched to. */
  rail: ScoutRail;
  /** Change-feed ref of the created artifact ("plan:<slug>" | "gym:<id>" | "wi:<id>"). */
  routedRef: string;
  /** One-line why-this-rail (for the audit / digest). */
  reason: string;
}

/**
 * Per-idea provenance derived by the cycle for P-013 outcome feedback (D-009):
 * a routed proposal is expanded to one row per source idea, carrying the
 * **creative lens** that produced it — the attribution key that lets P-013
 * weight winning lenses. su-80be9's `recordRoutedIdea` ledger consumes this
 * (structurally a subset of their `RoutedIdeaProvenance`; they stamp
 * `cycleId` / `routedAt` at persist time).
 */
export interface ScoutRoutedIdea {
  /** The {@link Idea.id} that contributed to the routed proposal. */
  ideaId: string;
  /** The lens that produced the idea — the P-013 attribution key. */
  lens: CreativeLens;
  /** Rail the proposal routed to. */
  rail: ScoutRail;
  /** Change-feed ref of the created artifact. */
  routedRef: string;
  /** Convenience: the idea's title (for the ledger / report). */
  title?: string;
}

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

/** The cycle's ordered steps (also the `ScoutCallRecord.step` tags). */
export type ScoutStep = 'ideate' | 'critique' | 'recombine' | 'route';

/* ────────────────────────────────────────────────────────────────────────
 * Ports — one per Scout step, injected so the cycle owns no step's logic.
 * ──────────────────────────────────────────────────────────────────────── */

/** Options every LLM-touching port receives (the recorder-wrapped call). */
export interface ScoutStepCtx {
  llmCall: ScoutLlmCall;
}

export interface ScoutCyclePorts {
  /** P-003 (su-7a8ee): synthesize the "state of the Hive" digest. */
  readCorpus: () => Promise<CorpusDigest>;
  /** P-004 (su-797a5): divergent generation → grounded ideas. `maxIdeators` clamps the roster (budget). */
  ideate: (digest: CorpusDigest, ctx: ScoutStepCtx & { maxIdeators?: number }) => Promise<Idea[]>;
  /** P-005 (su-d1170): adversarial novelty + feasibility critics → bucketed critiques. */
  critique: (ideas: Idea[], ctx: ScoutStepCtx) => Promise<Critique[]>;
  /** P-006 (su-d1170): debate + recombine SURVIVORS (keep+moonshot) → proposals. */
  recombine: (survivors: Critique[], ctx: ScoutStepCtx) => Promise<Proposal[]>;
  /** P-007 (su-ce4bd): route + dispatch each proposal → typed decisions (dispatch is internal/injected). */
  route: (proposals: Proposal[], ctx: ScoutStepCtx) => Promise<RouteDecision[]>;
}

export interface ScoutCycleDeps extends ScoutCyclePorts {
  /** The injected LLM call (the gym:judge pattern; faked in tests). */
  llmCall: ScoutLlmCall;
  /** Optional per-cycle limits (D-010). */
  limits?: ScoutCycleLimits;
  /** Opaque cycle id for provenance/audit (su-80be9 stamps the ledger with it). */
  cycleId?: string;
}

/** Why the cycle stopped — `completed` is the full pass; the rest are early exits. */
export type ScoutCycleStop =
  | 'completed'
  | 'no-ideas'
  | 'no-survivors'
  | 'no-proposals'
  | 'budget-exhausted';

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
  critiques: Critique[];
  /** keep + moonshot (reject dropped) — the proposals' source pool. */
  survivors: Critique[];
  proposals: Proposal[];
  routed: RouteDecision[];
  /** Per-idea lens provenance for P-013 (derived from routed × proposals × ideas). */
  provenance: ScoutRoutedIdea[];
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

/** keep + moonshot survive (D-005); reject is pruned before recombine. */
export function selectSurvivors(critiques: Critique[]): Critique[] {
  return critiques.filter((c) => c.verdict !== 'reject');
}

/**
 * Expand routed proposals to per-idea lens provenance (D-009 attribution). One
 * row per (decision × source idea); the idea's lens is looked up from the
 * cycle's own `ideas`. Ideas not found (defensive) are skipped.
 */
export function deriveProvenance(
  routed: RouteDecision[],
  proposals: Proposal[],
  ideas: Idea[],
): ScoutRoutedIdea[] {
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  const out: ScoutRoutedIdea[] = [];
  for (const decision of routed) {
    const proposal = proposalById.get(decision.proposalId);
    if (!proposal) continue;
    for (const ideaId of proposal.sourceIdeaIds) {
      const idea = ideaById.get(ideaId);
      if (!idea) continue;
      out.push({
        ideaId,
        lens: idea.lens,
        rail: decision.rail,
        routedRef: decision.routedRef,
        title: idea.title,
      });
    }
  }
  return out;
}

/**
 * Run one full Scout cycle. Prompt-free: the only input is `deps` (an injected
 * LLM call + step ports); there is NO human-input parameter and the cycle never
 * prompts a human — autonomy is structural (D-010). Returns the digest, the
 * ideas, the critiques + survivors, the proposals, the routing decisions, the
 * per-idea provenance, and the recorded spend.
 */
export async function runScoutCycle(deps: ScoutCycleDeps): Promise<ScoutCycleResult> {
  const calls: ScoutCallRecord[] = [];
  let currentStep: ScoutStep = 'ideate';

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
      critiques?: Critique[];
      survivors?: Critique[];
      proposals?: Proposal[];
      routed?: RouteDecision[];
      provenance?: ScoutRoutedIdea[];
    },
  ): ScoutCycleResult => ({
    cycleId: deps.cycleId,
    digest: partial.digest,
    ideas: partial.ideas ?? [],
    critiques: partial.critiques ?? [],
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
  const digest = await deps.readCorpus();

  // 2. Divergent generation (P-004).
  currentStep = 'ideate';
  const ideas = await deps.ideate(digest, {
    llmCall: recordingLlm,
    maxIdeators: deps.limits?.maxIdeators,
  });
  if (ideas.length === 0) return finish('no-ideas', { digest, ideas });
  if (overBudget()) return finish('budget-exhausted', { digest, ideas });

  // 3. Adversarial critics (P-005) → survivors (D-005: drop reject; keep+moonshot proceed).
  currentStep = 'critique';
  const critiques = await deps.critique(ideas, { llmCall: recordingLlm });
  const survivors = selectSurvivors(critiques);
  if (survivors.length === 0) return finish('no-survivors', { digest, ideas, critiques, survivors });
  if (overBudget()) return finish('budget-exhausted', { digest, ideas, critiques, survivors });

  // 4. Debate + recombine survivors → proposals (P-006).
  currentStep = 'recombine';
  const proposals = await deps.recombine(survivors, { llmCall: recordingLlm });
  if (proposals.length === 0) {
    return finish('no-proposals', { digest, ideas, critiques, survivors, proposals });
  }

  // 5. Route + dispatch each proposal (P-007); derive per-idea provenance (P-013).
  currentStep = 'route';
  const routed = await deps.route(proposals, { llmCall: recordingLlm });
  const provenance = deriveProvenance(routed, proposals, ideas);

  return finish('completed', {
    digest,
    ideas,
    critiques,
    survivors,
    proposals,
    routed,
    provenance,
  });
}
