/**
 * search-rrf-fusion.integration.test.ts — WI-5683 fix.
 *
 * Bug: plans:search scored lexical hits with a hand-rolled raw-TF ranker
 * (long plans that merely repeat common tokens win on raw count) and only
 * ever APPENDED up to 3 semantic-embedding hits AFTER the lexical results —
 * so a plan that is a topically-exact match but whose lexical score is
 * low/zero (or that fell outside the ILIKE candidate prefilter) landed dead
 * last, or was silently dropped from a `limit`-capped page entirely.
 *
 * Fix: fuse the lexical ranking with the semantic ranking via Reciprocal
 * Rank Fusion (@papercusp/rrf, the same mechanism search:semantic already
 * uses) — combining by RANK POSITION, not raw score, so a plan that ranks
 * #1 semantically can't be buried behind plans that only win on raw term
 * frequency.
 *
 * `semanticPlanHits` is inert under vitest without injected deps (by
 * design — the real resolver lazy-loads an ONNX model, WI-3792's load-scar
 * class) and `plans/search.ts` calls it with no deps override, so these
 * tests mock the `../semantic-dedup` module directly to drive the RRF
 * fusion path through the real tool handler, against real PG-backed
 * lexical scoring (mirrors search-slug.integration.test.ts's fixture).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';
import searchTool from '../search';

// vi.mock factories are hoisted above imports, so the mock fn must be too
// (vi.hoisted) — a plain outer-scope const would throw "cannot access before
// initialization" at hoist time.
const { semanticPlanHits } = vi.hoisted(() => ({ semanticPlanHits: vi.fn() }));
vi.mock('../semantic-dedup', () => ({ semanticPlanHits }));

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-search-rrf-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;

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
  matches: Array<{ scope: string; snippet: string }>;
}

async function runSearch(query: string, args: Record<string, unknown> = {}): Promise<{ hits: Hit[]; semanticHitCount?: number }> {
  const ctx = { metadata: () => {}, log: () => {}, progress: () => {} } as never;
  const res = (await searchTool.handler({ query, harness: HARNESS, semantic: true, ...args } as never, ctx)) as {
    content: { text: string }[];
  };
  return JSON.parse(res.content[0].text) as { hits: Hit[]; semanticHitCount?: number };
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

afterEach(() => {
  semanticPlanHits.mockReset();
});

describe('plans:search RRF fusion (WI-5683)', () => {
  it('a plan found ONLY via the semantic leg (rank #1 there) is not buried behind lexical noise', async () => {
    semanticPlanHits.mockResolvedValue([
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
    semanticPlanHits.mockResolvedValue([
      { slug: SLUG_N1, harness: HARNESS, title: 'Gadget noise one', status: 'active', archived: false, similarity: 0.5 },
    ]);
    const { hits } = await runSearch('gadget');
    const n1 = hits.find((h) => h.plan === SLUG_N1);
    expect(n1).toBeTruthy();
    expect(n1?.semantic).toBeUndefined();
    expect(n1?.similarity).toBe(0.5);
    expect(n1?.matches.some((m) => m.scope === 'now')).toBe(true);
  });

  it('fails open to lexical-only ranking when the semantic leg throws', async () => {
    semanticPlanHits.mockRejectedValue(new Error('embedder unavailable'));
    const { hits } = await runSearch('gadget');
    expect(hits.map((h) => h.plan)).toEqual([SLUG_N1, SLUG_N2, SLUG_N3]);
    expect(hits.every((h) => h.semantic === undefined)).toBe(true);
  });

  it('fails open to lexical-only ranking when the semantic leg returns null', async () => {
    semanticPlanHits.mockResolvedValue(null);
    const { hits } = await runSearch('gadget');
    expect(hits.map((h) => h.plan)).toEqual([SLUG_N1, SLUG_N2, SLUG_N3]);
  });
});
