/** The production browser adapter, bundled for and executed by real Chromium.
 * The broker and outbound host use real sockets and separate processes. This
 * layer verifies transport; the served Portal spec owns account/consent/UI proof.
 */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import SecretStream from '@hyperswarm/secret-stream';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from '../endpoint-route/hosted-workspace-connector';

describe('installed computer production browser transport', () => {
  it('proves pinned Noise, permuted roster recovery, reload identity and fail-closed transport in Chromium', async () => {
    const root = fileURLToPath(new URL('../../../..', import.meta.url));
    const bundle = await build({
      absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'iife',
      alias: { 'sodium-native': `${root}/packages/operator-core/lib/workspace-host/sodium-browser.cjs` },
      define: { global: 'globalThis' },
      stdin: { resolveDir: root, loader: 'ts', contents: `
        import { Buffer } from 'buffer';
        globalThis.Buffer = Buffer;
        import('./apps/operator/app/cloud-workspaces/installed-computer-connection.ts')
          .then(api => { globalThis.installedComputerTest = api; });
      ` },
    });
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
    const server = createServer((request, response) => {
      if (request.url === '/client.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end(bundle.outputFiles[0].contents);
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><script src="/client.js"></script>');
      }
    });
    const sockets = new WebSocketServer({ noServer: true });
    const binding: HostedConnectorBinding = { controlPlaneWorkspaceId: 'test-control', organizationId: 'test-org',
      customerWorkspaceId: 'test-workspace', hostId: 'test-host', routeLabel: 'test-route',
      generation: 1, transport: 'websocket', state: 'active', hosting: 'papercusp' };
    const ticket: HostedConnectorTicketBinding = { ...binding, kind: 'session', userId: 'test-user',
      hostedSessionId: 'test-session', audience: 'workspace-operator', expiresAt: new Date(Date.now() + 60_000) };
    const packets: string[] = [];
    server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, peer => {
      const path = new URL(request.url!, 'http://fixture');
      peer.on('message', data => packets.push(data.toString()));
      if (path.searchParams.get('peer') === 'host') broker.attachConnector(binding, peer);
      else if (path.pathname === '/plaintext') peer.send(JSON.stringify({ type: 'desktop.discovery.ready' }));
      else broker.attachBrowser(ticket, peer, { kind: 'desktop-discovery', sealed: true });
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('browser_fixture_not_listening');
    const origin = `http://127.0.0.1:${address.port}`;
    const socketUrl = origin.replace('http:', 'ws:') + '/api/hosted/connectors/socket';
    const host = fork(fileURLToPath(new URL('./fixtures/linked-desktop-host.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const messages: Record<string, unknown>[] = [];
    let hostErrors = '';
    host.stderr?.on('data', data => { hostErrors = (hostErrors + String(data)).slice(-4000); });
    host.on('message', message => messages.push(message as Record<string, unknown>));
    let browser: Browser | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    let phase = 'browser-start';
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext();
      page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      host.send({ type: 'start', url: socketUrl + '?peer=host', count: 193, permute: true });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'bound'), hostErrors).toBe(true), { timeout: 15_000 });
      expect(host.pid).not.toBe(process.pid);
      await page.goto(origin);
      await page.waitForFunction('!!globalThis.installedComputerTest');
      const publicKey = SecretStream.keyPair(Buffer.alloc(32, 82)).publicKey.toString('base64');
      const machinePublicKey = String(messages.find(message => message.type === 'bound')!.machinePublicKey);
      await page.evaluate(`localStorage.setItem('papercusp.installed-computer.browser-seed.v1', ${JSON.stringify(Buffer.alloc(32, 82).toString('base64'))})`);
      expect(await page.evaluate(`(async () => (await installedComputerTest.installedBrowserKey()).publicKey.toString('base64'))()`))
        .toBe(publicKey);
      const input = { url: socketUrl + '?kind=desktop-discovery', approval: { machinePublicKey, grant: { browserPublicKey: publicKey } } };
      // String evaluation keeps the test transform's helper functions out of
      // Chromium. Only the already-built production module executes there.
      const connect = async (value = input) => page!.evaluate(`(async () => {
        const input = ${JSON.stringify(value)};
        const socket = await installedComputerTest.installedComputerSocket(input.url, input.approval);
        const frames = [], errors = [];
        globalThis.fixtureSocket = socket; globalThis.fixtureFrames = frames; globalThis.fixtureErrors = errors;
        socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
        socket.addEventListener('error', event => errors.push(event.message || 'transport error'));
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('browser_noise_timeout')), 18000);
          socket.addEventListener('open', () => { clearTimeout(deadline); resolve(); }, { once: true });
          socket.addEventListener('error', event => {
            clearTimeout(deadline);
            reject(new Error('browser_noise_refused: ' + (event.message || 'transport error')));
          }, { once: true });
        });
        return (await installedComputerTest.installedBrowserKey()).publicKey.toString('base64');
      })()`);
      phase = 'initial-handshake';
      expect(await connect()).toBe(publicKey);
      phase = 'discovery-ready';
      await page.waitForFunction('fixtureFrames.some(frame => frame.type === "desktop.discovery.ready") || fixtureErrors.length > 0 || fixtureSocket.readyState === 3');
      expect(await page.evaluate('fixtureErrors')).toEqual([]);
      expect(await page.evaluate('fixtureFrames.some(frame => frame.type === "desktop.discovery.ready")')).toBe(true);
      type RosterResponse = { type: string; requestId: string; hostId: string; generation: string;
        desktops: Array<{ desktopSessionId: string; state: string; owner: string; name: string }>;
        cursor: string | null; nextCursor: string | null; hasMore: boolean; remaining: number; code?: string };
      let requestIndex = 0;
      const roster = async (cursor?: string | null) => {
        const request = { type: 'desktop.roster', requestId: `browser-${requestIndex++}`, ...(cursor ? { cursor } : {}) };
        await page!.evaluate(`fixtureSocket.send(${JSON.stringify(JSON.stringify(request))})`);
        await page!.waitForFunction(`fixtureFrames.some(frame => frame.requestId === ${JSON.stringify(request.requestId)})`);
        return await page!.evaluate(`fixtureFrames.find(frame => frame.requestId === ${JSON.stringify(request.requestId)})`) as RosterResponse;
      };
      const inventory = async (count: number) => {
        const requestId = `inventory-${requestIndex++}`;
        host.send({ type: 'inventory', count, requestId });
        await vi.waitFor(() => expect(messages.some(message => message.type === 'inventory-updated'
          && message.requestId === requestId && message.count === count)).toBe(true));
      };
      const expectedIds = (count: number) => Array.from({ length: count }, (_, index) => `desktop-${String(index).padStart(4, '0')}`);
      const listed: string[] = [];
      let cursor: string | null | undefined;
      let generation: string | undefined;
      let resumeCursor: string | null = null;
      for (let index = 0; index < 4; index++) {
        phase = `roster-page-${index}`;
        const result = await roster(cursor);
        expect(result.type).toBe('desktop.roster.result');
        expect(result.hostId).toBe(binding.hostId);
        if (generation === undefined) generation = result.generation;
        expect(result.generation).toBe(generation);
        expect(result.desktops.length).toBeLessThanOrEqual(64);
        expect(result.desktops).toEqual(expectedIds(193).slice(index * 64, (index + 1) * 64).map((desktopSessionId, offset) => {
          const number = index * 64 + offset;
          return { desktopSessionId, state: 'ready', scope: 'agent', owner: `test-agent-${number}`, name: `PRIVATE_ROSTER_MARKER_${number}` };
        }));
        // Repeating a page read must return the exact identities and cursor even
        // though the separate provider has permuted its input in the meantime.
        const duplicate = await roster(cursor);
        expect({ ...duplicate, requestId: result.requestId }).toEqual(result);
        listed.push(...result.desktops.map(desktop => desktop.desktopSessionId));
        cursor = result.nextCursor;
        if (index === 0) resumeCursor = cursor;
        expect(result.hasMore).toBe(Boolean(cursor));
        expect(result.remaining).toBe(193 - listed.length);
      }
      expect(listed).toEqual(expectedIds(193));
      expect(new Set(listed).size).toBe(193);
      expect(new Set(messages.filter(message => message.type === 'roster-read').map(message => message.first)).size).toBeGreaterThan(1);
      expect(cursor).toBeNull();
      expect(packets.join('\n')).not.toContain('PRIVATE_ROSTER_MARKER_');
      phase = 'changed-generation-refusal';
      await inventory(194);
      const stale = await roster(resumeCursor);
      expect(stale).toMatchObject({ type: 'operation.error', code: 'roster_resync_required' });
      expect(stale).not.toHaveProperty('desktops');
      phase = 'stable-generation-resync';
      const recovered: string[] = [];
      let recoveredGeneration: string | undefined;
      cursor = null;
      do {
        const result = await roster(cursor);
        expect(result.type).toBe('desktop.roster.result');
        if (!recoveredGeneration) recoveredGeneration = result.generation;
        expect(result.generation).toBe(recoveredGeneration);
        expect(result.generation).not.toBe(generation);
        expect(result.hostId).toBe(binding.hostId);
        recovered.push(...result.desktops.map(desktop => desktop.desktopSessionId));
        cursor = result.nextCursor;
        expect(result.remaining).toBe(194 - recovered.length);
        expect(recovered.length).toBeLessThanOrEqual(194);
      } while (cursor);
      expect(recovered).toEqual(expectedIds(194));
      await inventory(193);
      await page.evaluate('fixtureSocket.close()');
      phase = 'reload';
      await page.reload();
      await page.waitForFunction('!!globalThis.installedComputerTest');
      expect(await connect()).toBe(publicKey);
      phase = 'resume-after-reload';
      const resumed = await roster(resumeCursor);
      expect(resumed.type).toBe('desktop.roster.result');
      expect(resumed.generation).toBe(generation);
      expect(resumed.desktops.map(desktop => desktop.desktopSessionId)).toEqual(expectedIds(193).slice(64, 128));
      phase = 'host-disconnect';
      host.send({ type: 'disconnect', requestId: 'browser-disconnect' });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'disconnected'
        && message.requestId === 'browser-disconnect')).toBe(true));
      await page.waitForFunction('fixtureSocket.readyState === 3');
      const priorBindings = messages.filter(message => message.type === 'bound').length;
      host.send({ type: 'start', url: socketUrl + '?peer=host', count: 193, permute: true });
      await vi.waitFor(() => expect(messages.filter(message => message.type === 'bound')).toHaveLength(priorBindings + 1), { timeout: 15_000 });
      phase = 'resume-after-host-reconnect';
      expect(await connect()).toBe(publicKey);
      const reconnected = await roster(resumeCursor);
      expect({ ...reconnected, requestId: resumed.requestId }).toEqual(resumed);
      await page.evaluate('fixtureSocket.close()');
      const wrongKey = SecretStream.keyPair(Buffer.alloc(32, 83)).publicKey.toString('base64');
      phase = 'wrong-pin-refusal';
      await expect(connect({ ...input, approval: { ...input.approval, machinePublicKey: wrongKey } })).rejects.toThrow('browser_noise_refused');
      phase = 'plaintext-refusal';
      await expect(connect({ ...input, url: origin.replace('http:', 'ws:') + '/plaintext?kind=desktop-discovery' })).rejects.toThrow('browser_noise_refused');
      phase = 'revocation';
      expect(await connect()).toBe(publicKey);
      host.send({ type: 'revoke' });
      await vi.waitFor(() => expect(messages.some(message => message.type === 'revoked')).toBe(true));
      await page.evaluate('fixtureSocket.send(JSON.stringify({type:"desktop.roster",requestId:"revoked"}))');
      await page.waitForFunction('fixtureSocket.readyState === 3');
      expect(await page.evaluate('fixtureFrames.some(frame => frame.requestId === "revoked")')).toBe(false);
      expect(messages.find(message => message.type === 'revoked')?.counters).toMatchObject({ pty: 0, start: 0, lookup: 0 });
      expect(pageErrors).toEqual([]);
    } catch (error) {
      const state = await page?.evaluate('JSON.stringify({ readyState: globalThis.fixtureSocket?.readyState, errors: globalThis.fixtureErrors, frames: globalThis.fixtureFrames?.map(frame => ({ type: frame.type, requestId: frame.requestId, count: frame.desktops?.length, hasMore: frame.hasMore })) })')
        .catch(error => `unavailable: ${String(error)}`);
      const wire = packets.map(packet => {
        try { const frame = JSON.parse(packet); return { type: frame.type, contentType: frame.contentType, bytes: frame.packet?.length }; }
        catch { return { type: 'invalid-json' }; }
      });
      throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}; browser=${state}; pageErrors=${JSON.stringify(pageErrors)}; host=${hostErrors}; peerEvents=${JSON.stringify(messages)}; wire=${JSON.stringify(wire)}`, { cause: error });
    } finally {
      await browser?.close(); broker.dispose();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (host.exitCode === null && host.signalCode === null) {
        const exited = once(host, 'exit'); host.send({ type: 'stop' });
        const timeout = setTimeout(() => host.kill('SIGKILL'), 3000);
        await exited; clearTimeout(timeout);
      }
    }
  }, 60_000);
});
