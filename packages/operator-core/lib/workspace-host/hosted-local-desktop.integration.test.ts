import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import SecretStream from '@hyperswarm/secret-stream';
import { describe, expect, it, vi } from 'vitest';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from '../endpoint-route/hosted-workspace-connector';
import { ByocSealedChannel, isByocSealedPacket } from './byoc-sealed-channel';

/** Real loopback sockets and a separate outbound host process. Auth bindings and
 * desktop provider data are controlled fixtures; this does not claim live-account
 * pairing, real OS capture, or database grant acceptance. */
describe('linked desktop connector across process/socket boundaries', () => {
  it.each([63, 64, 65, 193])('paginates %i desktops through Noise and rechecks a revoked grant', async count => {
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const binding: HostedConnectorBinding = { controlPlaneWorkspaceId: 'test-control', organizationId: 'test-org',
      customerWorkspaceId: 'test-workspace', hostId: 'test-host', routeLabel: 'test-route',
      generation: 1, transport: 'websocket', state: 'active', hosting: 'papercusp' };
    const ticket: HostedConnectorTicketBinding = { ...binding, kind: 'session', userId: 'test-user',
      hostedSessionId: 'test-session', audience: 'workspace-operator', expiresAt: new Date(Date.now() + 60_000) };
    const captures: string[] = [];
    server.on('connection', (socket, request) => {
      socket.on('message', data => captures.push(data.toString()));
      if (new URL(request.url!, 'http://fixture').searchParams.get('peer') === 'host') broker.attachConnector(binding, socket);
      else broker.attachBrowser(ticket, socket, { kind: 'desktop-discovery', sealed: true });
    });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_socket_not_listening');
    const url = `ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`;
    const child = fork(fileURLToPath(new URL('./fixtures/linked-desktop-host.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Array<Record<string, unknown>> = [];
    let childErrors = '';
    child.stdout?.resume(); child.stderr?.on('data', data => { childErrors = (childErrors + String(data)).slice(-4000); });
    child.on('message', message => messages.push(message as Record<string, unknown>));
    child.send({ type: 'start', url: `${url}?peer=host`, count });
    let socket: WebSocket | undefined;
    let noise: ByocSealedChannel | undefined;
    try {
      await vi.waitFor(() => expect(messages.some(message => message.type === 'bound'), childErrors).toBe(true), { timeout: 15_000 });
      const bound = messages.find(message => message.type === 'bound')!;
      expect(bound.pid).toBe(child.pid); expect(child.pid).not.toBe(process.pid);
      socket = new WebSocket(url);
      const frames: Record<string, unknown>[] = [];
      socket.on('message', data => { const frame: unknown = JSON.parse(data.toString()); if (isByocSealedPacket(frame)) noise?.receive(frame); });
      await once(socket, 'open');
      noise = new ByocSealedChannel({ initiator: true,
        localKeyPair: SecretStream.keyPair(Buffer.alloc(32, 82)),
        expectedRemotePublicKey: Buffer.from(String(bound.machinePublicKey), 'base64'),
        sendPacket: packet => socket!.send(JSON.stringify(packet)), onFrame: frame => frames.push(frame), onError: () => {},
      });
      await noise.opened;
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'desktop.discovery.ready' }));
      const listed: string[] = [];
      let cursor: string | undefined;
      let generation: unknown;
      let pages = 0;
      do {
        const requestId = `roster-${pages++}`;
        await noise.send({ type: 'desktop.roster', requestId, ...(cursor ? { cursor } : {}) });
        await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop.roster.result' && frame.requestId === requestId)).toBe(true));
        const page = frames.find(frame => frame.type === 'desktop.roster.result' && frame.requestId === requestId)!;
        expect(page.hostId).toBe(binding.hostId);
        if (generation === undefined) generation = page.generation;
        expect(page.generation).toBe(generation);
        const desktops = page.desktops as Array<{ desktopSessionId: string }>;
        expect(desktops.length).toBeLessThanOrEqual(64);
        listed.push(...desktops.map(entry => entry.desktopSessionId));
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        expect(page.hasMore).toBe(Boolean(cursor));
        expect(pages).toBeLessThanOrEqual(Math.ceil(count / 64));
      } while (cursor);
      expect(new Set(listed).size).toBe(count);
      expect(listed).toEqual(Array.from({ length: count }, (_, index) => `desktop-${String(index).padStart(4, '0')}`));
      expect(captures.join('\n')).not.toContain('PRIVATE_ROSTER_MARKER_');
      child.send({ type: 'revoke' });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'revoked')).toBe(true));
      expect(messages.find(message => message.type === 'revoked')?.counters).toMatchObject({ pty: 0, start: 0, lookup: 0 });
      const closed = once(socket, 'close');
      await noise.send({ type: 'desktop.roster', requestId: 'after-revocation' });
      const [, reason] = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('revoked_channel_did_not_close')), 5000))]);
      expect(String(reason)).toContain('desktop_access_revoked');
      expect(frames.some(frame => frame.requestId === 'after-revocation')).toBe(false);
    } finally {
      noise?.close(); socket?.terminate(); broker.dispose();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.send({ type: 'stop' });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
        await exited; clearTimeout(timeout);
      }
    }
  }, 30_000);
});
