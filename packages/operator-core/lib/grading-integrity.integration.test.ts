import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import type { ScorecardRow, ScorecardGradingAuditCurrentness } from './scorecards';
import type { Rubric } from './rubrics';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, url: '' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./embedded-pg-discovery', async (original) => ({
  ...(await original<typeof import('./embedded-pg-discovery')>()),
  getHarnessAdminUrl: () => h.url,
}));

import {
  confirmPendingGradingAuditReservation,
  dispatchPendingGradingAudits,
  GRADING_AUDIT_DISPATCH_ACTOR,
  notifyRetainedGradingAuditor,
  promotePendingGradingAuditClaim,
  reconcilePendingGradingAudits,
  releasePendingGradingAudit,
  reservePendingGradingAudit,
  type DispatchPendingGradingAuditsDeps,
  type DispatchPendingGradingAuditsInput,
} from './grading-integrity';
import { _closeGradingAuditSubjectMutexForTests, isCurrentSourceAuditResponder } from './scorecards';
import { closeTask, getTask, listTasks, markSpawned, registerTask } from './task-manager/store';
import { ensureGradingAuditRuntime, retireUnusedGradingAuditRuntimes,
  type GradingAuditRuntimeDeps, type GradingAuditRuntimeLocator } from './release/grading-audit-runtime';
import { readGradingAuditSourcePin, writeGradingAuditSourcePin } from './release/grading-audit-source-pin';

const workspaceId = 'default';
const taskLedgerMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/696-task-ledger.sql', import.meta.url));
if (!existsSync(taskLedgerMigration)) throw new Error(`grading audit fixture migration missing: ${taskLedgerMigration}`);
const coordinationSubstrateMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/123-coordination-substrate.sql', import.meta.url));
if (!existsSync(coordinationSubstrateMigration)) throw new Error(`coordination substrate fixture migration missing: ${coordinationSubstrateMigration}`);
const coordinationConversationsMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/132-coordination-conversations.sql', import.meta.url));
if (!existsSync(coordinationConversationsMigration)) throw new Error(`coordination conversations fixture migration missing: ${coordinationConversationsMigration}`);
const consultThreadsMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url));
if (!existsSync(consultThreadsMigration)) throw new Error(`consult threads fixture migration missing: ${consultThreadsMigration}`);
const consultCascadeCursorMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url));
if (!existsSync(consultCascadeCursorMigration)) throw new Error(`consult cascade fixture migration missing: ${consultCascadeCursorMigration}`);
const issueId = 'EI-25100000000000005';
const replacementId = 'EI-25100000000000006';
const now = new Date('2026-10-06T08:00:00.000Z');
const reservation = { key: `grading-audit:${issueId}`, reservedAt: now.toISOString() };
const prior = { key: reservation.key, reservedAt: '2026-10-06T07:00:00.000Z' };
type LaunchHandler = NonNullable<DispatchPendingGradingAuditsDeps['launch']>;
type LaunchResult = Awaited<ReturnType<LaunchHandler>>;
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

function standardRubric(): Rubric {
  return { kind: 'standard' } as Rubric;
}

const backoff = {
  until: '2026-10-06T09:00:00.000Z', source: 'retry-window' as const,
  code: 'launch_failed', recordedAt: now.toISOString(), reason: 'fixture launch failed',
};
let db: FreshPgDb;
let prepared: postgres.Sql;

async function seed(id = issueId, gradingAudit: Record<string, unknown> = { state: 'pending' }) {
  const payload = JSON.stringify({
    _ei: { created_by: 'fixture-evaluator' },
    observation: {
      rubricRef: 'standard-rubric',
      evidenceFingerprint: 'fixture-evidence',
      gradingAudit,
    },
  });
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, payload)
    VALUES (${workspaceId}, 'papercusp', ${id}, 'change', ${payload}::text::jsonb)`;
}

async function readAudit(id = issueId): Promise<Record<string, unknown>> {
  const rows = await db.sql`
    SELECT payload->'observation'->'gradingAudit' AS audit
      FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND feature_id = ${id}`;
  return rows[0].audit;
}

async function registerRuntimeFixture(
  id: string,
  scratchRoot: string,
  buildSha: string,
  port: number,
  expiresAtSec: number,
): Promise<{ taskId: string; locator: GradingAuditRuntimeLocator }> {
  const evaluatorBuild = { sha: buildSha, version: '1.2.3' };
  const sourceRoot = join(scratchRoot, `.candidate-${buildSha}`, 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  const bundle = `fixture evaluator ${buildSha}`;
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, bundle);
  const ownerRef = 'grading-audit-runtime:' + createHash('sha256')
    .update(JSON.stringify([workspaceId, evaluatorBuild.sha, evaluatorBuild.version])).digest('hex');
  const locator: GradingAuditRuntimeLocator = {
    schemaVersion: 1, sourceRoot, bundlePath, ownerRef, evaluatorBuild,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'), expiresAtSec,
    baseUrl: `http://127.0.0.1:${port}`, issueIds: [id],
  };
  writeGradingAuditSourcePin(locator, Math.floor(now.getTime() / 1000));
  const task = await registerTask({ class: 'sidecar', title: ownerRef, argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
    detail: { label: ownerRef, gradingAuditRuntime: locator },
  }, { workspaceId }, db.sql);
  await markSpawned(task.taskId, {}, db.sql);
  return { taskId: task.taskId, locator };
}

async function reconcileRuntimeFixture(id: string, runtimeDeps: GradingAuditRuntimeDeps) {
  let cleanupPhase = false;
  const listCards: NonNullable<DispatchPendingGradingAuditsDeps['listScorecards']> = async filter => {
    if (!cleanupPhase) return [];
    const ids = filter?.issueIds ?? [id];
    const rows = await db.sql`
      SELECT feature_id, payload->'observation'->'gradingAudit' AS audit,
             payload->'observation'->>'rubricRef' AS rubric_ref,
             payload->'observation'->>'evidenceFingerprint' AS evidence_fingerprint,
             payload->'observation'->'rerunRecipe' AS rerun_recipe,
             payload->'observation'->>'supersededBy' AS superseded_by,
             payload->'observation'->'retracted' AS retracted
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids}::text[])`;
    return rows.map(row => ({ issueId: row.feature_id, rubricRef: row.rubric_ref,
      evidenceFingerprint: row.evidence_fingerprint, gradingAudit: row.audit,
      rerunRecipe: row.rerun_recipe, supersededBy: row.superseded_by, retracted: row.retracted })) as ScorecardRow[];
  };
  await reconcilePendingGradingAudits({ ctx: { workspaceId } as never, harness: 'papercusp', targetIds: [id] }, {
    listTasks: filter => listTasks(filter, db.sql),
    listScorecards: listCards,
    listWorkspaceWideLoopStanddownOwners: async () => new Set(),
    now: () => now.getTime(),
    retireRuntimes: async (ws, pendingIssueIds, _dispatchDeps, targetIds) => {
      cleanupPhase = true;
      await retireUnusedGradingAuditRuntimes(ws, pendingIssueIds, runtimeDeps, targetIds);
    },
    launch: async () => { throw new Error('retirement fixture must not launch an auditor'); },
  });
}

function runtimeRetirementDeps(nowSec: number): GradingAuditRuntimeDeps {
  return {
    now: () => nowSec * 1000,
    list: async (scope, label) => {
      const [live, history] = await Promise.all([
        listTasks({ workspaceId: scope, labelPrefix: label,
          states: ['pending', 'running', 'unaccounted'], limit: 2_000 }, db.sql),
        listTasks({ workspaceId: scope, labelPrefix: label, includeEnded: true,
          states: ['exited', 'killed', 'timed_out', 'stranded', 'ended_unobserved'], limit: 100 }, db.sql),
      ]);
      if (live.length >= 2_000) throw new Error('fixture runtime census is incomplete');
      return [...live, ...history];
    },
    mutex: async (_scope, _key, run) => run(),
    pendingAcceptanceRefs: async () => [],
    stop: async taskId => {
      await closeTask(taskId, { state: 'killed', exitReason: 'fixture runtime retired' }, db.sql, {
        emitTerminal: async () => {},
      });
    },
  };
}

async function cleanupRetirementFixture(taskIds: string[], scratchRoot: string) {
  for (const taskId of taskIds) {
    const task = await getTask(taskId, db.sql);
    if (task && (task.state === 'pending' || task.state === 'running' || task.state === 'unaccounted')) {
      await closeTask(taskId, { state: 'killed', exitReason: 'fixture cleanup' }, db.sql, {
        emitTerminal: async () => {},
      });
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
}

beforeAll(async () => {
  db = await createFreshPgDb('grading-audit-writes');
  h.sql = db.sql;
  h.url = db.url;
  prepared = postgres(db.url, { max: 2, onnotice: () => {} });
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await applyMigrationForTest(db.sql, taskLedgerMigration);
  // 834 widens the consult kind on coord_conversations, so replay the production
  // substrate/conversation prerequisites before applying it. createFreshPgDb
  // provisions an empty schema and never replays migrations on its own.
  await applyMigrationForTest(db.sql, coordinationSubstrateMigration);
  await applyMigrationForTest(db.sql, coordinationConversationsMigration);
  await applyMigrationForTest(db.sql, consultThreadsMigration);
  await applyMigrationForTest(db.sql, consultCascadeCursorMigration);
});

beforeEach(async () => {
  h.sql = db.sql;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.task_ledger`;
});

afterAll(async () => {
  await _closeGradingAuditSubjectMutexForTests();
  await prepared?.end({ timeout: 5 });
  await db?.cleanup();
});

describe.each([false, true])('grading audit JSON writes with prepare=%s', (prepare) => {
  beforeEach(() => { h.sql = prepare ? prepared : db.sql; });

  it('retires only a quota backoff after route recovery without bypassing a live lease', async () => {
    const quota = { ...backoff, code: 'model_quota_exhausted' };
    await seed(issueId, { state: 'pending', dispatchBackoff: quota });
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now }))
      .toMatchObject({ status: 'quota-backoff' });
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'claimed' });
    expect(await readAudit()).not.toHaveProperty('dispatchBackoff');
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'already-reserved' });
  });

  it('keeps non-quota backoffs even when the requested route can serve', async () => {
    await seed(issueId, { state: 'pending', dispatchBackoff: backoff });
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'dispatch-backoff' });
    expect(await readAudit()).toHaveProperty('dispatchBackoff', backoff);
  });

  it('clears a live generation-incompatible backoff only after compatibility is proven', async () => {
    const generationBackoff = { ...backoff, code: 'generation_incompatible',
      reason: 'the previous dispatcher did not contain the graded generation' };
    await seed(issueId, { state: 'pending', dispatchBackoff: generationBackoff });

    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now }))
      .toEqual({ status: 'dispatch-backoff', backoff: generationBackoff });
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowGenerationIncompatibleBackoff: true,
    })).toMatchObject({ status: 'claimed', reservation });
    expect(await readAudit()).not.toHaveProperty('dispatchBackoff');
  });

  it('reports a fresh dispatch claim when the compatible backoff override loses the claim race', async () => {
    const generationBackoff = { ...backoff, code: 'generation_incompatible',
      reason: 'the previous dispatcher did not contain the graded generation' };
    const liveClaim = {
      key: reservation.key,
      reservedAt: new Date(now.getTime() - 60_000).toISOString(),
    };
    await seed(issueId, {
      state: 'pending',
      dispatchBackoff: generationBackoff,
      dispatchClaim: liveClaim,
    });

    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowGenerationIncompatibleBackoff: true,
    })).toEqual({ status: 'already-reserved' });
    expect(await readAudit()).toMatchObject({
      dispatchBackoff: generationBackoff,
      dispatchClaim: liveClaim,
    });
    expect(await readAudit()).not.toHaveProperty('dispatchReservation');
  });

  it('stores both reservation fields as objects and confirms the exact lease', async () => {
    await seed();
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now }))
      .toEqual({ status: 'claimed', reservation });
    expect(await readAudit()).toMatchObject({ dispatchReservation: reservation, lastDispatchReservation: reservation });
    expect(await confirmPendingGradingAuditReservation(issueId, reservation.key, {
      workspaceId, reservedAt: reservation.reservedAt,
    })).toBe(true);
    expect(await confirmPendingGradingAuditReservation(issueId, reservation.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(false);
  });

  it('keeps the auditor lease visible while one dispatcher checks a retained task', async () => {
    await seed(issueId, { state: 'pending', dispatchReservation: prior, lastDispatchReservation: prior });
    const claim = await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    expect(claim).toMatchObject({ status: 'claimed', reservation: prior, dispatchClaim: reservation });
    // A separate read during slow task/native checks must still authorize the
    // original auditor, before any replacement notice could have been saved.
    expect(await readAudit()).toMatchObject({ dispatchReservation: prior, lastDispatchReservation: prior });
    expect(await confirmPendingGradingAuditReservation(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(true);
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now: new Date(now.getTime() + 1_000), preserveAuditorLease: true,
    })).toMatchObject({ status: 'already-reserved' });
    // An unclaimed cleanup path cannot erase this dispatcher's election.
    expect(await releasePendingGradingAudit(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(false);
    expect(await promotePendingGradingAuditClaim(issueId, prior, {
      ...reservation, reservedAt: new Date(now.getTime() + 1_000).toISOString(),
    }, workspaceId)).toBe(false);
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(true);
    expect(await readAudit()).toMatchObject({ dispatchReservation: reservation, lastDispatchReservation: reservation });
    expect((await readAudit()).dispatchClaim).toBeUndefined();
  });

  it('retains the auditor epoch on release and cannot promote after settlement or a competing claim', async () => {
    await seed(issueId, { state: 'pending', dispatchReservation: prior, lastDispatchReservation: prior });
    await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    expect(await releasePendingGradingAudit(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt, dispatchClaimReservedAt: reservation.reservedAt, restore: prior,
    })).toBe(true);
    expect(await readAudit()).toMatchObject({ dispatchReservation: prior, lastDispatchReservation: prior });
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(false);
    await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{observation,gradingAudit,state}', '"passed"'::jsonb)
      WHERE workspace_id = ${workspaceId} AND feature_id = ${issueId}`;
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(false);
  });

  it.each(['restore-and-backoff', 'restore', 'backoff'] as const)('round-trips the %s release branch', async (branch) => {
    await seed(issueId, { state: 'pending', dispatchReservation: reservation });
    const restore = branch !== 'backoff' ? prior : undefined;
    const suppression = branch !== 'restore' ? backoff : undefined;
    expect(await releasePendingGradingAudit(issueId, reservation.key, {
      workspaceId, reservedAt: reservation.reservedAt, restore, backoff: suppression,
    })).toBe(true);
    const audit = await readAudit();
    expect(audit.dispatchReservation).toEqual(restore);
    expect(audit.lastDispatchReservation).toEqual(restore ?? reservation);
    expect(audit.dispatchBackoff).toEqual(suppression);
  });

  it('reopens an obsolete settled rubric as an object with the new exact identity', async () => {
    await seed(issueId, { state: 'passed', rubricRevision: 5, criteriaHash: 'old-hash' });
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'stale', reason: 'revision-mismatch', recordedRevision: 5, currentRevision: 6,
      recordedCriteriaHash: 'old-hash', currentCriteriaHash: 'new-hash',
    };
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, currentness }))
      .toEqual({ status: 'claimed', reservation });
    expect(await readAudit()).toEqual({
      state: 'pending', metaRubricRef: 'grading-integrity', rubricRevision: 6, criteriaHash: 'new-hash',
      stampedAt: now.toISOString(), dispatchReservation: reservation, lastDispatchReservation: reservation,
    });
  });
});

it('atomically rebinds a recovered evaluator and rolls it back when auditor independence changes', async () => {
  await seed(issueId, { state: 'pending', dispatchReservation: reservation });
  const task = await registerTask({
    class: 'agent-session', title: 'retained evaluator renewal', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp', workItemId: issueId,
    detail: { label: reservation.key, coordOwnerId: 'su-retained-auditor', keep: 'unrelated',
      gradingAuditRuntimeBinding: { baseUrl: 'http://127.0.0.1:42457' } },
  }, { workspaceId }, db.sql);
  const target = { issueId, createdBy: 'fixture-evaluator', rubricRef: 'standard-rubric',
    evidenceFingerprint: 'fixture-evidence' } as ScorecardRow;
  const runtime = { taskId: 'runtime-recovered', baseUrl: 'http://127.0.0.1:33015',
    evaluatorBuild: { sha: 'exact-evaluator', version: '1.2.3' }, bundleSha256: 'b'.repeat(64),
    expiresAtSec: Math.floor(Date.now() / 1000) + 3600 };
  type RenewalDeps = NonNullable<Parameters<typeof notifyRetainedGradingAuditor>[1]>;
  const { PgCoordLog, ensureCoordEventLogTable } = await import('@papercusp/coordination/event-log');
  await ensureCoordEventLogTable(h.sql);
  const log = new PgCoordLog({ getSql: () => h.sql, workspaceId, ensureSchema: async () => {} });
  const resolveParties = vi.fn<NonNullable<RenewalDeps['resolveParties']>>(async ids =>
    new Map(ids.filter((id): id is string => typeof id === 'string').map(id => [id, id])));
  const send = vi.fn<NonNullable<RenewalDeps['send']>>(async (identity, options) =>
    options.persistEnvelope!({ msg_id: options.msgId!, from: identity.ownerId, to: options.to,
      kind: 'message', ts: now.toISOString(), summary: options.summary, body: options.body }));
  const wake = vi.fn<NonNullable<RenewalDeps['wake']>>().mockResolvedValue({ targets: ['su-retained-auditor'],
    keys: [], woken: 1, queued: 1, pickupConfirmed: false } as unknown as Awaited<ReturnType<NonNullable<RenewalDeps['wake']>>>);
  const deps = { append: log.appendLineIfAbsent.bind(log), resolveParties, send, wake };
  const input = { card: target, task, reservation, workspaceId, runtime };
  const delivered = await notifyRetainedGradingAuditor(input, deps);
  expect(delivered.reason).toBeUndefined();
  expect(delivered).toMatchObject({ state: 'delivered' });
  expect((await getTask(task.taskId, db.sql))?.detail).toMatchObject({
    keep: 'unrelated', gradingAuditRuntimeBinding: runtime,
    gradingAudit: { issueId, evidenceFingerprint: 'fixture-evidence', reservation },
  });
  expect(send.mock.calls[0]![1].body).toContain(runtime.baseUrl);

  // This fence runs AFTER the task UPDATE; the real replay transaction must
  // roll that update back together with the rejected notification append.
  resolveParties.mockResolvedValue(new Map([
    ['fixture-evaluator', 'same-party'], ['su-retained-auditor', 'same-party'],
  ]));
  const replacement = { ...runtime, taskId: 'runtime-uncommitted', baseUrl: 'http://127.0.0.1:33016' };
  expect(await notifyRetainedGradingAuditor({ ...input, runtime: replacement }, deps))
    .toMatchObject({ state: 'failed', reason: 'retained auditor independence is not proven' });
  expect((await getTask(task.taskId, db.sql))?.detail.gradingAuditRuntimeBinding).toEqual(runtime);
  expect(wake).toHaveBeenCalledTimes(1);
});

it('recovers the exact evaluator route before persisting and waking its retained auditor', async () => {
  const ownerId = 'su-retained-recovery-auditor';
  const issueReservation = { key: `grading-audit:${issueId}`, reservedAt: new Date().toISOString() };
  const evaluatorBuild = { sha: 'exact123456', version: '1.2.3' };
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-retained-recovery-'));
  const sourceRoot = join(scratchRoot, '.candidate-runtime-recovery', 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  const bundle = 'exact retained evaluator recovery fixture';
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, bundle);
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  const ownerRef = 'grading-audit-runtime:' + createHash('sha256')
    .update(JSON.stringify([workspaceId, evaluatorBuild.sha, evaluatorBuild.version])).digest('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  const locator: GradingAuditRuntimeLocator = {
    schemaVersion: 1, sourceRoot, bundlePath, ownerRef, evaluatorBuild, bundleSha256,
    expiresAtSec: nowSec + 3600, baseUrl: 'http://127.0.0.1:43123', issueIds: [issueId],
  };
  const taskIds: string[] = [];
  try {
    writeGradingAuditSourcePin(locator, nowSec);
    const lostRuntimeTask = await registerTask({
      class: 'sidecar', title: ownerRef, argv: [], launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
      detail: { label: ownerRef, gradingAuditRuntime: locator },
    }, { workspaceId }, db.sql);
    taskIds.push(lostRuntimeTask.taskId);
    await markSpawned(lostRuntimeTask.taskId, {}, db.sql);
    const staleBinding = { taskId: lostRuntimeTask.taskId, baseUrl: locator.baseUrl,
      evaluatorBuild, bundleSha256, expiresAtSec: locator.expiresAtSec };
    const auditorTask = await registerTask({
      class: 'agent-session', title: 'retained independent grading auditor', argv: [],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp', workItemId: issueId,
      detail: { label: issueReservation.key, coordOwnerId: ownerId, gradingAuditRuntimeBinding: staleBinding },
    }, { workspaceId }, db.sql);
    taskIds.push(auditorTask.taskId);
    await markSpawned(auditorTask.taskId, {}, db.sql);
    await closeTask(lostRuntimeTask.taskId,
      { state: 'killed', exitReason: 'fixture evaluator process lost' }, db.sql, { emitTerminal: async () => {} });
    const lostRuntimeRow = await getTask(lostRuntimeTask.taskId, db.sql);
    expect(lostRuntimeRow?.state).toBe('killed');

    let recoveredRuntimeTaskId = '';
    const runtimeDeps: GradingAuditRuntimeDeps = {
      now: () => nowSec * 1000,
      list: async () => lostRuntimeRow ? [lostRuntimeRow] : [],
      currentSource: () => { throw new Error('recovery must use the retained exact source pin'); },
      mutex: async (_workspace, _key, run) => run(),
      taskState: async taskId => (await getTask(taskId, db.sql))?.state ?? null,
      spawn: async (taskWorkspace, recoveredLocator) => {
        const task = await registerTask({
          class: 'sidecar', title: recoveredLocator.ownerRef, argv: [],
          launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
          detail: { label: recoveredLocator.ownerRef, gradingAuditRuntime: recoveredLocator },
        }, { workspaceId: taskWorkspace }, db.sql);
        taskIds.push(task.taskId);
        recoveredRuntimeTaskId = task.taskId;
        await markSpawned(task.taskId, {}, db.sql);
        return task.taskId;
      },
      probe: async () => ({ status: 'ready', build: evaluatorBuild }),
    };
    const recovered = await ensureGradingAuditRuntime({
      workspaceId, issueId, evaluatorBuild, allowSeed: false,
    }, runtimeDeps);
    expect(recovered.taskId).toBe(recoveredRuntimeTaskId);
    expect(recovered.taskId).not.toBe(lostRuntimeTask.taskId);
    expect(recovered).toMatchObject({ baseUrl: locator.baseUrl, evaluatorBuild, bundleSha256 });

    const target = { issueId, createdBy: 'fixture-evaluator', rubricRef: 'standard-rubric',
      evidenceFingerprint: 'fixture-evidence' } as ScorecardRow;
    const { PgCoordLog, ensureCoordEventLogTable } = await import('@papercusp/coordination/event-log');
    await ensureCoordEventLogTable(db.sql);
    const log = new PgCoordLog({ getSql: () => db.sql, workspaceId, ensureSchema: async () => {} });
    type RenewalDeps = NonNullable<Parameters<typeof notifyRetainedGradingAuditor>[1]>;
    const send = vi.fn<NonNullable<RenewalDeps['send']>>(async (identity, options) =>
      options.persistEnvelope!({ msg_id: options.msgId!, from: identity.ownerId, to: options.to,
        kind: 'message', ts: now.toISOString(), summary: options.summary, body: options.body }));
    const wake = vi.fn<NonNullable<RenewalDeps['wake']>>().mockResolvedValue({
      targets: [ownerId], keys: [], woken: 1, queued: 1, pickupConfirmed: false,
    } as unknown as Awaited<ReturnType<NonNullable<RenewalDeps['wake']>>>);
    const resolveParties: NonNullable<RenewalDeps['resolveParties']> = async ids =>
      new Map(ids.filter((id): id is string => typeof id === 'string').map(id => [id, id]));
    const auditor = await getTask(auditorTask.taskId, db.sql);
    expect(auditor?.state).toBe('running');
    const notice = await notifyRetainedGradingAuditor({
      card: target, task: auditor!, reservation: issueReservation, workspaceId, harness: 'papercusp', runtime: recovered,
    }, { append: log.appendLineIfAbsent.bind(log), send, wake, resolveParties,
      confirmReservation: async () => true, mutex: async (_workspace, _issueId, run) => run() });
    expect(notice).toMatchObject({ state: 'delivered', ownerId, queued: 1, pickupConfirmed: false });
    expect(send.mock.calls[0]![1].body).toContain(recovered.baseUrl);
    expect(send.mock.calls[0]![1].body).toContain(recovered.taskId);
    expect((await getTask(auditorTask.taskId, db.sql))?.detail.gradingAuditRuntimeBinding).toEqual(recovered);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toEqual([ownerId]);
    expect(wake.mock.calls[0]![1]).toMatchObject({
      payload: { gradingAuditRuntimeBinding: recovered },
    });
  } finally {
    for (const taskId of taskIds) await closeTask(taskId,
      { state: 'killed', exitReason: 'fixture cleanup' }, db.sql, { emitTerminal: async () => {} });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

it('binds a no-consult direct fallback lease to the live grading task owner', async () => {
  await seed(issueId, { state: 'pending', dispatchReservation: reservation });
  const task = await registerTask({
    class: 'agent-session', title: 'direct fallback grading auditor', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp',
    detail: { label: reservation.key, coordOwnerId: 'su-dispatched-auditor',
      gradingAudit: { issueId, reservation } },
  }, { workspaceId }, db.sql);

  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-dispatched-auditor'))
    .toBe(true);
  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-unrelated-session'))
    .toBe(false);

  await closeTask(task.taskId, { state: 'killed', exitReason: 'fixture complete' }, db.sql, {
    emitTerminal: async () => {},
  });
  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-dispatched-auditor'))
    .toBe(false);
});

it('retires cancelled missions from real private ledgers and preserves a pending replacement', async () => {
  await seed(issueId, { state: 'cancelled', stampedAt: prior.reservedAt });
  await seed(replacementId, { state: 'pending', stampedAt: prior.reservedAt });
  const tasks = await Promise.all([issueId, issueId, replacementId].map((target) => registerTask({
    class: 'agent-session', title: 'private cancelled-audit fixture', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp',
    detail: { label: `grading-audit:${target}` },
  }, { workspaceId }, db.sql)));
  // The changed reconciler selects the missions. The unchanged OS termination
  // seam closes disposable task rows; this fixture launches no provider/session.
  const killTask = vi.fn(async (taskId: string) => {
    await closeTask(taskId, { state: 'killed', exitReason: 'cancelled fixture audit' }, db.sql, {
      emitTerminal: async () => {},
    });
    return { ok: true as const, taskId, action: 'kill' as const };
  });
  const launch = vi.fn(async () => { throw new Error('cancelled audit must never launch'); });
  await reconcilePendingGradingAudits({ ctx: { workspaceId } as never, harness: 'papercusp', targetIds: [issueId] }, {
    listTasks: (filter) => listTasks(filter, db.sql),
    listScorecards: async (filter) => {
      const rows = await db.sql`
        SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${filter?.issueIds ?? []}::text[])`;
      return rows.map((row) => ({ issueId: row.feature_id, rubricRef: 'spec-test-adequacy',
        gradingAudit: row.audit })) as ScorecardRow[];
    },
    listWorkspaceWideLoopStanddownOwners: async () => new Set(),
    killTask, launch, now: () => now.getTime(),
  });
  expect(killTask.mock.calls.map(([id]) => id).sort()).toEqual(tasks.slice(0, 2).map((t) => t.taskId).sort());
  expect((await getTask(tasks[0].taskId, db.sql))?.state).toBe('killed');
  expect((await getTask(tasks[1].taskId, db.sql))?.state).toBe('killed');
  expect((await getTask(tasks[2].taskId, db.sql))?.state).toBe('pending');
  expect(launch).not.toHaveBeenCalled();
});

it('keeps a shared source pin while a same-build runtime sibling still needs it', async () => {
  const id = 'EI-25100000000000035';
  const nowSec = Math.floor(now.getTime() / 1000);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-shared-pin-'));
  const taskIds: string[] = [];
  try {
    await seed(id, { state: 'pending' });
    const first = await registerRuntimeFixture(id, scratchRoot, 'cccccccccc', 43229, nowSec + 3600);
    taskIds.push(first.taskId);
    const second = await registerRuntimeFixture(id, scratchRoot, 'cccccccccc', 43230, nowSec + 3600);
    taskIds.push(second.taskId);
    expect(second.locator.sourceRoot).toBe(first.locator.sourceRoot);
    expect(second.locator.ownerRef).toBe(first.locator.ownerRef);

    await reconcileRuntimeFixture(id, runtimeRetirementDeps(nowSec));

    const states = await Promise.all(taskIds.map(async taskId => (await getTask(taskId, db.sql))?.state));
    expect(states.filter(state => state === 'running')).toHaveLength(1);
    expect(readGradingAuditSourcePin(first.locator.sourceRoot, first.locator.ownerRef, nowSec)).not.toBeNull();
  } finally {
    await cleanupRetirementFixture(taskIds, scratchRoot);
  }
});

it('keeps one newest pinned sibling for an unbound pending audit and retires older roots', async () => {
  const id = 'EI-25100000000000030';
  const nowSec = Math.floor(now.getTime() / 1000);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-sibling-retirement-'));
  const taskIds: string[] = [];
  try {
    await seed(id, { state: 'pending' });
    const older = await registerRuntimeFixture(id, scratchRoot, 'aaaaaaaaaa', 43221, nowSec + 1800);
    taskIds.push(older.taskId);
    const newest = await registerRuntimeFixture(id, scratchRoot, 'bbbbbbbbbb', 43222, nowSec + 3600);
    taskIds.push(newest.taskId);

    await reconcileRuntimeFixture(id, runtimeRetirementDeps(nowSec));

    expect((await getTask(older.taskId, db.sql))?.state).toBe('killed');
    expect((await getTask(newest.taskId, db.sql))?.state).toBe('running');
    expect(readGradingAuditSourcePin(older.locator.sourceRoot, older.locator.ownerRef, nowSec)).toBeNull();
    expect(readGradingAuditSourcePin(newest.locator.sourceRoot, newest.locator.ownerRef, nowSec)).not.toBeNull();
  } finally {
    await cleanupRetirementFixture(taskIds, scratchRoot);
  }
});

it('keeps the exact recorded evaluator sibling when a newer unbound build is present', async () => {
  const id = 'EI-25100000000000034';
  const nowSec = Math.floor(now.getTime() / 1000);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-exact-sibling-'));
  const taskIds: string[] = [];
  try {
    await seed(id, { state: 'pending' });
    const exact = await registerRuntimeFixture(id, scratchRoot, 'aaaaaaaaaa', 43227, nowSec + 1800);
    taskIds.push(exact.taskId);
    const newer = await registerRuntimeFixture(id, scratchRoot, 'bbbbbbbbbb', 43228, nowSec + 3600);
    taskIds.push(newer.taskId);
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{observation,rerunRecipe}',
        ${db.sql.json({ evaluatorBuild: exact.locator.evaluatorBuild } as unknown as postgres.JSONValue)})
      WHERE workspace_id = ${workspaceId} AND feature_id = ${id}`;
    const [persistedRecipe] = await db.sql<Array<{ rerun_recipe: unknown }>>`
      SELECT payload->'observation'->'rerunRecipe' AS rerun_recipe
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${id}`;
    expect(persistedRecipe?.rerun_recipe).toEqual({ evaluatorBuild: exact.locator.evaluatorBuild });

    await reconcileRuntimeFixture(id, runtimeRetirementDeps(nowSec));

    expect((await getTask(exact.taskId, db.sql))?.state).toBe('running');
    expect((await getTask(newer.taskId, db.sql))?.state).toBe('killed');
    expect(readGradingAuditSourcePin(exact.locator.sourceRoot, exact.locator.ownerRef, nowSec)).not.toBeNull();
    expect(readGradingAuditSourcePin(newer.locator.sourceRoot, newer.locator.ownerRef, nowSec)).toBeNull();
  } finally {
    await cleanupRetirementFixture(taskIds, scratchRoot);
  }
});

it('keeps the active sibling bound to the current reservation even when another root is newer', async () => {
  const id = 'EI-25100000000000031';
  const nowSec = Math.floor(now.getTime() / 1000);
  const lease = { key: `grading-audit:${id}`, reservedAt: now.toISOString() };
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-active-sibling-'));
  const taskIds: string[] = [];
  try {
    await seed(id, { state: 'pending', dispatchReservation: lease });
    const active = await registerRuntimeFixture(id, scratchRoot, 'aaaaaaaaaa', 43223, nowSec + 1800);
    taskIds.push(active.taskId);
    const newer = await registerRuntimeFixture(id, scratchRoot, 'bbbbbbbbbb', 43224, nowSec + 3600);
    taskIds.push(newer.taskId);
    const auditor = await registerTask({ class: 'agent-session', title: 'fixture retained auditor', argv: [],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp', workItemId: id,
      detail: { label: `grading-audit:${id}`, coordOwnerId: 'su-fixture-auditor',
        gradingAuditRuntimeBinding: { taskId: active.taskId, baseUrl: active.locator.baseUrl,
          evaluatorBuild: active.locator.evaluatorBuild, bundleSha256: active.locator.bundleSha256,
          expiresAtSec: active.locator.expiresAtSec },
        gradingAudit: { issueId: id, evidenceFingerprint: 'fixture-evidence', reservation: lease } },
    }, { workspaceId }, db.sql);
    taskIds.push(auditor.taskId);
    await markSpawned(auditor.taskId, {}, db.sql);

    await reconcileRuntimeFixture(id, runtimeRetirementDeps(nowSec));

    expect((await getTask(active.taskId, db.sql))?.state).toBe('running');
    expect((await getTask(newer.taskId, db.sql))?.state).toBe('killed');
    expect(readGradingAuditSourcePin(active.locator.sourceRoot, active.locator.ownerRef, nowSec)).not.toBeNull();
    expect(readGradingAuditSourcePin(newer.locator.sourceRoot, newer.locator.ownerRef, nowSec)).toBeNull();
  } finally {
    await cleanupRetirementFixture(taskIds, scratchRoot);
  }
});

it('retires every sibling root after the pending audit card is superseded', async () => {
  const id = 'EI-25100000000000032';
  const supersedingId = 'EI-25100000000000033';
  const nowSec = Math.floor(now.getTime() / 1000);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'grading-audit-superseded-sibling-'));
  const taskIds: string[] = [];
  try {
    await seed(id, { state: 'passed', auditedAt: now.toISOString() });
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{observation,supersededBy}', ${JSON.stringify(supersedingId)}::jsonb)
      WHERE workspace_id = ${workspaceId} AND feature_id = ${id}`;
    const first = await registerRuntimeFixture(id, scratchRoot, 'aaaaaaaaaa', 43225, nowSec + 1800);
    taskIds.push(first.taskId);
    const second = await registerRuntimeFixture(id, scratchRoot, 'bbbbbbbbbb', 43226, nowSec + 3600);
    taskIds.push(second.taskId);

    await reconcileRuntimeFixture(id, runtimeRetirementDeps(nowSec));

    expect((await getTask(first.taskId, db.sql))?.state).toBe('killed');
    expect((await getTask(second.taskId, db.sql))?.state).toBe('killed');
    expect(readGradingAuditSourcePin(first.locator.sourceRoot, first.locator.ownerRef, nowSec)).toBeNull();
    expect(readGradingAuditSourcePin(second.locator.sourceRoot, second.locator.ownerRef, nowSec)).toBeNull();
  } finally {
    await cleanupRetirementFixture(taskIds, scratchRoot);
  }
});

it('commits Discovery admission before slow spec-quality routing can idle out its transaction', async () => {
  await seed(issueId, { state: 'pending', stampedAt: prior.reservedAt });
  await db.sql`UPDATE harness_shared.work_items
    SET payload = jsonb_set(payload, '{observation,rubricRef}', '"spec-quality"'::jsonb)
    WHERE workspace_id = ${workspaceId} AND feature_id = ${issueId}`;
  const guard = postgres(db.url, { max: 1, onnotice: () => {} });
  let backendPid = 0;
  let reservationWasProtected = false;
  let routingState: string | undefined;
  type DiscoveryGate = NonNullable<DispatchPendingGradingAuditsDeps['withCurrentDiscovery']>;
  // Exercise the real transaction lifetime at the injected Discovery boundary;
  // the existing refusal test independently guards Discovery's admission policy.
  const withCurrentDiscovery: DiscoveryGate = async (_input, accept) => guard.begin(async tx => {
    await tx`SET LOCAL idle_in_transaction_session_timeout = '500ms'`;
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    backendPid = backend.pid;
    return { ok: true as const, result: await accept(tx as never, {} as never) };
  });
  const card: ScorecardRow = {
    issueId, createdAt: now.toISOString(), createdBy: 'fixture-evaluator', rubricRef: 'spec-quality',
    subject: { kind: 'plan', ref: 'spec-set:registered-subject' },
    ratings: {}, nKeys: 0, missingKeys: [], extraKeys: [], rubricResolved: true,
    synthesized: false, score10: null, linkedItems: [], evidenceFingerprint: 'fixture-evidence',
    gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: prior.reservedAt },
  };
  const launch: LaunchHandler = vi.fn(async () => { throw new Error('routed audit must not launch twice'); });
  try {
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId],
      ctx: { workspaceId, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'] }, {
      listScorecards: async () => [card], getRubric: async () => standardRubric(),
      getEvaluatorBuild: () => ({ sha: 'fixture-evaluator', version: '1.0.0' }),
      resolveSpecQualityPlanSubject: async () => ({ planSlug: 'review-plan', harnessSlug: 'papercusp' }),
      withCurrentDiscovery,
      reserve: async (...args) => {
        const [backend] = await db.sql`SELECT state FROM pg_stat_activity WHERE pid = ${backendPid}`;
        reservationWasProtected = backend?.state === 'idle in transaction';
        return reservePendingGradingAudit(...args);
      },
      route: async () => {
        const [backend] = await db.sql`SELECT state FROM pg_stat_activity WHERE pid = ${backendPid}`;
        routingState = backend?.state;
        // Longer than the unchanged transaction idle budget. The old dispatcher
        // loses this exact backend here, then throws when Discovery commits.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return { state: 'routed', conversationId: 'private-independent-audit' };
      },
      listTasks: async () => [], launch,
      listWorkspaceWideLoopStanddownOwners: async () => new Set(),
    });
    expect(reservationWasProtected).toBe(true);
    expect(routingState).toBe('idle');
    expect(result.receipts[0]).toMatchObject({ state: 'routed', conversationId: 'private-independent-audit' });
    expect((await readAudit()).dispatchReservation).toMatchObject({ key: reservation.key });
    expect(launch).not.toHaveBeenCalled();
  } finally {
    await guard.end({ timeout: 1 });
  }
});

it('persists retained grading-auditor work-item custody and suppresses a duplicate launch', async () => {
  const ownerId = 'su-retained-auditor';
  await seed(issueId, { state: 'pending', stampedAt: prior.reservedAt });
  const liveTask = await registerTask({
    class: 'agent-session',
    title: 'live independent grading auditor',
    argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
    harnessSlug: 'papercusp',
    workItemId: issueId,
    detail: { label: reservation.key, coordOwnerId: ownerId },
  }, { workspaceId }, db.sql);
  await markSpawned(liveTask.taskId, {}, db.sql);

  const exactTasks = await listTasks({
    workspaceId,
    workItemId: issueId,
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 10,
  }, db.sql);
  expect(exactTasks.map((task) => task.taskId)).toEqual([liveTask.taskId]);

  const launch: LaunchHandler = vi.fn(async () => { throw new Error('duplicate grading auditor launch'); });
  const result = await dispatchPendingGradingAudits(
    {
      targetIds: [issueId],
      ctx: { workspaceId, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'],
      harness: 'papercusp',
    },
    {
      listScorecards: async (filter) => {
        const rows = await db.sql`
          SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ANY(${filter?.issueIds ?? [issueId]}::text[])`;
        return rows.map((row): ScorecardRow => ({
          issueId: row.feature_id,
          createdAt: now.toISOString(),
          createdBy: 'fixture-evaluator',
          rubricRef: 'standard-rubric',
          ratings: {},
          nKeys: 0,
          missingKeys: [],
          extraKeys: [],
          rubricResolved: true,
          synthesized: false,
          score10: null,
          linkedItems: [],
          evidenceFingerprint: 'fixture-evidence',
          gradingAudit: row.audit,
        }));
      },
      getRubric: async () => standardRubric(),
      listTasks: (filter) => listTasks(filter, db.sql),
      readRetainedTaskKernelVerdicts: async () => new Map(),
      isCurrentSourceAuditResponder: async () => true,
      listWorkspaceWideLoopStanddownOwners: async () => new Set(),
      launch,
    },
  );

  expect(result.receipts[0]).toMatchObject({
    issueId,
    state: 'deduped',
    launch: {
      deduped: true,
      mode: 'live-task-guard',
      tasks: [{ taskId: liveTask.taskId }],
    },
  });
  expect(launch).not.toHaveBeenCalled();
});

it('rebinds a live null-session auditor to its paced 429 transcript before launching an independent replacement', async () => {
  const ownerId = 'su-retained-auditor';
  const sessionId = 'native-retained-session';
  const taskLogPath = '/tmp/grading-retained-native.log';
  const nativeTranscriptPath = '/tmp/grading-retained-native.jsonl';
  const nativeTranscript = JSON.stringify({
    type: 'assistant',
    sessionId,
    isSidechain: false,
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API error' }] },
  });
  const pacedLog =
    "API Error: Request rejected (429) · inference-gateway: account 'aviynw4' paced/paused; retry after 60s";

  await seed(issueId, { state: 'pending', stampedAt: prior.reservedAt });
  const liveTask = await registerTask({
    class: 'agent-session',
    title: 'live independent grading auditor',
    argv: [],
    logPath: taskLogPath,
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
    harnessSlug: 'papercusp',
    detail: { label: reservation.key, coordOwnerId: ownerId },
  }, { workspaceId }, db.sql);
  await markSpawned(liveTask.taskId, {}, db.sql);
  expect((await getTask(liveTask.taskId, db.sql))?.sessionId).toBeNull();

  const bindTaskNativeSession = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['bindTaskNativeSession']>>()
    .mockResolvedValue(sessionId);
  const listNativeSessions = vi.fn<
    NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>
  >().mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
  const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
    .mockResolvedValue(nativeTranscriptPath);
  const killTask = vi.fn(async (taskId: string) => {
    await closeTask(taskId, { state: 'killed', exitReason: 'paced gateway 429 fixture' }, db.sql, {
      emitTerminal: async () => {},
    });
    return { ok: true as const, taskId, action: 'kill' as const };
  });
  const launchCalls: Array<Parameters<LaunchHandler>> = [];
  const launch: LaunchHandler = async (...args) => {
    launchCalls.push(args);
    return launchResult({
      deduped: false,
      launch: { opened: 1, tasks: [{ taskId: 'task-retained-fallback', logPath: '/tmp/grading-retained-fallback.log' }] },
      agentStarted: true,
    });
  };

  const result = await dispatchPendingGradingAudits(
    {
      targetIds: [issueId],
      ctx: { workspaceId, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'],
      harness: 'papercusp',
    },
    {
      listScorecards: async (filter) => {
        const rows = await db.sql`
          SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ANY(${filter?.issueIds ?? [issueId]}::text[])`;
        return rows.map((row): ScorecardRow => ({
          issueId: row.feature_id,
          createdAt: now.toISOString(),
          createdBy: 'fixture-evaluator',
          rubricRef: 'standard-rubric',
          ratings: {},
          nKeys: 0,
          missingKeys: [],
          extraKeys: [],
          rubricResolved: true,
          synthesized: false,
          score10: null,
          linkedItems: [],
          evidenceFingerprint: 'fixture-evidence',
          gradingAudit: row.audit,
        }));
      },
      getRubric: async () => standardRubric(),
      route: async () => ({ state: 'fallback', reason: 'fixture preserves the independent launch path' }),
      listTasks: (filter) => listTasks(filter, db.sql),
      bindTaskNativeSession,
      listNativeSessionsByTranscriptHandles: listNativeSessions,
      findSessionTranscript: resolveTranscript,
      killTask,
      launch,
      isCurrentSourceAuditResponder: async () => true,
      providerCanServe: async () => true,
      listWorkspaceWideLoopStanddownOwners: async () => new Set(),
      readLogTail: (path) => path === nativeTranscriptPath
        ? nativeTranscript
        : path === taskLogPath ? pacedLog : 'healthy fallback boot',
      readLogMtimeMs: () => Date.now(),
      terminalLogRecheckDelayMs: 0,
      terminalLogMaxRechecks: 0,
      now: () => Date.now(),
    },
  );

  expect(bindTaskNativeSession).toHaveBeenCalledExactlyOnceWith(liveTask.taskId);
  expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
  expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
  expect(killTask).toHaveBeenCalledExactlyOnceWith(liveTask.taskId, {
    includeSubtree: true,
    escalateAfterMs: 5_000,
  });
  expect((await getTask(liveTask.taskId, db.sql))?.state).toBe('killed');
  expect(result.receipts[0]).toMatchObject({
    issueId,
    state: 'launched',
    terminalRecovery: {
      retiredTaskIds: [liveTask.taskId],
      codes: ['inference_gateway_error'],
    },
  });
  expect(launchCalls).toHaveLength(1);
  expect(launchCalls[0]?.[1]).toMatchObject({
    ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
    principal: { kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId },
  });
  expect(await readAudit()).toMatchObject({
    state: 'pending',
    dispatchReservation: { key: reservation.key },
  });
});
