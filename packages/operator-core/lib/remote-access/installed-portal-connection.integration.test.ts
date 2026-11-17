/** Persisted installed-client authority across real broker sockets and process restarts.
 * The served Portal suite owns login/consent UI and actual desktop pixels. Here
 * the maintained local relay runtime reads real PG on every authorization. */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SecretStream from '@hyperswarm/secret-stream';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { createOrgTestDb } from '../../test/_org-test-db';
import { drainDetached } from '../detached-imports';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from '../endpoint-route/hosted-workspace-connector';
import { linkedWorkspaceIdentity } from '../endpoint-route/routes/hosted-cli/store';
import { ByocSealedChannel, isByocSealedPacket } from '../workspace-host/byoc-sealed-channel';
import { registerDesktopSession, markDesktopReady } from '../desktop/desktop-session-registry';
import { ensurePortalRelayRow, recordPortalRelayConsent, savePortalRelayLinked, readPortalRelay, PORTAL_RELAY_DESKTOP_NOTICE_VERSION } from './portal-relay-store';
import { PORTAL_RELAY_NOTICE_VERSION } from './relay-notice';

describe('persisted installed Portal connection', () => {
  it('enforces consent, account/install/browser identity, restart and revocation through the production local runtime', async () => {
    const db = await createOrgTestDb();
    // Registry writes also publish invalidations through the process-wide
    // client. Keep that real side effect on this same throwaway database.
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', db.adminDsn);
    vi.stubEnv('HARNESS_DATABASE_URL', db.appDsn);
    vi.stubEnv('DATABASE_URL', db.adminDsn);
    const root = await mkdtemp(join(tmpdir(), 'installed-portal-integration-'));
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const installId = 'inst-persisted-integration', organizationId = 'integration-org', userId = 'integration-user';
    const localWorkspaceId = 'installed-integration-workspace', portalOrigin = 'https://portal.integration.test';
    const identity = linkedWorkspaceIdentity(organizationId, installId);
    const binding: HostedConnectorBinding = { ...identity, organizationId, controlPlaneWorkspaceId: 'integration-control',
      generation: 1, transport: 'websocket', state: 'active', hosting: 'papercusp' };
    const wire: string[] = [];
    server.on('connection', (socket, request) => {
      const url = new URL(request.url!, 'http://fixture');
      socket.on('message', bytes => wire.push(bytes.toString()));
      if (url.searchParams.get('peer') === 'host') broker.attachConnector(binding, socket);
      else {
        const ticket: HostedConnectorTicketBinding = { ...binding, kind: 'session',
          userId: url.searchParams.get('user') ?? userId, hostedSessionId: 'integration-session',
          audience: 'workspace-operator', expiresAt: new Date(Date.now() + 60_000) };
        broker.attachBrowser(ticket, socket, { kind: 'desktop-discovery', sealed: true });
      }
    });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('integration_socket_not_listening');
    const url = `ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`;
    const opts = { sql: db.adminSql, encryptionKey: 'private-integration-encryption-key' };
    const browser = SecretStream.keyPair(Buffer.alloc(32, 82));
    let host: ChildProcess | undefined;
    let hostErrors = '', sequence = 0;
    const messages: Array<Record<string, any>> = [];
    const connections: Array<{ socket: WebSocket; noise: ByocSealedChannel }> = [];
    const request = async (type: string, extra: Record<string, unknown> = {}) => {
      const requestId = `request-${sequence++}`;
      host!.send({ type, requestId, ...extra });
      await vi.waitFor(() => {
        expect(host!.exitCode, hostErrors).toBeNull();
        expect(messages.some(value => value.requestId === requestId), `${type}:${requestId} pid=${host!.pid} ${hostErrors}`).toBe(true);
      }, { timeout: 20_000 });
      const result = messages.find(value => value.requestId === requestId)!;
      if (result.type === 'error') throw Object.assign(new Error(result.message), { code: result.code });
      return result;
    };
    const boot = async () => {
      hostErrors = '';
      host = fork(fileURLToPath(new URL('./fixtures/installed-portal-host.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn,
          DATABASE_URL: db.adminDsn, PAPERCUSP_DB_ENCRYPTION_KEY: opts.encryptionKey, STATE_DIRECTORY: root,
          PAPERCUSP_INSTALLED_INTEGRATION_ROOT: root },
      });
      host.stderr!.on('data', data => { hostErrors = (hostErrors + String(data)).slice(-4000); });
      host.on('message', value => messages.push(value as Record<string, any>));
      await vi.waitFor(() => expect(messages.some(value => value.type === 'ready' && value.pid === host!.pid), hostErrors).toBe(true), { timeout: 20_000 });
    };
    const stop = async () => {
      if (!host || host.exitCode !== null || host.signalCode !== null) return;
      const exited = once(host, 'exit');
      host.send({ type: 'stop', requestId: `stop-${sequence++}` });
      const deadline = setTimeout(() => host!.kill('SIGKILL'), 5000);
      await exited; clearTimeout(deadline);
    };
    const connect = async (machinePublicKey: string, asUser = userId, seed = 82) => {
      const socket = new WebSocket(`${url}?user=${encodeURIComponent(asUser)}`);
      const frames: Array<Record<string, any>> = [];
      let noise: ByocSealedChannel | undefined;
      socket.on('message', data => { const frame = JSON.parse(data.toString()); if (isByocSealedPacket(frame)) noise?.receive(frame); });
      await once(socket, 'open');
      noise = new ByocSealedChannel({ initiator: true, localKeyPair: SecretStream.keyPair(Buffer.alloc(32, seed)),
        expectedRemotePublicKey: Buffer.from(machinePublicKey, 'base64'),
        sendPacket: packet => socket.send(JSON.stringify(packet)), onFrame: frame => frames.push(frame), onError: () => {} });
      connections.push({ socket, noise });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          await noise.opened;
          await vi.waitFor(() => expect(frames).toContainEqual({ type: 'desktop.discovery.ready' }));
        })(),
          new Promise<never>((_, reject) => {
            socket.once('close', (code, reason) => reject(new Error(`desktop_channel_denied:${code}:${reason}`)));
            deadline = setTimeout(() => reject(new Error('desktop_handshake_deadline')), 4000);
          })]);
        return { socket, noise, frames };
      } catch (error) { noise.close(); socket.terminate(); throw error; }
      finally { clearTimeout(deadline); }
    };
    try {
      const migration = new URL('../../../../libs/papercusp/libs/db/sql/1635-portal-relay-desktop-grants.sql', import.meta.url);
      await db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(`${migration.href}.DRAFT`), 'utf8').replace(/^\\.*$/gm, ''));
      await mkdir(join(root, localWorkspaceId));
      await ensurePortalRelayRow({ installId, portalOrigin }, opts);
      await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: userId }, opts);
      await savePortalRelayLinked({ userId, organizationId, customerWorkspaceId: identity.customerWorkspaceId,
        appBaseUrl: `${portalOrigin}/apps/${identity.customerWorkspaceId}`, connectorUrl: url,
        connectorBearer: 'private-integration-connector', operatorPort: 3070 }, opts);
      const desktop = await registerDesktopSession({ workspaceId: localWorkspaceId, kind: 'xvfb-local',
        scope: 'agent', scopeRef: 'integration-agent', name: 'private-persisted-desktop',
        display: ':192', displayGeometry: { width: 800, height: 600 } }, db.adminSql);
      await markDesktopReady(desktop.id, {}, db.adminSql);
      await boot();
      const appOnly = await request('start', { url: `${url}?peer=host` });
      expect(appOnly.pid).toBe(host!.pid); expect(appOnly.pid).not.toBe(process.pid);
      expect(appOnly.grant).toBeNull();
      await expect(connect(appOnly.machinePublicKey)).rejects.toThrow('sealed_channel_unavailable');
      const approval = { noticeVersion: PORTAL_RELAY_DESKTOP_NOTICE_VERSION, installId, portalOrigin, userId,
        organizationId, customerWorkspaceId: identity.customerWorkspaceId, localWorkspaceId,
        browserPublicKey: browser.publicKey.toString('base64'), view: true, control: false };
      for (const changed of [{ userId: 'other-user' }, { installId: 'inst-other' }, { organizationId: 'other-org' }]) {
        await expect(request('approve', { approval: { ...approval, ...changed } })).rejects.toMatchObject({ code: 'desktop_binding_changed' });
        expect((await readPortalRelay(opts))?.desktopGrant).toBeNull();
      }
      const consent = await request('approve', { approval });
      expect(consent.grant).toMatchObject({ installId, userId, organizationId, localWorkspaceId,
        browserPublicKey: approval.browserPublicKey, view: true, control: false, id: expect.any(String) });
      const linked = await request('start', { url: `${url}?peer=host` });
      const connection = await connect(linked.machinePublicKey);
      await connection.noise.send({ type: 'desktop.roster', requestId: 'before-restart' });
      await vi.waitFor(() => expect(connection.frames).toContainEqual(expect.objectContaining({ type: 'desktop.roster.result',
        requestId: 'before-restart', desktops: [expect.objectContaining({ desktopSessionId: desktop.id, name: 'private-persisted-desktop' })] })));
      await expect(connect(linked.machinePublicKey, 'other-user')).rejects.toThrow('desktop_access_revoked');
      await expect(connect(linked.machinePublicKey, userId, 83)).rejects.toThrow('sealed_channel');
      const closed = once(connection.socket, 'close');
      await stop(); await closed;
      await boot();
      const resumed = await request('start', { url: `${url}?peer=host` });
      expect(resumed).toMatchObject({ installId, machinePublicKey: linked.machinePublicKey, grant: consent.grant });
      const recovered = await connect(resumed.machinePublicKey);
      await recovered.noise.send({ type: 'desktop.roster', requestId: 'after-restart' });
      await vi.waitFor(() => expect(recovered.frames.some(frame => frame.requestId === 'after-restart')).toBe(true));
      const revoked = once(recovered.socket, 'close');
      await request('revoke'); await revoked;
      expect(await readPortalRelay(opts)).toMatchObject({ installId, state: 'linked', desktopGrant: null });
      await request('start', { url: `${url}?peer=host` });
      await expect(connect(resumed.machinePublicKey)).rejects.toThrow('sealed_channel_unavailable');
      await stop(); await boot();
      const afterRevocation = await request('start', { url: `${url}?peer=host` });
      expect(afterRevocation).toMatchObject({ installId, grant: null });
      await expect(connect(afterRevocation.machinePublicKey)).rejects.toThrow('sealed_channel_unavailable');
      expect(wire.join('\n')).not.toContain('private-persisted-desktop');
      expect(wire.some(packet => packet.includes('sealed.packet'))).toBe(true);
    } finally {
      for (const connection of connections) { connection.noise.close(); connection.socket.terminate(); }
      await stop(); broker.dispose();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await drainDetached();
      await getOrgPg().sql.end();
      vi.unstubAllEnvs();
      await db.cleanup(); await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
