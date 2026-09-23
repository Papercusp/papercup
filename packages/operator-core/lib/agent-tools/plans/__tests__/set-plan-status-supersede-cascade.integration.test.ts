/**
 * set-plan-status-supersede-cascade.integration.test.ts — review-system-rework-reduction-2026-09-23
 * P-030 (spec RSR-P-030-A), driven through the REAL plans:set-plan-status handler and Postgres.
 *
 * Probe (from the spec's falsifier): supersede a plan with an open carrier item in another plan,
 * then read the carrier's claimability and the carrier plan's readiness. Before P-030 the
 * carrier stayed claimable (it drew 1,840 calls on 09-21/22 after its subject was superseded)
 * and nothing re-evaluated the carrier plan's readiness.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/set-plan-status-supersede-cascade.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setPlanStatusTool from '../set-plan-status';
import { MOOT_CARRIER_NOW_MARK } from '../plan-scope-cascade';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-sps-cascade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUBJECT = 'zzz-cascade-subject-2026-09-23';
const CARRIER_PLAN = 'zzz-cascade-carrier-2026-09-23';
const WS = DEFAULT_WORKSPACE_ID;
const CARRIER_ID = `WI-zzz-cascade-carrier-${Date.now()}`;
const UNRELATED_ID = `WI-zzz-cascade-unrelated-${Date.now()}`;

function planBody(slug: string, status: 'draft' | 'ready'): string {
  return `---
title: ${slug}
slug: ${slug}
created: 2026-09-23
updated: 2026-09-23
status: ${status}
---

# ${slug}

## Now

**State:** Author state for ${slug}.

**Next:** Author next for ${slug}.

## Background

prose
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-sps-cascade-test', workspaceId: WS },
  } as never;
}

async function insertItem(id: string, title: string, planItem: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       payload, source_plan_slug, source_plan_item_ids)
    VALUES (${HARNESS}, ${id}, 'feature', ${title}, 'open', NULL, ${WS}, 0, 0,
       '{}'::jsonb, ${CARRIER_PLAN}, ${[planItem]}::text[])`;
}

async function cleanupItems(): Promise<void> {
  await admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
}

/** The self-select floor claim_next / scheduler:get_next apply (claimHoldExclusionSql). */
async function selfSelectable(id: string): Promise<boolean> {
  const rows = await admin<{ ok: boolean }[]>`
    SELECT (COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true') AS ok
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = ${id}`;
  return rows[0]?.ok ?? false;
}

async function planContent(slug: string): Promise<string> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return rows[0]?.content ?? '';
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupItems().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupItems().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SUBJECT, planBody(SUBJECT, 'draft'));
  await seedPlan(admin, WS, HARNESS, CARRIER_PLAN, planBody(CARRIER_PLAN, 'ready'));
  await insertItem(CARRIER_ID, `Ship ${SUBJECT}: rebuild its acceptance chain`, 'P-001');
  await insertItem(UNRELATED_ID, 'Land the repair queue admission fix', 'P-002');
});

describe('plans:set-plan-status → superseded runs the P-030 scope cascade', () => {
  it('parks the moot carrier out of self-select, leaves the unrelated item claimable, and stamps readiness into the carrier plan Now', async () => {
    // Calibration: before the supersede, both items are self-selectable.
    expect(await selfSelectable(CARRIER_ID)).toBe(true);
    expect(await selfSelectable(UNRELATED_ID)).toBe(true);

    const res = (await setPlanStatusTool.handler(
      { harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never,
      makeCtx(),
    )) as { data: { results: Array<Record<string, unknown>> } };
    const out = res.data.results[0] as {
      ok: boolean;
      scopeCascade?: {
        carriers: Array<{ id: string; parked: boolean }>;
        carrierPlans: Array<{ slug: string; gate: { satisfied: boolean | null; code: string | null }; nowStamped: boolean }>;
        error?: string;
      };
    };

    expect(out.ok).toBe(true);
    expect(out.scopeCascade?.error).toBeUndefined();
    expect(out.scopeCascade?.carriers).toEqual([expect.objectContaining({ id: CARRIER_ID, parked: true })]);
    expect(await selfSelectable(CARRIER_ID)).toBe(false);
    expect(await selfSelectable(UNRELATED_ID)).toBe(true);

    // Readiness was measured in the same call and surfaced in the carrier plan's Now.
    const planRow = out.scopeCascade?.carrierPlans[0];
    expect(planRow?.slug).toBe(CARRIER_PLAN);
    expect(typeof planRow?.gate.satisfied).toBe('boolean');
    expect(planRow?.nowStamped).toBe(true);
    const carrierNow = await planContent(CARRIER_PLAN);
    expect(carrierNow).toContain(`${MOOT_CARRIER_NOW_MARK}: ${SUBJECT}`);
    expect(carrierNow).toContain(CARRIER_ID);
    expect(carrierNow).toContain(
      planRow?.gate.satisfied ? 'acceptance gate satisfied' : `acceptance gate BLOCKED: ${planRow?.gate.code}`,
    );
    expect(carrierNow).toContain(`Author next for ${CARRIER_PLAN}.`);
  });

  it('a re-application of superseded (no status change) does not cascade again', async () => {
    await setPlanStatusTool.handler({ harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never, makeCtx());
    const res = (await setPlanStatusTool.handler(
      { harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never,
      makeCtx(),
    )) as { data: { results: Array<Record<string, unknown>> } };

    expect(res.data.results[0]).not.toHaveProperty('scopeCascade');
  });
});
