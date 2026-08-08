/**
 * surface-registry — every search surface, and what it is DECLARED to do
 * (P-021 of semantic-search-fingerprint-coverage-2026-08-03).
 *
 * ─── WHY A REGISTRY AT ALL ─────────────────────────────────────────────────
 * The audit behind this plan found eight surfaces with no embedding floor and
 * six discarding the engine's leg report — not because anyone decided against
 * them, but because every ranking feature landed as an optional per-call field
 * that had to be hand-propagated, and hand-propagation never happens. P-017
 * fixed the propagation (a surface inherits the policy by importing the seam).
 * This fixes the ENUMERATION: a new `*:search` tool that quietly ships
 * keyword-only is now a build failure rather than a discovery someone makes
 * months later.
 *
 * ─── DECLARED vs DERIVED — the part that makes this not-ceremony ───────────
 * Entries below are DECLARATIONS of intent. `search-surface-conformance.test.ts`
 * DERIVES the same facts from each surface's transitive runtime import graph
 * and fails on any disagreement. A registry nobody can contradict is a comment;
 * the value is entirely in the cross-check.
 *
 * The rule that actually bites: **`engine: true` obliges the graph to reach
 * `configure-search-defaults`.** An engine caller without the policy seam runs
 * an unfloored vector leg, where RRF weights rank-1 noise exactly like a rank-1
 * real hit. That is the original bug, and it is still live in one surface.
 *
 * ─── WHAT THIS CANNOT SEE (state it, do not paper over it) ─────────────────
 * Discovery matches tools NAMED `*:search` / `search:*`. A search-shaped
 * surface under another name is invisible to it and must be added here BY
 * HAND. P-030 ran that hand-audit once (2026-08-08) and folded in six such
 * surfaces — the `coord:feed` `q=` filter, both `/adv/sessions/*` routes,
 * `/user/search`, the P-008 corpus-recall leg, and the boot warmup. So the
 * registry is AUTOMATICALLY complete for the naming class, and MANUALLY
 * complete as of that audit. A non-tool surface added later is still
 * invisible until someone adds it: this is a floor, never a self-maintaining
 * census.
 *
 * Two derivation limits, both of which bit during that audit and both of
 * which the entries below are written around:
 *
 *  1. **The derivation is per-MODULE, and a module can host more than one
 *     surface.** `endpoint-route/routes/adv/sessions.ts` serves BOTH
 *     `/adv/sessions/search` (a synchronous JSONL file scan) and
 *     `/adv/sessions/search-transcripts` (the hybrid engine). The file
 *     derives `hybrid` because of the second, which says nothing about the
 *     first. An entry must therefore point at the module that IMPLEMENTS its
 *     mechanism — `omp-sessions.ts` for the grep route — not at the HTTP
 *     wrapper both routes happen to share.
 *  2. **The walker follows STATIC relative imports only.** A surface reaching
 *     the engine through `await import()` (or a bare package specifier)
 *     resolves to a 0-module graph, where `hasFloor: false` is TRIVIALLY true
 *     rather than measured. `transcript-search-warmup` is exactly that shape,
 *     which is why its exemption is declared and reasoned rather than
 *     inferred from a derivation that cannot see its imports.
 */

export interface SearchSurface {
  /** Registered tool name, or a stable id for a non-tool surface. */
  id: string;
  /** Entry module, relative to `packages/operator-core/lib`. */
  entry: string;
  /**
   * Which engine entrypoint this surface runs. DERIVED and cross-checked — a
   * wrong value here fails the conformance test rather than being believed.
   *
   * The three-way split exists because the first run of the conformance test
   * refuted a boolean: `search:fulltext` was declared engine-backed and is not
   * a `runHybridSearch` caller — it runs `runFullTextSearch`, the engine's
   * lexical entrypoint, deliberately. A boolean forces that surface into the
   * same bucket as one that never reached the engine at all, which erases the
   * only distinction this registry exists to make: **keyword-only by CONTRACT
   * versus keyword-only by ACCIDENT.**
   */
  engine: 'hybrid' | 'fulltext' | 'none';
  /**
   * Required when `engine: 'none'`. Not a formality: every one of these was a
   * candidate for "why isn't this on the engine?", and writing the answer down
   * once is what stops it being re-litigated every audit.
   */
  whyNotEngine?: string;
  /**
   * An engine-backed surface that does NOT inherit the P-017 floor. This is a
   * TRACKED DEFECT, never an option — the conformance test caps the set and
   * verifies each entry is still real, so it can only shrink.
   */
  floorGap?: { reason: string; trackedBy: string };
  /**
   * An engine-backed surface that runs UNFLOORED and is CORRECT to — because
   * it has no result set for a floor to protect. It discards what the engine
   * returns; the call exists for its side effects (warming a pool, an
   * embedder, a prepared statement).
   *
   * This is deliberately NOT a second `floorGap`. A gap is a tracked defect
   * that must shrink; this is a permanent, correct state. Filing one as the
   * other corrupts both — the ceiling stops measuring outstanding defects,
   * and a genuine gap can hide behind a category that never has to shrink.
   * That is the `KNOWN_DARK_FLAGS` failure D-027 names, one level over.
   *
   * The claim is DERIVED, not trusted: the conformance test checks that every
   * `runHybridSearch` call in the entry module is a bare statement whose value
   * is discarded, so an entry that starts consuming results fails here instead
   * of keeping an exemption it no longer earns.
   */
  resultsDiscarded?: string;
}

export const SEARCH_SURFACES: readonly SearchSurface[] = [
  // ─── Engine-backed, floor inherited ──────────────────────────────────────
  { id: 'work_items:search', entry: 'agent-tools/work_items/search.ts', engine: 'hybrid' },
  { id: 'docs:search', entry: 'agent-tools/docs/search.ts', engine: 'hybrid' },
  { id: 'plans:search', entry: 'agent-tools/plans/search.ts', engine: 'hybrid' },
  { id: 'sessions:search', entry: 'agent-tools/sessions/search.ts', engine: 'hybrid' },
  { id: 'search:semantic', entry: 'agent-tools/search/semantic.ts', engine: 'hybrid' },
  {
    id: 'coordination:ask-knowledge-tier',
    entry: 'agent-tools/coordination/ask-knowledge-tier.ts',
    engine: 'hybrid',
  },

  // ─── On the engine's LEXICAL entrypoint, by contract ─────────────────────
  {
    id: 'search:fulltext',
    entry: 'agent-tools/search/fulltext.ts',
    engine: 'fulltext',
    whyNotEngine:
      'Runs `runFullTextSearch`, not `runHybridSearch` — lexical BY CONTRACT: the tool exists so a ' +
      'caller can ask for exact-term matching with no embedder in the path (and so a search still ' +
      'works when the embedder is down). It shares the engine and reaches the policy seam, whose ' +
      'minScore early-outs on `mode: "fulltext"` because there is no vector leg to floor. This is ' +
      'the case a boolean `engine` field got wrong on the first conformance run.',
  },

  // ─── Engine-backed, floor MISSING (tracked defect, shrink-only) ──────────
  {
    id: 'recipes:search',
    entry: 'agent-tools/recipes/search.ts',
    engine: 'hybrid',
    floorGap: {
      reason:
        'code-recipes-search.ts calls runHybridSearch with a live embedder and no minScore, and never ' +
        'imports the policy seam. The fix is NOT a bare side-effect import: 0.45 was calibrated on ' +
        'doc_sections, and both prior migrations in this plan had to re-measure per corpus before ' +
        'inheriting it (plans cleared by 0.0034). Inheriting an unmeasured floor can silently ZERO the ' +
        'leg, which is worse than the unfloored noise. Needs a code_recipes calibration first.',
      trackedBy: 'EI-19899975562178082',
    },
  },

  // ─── Deliberately NOT on the engine ──────────────────────────────────────
  {
    id: 'memory:search',
    entry: 'agent-tools/memory/search.ts',
    engine: 'none',
    whyNotEngine:
      'AUDITED 2026-08-08 (P-030). The previous note here — "mem0 owns its own store and ranking" — ' +
      'was right in its conclusion and wrong about the mechanism, which matters because it implied an ' +
      'opaque third-party store nobody could reason about. What actually serves this tool is a SECOND ' +
      'FIRST-PARTY HYBRID ENGINE: backend `hybrid-pg` (configure.ts:679) = `HybridBackend(' +
      'LexicalLegBackend(mem0), mem0)` from `@papercusp/memory`, with its own RRF fusion ' +
      '(hybrid-fusion.ts), its own diversity re-rank, and its own score-floor primitive ' +
      '(`applyScoreFloor`). So it is NOT keyword-only and NOT unfloorable — it is a parallel ' +
      'implementation of the same design as `@papercusp/search`, which is why migrating it would be a ' +
      'consolidation project, not a floor fix.\n\n' +
      'The one asymmetry worth knowing, since it looks like a floor gap and is not: this PULL path ' +
      'passes no `minScore`/`minLexScore`/`fusionMode` (search.ts:233), so it runs `floored-union` ' +
      'with an unfloored cosine leg, while the PUSH path (memory/injection.ts) passes a cosine floor, ' +
      'minLexScore 0.40 and `cosine-gated`. That split is DELIBERATE and recorded at ' +
      'injection.ts:298-303 (context-injection-audit-2026-07-28 D-010): "A human running memory:search ' +
      'wants recall and can discard a bad hit; auto-injection has no LLM filter downstream, so it ' +
      'wants precision." Do not "fix" the pull path to match the push path — that is a recall ' +
      'regression against an explicit decision.',
  },
  {
    id: 'rubrics:search',
    entry: 'agent-tools/rubrics/search.ts',
    engine: 'none',
    whyNotEngine:
      'Delegates to searchRubrics() over a small, bounded rubric set where lexical matching is ' +
      'adequate and a vector leg would add an embedder dependency to a read that must work when the ' +
      'embedder is down. Revisit if the rubric corpus grows past a few hundred rows.',
  },
  {
    id: 'cupboard:search',
    entry: 'agent-tools/cupboard/search.ts',
    engine: 'none',
    whyNotEngine:
      'Searches a catalog of installable listings by kind/name, not prose. The useful ranking signal ' +
      'is structural (kind, install state), not semantic similarity over a body.',
  },
];

/**
 * The number of engine-backed surfaces allowed to lack the P-017 floor.
 *
 * SHRINK-ONLY. Fixing a gap removes its entry and this number comes down with
 * it. Raising it requires an explicit decision recorded on the plan — the
 * `KNOWN_DARK_FLAGS` lesson: a ceiling that is quietly bumped each time the
 * same bug class recurs stops being a ceiling.
 */
export const FLOOR_GAP_CEILING = 1;
