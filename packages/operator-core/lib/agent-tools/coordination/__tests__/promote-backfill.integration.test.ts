/**
 * promote-backfill.integration.test.ts — WI-3972: `plans:promote apply=true`
 * back-fills the `## Promoted` block for a plan that already promoted
 * features (rows in `harness_features_consolidated` with this plan as
 * `source_plan_slug`) but has no `## Promote` policy block to derive a NEW
 * promotion from.
 *
 * Before this fix, `plans:lint`'s `missing_promoted_block` finding told the
 * caller to run exactly this — a bare `plans:promote apply=true` — and that
 * call always failed `no_promote_policy` instead: a catch-22 where the
 * tool's own suggested remedy could never succeed. This test drives the real
 * handler against real PG to pin the fix: a bare apply=true call now
 * BACK-FILLS the `## Promoted` block from the already-promoted features
 * instead of erroring, is idempotent on a second call, and the *genuinely*
 * nothing-to-do case (no policy AND no already-promoted features) still
 * returns `no_promote_policy` exactly as before.
 *
 * Same fixture as the sibling plans tool-suite integration tests: the
 * baseline-schema DB via setupPlanPgFixture() (inject('baselineSchemaDsn')).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import promoteTool from '../tools/promote';
import {
  setupPlanPgFixture,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

const PARENT_HARNESS = operatorHomeHarnessSlug();
const RUN = Math.random().toString(36).slice(2, 8);
const SLUG = `zzz-promote-backfill-${RUN}-2026-07-10`;
const EMPTY_SLUG = `zzz-promote-backfill-empty-${RUN}-2026-07-10`;

/** A plan with NO `## Promote` policy and NO `## Promoted` record block —
 *  the exact shape lint's `missing_promoted_block` flags once features
 *  exist on record for it. */
function backfillPlanContent(slug: string): string {
  return `---
title: Backfill Test
slug: ${slug}
created: 2026-05-01
updated: 2026-05-01
status: active
---

# Backfill Test

## Now

**State:** Features were promoted before the \`## Promoted\` write-back existed.

## Phase 1

- **P-001** \`done\` Foundation work (already promoted).
- **P-002** \`done\` Second item (already promoted).
`;
}

/** Same shape, but genuinely nothing was ever promoted for it — the
 *  regression guard: `no_promote_policy` must still fire here. */
function emptyPlanContent(slug: string): string {
  return `---
title: Backfill Empty Test
slug: ${slug}
created: 2026-05-01
updated: 2026-05-01
status: active
---

# Backfill Empty Test

## Now

**State:** Nothing promoted, no policy either.

## Phase 1

- **P-001** \`todo\` Not yet promoted.
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    principal: { kind: 'agent', slug: 'agent-promote-backfill-test', workspaceId: PAPERCUSP_WORKSPACE_ID },
  } as never;
}

async function runPromote(args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const res = (await promoteTool.handler(args as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: Boolean(res.isError) };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, SLUG, backfillPlanContent(SLUG));
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, EMPTY_SLUG, emptyPlanContent(EMPTY_SLUG));

  // Seed the "already promoted" features directly — as if a prior promote
  // (or an out-of-band import) minted these against this plan before the
  // `## Promoted` write-back existed / before it was captured for this slug.
  await admin`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, status, workspace_id, source_plan_slug, source_plan_item_ids, wave, feature_order)
    VALUES
      (${PARENT_HARNESS}, 'F-BACKFILL-001', 'Foundation work (already promoted)', 'todo', ${PAPERCUSP_WORKSPACE_ID}, ${SLUG}, ARRAY['P-001'], 'w1', 1),
      (${PARENT_HARNESS}, 'F-BACKFILL-002', 'Second item (already promoted)', 'todo', ${PAPERCUSP_WORKSPACE_ID}, ${SLUG}, ARRAY['P-002'], 'w1', 2)
  `;
}, 120_000);

afterAll(async () => {
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE feature_id IN ('F-BACKFILL-001', 'F-BACKFILL-002')`.catch(() => {});
  await admin`DELETE FROM harness_shared.harness_plans WHERE plan_slug IN (${SLUG}, ${EMPTY_SLUG})`.catch(() => {});
  await admin`DELETE FROM harness_shared.plan_revisions WHERE plan_slug IN (${SLUG}, ${EMPTY_SLUG})`.catch(() => {});
  await fx.dispose();
});

describe('plans:promote — WI-3972 backfill of ## Promoted (no policy, already-promoted features)', () => {
  it('preview (apply:false) reports what WOULD be backfilled, without writing anything', async () => {
    const { data, isError } = await runPromote({ slug: SLUG });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('preview');
    expect(data.backfill).toBe(true);
    expect(data.already_recorded).toBe(0);
    expect(data.would_record).toHaveLength(2);
    expect(data.would_record.join('\n')).toMatch(/F-BACKFILL-001/);
    expect(data.would_record.join('\n')).toMatch(/F-BACKFILL-002/);

    // Nothing written yet.
    const rows = await admin<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(rows[0].content).not.toMatch(/^## Promoted\b/m);
  });

  it('apply:true (bare — exactly what lint tells the caller to run) writes the ## Promoted block', async () => {
    const { data, isError } = await runPromote({ slug: SLUG, apply: true });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('backfill');
    expect(data.backfilled.count).toBe(2);
    expect(data.backfilled.feature_ids.sort()).toEqual(['F-BACKFILL-001', 'F-BACKFILL-002']);

    const rows = await admin<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${SLUG}
    `;
    const content = rows[0].content;
    expect(content).toMatch(/^## Promoted\b/m);
    expect(content).toMatch(/F-BACKFILL-001/);
    expect(content).toMatch(/F-BACKFILL-002/);
  });

  it('is idempotent — a second apply:true finds nothing new to backfill', async () => {
    const { data, isError } = await runPromote({ slug: SLUG, apply: true });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('backfill');
    expect(data.backfilled.count).toBe(0);
    expect(data.backfilled.feature_ids).toEqual([]);
  });

  it('regression guard: genuinely nothing to promote AND nothing to backfill still fails no_promote_policy', async () => {
    const { data, isError } = await runPromote({ slug: EMPTY_SLUG, apply: true });
    expect(isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_promote_policy');
  });
});
