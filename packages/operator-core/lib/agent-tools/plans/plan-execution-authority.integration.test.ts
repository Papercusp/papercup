import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { hashPlanContent } from './content-hash';
import { withPlanLock } from './with-plan-lock';

const gates = vi.hoisted(() => ({ blocker: '', unavailable: false,
  selectedReview: false, ordinaryCritiques: false, omitFinalReviewFence: false,
  beforeReadiness: null as (() => Promise<void>) | null, startGate: vi.fn() }));
const connection = vi.hoisted(() => ({ sql: null as unknown, idleTimeout: '0', timeZone: 'UTC',
  beforeFinalPlanLock: null as (() => Promise<void>) | null,
  beforeRevisionInsert: null as (() => Promise<void>) | null }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => {
    return db.sql.begin(async tx => {
      await tx`SELECT set_config('idle_in_transaction_session_timeout', ${connection.idleTimeout}, true)`;
      await tx`SELECT set_config('TimeZone', ${connection.timeZone}, true)`;
      // A transport barrier only: the production readers, locks and SQL still run.
      return fn(new Proxy(tx, { apply(target, thisArg, args) {
        const text = Array.isArray(args[0]) ? args[0].join('') : '';
        const planBarrier = connection.beforeFinalPlanLock;
        if (planBarrier && text.includes('pg_advisory_xact_lock') && args[1] === 'harness_plans') {
          connection.beforeFinalPlanLock = null;
          return planBarrier().then(() => Reflect.apply(target, thisArg, args));
        }
        const barrier = connection.beforeRevisionInsert;
        if (barrier && text.includes('INSERT INTO harness_shared.plan_revisions')) {
          connection.beforeRevisionInsert = null;
          return barrier().then(() => Reflect.apply(target, thisArg, args));
        }
        return Reflect.apply(target, thisArg, args);
      } }));
    });
  },
}));
// Policy readers have their own maintained suites. Control their verdicts here;
// the canonical writer, scoped SQL, revision insert, trigger, native guard and GC
// remain real so a ready verdict alone cannot manufacture a start receipt.
vi.mock('./plan-activation-gate', async original => ({
  ...(await original<typeof import('./plan-activation-gate')>()),
  evaluateConversationActivationGate: async () => {
  await gates.beforeReadiness?.();
  if (gates.unavailable) throw new Error('policy reader unavailable');
  return { satisfied: gates.blocker !== 'conversation_audit_required', grandfathered: true,
    code: 'conversation_audit_required' };
  },
}));
// The canonical start gate includes the pre-start BAR contract check.
vi.mock('./plan-start-gate', async original => ({
  ...(await original<typeof import('./plan-start-gate')>()),
  checkPlanStartable: async (...args: unknown[]) => {
  gates.startGate(...args);
  return ['initial_change_scope_missing', 'bar_contract_not_ready'].includes(gates.blocker)
    ? { ok: false, refusal: { code: gates.blocker } } : { ok: true };
  },
}));
vi.mock('./plan-spec-quality-gate', async original => ({
  ...(await original<typeof import('./plan-spec-quality-gate')>()),
  evaluatePlanSpecQualityGate: async () => ({
  satisfied: gates.blocker !== 'spec_quality_not_current', applicable: true, mode: 'enforced', code: 'spec_quality_not_current',
  }),
}));
vi.mock('./plan-start-critique-gate', async original => ({
  ...(await original<typeof import('./plan-start-critique-gate')>()),
  isPlanStartBarCritiqueInCohort: () => true,
  evaluatePlanStartBarCritique: async () => {
    const selected = gates.selectedReview
      ? await (await import('./plan-start-owner-review')).loadOwnerSelectedReview(scope, [], db.sql) : null;
    return { mode: 'enforced', verdict: {
      satisfied: gates.blocker !== 'critique_missing'
        && (!gates.selectedReview || gates.ordinaryCritiques || selected?.ok === true),
      code: 'critique_missing',
    }, requiresOwnerSelectedReview: gates.selectedReview && !gates.ordinaryCritiques,
    ...(selected ? { ownerSelectedReview: selected } : {}) };
  },
}));
vi.mock('../../acceptance-bar-lifecycle-evaluator', async original => ({
  ...(await original<typeof import('../../acceptance-bar-lifecycle-evaluator')>()),
  readAndEvaluateAcceptanceBarLifecycle: async () => ({
  satisfied: gates.blocker !== 'bar_contract_not_ready', codes: ['bar_contract_not_ready'],
  }),
}));
vi.mock('../../plan-types/pins', async original => ({
  ...(await original<typeof import('../../plan-types/pins')>()),
  withPinnedPlanTypes: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./plan-admission-gate', async original => ({
  ...(await original<typeof import('./plan-admission-gate')>()),
  checkPlanAdmission: async () => gates.blocker === 'governance_refused'
    ? { admitted: false, refusal: { code: gates.blocker } } : { admitted: true },
}));
vi.mock('./source', async original => ({
  ...(await original<typeof import('./source')>()),
  resolvePlanScope: async () => ({ workspaceId: 'execution-ws', harnessSlug: 'project' }),
  getPlanRow: async () => {
    const rows = await db.sql<{ content: string; content_hash: string }[]>`
      SELECT content,content_hash FROM harness_shared.harness_plans WHERE workspace_id='execution-ws' AND harness_slug='project' AND plan_slug='feature'`;
    if (!rows[0]) return null;
    const { readPlanLineNodes } = await import('./plan-line-graph');
    const { renderPlanLines } = await import('./plan-line-render');
    const items = await readPlanLineNodes(db.sql, { workspaceId: 'execution-ws', harnessSlug: 'project', slug: 'feature' });
    return { content: renderPlanLines(rows[0].content, items), contentHash: rows[0].content_hash,
      template: null, templateData: null, inputSchema: null, items };
  },
}));
// Deliberate recurrence control: reproduce omission of only the final fence.
// The selected source resolver and every evidence writer remain production code.
vi.mock('./plan-start-owner-review', async original => {
  const actual = await original<typeof import('./plan-start-owner-review')>();
  return { ...actual, revalidateOwnerSelectedReviewForStart:
    (...args: Parameters<typeof actual.revalidateOwnerSelectedReviewForStart>) => gates.omitFinalReviewFence
      ? Promise.resolve() : actual.revalidateOwnerSelectedReviewForStart(...args) };
});

import { preservePlanExecutionProgress, readExecutionPlanRow, readPlanExecutionStart,
  recordPlanExecutionStart } from './plan-execution-authority';
import {
  checkExecutionPlan,
  checkPlanExecutionGuard,
  checkPlanExecutionReadiness,
  readExecutionPlanBindings,
} from './plan-execution-guard';
import { gcOldPlanRevisions } from './revisions-gc';
import { publishReport, retireReport, type ReportRecord } from '../../report-library';
import { dispositionOwnerDirective } from '../../owner-directives';
import { registerOwnerSelectedReview } from './plan-start-owner-review';
import { listSpecClauses, setSpecClause, type SpecClauseSql } from './spec-clauses-store';
import { computeSpecSetHash } from './spec-clause-compiler';

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
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY,payload jsonb);
    INSERT INTO harness_shared.harness_registry VALUES ('execution-ws','{"projects":[{"slug":"project","harness_kind":"hive"}]}'::jsonb);
    CREATE TABLE harness_shared.harness_plans (workspace_id text, harness_slug text, plan_slug text,
      content text, content_hash text, status text, op_status text, template_data jsonb, input_schema jsonb,
      archived boolean DEFAULT false, version integer DEFAULT 1, now_note jsonb, updated_at timestamptz,
      created_at timestamptz DEFAULT now(),
      _search text GENERATED ALWAYS AS (lower(content)) STORED,
      PRIMARY KEY(workspace_id,harness_slug,plan_slug));
    ALTER TABLE harness_shared.harness_plans
      ADD COLUMN title text, ADD COLUMN created text, ADD COLUMN updated text, ADD COLUMN owner text,
      ADD COLUMN initiative text, ADD COLUMN supersedes text[] DEFAULT '{}', ADD COLUMN superseded_by text,
      ADD COLUMN op_started_at timestamptz, ADD COLUMN op_updated_at timestamptz,
      ADD COLUMN current_wave integer, ADD COLUMN op_priority integer, ADD COLUMN is_legacy boolean DEFAULT false,
      ADD COLUMN items jsonb DEFAULT '[]', ADD COLUMN now_state text, ADD COLUMN now_next text,
      ADD COLUMN promote_policy text, ADD COLUMN schedule jsonb, ADD COLUMN schedule_active boolean,
      ADD COLUMN scheduled_at timestamptz, ADD COLUMN expires_at timestamptz, ADD COLUMN tzid text,
      ADD COLUMN template_slug text, ADD COLUMN run_seq integer, ADD COLUMN template text,
      ADD COLUMN output_schema jsonb, ADD COLUMN forced_past jsonb,
      ADD COLUMN verification_profile text, ADD COLUMN verification_profile_source text,
      ADD COLUMN acceptance_bar_seeded_at timestamptz, ADD COLUMN decisions jsonb DEFAULT '[]',
      ADD COLUMN acceptance_bar_epoch integer, ADD COLUMN acceptance_bar_cohort text,
      ADD COLUMN property_schema jsonb DEFAULT '{}', ADD COLUMN properties jsonb DEFAULT '{}',
      ADD COLUMN author_pubkey text, ADD COLUMN owner_author_pubkey text,
      ADD COLUMN origin text, ADD COLUMN fed_ts bigint, ADD COLUMN fed_hlc text;
    CREATE TABLE harness_shared.plan_items (workspace_id text,harness_slug text,plan_slug text,
      item_id text,seq integer,item_text text,status text,importance text,phase text,
      owner_gate_marker text,deliverable text,blocked_by text[],decision_refs text[]);
    CREATE TABLE harness_shared.plan_decisions (workspace_id text,harness_slug text,plan_slug text,
      decision_id text,seq integer,title text,body text,decision_date text,item_refs text[],affects text[]);
    CREATE TABLE harness_shared.plan_revisions (id bigserial PRIMARY KEY, workspace_id text, harness_slug text,
      plan_slug text, seq integer, content_hash text, content_snapshot text, rationale text, author_kind text,
      author_id text, session_id text, session_kind text, created_at bigint,
      UNIQUE(workspace_id,harness_slug,plan_slug,seq));
    CREATE TABLE harness_shared.plan_audits (workspace_id text, harness_slug text, plan_slug text,
      audit_kind text,audit_seq integer,audited_plan_content_hash text,audited_plan_revision_id bigint);
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text,current_plan_slug text,harness_slug text,control_state jsonb);
    CREATE TABLE harness_shared.adv_sessions (coord_owner_id text,workspace_id text,plan_slug text,ended_at timestamptz);
    CREATE TABLE harness_shared.plan_item_claims (owner text,workspace_id text,harness_slug text,plan_slug text,item_id text);
    CREATE TABLE harness_shared.work_items (taken_by text,workspace_id text,harness_slug text,source_plan_slug text,status text,
      feature_id text,item_kind text,plan_slug text,plan_line_id text,plan_line_text text,plan_importance text,
      plan_phase text,plan_decision_refs text[],plan_deliverable text,plan_owner_gate_marker text,plan_seq integer,
      title text,summary text,closed_ts bigint,updated_ts bigint,origin text);
    CREATE TABLE harness_shared.work_item_deps (workspace_id text,dep_type text,blocked_kind text,blocked_ref text,blocker_kind text,blocker_ref text);
    ALTER TABLE harness_shared.plan_audits ADD COLUMN created_by text;
    ALTER TABLE harness_shared.adv_sessions ADD COLUMN launch_parent_owner text;
    CREATE TABLE harness_shared.consult_state (workspace_id text,routing jsonb);
    CREATE TABLE harness_shared.task_ledger (workspace_id text,detail jsonb);
    CREATE TABLE harness_shared.tool_invocations
      (workspace_id text,tool_name text,status text,args_json jsonb,coord_owner_id text);
    CREATE TABLE harness_shared.spawned_agents
      (workspace_id text,parent_spawn_id text,spawn_id text,session_owner text);
    CREATE TABLE harness_shared.owner_directives (id bigint PRIMARY KEY,workspace_id text,owner_id text,
      session_ref text,source_turn_ref text,verbatim_text text,recorded_by text,captured_by_hook boolean,
      created_at timestamptz DEFAULT now(),dispositioned_at timestamptz,disposition_status text,
      disposition_note text,dispositioned_by text);
    CREATE TABLE harness_shared.report_library (workspace_id text,report_id text,title text,summary text,
      body_md text,kind text,subject_kind text,subject_ref text,subject_label text,origin_harness_slug text,
      author_owner_id text,author_session_ref text,visibility text,supersedes_report_id text,lineage_id text,
      source text,tags text[],published_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      retired_at timestamptz,goal_owner_report jsonb,request_key text,request_scope text,
      PRIMARY KEY(workspace_id,report_id));
    CREATE TABLE harness_shared.plan_spec_clauses (workspace_id text,harness_slug text,plan_slug text,
      spec_id text,source_val_id text,current_revision integer,created_by text,updated_at timestamptz,
      PRIMARY KEY(workspace_id,harness_slug,plan_slug,spec_id));
    CREATE TABLE harness_shared.plan_spec_clause_revisions (workspace_id text,harness_slug text,plan_slug text,
      spec_id text,revision integer,plan_item_id text DEFAULT 'P-001',behavior text,
      behavior_class text DEFAULT 'happy-path',required_evidence text[] DEFAULT '{}',
      required_test_layers text[] DEFAULT '{}',mutation_required boolean DEFAULT false,
      lifecycle_status text DEFAULT 'active',supersedes_spec_id text,supersedes_revision integer,
      exemption jsonb,falsifier jsonb,content_hash text DEFAULT 'fixture',created_by text DEFAULT 'su-execution',
      created_at timestamptz DEFAULT now(),accepted_by text,accepted_at timestamptz,
      acceptance_ref text,source_bar_key text,source_bar_hash text,source_bar_set_hash text,
      source_rubric_slug text,source_rubric_revision integer,evidence_plane text);
  `);
  await db.sql.unsafe(await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/1613-plan-execution-start-revision.sql', import.meta.url), 'utf8'));
  const invalidationMigration = await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/1620-plan-execution-invalidation-reasons.sql', import.meta.url), 'utf8');
  await db.sql.unsafe(invalidationMigration);
  await db.sql.unsafe(invalidationMigration); // idempotent replay must not restore authority
  // Fail at fixture setup if the authority census or readiness readers drift
  // beyond this migrated-PG schema. Otherwise their callers collapse a SQL
  // shape error into `plan_authority_unavailable`, obscuring the missing column.
  await db.sql`INSERT INTO harness_shared.harness_plans
    (workspace_id,harness_slug,plan_slug,content,content_hash,status)
    VALUES (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},${body},${hashPlanContent(body)},'ready')`;
  expect(await readExecutionPlanBindings(identity.ownerId, scope.workspaceId)).toEqual([]);
  await expect(readExecutionPlanRow(scope)).resolves.toMatchObject({ content: body });
  const { seedAcceptanceBarsOnFederatedApply } = await import('../../acceptance-bar-receiver-seed');
  expect((await seedAcceptanceBarsOnFederatedApply(db.sql, scope)).status).not.toBe('failed');
  await expect(checkPlanExecutionReadiness(binding, scope.workspaceId)).resolves.toEqual([]);
}, 120_000);
afterAll(async () => { connection.sql = null; await db?.cleanup(); });
beforeEach(async () => {
  gates.blocker = ''; gates.unavailable = false;
  gates.selectedReview = false; gates.ordinaryCritiques = false; gates.omitFinalReviewFence = false;
  gates.beforeReadiness = null;
  connection.beforeFinalPlanLock = null; connection.beforeRevisionInsert = null;
  connection.idleTimeout = '0'; connection.timeZone = 'UTC';
  await db.sql.unsafe('TRUNCATE harness_shared.harness_plans,harness_shared.plan_revisions,harness_shared.plan_audits,harness_shared.session_briefs,harness_shared.work_items,harness_shared.work_item_deps RESTART IDENTITY');
  await db.sql.unsafe('TRUNCATE harness_shared.owner_directives,harness_shared.report_library,harness_shared.plan_spec_clauses,harness_shared.plan_spec_clause_revisions,harness_shared.plan_items');
  await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,content,content_hash,status)
    VALUES (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},${body},${hashPlanContent(body)},'ready')`;
});

describe('canonical successful-start revision authority (real PG)', () => {
  const reviewOrigin = { harnessSlug: scope.harnessSlug, authorOwnerId: 'independent-reviewer',
    authorSessionRef: 'owner-review-session' };
  async function seedSelectedReview() {
    const barSetHash = 'b'.repeat(64);
    await db.sql`INSERT INTO harness_shared.plan_items (workspace_id,harness_slug,plan_slug,item_id)
      VALUES (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},'P-001')`;
    await db.sql`INSERT INTO harness_shared.plan_spec_clauses
      (workspace_id,harness_slug,plan_slug,spec_id,source_val_id,current_revision) VALUES
      (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},'S-1',NULL,1)`;
    await db.sql`INSERT INTO harness_shared.plan_spec_clause_revisions
      (workspace_id,harness_slug,plan_slug,spec_id,revision,behavior,source_bar_key,source_bar_hash,
       source_bar_set_hash,source_rubric_slug,source_rubric_revision,evidence_plane,created_at)
      VALUES (${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},'S-1',1,'Preserve signed bytes',
        'R-1',${'a'.repeat(64)},${barSetHash},'fixture-rubric',1,'tree','2020-01-01T00:00:00Z')`;
    const clauses = await listSpecClauses(scope, { ...scope, executor: db.sql as unknown as SpecClauseSql });
    const specSetHash = computeSpecSetHash(clauses);
    const reviewConclusion = 'APPROVE this exact implementation contract.';
    const report = await publishReport(db.sql, { workspaceId: scope.workspaceId, title: 'Independent review',
      bodyMd: `${reviewConclusion}\nBAR ${barSetHash}\nSpec ${specSetHash}`, kind: 'review',
      subject: { kind: 'plan', ref: scope.planSlug }, visibility: 'workspace' }, reviewOrigin);
    const selectionText = 'Accept your review as adequate.';
    await db.sql`INSERT INTO harness_shared.owner_directives
      (id,workspace_id,owner_id,session_ref,source_turn_ref,verbatim_text,recorded_by,captured_by_hook)
      VALUES (42,${scope.workspaceId},'fixture-human',${reviewOrigin.authorSessionRef},
        'session_turn:codex:fixture:1',${selectionText},${reviewOrigin.authorOwnerId},true)`;
    expect(await registerOwnerSelectedReview(scope, { directiveId: 42, reportId: report.reportId,
      bodySha256: report.bodySha256, barSetHash, specSetHash, selectionText, reviewConclusion,
      dispositions: 'Preserve separate final product acceptance.' }, identity)).toMatchObject({ ok: true });
    gates.selectedReview = true;
    expect(await checkPlanExecutionReadiness(binding, scope.workspaceId)).toEqual([]);
    return report;
  }
  function barrier() {
    let reached!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    return { ready, release, wait: async () => { reached(); await resume; } };
  }
  const reviewChanges = ['supersede', 'retire', 'decline', 'clause-phantom'] as const;
  async function changeReview(kind: typeof reviewChanges[number], report: ReportRecord, sql = db.sql) {
    if (kind === 'supersede') await publishReport(sql, { workspaceId: scope.workspaceId, title: 'Withdraw approval',
      bodyMd: 'The earlier review is withdrawn.', kind: 'review', subject: { kind: 'plan', ref: scope.planSlug },
      visibility: 'owner', supersedes: report.reportId }, reviewOrigin);
    else if (kind === 'retire') await retireReport(sql, scope.workspaceId, report.reportId);
    else if (kind === 'clause-phantom') await sql.begin(async tx => {
      expect(await setSpecClause({ planSlug: scope.planSlug, specId: 'S-2', expectedRevision: 0,
        planItemId: 'P-001', behavior: 'A newly added obligation', behaviorClass: 'boundary',
        lifecycleStatus: 'draft', actorId: 'new-clause-author' },
      { ...scope, executor: tx as unknown as SpecClauseSql })).toMatchObject({ status: 'created' });
    });
    else expect(await dispositionOwnerDirective({ id: 42, status: 'declined',
      note: 'Withdraw this selection.', dispositionedBy: reviewOrigin.authorOwnerId }, sql)).toMatchObject({ ok: true });
  }

  it('issues authority from a real current selected review', async () => {
    await seedSelectedReview();
    expect(await issue()).toMatchObject({ seq: 2 });
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
  });

  it('allows sufficient ordinary critiques despite an invalid historical selected review', async () => {
    const report = await seedSelectedReview();
    await changeReview('retire', report);
    gates.ordinaryCritiques = true; // Producer truth has its own maintained critique-gate cases.
    expect(await issue()).toMatchObject({ seq: 2 });
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
  });

  it.each(reviewChanges)('refuses %s committed after readiness and before the final grant lock', async kind => {
    const report = await seedSelectedReview();
    const pause = barrier();
    connection.beforeFinalPlanLock = pause.wait;
    const granting = issue().then(() => null, error => error as Error);
    try {
      await Promise.race([pause.ready, granting.then(() => { throw new Error('Grant settled before final-plan lock barrier'); })]);
      await changeReview(kind, report);
    } finally { connection.beforeFinalPlanLock = null; pause.release(); }
    expect(await granting).toBeInstanceOf(Error);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
    const revisions = await db.sql<{ rationale: string }[]>`SELECT rationale FROM harness_shared.plan_revisions`;
    expect(revisions).toHaveLength(1); // Original review binding only; no grant or partial revision.
    expect(revisions[0]!.rationale).toBe('plans:start owner-selected pre-implementation review');
  });

  it.each(['supersede', 'decline', 'clause-phantom'] as const)(
    'distinguishes omitted final revalidation for a committed %s', async kind => {
      const report = await seedSelectedReview();
      const pause = barrier();
      gates.omitFinalReviewFence = true;
      connection.beforeFinalPlanLock = pause.wait;
      const granting = issue().then(value => ({ value, error: null }), error => ({ value: null, error }));
      try {
        await Promise.race([pause.ready, granting.then(() => { throw new Error('Grant settled before final-plan lock barrier'); })]);
        await changeReview(kind, report);
      } finally { connection.beforeFinalPlanLock = null; pause.release(); }
      expect(await granting).toMatchObject({ value: { seq: 2 }, error: null });
      gates.omitFinalReviewFence = false;
      expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual(['critique_missing']);
    },
  );

  it.each(reviewChanges)('serializes the actual %s writer until the final grant commits', async kind => {
    const report = await seedSelectedReview();
    const pause = barrier();
    connection.beforeRevisionInsert = pause.wait;
    const granting = issue().then(value => ({ value, error: null }), error => ({ value: null, error }));
    const applicationName = `owner-review-${kind}`;
    const writer = postgres(db.url, { max: 1, prepare: false, connection: { application_name: applicationName } });
    let writing: Promise<void> | undefined;
    try {
      await Promise.race([pause.ready, granting.then(() => { throw new Error('Grant settled before revision barrier'); })]);
      writing = changeReview(kind, report, writer);
      await vi.waitFor(async () => {
        const blocked = await db.sql`SELECT 1 FROM pg_stat_activity
          WHERE application_name=${applicationName} AND wait_event_type='Lock'`;
        expect(blocked).toHaveLength(1);
      }, { timeout: 5000, interval: 20 });
      pause.release();
      expect(await granting).toMatchObject({ value: { seq: 2 }, error: null });
      await writing;
      // The later revocation need not rewrite the plan row: every guarded use
      // resolves the real selected evidence again and refuses it.
      expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual(['critique_missing']);
    } finally {
      pause.release();
      await granting;
      await writing?.catch(() => {});
      await writer.end();
    }
  });

  it('uses new-start discovery for issuance and continuation only after a matching immutable receipt', async () => {
    gates.startGate.mockClear();
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    expect(gates.startGate).not.toHaveBeenCalled();
    await issue();
    expect(gates.startGate).toHaveBeenLastCalledWith('feature', expect.any(Object), null, 'start',
      expect.objectContaining({ discoveryAdmission: 'start' }));
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
    expect(gates.startGate).toHaveBeenLastCalledWith('feature', expect.any(Object), null, 'start',
      expect.objectContaining({ discoveryAdmission: 'continuation' }));
    gates.blocker = 'bar_contract_not_ready';
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual(['bar_contract_not_ready']);
  });

  const seedLine = async (id: string, seq = 0) => db.sql`
    INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,status,
      plan_slug,plan_line_id,plan_line_text,plan_importance,plan_decision_refs,plan_deliverable,plan_seq)
    VALUES ('execution-ws','project',${id},'feature','open','feature',${id},'Preserve findings','normal','{}','doc',${seq})`;

  it.each(['America/New_York', 'Asia/Kathmandu'])('preserves timestamp instants across %s start and UTC admission', async timeZone => {
    await db.sql`UPDATE harness_shared.harness_plans SET created_at='2026-11-05T18:19:03.691104Z',
      acceptance_bar_seeded_at='2026-11-06T00:35:06.875123Z'`;
    const reader = postgres(db.url, { max: 1, prepare: false, connection: { TimeZone: timeZone } });
    connection.sql = reader;
    connection.timeZone = timeZone;
    try {
      const receipt = await issue();
      connection.sql = db.sql;
      expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
      expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
    } finally {
      connection.sql = db.sql;
      await reader.end();
    }
  });

  it('does not clear an immutable start on a dependency bookkeeping replay', async () => {
    await seedLine('P-001'); await seedLine('P-002', 1);
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('default','blocks','feature','project#P-002','feature','project#P-001')`;
    const receipt = await issue();
    await db.sql`UPDATE harness_shared.work_item_deps SET dep_type=dep_type`;
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
  });

  it('reads an existing offset-formatted receipt without losing microseconds or granting an orphaned start', async () => {
    await db.sql`UPDATE harness_shared.harness_plans SET created_at='2026-11-05T18:19:03.691104Z'`;
    await issue();
    await db.sql`UPDATE harness_shared.plan_revisions SET content_snapshot=jsonb_set(content_snapshot::jsonb,
      '{inputs,created_at}', '"2026-11-05T13:19:03.691104-05:00"')::text`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    await db.sql`UPDATE harness_shared.plan_revisions SET content_snapshot=jsonb_set(content_snapshot::jsonb,
      '{inputs,created_at}', '"2026-11-05T13:19:03.691105-05:00"')::text`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_start_revision_stale']);
    await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it.each([undefined, null, { reason: 'prior author edit', priorRevision: 17 }])(
    'admits legacy lifecycle metadata %j without admitting changed authority inputs or body', async invalidation => {
      const receipt = await issue();
      const [stored] = await db.sql<{ content_snapshot: string }[]>`
        SELECT content_snapshot FROM harness_shared.plan_revisions WHERE seq=${receipt.seq}`;
      const legacy = JSON.parse(stored!.content_snapshot);
      if (invalidation === undefined) delete legacy.inputs.execution_start_invalidation;
      else legacy.inputs.execution_start_invalidation = invalidation;
      const replaceReceipt = async (snapshot: unknown) => db.sql`
        UPDATE harness_shared.plan_revisions SET content_snapshot=${JSON.stringify(snapshot)}
        WHERE seq=${receipt.seq}`;

      await replaceReceipt(legacy);
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
      expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);

      await replaceReceipt({ ...legacy, inputs: { ...legacy.inputs, template_data: { changed: true } } });
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_start_revision_stale']);

      await replaceReceipt({ ...legacy, body: legacy.body.replace('Preserve findings', 'Discard findings') });
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_start_revision_stale']);
    },
  );

  it('normalizes the final locked start snapshot across reader and writer TimeZone', async () => {
    const reader = postgres(db.url, { max: 1, prepare: false, connection: { TimeZone: 'America/New_York' } });
    connection.sql = reader;
    try { await expect(issue()).resolves.toMatchObject({ seq: 1 }); }
    finally { connection.sql = db.sql; await reader.end(); }
  });

  it('carries accepted start through real federation, bookkeeping and native source admission', async () => {
    await seedLine('P-001'); await seedLine('P-002', 1);
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('default','blocks','feature','project#P-002','feature','project#P-001')`;
    await db.sql`INSERT INTO harness_shared.session_briefs VALUES (${identity.ownerId},${scope.workspaceId},'feature','project',NULL)`;
    await db.sql`UPDATE harness_shared.harness_plans SET author_pubkey='peer'`;
    const receipt = await issue();
    const { buildHarnessPlansProjection } = await import('../../sync/hyperbee/projections/harness-plans');
    const projection = buildHarnessPlansProjection({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      sql: db.sql, isFlagOn: async () => false });
    const progress = body.replace('Building', 'Testing');
    const incoming = { harness_slug: scope.harnessSlug, plan_slug: scope.planSlug,
      content: progress, content_hash: hashPlanContent(progress), title: null, status: 'ready',
      created: null, updated: null, owner: null, supersedes: [], superseded_by: null,
      archived: false, is_legacy: false };
    await projection.writeToPg(incoming, { origin: 'remote', ts: 10, authorPubkey: 'peer' });
    await db.sql`UPDATE harness_shared.work_items SET status='wip',updated_ts=42`;
    await db.sql`UPDATE harness_shared.work_item_deps SET dep_type=dep_type`;
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} })).toBeNull();
    const changed = progress.replace('Preserve findings', 'Discard findings');
    await projection.writeToPg({ ...incoming, content: changed, content_hash: hashPlanContent(changed) },
      { origin: 'remote', ts: 20, authorPubkey: 'peer' });
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} })).toMatchObject({ blockers: ['plan_not_started'] });
    const row = await readExecutionPlanRow(scope);
    expect(row?.execution_start_invalidation).toMatchObject({ schema: 'plan-execution-invalidation-v1',
      startRevisionSeq: receipt.seq, scope, reason: 'plan_body_changed' });
  });

  it('ignores unrelated dependency scopes and kinds but records real dependency and line invalidations', async () => {
    await seedLine('P-001'); await seedLine('P-002', 1);
    const receipt = await issue();
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('foreign','blocks','feature','project#P-002','feature','project#P-001')`;
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('default','blocks','issue','P-002','issue','P-001')`;
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('default','blocks','feature','project#P-002','feature','project#P-001')`;
    expect((await readExecutionPlanRow(scope))?.execution_start_invalidation).toMatchObject({
      scope, reason: 'dependency_changed', startRevisionSeq: receipt.seq });
    await issue();
    await db.sql`UPDATE harness_shared.work_items SET plan_line_text='Discard findings' WHERE plan_line_id='P-001'`;
    expect((await readExecutionPlanRow(scope))?.execution_start_invalidation).toMatchObject({ scope, reason: 'plan_line_changed' });
  });

  it('preserves local start through per-part progress recomposition and invalidates a requirements edit', async () => {
    // A canonical plan has a slug. Otherwise recomposition legitimately changes
    // is_legacy, which is a structured authority input rather than progress.
    const canonicalBody = body.replace('title: Feature', 'slug: feature\ntitle: Feature');
    await db.sql`UPDATE harness_shared.harness_plans SET content=${canonicalBody},content_hash=${hashPlanContent(canonicalBody)}`;
    const receipt = await issue();
    const { buildHarnessPlanPartsProjection } = await import('../../sync/hyperbee/projections/harness-plan-parts');
    const { InMemoryPlanPartsStore } = await import('../../plan-parts/store');
    const { splitPlanIntoParts } = await import('./parser');
    // The in-process LWW part store is the maintained projection seam; the
    // production recomposition, admission, PG writes and authority stay real.
    const projection = buildHarnessPlanPartsProjection({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      sql: db.sql, store: new InMemoryPlanPartsStore(), isFlagOn: async () => true,
      readLocalContent: async () => canonicalBody });
    const parts = splitPlanIntoParts(canonicalBody);
    const apply = async (part: (typeof parts)[number], text: string, ts: number) => projection.writeToPg({
      harness_slug: scope.harnessSlug, plan_slug: scope.planSlug, part_key: part.key,
      kind: part.kind, body: text, ordinal: part.order, tombstone: false,
    }, { origin: 'remote', authorPubkey: 'peer', ts });
    const now = parts.find(part => part.text.includes('Building'))!;
    await apply(now, now.text.replace('Building', 'Testing'), 10);
    expect(await readExecutionPlanRow(scope)).toMatchObject({
      execution_start_revision_seq: receipt.seq, execution_start_invalidation: null });
    expect(await checkExecutionPlan(binding, scope.workspaceId)).toEqual([]);
    const requirements = parts.find(part => part.text.includes('Preserve findings'))!;
    await apply(requirements, requirements.text.replace('Preserve', 'Discard'), 20);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    expect((await readExecutionPlanRow(scope))?.execution_start_invalidation).toMatchObject({
      scope, startRevisionSeq: receipt.seq, reason: 'plan_body_changed' });
  });

  it('survives independent readiness slower than the write transaction idle timeout', async () => {
    const slowRead = async () => { await db.sql`SELECT pg_sleep(0.3)`; };
    // Positive control: the former transaction/read/query ordering really loses
    // its backend under this timeout; a merely slow or disabled timer cannot pass.
    const expired = db.sql.begin(async tx => {
      await tx`SELECT set_config('idle_in_transaction_session_timeout', '100ms', true)`;
      await slowRead();
      await tx`SELECT 1`;
    });
    await expect(expired).rejects.toHaveProperty('code', expect.stringMatching(/^(25P03|CONNECTION_CLOSED)$/));
    connection.idleTimeout = '100ms';
    gates.beforeReadiness = slowRead;
    await expect(issue()).resolves.toMatchObject({ seq: 1 });
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
  });

  it('leaves the plan advisory lock available to independent readiness readers', async () => {
    gates.beforeReadiness = async () => {
      await db.sql.begin(async tx => {
        const [row] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('harness_plans'),
          hashtext(${`${scope.workspaceId}:${scope.harnessSlug}:${scope.planSlug}`})) AS acquired`;
        expect(row.acquired).toBe(true);
      });
    };
    await expect(issue()).resolves.toMatchObject({ seq: 1 });
  });

  it.each(['body', 'structured input', 'rendered line'])('fences a %s change during independent readiness', async change => {
    await seedLine('P-001');
    const expected = await readExecutionPlanRow(scope);
    if (!expected) throw new Error('missing plan');
    gates.beforeReadiness = async () => {
      if (change === 'body') await db.sql`UPDATE harness_shared.harness_plans SET content=content || ' changed'`;
      else if (change === 'structured input') await db.sql`UPDATE harness_shared.harness_plans SET template_data='{"changed":true}'::jsonb`;
      else await db.sql`UPDATE harness_shared.work_items SET plan_line_text='Discard findings'`;
    };
    await expect(recordPlanExecutionStart(scope, identity, expected)).rejects.toThrow('plan_changed_before_start_proof');
    expect(await db.sql`SELECT seq FROM harness_shared.plan_revisions`).toHaveLength(0);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
  });

  it('records rendered work-graph scope, preserves progress, and invalidates a line edit even after revert', async () => {
    await seedLine('P-001');
    const receipt = await issue();
    const [revision] = await db.sql`SELECT content_snapshot FROM harness_shared.plan_revisions WHERE seq=${receipt.seq}`;
    expect(JSON.parse(revision.content_snapshot).body).toContain('P-001');
    await db.sql`UPDATE harness_shared.work_items SET status='wip'`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    await db.sql`UPDATE harness_shared.work_items SET plan_line_text='Discard findings'`;
    await db.sql`UPDATE harness_shared.work_items SET plan_line_text='Preserve findings'`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('fences final rendered-line races and invalidates dependency insertion and removal', async () => {
    await seedLine('P-001'); await seedLine('P-002', 1);
    const expected = await readExecutionPlanRow(scope);
    if (!expected) throw new Error('missing plan');
    await db.sql`UPDATE harness_shared.work_items SET plan_deliverable='decision' WHERE plan_line_id='P-002'`;
    await expect(recordPlanExecutionStart(scope, identity, expected)).rejects.toThrow('plan_changed');
    await issue();
    await db.sql`INSERT INTO harness_shared.work_item_deps VALUES ('default','blocks','feature','project#P-002','feature','project#P-001')`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    await issue();
    await db.sql`DELETE FROM harness_shared.work_item_deps`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('invalidates dropping, restoring, and deleting a line while leaving another plan alone', async () => {
    await seedLine('P-001');
    for (const status of ['dropped','open']) {
      await issue();
      await db.sql`UPDATE harness_shared.work_items SET status=${status}`;
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    }
    await issue();
    await db.sql`DELETE FROM harness_shared.work_items`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('refuses fully ready never-started plans and permits native write admission only after a strict receipt, without op_status', async () => {
    await db.sql`INSERT INTO harness_shared.session_briefs VALUES (${identity.ownerId},${scope.workspaceId},'feature','project',NULL)`;
    const input = { ownerId: identity.ownerId, workspaceId: scope.workspaceId, toolName: 'apply_patch', args: {} };
    // Exercise the real census query explicitly so fixture/schema drift reports
    // its SQL error instead of only the guard's intentionally opaque refusal.
    await expect(readExecutionPlanBindings(identity.ownerId, scope.workspaceId)).resolves.toEqual([
      { planSlug: scope.planSlug, harnessSlug: scope.harnessSlug, source: 'session-brief', sourceRef: scope.planSlug },
    ]);
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
    const current = await checkExecutionPlan(binding, scope.workspaceId);
    if (blocker === 'initial_change_scope_missing') {
      expect(current).toEqual(['initial_change_scope_missing']);
    } else {
      expect(current).toEqual([blocker]);
    }
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

  it('preserves the issued receipt across generated claim progress and rejects added author scope', async () => {
    await seedLine('P-001');
    const original = body + '\n## Phase 1\n- **P-001** `todo` Preserve findings\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${original},content_hash=${hashPlanContent(original)}`;
    const receipt = await issue();
    const claimed = original.replace('`todo`', '`wip`')
      .replace('Preserve findings\n', 'Preserve findings — note: → WI-6554700010045594\n');
    await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, original, claimed, hashPlanContent(original), hashPlanContent(claimed));
      await tx`UPDATE harness_shared.harness_plans SET content=${claimed},content_hash=${hashPlanContent(claimed)}`;
      await tx`UPDATE harness_shared.work_items SET status='wip' WHERE plan_line_id='P-001'`;
    });
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    const changed = claimed.replace('WI-6554700010045594', 'WI-6554700010045594 — also discard findings');
    await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, claimed, changed, hashPlanContent(claimed), hashPlanContent(changed));
      await tx`UPDATE harness_shared.harness_plans SET content=${changed},content_hash=${hashPlanContent(changed)}`;
    });
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('preserves execution authority for a reflected release receipt but rejects extra author scope', async () => {
    await seedLine('P-001');
    const original = body + '\n## Phase 1\n- **P-001** `wip` Preserve findings\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${original},content_hash=${hashPlanContent(original)}`;
    const receipt = await issue();
    // plan-item-reflect:release emits this exact unmarked legacy receipt.
    // Releasing duplicate tracking must not revoke the plan's issued start.
    const released = original.replace('`wip`', '`todo`')
      .replace('Preserve findings\n', 'Preserve findings — note: ← WI-6554700010046542 released\n');
    await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, original, released, hashPlanContent(original), hashPlanContent(released));
      await tx`UPDATE harness_shared.harness_plans SET content=${released},content_hash=${hashPlanContent(released)}`;
      await tx`UPDATE harness_shared.work_items SET status='todo' WHERE plan_line_id='P-001'`;
    });
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);

    const changed = released.replace('released\n', 'released — also discard findings\n');
    await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, released, changed, hashPlanContent(released), hashPlanContent(changed));
      await tx`UPDATE harness_shared.harness_plans SET content=${changed},content_hash=${hashPlanContent(changed)}`;
    });
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('preserves execution authority for a reflected release through the plan-line graph writer', async () => {
    await seedLine('P-001');
    await db.sql`UPDATE harness_shared.work_items SET status='wip',plan_phase='Phase 1',plan_deliverable='code' WHERE plan_line_id='P-001'`;
    const original = body + '\n## Phase 1\n- **P-001** \x60wip\x60 Preserve findings deliverable: code\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${original},content_hash=${hashPlanContent(original)}`;
    const receipt = await issue();
    await import('../../plan-items/reflect-rules');
    const { reactionRulesFor } = await import('../../events/registry');
    const { flipStatusInBody } = await import('./set-status');
    const { deriveIndexFromContent } = await import('./derive-index');
    const { readPlanLineNodes, writePlanLineNodes } = await import('./plan-line-graph');
    const graphScope = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, slug: scope.planSlug };
    const rule = reactionRulesFor('work_items:release').find(r => r.id === 'plan-item-reflect:release');
    if (!rule || typeof rule.args !== 'function') throw new Error('release reflection rule missing');
    const args = rule.args({
      tool: 'work_items:release', args: {}, ctx: { uiClientId: identity.ownerId },
      result: { ok: true, data: { workItem: { id: 'WI-6554700010046542', state: 'open',
        payload: { plan_item: { plan_slug: scope.planSlug, item_id: 'P-001', harness_slug: scope.harnessSlug } } } } },
    } as import('../../events/types').ToolInvocationEvent) as {
      item: string; status: string; note: string; noteKind?: 'author' | 'progress';
    };
    const released = flipStatusInBody(original, args.item, args.status, args.note, args.noteKind);
    expect(released.found).toBe(true);
    const beforeNodes = await readPlanLineNodes(db.sql, graphScope);
    const mutations = await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(tx, scope, original, released.newBody,
        hashPlanContent(original), hashPlanContent(released.newBody));
      await tx`UPDATE harness_shared.harness_plans SET content=${released.newBody},content_hash=${hashPlanContent(released.newBody)}`;
      return writePlanLineNodes(tx as unknown as Parameters<typeof writePlanLineNodes>[0],
        graphScope, beforeNodes, deriveIndexFromContent(released.newBody).items);
    });
    expect(mutations).toEqual([]);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    expect((await readPlanLineNodes(db.sql, graphScope))[0]).toMatchObject({
      text: 'Preserve findings', status: 'todo', blockedBy: [], deliverable: 'code', phase: 'Phase 1',
    });
  });

  it.each(['text', 'importance', 'legacy note'] as const)(
    'retains canonical legacy-note bytes across repeated reflected progress and fences changed %s', async changedField => {
      const { deriveIndexFromContent } = await import('./derive-index');
      const { readPlanLineNodes, writePlanLineNodes } = await import('./plan-line-graph');
      const { renderPlanLines } = await import('./plan-line-render');
      const { flipStatusInBody } = await import('./set-status');
      await import('../../plan-items/reflect-rules');
      const { reactionRulesFor } = await import('../../events/registry');
      const graphScope = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, slug: scope.planSlug };
      let current = body + '\n## Phase 1\n'
        + '- **P-001** `wip` Preserve findings deliverable: code\n'
        + '- **P-002** `todo` Retain artifacts D-050 importance: low deliverable: doc — note: Original evidence\n'
        + '- **P-003** `todo` Preserve provenance D-051 importance: high deliverable: code — note: Historical evidence\n';
      const initialItems = deriveIndexFromContent(current).items;
      for (const [seq, item] of initialItems.entries()) {
        await seedLine(item.id, seq);
        // Historical graph projections can retain fewer separator bytes than
        // a current metadata render/parse. Both represent the same author text.
        const storedText = item.text.replace(/\s+/g, ' ').trim();
        await db.sql`UPDATE harness_shared.work_items SET
          plan_line_text=${storedText},plan_phase=${item.phase},plan_importance=${item.importance},
          plan_deliverable=${item.deliverable ?? null},plan_decision_refs=${item.decisionRefs}::text[],
          status=${item.status === 'todo' ? 'open' : item.status},
          title='Retained title',summary='Retained summary' WHERE plan_line_id=${item.id}`;
      }
      await db.sql`UPDATE harness_shared.harness_plans SET content=${current},content_hash=${hashPlanContent(current)}`;
      await db.sql`INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,current_plan_slug,harness_slug)
        VALUES (${identity.ownerId},${scope.workspaceId},${scope.planSlug},${scope.harnessSlug})`;
      expect(await readExecutionPlanBindings(identity.ownerId, scope.workspaceId))
        .toEqual([expect.objectContaining(binding)]);
      const receipt = await issue();
      const originalRows = await db.sql`SELECT plan_line_id,plan_line_text,title,summary
        FROM harness_shared.work_items ORDER BY plan_seq`;
      const rule = reactionRulesFor('work_items:release').find(r => r.id === 'plan-item-reflect:release');
      if (!rule || typeof rule.args !== 'function') throw new Error('release reflection rule missing');
      const releaseArgs = rule.args({
        tool: 'work_items:release', args: {}, ctx: { uiClientId: identity.ownerId },
        result: { ok: true, data: { workItem: { id: 'WI-6554700010046542', state: 'open',
          payload: { plan_item: { plan_slug: scope.planSlug, item_id: 'P-001', harness_slug: scope.harnessSlug } } } } },
      } as import('../../events/types').ToolInvocationEvent) as {
        item: string; status: string; note: string; noteKind?: 'author' | 'progress';
      };
      const reflections = [releaseArgs, { item: 'P-001', status: 'wip',
        note: 'Claim progress blocked-by: P-999 importance: high D-999', noteKind: 'progress' as const }, releaseArgs];
      for (const [pass, args] of reflections.entries()) {
        const beforeNodes = await readPlanLineNodes(db.sql, graphScope);
        const rendered = renderPlanLines(current, beforeNodes);
        if (pass === 0) {
          // This is the production failure mechanism: multiple metadata fields
          // leave different separator bytes before an ordinary legacy note.
          const roundTrip = deriveIndexFromContent(rendered).items;
          expect(roundTrip.map(item => item.text)).not.toEqual(beforeNodes.map(item => item.text));
          const meaning = (text: string) => text.replace(/\s+/g, ' ').trim();
          expect(roundTrip.map(item => meaning(item.text))).toEqual(beforeNodes.map(item => meaning(item.text)));
        }
        const reflected = flipStatusInBody(rendered, args.item, args.status, args.note, args.noteKind);
        expect(reflected.found).toBe(true);
        const next = reflected.newBody;
        const mutations = await db.sql.begin(async tx => {
          await preservePlanExecutionProgress(tx, scope, current, next, hashPlanContent(current), hashPlanContent(next));
          await tx`UPDATE harness_shared.harness_plans SET content=${next},content_hash=${hashPlanContent(next)}`;
          return writePlanLineNodes(tx as unknown as Parameters<typeof writePlanLineNodes>[0],
            graphScope, beforeNodes, deriveIndexFromContent(next).items);
        });
        expect(mutations).toEqual([]);
        expect(await db.sql`SELECT plan_line_id,plan_line_text,title,summary
          FROM harness_shared.work_items ORDER BY plan_seq`).toEqual(originalRows);
        expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
        expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
        expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
          toolName: 'apply_patch', args: {} })).toBeNull();
        current = next;
      }
      const changed = changedField === 'text' ? current.replace('Preserve findings deliverable:', 'Discard findings deliverable:')
        : changedField === 'importance' ? current.replace('importance: low', 'importance: high')
          : current.replace('Original evidence', 'Different evidence');
      expect(changed).not.toBe(current);
      expect(deriveIndexFromContent(changed).items).not.toEqual(deriveIndexFromContent(current).items);
      const beforeNodes = await readPlanLineNodes(db.sql, graphScope);
      // Exercise the graph fence directly: no body update or preservation helper
      // can clear the receipt on behalf of this meaningful-change control.
      await db.sql.begin(tx => writePlanLineNodes(tx as unknown as Parameters<typeof writePlanLineNodes>[0],
        graphScope, beforeNodes, deriveIndexFromContent(changed).items));
      expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
      expect((await readExecutionPlanRow(scope))?.execution_start_invalidation).toMatchObject({ reason: 'plan_line_changed' });
      expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
      expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
        toolName: 'apply_patch', args: {} })).toMatchObject({ blockers: ['plan_not_started'] });
    });

  it('preserves execution authority for a typed progress note through the plan-line graph writer', async () => {
    await seedLine('P-001');
    await db.sql`UPDATE harness_shared.work_items SET plan_phase='Phase 1',plan_deliverable='code' WHERE plan_line_id='P-001'`;
    const original = body + '\n## Phase 1\n- **P-001** \x60todo\x60 Preserve findings deliverable: code\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${original},content_hash=${hashPlanContent(original)}`;
    const receipt = await issue();
    const { deriveIndexFromContent } = await import('./derive-index');
    const { readPlanLineNodes, writePlanLineNodes } = await import('./plan-line-graph');
    const { formatOperationalProgressNote } = await import('@papercusp/plan-parser');
    const graphScope = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, slug: scope.planSlug };
    const note = 'Operational update blocked-by: P-999 importance: high deliverable: code D-999';
    const noteSuffix = formatOperationalProgressNote(note);
    const progress = original
      .replace('Preserve findings deliverable: code\n', 'Preserve findings deliverable: code' + noteSuffix + '\n')
      .replace('\x60todo\x60', '\x60wip\x60');
    const beforeNodes = await readPlanLineNodes(db.sql, graphScope);
    const progressMutations = await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(
        tx, scope, original, progress, hashPlanContent(original), hashPlanContent(progress),
      );
      await tx`UPDATE harness_shared.harness_plans SET content=${progress},content_hash=${hashPlanContent(progress)}`;
      return writePlanLineNodes(tx as unknown as Parameters<typeof writePlanLineNodes>[0],
        graphScope, beforeNodes, deriveIndexFromContent(progress).items);
    });
    expect(progressMutations).toEqual([]);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    const progressNodes = await readPlanLineNodes(db.sql, graphScope);
    expect(progressNodes[0]).toMatchObject({
      text: 'Preserve findings', status: 'wip', blockedBy: [], deliverable: 'code', phase: 'Phase 1',
    });

    const author = progress.replace(noteSuffix, ' — note: Author explanation');
    const authorMutations = await db.sql.begin(async tx => {
      await preservePlanExecutionProgress(
        tx, scope, progress, author, hashPlanContent(progress), hashPlanContent(author),
      );
      await tx`UPDATE harness_shared.harness_plans SET content=${author},content_hash=${hashPlanContent(author)}`;
      return writePlanLineNodes(tx as unknown as Parameters<typeof writePlanLineNodes>[0],
        graphScope, progressNodes, deriveIndexFromContent(author).items);
    });
    expect(authorMutations).toEqual([]);
    expect((await readExecutionPlanRow(scope))?.execution_start_revision_seq).toBeNull();
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
  });

  it('preserves and invalidates execution authority through the canonical locked content writer', async () => {
    // withPlanLock also reads plan admission metadata; this fixture intentionally
    // models that field lazily so the canonical content-writer path remains covered.
    await db.sql.unsafe('ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS acceptance_bar_rubric_slug text');
    await db.sql.unsafe("CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || ':00000:test' $$");
    const planCtx = { ...identity, harnessSlug: scope.harnessSlug };
    const writeOptions = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      slug: scope.planSlug, actorId: identity.ownerId, intent: 'execution-authority writer regression' };
    await db.sql`INSERT INTO harness_shared.session_briefs
      (owner_id,workspace_id,current_plan_slug,harness_slug,control_state)
      VALUES (${identity.ownerId},${scope.workspaceId},${scope.planSlug},${scope.harnessSlug},NULL)`;
    expect(await readExecutionPlanBindings(identity.ownerId, scope.workspaceId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ planSlug: scope.planSlug, harnessSlug: scope.harnessSlug })]),
    );
    // The direct fixture INSERT has not projected content-derived columns yet.
    // Run the canonical writer before issuing the receipt so this regression
    // isolates the subsequent Now-only edit instead of testing first-write
    // normalization of is_legacy/promote_policy as a structured input change.
    const canonicalWrite = await withPlanLock(planCtx, writeOptions, async current => {
      if (current === null) throw new Error('started plan disappeared before canonical setup write');
      return { newBody: current, value: null };
    });
    expect(canonicalWrite.kind).toBe('applied');
    const receipt = await issue();

    const progressWrite = await withPlanLock(planCtx, writeOptions, async current => {
      if (current === null) throw new Error('started plan disappeared before progress write');
      return { newBody: current.replace('Building', 'Testing'), value: null };
    });
    expect(progressWrite.kind).toBe('applied');
    const progressRow = await readExecutionPlanRow(scope);
    expect(progressRow?.execution_start_invalidation).toBeNull();
    expect(progressRow?.execution_start_revision_seq).toBe(receipt.seq);
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([]);
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} })).toBeNull();

    // Seq 76 added this exact untyped author note after start receipt 75. It is
    // not a typed operational-progress receipt, so execution meaning changes.
    const authorWrite = await withPlanLock(planCtx, writeOptions, async current => {
      if (current === null) throw new Error('started plan disappeared before author write');
      return { newBody: current.replace('Preserve findings',
        'Preserve findings — note: Canonical start75 and current executionReadiness ready; direct SELF implementation of existing shared PUI/native contracts continues.'), value: null };
    });
    expect(authorWrite.kind).toBe('applied');
    const invalidated = await readExecutionPlanRow(scope);
    expect(invalidated?.execution_start_revision_seq).toBeNull();
    expect(invalidated?.execution_start_invalidation).toMatchObject({
      schema: 'plan-execution-invalidation-v1', startRevisionSeq: receipt.seq, reason: 'plan_body_changed',
    });
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual(['plan_not_started']);
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} })).toMatchObject({ blockers: ['plan_not_started'] });
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

  it.each(['dangling','wrong-scope','invalid-scope','forged-rationale'])('fails closed for a %s referenced revision', async defect => {
    const receipt = await issue();
    if (defect === 'dangling') await db.sql`DELETE FROM harness_shared.plan_revisions WHERE seq=${receipt.seq}`;
    else if (defect === 'wrong-scope') await db.sql`UPDATE harness_shared.plan_revisions SET workspace_id='foreign' WHERE seq=${receipt.seq}`;
    else if (defect === 'invalid-scope') await db.sql`UPDATE harness_shared.plan_revisions
      SET content_snapshot=jsonb_set(content_snapshot::jsonb,'{scope,workspaceId}','"foreign"')::text WHERE seq=${receipt.seq}`;
    else await db.sql`UPDATE harness_shared.plan_revisions SET content_snapshot='plain plan body',
      rationale='plans:start completed canonical promotion, admission and claim binding' WHERE seq=${receipt.seq}`;
    expect(await readPlanExecutionStart(binding, scope.workspaceId)).toEqual([
      defect === 'dangling' || defect === 'wrong-scope' ? 'plan_start_revision_missing' : 'plan_start_revision_invalid',
    ]);
    expect(await checkPlanExecutionGuard({ ownerId: identity.ownerId, workspaceId: scope.workspaceId,
      toolName: 'apply_patch', args: {} }, { readBindings: async () => [binding], checkPlan: checkExecutionPlan }))
      .toMatchObject({ code: 'plan_execution_not_ready' });
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
