/**
 * source-archived.integration.test.ts — the PG-read filter + cross-harness
 * isolation paths in source.ts (readAllPlans / listPlanRows / listPlanFiles /
 * getPlanRow) against real Postgres.
 *
 * The parse cores are covered by e2e.integration.test.ts; the gaps here are the
 * filter + scope branches:
 *
 *   - The `archived` default-filter: with one archived + one live row seeded,
 *     readAllPlans() / listPlanRows() / listPlanFiles() return only the live row
 *     by default, and { includeArchived: true } returns both.
 *   - Cross-workspace / cross-harness isolation: a plan seeded under harness A is
 *     invisible to a read scoped to harness B — getPlanRow → null, listPlanRows /
 *     listPlanFiles → empty (no cross-harness leak).
 *
 * Archived rows are seeded directly (admin) because seedPlan() always inserts
 * archived=false.
 *
 * Self-contained PG (own container + real migrations), wired exactly like the
 * edit-handler integration test so the file runs from operator-core's own config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { readAllPlans, listPlanRows, listPlanFiles, getPlanRow } from '../source';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import {
  setupPlanPgFixture,
  seedPlan,
  registerHarnessProject,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS_A = `zzz-arch-a-${STAMP}`;
const HARNESS_B = `zzz-arch-b-${STAMP}`;
const LIVE_SLUG = 'zzz-live-plan-2026-06-04';
const ARCHIVED_SLUG = 'zzz-archived-plan-2026-06-04';
const WS = DEFAULT_WORKSPACE_ID;

function planBody(slug: string): string {
  return `---
title: ${slug}
slug: ${slug}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# ${slug}

## Now

**State:** seeded.

**Next:** read it back.

## Decisions
`;
}

/** Seed a row with an explicit archived flag (seedPlan only seeds archived=false). */
async function seedArchived(harnessSlug: string, slug: string, content: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, archived, origin)
    VALUES
      (${WS}, ${harnessSlug}, ${slug}, ${content}, md5(${content}), 1, true, 'local')
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE
      SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, archived = true
  `;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;

  // Harness A: one live + one archived plan.
  await seedPlan(admin, WS, HARNESS_A, LIVE_SLUG, planBody(LIVE_SLUG));
  await seedArchived(HARNESS_A, ARCHIVED_SLUG, planBody(ARCHIVED_SLUG));
  // Harness B: REGISTERED (its own Hive home — resolvePlanScope is Hive-scoped
  // post-WI-1992 and THROWS for an unregistered slug) but deliberately left
  // empty of plans — the isolation control: reads under B must return
  // null/empty, never leak A's rows.
  await registerHarnessProject(admin, WS, HARNESS_B);
}, 180_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug IN (${HARNESS_A}, ${HARNESS_B})
  `.catch(() => {});
  // Drop the synthetic Hive-home identities registerHarnessProject/seedPlan
  // seeded (the baseline DB is shared by the whole run — leave no trace).
  await admin`
    DELETE FROM harness_shared.hives
     WHERE workspace_id = ${WS} AND home_slug IN (${HARNESS_A}, ${HARNESS_B})
  `.catch(() => {});
  await fx?.dispose();
});

describe('source.ts archived filter (harness A: 1 live + 1 archived)', () => {
  const optsA = { harnessSlug: HARNESS_A, workspaceId: WS };

  it('readAllPlans() returns only the live plan by default', async () => {
    const all = await readAllPlans(optsA);
    const slugs = all.map((r) => r.row.planSlug).sort();
    expect(slugs).toEqual([LIVE_SLUG]);
    expect(all.every((r) => r.archived === false)).toBe(true);
  });

  it('readAllPlans({ includeArchived: true }) returns both', async () => {
    const all = await readAllPlans({ ...optsA, includeArchived: true });
    const slugs = all.map((r) => r.row.planSlug).sort();
    expect(slugs).toEqual([ARCHIVED_SLUG, LIVE_SLUG].sort());
    expect(all.find((r) => r.row.planSlug === ARCHIVED_SLUG)?.archived).toBe(true);
  });

  it('listPlanRows() / listPlanFiles() apply the same default-live filter', async () => {
    const liveRows = await listPlanRows(optsA);
    expect(liveRows.map((r) => r.planSlug)).toEqual([LIVE_SLUG]);

    const allRows = await listPlanRows({ ...optsA, includeArchived: true });
    expect(allRows.map((r) => r.planSlug).sort()).toEqual([ARCHIVED_SLUG, LIVE_SLUG].sort());

    const liveFiles = await listPlanFiles(optsA);
    expect(liveFiles.map((e) => e.slug)).toEqual([LIVE_SLUG]);

    const allFiles = await listPlanFiles({ ...optsA, includeArchived: true });
    expect(allFiles.map((e) => e.slug).sort()).toEqual([ARCHIVED_SLUG, LIVE_SLUG].sort());
    // The archived entry carries the archived flag through.
    expect(allFiles.find((e) => e.slug === ARCHIVED_SLUG)?.archived).toBe(true);
  });
});

describe('source.ts cross-harness isolation (harness B is empty — no leak from A)', () => {
  const optsB = { harnessSlug: HARNESS_B, workspaceId: WS };

  it('getPlanRow under harness B → null for A-seeded slugs (even with includeArchived)', async () => {
    expect(await getPlanRow(LIVE_SLUG, optsB)).toBeNull();
    expect(await getPlanRow(ARCHIVED_SLUG, optsB)).toBeNull();
  });

  it('listPlanRows / listPlanFiles under harness B return empty', async () => {
    expect(await listPlanRows(optsB)).toEqual([]);
    expect(await listPlanRows({ ...optsB, includeArchived: true })).toEqual([]);
    expect(await listPlanFiles(optsB)).toEqual([]);
    expect(await readAllPlans(optsB)).toEqual([]);
  });

  it('the same slug IS readable under harness A (control — proves the row exists)', async () => {
    const row = await getPlanRow(LIVE_SLUG, { harnessSlug: HARNESS_A, workspaceId: WS });
    expect(row).not.toBeNull();
    expect(row?.harnessSlug).toBe(HARNESS_A);
  });
});
