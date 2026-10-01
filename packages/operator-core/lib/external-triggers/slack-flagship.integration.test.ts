import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { dispatchPendingTriggerRuns } from './binding-engine';
import { ingestExternalTriggerEvent } from './ingestion';
import {
  ensureSlackRespondInThreadBinding,
  respondToSlackTriggerPlanRun,
  SLACK_RESPOND_IN_THREAD_EVENT,
  SLACK_RESPOND_IN_THREAD_HARNESS,
  SLACK_RESPOND_IN_THREAD_PLAN,
} from './slack-flagship';
import { normalizeSlackSocketEnvelope } from './slack';
import { upsertOwnedExternalTriggerSource } from './source-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// Canonical promotion uses the shared stores rather than the explicit plan-run
// transaction client. Keep every one of those reads/writes in this throwaway DB;
// the Slack integration previously left the operator-home shortcut active, so
// promotion could not see the disposable instance seeded by this test.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const WS = 'slack-flagship-e2e';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'slack-flagship-owner-' + Date.now()}, 'Slack Flagship Owner')
    RETURNING id`;
  userId = users[0].id;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${SLACK_RESPOND_IN_THREAD_HARNESS}, ${Buffer.from([2])}, 'kc-slack-flagship', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (
      ${WS},
      ${JSON.stringify({
        projects: [
          {
            slug: SLACK_RESPOND_IN_THREAD_HARNESS,
            path: '/tmp/slack-flagship',
            harness_kind: 'hive',
          },
        ],
      })}::text::jsonb
    )
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
  await sql`
    INSERT INTO harness_shared.datatype_registry
      (workspace_id, id, title, description, tier, payload_schema, authoritative_writer)
    VALUES (
      ${WS}, 'chat-message', 'Chat message', 'Normalized chat event', 'workspace',
      '{"type":"object","required":["id","channelId","threadId","sender","text"],"additionalProperties":true}'::jsonb,
      'papercusp'
    )
    ON CONFLICT (workspace_id, id) DO NOTHING`;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
});

describe('Slack flagship desktop flow', () => {
  it('connects a disarmed binding, launches the built-in plan, and posts one anchored thread reply', async () => {
    const source = await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'slack',
      ownerUserId: userId,
      credentialRef: 'slack-socket:owner',
      status: 'connected',
      config: { installSlug: SLACK_RESPOND_IN_THREAD_HARNESS, botUserId: 'UPAPER', channels: ['C1'] },
    });
    const first = await ensureSlackRespondInThreadBinding(sql, WS, source, `owner:${userId}`);
    expect(first).toMatchObject({ plan: { created: true }, binding: { armed: false } });
    const second = await ensureSlackRespondInThreadBinding(sql, WS, source, `owner:${userId}`);
    expect(second).toMatchObject({ plan: { created: false }, binding: { id: first.binding.id, armed: false } });

    const planRows = await sql<Array<{ inputSchema: unknown; itemCount: number }>>`
      SELECT input_schema AS "inputSchema", jsonb_array_length(items)::int AS "itemCount"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS}
         AND harness_slug = ${SLACK_RESPOND_IN_THREAD_HARNESS}
         AND plan_slug = ${SLACK_RESPOND_IN_THREAD_PLAN}`;
    expect(planRows).toHaveLength(1);
    expect(planRows[0].inputSchema).toMatchObject({ required: ['trigger'] });
    expect(planRows[0].itemCount).toBe(1);
    const indexRows = await sql<Array<{ itemId: string; status: string }>>`
      SELECT item_id AS "itemId", status
        FROM harness_shared.plan_items
       WHERE workspace_id = ${WS}
         AND harness_slug = ${SLACK_RESPOND_IN_THREAD_HARNESS}
         AND plan_slug = ${SLACK_RESPOND_IN_THREAD_PLAN}`;
    expect(indexRows).toEqual([{ itemId: 'P-001', status: 'todo' }]);

    await sql`
      UPDATE harness_shared.trigger_bindings SET armed = TRUE
       WHERE workspace_id = ${WS} AND id = ${first.binding.id}::uuid`;
    const normalized = normalizeSlackSocketEnvelope({
      envelope_id: 'env-flagship',
      type: 'events_api',
      payload: {
        event_id: 'EvFlagship',
        event: {
          type: 'app_mention',
          channel: 'C1',
          user: 'U1',
          text: '<@UPAPER> summarize the release',
          ts: '1777000000.1',
        },
      },
    })!;
    const emit = vi.fn(async () => ({
      ok: true as const,
      key: SLACK_RESPOND_IN_THREAD_EVENT,
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const ingested = await ingestExternalTriggerEvent(
      sql,
      {
        workspaceId: WS,
        sourceId: source.id,
        source: 'slack',
        event: normalized.event,
        externalId: normalized.externalId,
        datatypeId: 'chat-message',
        adapterPayload: normalized.payload,
        normalize: () => normalized.payload,
        occurredAt: normalized.occurredAt,
        dedupeKey: normalized.dedupeKey,
      },
      { emit },
    );
    expect(ingested).toMatchObject({ ok: true });
    expect(ingested.deliveries).toEqual(
      expect.arrayContaining([expect.objectContaining({ sinkKind: 'trigger-bindings', outcome: 'delivered' })]),
    );

    await expect(dispatchPendingTriggerRuns(sql, { announceRunWork: async () => undefined })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    const runs = await sql<Array<{ planRunId: number }>>`
      SELECT plan_run_ref::bigint::int AS "planRunId"
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS}`;
    expect(runs).toHaveLength(1);
    const work = await sql<Array<{ title: string; payload: Record<string, unknown> }>>`
      SELECT title, payload FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND source_plan_slug = ${SLACK_RESPOND_IN_THREAD_PLAN}`;
    expect(work).toHaveLength(1);
    expect(work[0].title).toContain('slack:respond-in-thread');

    const storage = {
      read: vi.fn(async () => ({
        owner_app_token: 'xapp-secret',
        owner_bot_token: 'xoxb-secret',
      })),
      update: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channel: 'C1',
            ts: '1777000001.4',
          }),
        ),
    ) as never;
    await expect(
      sql.begin((tx) =>
        respondToSlackTriggerPlanRun(tx, WS, runs[0].planRunId, 'Release is green.', {
          storage,
          fetch: fetchImpl,
          apiOrigin: 'https://slack.test',
          now: () => new Date('2026-08-22T18:00:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({
      posted: true,
      alreadyPosted: false,
      channelId: 'C1',
      threadId: '1777000000.1',
      messageTs: '1777000001.4',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      respondToSlackTriggerPlanRun(sql, WS, runs[0].planRunId, 'Release is green.', {
        storage,
        fetch: fetchImpl,
        apiOrigin: 'https://slack.test',
      }),
    ).resolves.toMatchObject({ posted: false, alreadyPosted: true, messageTs: '1777000001.4' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
