/**
 * search-rrf-fusion.integration.test.ts — WI-5683's ranking contract, now
 * enforced through the engine (P-016 / D-025 of
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * Bug (WI-5683): plans:search scored lexical hits with a hand-rolled raw-TF
 * ranker (long plans that merely repeat common tokens win on raw count) and
 * only ever APPENDED up to 3 semantic-embedding hits AFTER the lexical
 * results — so a plan that is a topically-exact match but whose lexical score
 * is low/zero (or that fell outside the ILIKE candidate prefilter) landed dead
 * last, or was silently dropped from a `limit`-capped page entirely.
 *
 * Fix: fuse by Reciprocal Rank Fusion — combining by RANK POSITION, not raw
 * score, so a plan that ranks #1 semantically can't be buried behind plans
 * that only win on raw term frequency.
 *
 * P-016 moved that fusion from a local `rrfCombine` call into
 * `runHybridSearch`. These assertions are UNCHANGED across that move on
 * purpose: the engine calls the same `rrfCombine` with the same
 * `RRF_K_DEFAULT`, so the migration must be a de-duplication, not a re-ranking.
 * A diff in this file would have meant ranking moved.
 *
 * ⚠ WHAT THIS FILE STRUCTURALLY CANNOT TEST: the P-017 floor. The mocked
 * embedder below is not stamped in `embedder.ts`'s WeakMap, so no floor
 * resolves for it — exactly as D-024 describes. Floor provenance is asserted by
 * identity in plans-search-embedder-identity.test.ts, which is the only place
 * it CAN be. Do not add a floor assertion here; it would pass either way.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';
import searchTool from '../search';

// vi.mock factories are hoisted above imports, so the mocks must be too
// (vi.hoisted) — a plain outer-scope const would throw "cannot access before
// initialization" at hoist time.
const { resolveEmbedderMock, queryTopPlans } = vi.hoisted(() => ({
  resolveEmbedderMock: vi.fn(),
  queryTopPlans: vi.fn(),
}));

// `importOriginal`, NOT a wholesale factory (the WI-7262 class D-021 fixed in
// search-tools.test.ts): a wholesale stub would drop `realPlanSearchDeps` and
// every other export, and — worse — would replace the REAL `planEmbeddingRanker`
// with a fake, so this file would stop testing the code it exists to test. Only
// the two seams that reach an ONNX model and PG are overridden; the ranker's
// own logic (Listing shape, sink hydration) runs for real.
vi.mock('../semantic-leg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../semantic-leg')>();
  return {
    ...actual,
    resolvePlansEmbedder: resolveEmbedderMock,
    // The forwarded params are DERIVED from the real signature, never restated.
    // This wrapper only passes them through, so a hand-written type here is a
    // second source of truth that drifts silently: `sink: (h: never) => void`
    // was exactly that — a function taking `never` cannot accept a
    // PlanSemanticHit, so it stopped being assignable (TS2345) and left this
    // file red. Deriving also retires the `opts as never` cast, which was
    // disabling checking on that argument rather than satisfying it.
    planEmbeddingRanker: (
      sourceKey: string,
      mode: string,
      opts: Parameters<typeof actual.planEmbeddingRanker>[2],
      sink: Parameters<typeof actual.planEmbeddingRanker>[3],
    ) =>
      actual.planEmbeddingRanker(sourceKey, mode, opts, sink, {
        resolveEmbedder: async () => null, // unused by the ranker itself
        queryTopPlans: queryTopPlans as never,
      }),
  };
});

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-search-rrf-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;
const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

function noisePlan(title: string, slug: string, repeats: number): string {
  return `---
title: ${title}
slug: ${slug}
created: 2026-07-20
updated: 2026-07-20
status: active
---

# ${title}

## Now

**State:** ${'gadget '.repeat(repeats)}rollout continues.

**Next:** Ship it.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

interface Hit {
  plan: string;
  score: number;
  semantic?: true;
  similarity?: number;
  matchedSection?: string;
  matches: Array<{ scope: string; snippet: string }>;
}

interface Legs {
  degraded: boolean;
  warning?: string;
  semantic?: { status?: string; blocked?: string };
}

async function runSearch(
  query: string,
  args: Record<string, unknown> = {},
): Promise<{ hits: Hit[]; semanticHitCount?: number; legs: Legs }> {
  const ctx = { metadata: () => {}, log: () => {}, progress: () => {} } as never;
  const res = (await searchTool.handler({ query, harness: HARNESS, semantic: true, ...args } as never, ctx)) as {
    content: { text: string }[];
  };
  return JSON.parse(res.content[0].text) as { hits: Hit[]; semanticHitCount?: number; legs: Legs };
}

const SLUG_N1 = 'zzz-gadget-noise-one';
const SLUG_N2 = 'zzz-gadget-noise-two';
const SLUG_N3 = 'zzz-gadget-noise-three';
const BURIED_SLUG = 'zzz-topically-exact-not-in-db';

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  // Descending raw term-frequency: N1 scores highest lexically, N3 lowest —
  // none of them mention the buried plan's topic at all.
  await seedPlan(admin, WS, HARNESS, SLUG_N1, noisePlan('Gadget noise one', SLUG_N1, 30));
  await seedPlan(admin, WS, HARNESS, SLUG_N2, noisePlan('Gadget noise two', SLUG_N2, 20));
  await seedPlan(admin, WS, HARNESS, SLUG_N3, noisePlan('Gadget noise three', SLUG_N3, 10));
}, 180_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
  `.catch(() => {});
  await fx?.dispose();
});

beforeEach(() => {
  // Healthy default: a resolved embedder in the active space.
  resolveEmbedderMock.mockResolvedValue({ embedder: async () => VEC, embeddingMode: 'gemma' });
  queryTopPlans.mockResolvedValue([]);
});

afterEach(() => {
  resolveEmbedderMock.mockReset();
  queryTopPlans.mockReset();
});

describe('plans:search RRF fusion (WI-5683)', () => {
  it('a plan found ONLY via the semantic leg (rank #1 there) is not buried behind lexical noise', async () => {
    queryTopPlans.mockResolvedValue([
      { slug: BURIED_SLUG, harness: HARNESS, title: 'The exact topic plan', status: 'active', archived: false, similarity: 0.93 },
    ]);
    const { hits } = await runSearch('gadget');
    const buriedIdx = hits.findIndex((h) => h.plan === BURIED_SLUG);
    expect(buriedIdx, 'buried plan must be present').toBeGreaterThanOrEqual(0);
    // Pre-fix it was appended after EVERY lexical hit (dead last); post-fix
    // its semantic rank-#1 RRF contribution ties/beats every lexical entry
    // beyond rank #1, so it must land ahead of at least the #2 and #3 noise
    // plans — never last among 4 results.
    expect(buriedIdx).toBeLessThan(hits.length - 1);
    expect(hits.some((h) => h.plan === SLUG_N3)).toBe(true);
    expect(buriedIdx).toBeLessThan(hits.findIndex((h) => h.plan === SLUG_N3));

    const buried = hits[buriedIdx];
    expect(buried.semantic).toBe(true);
    expect(buried.similarity).toBe(0.93);
  });

  it('a plan found by BOTH legs keeps its lexical matches and is not marked semantic-only', async () => {
    queryTopPlans.mockResolvedValue([
      { slug: SLUG_N1, harness: HARNESS, title: 'Gadget noise one', status: 'active', archived: false, similarity: 0.5 },
    ]);
    const { hits } = await runSearch('gadget');
    const n1 = hits.find((h) => h.plan === SLUG_N1);
    expect(n1).toBeTruthy();
    expect(n1?.semantic).toBeUndefined();
    expect(n1?.similarity).toBe(0.5);
    expect(n1?.matches.some((m) => m.scope === 'now')).toBe(true);
  });

  it('a chunk match\'s section rides through fusion onto the hit, and only onto that hit (P-009)', async () => {
    queryTopPlans.mockResolvedValue([
      { slug: BURIED_SLUG, harness: HARNESS, title: 'The exact topic plan', status: 'active', archived: false, similarity: 0.91, matchedSection: 'D-014 Plans window split' },
      { slug: SLUG_N1, harness: HARNESS, title: 'Gadget noise one', status: 'active', archived: false, similarity: 0.5 },
    ]);
    const { hits } = await runSearch('gadget');
    expect(hits.find((h) => h.plan === BURIED_SLUG)?.matchedSection).toBe('D-014 Plans window split');
    // A plan whose own vector matched (no section) and a lexical-only plan carry none.
    expect(hits.find((h) => h.plan === SLUG_N1)?.matchedSection).toBeUndefined();
    expect(hits.find((h) => h.plan === SLUG_N2)?.matchedSection).toBeUndefined();
  });

  it('fails open to lexical-only ranking when the semantic leg throws', async () => {
    queryTopPlans.mockRejectedValue(new Error('harness_plans read failed'));
    const { hits } = await runSearch('gadget');
    expect(hits.map((h) => h.plan)).toEqual([SLUG_N1, SLUG_N2, SLUG_N3]);
    expect(hits.every((h) => h.semantic === undefined)).toBe(true);
  });
});

/**
 * D-023's CALIBRATION PAIR at the TOOL level. These two cases are each other's
 * control and differ in ONE input: whether the semantic leg was WANTED.
 *
 * Both produce the identical lexical-only ranking, which is exactly why the
 * old code could conflate them — `semanticPlanHits` returned a bare `null` for
 * both, so a DEAD embedder was indistinguishable from `semantic:false`. The
 * only thing that separates them is what the surface SAYS.
 *
 * Collapse the caller to always-null and the blocked case fails; make it
 * always-blocked and the not-run case fails. Neither can go green by accident.
 */
describe('plans:search reports WHY a search was lexical-only (D-023)', () => {
  it('semantic:false is NOT degraded — an intentionally lexical-only search is healthy', async () => {
    const { hits, legs } = await runSearch('gadget', { semantic: false });
    expect(hits.map((h) => h.plan)).toEqual([SLUG_N1, SLUG_N2, SLUG_N3]);
    expect(legs.degraded).toBe(false);
    expect(legs.semantic?.status).toBe('not-run');
    // The embedder must never even be resolved when the leg was not wanted.
    expect(resolveEmbedderMock).not.toHaveBeenCalled();
  });

  it('a WANTED-but-dead embedder yields the SAME ranking but reports degraded/blocked', async () => {
    resolveEmbedderMock.mockResolvedValue({
      embedder: async () => { throw new Error('no query embedder resolved (unavailable or disabled)'); },
      embeddingMode: null,
    });
    const { hits, legs } = await runSearch('gadget');
    // Identical hits to the not-run case above — the ranking cannot tell you
    // anything, which is the entire point of the leg report.
    expect(hits.map((h) => h.plan)).toEqual([SLUG_N1, SLUG_N2, SLUG_N3]);
    expect(legs.degraded).toBe(true);
    expect(legs.semantic?.blocked).toMatch(/no query embedder resolved/);
  });
});
