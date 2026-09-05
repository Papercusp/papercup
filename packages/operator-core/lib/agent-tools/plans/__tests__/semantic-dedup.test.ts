/**
 * semantic-dedup — plans:new's similar_exists CONFIRMATION check
 * (P-010 shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Everything through injected deps (the real resolver lazy-loads an ONNX
 * model — WI-3792 load-scar class); the no-deps cases assert VITEST inertness.
 * The confirmation contract under test: only a POSITIVE cosine verdict may
 * shrink the token refusal — every degraded path returns the candidates
 * unchanged (verdict:false), never a throw.
 *
 * D-025: the SEARCH leg that used to live in this module (`semanticPlanHits`)
 * moved to ../semantic-leg.ts and now runs inside `runHybridSearch`; its tests
 * moved with it. What is left here is a threshold classifier in the doc↔doc
 * pairing, which is deliberately NOT on the engine — see that module's header.
 *
 * ─── THE CALIBRATION GUARD (WI-2145556) ────────────────────────────────────
 * Every test in this file's previous revision INJECTED the similarity numbers
 * it then asserted on, so all six passed identically whether the cut was 0.0,
 * 0.6 or 1.0. Nothing tested that the cut SEPARATES ANYTHING in the real
 * distribution — which is why the absolute 0.6 could sit below the entire live
 * corpus (min pair 0.650 over 7,140 pairs) for weeks with a green suite while
 * the `dropped` branch was unreachable and every refusal needed `force:true`.
 *
 * `describe('calibration guard')` below closes that: it drives the classifier
 * with a background whose SHAPE is the measured live one and asserts the
 * partition is REACHABLE — a candidate is dropped and a candidate is kept. It
 * asserts nothing about the quality of live data (that would redden the shared
 * gate for data reasons); the fixture is recorded, offline and deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  confirmSimilarPlans,
  planDupeAbsoluteOverride,
  planDupeBaselineQuantile,
  resolveConfirmCalibration,
  type PlanConfirmDeps,
} from '../semantic-dedup';
// Import the width — these fixtures are ABOUT the prose column contract, so a
// width change moves them automatically instead of stranding them here (the
// 384→768 strand they were fixed for).
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

/**
 * A background with the SHAPE measured on the live corpus 2026-09-05 in this
 * module's own units — `1 - (embedding <=> vec::vector)` over
 * `harness_shared.harness_plans` — where 120 random plans / 7,140 pairs gave
 * min 0.650, p05 0.720, median 0.776, max 1.000.
 *
 * The load-bearing property is that the WHOLE distribution sits above any
 * plausible hand-picked absolute cosine cut; that is what made the old 0.6
 * inert. Recorded, not sampled live: this file must never redden because
 * production data moved.
 */
const LIVE_SHAPED_BACKGROUND = Array.from({ length: 200 }, (_, i) => 0.65 + (i / 199) * 0.25);

function deps(over: Partial<PlanConfirmDeps> = {}): PlanConfirmDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed: async () => VEC }),
    querySimilarities: async () => new Map(),
    queryBackgroundSimilarities: async () => LIVE_SHAPED_BACKGROUND,
    ...over,
  };
}

const CANDS = [{ slug: 'plan-a' }, { slug: 'plan-b' }, { slug: 'plan-c' }];

afterEach(() => {
  delete process.env.PAPERCUSP_PLAN_DUPE_CONFIRM;
  delete process.env.PAPERCUSP_PLAN_DUPE_QUANTILE;
});

describe('confirmSimilarPlans', () => {
  it('is inert under vitest without injected deps (verdict:false, candidates unchanged)', async () => {
    const r = await confirmSimilarPlans({ title: 't' }, CANDS);
    expect(r.verdict).toBe(false);
    expect(r.kept).toEqual(CANDS);
    expect(r.calibration).toBeUndefined();
  });

  it('drops candidates below the corpus-relative cut, keeps confirmed ones with similarity attached', async () => {
    const d = deps({
      querySimilarities: async () =>
        new Map([
          ['plan-a', 0.95], // genuine dupe — above the corpus's own top tail, kept
          ['plan-b', 0.78], // token-only false positive — median of the corpus, dropped
        ]),
    });
    const r = await confirmSimilarPlans({ title: 't', body: 'b' }, CANDS, {}, d);
    expect(r.verdict).toBe(true);
    expect(r.kept.map((k) => k.slug)).toEqual(['plan-a', 'plan-c']);
    expect(r.kept[0].similarity).toBe(0.95);
    expect(r.dropped).toEqual([{ slug: 'plan-b', similarity: 0.78 }]);
    expect(r.calibration?.basis).toBe('corpus-relative');
  });

  it('keeps a candidate with NO stored vector (no per-candidate verdict)', async () => {
    const d = deps({ querySimilarities: async () => new Map([['plan-b', 0.1]]) });
    const r = await confirmSimilarPlans({ title: 't' }, CANDS, {}, d);
    // plan-a and plan-c have no vector → kept without similarity.
    expect(r.kept.map((k) => k.slug)).toEqual(['plan-a', 'plan-c']);
    expect(r.kept[0].similarity).toBeUndefined();
  });

  it('returns candidates unchanged when the embedder is unavailable / wrong dims / throws', async () => {
    for (const d of [
      deps({ resolveEmbedder: async () => null }),
      deps({ resolveEmbedder: async () => ({ mode: 'harrier', dims: 1024, embed: async () => VEC }) }),
      deps({ resolveEmbedder: async () => { throw new Error('boom'); } }),
      deps({ querySimilarities: async () => { throw new Error('553 absent'); } }),
    ]) {
      const r = await confirmSimilarPlans({ title: 't' }, CANDS, {}, d);
      expect(r.verdict).toBe(false);
      expect(r.kept).toEqual(CANDS);
    }
  });

  it('keeps every candidate when the background is unavailable, too small, or degenerate', async () => {
    const sims = async () => new Map([['plan-a', 0.7]]);
    for (const d of [
      // no background seam at all
      deps({ querySimilarities: sims, queryBackgroundSimilarities: undefined }),
      // the background read threw
      deps({ querySimilarities: sims, queryBackgroundSimilarities: async () => { throw new Error('no 553'); } }),
      // too few samples to be a population
      deps({ querySimilarities: sims, queryBackgroundSimilarities: async () => [0.7, 0.8, 0.9] }),
      // near-self-identical corpus: a cut here would clear real duplicates
      deps({ querySimilarities: sims, queryBackgroundSimilarities: async () => Array(200).fill(0.999) }),
    ]) {
      const r = await confirmSimilarPlans({ title: 't' }, CANDS, {}, d);
      expect(r.verdict).toBe(false);
      expect(r.kept).toEqual(CANDS);
      expect(r.dropped).toEqual([]);
    }
  });

  it('honors the PAPERCUSP_PLAN_DUPE_CONFIRM absolute override, without reading a background', async () => {
    process.env.PAPERCUSP_PLAN_DUPE_CONFIRM = '0.9';
    expect(planDupeAbsoluteOverride()).toBe(0.9);
    let backgroundReads = 0;
    const d = deps({
      querySimilarities: async () => new Map([['plan-a', 0.85]]),
      queryBackgroundSimilarities: async () => {
        backgroundReads += 1;
        return LIVE_SHAPED_BACKGROUND;
      },
    });
    const r = await confirmSimilarPlans({ title: 't' }, [{ slug: 'plan-a' }], {}, d);
    expect(r.dropped.map((x) => x.slug)).toEqual(['plan-a']); // 0.85 < 0.9
    expect(r.calibration).toEqual({ basis: 'absolute-override', cut: 0.9, backgroundSamples: 0 });
    expect(backgroundReads).toBe(0);
  });

  it('treats a garbage override as absent, so the corpus-relative rule stays in force', () => {
    process.env.PAPERCUSP_PLAN_DUPE_CONFIRM = 'nonsense';
    expect(planDupeAbsoluteOverride()).toBeNull();
    process.env.PAPERCUSP_PLAN_DUPE_QUANTILE = 'nonsense';
    expect(planDupeBaselineQuantile()).toBe(0.95);
  });
});

describe('resolveConfirmCalibration', () => {
  it('takes the cut from the background quantile, not from a constant', () => {
    const c = resolveConfirmCalibration(LIVE_SHAPED_BACKGROUND, { quantile: 0.95 });
    expect(c?.basis).toBe('corpus-relative');
    expect(c?.backgroundSamples).toBe(200);
    // Nearest-rank on a 200-point ramp over [0.65, 0.90].
    expect(c!.cut).toBeCloseTo(0.65 + (190 / 199) * 0.25, 6);
  });

  it('moves with the corpus instead of staying put — the whole point of the change', () => {
    const compressed = LIVE_SHAPED_BACKGROUND;
    const spread = Array.from({ length: 200 }, (_, i) => 0.2 + (i / 199) * 0.6);
    const a = resolveConfirmCalibration(compressed, {})!.cut;
    const b = resolveConfirmCalibration(spread, {})!.cut;
    expect(a).toBeGreaterThan(b);
  });

  it('declines to classify on too few samples, a degenerate background, or non-finite noise', () => {
    expect(resolveConfirmCalibration(Array(31).fill(0.8), {})).toBeNull();
    expect(resolveConfirmCalibration(Array(200).fill(0.999), {})).toBeNull();
    expect(resolveConfirmCalibration(Array(200).fill(Number.NaN), {})).toBeNull();
  });

  it('an absolute override wins and reports itself as such', () => {
    expect(resolveConfirmCalibration([], { absoluteOverride: 0.42 })).toEqual({
      basis: 'absolute-override',
      cut: 0.42,
      backgroundSamples: 0,
    });
  });
});

/**
 * The guard whose ABSENCE let WI-2145556 happen. It does not assert that the
 * corpus is healthy — it asserts that the classifier's partition is REACHABLE
 * on a distribution shaped like the real one, which no injected-similarity test
 * can do.
 */
describe('calibration guard — the cut must be able to partition the real distribution', () => {
  it('the recorded live shape sits ENTIRELY above the old absolute cut (why it went inert)', () => {
    // This is the measured fact, recorded: min pair 0.650 over 7,140 live pairs.
    // Any absolute constant at or below the corpus floor can drop nothing.
    expect(Math.min(...LIVE_SHAPED_BACKGROUND)).toBeGreaterThan(0.6);
    const OLD_ABSOLUTE_CUT = 0.6;
    expect(LIVE_SHAPED_BACKGROUND.filter((s) => s < OLD_ABSOLUTE_CUT)).toHaveLength(0);
  });

  it('partitions that same distribution: something is dropped AND something is kept', async () => {
    const cut = resolveConfirmCalibration(LIVE_SHAPED_BACKGROUND, {})!.cut;
    // Two candidates straddling the corpus's own top tail — the case the old
    // absolute cut could not express at all, because both sit above 0.6.
    const nearDuplicate = 0.97;
    const sameDomainOnly = 0.7;
    expect(nearDuplicate).toBeGreaterThan(0.6);
    expect(sameDomainOnly).toBeGreaterThan(0.6);

    const d = deps({
      querySimilarities: async () =>
        new Map([
          ['plan-a', nearDuplicate],
          ['plan-b', sameDomainOnly],
        ]),
    });
    const r = await confirmSimilarPlans({ title: 't' }, [{ slug: 'plan-a' }, { slug: 'plan-b' }], {}, d);

    expect(r.verdict).toBe(true);
    expect(r.dropped.length).toBeGreaterThan(0); // the branch that was unreachable
    expect(r.kept.length).toBeGreaterThan(0); // and it did not simply drop everything
    expect(r.dropped.map((x) => x.slug)).toEqual(['plan-b']);
    expect(r.kept.map((x) => x.slug)).toEqual(['plan-a']);
    expect(r.calibration?.cut).toBe(cut);
  });

  it('reports the cut it used, so an inert classifier is visible at the call site', async () => {
    const d = deps({ querySimilarities: async () => new Map([['plan-a', 0.99]]) });
    const r = await confirmSimilarPlans({ title: 't' }, [{ slug: 'plan-a' }], {}, d);
    expect(r.calibration).toMatchObject({
      basis: 'corpus-relative',
      backgroundSamples: 200,
      quantile: 0.95,
    });
    expect(r.calibration!.cut).toBeGreaterThan(Math.min(...LIVE_SHAPED_BACKGROUND));
  });
});
