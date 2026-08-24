import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { hashPlanContent } from '../content-hash';
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

async function appendPlanRevision(sql: postgres.Sql, body: string) {
  const contentHash = hashPlanContent(body);
  const rows = await sql<Array<{ id: number | string; seq: number }>>`
    INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
       rationale, author_kind, author_id, session_id, session_kind, created_at)
    SELECT ${fx.workspaceId}, ${HARNESS}, ${SLUG}, COALESCE(MAX(seq), 0) + 1,
           ${contentHash}, ${body}, 'activation notice regression', 'agent', 'su-test',
           'session-test', 'codex', ${Date.now()}
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    RETURNING id, seq`;
  return { id: Number(rows[0]!.id), seq: Number(rows[0]!.seq), contentHash };
}

async function activationAuditAt(
  sql: postgres.Sql,
  anchor: { id: number; seq: number; contentHash: string },
) {
  await sql`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${SLUG}, 1, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       ${anchor.id}, ${anchor.seq}, ${anchor.contentHash}, '[]'::jsonb, '[]'::jsonb)`;
}

const flipReady = (body: string) => body.replace('status: draft', 'status: ready');

const RUBRIC_DRAFT = `---
title: Rubric activation
slug: rubric-activation
status: draft
template: rubric
created: 2026-08-24
updated: 2026-08-24
---

# Rubric activation
`;

const activate = (body: string) => body.replace('status: draft', 'status: active');

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

  it('exempts a new rubric-template plan entering active without an activation audit', async () => {
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'rubric-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test rubric activation' },
      async () => ({ newBody: activate(RUBRIC_DRAFT), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'rubric-activation'`;
    expect(rows[0]?.content).toContain('status: active');
  });

  it('exempts an existing proposed rubric-template plan promoted to active', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, 'rubric-activation', RUBRIC_DRAFT);
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'rubric-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test rubric ratification' },
      async (current) => ({ newBody: activate(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'rubric-activation'`;
    expect(rows[0]?.content).toContain('status: active');
  });

  it('keeps the activation audit requirement for ordinary plans', async () => {
    await seedPlan(fx.admin, fx.workspaceId, SLUG, DRAFT);
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test ordinary activation' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({
      kind: 'applied',
      value: { ok: false, code: 'conversation_audit_required' },
    });
  });

  it('preserves the audit after cosmetic and substantive edits while surfacing exact revision/materiality guidance', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    const audited = await appendPlanRevision(fx.admin, DRAFT);
    await activationAuditAt(fx.admin, audited);

    const cosmetic = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: SLUG,
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test cosmetic post-audit edit notice',
        afterWrite: async (body) => { await appendPlanRevision(fx.admin, body); },
      },
      async (current) => ({
        newBody: current!.replace('# Activation gate', '# Activation gate '),
        value: { ok: true },
      }),
    );

    expect(cosmetic).toMatchObject({
      kind: 'applied',
      activationAudit: {
        status: 'preserved',
        auditedPlanRevision: { id: audited.id, seq: 1, contentHash: audited.contentHash },
        currentPlanRevision: { seq: 2, recorded: true },
        changedSinceAudit: true,
        revisionGap: 1,
        reAudit: {
          decision: 'editing_agent',
          notRequiredWhen: expect.arrayContaining(['spelling', 'formatting', 'cosmetic-only wording']),
        },
      },
      value: { ok: true, activationAudit: { status: 'preserved' } },
    });

    const substantive = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: SLUG,
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test substantive post-audit edit notice',
        afterWrite: async (body) => { await appendPlanRevision(fx.admin, body); },
      },
      async (current) => ({
        newBody: current!.replace('prove the gate', 'prove the gate and preserve backward compatibility'),
        value: { ok: true },
      }),
    );

    expect(substantive).toMatchObject({
      kind: 'applied',
      activationAudit: {
        auditedPlanRevision: { id: audited.id, seq: 1 },
        currentPlanRevision: { seq: 3, recorded: true },
        revisionGap: 2,
        reAudit: {
          requiredWhen: expect.arrayContaining(['requirements', 'constraints', 'acceptance criteria']),
          instruction: expect.stringContaining("Re-run plans:audit { phase:'activation' }"),
        },
      },
    });

    const auditRows = await fx.admin<Array<{ n: number; audited_seq: number }>>`
      SELECT count(*)::int AS n, max(audited_plan_revision_seq)::int AS audited_seq
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${SLUG} AND audit_kind = 'activation'`;
    expect(auditRows).toEqual([{ n: 1, audited_seq: 1 }]);
  });
});
