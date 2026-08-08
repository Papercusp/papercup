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
 * surface under another name is invisible to it and must be added here by
 * hand — `coord:feed`'s `q=` filter and the second `/adv/sessions/search`
 * route are two known examples, both queued under P-030. So this registry is
 * complete for the NAMING CLASS and a floor everywhere else, never a census.
 */

export interface SearchSurface {
  /** Registered tool name, or a stable id for a non-tool surface. */
  id: string;
  /** Entry module, relative to `packages/operator-core/lib`. */
  entry: string;
  /**
   * Does this surface run `runHybridSearch`? DERIVED and cross-checked — a
   * wrong value here fails the conformance test rather than being believed.
   */
  engine: boolean;
  /**
   * Required when `engine: false`. Not a formality: every one of these was a
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
}

export const SEARCH_SURFACES: readonly SearchSurface[] = [
  // ─── Engine-backed, floor inherited ──────────────────────────────────────
  { id: 'work_items:search', entry: 'agent-tools/work_items/search.ts', engine: true },
  { id: 'docs:search', entry: 'agent-tools/docs/search.ts', engine: true },
  { id: 'plans:search', entry: 'agent-tools/plans/search.ts', engine: true },
  { id: 'sessions:search', entry: 'agent-tools/sessions/search.ts', engine: true },
  { id: 'search:semantic', entry: 'agent-tools/search/semantic.ts', engine: true },
  { id: 'search:fulltext', entry: 'agent-tools/search/fulltext.ts', engine: true },
  {
    id: 'coordination:ask-knowledge-tier',
    entry: 'agent-tools/coordination/ask-knowledge-tier.ts',
    engine: true,
  },

  // ─── Engine-backed, floor MISSING (tracked defect, shrink-only) ──────────
  {
    id: 'recipes:search',
    entry: 'agent-tools/recipes/search.ts',
    engine: true,
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
    engine: false,
    whyNotEngine:
      'mem0 owns its own store, embedding lifecycle and recall ranking; the engine would have to ' +
      'duplicate or bypass it. Explicitly NOT yet audited to this matrix — P-030 covers it, so treat ' +
      'this entry as "known unexamined", not "known healthy".',
  },
  {
    id: 'rubrics:search',
    entry: 'agent-tools/rubrics/search.ts',
    engine: false,
    whyNotEngine:
      'Delegates to searchRubrics() over a small, bounded rubric set where lexical matching is ' +
      'adequate and a vector leg would add an embedder dependency to a read that must work when the ' +
      'embedder is down. Revisit if the rubric corpus grows past a few hundred rows.',
  },
  {
    id: 'cupboard:search',
    entry: 'agent-tools/cupboard/search.ts',
    engine: false,
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
