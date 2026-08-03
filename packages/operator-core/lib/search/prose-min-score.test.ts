/**
 * The papercusp prose `minScore` floor selection (P-001).
 *
 * The behaviour under test is small but load-bearing: a floor is only valid
 * in the units of the model that produced the query vector, so the ONE thing
 * that must never regress is that an unmeasured mode gets NO floor rather
 * than someone else's number.
 */

import { describe, it, expect } from 'vitest';
import { EMBEDDING_FLOOR_GEMMA, proseMinScoreFloors } from './prose-min-score';

describe('proseMinScoreFloors', () => {
  it('applies the measured cosine floor for gemma', () => {
    expect(proseMinScoreFloors('gemma')).toEqual({ embeddings: EMBEDDING_FLOOR_GEMMA });
  });

  it('returns NO floor for an unmeasured mode — never another model`s number', () => {
    // A gemma-derived floor on an OpenAI vector would delete nearly every
    // result while looking like a correctly-configured floor: cosine offsets
    // are a property of the model, not of similarity.
    expect(proseMinScoreFloors('openai')).toBeUndefined();
    expect(proseMinScoreFloors('harrier')).toBeUndefined();
    expect(proseMinScoreFloors('some-future-model')).toBeUndefined();
  });

  it('returns NO floor when there is no embedder at all', () => {
    expect(proseMinScoreFloors(null)).toBeUndefined();
    expect(proseMinScoreFloors(undefined)).toBeUndefined();
  });

  it('never floors the lexical leg — ts_rank_cd distributions are unmeasured', () => {
    expect(proseMinScoreFloors('gemma')?.bm25).toBeUndefined();
  });

  it('keeps the floor below the worst TRUE hit we measured (0.4825 in-domain top-1)', () => {
    // The floor is set from the worst observed true hit, not the best observed
    // noise, because dropping a real hit is unrecoverable while keeping noise
    // only costs a rank slot. If someone raises this constant, this assertion
    // is the one that should stop them without re-reading the measurement.
    expect(EMBEDDING_FLOOR_GEMMA).toBeLessThan(0.4825);
    // ...and above the weakest off-domain top-1s, so it still does work.
    expect(EMBEDDING_FLOOR_GEMMA).toBeGreaterThan(0.4134);
  });
});
