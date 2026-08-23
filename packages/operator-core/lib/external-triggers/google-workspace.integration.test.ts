import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  GOOGLE_CALENDAR_MEETING_PREP_EVENT,
  GOOGLE_CALENDAR_MEETING_PREP_HARNESS,
  GOOGLE_CALENDAR_MEETING_PREP_PLAN,
  provisionOwnedGoogleWorkspaceSources,
} from './google-workspace';

const WS = 'google-workspace-source-test';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'google-workspace-owner-' + Date.now()}, 'Workspace Owner')
    RETURNING id`;
  userId = users[0].id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await sql`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS}
       AND harness_slug = ${GOOGLE_CALENDAR_MEETING_PREP_HARNESS}
       AND plan_slug = ${GOOGLE_CALENDAR_MEETING_PREP_PLAN}`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (
      ${WS}, ${GOOGLE_CALENDAR_MEETING_PREP_HARNESS}, ${GOOGLE_CALENDAR_MEETING_PREP_PLAN},
      'Meeting prep', 'ready', '# Meeting prep', 'meeting-prep-v1', '[]'::jsonb
    )`;
});

describe('Google Workspace owned trigger-source provisioning', () => {
  it('creates Gmail + Calendar + Contacts once and preserves cursors/preferences across re-consent', async () => {
    const first = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      field: 'owner',
    });
    expect(first.map((row) => row.kind).sort()).toEqual(['contacts', 'gcal', 'gmail']);
    expect(first.every((row) => row.credentialRef === 'google-workspace:owner')).toBe(true);

    const calendar = first.find((row) => row.kind === 'gcal')!;
    await sql`
      UPDATE harness_shared.trigger_sources
         SET cursor = '{"syncToken":"keep-me"}'::jsonb,
             status = 'degraded',
             last_error = 'transient'
       WHERE workspace_id = ${WS} AND id = ${calendar.id}::uuid`;
    const contacts = first.find((row) => row.kind === 'contacts')!;
    await sql`
      UPDATE harness_shared.trigger_sources
         SET config = config || '{"capabilityEnabled":false}'::jsonb,
             status = 'disabled'
       WHERE workspace_id = ${WS} AND id = ${contacts.id}::uuid`;

    const second = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      field: 'owner-reconnected',
    });
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(second.every((row) => row.credentialRef === 'google-workspace:owner-reconnected')).toBe(true);
    expect(second.filter((row) => row.kind !== 'contacts').every((row) => row.status === 'connected')).toBe(true);
    expect(second.find((row) => row.kind === 'contacts')).toMatchObject({
      status: 'disabled',
      config: { capabilityEnabled: false },
    });
    expect(second.find((row) => row.kind === 'gcal')?.cursor).toEqual({ syncToken: 'keep-me' });

    const rows = await sql<Array<{ kind: string; count: number }>>`
      SELECT kind, count(*)::int AS count
        FROM harness_shared.trigger_sources
       WHERE workspace_id = ${WS} AND owner_user_id = ${userId}::uuid
       GROUP BY kind
       ORDER BY kind`;
    expect(rows).toEqual([
      { kind: 'contacts', count: 1 },
      { kind: 'gcal', count: 1 },
      { kind: 'gmail', count: 1 },
    ]);

    const bindings = await sql<
      Array<{
        sourceKind: string;
        eventPattern: string;
        eventFilter: Record<string, unknown>;
        planHarnessSlug: string;
        planSlug: string;
        action: Record<string, unknown>;
        armed: boolean;
        count: number;
      }>
    >`
      SELECT s.kind AS "sourceKind",
             b.event_pattern AS "eventPattern",
             b.event_filter AS "eventFilter",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             b.action,
             b.armed,
             count(*)::int AS count
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE b.workspace_id = ${WS}
       GROUP BY s.kind, b.event_pattern, b.event_filter, b.plan_harness_slug,
                b.plan_slug, b.action, b.armed`;
    expect(bindings).toEqual([
      {
        sourceKind: 'gcal',
        eventPattern: GOOGLE_CALENDAR_MEETING_PREP_EVENT,
        eventFilter: { 'attendees.0': { exists: true } },
        planHarnessSlug: GOOGLE_CALENDAR_MEETING_PREP_HARNESS,
        planSlug: GOOGLE_CALENDAR_MEETING_PREP_PLAN,
        action: { type: 'launch-plan' },
        armed: false,
        count: 1,
      },
    ]);
  });

  it('serializes concurrent reconnects onto the same disarmed Calendar binding', async () => {
    await Promise.all([
      provisionOwnedGoogleWorkspaceSources(sql, {
        workspaceId: WS,
        ownerUserId: userId,
        field: 'owner-a',
      }),
      provisionOwnedGoogleWorkspaceSources(sql, {
        workspaceId: WS,
        ownerUserId: userId,
        field: 'owner-b',
      }),
    ]);
    const rows = await sql<Array<{ count: number; armed: boolean }>>`
      SELECT count(*)::int AS count, bool_or(armed) AS armed
        FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS}`;
    expect(rows).toEqual([{ count: 1, armed: false }]);
  });
});
