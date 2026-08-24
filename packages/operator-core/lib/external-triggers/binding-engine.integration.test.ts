import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { StartGoalByIdResult } from '../goals/start-goal-by-id';
import { dispatchPendingTriggerRuns, triggerRunPlanToken } from './binding-engine';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PLAN = 'triage-external-event';

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;
let bindingId: string;
let deliveryId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const migration = readFileSync(
    path.join(REPO, 'libs/papercusp/libs/db/sql/878-external-trigger-dispatch-routine.sql'),
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
  await sql`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS}`;
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
  sourceId = sources[0].id;
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

async function seedTriggerRun(over: {
  status?: string;
  attempts?: number;
  startedAt?: string;
  args?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  bindingId?: string;
} = {}): Promise<string> {
  const args = over.args ?? {
    trigger: {
      key: 'ext:gmail:message.received', source: 'gmail', event: 'message.received',
      sourceId: 'source-fixture', externalId: 'dispatch-1', occurredAt: null,
      datatypeId: 'email-message', dedupeKey: 'gmail:dispatch-1',
      payload: { id: 'dispatch-1', subject: 'Triage this' },
    },
  };
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args, outcome, attempts, started_at)
    VALUES (${WS}, ${over.bindingId ?? bindingId}, ${deliveryId}, ${(args.trigger as { dedupeKey?: string })?.dedupeKey ?? 'gmail:dispatch-1'}, ${over.status ?? 'pending'},
            ${JSON.stringify(args)}::text::jsonb, ${JSON.stringify(over.outcome ?? {})}::text::jsonb,
            ${over.attempts ?? 0}, ${over.startedAt ?? null}::timestamptz)
    RETURNING id`;
  return rows[0].id;
}

describe('external trigger durable dispatch', () => {
  it('launches the canonical plan run with trigger inputs and announces its work', async () => {
    const audit = {
      runWithLastEvent: {
        sourceTriggerRunId: 'source-run-1',
        sourceDeliveryId: deliveryId,
        providerDedupeKey: 'gmail:dispatch-1',
        requestedBy: 'owner:test',
      },
    };
    const triggerRunId = await seedTriggerRun({ outcome: audit });
    const announceRunWork = vi.fn(async () => undefined);
    const result = await dispatchPendingTriggerRuns(sql, { announceRunWork });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);
    const triggerRuns = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string;
      outcome: {
        instancePlanSlug: string;
        planRunId: number;
        runWithLastEvent: typeof audit.runWithLastEvent;
      };
    }>>`
      SELECT status, attempts, plan_run_ref, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(triggerRuns[0].status).toBe('succeeded');
    expect(triggerRuns[0].attempts).toBe(1);
    expect(triggerRuns[0].outcome.instancePlanSlug).toBe(`${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`);
    expect(triggerRuns[0].outcome.runWithLastEvent).toEqual(audit.runWithLastEvent);
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

  it('passes the complete Calendar-upcoming trigger input into the meeting-prep plan run', async () => {
    const args = {
      trigger: {
        key: 'ext:gcal:event-upcoming',
        source: 'gcal',
        event: 'event-upcoming',
        sourceId: 'calendar-source-1',
        externalId: 'calendar-event-7',
        occurredAt: '2026-08-22T13:45:00.000Z',
        datatypeId: 'calendar-event',
        dedupeKey: 'gcal:calendar-event-7:event-upcoming:2026-08-22T14:00:00.000Z',
        payload: {
          id: 'calendar-event-7',
          summary: 'Roadmap review',
          start: '2026-08-22T14:00:00.000Z',
          end: '2026-08-22T14:30:00.000Z',
          attendees: [
            { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted' },
            { email: 'bob@example.com', displayName: 'Bob', responseStatus: 'tentative' },
          ],
          organizer: { email: 'owner@example.com', self: true },
          htmlLink: 'https://calendar.google.com/event?eid=fixture',
        },
      },
    };
    const triggerRunId = await seedTriggerRun({ args });
    const runPlan = vi.fn(async () => ({
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 4243,
      runSeq: 0,
      minted: 1,
      replayed: false,
    }));
    const announceRunWork = vi.fn(async () => undefined);

    await expect(dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(runPlan).toHaveBeenCalledWith(sql, expect.objectContaining({
      trigger: 'event',
      inputs: args,
    }));
  });
});

describe('start-goal trigger dispatch (P-020)', () => {
  const GOAL = 'goal-woe-dispatch-1';
  let goalBindingId: string;

  async function seedGoalBinding(goalId: string | null): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, NULL, NULL, ${goalId}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)
      RETURNING id`;
    return rows[0].id;
  }

  beforeEach(async () => {
    await sql`
      INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, status)
      VALUES (${GOAL}, ${WS}, ${HARNESS}, 'Standing dispatch-test goal', 'active')`;
    goalBindingId = await seedGoalBinding(GOAL);
  });

  async function readRun(triggerRunId: string): Promise<{
    status: string;
    attempts: number;
    plan_run_ref: string | null;
    outcome: Record<string, unknown> | null;
    error: string | null;
  }> {
    const rows = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string | null;
      outcome: Record<string, unknown> | null;
      error: string | null;
    }>>`
      SELECT status, attempts, plan_run_ref, outcome, error
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    return rows[0];
  }

  it('activates the goal through the injected primitive and closes the run with a goal outcome', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const activation: StartGoalByIdResult = {
      ok: true,
      goalId: GOAL,
      ownerId: 'su-goal-holder-1',
      warnings: ['budget_policy_read_failed'],
      startBlockedOverride: null,
    };
    const startGoal = vi.fn(async () => activation);

    const result = await dispatchPendingTriggerRuns(sql, { startGoal });
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);
    expect(startGoal).toHaveBeenCalledWith(sql, {
      workspaceId: WS,
      goalId: GOAL,
      launcherOwnerId: `trigger-binding:${goalBindingId}`,
    });

    const run = await readRun(triggerRunId);
    expect(run.status).toBe('succeeded');
    // A goal run's handle is the outcome, never a plan-run ref.
    expect(run.plan_run_ref).toBeNull();
    expect(run.error).toBeNull();
    expect(run.outcome).toEqual({
      goalId: GOAL,
      agentOwnerId: 'su-goal-holder-1',
      warnings: ['budget_policy_read_failed'],
    });
  });

  it('retries a heal-able refusal (not-ready) as failed, then succeeds — outcome omits empty warnings', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const refused: StartGoalByIdResult = { ok: false, reason: 'not-ready', detail: 'blockers pending: 2' };
    const activated: StartGoalByIdResult = {
      ok: true, goalId: GOAL, ownerId: 'su-goal-holder-2', warnings: [], startBlockedOverride: null,
    };
    const startGoal = vi.fn()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(activated);

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    const failed = await readRun(triggerRunId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('external_trigger_goal_start_refused:not-ready');

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    const done = await readRun(triggerRunId);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
    // warnings: [] is elided from the persisted outcome entirely.
    expect(done.outcome).toEqual({ goalId: GOAL, agentOwnerId: 'su-goal-holder-2' });
  });

  it('closes a terminal refusal (already-held) as skipped and never re-claims it', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const refused: StartGoalByIdResult = {
      ok: false, reason: 'already-held', detail: 'goal has a live holder su-elsewhere',
    };
    const startGoal = vi.fn(async () => refused);

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });
    const run = await readRun(triggerRunId);
    expect(run.status).toBe('skipped');
    expect(run.outcome).toEqual({ goalId: GOAL, refusal: 'already-held' });
    expect(run.error).toBe('goal has a live holder su-elsewhere');

    // Terminal: the claim query only takes pending/failed/stale-running rows.
    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 0 });
    expect(startGoal).toHaveBeenCalledTimes(1);
  });

  it('fails a start-goal action whose binding carries no goal target, without invoking the primitive', async () => {
    // The exactly-one-target CHECK allows a plan-targeted row whose action jsonb
    // says start-goal (action is independent of the target columns) — the engine
    // guard is what catches the mismatch.
    const mismatched = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)
      RETURNING id`;
    const triggerRunId = await seedTriggerRun({ bindingId: mismatched[0].id });
    const startGoal = vi.fn();

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    const run = await readRun(triggerRunId);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('external_trigger_missing_goal_target');
    expect(startGoal).not.toHaveBeenCalled();
  });

  it('migration 921 canary: the DB refuses a binding with both targets or neither', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, ${HARNESS}, ${PLAN}, ${GOAL}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)`,
    ).rejects.toThrow(/trigger_bindings_exactly_one_target/);
    await expect(seedGoalBinding(null)).rejects.toThrow(/trigger_bindings_exactly_one_target/);
  });
});

/**
 * P-028 simulated acceptance for the SOCIAL platforms.
 *
 * Every other case in this file drives gmail/calendar. Before this block, no
 * test anywhere asserted a social `ext:<platform>:` pattern reaching a plan run
 * — the adapters, the registry and the admin surfaces were all covered, but the
 * span between an inbound social event and the delivery ledger was not. That is
 * the half of P-028's acceptance chain a fixture CAN prove; the live half ("the
 * reply lands on the platform") is owner-walled at every wave (D-052), so this
 * deliberately stops at the ledger.
 *
 * It is a distinct block rather than another gmail case because the thing under
 * test is that the dispatch path is platform-AGNOSTIC: nothing between the
 * binding and the plan run may special-case a source kind.
 */
describe('social platform dispatch (P-028 simulated acceptance)', () => {
  const SOCIAL_DEDUPE = 'bluesky:reply-9001';

  async function seedSocialChain(): Promise<{ triggerRunId: string; bindingId: string }> {
    const sources = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_sources (workspace_id, kind, status, cursor)
      VALUES (${WS}, 'bluesky', 'connected', ${JSON.stringify({ seq: 4821 })}::text::jsonb)
      RETURNING id`;
    const bindings = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:bluesky:reply.*',
              '{}'::jsonb, '{"type":"launch-plan"}'::jsonb, TRUE,
              ${JSON.stringify({ maxRuns: 12, windowSeconds: 300 })}::text::jsonb)
      RETURNING id`;
    const deliveries = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
         sink_kind, sink_ref, outcome, attempts, completed_at)
      VALUES (${WS}, ${sources[0].id}, ${SOCIAL_DEDUPE}, 'social-post',
              'ext:bluesky:reply.created',
              ${JSON.stringify({
                uri: 'at://did:plc:p028/app.bsky.feed.post/9001',
                text: 'anyone else seeing this?',
                author: 'did:plc:p028',
              })}::text::jsonb,
              'event-bus', 'workspace', 'delivered', 1, now())
      RETURNING id`;
    const args = {
      trigger: {
        key: 'ext:bluesky:reply.created',
        source: 'bluesky',
        event: 'reply.created',
        sourceId: sources[0].id,
        externalId: 'at://did:plc:p028/app.bsky.feed.post/9001',
        occurredAt: null,
        datatypeId: 'social-post',
        dedupeKey: SOCIAL_DEDUPE,
        payload: {
          uri: 'at://did:plc:p028/app.bsky.feed.post/9001',
          text: 'anyone else seeing this?',
          author: 'did:plc:p028',
        },
      },
    };
    const runs = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args, attempts)
      VALUES (${WS}, ${bindings[0].id}, ${deliveries[0].id}, ${SOCIAL_DEDUPE}, 'pending',
              ${JSON.stringify(args)}::text::jsonb, 0)
      RETURNING id`;
    return { triggerRunId: runs[0].id, bindingId: bindings[0].id };
  }

  it('carries a social inbound event through binding -> plan run -> delivery ledger', async () => {
    const { triggerRunId } = await seedSocialChain();
    const announceRunWork = vi.fn(async () => undefined);

    const result = await dispatchPendingTriggerRuns(sql, { announceRunWork });

    // The gmail fixture from beforeEach has no pending run, so exactly the
    // social one is claimed — if dispatch ever special-cased a source kind,
    // this is where it would show up as claimed:0.
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);

    const triggerRuns = await sql<Array<{
      status: string;
      outcome: { instancePlanSlug: string; planRunId: number };
    }>>`
      SELECT status, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(triggerRuns[0].status).toBe('succeeded');
    expect(triggerRuns[0].outcome.instancePlanSlug).toBe(
      `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
    );

    // The plan run carries the SOCIAL payload verbatim — an agent drafting a
    // reply reads it from here, so a lossy hand-off would surface as a missing
    // uri/text rather than as a dispatch failure.
    const planRuns = await sql<Array<{ trigger: string; inputs: Record<string, unknown> }>>`
      SELECT trigger, inputs FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(planRuns).toHaveLength(1);
    expect(planRuns[0].trigger).toBe('event');
    expect(planRuns[0].inputs).toMatchObject({
      trigger: {
        key: 'ext:bluesky:reply.created',
        source: 'bluesky',
        payload: { uri: 'at://did:plc:p028/app.bsky.feed.post/9001', text: 'anyone else seeing this?' },
      },
    });
    expect(announceRunWork).toHaveBeenCalledWith(sql, WS, triggerRuns[0].outcome.planRunId);

    // The ledger end of the trace: the delivery that caused this run is still
    // joinable to it, which is what the "delivery ledger shows the full trace"
    // half of P-028 actually means.
    const trace = await sql<Array<{ event_key: string; outcome: string; run_status: string }>>`
      SELECT d.event_key, d.outcome, r.status AS run_status
        FROM harness_shared.trigger_runs r
        JOIN harness_shared.trigger_deliveries d ON d.id = r.delivery_id
       WHERE r.workspace_id = ${WS} AND r.id = ${triggerRunId}`;
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      event_key: 'ext:bluesky:reply.created',
      outcome: 'delivered',
      run_status: 'succeeded',
    });
  });

  it('honours the per-platform storm policy stored on a social binding', async () => {
    const { bindingId: socialBindingId } = await seedSocialChain();
    const stored = await sql<Array<{ storm_policy: { maxRuns: number; windowSeconds: number } }>>`
      SELECT storm_policy FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND id = ${socialBindingId}`;
    // Bluesky's conservative-default budget (12 runs / 300s) is what the plan
    // Triggers composer prefills (D-051). A binding that persisted an unbounded
    // policy instead would spend a metered platform's quota early, which is the
    // defect that prefill exists to prevent.
    expect(stored[0].storm_policy).toMatchObject({ maxRuns: 12, windowSeconds: 300 });
  });
});
