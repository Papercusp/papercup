import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import {
  cleanupPlans,
  registerHarnessProject,
  seedPlan,
  setupPlanPgFixture,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = 'zzz-activation-audit-gate';
const SLUG = 'activation-gate-plan';
const DRAFT = `---
title: Activation gate
slug: ${SLUG}
status: draft
created: 2026-08-24
updated: 2026-08-24
---

# Activation gate

## Phase 1

- **P-001** \`todo\` prove the gate
`;

let fx: PlanPgFixture;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  await registerHarnessProject(fx.admin, fx.workspaceId, HARNESS);
}, 90_000);

afterAll(async () => {
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await fx.dispose();
});

beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await registerHarnessProject(fx.admin, fx.workspaceId, HARNESS);
});

async function activationAudit(sql: postgres.Sql, planSlug = SLUG) {
  await sql`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${planSlug}, 1, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       1, 1, ${'a'.repeat(64)}, '[]'::jsonb, '[]'::jsonb)`;
}

const flipReady = (body: string) => body.replace('status: draft', 'status: ready');

describe('conversation activation audit gate', () => {
  it('blocks a raw draft→ready content transition and leaves the row unchanged', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);

    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test activation gate' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({
      kind: 'applied',
      value: { ok: false, code: 'conversation_audit_required', message: expect.stringContaining("plans:audit { phase:'activation'") },
    });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    expect(rows[0]?.content).toContain('status: draft');
  });

  it('admits the same transition after an activation audit exists', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    await activationAudit(fx.admin);

    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test activation gate' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    expect(rows[0]?.content).toContain('status: ready');
  });

  it('blocks direct creation as ready but allows later cosmetic edits of an already-ready plan', async () => {
    const direct = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test direct ready' },
      async () => ({ newBody: flipReady(DRAFT), value: { ok: true } }),
    );
    expect(direct).toMatchObject({ kind: 'applied', value: { code: 'conversation_audit_required' } });

    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, flipReady(DRAFT));
    const cosmetic = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test cosmetic edit' },
      async (current) => ({ newBody: current!.replace('prove the gate', 'prove the shared gate'), value: { ok: true } }),
    );
    expect(cosmetic).toMatchObject({ kind: 'applied', value: { ok: true } });
  });
});
