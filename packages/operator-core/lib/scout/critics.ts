/**
 * P-005 — the adversarial novelty + feasibility critics (hive-creative-ideation
 * D-005). Layers LLM judgment on top of the deterministic ./critique-core spine:
 *
 *   1. SEARCH-FIRST novelty vs the corpus (deterministic — corpusNovelty, which
 *      reuses the shipped dedupSignature + titleSimilarity matcher, no second
 *      dedup invented). This is a CEILING.
 *   2. an LLM novelty-skeptic that can only LOWER novelty (spot a conceptual dup
 *      the dedup missed) — it can NEVER raise an already-present idea to novel,
 *      so "already tried" stays caught (b6c3f invariant 3).
 *   3. an LLM feasibility critic (groundable in THIS architecture? cost vs upside).
 *   4. bucket into keep / moonshot / reject, preserving a capped moonshot bucket.
 *
 * The two critics pull against each other (novelty wants weird, feasibility wants
 * buildable) — creativity lives at that boundary (D-005). The `ScoutLlmCall` is
 * injected (the gym:judge pattern) so this unit-tests with a fake call (no
 * network). The cycle (su-cb4b9) calls `critiqueIdeas`; P-009 (su-e8630) asserts
 * over its output.
 */
import type { Idea, ScoutLlmCall, ScoredIdea } from './types';
import {
  bucketByCritique,
  verdictFor,
  type CorpusEntry,
  type CorpusNoveltyOptions,
  type BucketOptions,
} from './critique-core';
import { corpusNoveltyHybrid } from './semantic-novelty-leg';
import { parseLlmJson } from './llm-json';
import { DEFAULT_SCOUT_CRITIC_MODEL } from './models';

/**
 * Default critic model — cheap on purpose (the plan: "a handful of ideators +
 * critics per cycle"). Overridable via CriticContext.model; the search-first
 * novelty (the load-bearing dedup) is free + deterministic regardless.
 */
export const DEFAULT_CRITIC_MODEL = DEFAULT_SCOUT_CRITIC_MODEL;

/**
 * The default critic MISSION framing (P-010 scout prompt-overlay seam,
 * domain-generic-hive-architecture-2026-06-18 D-004) — the adversarial-critics
 * intro line naming the domain the idea is judged FOR. Coding/Papercusp-flavored by
 * default; a `work` hive overrides it via the blueprint `scout.framing.criticMission`
 * block. This is the DOMAIN framing only — the two-axis novelty/feasibility critic
 * MECHANISM + the JSON output contract stay hardcoded (P-011).
 *
 * Exported so {@link DEFAULT_SCOUT_FRAMING} (config.ts) is built FROM it (anti-drift).
 */
export const DEFAULT_CRITIC_MISSION =
  'You are TWO adversarial critics judging ONE creative idea proposed for the Papercusp "Hive" (a multi-agent coding platform). You pull against each other on purpose:';

export interface CriticContext {
  /** Project / architecture summary the feasibility critic weighs against. */
  projectContext?: string;
  model?: string;
  thinkingBudgetTokens?: number;
  /**
   * Per-blueprint MISSION framing override (P-010). Replaces the default
   * adversarial-critics intro with the hive's domain framing. Absent ⇒
   * {@link DEFAULT_CRITIC_MISSION} (byte-identical to the pre-seam prompt).
   */
  mission?: string;
}

export interface CriticRawScores {
  /** The LLM novelty-skeptic's conceptual-novelty score (0..1). */
  conceptualNovelty: number;
  /** The LLM feasibility critic's score (0..1). */
  feasibility: number;
  rationale: string;
  costUsd: number;
}

export interface CritiqueOptions {
  novelty?: CorpusNoveltyOptions;
  bucket?: BucketOptions;
  critic?: CriticContext;
}

export interface CritiqueResult {
  /** Every idea scored (verdict reflects the post-cap bucket). */
  critiques: ScoredIdea[];
  /** Survivors to build (novel + feasible). */
  kept: ScoredIdea[];
  /** Preserved high-novelty / low-feasibility leaps (capped, D-005). */
  moonshot: ScoredIdea[];
  /** The obvious / already-tried + not-strong-enough leaps + capped-out leaps. */
  rejected: ScoredIdea[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: unknown, fallback: number): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, x));
}

export function buildCriticPrompt(
  idea: Idea,
  nearestPriors: ReadonlyArray<{ ref: string; similarity: number; state?: string }>,
  ctx: CriticContext,
): { system: string; user: string } {
  const system = [
    // P-010: the domain MISSION framing is blueprint-overridable; the two-critic
    // mechanism + JSON output contract below stay hardcoded.
    ctx.mission ?? DEFAULT_CRITIC_MISSION,
    '',
    '• NOVELTY critic (skeptic): is this genuinely NEW, or the obvious move dressed up / something already tried? Be harsh — penalise ideas close to what already exists. Score conceptualNovelty 0 (obvious / already done) … 1 (a real leap).',
    '• FEASIBILITY critic: could this actually work in THIS architecture, and is the cost worth the upside? Score feasibility 0 (impractical / no clear payoff) … 1 (clearly buildable, high payoff).',
    '',
    'A great idea is novel AND feasible; a leap may be novel but not-yet-feasible (that is fine — it is preserved separately). Reason briefly, then output ONLY this JSON (no prose, no fences):',
    '{"conceptualNovelty": <0-1 number>, "feasibility": <0-1 number>, "rationale": "<one or two sentences>"}',
  ].join('\n');

  const priorLines = nearestPriors.length
    ? nearestPriors
        .map((p) => `  - ${p.ref}${p.state ? ` [${p.state}]` : ''} (similarity ${p.similarity})`)
        .join('\n')
    : '  (none — the search-first pass found nothing close)';

  const user = [
    `## Idea (lens: ${idea.lens})`,
    `Title: ${idea.title}`,
    '',
    'What it is:',
    idea.body,
    '',
    'Proposed mechanism:',
    idea.mechanism,
    '',
    '## Closest things the Hive has already considered (search-first)',
    priorLines,
    '',
    '## Architecture context',
    ctx.projectContext ?? '(none provided)',
  ].join('\n');

  return { system, user };
}

/** Run the LLM critic for one idea (injected llmCall — testable with a fake). */
export async function runCritic(
  idea: Idea,
  nearestPriors: ReadonlyArray<{ ref: string; similarity: number; state?: string }>,
  ctx: CriticContext,
  deps: { llmCall: ScoutLlmCall },
): Promise<CriticRawScores> {
  const { system, user } = buildCriticPrompt(idea, nearestPriors, ctx);
  const thinkingBudgetTokens = ctx.thinkingBudgetTokens ?? 1024;
  const res = await deps.llmCall({
    model: ctx.model ?? DEFAULT_CRITIC_MODEL,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
    thinkingBudgetTokens,
    maxTokens: thinkingBudgetTokens + 1024,
  });
  const parsed = parseLlmJson(res) as Record<string, unknown> | null;
  if (parsed == null) {
    // Fail safe: an unparseable critic cannot smuggle an idea through to KEEP —
    // feasibility 0 forbids 'keep'; novelty 1 leaves the search-first ceiling intact.
    return { conceptualNovelty: 1, feasibility: 0, rationale: 'critic produced no parseable JSON', costUsd: res.costUsd };
  }
  return {
    conceptualNovelty: clamp01(parsed.conceptualNovelty, 1),
    feasibility: clamp01(parsed.feasibility, 0),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    costUsd: res.costUsd,
  };
}

/**
 * Critique one idea: deterministic search-first novelty (the CEILING) blended via
 * `min` with the LLM novelty-skeptic, plus the LLM feasibility critic, then a
 * PRE-CAP verdict. The batch moonshot-cap is applied in `critiqueIdeas`.
 */
export async function critiqueIdea(
  idea: Idea,
  corpus: readonly CorpusEntry[],
  deps: { llmCall: ScoutLlmCall },
  opts: CritiqueOptions = {},
): Promise<ScoredIdea> {
  // P-017: the deterministic search-first novelty, now blended with the hybrid
  // embedding leg (fail-open to pure lexical). Still a CEILING the LLM may only lower.
  const cn = await corpusNoveltyHybrid(`${idea.title} ${idea.body}`, corpus, opts.novelty);
  const raw = await runCritic(
    idea,
    cn.matches.map((m) => ({ ref: m.ref, similarity: m.similarity, state: m.state })),
    opts.critic ?? {},
    deps,
  );
  // Search-first novelty is the CEILING: the LLM may only LOWER it.
  const novelty = round2(Math.min(cn.novelty, raw.conceptualNovelty));
  const feasibility = round2(raw.feasibility);
  const { verdict } = verdictFor({ id: idea.id, novelty, feasibility }, opts.bucket);
  return {
    idea,
    novelty,
    feasibility,
    noveltyMatches: cn.matches,
    verdict,
    notes: raw.rationale,
  };
}

/**
 * Critique a batch of ideas: score each, then partition with the capped moonshot
 * bucket (D-005) and stamp the FINAL (post-cap) verdict + reason back onto each
 * ScoredIdea. Returns the full set plus the keep / moonshot / reject lanes.
 */
export async function critiqueIdeas(
  ideas: readonly Idea[],
  corpus: readonly CorpusEntry[],
  deps: { llmCall: ScoutLlmCall },
  opts: CritiqueOptions = {},
): Promise<CritiqueResult> {
  const critiques: ScoredIdea[] = [];
  for (const idea of ideas) {
    critiques.push(await critiqueIdea(idea, corpus, deps, opts));
  }
  const buckets = bucketByCritique(
    critiques.map((c) => ({ id: c.idea.id, novelty: c.novelty, feasibility: c.feasibility })),
    opts.bucket,
  );
  for (const c of critiques) {
    const v = buckets.verdicts[c.idea.id];
    if (v) {
      c.verdict = v.verdict;
      c.notes = c.notes ? `${v.reason} — ${c.notes}` : v.reason;
    }
  }
  const byId = new Map(critiques.map((c) => [c.idea.id, c]));
  const pick = (rows: ReadonlyArray<{ id: string }>): ScoredIdea[] =>
    rows.map((r) => byId.get(r.id)).filter((c): c is ScoredIdea => c != null);
  return {
    critiques,
    kept: pick(buckets.kept),
    moonshot: pick(buckets.moonshot),
    rejected: pick(buckets.rejected),
  };
}
