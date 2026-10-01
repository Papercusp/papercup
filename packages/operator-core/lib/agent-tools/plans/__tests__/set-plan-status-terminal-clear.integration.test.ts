/**
 * set-plan-status-terminal-clear.integration.test.ts — the cross-store
 * side-effect of plans:set-plan-status when the target is a TERMINAL lifecycle
 * status, with the P1-2 focus on the terminal-NOOP path.
 *
 * Invariant (plan-start-state.ts): a plan that is operationally started/paused
 * must NEVER also be at a terminal lifecycle status (shipped/superseded). The
 * set-plan-status handler enforces this by calling clearStartedForTerminalPlan
 * after a successful terminal set.
 *
 * P1-2 bug: that clear used to live inside `if (ok && changed)`. Setting a
 * STARTED plan to a terminal status it is ALREADY at (changed:false — e.g. its
 * frontmatter was edited to `superseded` directly, leaving the op-row started)
 * skipped the clear, so a started+terminal row persisted. The fix moves the
 * clear out of the `changed` guard: it runs on every successful terminal set,
 * including the noop.
 *
 * Drives the REAL handler through Postgres via withPlanLock + the shared
 * baseline-schema fixture, mirroring set-content-terminal-status.integration.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/set-plan-status-terminal-clear.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setPlanStatusTool from '../set-plan-status';
import { getRubric, proposeRubric } from '../../../rubrics';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { runWithWorkspace } from '../../../workspace-als';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-sps-term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-sps-term-plan-2026-06-16';
const WS = DEFAULT_WORKSPACE_ID;
const RUBRIC_ID = `zzz-sps-term-acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREVIOUS_RUBRIC_ID = 'zzz-sps-term-acceptance-2026-06-16';

function planBody(status: 'draft' | 'ready' | 'superseded' | 'shipped'): string {
  return `---
title: Terminal Clear Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: ${status}
---

# Terminal Clear Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose for the body.

## Decisions
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
    principal: { kind: 'agent', slug: 'agent-sps-term-test', workspaceId: WS },
  } as never;
}

async function runSetPlanStatus(
  status: 'draft' | 'ready' | 'shipped' | 'superseded',
  expectedCurrent?: 'draft' | 'ready' | 'shipped' | 'superseded',
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await runWithWorkspace(WS, () => setPlanStatusTool.handler(
      { harness: HARNESS, slug: SLUG, status, ...(expectedCurrent ? { expectedCurrent } : {}) } as never,
      makeCtx(),
    ))) as { data: { results: Record<string, unknown>[]; counts?: { failed?: number } } };
  // Bulk-pattern envelope: per-slug result at data.results[0]; failure ⇒ counts.failed > 0.
  return { data: res.data.results[0], isError: (res.data.counts?.failed ?? 0) > 0 };
}

/** Seed the plan row at `status` AND force a started op-row — i.e. the exact
 *  invariant-violating started+terminal state when `status` is terminal. */
async function seedStartedPlan(status: 'draft' | 'ready' | 'superseded' | 'shipped'): Promise<void> {
  await seedPlan(admin, WS, HARNESS, SLUG, planBody(status));
  await admin`
    UPDATE harness_shared.harness_plans
       SET op_status = 'started', op_started_at = now(), op_updated_at = now()
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
}

async function seedAcceptanceRubric(): Promise<void> {
  const rubric = await runWithWorkspace(WS, () => proposeRubric({
    rubricId: RUBRIC_ID,
    kind: 'acceptance',
    subjectPlan: SLUG,
    subjectHarnessSlug: HARNESS,
    characteristic: 'set-plan-status-terminal-clear',
    title: 'Terminal status acceptance contract',
    criteria: [{
      key: 'terminal-outcome',
      title: 'Terminal outcome',
      driftMarkers: 'the terminal outcome regresses',
      check: { kind: 'instrument', instrumentKey: 'none' },
    }],
    by: 'agent-sps-term-test',
  }));
 expect(rubric.status).toBe('active');
  expect(await acceptanceRubricStatus()).toBe('active');
}

async function acceptanceRubricStatus(): Promise<string | undefined> {
  return (await runWithWorkspace(WS, () => getRubric(RUBRIC_ID)))?.status;
}

async function cleanupAcceptanceRubric(): Promise<void> {
  for (const rubricId of [RUBRIC_ID, PREVIOUS_RUBRIC_ID]) {
    await admin`DELETE FROM harness_shared.plan_revisions WHERE plan_slug = ${rubricId}`.catch(() => {});
    await admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = ${rubricId}`.catch(() => {});
  }
}

async function opStatus(): Promise<string | null> {
  const rows = await admin<{ op_status: string | null }[]>`
    SELECT op_status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]?.op_status ?? null;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupAcceptanceRubric().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupAcceptanceRubric().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
});

describe('plans:set-plan-status — terminal set clears the started op-row', () => {
  it('a real draft→superseded set clears STARTED state and retires its acceptance rubric', async () => {
    await seedStartedPlan('draft');
    await seedAcceptanceRubric();
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetPlanStatus('superseded');
    expect(isError).toBe(false);
    expect(await acceptanceRubricStatus()).toBe('retired');
    expect(data).toMatchObject({
      ok: true,
      changed: true,
      newStatus: 'superseded',
      acceptanceRubricRetired: RUBRIC_ID,
    });

    expect(await opStatus()).toBe('done');
    expect(await acceptanceRubricStatus()).toBe('retired');
  });

  // ── P1-2: the terminal-NOOP path ────────────────────────────────────────
  it('a terminal-NOOP (already superseded) clears the row and retires an active acceptance rubric', async () => {
    // The invariant-violating state: frontmatter already superseded, but the
    // op-row is started (e.g. a raw .md edit set the status and bypassed the
    // verb's clear). Setting status→superseded is a NOOP (changed:false).
    await seedStartedPlan('superseded');
    await seedAcceptanceRubric();
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetPlanStatus('superseded');
    expect(isError).toBe(false);
    // Success, but nothing was written — this is the noop branch.
    expect(await acceptanceRubricStatus()).toBe('retired');
    expect(data).toMatchObject({
      ok: true,
      changed: false,
      newStatus: 'superseded',
      acceptanceRubricRetired: RUBRIC_ID,
    });

    // The fix: the clear runs anyway, healing the started+terminal violation.
    expect(await opStatus()).toBe('done');
    expect(await acceptanceRubricStatus()).toBe('retired');
  });

  it('a terminal-NOOP at shipped clears a started row too (other terminal status)', async () => {
    await seedStartedPlan('shipped');
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetPlanStatus('shipped', 'shipped');
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ ok: true, changed: false });

    expect(await opStatus()).toBe('done');
  });

  it('a terminal-NOOP clears a PAUSED+terminal row as well', async () => {
    await seedStartedPlan('superseded');
    await admin`
      UPDATE harness_shared.harness_plans SET op_status = 'paused'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(await opStatus()).toBe('paused');

    const { isError } = await runSetPlanStatus('superseded');
    expect(isError).toBe(false);

    expect(await opStatus()).toBe('done');
  });

  it('a NON-terminal noop (ready→ready) leaves a started op-row untouched', async () => {
    await seedStartedPlan('ready');
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetPlanStatus('ready');
    expect(isError).toBe(false);
    expect(data).toMatchObject({ ok: true, changed: false });

    // ready is not terminal → no clear; the started plan keeps running.
    expect(await opStatus()).toBe('started');
  });
});
