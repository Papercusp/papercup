import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createExternalTriggerBinding,
  createExternalTriggerSource,
  loadExternalTriggerAdminSnapshot,
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
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, 'Trigger admin fixture', 'ready',
            ${`---\nslug: ${PLAN}\n---\n# Trigger admin fixture`}, 'trigger-admin-v1', '[]'::jsonb)`;
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

  it('changes only the named workspace binding armed state', async () => {
    expect(await setExternalTriggerBindingArmed(sql, WS, bindingId, false)).toMatchObject({
      id: bindingId,
      armed: false,
    });
    const rows = await sql<Array<{ armed: boolean }>>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    expect(rows[0].armed).toBe(false);
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
