/**
 * The width of the SHARED prose embedding columns — one constant, imported by
 * every site that reads or writes them.
 *
 * WHY THIS FILE EXISTS. `384` used to be restated in SEVEN places
 * (embed-backfill, agent-tools/search/embedder, memory/configure, the plans /
 * docs / work-items semantic legs, and three scout legs). Six of them carried
 * a comment saying "= embed-backfill's EMBEDDER_DIM" and then wrote the number
 * out again — which is exactly the failure mode D-001 of
 * prose-embedding-384-untrained-mrl-fix-2026-08-02 names: "a declaration that
 * can drift from the code it describes is just a second docblock". D-001 fixed
 * the BUILDER side (the embedders derive their target from
 * `EMBEDDER_DIM_SPECS`); this fixes the STORAGE side.
 *
 * ⚠ THIS IS A STORAGE FACT, AND IT IS DELIBERATELY *NOT* DERIVED FROM
 * `EMBEDDER_DIM_SPECS`. It states what the database columns actually are, as
 * created by their migration. Deriving it from the embedder declaration would
 * be strictly worse than restating it: editing a model's `targetDims` would
 * silently move the code's idea of the column width with no migration behind
 * it, and the first symptom would be either a pgvector INSERT failure in a
 * background sweep or — worse — a dims guard that agrees with itself and skips
 * every surface, which looks exactly like "embedding is disabled".
 *
 * The two ARE required to agree; that agreement is asserted by
 * `prose-vector-dims.test.ts`, so a model width change WITHOUT its migration
 * reds a unit test instead of failing in production. That is the whole point:
 * the constant is independent, the agreement is enforced.
 *
 * TO CHANGE THIS WIDTH you need all three, together, in one change:
 *   1. the migration that ALTERs every column in `PROSE_VECTOR_COLUMNS`,
 *   2. this constant,
 *   3. the emitting mode's `targetDims` in `embedder-dims.ts`.
 * pgvector cannot cast between vector widths, so step 1 necessarily drops
 * every stored vector and the surfaces run lexical-only until the backfill
 * sweep refills them (~395k vectors, see D-005). It is not a cheap change.
 */

import { EMBEDDER_DIM_SPECS, type EmbedderMode } from '@papercusp/memory';

/**
 * Width of every shared prose embedding column, per migration 555.
 *
 * 768 = EmbeddingGemma-300m's NATIVE width. Previously 384, an UNTRAINED MRL
 * cut that measured ~19-21% worse on prose retrieval MRR (D-003). Native means
 * no truncation at all, so the untrained-cut bug class is structurally
 * impossible here rather than parked at a different trained point (D-005).
 */
export const PROSE_VECTOR_DIMS = 768;

/**
 * The embedder modes whose vectors may be STORED in the prose columns.
 *
 * A mode is prose-eligible iff it can emit exactly `PROSE_VECTOR_DIMS`. This
 * is not a preference list — it is a physical constraint, and the test asserts
 * it against each mode's declared `targetDims`.
 *
 * NOT eligible, and why:
 *  - `local`  — bge-small-en-v1.5 is natively 384 with `mrl:'none'`, so it
 *               CANNOT emit 768. It was eligible only while the columns
 *               happened to be 384 (D-005 §6). Under a `local` preference the
 *               prose surfaces now dims-guard off and run lexical-only, which
 *               is better than the previous behaviour of silently re-embedding
 *               the whole column into a weaker space on a fallback.
 *  - `harrier`— native 1024, no MRL at all (the pre-existing exclusion that
 *               `proseSurfacePreference` already maps around).
 */
export const PROSE_ELIGIBLE_MODES = ['gemma', 'openai'] as const satisfies readonly EmbedderMode[];

export type ProseEligibleMode = (typeof PROSE_ELIGIBLE_MODES)[number];

/**
 * Every column the width contract above applies to — the list a width
 * migration must ALTER, and the list the test uses so a NEW prose surface
 * cannot quietly adopt a stale width.
 */
export const PROSE_VECTOR_COLUMNS: ReadonlyArray<{ table: string; column: string; migration: string }> = [
  { table: 'harness_shared.session_turns', column: 'text_embedding', migration: '501' },
  { table: 'harness_shared.operator_turns', column: 'text_embedding', migration: '000-baseline' },
  { table: 'harness_shared.work_items', column: 'embedding', migration: '551' },
  { table: 'harness_shared.doc_sections', column: 'embedding', migration: '552' },
  { table: 'harness_shared.harness_plans', column: 'embedding', migration: '553' },
];

/**
 * Does a resolved embedder's output fit the prose columns?
 *
 * The dims guard every prose reader/writer already performs, as one named
 * predicate rather than six copies of `resolved.dims !== EMBED_DIM`. Callers
 * return null / skip the sweep when this is false.
 */
export function fitsProseColumns(dims: number): boolean {
  return dims === PROSE_VECTOR_DIMS;
}

/** The declared target width for a mode — the emitting side of the contract. */
export function modeTargetDims(mode: EmbedderMode): number {
  return EMBEDDER_DIM_SPECS[mode].targetDims;
}
