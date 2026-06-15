/**
 * search-slug.integration.test.ts — the F-FIX-028/029 fix: `plans:search` must
 * find a plan by its OWN slug (or a slug fragment), not only plans that mention
 * it elsewhere.
 *
 * Root cause this guards against: a plan's PG `plan_slug` is not part of what the
 * scorer sees (the parser strips frontmatter from `prose`), AND the tokenizer
 * keeps hyphens — so a query token like `frobnicate` / a multi-segment slug never
 * token-equals anything in the scored scopes (title/now/items/decisions/prose).
 * Pre-fix, searching a plan's slug returned every OTHER plan that referenced the
 * slug in prose, but never the plan whose slug it is.
 *
 * Two coordinated arms are asserted:
 *   1. Scoring (search.ts) — a new `slug` scope scores a SUBSTRING match against
 *      the PG slug. Driven through the real tool handler.
 *   2. Prefilter (source.ts listPlanRowsMatchingAnyToken) — the candidate SELECT
 *      now also matches `plan_slug ILIKE`, so a plan whose ONLY token hit is its
 *      slug (frontmatter slug absent from content) still becomes a candidate.
 *
 * Self-contained PG via setupPlanPgFixture() (the integration-tier baseline DB),
 * wired exactly like source-archived.integration.test.ts / edit-handler.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import searchTool from '../search';
import { listPlanRowsMatchingAnyToken } from '../source';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-search-slug-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;

// Plan A — the faithful repro. The token `frobnicate` lives in the slug (and,
// realistically, the frontmatter `slug:` line) but in NO scored scope: the
// title/now/prose deliberately avoid it. Pre-fix this scored 0 and was absent.
const SLUG_A = 'zzz-frobnicate-widget-2026-06-14';
function planA(): string {
  return `---
title: Widget rollout plan
slug: ${SLUG_A}
created: 2026-06-14
updated: 2026-06-14
status: active
---

# Widget rollout plan

## Now

**State:** The rollout proceeds in two stages.

**Next:** Ship stage one.

## Decisions
`;
}

// Plan B — regression control. Its prose carries a distinctive token so a normal
// content search must still find it (the slug scope did not displace content).
const SLUG_B = 'zzz-content-plan-2026-06-14';
function planB(): string {
  return `---
title: Content control plan
slug: ${SLUG_B}
created: 2026-06-14
updated: 2026-06-14
status: active
---

# Content control plan

## Now

**State:** The zarquon subsystem hums along nicely.

**Next:** Keep it humming.

## Decisions
`;
}

// Plan C — the prefilter defensive arm. NO frontmatter slug line and a body that
// never contains the token, so `glorptastic` exists ONLY in the PG plan_slug.
// Only the `OR plan_slug ILIKE` arm can surface it as a candidate.
const SLUG_C = 'zzz-glorptastic-2026-06-14';
function planC(): string {
  return `---
title: Plain sample plan
created: 2026-06-14
updated: 2026-06-14
status: active
---

# Plain sample plan

## Now

**State:** Nothing remarkable here.

**Next:** Nothing pending.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

interface Hit {
  plan: string;
  score: number;
  matches: Array<{ scope: string; snippet: string }>;
}

async function runSearch(query: string): Promise<Hit[]> {
  const ctx = { metadata: () => {}, log: () => {}, progress: () => {} } as never;
  const res = (await searchTool.handler({ query, harness: HARNESS } as never, ctx)) as {
    content: { text: string }[];
  };
  return (JSON.parse(res.content[0].text) as { hits: Hit[] }).hits;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, WS, HARNESS, SLUG_A, planA());
  await seedPlan(admin, WS, HARNESS, SLUG_B, planB());
  await seedPlan(admin, WS, HARNESS, SLUG_C, planC());
}, 180_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
  `.catch(() => {});
  await fx?.dispose();
});

describe('plans:search slug scope (F-FIX-028/029)', () => {
  it('finds a plan by a slug fragment present in NO scored scope', async () => {
    const hits = await runSearch('frobnicate');
    const a = hits.find((h) => h.plan === SLUG_A);
    expect(a, 'plan A must surface when searching its slug fragment').toBeTruthy();
    // The match is attributed to the slug scope (not title/now/prose).
    expect(a?.matches.some((m) => m.scope === 'slug' && m.snippet === SLUG_A)).toBe(true);
  });

  it('finds a plan by its full exact slug', async () => {
    const hits = await runSearch(SLUG_A);
    expect(hits.some((h) => h.plan === SLUG_A)).toBe(true);
  });

  it('does NOT slug-match a bare-numeric token (date-stamp flood guard)', async () => {
    // Every seeded slug carries `-2026-06-14`; a bare `2026` query must NOT
    // surface them via the slug scope (none mention 2026 in a scored scope).
    const hits = await runSearch('2026');
    expect(hits.some((h) => h.plan === SLUG_A)).toBe(false);
    expect(hits.some((h) => h.plan === SLUG_C)).toBe(false);
  });

  it('regression: a content-only token still matches via prose', async () => {
    const hits = await runSearch('zarquon');
    expect(hits.some((h) => h.plan === SLUG_B)).toBe(true);
    // The slug scope did not spuriously also surface plan A/C.
    expect(hits.some((h) => h.plan === SLUG_A)).toBe(false);
  });
});

describe('listPlanRowsMatchingAnyToken slug prefilter arm (source.ts)', () => {
  it('admits a plan whose only token hit is its plan_slug (not its content)', async () => {
    const { rows } = await listPlanRowsMatchingAnyToken(['glorptastic'], {
      harnessSlug: HARNESS,
      workspaceId: WS,
      includeArchived: true,
    });
    expect(rows.map((r) => r.planSlug)).toContain(SLUG_C);
  });

  it('still admits a plain content match (regression)', async () => {
    const { rows } = await listPlanRowsMatchingAnyToken(['zarquon'], {
      harnessSlug: HARNESS,
      workspaceId: WS,
      includeArchived: true,
    });
    expect(rows.map((r) => r.planSlug)).toContain(SLUG_B);
  });
});
