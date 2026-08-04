/**
 * docs-search-embedder-identity — the recurrence guard for a defect that was
 * caught mid-migration and would have shipped invisibly (P-016 / D-024 of
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * THE CLASS. The P-017 similarity floor is resolved from the embedder
 * INSTANCE, not from a mode string a caller plumbs: `agent-tools/search/
 * embedder.ts` stamps every embedder it builds into a
 * `WeakMap<Embedder, mode>`, and `embedderModeOf` is a lookup on that exact
 * function object. That design is deliberate — it is what makes an embedder
 * from a FOREIGN space miss and get no floor, instead of inheriting a
 * threshold calibrated somewhere else.
 *
 * The trap it sets: wrapping the resolved embedder in ANY closure — a
 * width guard, a timer, a log line, a retry — produces a different function
 * object, so the lookup misses, `proseMinScoreFloors(undefined)` returns no
 * floor, and the surface silently ranks UNFLOORED while every leg still
 * reports as having run. Nothing fails. The search just quietly goes back to
 * handing fusion its k nearest rows whether or not any is a match, which is
 * the precise defect P-016 exists to remove.
 *
 * It is invisible to every other kind of test — a mocked embedder is never
 * stamped either, so a fixture-driven fusion test passes identically with and
 * without the bug. Identity is the only property that discriminates, so it is
 * asserted directly here.
 *
 * The CONTROL below is what makes this falsifiable: the same assertion run
 * against a deliberately-wrapped embedder must FAIL. Without it, a test that
 * only ever sees the correct implementation cannot tell you it would catch
 * the wrong one.
 */

import { describe, it, expect } from 'vitest';
import { resolveDocsEmbedder, type DocSemanticDeps } from '../semantic-leg';
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

/** The exact function instance a stamped resolver would have handed out. */
const stamped = async (): Promise<number[]> => VEC;

function deps(over: Partial<DocSemanticDeps> = {}): DocSemanticDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed: stamped }),
    querySections: async () => [],
    ...over,
  };
}

describe('resolveDocsEmbedder preserves embedder IDENTITY (floor provenance)', () => {
  it('hands back the SAME function object the resolver produced', async () => {
    const { embedder, embeddingMode } = await resolveDocsEmbedder(deps());
    expect(embeddingMode).toBe('gemma');
    // `toBe`, not `toEqual`: reference identity is the whole property. A
    // wrapper is deep-equal to nothing and behaviourally identical, so only
    // an identity check can see it.
    expect(embedder).toBe(stamped);
  });

  it('CONTROL: a wrapped embedder — the bug — fails that same assertion', async () => {
    // Behaviourally indistinguishable from the real thing: same input, same
    // output, same errors. This is what makes the defect so easy to introduce
    // and so hard to notice. Only identity separates them.
    const wrapped = async (t: string): Promise<number[]> => {
      const vec = await stamped();
      if (vec.length !== PROSE_VECTOR_DIMS) throw new Error(`bad width for ${t}`);
      return vec;
    };
    expect(await wrapped('q')).toEqual(await stamped());
    expect(wrapped).not.toBe(stamped);
  });

  it('a REJECTING embedder is correctly NOT the resolved one (D-023 still holds)', async () => {
    // The degraded paths deliberately return a fresh rejecting function — they
    // have no resolved embedder to preserve, and no floor to look up (the leg
    // never ranks). Identity preservation applies to the SUCCESS path only, so
    // pin that boundary rather than letting a future reader over-apply it.
    const { embedder, embeddingMode } = await resolveDocsEmbedder(
      deps({ resolveEmbedder: async () => null }),
    );
    expect(embeddingMode).toBeNull();
    expect(embedder).not.toBe(stamped);
    await expect(embedder('q')).rejects.toThrow(/no query embedder resolved/);
  });
});
