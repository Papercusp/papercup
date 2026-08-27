import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { WorkosLifecycleWorker } from './workos-lifecycle-worker';
import {
  PostgresWorkosAccessClosureSink,
  PostgresWorkosLifecycleProjectionStore,
  workosLifecycleEventFromReceipt,
  type HostedServiceContextRunner,
} from './workos-lifecycle-postgres';
import type { WorkOsWebhookReceiptResult } from './workos-webhook-intake';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(HERE, '../../../../../libs/papercusp/libs/db/sql');
const RECEIVED_AT = new Date('2026-08-27T12:00:01.000Z');
const OCCURRED_AT = new Date('2026-08-27T12:00:00.000Z');
const SESSION_ID = `hs_${'A'.repeat(43)}`;

function migration(name: string, allowDraft = false): string {
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  if (allowDraft && existsSync(`${armed}.DRAFT`)) return readFileSync(`${armed}.DRAFT`, 'utf8');
  throw new Error(`migration not found at ${armed}${allowDraft ? '[.DRAFT]' : ''}`);
}

let db: MigratedTestDb;
let sql: Sql;
let runAsService: HostedServiceContextRunner;

async function provisionRoles(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service',
        'harness_admin', 'harness_app', 'harness_zero'
      ]
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      EXECUTE format(
        'GRANT hosted_owner, hosted_app, hosted_service, harness_admin, harness_app, harness_zero TO %I',
        current_user
      );
    END
    $$;
  `);
}

function receipt(eventId: string, eventType: string, data: Record<string, unknown>): WorkOsWebhookReceiptResult {
  return {
    eventId,
    eventType,
    eventCreatedAt: OCCURRED_AT,
    receivedAt: RECEIVED_AT,
    providerAccountId: typeof data.organization_id === 'string' ? data.organization_id : null,
    subjectRef: typeof data.id === 'string' ? data.id : null,
    eventVersion: typeof data.version === 'number' ? String(data.version) : null,
    payload: {
      id: eventId,
      event: eventType,
      created_at: OCCURRED_AT.toISOString(),
      data,
    },
    payloadSha256: 'a'.repeat(64),
    deduplicated: false,
  };
}

async function insertReceipt(value: WorkOsWebhookReceiptResult): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.webhook_event_receipts
      (provider, event_id, event_type, provider_account_id, subject_ref,
       event_version, event_created_at, payload, payload_sha256,
       received_at, verified_at, enqueued_at, retention_until)
    VALUES
      ('workos', ${value.eventId}, ${value.eventType}, ${value.providerAccountId},
       ${value.subjectRef}, ${value.eventVersion}, ${value.eventCreatedAt.toISOString()},
       ${JSON.stringify(value.payload)}::text::jsonb, ${value.payloadSha256},
       ${value.receivedAt.toISOString()}, ${value.receivedAt.toISOString()},
       ${value.receivedAt.toISOString()}, ${new Date(RECEIVED_AT.getTime() + 86_400_000).toISOString()})
  `;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'workoslifecycle1005adapter' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionRoles();
  // The focused DB harness applies no baseline migrations. Reproduce only the
  // pre-existing directory seam migration 906 references, matching the
  // canonical hosted-customer-RLS integration fixture.
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_hosts (
      workspace_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  for (const name of [
    '902-hosted-session-webhook-receipts.sql',
    '903-customer-organization-boundary.sql',
    '904-hosted-identity-links.sql',
    '906-customer-workspace-directory.sql',
    '978-hosted-customer-rls.sql',
  ]) {
    await sql.unsafe(migration(name));
  }
  await sql.unsafe(migration('1005-hosted-service-lifecycle-runtime.sql', true));
  runAsService = async (fn) =>
    sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return fn(tx as unknown as Sql);
    }) as Promise<never>;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`TRUNCATE papercusp_auth.webhook_event_receipts`;
  await sql`TRUNCATE papercusp_auth.workos_lifecycle_entity_cursors`;
  await sql`TRUNCATE papercusp_auth.hosted_sessions`;
  await sql`TRUNCATE papercusp_auth.organization_memberships CASCADE`;
  await sql`TRUNCATE papercusp_auth.organization_invitation_refs CASCADE`;
  await sql`TRUNCATE papercusp_auth.external_identities CASCADE`;
  await sql`TRUNCATE papercusp_auth.hosted_users CASCADE`;
  await sql`TRUNCATE papercusp_auth.organizations CASCADE`;
});

describe('PostgresWorkosLifecycleProjectionStore', () => {
  it('projects a verified identity exactly once and persists the entity cursor on the receipt ledger', async () => {
    const accepted = receipt('event_user_1', 'user.created', {
      id: 'user_workos_1',
      email: 'Person@Example.com',
      name: 'Person One',
      updated_at: '2026-08-27T11:59:59.000Z',
    });
    await insertReceipt(accepted);
    const store = new PostgresWorkosLifecycleProjectionStore(runAsService);
    const worker = new WorkosLifecycleWorker(store, new PostgresWorkosAccessClosureSink(runAsService));
    const event = workosLifecycleEventFromReceipt(accepted);
    expect(event).not.toBeNull();

    await expect(worker.apply(event!)).resolves.toMatchObject({ disposition: 'applied' });
    await expect(worker.apply(event!)).resolves.toMatchObject({ disposition: 'duplicate' });

    const [projection] = await sql<
      {
        email: string;
        subject: string;
        receipt_status: string;
        entity_key: string;
        cursor_event_id: string;
        user_count: number;
      }[]
    >`
      SELECT user_row.primary_email AS email,
             identity.subject,
             receipt.status AS receipt_status,
             receipt.lifecycle_entity_key AS entity_key,
             cursor.event_id AS cursor_event_id,
             (SELECT count(*)::int FROM papercusp_auth.hosted_users) AS user_count
        FROM papercusp_auth.external_identities AS identity
        JOIN papercusp_auth.hosted_users AS user_row ON user_row.id = identity.hosted_user_id
        JOIN papercusp_auth.webhook_event_receipts AS receipt ON receipt.event_id = 'event_user_1'
        JOIN papercusp_auth.workos_lifecycle_entity_cursors AS cursor
          ON cursor.entity_key = receipt.lifecycle_entity_key
    `;
    expect(projection).toEqual({
      email: 'person@example.com',
      subject: 'user_workos_1',
      receipt_status: 'applied',
      entity_key: 'workos:user:user_workos_1',
      cursor_event_id: 'event_user_1',
      user_count: 1,
    });
  });

  it('never grants an upstream membership and marks that signed event ignored', async () => {
    const accepted = receipt('event_membership_grant', 'organization_membership.created', {
      id: 'membership_workos_1',
      user_id: 'user_workos_1',
      organization_id: 'org_workos_1',
      status: 'active',
    });
    await insertReceipt(accepted);
    const store = new PostgresWorkosLifecycleProjectionStore(runAsService);
    const worker = new WorkosLifecycleWorker(store, new PostgresWorkosAccessClosureSink(runAsService));
    await worker.apply(workosLifecycleEventFromReceipt(accepted)!);

    const [state] = await sql<{ memberships: number; status: string; code: string }[]>`
      SELECT (SELECT count(*)::int FROM papercusp_auth.organization_memberships) AS memberships,
             status,
             last_error_code AS code
        FROM papercusp_auth.webhook_event_receipts
       WHERE event_id = ${accepted.eventId}
    `;
    expect(state).toEqual({
      memberships: 0,
      status: 'ignored',
      code: 'membership-upsert',
    });
  });

  it('reduces an existing membership, revokes its hosted session, and clears closure only after delivery', async () => {
    const [user] = await sql<IdRow[]>`
      INSERT INTO papercusp_auth.hosted_users (primary_email)
      VALUES ('member@example.com') RETURNING id::text AS id
    `;
    await sql`
      INSERT INTO papercusp_auth.external_identities
        (hosted_user_id, provider, subject, provider_email)
      VALUES (${user.id}::uuid, 'workos', 'user_workos_2', 'member@example.com')
    `;
    const [organization] = await sql<IdRow[]>`
      INSERT INTO papercusp_auth.organizations
        (identity_provider, external_organization_id, display_name)
      VALUES ('workos', 'org_workos_2', 'Organization Two')
      RETURNING id::text AS id
    `;
    await sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, status, authority, created_via)
      VALUES
        (${organization.id}::uuid, ${user.id}::uuid, 'owner', 'active',
         'papercusp', 'organization_bootstrap')
    `;
    await sql`
      INSERT INTO papercusp_auth.hosted_sessions
        (id, user_id, organization_id, permission_version,
         upstream_provider, upstream_session_id, expires_at)
      VALUES
        (${SESSION_ID}, ${user.id}, ${organization.id}, 1,
         'workos', 'session_workos_2', now() + interval '1 hour')
    `;

    const accepted = receipt('event_membership_revoke', 'organization_membership.deleted', {
      id: 'membership_workos_2',
      user_id: 'user_workos_2',
      organization_id: 'org_workos_2',
    });
    await insertReceipt(accepted);
    const store = new PostgresWorkosLifecycleProjectionStore(runAsService);
    const worker = new WorkosLifecycleWorker(store, new PostgresWorkosAccessClosureSink(runAsService));
    await expect(worker.apply(workosLifecycleEventFromReceipt(accepted)!)).resolves.toMatchObject({
      disposition: 'applied',
      closureDelivered: true,
    });

    const [state] = await sql<
      {
        role: string;
        membership_status: string;
        session_revoked: boolean;
        closure_targets: unknown;
        closure_acknowledged: boolean;
      }[]
    >`
      SELECT membership.role,
             membership.status AS membership_status,
             session.revoked_at IS NOT NULL AS session_revoked,
             receipt.closure_targets,
             receipt.closure_acknowledged_at IS NOT NULL AS closure_acknowledged
        FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_sessions AS session
          ON session.user_id = membership.user_id::text
         AND session.organization_id = membership.organization_id::text
        JOIN papercusp_auth.webhook_event_receipts AS receipt
          ON receipt.event_id = ${accepted.eventId}
    `;
    expect(state).toEqual({
      role: 'owner',
      membership_status: 'revoked',
      session_revoked: true,
      closure_targets: null,
      closure_acknowledged: true,
    });
  });

  it('maps unsupported signed events to no authority-bearing lifecycle event', () => {
    expect(
      workosLifecycleEventFromReceipt(receipt('event_auth', 'authentication.password_succeeded', { id: 'x' })),
    ).toBeNull();
  });
});

interface IdRow {
  id: string;
}
