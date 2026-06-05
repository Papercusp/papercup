/**
 * set-content-terminal-status.integration.test.ts — the cross-store side-effect
 * of the plans:set-content HANDLER when a whole-document write flips the plan's
 * frontmatter `status:` to a TERMINAL value.
 *
 * The pure decision core (evaluateSetContent) and the CAS/lint envelope are
 * covered elsewhere; the gap is the handler's post-write reconciliation:
 *
 *     if (isTerminalPlanStatus(parsePlan(content).frontmatter.status)) {
 *       await clearStartedForTerminalPlan(harnessSlug, slug);  // op_status → 'done'
 *     }
 *
 * Invariant (plan-start-state.ts): a plan that is operationally `started`/
 * `paused` must NEVER also be at a terminal lifecycle status. So a set-content
 * write that lands `status: superseded` (or `shipped`) must clear the started
 * op-row to 'done'; a NON-terminal write (`status: active`) must leave a started
 * row untouched.
 *
 * Drives the REAL handler through Postgres via withPlanLock + the shared
 * baseline-schema fixture (setupPlanPgFixture / inject('baselineSchemaDsn')),
 * mirroring edit-handler.integration's spine but using the injected baseline DB
 * rather than a self-stood container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setContentTool from '../set-content';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-setc-term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-setc-term-plan-2026-06-04';
const WS = DEFAULT_WORKSPACE_ID;

/** A minimal non-legacy plan that lints clean, at the given lifecycle status. */
function planBody(status: 'active' | 'superseded' | 'shipped'): string {
  return `---
title: Terminal Side-Effect Plan
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: ${status}
---

# Terminal Side-Effect Plan

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

/** Build a ctx with a resolvable principal so the write is attributable. */
function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-setc-term-test', workspaceId: WS },
  } as never;
}

/** Run plans:set-content under the throwaway harness; parse its JSON result. */
async function runSetContent(content: string): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await setContentTool.handler(
    { harness: HARNESS, slug: SLUG, content } as never,
    makeCtx(),
  )) as { content: { text: string }[]; isError?: boolean };
  return { data: JSON.parse(res.content[0].text), isError: res.isError === true };
}

/** Seed the plan row AND mark it operationally started. */
async function seedStartedPlan(status: 'active' | 'superseded' | 'shipped'): Promise<void> {
  await seedPlan(admin, WS, HARNESS, SLUG, planBody(status));
  await admin`
    UPDATE harness_shared.harness_plans
       SET op_status = 'started', op_started_at = now(), op_updated_at = now()
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
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
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
});

describe('plans:set-content handler — terminal-status clears the started op-row', () => {
  it('writing a superseded body clears a STARTED plan to op_status=done', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetContent(planBody('superseded'));
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);

    // The cross-store side-effect ran: the started op-row was cleared.
    expect(await opStatus()).toBe('done');
  });

  it('writing a shipped body also clears a STARTED plan to done (the other terminal status)', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    const { isError } = await runSetContent(planBody('shipped'));
    expect(isError).toBe(false);

    expect(await opStatus()).toBe('done');
  });

  it('clears a PAUSED plan too (clearStartedForTerminalPlan targets started OR paused)', async () => {
    await seedStartedPlan('active');
    await admin`
      UPDATE harness_shared.harness_plans SET op_status = 'paused'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(await opStatus()).toBe('paused');

    const { isError } = await runSetContent(planBody('superseded'));
    expect(isError).toBe(false);

    expect(await opStatus()).toBe('done');
  });
});

describe('plans:set-content handler — non-terminal write leaves the started op-row', () => {
  it('rewriting prose while staying active does NOT clear a started plan', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    // A real prose change (so it is not a no-op), still status: active.
    const next = planBody('active').replace('Some prose for the body.', 'Revised prose for the body.');
    const { data, isError } = await runSetContent(next);
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);

    // No terminal status → the started op-row is untouched.
    expect(await opStatus()).toBe('started');
  });
});
