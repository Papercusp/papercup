/**
 * Scout loop — shared cross-step types (hive-creative-ideation-2026-06-08).
 *
 * The Scout loop is the Hive's generative-exploration engine — the "missing
 * third mode" of self-improvement (D-003): the deliberate creative *leap*
 * (analogy / reframing / recombination / first-principles) that the reactive
 * idea queue and the exploitative gym structurally cannot produce. Its cycle:
 *
 *   corpus synthesis (P-003) → divergent generation (P-004) → adversarial
 *   critics (P-005) → debate + recombine (P-006) → routing (P-007) →
 *   Queen-triage cadence (P-008).
 *
 * This module SEEDS the contract the steps hand each other. Per the lane split
 * (su-797a5 owns P-004), this file is seeded here and EXTENDED by P-005/P-006
 * (su-d1170: `Critique`, `Proposal`) and consumed by P-007 (su-80be9) +
 * the verification lane (su-b6c3f).
 *
 * Two design rules carried from the plan's ratified decisions:
 *  - **Forced diversity (D-004):** divergence is structural, not a single
 *    "be creative" prompt — each ideator runs a *distinct* {@link CreativeLens}.
 *  - **Injected LLM (gym:judge pattern):** every Scout step takes a
 *    {@link ScoutLlmCall} so build → call → parse is unit-tested with a fake
 *    call (no network), exactly like `runGymJudge(args, { llmCall })`.
 */

// P-005/P-006 (su-d1170) extend this contract below; the pure critic spine lives
// in ./critique-core (Idea-shape-agnostic + reusable) and supplies these types.
import type { CorpusMatch, CritiqueVerdict } from './critique-core';

/**
 * The forced-diversity lens taxonomy (D-004). Each lens is a structurally
 * different generative stance so N ideators can't collapse to the median idea:
 *  - `analogical`        — map a distant domain's solution onto a Hive bottleneck.
 *  - `first-principles`  — derive the ideal mechanism from the goal, backward.
 *  - `reframing`         — find the real constraint nobody named (problem-finding).
 *  - `constraint-removal`— negate a load-bearing assumption; build what it blocked.
 */
export type CreativeLens =
  | 'analogical'
  | 'first-principles'
  | 'reframing'
  | 'constraint-removal';

/** All lenses, in a stable order (the default ideator roster). */
export const CREATIVE_LENSES: readonly CreativeLens[] = [
  'analogical',
  'first-principles',
  'reframing',
  'constraint-removal',
] as const;

/**
 * One meta-pattern category from the "state of the Hive" corpus digest. The four
 * friction lanes (P-003) plus `rubric-rating` — structured rubric measurements
 * grouped by rubric/source-hive (rubric-driven-observations-2026-06-20 P-006), so
 * the ideators leap from MEASUREMENTS, not just free-text clusters.
 */
export type MetaPatternCategory =
  | 'recurring-friction'
  | 'time-token-sink'
  | 'chronic-deferral'
  | 'capability-gap'
  | 'rubric-rating';

/**
 * A grounded meta-pattern: a cross-corpus regularity (not a single capture),
 * carrying a `ref` back to the original (the rationale:feed / change-feed
 * pattern). The `ref` is also the attribution key P-013 uses to trace an
 * outcome back to the idea — and the lens — that produced it.
 *
 * `category` is optional so the digest's per-lane arrays (which need not repeat
 * the category on each row) are directly assignable; {@link flattenDigest}
 * stamps it when collapsing the digest into one list.
 */
export interface MetaPattern {
  /** Which corpus lane this came from (stamped by flattenDigest if absent). */
  category?: MetaPatternCategory;
  /** One-line meta-pattern (what recurs / where time goes / what's deferred / what's missing). */
  summary: string;
  /** Optional expansion or evidence. */
  detail?: string;
  /** Drill-back reference to the original record (e.g. "wi:F-012", "plan:slug"). */
  ref: string;
  /** Optional salience 0..1 (the digest's own ranking), to prime the ideators. */
  weight?: number;
}

/**
 * The "state of the Hive" digest (P-003 output) — the grounded substrate the
 * ideators read so their leaps are anchored to real Hive history, not invented.
 *
 * STRUCTURAL CONTRACT: this is the shape P-004 consumes. The production digest
 * is `StateOfHiveDigest` from `curation/state-of-hive` (su-7a8ee, P-003); when
 * it lands, the loop seam adapts it to this shape (the four ref-carrying
 * categories are the agreed contract). Kept here so P-004 is buildable +
 * testable independently of P-003's in-flight implementation.
 */
export interface CorpusDigest {
  recurringFriction: MetaPattern[];
  timeTokenSinks: MetaPattern[];
  chronicDeferrals: MetaPattern[];
  capabilityGaps: MetaPattern[];
  /**
   * Structured rubric-rating measurements grouped by rubric / source-hive
   * (rubric-driven-observations-2026-06-20 P-006). OPTIONAL so pre-rubric digests
   * and the 4-lane test fixtures stay valid CorpusDigests; {@link flattenDigest}
   * folds it in when present so the ideators ideate on MEASUREMENTS, not just
   * free-text clusters. Each pattern is one (rubric, source-hive, criterion)
   * standing; its `ref` (`rubric:<id>#<criterion>@<hive>`) is the drill-back.
   */
  rubricRatings?: MetaPattern[];
  /** Optional one-line "state of the Hive" headline. */
  headline?: string;
  /** ISO timestamp the digest was synthesized. */
  generatedAt?: string;
}

/**
 * A single divergent idea (P-004 output → P-005 critic input). `id` and `lens`
 * are assigned by the ideator code, never trusted from the model. The idea is
 * grounded by `addressesPatternRefs` (the digest patterns it targets) — the
 * hook for D-006 (bettable, not merely clever) and P-013 (outcome → lens).
 */
export interface Idea {
  id: string;
  lens: CreativeLens;
  /** One-line idea title. */
  title: string;
  /** The idea explained — what it is and why it could matter. */
  body: string;
  /** How it would work (the concrete mechanism — the anti-hand-wave field). */
  mechanism: string;
  /** For the analogical lens: the distant domain that primed it (e.g. 'immune-systems'). */
  seedDomain?: string;
  /**
   * Refs (into the corpus digest's MetaPattern.ref) the idea targets. Grounding
   * + attribution: empty means ungrounded (the novelty/feasibility critics weigh
   * this). Only refs that exist in the digest are kept.
   */
  addressesPatternRefs: string[];
}

/**
 * The injected LLM call — structurally identical to the gym's `JudgeLlmCall`
 * so the real `llmCall` (lib/llm-testing/llm-client) satisfies both,
 * and so every Scout step (ideators, critics, recombine) is unit-tested with a
 * fake call (no network). Defined here, not imported from the gym, so the Scout
 * module stays decoupled from the (Phase-2, heavily-edited) gym package.
 */
export interface ScoutLlmCall {
  (opts: {
    model: string;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    responseFormat?: 'text' | 'json';
    thinkingBudgetTokens?: number;
    maxTokens?: number;
    /** Abort the host transport when the Scout cycle wall-clock timeout fires. */
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    json?: unknown;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// ───────────────────── P-005 / P-006 (su-d1170) — critics → proposals ─────────────────────
// Appended onto su-797a5's seed per the lane split. The pure critic spine + its
// CorpusMatch / CritiqueVerdict types live in ./critique-core (network-free,
// Idea-shape-agnostic); these are the typed contract the steps hand each other:
// ideators (P-004) → ScoredIdea (P-005) → Proposal (P-006) → routing (P-007).

/**
 * One idea after the adversarial critics (P-005 output → P-006 input). `novelty`
 * blends the deterministic SEARCH-FIRST signal (corpusNovelty — a ceiling, so an
 * already-tried idea stays caught) with the LLM novelty-skeptic; `feasibility` is
 * the LLM feasibility critic. `verdict` is the bucket it landed in (D-005), and
 * `noveltyMatches` is the search-first evidence so a reviewer sees *why*.
 */
export interface ScoredIdea {
  idea: Idea;
  /** 0..1 — how unlike the corpus (1 = nothing like it). */
  novelty: number;
  /** 0..1 — how groundable in this architecture (cost vs upside). */
  feasibility: number;
  /** The closest priors the search-first pass surfaced (evidence for the verdict). */
  noveltyMatches: CorpusMatch[];
  /** Which bucket: 'keep' (build), 'moonshot' (preserved leap), 'reject'. */
  verdict: CritiqueVerdict;
  /** One-line rationale (verdict reason + critic notes), for the digest / audit. */
  notes: string;
}

/**
 * The cheap, falsifiable first experiment every Proposal must carry (D-006) —
 * STRUCTURED so "bettable" is machine-checkable (not free prose): a hypothesis,
 * the method to test it, and the concrete signal that would FALSIFY it. The
 * natural hand-off to the gym.
 */
export interface ScoutExperiment {
  /** What we believe will be true if the idea has merit. */
  hypothesis: string;
  /** The cheap first test (what to run / build / measure). */
  method: string;
  /** The observable that would prove the hypothesis WRONG (the falsifier). */
  falsifiableSignal: string;
}

/**
 * A recombined proposal (P-006 output → P-007 routing input). Surviving critiques
 * are debated + *merged* (A's mechanism + B's framing — the best ideas are usually
 * a fusion) into this shape. `cheapExperiment` is REQUIRED (D-006): the
 * anti-bullshit gate that keeps a proposal bettable, not merely clever, and the
 * natural hand-off to the gym. `routeHint` is P-007's hint (the router may override).
 */
export interface Proposal {
  id: string;
  /** The problem framing the proposal addresses. */
  framing: string;
  /** The novel mechanism — how it would work. */
  mechanism: string;
  /** Why it's new vs everything the Hive has already considered (search-first grounded). */
  whyNew: string;
  /** The bet — the upside if it pans out. */
  bet: string;
  /** REQUIRED (D-006): the cheap falsifiable first experiment, STRUCTURED + machine-checkable.
   *  All three sub-fields must be non-empty (see validateProposal). */
  cheapExperiment: ScoutExperiment;
  /** The critiqued ideas that recombined into this proposal (≥1). */
  sourceIdeaIds: string[];
  /**
   * P-007 routing hint (reconciliation P-005 — the two eval subjects are rails here):
   *   broad-scope → 'plan'; concrete → 'improvement';
   *   testable COMPONENT idea → 'gym' (the eval-battery HarnessSubject);
   *   testable WHOLE-SYSTEM idea → 'instance' (the eval-battery InstanceSubject — a genome
   *   delta over the interacting wholes; the missing rail this plan adds).
   */
  routeHint?: 'plan' | 'gym' | 'improvement' | 'instance';
  /** Corpus pattern refs carried from the source ideas — grounding (⊆ digest refs) + P-013 lens attribution. */
  addressesPatternRefs: string[];
}
