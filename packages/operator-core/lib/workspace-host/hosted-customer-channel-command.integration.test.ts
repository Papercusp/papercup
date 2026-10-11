/**
 * Persisted authority → native WS broker → host adapter → real command process.
 * Socket bindings are trusted fixture inputs: ticket issuance/upgrade admission
 * stays in hosted-two-tenant-acceptance.integration.test.ts. The maintained
 * identity wrapper runs under the test UID; this is not SSH/provider acceptance.
 */
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildLoopbackIdentitySpawn } from '@papercusp/papercusp-shared/agent';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { createHostedChannelPrincipalResolver } from '../auth/hosted-principal-resolver';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from '../endpoint-route/hosted-workspace-connector';
import { HostedWorkspaceHostSessionAdapter } from './hosted-session-host';
import { bindHostedCustomerCommandExecutor } from './hosted-customer-command';

// Measure real process side effects, without writing to the shared task ledger.
vi.mock('../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: vi.fn(() => ({ taskId: randomUUID(), enrolled: false })),
  completeSyncEnrolment: vi.fn(), finishSyncEnrolment: vi.fn(),
}));

const CONTROL = 'hosted-command-acceptance';
let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb({ adminPoolMax: 4 }); }, 180_000);
afterAll(async () => { await db?.cleanup(); });
afterEach(() => { vi.unstubAllEnvs(); });

async function tenant(label: string, root: string) {
  const sql = db.adminSql;
  const userId = randomUUID(), organizationId = randomUUID(), customerWorkspaceId = randomUUID();
  const hostId = `command-host-${customerWorkspaceId}`, connectionId = `command-connection-${customerWorkspaceId}`;
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES (${userId}::uuid, ${`${userId}@example.test`}, 'Same display name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${`workos-${organizationId}`}, 'Same organization name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
    VALUES (${CONTROL}, ${connectionId}, 'gcp', 'Same connection', 'acceptance://no-provider', 'connected')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${CONTROL}, ${hostId}, 'Same host name', ${connectionId}, 'gcp', 'acceptance',
      'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')
  `;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES (${CONTROL}, ${customerWorkspaceId}, ${organizationId}, ${hostId}, 'Same workspace name',
      'active', 'user', ${userId})
  `;
  const store = new HostedSessionStore(sql);
  const membershipAuthority = new PostgresHostedMembershipAuthority(sql);
  const authority = await membershipAuthority.resolveActive({ userId, organizationId });
  if (!authority) throw new Error('missing command acceptance membership');
  const session = await store.create({ userId, organizationId, workspaceId: customerWorkspaceId,
    permissionVersion: authority.permissionVersion, upstreamProvider: 'workos',
    upstreamSessionId: `command-session-${userId}`, expiresAt: new Date(Date.now() + 60 * 60_000) });
  const binding: HostedConnectorBinding = { controlPlaneWorkspaceId: CONTROL, organizationId,
    customerWorkspaceId, hostId, routeLabel: `command-${label}`, generation: 1, transport: 'websocket', state: 'active' };
  const ticket: HostedConnectorTicketBinding = { ...binding, kind: 'session', audience: 'workspace-operator',
    userId, hostedSessionId: session.id, expiresAt: new Date(Date.now() + 60_000) };
  const home = join(root, label), project = join(home, "project ' $literal");
  mkdirSync(project, { recursive: true });
  const transform = vi.fn(buildLoopbackIdentitySpawn({
    transportCommand: '/bin/bash', transportArgs: ['-c'], identity: 'test-customer',
    nodePath: process.execPath, remoteHome: home, spawnRoot: join(home, 'spawns'),
    localHome: root, baseEnv: process.env, remotePath: ['/usr/bin', '/bin'],
  }));
  return { binding, ticket, session, store, project, transform };
}

describe.sequential('persisted hosted channel command acceptance', () => {
  it.each(['session-expiry', 'session-revocation', 'role-version', 'membership-revocation'] as const)(
    'refuses command side effects after %s on the original native channel while tenant B executes', async (ending) => {
      const root = mkdtempSync(join(tmpdir(), 'hosted-channel-command-'));
      const sockets: WebSocket[] = [];
      const adapters: HostedWorkspaceHostSessionAdapter[] = [];
      const errors: unknown[] = [];
      let server: WebSocketServer | undefined, broker: HostedWorkspaceSessionBroker | undefined;
      try {
        vi.stubEnv('OPERATOR_DB_URL', 'synthetic-private-db');
        vi.stubEnv('PAPERCUSP_SID', 'synthetic-private-session');
        const tenants = [await tenant('a', root), await tenant('b', root)];
        const sessionStore = new HostedSessionStore(db.adminSql);
        const membershipAuthority = new PostgresHostedMembershipAuthority(db.adminSql);
        broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0,
          resolveChannelPrincipal: binding => createHostedChannelPrincipalResolver({
            controlPlaneWorkspaceId: CONTROL, sessionStore, membershipAuthority,
          }, binding)(),
        });
        server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        server.on('error', error => errors.push(error));
        server.on('connection', (socket, request) => {
          socket.on('error', error => errors.push(error));
          const match = /^\/(host|browser)\/([01])$/.exec(request.url ?? '');
          if (!match) { socket.close(4403); return; }
          const t = tenants[Number(match[2])];
          // Deliberately trusted bindings, supplied on the server side only.
          if (match[1] === 'host') broker!.attachConnector(t.binding, socket);
          else broker!.attachBrowser(t.ticket, socket, { kind: 'operator-http' });
        });
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('private command socket address unavailable');
        const base = `ws://127.0.0.1:${address.port}`;
        const dial = async (path: string) => {
          const socket = new WebSocket(`${base}${path}`);
          const frames: Array<Record<string, unknown>> = [];
          sockets.push(socket);
          socket.on('message', data => frames.push(JSON.parse(data.toString())));
          socket.on('error', error => errors.push(error));
          await once(socket, 'open');
          return { socket, frames };
        };
        const connections = [];
        for (const [index, t] of tenants.entries()) {
          const host = await dial(`/host/${index}`);
          const adapter = new HostedWorkspaceHostSessionAdapter({ binding: t.binding, workspaceRoot: t.project,
            send: frame => { host.socket.send(JSON.stringify(frame)); },
          });
          adapters.push(adapter);
          host.socket.on('message', data => { void adapter.accept(JSON.parse(data.toString())).catch(error => errors.push(error)); });
          const browser = await dial(`/browser/${index}`);
          await vi.waitFor(() => expect(browser.frames).toContainEqual(expect.objectContaining({ type: 'session.bound' })));
          const channelId = browser.frames.find(frame => frame.type === 'session.bound')!.channelId as string;
          await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({ type: 'relay.open', channelId })));
          const deps = { resolvePrincipal: () => adapter.resolveCustomerPrincipal(channelId),
            sessionHeaders: new Headers(), customerWorkspaceId: t.binding.customerWorkspaceId,
            projectDir: t.project, transform: t.transform };
          const executor = await bindHostedCustomerCommandExecutor(deps);
          const foreign = tenants[1 - index].binding.customerWorkspaceId;
          await expect(bindHostedCustomerCommandExecutor({ ...deps, customerWorkspaceId: foreign }))
            .rejects.toThrow('hosted_customer_execution_denied');
          expect(t.transform).not.toHaveBeenCalled();
          connections.push({ t, host, browser, channelId, adapter, executor });
        }
        const [a, b] = connections;
        const first = await a.executor.run({ command: 'printf tenant-a > before; printf "%s|%s" "$OPERATOR_DB_URL" "$PAPERCUSP_SID"' });
        expect(first).toMatchObject({ exitCode: 0, stdout: '|', stderr: '', signal: null, taskEnrolled: false });
        expect(readFileSync(join(a.t.project, 'before'), 'utf8')).toBe('tenant-a');
        expect(existsSync(join(b.t.project, 'before'))).toBe(false);
        expect(a.t.transform).toHaveBeenCalledTimes(1);

        if (ending === 'session-expiry') {
          const changed = await db.adminSql<Array<{ id: string }>>`
            UPDATE papercusp_auth.hosted_sessions
               SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
             WHERE id = ${a.t.session.id} RETURNING id
          `;
          expect(changed).toEqual([{ id: a.t.session.id }]);
        } else if (ending === 'session-revocation') {
          expect(await a.t.store.revoke(a.t.session.id, 'command_acceptance_logout')).toBe(true);
        } else if (ending === 'role-version') {
          const changed = await db.adminSql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET role = 'member', updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${a.t.session.organizationId}::uuid AND user_id = ${a.t.session.userId}::uuid
            RETURNING user_id
          `;
          expect(changed).toEqual([{ user_id: a.t.session.userId }]);
        } else {
          const changed = await db.adminSql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${a.t.session.organizationId}::uuid AND user_id = ${a.t.session.userId}::uuid
            RETURNING user_id
          `;
          expect(changed).toEqual([{ user_id: a.t.session.userId }]);
        }
        // Reuse the bound executor/channel, rather than reconnecting after revocation.
        await expect(a.executor.run({ command: 'printf forbidden > forbidden' }))
          .rejects.toThrow('hosted_customer_execution_denied');
        expect(a.t.transform).toHaveBeenCalledTimes(1);
        expect(existsSync(join(a.t.project, 'forbidden'))).toBe(false);
        expect(readFileSync(join(a.t.project, 'before'), 'utf8')).toBe('tenant-a');
        const survivor = await b.executor.run({ command: 'printf tenant-b > survivor; printf survivor' });
        expect(survivor).toMatchObject({ exitCode: 0, stdout: 'survivor', stderr: '', signal: null });
        expect(readFileSync(join(b.t.project, 'survivor'), 'utf8')).toBe('tenant-b');
        expect(existsSync(join(a.t.project, 'survivor'))).toBe(false);
        expect(b.t.transform).toHaveBeenCalledTimes(1);
        for (const connection of connections) {
          expect(connection.host.socket.readyState).toBe(WebSocket.OPEN);
          expect(connection.browser.socket.readyState).toBe(WebSocket.OPEN);
        }
        expect(errors).toEqual([]);
      } finally {
        for (const adapter of adapters) adapter.close();
        broker?.dispose();
        for (const socket of sockets) socket.terminate();
        if (server) {
          for (const socket of server.clients) socket.terminate();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        }
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    }, 30_000,
  );
});
