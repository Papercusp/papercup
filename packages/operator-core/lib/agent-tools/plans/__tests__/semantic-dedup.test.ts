/**
 * semantic-dedup — P-010 plan-store embedding legs
 * (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Everything through injected deps (the real resolver lazy-loads an ONNX
 * model — WI-3792 load-scar class); the no-deps cases assert VITEST inertness.
 * The confirmation contract under test: only a POSITIVE cosine verdict may
 * shrink the token refusal — every degraded path returns the candidates
 * unchanged (verdict:false), never a throw.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  confirmSimilarPlans,
  semanticPlanHits,
  planDupeConfirmThreshold,
  type PlanSemanticDeps,
  type PlanSemanticHit,
} from '../semantic-dedup';

const VEC = Array.from({ length: 384 }, () => 0.1);

function deps(over: Partial<PlanSemanticDeps> = {}): PlanSemanticDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: 384, embed: async () => VEC }),
    querySimilarities: async () => new Map(),
    queryTopPlans: async () => [],
    ...over,
  };
}

const CANDS = [{ slug: 'plan-a' }, { slug: 'plan-b' }, { slug: 'plan-c' }];

afterEach(() => {
  delete process.env.PAPERCUSP_PLAN_DUPE_CONFIRM;
});

describe('confirmSimilarPlans', () => {
  it('is inert under vitest without injected deps (verdict:false, candidates unchanged)', async () => {
    const r = await confirmSimilarPlans({ title: 't' }, CANDS);
    expect(r.verdict).toBe(false);
    expect(r.kept).toEqual(CANDS);
  });

  it('drops candidates below the threshold, keeps confirmed ones with similarity attached', async () => {
    const d = deps({
      querySimilarities: async () =>
        new Map([
          ['plan-a', 0.91], // genuine dupe — kept
          ['plan-b', 0.31], // token-only false positive — dropped
        ]),
    });
    const r = await confirmSimilarPlans({ title: 't', body: 'b' }, CANDS, {}, d);
    expect(r.verdict).toBe(true);
    expect(r.kept.map((k) => k.slug)).toEqual(['plan-a', 'plan-c']);
    expect(r.kept[0].similarity).toBe(0.91);
    expect(r.dropped).toEqual([{ slug: 'plan-b', similarity: 0.31 }]);
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

  it('honors the PAPERCUSP_PLAN_DUPE_CONFIRM env override', async () => {
    process.env.PAPERCUSP_PLAN_DUPE_CONFIRM = '0.9';
    expect(planDupeConfirmThreshold()).toBe(0.9);
    const d = deps({ querySimilarities: async () => new Map([['plan-a', 0.85]]) });
    const r = await confirmSimilarPlans({ title: 't' }, [{ slug: 'plan-a' }], {}, d);
    expect(r.dropped.map((x) => x.slug)).toEqual(['plan-a']); // 0.85 < 0.9
  });

  it('rejects garbage threshold overrides back to the default', () => {
    process.env.PAPERCUSP_PLAN_DUPE_CONFIRM = 'nonsense';
    expect(planDupeConfirmThreshold()).toBe(0.6);
  });
});

describe('semanticPlanHits', () => {
  it('is inert under vitest without injected deps', async () => {
    expect(await semanticPlanHits('q', { limit: 5 })).toBeNull();
  });

  it('returns the query hits with the resolved mode passed through', async () => {
    const hit: PlanSemanticHit = { slug: 'p', harness: 'h', title: 'T', status: 'wip', archived: false, similarity: 0.7 };
    let gotMode = '';
    const d = deps({
      queryTopPlans: async (_v, mode) => {
        gotMode = mode;
        return [hit];
      },
    });
    expect(await semanticPlanHits('q', { limit: 5 }, d)).toEqual([hit]);
    expect(gotMode).toBe('gemma');
  });

  it('returns null on failure (never throws)', async () => {
    const d = deps({ queryTopPlans: async () => { throw new Error('boom'); } });
    expect(await semanticPlanHits('q', { limit: 5 }, d)).toBeNull();
  });
});
