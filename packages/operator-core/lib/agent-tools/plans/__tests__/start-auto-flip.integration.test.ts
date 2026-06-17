/**
 * start-auto-flip.integration.test.ts — plans:start auto-approves a draft (P2-3).
 *
 * Starting a plan IS the approval signal: a still-`draft` plan has its
 * frontmatter auto-advanced to `ready` (best-effort, inside withPlanLock), and
 * the start result reports `autoApproved: true`. start-guard.test.ts stubs
 * withPlanLock to a no-op, so it never exercises the flip — this drives the REAL
 * flip against Postgres via the shared baseline-schema fixture.
 *
 * Covers:
 *   - draft start → frontmatter reads `ready`, autoApproved:true;
 *   - re-start (now ready) → autoApproved:false, no second flip;
 *   - a non-draft (ready) start → autoApproved:false, frontmatter unchanged.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/start-auto-flip.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import startTool from '../start';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-start-flip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-start-flip-plan-2026-06-16';
const WS = DEFAULT_WORKSPACE_ID;

function planBody(status: 'draft' | 'ready'): string {
  return `---
title: Auto-Approve Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: ${status}
---

# Auto-Approve Plan

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
    principal: { kind: 'agent', slug: 'agent-start-flip-test', workspaceId: WS },
  } as never;
}

async function runStart(): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await startTool.handler({ harness: HARNESS, slug: SLUG } as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: res.isError === true };
}

async function frontmatterStatus(): Promise<string | null> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  const content = rows[0]?.content ?? '';
  const m = /^status:[ \t]*([A-Za-z][\w-]*)/m.exec(content.split('\n---')[0] ?? '');
  return m?.[1] ?? null;
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

describe('plans:start — draft auto-approve (P2-3)', () => {
  it('starting a DRAFT plan flips its frontmatter to ready and reports autoApproved:true', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));
    expect(await frontmatterStatus()).toBe('draft');

    const { data, isError } = await runStart();
    expect(isError).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: true, transitioned: true });

    // The real withPlanLock flip landed: the frontmatter now reads ready.
    expect(await frontmatterStatus()).toBe('ready');
  });

  it('re-starting the now-ready plan does NOT flip again (autoApproved:false)', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));
    const first = await runStart();
    expect(first.data.autoApproved).toBe(true);
    expect(await frontmatterStatus()).toBe('ready');

    const second = await runStart();
    expect(second.isError).toBe(false);
    // Already ready → expectedCurrent:'draft' makes the flip a no-op.
    expect(second.data.autoApproved).toBe(false);
    // Idempotent re-start: op_status was already started → not a transition.
    expect(second.data.transitioned).toBe(false);
    expect(await frontmatterStatus()).toBe('ready');
  });

  it('starting a plan that is ALREADY ready does not auto-approve', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('ready'));
    expect(await frontmatterStatus()).toBe('ready');

    const { data, isError } = await runStart();
    expect(isError).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: false, transitioned: true });
    // Frontmatter untouched — it was never a draft.
    expect(await frontmatterStatus()).toBe('ready');
  });
});
