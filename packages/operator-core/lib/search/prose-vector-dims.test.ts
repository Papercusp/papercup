/**
 * The STORAGE half of D-001's guard.
 *
 * D-001 (prose-embedding-384-untrained-mrl-fix-2026-08-02) made every embedder
 * DECLARE the width it emits, and made the builders derive their constant from
 * that declaration so the two could not drift. It left the other side of the
 * contract unguarded: nothing asserted that the width a mode emits is the width
 * the database columns can actually hold. They agreed only by coincidence —
 * every mode happened to be 384 — and `384` was restated in seven files.
 *
 * That gap is not theoretical. A width mismatch does not throw at startup; it
 * surfaces either as a pgvector INSERT error inside a background sweep nobody
 * is watching, or — the quieter and worse case — as a dims guard that skips
 * every prose surface, which is indistinguishable from "embeddings are turned
 * off". These tests make the disagreement red HERE instead.
 */

import { describe, it, expect } from 'vitest';
import { EMBEDDER_DIM_SPECS, isTrainedDim, type EmbedderMode } from '@papercusp/memory';
import {
  PROSE_VECTOR_DIMS,
  PROSE_ELIGIBLE_MODES,
  PROSE_VECTOR_COLUMNS,
  fitsProseColumns,
  modeTargetDims,
} from './prose-vector-dims';

describe('the prose column width contract', () => {
  it('every prose-eligible mode emits EXACTLY the column width', () => {
    for (const mode of PROSE_ELIGIBLE_MODES) {
      expect(
        modeTargetDims(mode),
        `${mode} is declared prose-eligible but emits ${modeTargetDims(mode)} dims, ` +
          `while the prose columns are vector(${PROSE_VECTOR_DIMS}). Either its targetDims ` +
          `changed without the migration that widens the columns, or it should be removed ` +
          `from PROSE_ELIGIBLE_MODES.`,
      ).toBe(PROSE_VECTOR_DIMS);
    }
  });

  /**
   * The converse, and the one that catches the DANGEROUS direction: someone
   * widens a model to match the columns and forgets that this also makes it a
   * legal prose writer. Without this, the new mode's vectors would be stored
   * by the backfill sweep while the readers' eligibility list still excluded
   * it — a silent mixed-space column.
   */
  it('the eligible list is EXACTLY the set of modes that fit — no mode fits silently', () => {
    const actuallyFits = (Object.keys(EMBEDDER_DIM_SPECS) as EmbedderMode[])
      .filter((m) => EMBEDDER_DIM_SPECS[m].targetDims === PROSE_VECTOR_DIMS)
      .sort();
    expect(
      actuallyFits,
      'A mode now emits the prose column width but is not listed in PROSE_ELIGIBLE_MODES ' +
        '(or is listed but no longer fits). The list is a physical constraint, not a preference — ' +
        'update it in the same change that moved the width.',
    ).toEqual([...PROSE_ELIGIBLE_MODES].sort());
  });

  it('the width a prose-eligible mode emits is one it was actually TRAINED to emit', () => {
    // The original bug: 384 was a legal-looking prefix of gemma's 768 that the
    // model was never trained to nest at. A prose-eligible mode must not be
    // storing an untrained cut, whatever the column happens to be.
    for (const mode of PROSE_ELIGIBLE_MODES) {
      const spec = EMBEDDER_DIM_SPECS[mode];
      expect(
        isTrainedDim(spec, PROSE_VECTOR_DIMS),
        `${mode} (${spec.model}) would store an UNTRAINED ${PROSE_VECTOR_DIMS}-dim cut ` +
          `(native ${spec.nativeDims}, mrl '${spec.mrl}', trained at ${spec.trainedDims.join('/')}). ` +
          `That is the exact defect EI-19301722864393687 was filed for.`,
      ).toBe(true);
    }
  });

  it('no prose-eligible mode carries a stale untrainedCut acknowledgement', () => {
    for (const mode of PROSE_ELIGIBLE_MODES) {
      expect(EMBEDDER_DIM_SPECS[mode].untrainedCut, `${mode} fits the columns at a trained width, so its untrainedCut ack is stale — it would pre-authorize the NEXT untrained cut (D-001)`).toBeUndefined();
    }
  });

  it('modes that cannot emit the column width are excluded, with local named explicitly', () => {
    // Regression pin for D-005 §6. bge-small is natively 384 with no MRL, so a
    // 768 column makes it prose-ineligible. If someone "fixes" that by adding
    // local back to the list, the first test above reds — but pin the reason
    // here so the intent is legible rather than inferred from a failure.
    expect(EMBEDDER_DIM_SPECS.local.mrl).toBe('none');
    expect(EMBEDDER_DIM_SPECS.local.nativeDims).toBe(384);
    expect((PROSE_ELIGIBLE_MODES as readonly string[]).includes('local')).toBe(false);
    expect((PROSE_ELIGIBLE_MODES as readonly string[]).includes('harrier')).toBe(false);
  });

  it('fitsProseColumns is the dims guard, and rejects the near-miss widths', () => {
    expect(fitsProseColumns(PROSE_VECTOR_DIMS)).toBe(true);
    // The three widths that actually show up in this codebase's history.
    expect(fitsProseColumns(384)).toBe(false); // the old untrained cut
    expect(fitsProseColumns(512)).toBe(false); // the trained dim D-005 rejected
    expect(fitsProseColumns(1024)).toBe(false); // harrier / qwen3 native
  });

  it('lists every column the width contract covers', () => {
    // A new prose surface added without registering it here would be migrated
    // by hand and could quietly keep a stale width.
    expect(PROSE_VECTOR_COLUMNS.length).toBeGreaterThanOrEqual(5);
    for (const c of PROSE_VECTOR_COLUMNS) {
      expect(c.table.startsWith('harness_shared.'), `${c.table} should be schema-qualified`).toBe(true);
      expect(c.column.length).toBeGreaterThan(0);
    }
    // No duplicates — a repeated entry would make a migration ALTER twice and
    // read as broader coverage than it is.
    const keys = PROSE_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
