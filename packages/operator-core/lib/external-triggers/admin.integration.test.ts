import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createExternalTriggerBinding,
  createExternalTriggerSource,
  detachExternalTriggerBinding,
  loadExternalTriggerAdminSnapshot,
  loadExternalTriggerPlanAdminSnapshot,
  setExternalTriggerBindingArmed,
  updateExternalTriggerBindingStormPolicy,
} from './admin';

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PLAN = 'trigger-admin-fixture';

let org: OrgTestDb;
let sql: Sql;
let bindingId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_run_turns WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS} AND install_slug = ${HARNESS} AND name = ${`plan-schedule-${PLAN}`}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items,
       schedule, schedule_active, tzid, input_schema)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, 'Trigger admin fixture', 'ready',
            ${`---\nslug: ${PLAN}\n---\n# Trigger admin fixture`}, 'trigger-admin-v1', '[]'::jsonb,
            '{"kind":"cron","cron":"0 9 * * 1-5"}'::jsonb, FALSE, 'America/New_York',
            '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}'::jsonb)`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, active, last_fired_at, next_fire_at)
    VALUES (${`fixture-${PLAN}`}, ${WS}, ${HARNESS}, ${`plan-schedule-${PLAN}`}, 'cron', '{}'::jsonb,
            'system:plan-run', '{}'::jsonb, FALSE,
            '2026-08-22T12:00:00.000Z'::timestamptz,
            '2026-08-23T13:00:00.000Z'::timestamptz)`;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_sources
      (workspace_id, kind, status, credential_ref, last_connected_at)
    VALUES (${WS}, 'gmail', 'connected', 'google-oauth:fixture', now())
    RETURNING id`;
  const bindings = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       event_filter, action, armed, storm_policy, created_by)
    VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
            '{"label":"support"}'::jsonb, '{"type":"launch-plan"}'::jsonb,
            TRUE, '{"maxRuns":2,"windowSeconds":60}'::jsonb, 'owner-fixture')
    RETURNING id`;
  bindingId = bindings[0].id;
  await sql`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, dedupe_key, status, args, attempts, completed_at)
    VALUES (${WS}, ${bindingId}, 'gmail:admin-fixture', 'failed', '{}'::jsonb, 2, now())`;
});

describe('external-trigger admin shared seam', () => {
  it('reports source/binding/run truth from the canonical tables', async () => {
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.counts).toEqual({ sources: 1, bindings: 1, armed: 1, recentFailures: 1 });
    expect(snapshot.sources[0]).toMatchObject({
      kind: 'gmail',
      status: 'connected',
      credentialRef: 'google-oauth:fixture',
      bindingCount: 1,
      armedBindingCount: 1,
    });
    expect(snapshot.bindings[0]).toMatchObject({
      id: bindingId,
      eventPattern: 'ext:gmail:message.*',
      planSlug: PLAN,
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      lastRun: { status: 'failed', error: null },
    });
    expect(snapshot.recentRuns[0]).toMatchObject({ bindingId, status: 'failed', attempts: 2 });
  });

  it('projects a redacted trigger cause, policy trace, linked plan progress, and outcome links', async () => {
    const planRuns = await sql<Array<{ id: number }>>`
      INSERT INTO harness_shared.plan_runs
        (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, note,
         launched_by, launched_at, status, title, updated_at, run_type, trigger,
         outcome, finished_at, instance_plan_slug)
      VALUES (${WS}, ${HARNESS}, ${PLAN}, 'trigger-admin-v1', 'trigger-visibility-session', NULL,
              'system:plan-run', 1000, 'done', 'Triggered fixture', 5000,
              'scheduled', 'event', 'success', 5000, 'trigger-admin-fixture@run-1')
      RETURNING id`;
    const planRunId = Number(planRuns[0].id);
    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'succeeded',
             args = ${JSON.stringify({
               trigger: {
                 payload: {
                   subject: 'Launch review',
                   from: 'Ada <ada@example.com>',
                   accessToken: 'opaque-secret-token',
                 },
               },
             })}::text::jsonb,
             outcome = ${JSON.stringify({
               gmailDraft: {
                 draftId: 'draft-1',
                 subject: 'Re: Launch review',
               },
             })}::text::jsonb,
             plan_run_ref = ${String(planRunId)},
             attempts = 1,
             error = NULL,
             started_at = '2026-08-22T18:00:00.000Z'::timestamptz,
             completed_at = '2026-08-22T18:00:01.000Z'::timestamptz
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}`;

    const run = (await loadExternalTriggerAdminSnapshot(sql, WS)).recentRuns[0]!;
    expect(run).toMatchObject({
      bindingId,
      sourceKind: 'gmail',
      causeSummary: 'Launch review · Ada <ada@example.com>',
      policyDisposition: 'ran',
      policyDetail: 'ran',
      eventFilter: { label: 'support' },
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      redactedPayload: {
        subject: 'Launch review',
        from: 'Ada <ada@example.com>',
        accessToken: '[redacted]',
      },
      planRun: {
        id: planRunId,
        instancePlanSlug: 'trigger-admin-fixture@run-1',
        status: 'done',
        workItems: { total: 0, passed: 0, failed: 0, open: 0 },
        durationMs: 4000,
        costUsd: 0,
      },
    });
    expect(run.timeline?.map((step) => step.stage)).toEqual([
      'received', 'matched', 'policy', 'launched', 'completed',
    ]);
    expect(run.outcomeLinks).toEqual([
      {
        kind: 'gmail-draft',
        label: 'Re: Launch review',
        href: 'https://mail.google.com/mail/u/0/#drafts/draft-1',
      },
    ]);
  });

  it('changes only the named workspace binding armed state', async () => {
    expect(await setExternalTriggerBindingArmed(sql, WS, bindingId, false)).toMatchObject({
      id: bindingId,
      armed: false,
    });
    const rows = await sql<Array<{ armed: boolean }>>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    expect(rows[0].armed).toBe(false);
  });

  it('reads schedule fire state and the manual source for one plan', async () => {
    expect(await loadExternalTriggerPlanAdminSnapshot(sql, WS, HARNESS, PLAN)).toMatchObject({
      harnessSlug: HARNESS,
      planSlug: PLAN,
      schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
      scheduleActive: false,
      tzid: 'America/New_York',
      lastFire: '2026-08-22T12:00:00.000Z',
      nextFire: '2026-08-23T13:00:00.000Z',
      manualSource: 'input-schema',
    });
  });

  it('soft-detaches while preserving settled history and cancelling queued runs', async () => {
    await sql`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, dedupe_key, status, args)
      VALUES (${WS}, ${bindingId}, 'gmail:queued-before-detach', 'pending', '{}'::jsonb)`;
    expect(await detachExternalTriggerBinding(sql, WS, bindingId)).toMatchObject({ id: bindingId });

    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.counts.bindings).toBe(0);
    const runs = await sql<Array<{ dedupeKey: string; status: string }>>`
      SELECT dedupe_key AS "dedupeKey", status
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}
       ORDER BY dedupe_key`;
    expect(runs).toEqual([
      { dedupeKey: 'gmail:admin-fixture', status: 'failed' },
      { dedupeKey: 'gmail:queued-before-detach', status: 'cancelled' },
    ]);
  });

  it('validates and persists the binding-engine storm-policy vocabulary', async () => {
    expect(
      await updateExternalTriggerBindingStormPolicy(sql, WS, bindingId, {
        maxRuns: 5,
        windowSeconds: 300,
      }),
    ).toMatchObject({ stormPolicy: { maxRuns: 5, windowSeconds: 300 } });
    await expect(
      updateExternalTriggerBindingStormPolicy(sql, WS, bindingId, {
        maxRuns: 0,
        windowSeconds: 300,
      }),
    ).rejects.toThrow('external_trigger_invalid_storm_max_runs');
  });

  it('creates a non-secret source and installs its binding disarmed', async () => {
    const source = await createExternalTriggerSource(sql, WS, {
      kind: 'slack',
      config: { teamId: 'T123' },
      credentialRef: 'integration:slack-fixture',
      status: 'ready',
      createdBy: 'agent-fixture',
    });
    expect(source).toMatchObject({ kind: 'slack', status: 'ready', config: { teamId: 'T123' } });

    const binding = await createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      planHarnessSlug: HARNESS,
      planSlug: PLAN,
      eventPattern: 'ext:slack:mention',
      eventFilter: { channelType: 'public_channel' },
      stormPolicy: { maxRuns: 3, windowSeconds: 120 },
      createdBy: 'agent-fixture',
    });
    expect(binding).toMatchObject({
      sourceId: source.id,
      sourceKind: 'slack',
      eventPattern: 'ext:slack:mention',
      armed: false,
      action: { type: 'launch-plan' },
      stormPolicy: { maxRuns: 3, windowSeconds: 120 },
    });
  });

  it('refuses a binding pattern for a different source kind', async () => {
    const source = await createExternalTriggerSource(sql, WS, { kind: 'slack' });
    await expect(
      createExternalTriggerBinding(sql, WS, {
        sourceId: source.id,
        planHarnessSlug: HARNESS,
        planSlug: PLAN,
        eventPattern: 'ext:gmail:message.received',
      }),
    ).rejects.toThrow('external_trigger_pattern_source_mismatch:ext:slack:');
  });
});

/**
 * P-023. Every test above supplies an EXPLICIT storm policy, so none of them
 * exercises what a binding gets when the caller supplies none — which is the
 * only path a real social source takes at install time.
 */
describe('P-023 — a social binding defaults to coalesce-with-cap, never to unbounded', () => {
  const bindOn = async (kind: string, stormPolicy?: Record<string, unknown>) => {
    const source = await createExternalTriggerSource(sql, WS, { kind });
    return createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      planHarnessSlug: HARNESS,
      planSlug: PLAN,
      eventPattern: `ext:${kind}:mention.created`,
      ...(stormPolicy ? { stormPolicy } : {}),
    });
  };

  it('bluesky states no rate budget, and still gets a bounded cap rather than none', async () => {
    const binding = await bindOn('bluesky');
    expect(binding.stormPolicy).toMatchObject({
      mode: 'coalesce-with-cap',
      maxRuns: 12,
      windowSeconds: 300,
    });
    expect((binding.stormPolicy.basis as { kind: string }).kind).toBe('conservative-default');
  });

  it('reddit derives its cap from the documented 60 requests/minute', async () => {
    const binding = await bindOn('reddit');
    expect(binding.stormPolicy).toMatchObject({ mode: 'coalesce-with-cap', maxRuns: 30 });
    expect(binding.stormPolicy.basis).toMatchObject({ kind: 'rate-budget', requestsPerMinute: 60 });
  });

  it('CONTROL: a non-social source is untouched and still defaults to unbounded', async () => {
    // Proves the change is SCOPED. Without this, the social default passing
    // would be equally consistent with having silently capped every mail and
    // chat binding in the system.
    const binding = await bindOn('gmail');
    expect(binding.stormPolicy.maxRuns).toBeUndefined();
    expect(binding.stormPolicy).toMatchObject({ windowSeconds: 60 });
  });

  it('an explicit caller policy still wins on a social source', async () => {
    const binding = await bindOn('bluesky', { maxRuns: 2, windowSeconds: 60 });
    expect(binding.stormPolicy).toMatchObject({ maxRuns: 2, windowSeconds: 60 });
    expect(binding.stormPolicy.mode).toBeUndefined();
  });
});
