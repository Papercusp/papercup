import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { dispatchPendingTriggerRuns } from './binding-engine';
import {
  draftResponseToGmailTriggerPlanRun,
  ensureGmailRespondDraftBinding,
  GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS,
  GMAIL_RESPOND_DRAFT_EVENT,
  GMAIL_RESPOND_DRAFT_HARNESS,
  GMAIL_RESPOND_DRAFT_PLAN,
} from './gmail-flagship';
import { ingestExternalTriggerEvent } from './ingestion';
import { upsertOwnedExternalTriggerSource } from './source-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// Canonical promotion uses the shared stores rather than the explicit plan-run
// transaction client. Keep every one of those reads/writes in this throwaway DB;
// papercusp's operator-home shortcut previously hid the missing isolation.
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

const WS = 'gmail-flagship-e2e';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'gmail-flagship-owner-' + Date.now()}, 'Gmail Flagship Owner')
    RETURNING id`;
  userId = users[0].id;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${GMAIL_RESPOND_DRAFT_HARNESS}, ${Buffer.from([2])}, 'kc-gmail-flagship-email', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (
      ${WS},
      ${JSON.stringify({
        projects: [
          {
            slug: GMAIL_RESPOND_DRAFT_HARNESS,
            path: '/tmp/gmail-flagship-email',
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
      ${WS}, 'email-message', 'Email message', 'Normalized email event', 'workspace',
      '{"type":"object","required":["id","threadId","from","subject","messageId","direction"],"additionalProperties":true}'::jsonb,
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

describe('Gmail flagship desktop flow', () => {
  it('connects a disarmed binding, launches the built-in plan, and creates one anchored Gmail draft', async () => {
    const source = await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner',
      status: 'connected',
      config: {},
    });
    const first = await ensureGmailRespondDraftBinding(sql, WS, source, `owner:${userId}`);
    expect(first).toMatchObject({
      plan: { created: true },
      binding: { armed: false, action: { type: 'launch-plan' } },
    });
    // Upgrade guard: reconnecting an installation provisioned with a named
    // direct executor preserves the semantic binding while moving it to the
    // durable manual-review queue.
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items, input_schema)
      SELECT workspace_id, ${GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS}, plan_slug,
             title, status, content, content_hash, items, input_schema
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS}
         AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING`;
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET plan_harness_slug = ${GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS},
             action = '{"type":"launch-plan","execution":{"appHarnessSlug":"email","agentName":"email-agent"}}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${first.binding.id}::uuid`;
    const second = await ensureGmailRespondDraftBinding(sql, WS, source, `owner:${userId}`);
    expect(second).toMatchObject({
      plan: { created: false },
      binding: {
        id: first.binding.id,
        armed: false,
        action: { type: 'launch-plan' },
      },
    });

    const planRows = await sql<Array<{ inputSchema: unknown; itemCount: number }>>`
      SELECT input_schema AS "inputSchema", jsonb_array_length(items)::int AS "itemCount"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS}
         AND harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS}
         AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}`;
    expect(planRows).toHaveLength(1);
    expect(planRows[0].inputSchema).toMatchObject({ required: ['trigger'] });
    expect(planRows[0].itemCount).toBe(1);

    await sql`
      UPDATE harness_shared.trigger_bindings SET armed = TRUE
       WHERE workspace_id = ${WS} AND id = ${first.binding.id}::uuid`;
    const payload = {
      id: 'message-1',
      threadId: 'thread-1',
      from: 'Ada <ada@example.com>',
      to: ['Owner <owner@example.com>'],
      subject: 'Launch review',
      messageId: '<message-1@example.com>',
      references: '<root@example.com>',
      text: 'Can you review the launch?',
      labels: ['INBOX'],
      direction: 'inbound',
    };
    const emit = vi.fn(async () => ({
      ok: true as const,
      key: GMAIL_RESPOND_DRAFT_EVENT,
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    await expect(
      ingestExternalTriggerEvent(
        sql,
        {
          workspaceId: WS,
          sourceId: source.id,
          source: 'gmail',
          event: 'message.received',
          externalId: payload.id,
          datatypeId: 'email-message',
          adapterPayload: payload,
          normalize: () => payload,
          dedupeKey: `gmail:${payload.id}:message.received`,
        },
        { emit },
      ),
    ).resolves.toMatchObject({ ok: true });
    const dispatchResult = await dispatchPendingTriggerRuns(sql, {
      announceRunWork: async () => undefined,
    });
    const dispatchRows = await sql<Array<{ error: string | null }>>`
      SELECT error FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} ORDER BY triggered_at DESC LIMIT 1`;
    expect(dispatchResult, dispatchRows[0]?.error ?? 'trigger dispatch failed without an error').toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    const reviewWork = await sql<Array<{ status: string; takenBy: string | null }>>`
      SELECT status, taken_by AS "takenBy"
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS}`;
    expect(reviewWork).toEqual([{ status: 'open', takenBy: null }]);
    const runs = await sql<Array<{ planRunId: number }>>`
      SELECT plan_run_ref::bigint::int AS "planRunId"
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS}`;
    expect(runs).toHaveLength(1);

    const resolveAccessToken = vi.fn(async () => 'gmail-access-token');
    const createDraft = vi.fn(async (_token, input) => {
      expect(input).toEqual({
        to: 'Ada <ada@example.com>',
        subject: 'Re: Launch review',
        text: 'The launch looks good.',
        threadId: 'thread-1',
        inReplyTo: '<message-1@example.com>',
        references: '<root@example.com>',
      });
      return { draftId: 'draft-1', messageId: 'draft-message-1', threadId: 'thread-1' };
    });
    await expect(
      sql.begin((tx) =>
        draftResponseToGmailTriggerPlanRun(tx, WS, runs[0].planRunId, 'The launch looks good.', {
          resolveAccessToken,
          createDraft,
          now: () => new Date('2026-08-22T18:00:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({
      created: true,
      alreadyCreated: false,
      draftId: 'draft-1',
      messageId: 'draft-message-1',
      threadId: 'thread-1',
      to: 'Ada <ada@example.com>',
      subject: 'Re: Launch review',
    });
    expect(resolveAccessToken).toHaveBeenCalledTimes(1);
    expect(resolveAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: source.id }),
      GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS,
    );
    expect(createDraft).toHaveBeenCalledTimes(1);
    await expect(
      draftResponseToGmailTriggerPlanRun(sql, WS, runs[0].planRunId, 'The launch looks good.', {
        resolveAccessToken,
        createDraft,
      }),
    ).resolves.toMatchObject({ created: false, alreadyCreated: true, draftId: 'draft-1' });
    expect(createDraft).toHaveBeenCalledTimes(1);
  });
});
