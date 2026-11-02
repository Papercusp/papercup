import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { hashPlanContent } from './content-hash';

const gates = vi.hoisted(() => ({ blocker: '', unavailable: false }));
const connection = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => db.sql.begin(tx => fn(tx)),
}));
// Policy readers have their own maintained suites. Control their verdicts here;
// the canonical writer, scoped SQL, revision insert, trigger, native guard and GC
// remain real so a ready verdict alone cannot manufacture a start receipt.
vi.mock('./plan-activation-gate', () => ({ evaluateConversationActivationGate: async () => {
  if (gates.unavailable) throw new Error('policy reader unavailable');
  return { satisfied: gates.blocker !== 'conversation_audit_required', grandfathered: true,
    code: 'conversation_audit_required' };
} }));
vi.mock('./plan-start-gate', () => ({ checkPlanStartable: async () => gates.blocker === 'initial_change_scope_missing'
  ? { ok: false, refusal: { code: gates.blocker } } : { ok: true } }));
vi.mock('./plan-spec-quality-gate', () => ({ evaluatePlanSpecQualityGate: async () => ({
  satisfied: gates.blocker !== 'spec_quality_not_current', applicable: true, mode: 'enforced', code: 'spec_quality_not_current',
}) }));
vi.mock('./plan-start-critique-gate', () => ({ evaluatePlanStartBarCritique: async () => ({
  mode: 'enforced', verdict: { satisfied: gates.blocker !== 'critique_missing', code: 'critique_missing' },
}) }));
vi.mock('../../acceptance-bar-lifecycle-evaluator', () => ({ readAndEvaluateAcceptanceBarLifecycle: async () => ({
  satisfied: gates.blocker !== 'bar_contract_not_ready', codes: ['bar_contract_not_ready'],
}) }));
vi.mock('../../plan-types/pins', () => ({ withPinnedPlanTypes: async (_scope: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('./plan-admission-gate', () => ({ checkPlanAdmission: async () => gates.blocker === 'governance_refused'
  ? { admitted: false, refusal: { code: gates.blocker } } : { admitted: true } }));
vi.mock('./source', async original => ({
  ...(await original<typeof import('./source')>()),
  getPlanRow: async () => {
    const rows = await db.sql<{ content: string; content_hash: string }[]>`
      SELECT content,content_hash FROM harness_shared.harness_plans WHERE workspace_id='execution-ws' AND harness_slug='project' AND plan_slug='feature'`;
    return rows[0] ? { content: rows[0].content, contentHash: rows[0].content_hash,
      template: null, templateData: null, inputSchema: null, items: [] } : null;
  },
}));

import { preservePlanExecutionProgress, readExecutionPlanRow, readPlanExecutionStart,
  recordPlanExecutionStart } from './plan-execution-authority';
import { checkExecutionPlan, checkPlanExecutionGuard } from './plan-execution-guard';
import { gcOldPlanRevisions } from './revisions-gc';

let db: FreshPgDb;
const scope = { workspaceId: 'execution-ws', harnessSlug: 'project', planSlug: 'feature' };
const binding = { harnessSlug: 'project', planSlug: 'feature' };
const identity = { ownerId: 'su-execution', ownerLabel: 'test', source: 'omp-hook-session' as const,
  workspaceId: scope.workspaceId, userId: null };
const body = '---\ntitle: Feature\nstatus: ready\n---\n# Feature\n## Requirements\nPreserve findings.\n## Now\n**State:** Building\n**Next:** Verify\n';
const issue = async () => {
  const expected = await readExecutionPlanRow(scope);
  if (!expected) throw new Error('test plan missing');
  return recordPlanExecutionStart(scope, identity, expected);
};

beforeAll(async () => {
  db = await createFreshPgDb('executionstart');
  connection.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (workspace_id text, harness_slug text, plan_slug text,
      content text, content_hash text, status text, op_status text, template_data jsonb, input_schema jsonb,
      archived boolean DEFAULT false, version integer DEFAULT 1, now_note jsonb, updated_at timestamptz,
      PRIMARY KEY(workspace_id,harness_slug,plan_slug));
    CREATE TABLE harness_shared.plan_revisions (id bigserial PRIMARY KEY, workspace_id text, harness_slug text,
      plan_slug text, seq integer, content_hash text, content_snapshot text, rationale text, author_kind text,
      author_id text, session_id text, session_kind text, created_at bigint,
      UNIQUE(workspace_id,harness_slug,plan_slug,seq));
    CREATE TABLE harness_shared.plan_audits (workspace_id text, harness_slug text, plan_slug text,
      audit_kind text,audit_seq integer,audited_plan_content_hash text,audited_plan_revision_id bigint);
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text,current_plan_slug text,harness_slug text,control_state jsonb);
    CREATE TABLE harness_shared.adv_sessions (coord_owner_id text,workspace_id text,plan_slug text,ended_at timestamptz);
    CREATE TABLE harness_shared.plan_item_claims (owner text,workspace_id text,harness_slug text,plan_slug text);
    CREATE TABLE harness_shared.work_items (taken_by text,workspace_id text,harness_slug text,source_plan_slug text,status text);
  `);
  await db.sql.unsafe(await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/1613-plan-execution-start-revision.sql.DRAFT', import.meta.url), 'utf8'));
}, 120_000);
afterAll(async () => { connection.sql = null; await db?.cleanup(); });
beforeEach(async () => {
  gates.blocker = ''; gates.unavailable = false;
  await db.sql.unsafe('TRUNCATE harness_shared.harness_plans,harness_shared.plan_revisions,harness_shared.plan_audits,harness_shared.session_briefs RESTART IDENTITY');
  await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,content,content_hash,status)
    VALUES (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},${body},${hashPlanContent(body)},'ready')`;
});

describe('canonical successful-start revision authority (real PG)', () => {
  it('refuses fully ready never-started plans and permits native write admission only after a strict receipt, without op_status', async () => {
    await db.sql`INSERT INTO harness_shared.session_briefs VALUES (${identity.ownerId},${scope.workspaceId},'feature','project',NULL)`;
    const input = { ownerId: identity.ownerId, workspaceId: scope.workspaceId, toolName: 'apply_patch', args: {} };
    expect(await checkPlanExecutionGuard(input)).toMatchObject({ blockers: ['plan_not_started'] });
    const receipt = await issue();
    expect(receipt.seq).toBe(1);
    expect((await readExecutionPlanRow(scope))?.op_status).toBeNull();
    expect(await checkPlanExecutionGuard(input)).toBeNull();
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
    await issue(); // no-op starts need no fake content mutation
    expect((await readExecutionPlanRow(scope))?.content).toBe(body);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(2);
  });

  it.each(['conversation_audit_required','initial_change_scope_missing','spec_quality_not_current',
    'critique_missing','bar_contract_not_ready','governance_refused'])('rechecks current %s after a successful start', async blocker => {
    await issue(); gates.blocker = blocker;
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([blocker]);
    await expect(issue()).rejects.toThrow(blocker);
    const rows = await db.sql`SELECT seq FROM harness_shared.plan_revisions`;
    expect(rows).toHaveLength(1);
  });

  it('fails closed when current policy or the proof store is unreadable', async () => {
    await issue(); gates.unavailable = true;
    await expect(checkExecutionPlan(binding, scope.workspaceId)).rejects.toThrow('unavailable');
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} }, { readBindings: async () => [binding], checkPlan: checkExecutionPlan }))
      .toMatchObject({ blockers: ['plan_authority_unavailable'] });
    gates.unavailable = false;
    await db.sql.unsafe('ALTER TABLE harness_shared.plan_revisions RENAME TO unavailable_revisions');
    try { await expect(readPlanExecutionStart(binding, scope.workspaceId)).rejects.toThrow(); }
    finally { await db.sql.unsafe('ALTER TABLE harness_shared.unavailable_revisions RENAME TO plan_revisions'); }
  });

  it('fences both body and structured input races against the final snapshot', async () => {
    for (const column of ['content','template_data']) {
      const expected = await readExecutionPlanRow(scope);
      if (!expected) throw new Error('missing test plan');
      if (column === 'content') await db.sql`UPDATE harness_shared.harness_plans SET content=content || ' changed'`;
      else await db.sql`UPDATE harness_shared.harness_plans SET template_data='{"changed":true}'::jsonb`;
      await expect(recordPlanExecutionStart(scope, identity, expected)).rejects.toThrow('plan_changed');
    }
    expect(await db.sql`SELECT seq FROM harness_shared.plan_revisions`).toHaveLength(0);
  });

  it('preserves Now-only writes but atomically invalidates edit-then-revert and structured changes', async () => {
    await issue();
    const progress = body.replace('Building','Testing');
    await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, body, progress, hashPlanContent(body), hashPlanContent(progress));
      await tx`UPDATE harness_shared.harness_plans SET content=${progress},content_hash=${hashPlanContent(progress)}`;
    });
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    await db.sql`UPDATE harness_shared.harness_plans SET content=${progress.replace('Preserve','Discard')}`;
    await db.sql`UPDATE harness_shared.harness_plans SET content=${progress}`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    await issue();
    await db.sql`UPDATE harness_shared.harness_plans SET template_data='{"changed":true}'::jsonb`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('does not import, clone or forge proof via properties, rationale or a copied reference', async () => {
    const receipt = await issue();
    await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,content,content_hash,status,execution_start_revision_seq)
      VALUES ('other','project','feature',${body},${hashPlanContent(body)},'ready',${receipt.seq})`;
    expect(await readPlanExecutionStart(binding, 'other')).toEqual(['plan_not_started']);
    await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL`;
    await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=${receipt.seq},template_data='{"execution_start_revision_seq":1}'::jsonb`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it.each(['draft','shipped','superseded'])('clears authority on lifecycle %s', async status => {
    await issue();
    await db.sql`UPDATE harness_shared.harness_plans SET status=${status}`;
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
  });

  it('rolls back strict revision insert and reference-update failures together', async () => {
    await db.sql.unsafe(`ALTER TABLE harness_shared.plan_revisions ADD CONSTRAINT reject_receipt CHECK(seq < 0)`);
    try { await expect(issue()).rejects.toThrow(); }
    finally { await db.sql.unsafe('ALTER TABLE harness_shared.plan_revisions DROP CONSTRAINT reject_receipt'); }
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
    await db.sql.unsafe(`ALTER TABLE harness_shared.harness_plans ADD CONSTRAINT reject_reference CHECK(execution_start_revision_seq IS NULL)`);
    try { await expect(issue()).rejects.toThrow(); }
    finally { await db.sql.unsafe('ALTER TABLE harness_shared.harness_plans DROP CONSTRAINT reject_reference'); }
    expect(await db.sql`SELECT seq FROM harness_shared.plan_revisions`).toHaveLength(0);
  });

  it('retains the scoped proof beyond 100 subsequent revisions, then releases the obsolete pin', async () => {
    await issue();
    await db.sql`INSERT INTO harness_shared.plan_revisions (workspace_id,harness_slug,plan_slug,seq,content_snapshot)
      SELECT ${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},n,'later progress' FROM generate_series(2,105) AS n`;
    expect(await gcOldPlanRevisions()).toBe(4);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL`;
    expect(await gcOldPlanRevisions()).toBe(1);
  });
});
