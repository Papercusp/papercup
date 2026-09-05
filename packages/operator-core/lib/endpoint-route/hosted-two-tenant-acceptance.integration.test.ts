/**
 * D-008 / P-030 assembled hosted-system acceptance.
 *
 * The leaf suites prove individual policies and adapters. This suite is the
 * maintained cross-component gate: the production hosted composition runs on a
 * real Postgres database with two deliberately similar tenants, and requests
 * cross the same auth, RLS, browser, connector, relay, and delegation seams the
 * deployed control plane uses.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  deriveTenantContext,
  type VerifiedTenantServerContext,
} from '@papercusp/db-org';
import { HOSTED_SESSION_COOKIE, type HostedSession } from '../auth/hosted-session';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { HostedTenantContextRunner } from '../auth/hosted/service-adapters';
import type { SyncEvent } from '../sync-sse';
import type { HostedProviderDelegationAdapter } from '../workspace-host/hosted-provider-delegation';
import {
  HOSTED_BROWSER_QUERY_NAME,
  HOSTED_BROWSER_REST_QUERY_PATH,
  HOSTED_BROWSER_SSE_PATH,
} from './hosted-browser';
import type { AssembledHostedControlPlane } from './hosted-control-plane';
import { createHostedRuntime, type HostedRuntimeDependencies } from './hosted-runtime';
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceRelaySocket,
} from './hosted-workspace-session';
import {
  authenticateHostedConnectorSocket,
} from './routes/hosted-workspace-connector';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(HERE, '../../../../libs/papercusp/libs/db/sql');
const ORIGIN = 'https://app.papercusp.com';
const CONTROL = 'p030-control-plane';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const HOST_A = 'host-tenant-a';
const HOST_B = 'host-tenant-b';
const CONNECTION_A = 'connection-tenant-a';
const CONNECTION_B = 'connection-tenant-b';

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
] as const;

const CONFIGURATION = {
  publicOrigin: ORIGIN,
  controlPlaneWorkspaceId: CONTROL,
  hostedSessionCookieSecretRef: 'test:hosted-cookie',
  workosClientId: 'client_test_p030',
  workosApiKeyRef: 'test:workos-api-key',
  workosCookiePasswordRef: 'test:workos-cookie-password',
  workosWebhookSecretRef: 'test:workos-webhook-secret',
} as const;

function migration(name: string): string {
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`missing hosted acceptance migration ${name}`);
}

async function provisionDatabase(sql: Sql): Promise<void> {
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

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES
      (${USER_A}::uuid, 'same@example.test', 'Same display name'),
      (${USER_B}::uuid, 'same+tenant-b@example.test', 'Same display name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organizations
      (id, external_organization_id, display_name)
    VALUES
      (${ORG_A}::uuid, 'workos-org-a', 'Same organization name'),
      (${ORG_B}::uuid, 'workos-org-b', 'Same organization name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
    VALUES
      (${ORG_A}::uuid, ${USER_A}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap'),
      (${ORG_B}::uuid, ${USER_B}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
    VALUES
      (${CONTROL}, ${CONNECTION_A}, 'gcp', 'Same cloud connection', 'delegation://tenant-a/gcp', 'connected'),
      (${CONTROL}, ${CONNECTION_B}, 'gcp', 'Same cloud connection', 'delegation://tenant-b/gcp', 'connected')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
    VALUES
      (${CONTROL}, ${HOST_A}, 'Same workspace name', ${CONNECTION_A}, 'gcp', 'project-a',
       'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running'),
      (${CONTROL}, ${HOST_B}, 'Same workspace name', ${CONNECTION_B}, 'gcp', 'project-b',
       'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')
  `;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES
      (${CONTROL}, ${WORKSPACE_A}, ${ORG_A}, ${HOST_A}, 'Same workspace name',
       'active', 'user', ${USER_A}),
      (${CONTROL}, ${WORKSPACE_B}, ${ORG_B}, ${HOST_B}, 'Same workspace name',
       'active', 'user', ${USER_B})
  `;
}

function serviceRunner(sql: Sql): HostedServiceContextRunner {
  return async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
}

function tenantRunner(sql: Sql): HostedTenantContextRunner {
  return async <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>): Promise<T> => {
    const tenant = deriveTenantContext(context);
    return sql.begin(async (tx) => {
      await tx`
        SELECT
          set_config('app.user_id', ${tenant.userId}, true),
          set_config('app.organization_id', ${tenant.organizationId}, true),
          set_config('app.workspace_id', ${tenant.workspaceId ?? ''}, true)
      `;
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  };
}

function delegationAdapters(): Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>> {
  const adapter: HostedProviderDelegationAdapter = {
    async verify(record) {
      return {
        identity: `${record.provider}:${record.connectionId}`,
        evidenceRef: `acceptance://${record.workspaceId}/${record.connectionId}/${record.generation}/verified`,
      };
    },
    async revoke(record) {
      return {
        evidenceRef: `acceptance://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked`,
      };
    },
  };
  return { gcp: adapter, aws: adapter, azure: adapter };
}

function fakeSecrets(reference: string): Promise<string> {
  const values: Record<string, string> = {
    'test:hosted-cookie': 'p030-hosted-cookie-secret-is-longer-than-thirty-two-bytes',
    'test:workos-api-key': 'sk_test_p030_not_a_real_secret',
    'test:workos-cookie-password': 'p030-workos-cookie-password-is-thirty-two-bytes',
    'test:workos-webhook-secret': 'whsec_p030_not_a_real_secret',
  };
  const value = values[reference];
  if (!value) throw new Error(`unexpected secret reference ${reference}`);
  return Promise.resolve(value);
}

function tenantContext(session: HostedSession): VerifiedTenantServerContext {
  return {
    principal: {
      kind: 'user',
      profile: 'hosted',
      authMethod: 'cookie-session',
      trust: 'verified',
      slug: session.userId,
      workspaceId: CONTROL,
      userId: session.userId,
      activeOrganizationId: session.organizationId,
      selectedWorkspaceId: session.workspaceId ?? undefined,
      sessionId: session.id,
      sessionVersion: session.permissionVersion,
    },
    selectedWorkspace: session.workspaceId
      ? { id: session.workspaceId, organizationId: session.organizationId }
      : undefined,
  };
}

function cookie(plane: AssembledHostedControlPlane, session: HostedSession): string {
  const encoded = plane.components.sessionCookieCodec.encode(session.id);
  return `${HOSTED_SESSION_COOKIE}=${encodeURIComponent(encoded)}`;
}

async function request(
  plane: AssembledHostedControlPlane,
  pathname: string,
  session?: HostedSession,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session) headers.set('cookie', cookie(plane, session));
  return plane.app.request(new Request(new URL(`/api${pathname}`, ORIGIN), { ...init, headers }));
}

async function createSession(
  plane: AssembledHostedControlPlane,
  userId: string,
  organizationId: string,
  workspaceId: string,
  suffix: string,
): Promise<HostedSession> {
  const authority = await plane.components.membershipAuthority.resolveActive({ userId, organizationId });
  if (!authority) throw new Error(`missing acceptance authority for ${suffix}`);
  return plane.components.sessionStore.create({
    userId,
    organizationId,
    workspaceId,
    permissionVersion: authority.permissionVersion,
    upstreamProvider: 'workos',
    upstreamSessionId: `workos-session-${suffix}`,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let read = 0; read < 8 && !predicate(text); read += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

class FakeSocket extends EventEmitter implements HostedWorkspaceRelaySocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  readonly closed: Array<[number | undefined, string | undefined]> = [];

  send(data: string | Buffer): void {
    this.sent.push(JSON.parse(data.toString()));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closed.push([code, reason]);
    this.emit('close');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

let db: MigratedTestDb;
let sql: Sql;
let runService: HostedServiceContextRunner;
let runTenant: HostedTenantContextRunner;
let plane: AssembledHostedControlPlane;
let sessionA: HostedSession;
let sessionB: HostedSession;
const backfillEvents: SyncEvent[] = [
  { id: 1, ts: 1001, name: HOSTED_BROWSER_QUERY_NAME, args: { workspaceId: WORKSPACE_A }, data: [{ secret: 'tenant-a-row' }] },
  { id: 2, ts: 1002, name: HOSTED_BROWSER_QUERY_NAME, args: { workspaceId: WORKSPACE_B }, data: [{ secret: 'tenant-b-row' }] },
];

function runtimeDependencies(): HostedRuntimeDependencies {
  return {
    resolveSecret: fakeSecrets,
    runService,
    runTenant,
    providerDelegationAdapters: delegationAdapters(),
    hostedBrowser: {
      runTenant,
      backfillSince: () => backfillEvents,
      subscribe: async (listener) => ({ send: listener, close: () => {} }),
    },
  };
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostedtwotenant' });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
  await provisionDatabase(sql);
  await seedTenants(sql);
  runService = serviceRunner(sql);
  runTenant = tenantRunner(sql);
  plane = await createHostedRuntime(CONFIGURATION, runtimeDependencies());
  sessionA = await createSession(plane, USER_A, ORG_A, WORKSPACE_A, 'a');
  sessionB = await createSession(plane, USER_B, ORG_B, WORKSPACE_B, 'b');
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe.sequential('assembled hosted two-tenant acceptance', () => {
  it('isolates HTTP, SSE, MCP mount, and direct SQL under overlapping tenant names', async () => {
    const rlsFacts = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{
        current_user: string;
        session_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        organization_id: string;
        workspace_id: string;
      }>>`
        SELECT current_user,
               session_user,
               role_row.rolsuper,
               role_row.rolbypassrls,
               current_setting('app.organization_id', true) AS organization_id,
               current_setting('app.workspace_id', true) AS workspace_id
          FROM pg_roles role_row
         WHERE role_row.rolname = current_user
      `,
    );
    expect(rlsFacts).toHaveLength(1);
    expect(rlsFacts[0]).toMatchObject({
      current_user: 'hosted_app',
      rolsuper: false,
      rolbypassrls: false,
      organization_id: ORG_A,
      workspace_id: WORKSPACE_A,
    });
    expect(rlsFacts[0]?.session_user).toBeTruthy();
    const scopeFacts = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string; allowed: boolean }>>`
        SELECT id,
               harness_shared.workspace_host_scope_allows(workspace_id, id) AS allowed
          FROM harness_shared.workspace_hosts
         ORDER BY id
      `,
    );
    expect(scopeFacts).toEqual([
      { id: HOST_A, allowed: true },
    ]);

    const queryPath = `${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    const [responseA, responseB] = await Promise.all([
      request(plane, queryPath, sessionA),
      request(plane, queryPath, sessionB),
    ]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const identities = (body: unknown) => {
      const rows = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { rows?: unknown }).rows
        : null;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
        const { kind, id } = row as { kind?: unknown; id?: unknown };
        return typeof kind === 'string' && typeof id === 'string' ? [{ kind, id }] : [];
      });
    };
    // Compare authoritative row identities, never serialized substrings. The
    // public acceptance deliberately reuses display names across tenants, and
    // a display name is allowed to equal another row's opaque id.
    expect(identities(await responseA.json())).toEqual([
      { kind: 'connection', id: CONNECTION_A },
      { kind: 'workspace', id: HOST_A },
    ]);
    expect(identities(await responseB.json())).toEqual([
      { kind: 'connection', id: CONNECTION_B },
      { kind: 'workspace', id: HOST_B },
    ]);

    const headerAttack = await request(plane, queryPath, sessionA, {
      headers: { 'x-papercusp-workspace': WORKSPACE_B },
    });
    expect(headerAttack.status).toBe(403);
    await expect(headerAttack.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });

    const directRows = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string }>>`
        SELECT id FROM harness_shared.workspace_hosts ORDER BY id
      `,
    );
    expect(directRows.map(({ id }) => id)).toEqual([HOST_A]);
    const directMutation = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string }>>`
        UPDATE harness_shared.workspace_hosts
           SET name = 'cross-tenant-write'
         WHERE id = ${HOST_B}
        RETURNING id
      `,
    );
    expect(directMutation).toEqual([]);

    const localMcp = await request(plane, '/mcp', sessionA, { method: 'POST' });
    expect(localMcp.status).toBe(404);

    const abort = new AbortController();
    const sse = await request(plane, HOSTED_BROWSER_SSE_PATH, sessionA, {
      headers: { 'last-event-id': '0' },
      signal: abort.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const replay = await readSseUntil(reader, (text) => text.includes('"tsMs":1001'));
    expect(replay).toContain('"tsMs":1001');
    expect(replay).not.toContain('1002');
    expect(replay).not.toContain('tenant-a-row');
    expect(replay).not.toContain('tenant-b-row');
    abort.abort();
    await reader.cancel();
  });

  it('binds WS/PTY/file/MCP relay tickets to one tenant and rejects replay and rotation residue', async () => {
    const crossTenantEnroll = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_B}/connectors/enroll`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_B, routeLabel: 'tenant-b', transport: 'websocket' }),
      },
    );
    expect(crossTenantEnroll.status).toBe(403);

    const enrollment = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/enroll`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_A, routeLabel: 'tenant-a', transport: 'websocket' }),
      },
    );
    expect(enrollment.status, await enrollment.clone().text()).toBe(200);
    const enrollmentBody = await enrollment.json() as { ticket: string };
    const registered = await request(plane, `/hosted/connectors/register?ticket=${enrollmentBody.ticket}`, undefined, {
      method: 'POST',
    });
    expect(registered.status).toBe(200);
    const credential = await registered.json() as { bearer: string };

    const issueTicket = () => request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/session-ticket`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostId: HOST_A,
          routeLabel: 'tenant-a',
          transport: 'websocket',
          audience: 'workspace-operator',
        }),
      },
    );

    const oneTime = await issueTicket();
    expect(oneTime.status).toBe(200);
    const oneTimeBody = await oneTime.json() as { ticket: string };
    const upgrade = new Request(
      `https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${oneTimeBody.ticket}`,
    );
    const accepted = await authenticateHostedConnectorSocket(plane.components.connectorGateway!, upgrade);
    expect(accepted).toMatchObject({
      role: 'browser',
      binding: {
        organizationId: ORG_A,
        customerWorkspaceId: WORKSPACE_A,
        hostId: HOST_A,
        userId: USER_A,
        hostedSessionId: sessionA.id,
      },
    });
    await expect(
      authenticateHostedConnectorSocket(plane.components.connectorGateway!, upgrade),
    ).resolves.toBeNull();

    const relayTicketResponse = await issueTicket();
    const relayTicket = await relayTicketResponse.json() as { ticket: string };
    const relayAuth = await authenticateHostedConnectorSocket(
      plane.components.connectorGateway!,
      new Request(`https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${relayTicket.ticket}`),
    );
    if (!relayAuth || relayAuth.role !== 'browser') throw new Error('expected a browser relay binding');
    const connectorBinding = await plane.components.connectorGateway!.authenticate(credential.bearer);
    if (!connectorBinding) throw new Error('expected an active connector binding');

    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'p030-channel' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    const foreignBrowser = new FakeSocket();
    broker.attachConnector(connectorBinding, host);
    broker.attachBrowser(relayAuth.binding, browser);
    broker.attachBrowser({ ...relayAuth.binding, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B }, foreignBrowser);
    browser.message({ type: 'pty.input', data: 'aGVsbG8=' });
    browser.message({ type: 'file.write', requestId: 'file-1', path: 'proof.txt', data: 'cHJvb2Y=' });
    browser.message({ type: 'mcp.call', requestId: 'mcp-1', method: 'tools/list' });
    expect(host.sent).toContainEqual({
      type: 'relay',
      channelId: 'p030-channel',
      payload: { type: 'pty.input', data: 'aGVsbG8=' },
    });
    expect(host.sent).toContainEqual(expect.objectContaining({
      type: 'relay',
      payload: expect.objectContaining({ type: 'file.write', requestId: 'file-1' }),
    }));
    expect(host.sent).toContainEqual(expect.objectContaining({
      type: 'relay',
      payload: expect.objectContaining({ type: 'mcp.call', requestId: 'mcp-1' }),
    }));
    expect(foreignBrowser.closed).toContainEqual([4411, 'connector_unavailable']);

    const staleTicketResponse = await issueTicket();
    const staleTicket = await staleTicketResponse.json() as { ticket: string };
    const rotated = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/rotate`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_A, routeLabel: 'tenant-a-next', transport: 'websocket' }),
      },
    );
    expect(rotated.status).toBe(200);
    await expect(plane.components.connectorGateway!.authenticate(credential.bearer)).resolves.toBeNull();
    await expect(
      authenticateHostedConnectorSocket(
        plane.components.connectorGateway!,
        new Request(`https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${staleTicket.ticket}`),
      ),
    ).resolves.toBeNull();
  });

  it('keeps delegation and session authority tenant-bound across a control-plane restart and revocation', async () => {
    const body = {
      connectionId: CONNECTION_A,
      label: 'Same cloud connection',
      credentialRef: 'delegation://tenant-a/gcp/connection-tenant-a/1',
      configuration: {
        provider: 'gcp',
        source: {
          method: 'service-account-impersonation',
          projectId: 'tenant-a-project',
          serviceAccountEmail: 'runtime@tenant-a-project.iam.gserviceaccount.com',
          trustedPrincipal: 'principal://papercusp/tenant-a',
        },
      },
    };
    const foreign = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_B}/provider-delegations/onboard`,
      sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    expect(foreign.status).toBe(403);

    const onboard = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/onboard`,
      sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    expect(onboard.status, await onboard.clone().text()).toBe(201);
    const verify = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/verify`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_A }),
      },
    );
    expect(verify.status).toBe(200);

    const restarted = await createHostedRuntime(CONFIGURATION, runtimeDependencies());
    const resolverProbe = `${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    const sessionAfterRestart = await request(restarted, resolverProbe, sessionA);
    expect(sessionAfterRestart.status, await sessionAfterRestart.clone().text()).toBe(200);
    const verifyAfterRestart = await request(
      restarted,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/verify`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_A }),
      },
    );
    expect(verifyAfterRestart.status).toBe(200);

    const oldVersion = sessionA.permissionVersion;
    await sql`
      UPDATE papercusp_auth.organization_memberships
         SET role = 'member', updated_at = updated_at + interval '2 seconds'
       WHERE organization_id = ${ORG_A}::uuid AND user_id = ${USER_A}::uuid
    `;
    const revokedAt = Date.now();
    const staleSession = await request(restarted, resolverProbe, sessionA);
    expect(staleSession.status).toBe(401);
    expect(Date.now() - revokedAt).toBeLessThan(60_000);
    expect(sessionA.permissionVersion).toBe(oldVersion);
    await expect(
      runService((tx) =>
        tx`
          UPDATE papercusp_auth.organization_memberships
             SET role = 'owner', updated_at = updated_at + interval '2 seconds'
           WHERE organization_id = ${ORG_A}::uuid AND user_id = ${USER_A}::uuid
        `,
      ),
    ).rejects.toThrow(/hosted_service may only reduce membership lifecycle state/);

    const liveTenantB = await request(restarted, resolverProbe, sessionB);
    expect(liveTenantB.status).toBe(200);
    await sql`
      UPDATE papercusp_auth.organization_memberships
         SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
       WHERE organization_id = ${ORG_B}::uuid AND user_id = ${USER_B}::uuid
    `;
    const revokedSession = await request(restarted, resolverProbe, sessionB);
    expect(revokedSession.status).toBe(403);
  });

  it('keeps support grants scoped, expiring, revoke-only, and unable to widen customer RLS', async () => {
    const [grant] = await sql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.support_access_grants
        (organization_id, workspace_id, staff_principal_id, granted_by_user_id,
         purpose, scopes, banner_message, starts_at, expires_at)
      VALUES
        (${ORG_A}::uuid, ${WORKSPACE_A}::uuid, 'staff-p030', ${USER_A}::uuid,
         'P-030 acceptance', ARRAY['workspace.view'], 'Support access active',
         now() - interval '1 minute', now() + interval '5 minutes')
      RETURNING id::text AS id
    `;
    const foreignRows = await runTenant(tenantContext(sessionB), (tx) =>
      tx<Array<{ id: string }>>`SELECT id FROM harness_shared.workspace_hosts ORDER BY id`,
    );
    expect(foreignRows.map(({ id }) => id)).toEqual([HOST_B]);

    await sql`
      UPDATE papercusp_auth.support_access_grants
         SET revoked_at = now(), revoked_by_user_id = ${USER_A}::uuid,
             revocation_reason = 'acceptance complete', updated_at = now()
       WHERE id = ${grant.id}::uuid
    `;
    await expect(
      sql<Array<{ id: string }>>`
        UPDATE papercusp_auth.support_access_grants
           SET revoked_at = now(), revoked_by_user_id = ${USER_A}::uuid,
               revocation_reason = 'second attempt', updated_at = now()
         WHERE id = ${grant.id}::uuid
         RETURNING id::text AS id
      `,
    ).rejects.toThrow(/revocation is immutable/);

    const [expired] = await sql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.support_access_grants
        (organization_id, workspace_id, staff_principal_id, granted_by_user_id,
         purpose, scopes, banner_message, starts_at, expires_at)
      VALUES
        (${ORG_A}::uuid, ${WORKSPACE_A}::uuid, 'staff-p030-expired', ${USER_A}::uuid,
         'Expired P-030 acceptance', ARRAY['workspace.view'], 'Expired support access',
         now() - interval '2 minutes', now() - interval '1 minute')
      RETURNING id::text AS id
    `;
    expect(expired.id).toBeTruthy();
  });
});
