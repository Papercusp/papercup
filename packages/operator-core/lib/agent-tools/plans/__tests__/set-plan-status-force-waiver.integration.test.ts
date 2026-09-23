/**
 * set-plan-status-force-waiver.integration.test.ts — the public lifecycle
 * handler carries the narrow BAR proof waiver into its acceptance evaluator
 * and persists the owner-attributed forcedPast record with the shipped plan.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const mocks = vi.hoisted(() => ({ evaluatePlanAcceptanceGate: vi.fn() }));
vi.mock('../../../plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: mocks.evaluatePlanAcceptanceGate,
}));

import setPlanStatusTool from '../set-plan-status';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-sps-force-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-sps-force-plan-2026-09-23';
const WS = DEFAULT_WORKSPACE_ID;
const ACTOR = 'agent-status-force-test';
const REASON = 'Owner ordered shipment; only BAR proof metadata is stale.';
const WAIVED_CHECK = 'bar_snapshot_proof_stale';

function planBody(): string {
  return `---
title: Force Waiver Plan
slug: ${SLUG}
created: 2026-09-23
updated: 2026-09-23
status: active
---

# Force Waiver Plan

## Now

**State:** The implementation is complete and verified.

**Next:** Prepare the accepted release.

## Background

This plan has a complete implementation record.

## Decisions
`;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: ACTOR, workspaceId: WS },
  } as never;
}

async function runStatus(force: Record<string, unknown>) {
  const res = (await setPlanStatusTool.handler({
    harness: HARNESS,
    slug: SLUG,
    status: 'shipped',
    force,
  } as never, makeCtx())) as {
    data: { results: Record<string, unknown>[]; counts?: { failed?: number } };
  };
  return {
    data: res.data.results[0]!,
    isError: (res.data.counts?.failed ?? 0) > 0,
  };
}

async function storedPlan(): Promise<{ content: string; forced_past: Record<string, unknown> | null }> {
  const rows = await admin<{ content: string; forced_past: Record<string, unknown> | null }[]>`
    SELECT content, forced_past
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]!;
}

async function revisionCount(): Promise<number> {
  const rows = await admin<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM harness_shared.plan_revisions
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return Number(rows[0]?.count ?? 0);
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SLUG, planBody());
  mocks.evaluatePlanAcceptanceGate.mockImplementation(async (_slug, opts) => {
    const force = (opts as { force?: { reason?: string; acceptanceBarProofMetadata?: boolean } }).force;
    if (force?.acceptanceBarProofMetadata !== true) {
      return {
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        message: 'BAR proof metadata needs the explicit narrow waiver.',
      };
    }
    return {
      satisfied: true,
      forcedPast: { reason: force.reason, checks: [WAIVED_CHECK] },
    };
  });
});

describe('plans:set-plan-status — narrow BAR proof metadata force through the real handler', () => {
  it('keeps a generic force reason blocked and makes no plan write', async () => {
    const before = await storedPlan();

    const { data, isError } = await runStatus({ reason: REASON });

    expect(isError).toBe(true);
    expect(data).toMatchObject({ ok: false, error: 'acceptance_bar_contract_not_ready' });
    expect(await storedPlan()).toEqual(before);
    expect(await revisionCount()).toBe(0);
  });

  it('threads the metadata-only waiver through, then persists its reason and caller attribution', async () => {
    const { data, isError } = await runStatus({
      reason: REASON,
      acceptanceBarProofMetadata: true,
    });

    expect(isError).toBe(false);
    expect(data).toMatchObject({ ok: true, changed: true, newStatus: 'shipped' });

    const saved = await storedPlan();
    expect(saved.content).toContain('status: shipped');
    expect(saved.forced_past).toMatchObject({
      count: 1,
      latest: {
        reason: REASON,
        checks: [WAIVED_CHECK],
        legacy: false,
        forcedBy: { ownerId: ACTOR },
      },
    });
    expect((saved.forced_past?.latest as Record<string, unknown>).forcedAt).toEqual(expect.any(String));
    expect(await revisionCount()).toBe(1);
  });
});
