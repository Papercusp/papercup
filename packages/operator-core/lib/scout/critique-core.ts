/**
 * Pure critique core for the Scout loop (hive-creative-ideation-2026-06-08,
 * P-005 / D-005). The deterministic, network-free spine of the adversarial
 * novelty + feasibility critics:
 *
 *   - `corpusNovelty` — the SEARCH-FIRST novelty signal: how unlike everything
 *     the Hive has already considered an idea is, measured against the corpus
 *     (prior plans, decisions, ideas, dropped/shipped improvements) using the
 *     same stable-signature + token-set Jaccard matcher the self-improvement
 *     dedup uses (lib/harness/improvements/digest). The plan's "if it's the
 *     obvious idea or already-dropped, send it back to go weirder" reduces to:
 *     a high-similarity match — especially to an already-DECIDED prior
 *     (dropped/shipped/resolved) — ⇒ low novelty + an `alreadyTried` flag.
 *   - `bucketByCritique` — the two-critics-in-tension partition plus the
 *     MOONSHOT bucket (D-005): keep high-novelty/high-feasibility, reject the
 *     obvious, and PRESERVE a small *capped* bucket of high-novelty/low-feasibility
 *     leaps so the critics don't strangle them.
 *
 * Pure + deterministic — no LLM, no IO. The LLM feasibility/novelty judgment is
 * layered on top in `critics.ts` (injected `llmCall`, the gym:judge pattern);
 * this module is the part the tests pin hard. Types here are intentionally
 * Idea-shape-agnostic (plain {id,text}) so they don't couple to P-004's Idea
 * and stay reusable.
 */
import { dedupSignature, titleSimilarity } from '../harness/improvements/digest';

export type CorpusKind = 'plan' | 'decision' | 'idea' | 'improvement';

/** A prior the Hive has already considered — what novelty is measured against. */
export interface CorpusEntry {
  /** Drill-in reference: a plan slug, D-id, idea/EI-id. */
  ref: string;
  kind: CorpusKind;
  /** The comparable text (title, optionally + a short body) of the prior. */
  text: string;
  /** Lifecycle of the prior — a 'dropped'/'shipped'/'resolved' near-match is the
   *  strongest "already tried" signal. Optional. */
  state?: string;
}

export interface CorpusMatch {
  ref: string;
  kind: CorpusKind;
  /** Blended similarity [0,1]: lexical token-set Jaccard, or — when a semantic
   *  (cosine) similarity was resolved for this prior and beat lexical — that. */
  similarity: number;
  /** True when the P-017 embedding leg's cosine BEAT lexical for this prior — the
   *  match was caught semantically (a re-worded re-encounter the token matcher missed). */
  semantic?: boolean;
  state?: string;
}

export interface CorpusNovelty {
  /** 1 = nothing in the corpus is like it; 0 = an exact prior exists. */
  novelty: number;
  /** Closest priors above the match floor, strongest first (search-first evidence). */
  matches: CorpusMatch[];
  /** True when the strongest above-floor match is an already-decided prior
   *  (dropped/shipped/resolved/closed/done) — "already tried", the adversarial
   *  reject signal. */
  alreadyTried: boolean;
}

export interface CorpusNoveltyOptions {
  /** Min similarity to surface a match (default 0.5). */
  matchFloor?: number;
  /** Max matches to return (default 5). */
  maxMatches?: number;
  /** States that count as "already tried/decided" (default dropped/shipped/resolved/closed/done). */
  decidedStates?: readonly string[];
  /** Extra novelty penalty when the closest above-floor match is an already-decided
   *  prior — we've literally tried/shipped/dropped this before (default 0.15). */
  decidedPenalty?: number;
  /**
   * P-017 hybrid embedding leg (D-016): a per-corpus-ref cosine similarity [0,1] in
   * the active embedding space, resolved JOIN-WISE by the caller (semantic-novelty-leg).
   * When present for an entry, its score is blended as `max(lexical, cosine)` — so a
   * re-worded re-encounter the lexical matcher misses is still caught by its semantic
   * neighbour. Keeps this core PURE (the impure vector IO lives in the caller); absent
   * the map, scoring is byte-identical to the lexical-only original.
   */
  semanticSimByRef?: ReadonlyMap<string, number>;
}

const DEFAULT_DECIDED_STATES = ['dropped', 'shipped', 'resolved', 'closed', 'done'] as const;

/**
 * Default search-first novelty knobs (P-009 scout-config seam,
 * domain-generic-hive-architecture-2026-06-18). The SINGLE source of truth for these
 * values: `corpusNovelty`'s `??` fallbacks and the blueprint `scout.novelty` config
 * default (`scout/config.ts`) both reference this, so they cannot drift. Per-blueprint
 * tuning flows in via the resolved ScoutConfig; absent a blueprint override, behavior is
 * byte-identical to the previous inline constants.
 */
export const DEFAULT_CORPUS_NOVELTY_OPTIONS: Required<CorpusNoveltyOptions> = {
  matchFloor: 0.5,
  maxMatches: 5,
  decidedStates: DEFAULT_DECIDED_STATES,
  decidedPenalty: 0.15,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Search-first novelty of `text` against the corpus. Deterministic: novelty is
 * `1 - (closest similarity)`, with an extra penalty when the closest above-floor
 * prior was already decided. Reuses the self-improvement dedup matcher so a
 * re-worded re-encounter still collides (token-order-insensitive signature).
 */
export function corpusNovelty(
  text: string,
  corpus: readonly CorpusEntry[],
  opts: CorpusNoveltyOptions = {},
): CorpusNovelty {
  const matchFloor = opts.matchFloor ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.matchFloor;
  const maxMatches = opts.maxMatches ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.maxMatches;
  const decidedStates = opts.decidedStates ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.decidedStates;
  const decidedPenalty = opts.decidedPenalty ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.decidedPenalty;
  const semanticSimByRef = opts.semanticSimByRef;

  // No comparable tokens (e.g. empty / punctuation-only) — maximally novel, but
  // we surface nothing (there is nothing to compare).
  if (!dedupSignature(text)) {
    return { novelty: 1, matches: [], alreadyTried: false };
  }

  const scored: CorpusMatch[] = [];
  for (const e of corpus) {
    const lexical = round2(titleSimilarity(text, e.text));
    // P-017 hybrid leg: blend the caller-resolved cosine as max(lexical, cosine).
    // Computed BEFORE the <=0 skip on purpose — a re-worded re-encounter with zero
    // lexical overlap (the 2026-07-10 dupe-storm class) is only caught this way.
    const cos = semanticSimByRef?.get(e.ref);
    const useSemantic = typeof cos === 'number' && cos > lexical;
    const similarity = useSemantic ? round2(cos as number) : lexical;
    if (similarity <= 0) continue;
    scored.push({
      ref: e.ref,
      kind: e.kind,
      similarity,
      ...(useSemantic ? { semantic: true } : {}),
      ...(e.state ? { state: e.state } : {}),
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);

  const top = scored[0];
  const maxSim = top ? top.similarity : 0;
  const alreadyTried =
    !!top && top.similarity >= matchFloor && !!top.state && decidedStates.includes(top.state);

  let novelty = 1 - maxSim;
  if (alreadyTried) novelty -= decidedPenalty;
  novelty = round2(Math.max(0, Math.min(1, novelty)));

  const matches = scored.filter((m) => m.similarity >= matchFloor).slice(0, maxMatches);
  return { novelty, matches, alreadyTried };
}

export type CritiqueVerdict = 'keep' | 'moonshot' | 'reject';

/** The minimal per-idea scores the bucketing reasons over. */
export interface CritiqueScores {
  id: string;
  /** 0..1 — how unlike the corpus (search-first + LLM-blended). */
  novelty: number;
  /** 0..1 — how groundable in this architecture, cost vs upside. */
  feasibility: number;
}

export interface BucketOptions {
  /** Below this novelty an idea is "the obvious idea / already tried" → reject (default 0.34). */
  noveltyFloor?: number;
  /** At/above this feasibility an idea is buildable now (default 0.5). */
  feasibilityFloor?: number;
  /** A leap must be at least this novel to earn a moonshot slot (default 0.66). */
  moonshotNoveltyFloor?: number;
  /** Max ideas kept in the moonshot bucket so leaps survive but don't flood (D-005, default 2). */
  maxMoonshots?: number;
}

/**
 * Default verdict-bucket knobs (P-009 scout-config seam) — single source of truth for
 * `verdictFor`/`bucketByCritique`'s `??` fallbacks AND the blueprint `scout.buckets`
 * config default (`scout/config.ts`).
 */
export const DEFAULT_BUCKET_OPTIONS: Required<BucketOptions> = {
  noveltyFloor: 0.34,
  feasibilityFloor: 0.5,
  moonshotNoveltyFloor: 0.66,
  maxMoonshots: 2,
};

export interface CritiqueBuckets<T extends CritiqueScores> {
  /** Novel AND feasible — proceed to debate/recombine. */
  kept: T[];
  /** High-novelty / low-feasibility leaps preserved on purpose (capped). */
  moonshot: T[];
  /** The obvious / already-tried, and the not-novel-enough leaps. */
  rejected: T[];
  /** Per-id verdict + one-line reason, for the digest/audit. */
  verdicts: Record<string, { verdict: CritiqueVerdict; reason: string }>;
}

/**
 * The two-critics-in-tension verdict for one idea (pre-cap). Novelty is the
 * gate; feasibility decides keep-vs-moonshot among the novel.
 */
export function verdictFor(
  s: CritiqueScores,
  opts: BucketOptions = {},
): { verdict: CritiqueVerdict; reason: string } {
  const noveltyFloor = opts.noveltyFloor ?? DEFAULT_BUCKET_OPTIONS.noveltyFloor;
  const feasibilityFloor = opts.feasibilityFloor ?? DEFAULT_BUCKET_OPTIONS.feasibilityFloor;
  const moonshotNoveltyFloor = opts.moonshotNoveltyFloor ?? DEFAULT_BUCKET_OPTIONS.moonshotNoveltyFloor;

  if (s.novelty < noveltyFloor) {
    return {
      verdict: 'reject',
      reason: `novelty ${s.novelty} < ${noveltyFloor} — too close to an existing/already-tried idea`,
    };
  }
  if (s.feasibility >= feasibilityFloor) {
    return { verdict: 'keep', reason: `novel (${s.novelty}) + feasible (${s.feasibility})` };
  }
  // Novel but not currently feasible → a moonshot IF it's a genuine leap.
  if (s.novelty >= moonshotNoveltyFloor) {
    return {
      verdict: 'moonshot',
      reason: `high novelty (${s.novelty}) / low feasibility (${s.feasibility}) — preserved leap`,
    };
  }
  return {
    verdict: 'reject',
    reason: `mid novelty (${s.novelty}) but low feasibility (${s.feasibility}) — not a strong enough leap`,
  };
}

/**
 * Partition scored ideas into keep / moonshot / reject (D-005). The moonshot
 * bucket is capped (`maxMoonshots`) — the most-novel leaps win the slots, the
 * rest are demoted to rejected — so leaps survive without flooding the pipeline.
 */
export function bucketByCritique<T extends CritiqueScores>(
  items: readonly T[],
  opts: BucketOptions = {},
): CritiqueBuckets<T> {
  const maxMoonshots = opts.maxMoonshots ?? DEFAULT_BUCKET_OPTIONS.maxMoonshots;
  const kept: T[] = [];
  const moonshotCandidates: T[] = [];
  const rejected: T[] = [];
  const verdicts: Record<string, { verdict: CritiqueVerdict; reason: string }> = {};

  for (const it of items) {
    const v = verdictFor(it, opts);
    verdicts[it.id] = v;
    if (v.verdict === 'keep') kept.push(it);
    else if (v.verdict === 'moonshot') moonshotCandidates.push(it);
    else rejected.push(it);
  }

  // Cap the moonshot bucket: keep the most-novel leaps, demote the rest.
  moonshotCandidates.sort((a, b) => b.novelty - a.novelty);
  const moonshot = moonshotCandidates.slice(0, maxMoonshots);
  for (const demoted of moonshotCandidates.slice(maxMoonshots)) {
    verdicts[demoted.id] = {
      verdict: 'reject',
      reason: `moonshot bucket full (max ${maxMoonshots}) — demoted lowest-novelty leap`,
    };
    rejected.push(demoted);
  }

  return { kept, moonshot, rejected, verdicts };
}
