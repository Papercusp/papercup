/**
 * plans-search-embedder-identity — the D-024 recurrence guard, on the third
 * surface to inherit it (P-016 of
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * THE CLASS. The P-017 similarity floor is resolved from the embedder
 * INSTANCE, not from a mode string a caller plumbs: `agent-tools/search/
 * embedder.ts` stamps every embedder it builds into a `WeakMap<Embedder, mode>`
 * and `embedderModeOf` is a lookup on that exact function object. That design
 * is deliberate — it is what makes an embedder from a FOREIGN space miss and
 * get no floor, instead of inheriting a threshold calibrated somewhere else.
 *
 * The trap it sets: wrapping the resolved embedder in ANY closure — a width
 * guard, a timer, a log line, a retry — produces a different function object,
 * so the lookup misses, `proseMinScoreFloors(undefined)` returns no floor, and
 * the surface silently ranks UNFLOORED while every leg still reports as having
 * run. Nothing fails.
 *
 * ⚠ This surface is the one where a wrapper is MOST tempting: the code it
 * replaced (`semanticPlanHits`) checked the embed OUTPUT width — a check that
 * cannot survive without a closure. D-024 gives it up deliberately; a
 * wrong-width vector now fails inside `queryTopPlans`, which the engine records
 * in `legs.semantic.failures` and reports as degraded, where the old code
 * returned `null` and said nothing at all.
 *
 * It is invisible to every other kind of test — a mocked embedder is never
 * stamped either, so a fixture-driven fusion test passes identically with and
 * without the bug. Identity is the only discriminating property, so it is
 * asserted directly. The CONTROL is what makes that falsifiable: the same
 * assertion run against a deliberately-wrapped embedder must FAIL.
 */

import { describe, it, expect } from 'vitest';
import { resolvePlansEmbedder, type PlanSearchDeps } from '../semantic-leg';
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

/** The exact function instance a stamped resolver would have handed out. */
const stamped = async (): Promise<number[]> => VEC;

function deps(over: Partial<PlanSearchDeps> = {}): PlanSearchDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed: stamped }),
    queryTopPlans: async () => [],
    ...over,
  };
}

describe('resolvePlansEmbedder preserves embedder IDENTITY (floor provenance)', () => {
  it('hands back the SAME function object the resolver produced', async () => {
    const { embedder, embeddingMode } = await resolvePlansEmbedder(deps());
    expect(embeddingMode).toBe('gemma');
    // `toBe`, not `toEqual`: reference identity is the whole property. A
    // wrapper is deep-equal to nothing and behaviourally identical, so only an
    // identity check can see it.
    expect(embedder).toBe(stamped);
  });

  it('CONTROL: the output-width wrapper the old code needed — the bug — fails that same assertion', async () => {
    // This is not a strawman: it is what preserving `semanticPlanHits`'s
    // `if (!fitsProseColumns(vec.length)) return null` check would require.
    // Behaviourally indistinguishable from the real thing — same input, same
    // output, same errors. Only identity separates them.
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
    const { embedder, embeddingMode } = await resolvePlansEmbedder(
      deps({ resolveEmbedder: async () => null }),
    );
    expect(embeddingMode).toBeNull();
    expect(embedder).not.toBe(stamped);
    await expect(embedder('q')).rejects.toThrow(/no query embedder resolved/);
  });
});

/**
 * D-023's CALIBRATION PAIR, kept adjacent on purpose: the two cases are each
 * other's control. Collapse `resolvePlansEmbedder` to always-reject and the
 * dims case still passes but the mode case fails; make it always-resolve and
 * the reverse. Neither can go green by accident.
 */
describe('resolvePlansEmbedder reports WANTED-but-unavailable as blocked, never as not-run', () => {
  it('a wrong-width embedder is rejected with the reason (not silently dropped)', async () => {
    const { embedder, embeddingMode } = await resolvePlansEmbedder(
      deps({ resolveEmbedder: async () => ({ mode: 'harrier', dims: 1024, embed: stamped }) }),
    );
    // A null mode is what makes the caller omit the source's `embedding()`
    // method, so the engine never issues a vector query it has no space for.
    expect(embeddingMode).toBeNull();
    await expect(embedder('q')).rejects.toThrow(/dims 1024 do not fit/);
  });

  it('a throwing resolver is rejected with the reason, not swallowed', async () => {
    const { embedder, embeddingMode } = await resolvePlansEmbedder(
      deps({ resolveEmbedder: async () => { throw new Error('onnx load failed'); } }),
    );
    expect(embeddingMode).toBeNull();
    await expect(embedder('q')).rejects.toThrow(/resolution threw: onnx load failed/);
  });

  it('the no-deps vitest path is BLOCKED, not a silent lexical-only search', async () => {
    // WI-3792 load-scar class. Reported as blocked rather than not-run: the leg
    // WAS wanted here, so a test asserting "semantic ran" must fail loudly
    // instead of reading a suppressed embedder as a healthy search.
    const { embedder, embeddingMode } = await resolvePlansEmbedder();
    expect(embeddingMode).toBeNull();
    await expect(embedder('q')).rejects.toThrow(/vitest: real embedder resolution suppressed/);
  });
});
