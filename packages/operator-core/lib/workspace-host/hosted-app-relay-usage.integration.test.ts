/**
 * PostgresHostedAppRelayUsageStore against the real hosted schema (plan
 * external-app-access-to-workspaces-2026-09-29 P-007, WI-10004018; D-006, D-008).
 *
 * Migrations 1254 (the table) + 1255 (ownership, FORCE RLS, grants) are applied on
 * top of the same hosted migration set the two-tenant acceptance test uses, and the
 * store runs as `hosted_service`, exactly as the portal composes it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { PostgresHostedAppRelayUsageStore, appRelayMonth, type AppRelayServiceRunner } from './hosted-app-relay';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(HERE, '../../../../libs/papercusp/libs/db/sql');
const CONTROL = 'p007-control-plane';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

const MIGRATIONS = [
  '887-workspace-host-observability.sql',
  '902-hosted-session-webhook-receipts.sql',
  '903-customer-organization-boundary.sql',
  '904-hosted-identity-links.sql',
  '906-customer-workspace-directory.sql',
  '907-hosted-governance.sql',
  '978-hosted-customer-rls.sql',
  '979-workspace-host-tenant-rls.sql',
  '997-hosted-app-role-membership.sql',
  '1002-workos-sealed-session-vault.sql',
  '1005-hosted-service-lifecycle-runtime.sql',
  '1009-hosted-workspace-reverse-connectors.sql',
  '1010-hosted-provider-delegation-metadata.sql',
  '1126-hosted-two-tenant-boundary-repair.sql',
  '1127-workspace-host-domain-contracts.sql',
  '1188-hosted-self-signup.sql',
  '1254-hosted-app-relay-usage.sql',
  '1255-hosted-app-relay-usage-grants.sql',
] as const;

const A = { controlPlaneWorkspaceId: CONTROL, organizationId: ORG_A, customerWorkspaceId: WORKSPACE_A };
const B = { controlPlaneWorkspaceId: CONTROL, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B };
const SEPTEMBER = appRelayMonth(new Date(Date.UTC(2026, 8, 30, 23, 59, 59)));
const OCTOBER = appRelayMonth(new Date(Date.UTC(2026, 9, 1, 0, 0, 1)));

let db: MigratedTestDb;
let sql: Sql;
let store: PostgresHostedAppRelayUsageStore;

function migration(name: string): string {
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  throw new Error(`missing armed migration ${name}`);
}

async function provisionDatabase(): Promise<void> {
  await sql.unsafe(`
    DO $roles$
    DECLARE target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY['harness_admin', 'harness_app', 'harness_zero']
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      EXECUTE format('GRANT harness_admin, harness_app, harness_zero TO %I', current_user);
    END
    $roles$;
    CREATE SCHEMA harness_shared;
    CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN COALESCE(NEW, OLD);
    END
    $$;
  `);
  for (const name of MIGRATIONS) await sql.unsafe(migration(name));
}

async function seedWorkspaces(): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES (${USER_A}::uuid, 'a@example.test', 'A'), (${USER_B}::uuid, 'b@example.test', 'B')`;
  await sql`
    INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${ORG_A}::uuid, 'workos-org-a', 'Org A'), (${ORG_B}::uuid, 'workos-org-b', 'Org B')`;
  await sql`
    INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref, status)
    VALUES (${CONTROL}, 'conn-a', 'gcp', 'A', 'delegation://a/gcp', 'connected'),
           (${CONTROL}, 'conn-b', 'gcp', 'B', 'delegation://b/gcp', 'connected')`;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${CONTROL}, 'host-a', 'A', 'conn-a', 'gcp', 'project-a', 'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running'),
           (${CONTROL}, 'host-b', 'B', 'conn-b', 'gcp', 'project-b', 'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
    VALUES (${CONTROL}, ${WORKSPACE_A}, ${ORG_A}, 'host-a', 'A', 'active', 'user', ${USER_A}),
           (${CONTROL}, ${WORKSPACE_B}, ${ORG_B}, 'host-b', 'B', 'active', 'user', ${USER_B})`;
}

function runAs(role: string): AppRelayServiceRunner {
  return async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'p007relayusage' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionDatabase();
  await seedWorkspaces();
  store = new PostgresHostedAppRelayUsageStore(runAs('hosted_service'));
}, 180_000);

beforeEach(async () => {
  await sql`TRUNCATE papercusp_auth.hosted_app_relay_usage`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('PostgresHostedAppRelayUsageStore (migrations 1254 + 1255)', () => {
  it('adds bytes and requests per workspace per month, as the hosted service role', async () => {
    expect(await store.monthBytes(A, SEPTEMBER)).toBe(0);
    await store.add(A, SEPTEMBER, { bytes: 60, requests: 1 });
    await store.add(A, SEPTEMBER, { bytes: 40, requests: 1 });

    expect(await store.monthBytes(A, SEPTEMBER)).toBe(100);
    const [row] = await sql<{ bytes: string; requests: string }[]>`
      SELECT bytes, requests FROM papercusp_auth.hosted_app_relay_usage WHERE customer_workspace_id = ${WORKSPACE_A}`;
    expect({ bytes: Number(row?.bytes), requests: Number(row?.requests) }).toEqual({ bytes: 100, requests: 2 });
  });

  it('keeps each workspace and each calendar month separate', async () => {
    await store.add(A, SEPTEMBER, { bytes: 64, requests: 1 });
    await store.add(B, SEPTEMBER, { bytes: 5, requests: 1 });
    await store.add(A, OCTOBER, { bytes: 7, requests: 1 });

    expect(await store.monthBytes(A, SEPTEMBER)).toBe(64);
    expect(await store.monthBytes(B, SEPTEMBER)).toBe(5);
    expect(await store.monthBytes(A, OCTOBER)).toBe(7);
    expect(await store.monthBytes(B, OCTOBER)).toBe(0);
  });

  it('refuses a usage row for a workspace that does not exist', async () => {
    const unknown = { ...A, customerWorkspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    await expect(store.add(unknown, SEPTEMBER, { bytes: 1, requests: 1 })).rejects.toThrow(/foreign key/i);
  });

  it('stores counts only: no column can hold any part of a relayed call (D-008, R-38)', async () => {
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'papercusp_auth' AND table_name = 'hosted_app_relay_usage'
       ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'bytes', 'control_workspace_id', 'customer_workspace_id', 'month', 'organization_id', 'requests', 'updated_at',
    ]);
  });

  it('is closed to every role but hosted_service, with row security forced', async () => {
    const [table] = await sql<{ owner: string; rls: boolean; forced: boolean }[]>`
      SELECT relowner::regrole::text AS owner, relrowsecurity AS rls, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'papercusp_auth.hosted_app_relay_usage'::regclass`;
    expect(table).toEqual({ owner: 'hosted_owner', rls: true, forced: true });

    for (const role of ['hosted_app', 'harness_app', 'harness_zero']) {
      await expect(runAs(role)((tx) => tx`SELECT bytes FROM papercusp_auth.hosted_app_relay_usage`))
        .rejects.toThrow(/permission denied/i);
    }
  });
});
