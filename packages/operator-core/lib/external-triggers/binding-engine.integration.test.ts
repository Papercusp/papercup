import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { dispatchPendingTriggerRuns, triggerRunPlanToken } from './binding-engine';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PLAN = 'triage-external-event';

let org: OrgTestDb;
let sql: Sql;
let bindingId: string;
let deliveryId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const migration = readFileSync(
    path.join(REPO, 'libs/papercusp/libs/db/sql/878-external-trigger-dispatch-routine.sql.DRAFT'),
    'utf8',
  );
  await sql.unsafe(migration);
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, 'Triage event', 'active',
            ${`---\nslug: ${PLAN}\n---\n# Triage event`}, 'trigger-plan-v1',
            ${JSON.stringify([{ id: 'P-001', text: 'Handle trigger payload', status: 'todo' }])}::text::jsonb)`;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_sources (workspace_id, kind, status)
    VALUES (${WS}, 'gmail', 'connected') RETURNING id`;
  const bindings = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       event_filter, action, armed, storm_policy)
    VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
            '{}'::jsonb, '{"type":"launch-plan"}'::jsonb, TRUE, '{}'::jsonb)
    RETURNING id`;
  bindingId = bindings[0].id;
  const deliveries = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, completed_at)
    VALUES (${WS}, ${sources[0].id}, 'gmail:dispatch-1', 'email-message',
            'ext:gmail:message.received', '{"id":"dispatch-1"}'::jsonb,
            'event-bus', 'workspace', 'delivered', 1, now())
    RETURNING id`;
  deliveryId = deliveries[0].id;
});

async function seedTriggerRun(over: { status?: string; attempts?: number; startedAt?: string } = {}): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args, attempts, started_at)
    VALUES (${WS}, ${bindingId}, ${deliveryId}, 'gmail:dispatch-1', ${over.status ?? 'pending'},
            ${JSON.stringify({
              trigger: {
                key: 'ext:gmail:message.received', source: 'gmail', event: 'message.received',
                sourceId: 'source-fixture', externalId: 'dispatch-1', occurredAt: null,
                datatypeId: 'email-message', dedupeKey: 'gmail:dispatch-1',
                payload: { id: 'dispatch-1', subject: 'Triage this' },
              },
            })}::text::jsonb,
            ${over.attempts ?? 0}, ${over.startedAt ?? null}::timestamptz)
    RETURNING id`;
  return rows[0].id;
}

describe('external trigger durable dispatch', () => {
  it('launches the canonical plan run with trigger inputs and announces its work', async () => {
    const triggerRunId = await seedTriggerRun();
    const announceRunWork = vi.fn(async () => undefined);
    const result = await dispatchPendingTriggerRuns(sql, { announceRunWork });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);
    const triggerRuns = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string;
      outcome: { instancePlanSlug: string; planRunId: number };
    }>>`
      SELECT status, attempts, plan_run_ref, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(triggerRuns[0].status).toBe('succeeded');
    expect(triggerRuns[0].attempts).toBe(1);
    expect(triggerRuns[0].outcome.instancePlanSlug).toBe(`${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`);
    expect(triggerRuns[0].plan_run_ref).toBe(String(triggerRuns[0].outcome.planRunId));

    const planRuns = await sql<Array<{ trigger: string; inputs: Record<string, unknown> }>>`
      SELECT trigger, inputs FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(planRuns).toHaveLength(1);
    expect(planRuns[0].trigger).toBe('event');
    expect(planRuns[0].inputs).toMatchObject({
      trigger: { key: 'ext:gmail:message.received', payload: { id: 'dispatch-1' } },
    });
    expect(announceRunWork).toHaveBeenCalledWith(sql, WS, triggerRuns[0].outcome.planRunId);
  });

  it('retries failed and stale-running rows without minting duplicate trigger attempts', async () => {
    const triggerRunId = await seedTriggerRun();
    const runPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary launch failure'))
      .mockResolvedValueOnce({
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 4242,
        runSeq: 0,
        minted: 1,
        replayed: false,
      });
    const announceRunWork = vi.fn(async () => undefined);

    expect(await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const rows = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
    expect(runPlan).toHaveBeenCalledTimes(2);
    expect(announceRunWork).toHaveBeenCalledTimes(1);

    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'running', started_at = now() - interval '5 minutes',
             completed_at = NULL, attempts = 2
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    runPlan.mockResolvedValueOnce({
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 4242,
      runSeq: 0,
      minted: 0,
      replayed: true,
    });
    expect(await dispatchPendingTriggerRuns(sql, {
      runPlan,
      announceRunWork,
      staleAfterSeconds: 60,
    })).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const recovered = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(recovered[0]).toEqual({ status: 'succeeded', attempts: 3 });
  });
});
