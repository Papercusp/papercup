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
 * One meta-pattern category from the "state of the Hive" corpus digest (P-003).
 * Mirrors the four lanes curation/state-of-hive surfaces.
 */
export type MetaPatternCategory =
  | 'recurring-friction'
  | 'time-token-sink'
  | 'chronic-deferral'
  | 'capability-gap';

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
 * so the real meridian `llmCall` (lib/llm-testing/llm-client) satisfies both,
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
  }): Promise<{
    text: string;
    json?: unknown;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}
