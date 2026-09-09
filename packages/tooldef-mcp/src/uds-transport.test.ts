import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ProgressNotificationSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { UdsMcpTransport, type UdsMcpTransportOptions } from './uds-transport';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function endpoint() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-uds-'));
  const path = join(root, 'mcp.sock');
  const server = createServer({ pauseOnConnect: true });
  server.listen(path);
  await once(server, 'listening');
  const sockets: Socket[] = [];
  server.on('connection', (socket) => sockets.push(socket));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { path, server };
}

async function rawConnection(limits: Partial<UdsMcpTransportOptions> = {}) {
  const { path, server } = await endpoint();
  const accepted = once(server, 'connection');
  const peer = createConnection(path);
  cleanup.push(() => peer.destroy());
  const [socket] = await accepted;
  const transport = new UdsMcpTransport({ ...limits, socket } as UdsMcpTransportOptions);
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  cleanup.push(() => transport.close());
  await transport.start();
  return { peer, socket: socket as Socket, transport, messages, errors };
}

describe('UDS MCP framing and lifecycle', () => {
  it('decodes split UTF-8, escaped newlines and coalesced frames exactly once', async () => {
    const { socket, messages } = await rawConnection();
    const values: JSONRPCMessage[] = [
      { jsonrpc: '2.0', id: 'α', method: 'tools/call', params: { text: '🦉\nquoted " value' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 7, result: {} },
    ];
    const bytes = Buffer.from(values.map((v) => JSON.stringify(v)).join('\n') + '\n');
    // Drive actual socket events with deterministic byte boundaries. Real network
    // writes alone cannot guarantee where the OS splits a multibyte character.
    for (const byte of bytes.subarray(0, bytes.length - 40)) socket.emit('data', Buffer.from([byte]));
    socket.emit('data', bytes.subarray(bytes.length - 40));
    expect(messages).toEqual(values);
  });

  it.each([false, true])('closes an oversized frame with/without newline (newline=%s)', async (newline) => {
    const { peer, transport, errors, messages } = await rawConnection({ maxFrameBytes: 32 });
    const closed = vi.fn();
    transport.onclose = closed;
    peer.write('x'.repeat(33) + (newline ? '\n' : ''));
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(errors[0]).toMatchObject({ code: 'uds_frame_limit' });
    expect(messages).toEqual([]);
  });

  it.each(['{bad json}\n', '{"jsonrpc":"2.0","id":1}\n'])('rejects malformed JSON-RPC before dispatch', async (frame) => {
    const { peer, errors, messages } = await rawConnection();
    peer.write(frame);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(messages).toEqual([]);
  });

  it('fails a truncated UTF-8 sequence instead of replacing it with a different character', async () => {
    const { peer, errors, messages } = await rawConnection();
    peer.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"'), Buffer.from([0xf0, 0x9f]), Buffer.from('"}\n')]));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(messages).toEqual([]);
  });

  it('times out a partial frame and settles closure once', async () => {
    const { peer, transport, errors } = await rawConnection({ frameTimeoutMs: 20 });
    const closed = vi.fn();
    transport.onclose = closed;
    peer.write('{');
    await vi.waitFor(() => expect(errors[0]).toMatchObject({ code: 'uds_frame_timeout' }));
    await transport.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('caps pending requests before forwarding excess work', async () => {
    const { peer, messages, errors } = await rawConnection({ maxPendingRequests: 1 });
    peer.write([1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n').join(''));
    await vi.waitFor(() => expect(errors[0]).toMatchObject({ code: 'uds_request_limit' }));
    expect(messages).toHaveLength(1);
  });

  it('rejects sends before start and connection failure without hanging', async () => {
    const { path } = await endpoint();
    const transport = new UdsMcpTransport({ path: path + '-missing' });
    const closed = vi.fn();
    transport.onclose = closed;
    await expect(transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).rejects.toMatchObject({ code: 'uds_closed' });
    await expect(transport.start()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(closed).toHaveBeenCalledOnce();
    await expect(transport.start()).rejects.toMatchObject({ code: 'uds_lifecycle' });
  });
});

describe('UDS MCP output bounds', () => {
  it('waits for drain, refuses queued excess, and rejects pending writes on close', async () => {
    class BlockedSocket extends EventEmitter {
      destroyed = false;
      connecting = false;
      write = vi.fn((_frame: string, callback: (error?: Error) => void) => { callback(); return false; });
      pause() {}
      resume() {}
      destroy() { this.destroyed = true; this.emit('close'); }
    }
    const socket = new BlockedSocket();
    const message = { jsonrpc: '2.0', method: 'notifications/initialized' } as const;
    const bytes = Buffer.byteLength(JSON.stringify(message) + '\n');
    const transport = new UdsMcpTransport({ socket: socket as unknown as Socket, maxQueuedBytes: bytes, sendTimeoutMs: 1000 });
    await transport.start();
    let settled = false;
    const first = transport.send(message).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(transport.send(message)).rejects.toMatchObject({ code: 'uds_output_limit' });
    expect(socket.write).toHaveBeenCalledOnce();
    socket.emit('drain');
    await first;
    const second = transport.send(message);
    const rejected = expect(second).rejects.toMatchObject({ code: 'uds_closed' });
    await transport.close();
    await rejected;
    expect(socket.listenerCount('drain')).toBe(0);
  });
});

describe('installed SDK over actual UDS', () => {
  it('multiplexes out-of-order responses, progress and cancellation without mixing request IDs', async () => {
    const { path, server } = await endpoint();
    const accepted = once(server, 'connection');
    const clientTransport = new UdsMcpTransport({ path });
    const client = new Client({ name: 'uds-client', version: '1' });
    const connecting = client.connect(clientTransport);
    const [socket] = await accepted;
    const host = new Server({ name: 'uds-host', version: '1' }, { capabilities: { tools: {} } });
    let releaseSlow!: () => void;
    let startedSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => { startedSlow = resolve; });
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let cancelSeen!: () => void;
    let cancelStarted!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancelSeen = resolve; });
    const cancelling = new Promise<void>((resolve) => { cancelStarted = resolve; });
    host.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === 'slow') { startedSlow(); await slow; }
      if (request.params.name === 'cancel') {
        cancelStarted();
        await new Promise<void>((resolve) => extra.signal.addEventListener('abort', () => { cancelSeen(); resolve(); }, { once: true }));
      }
      if (request.params._meta?.progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: 1, total: 1 } });
      return { content: [{ type: 'text', text: request.params.name }] };
    });
    await host.connect(new UdsMcpTransport({ socket }));
    cleanup.push(async () => { releaseSlow(); await client.close(); await host.close(); });
    await connecting;
    const progress = vi.fn();
    client.setNotificationHandler(ProgressNotificationSchema, progress);
    const first = client.callTool({ name: 'slow', arguments: {} });
    await slowStarted;
    const second = await client.callTool({ name: 'fast', arguments: {}, _meta: { progressToken: 'fast-progress' } });
    expect(second.content).toEqual([{ type: 'text', text: 'fast' }]);
    releaseSlow();
    expect((await first).content).toEqual([{ type: 'text', text: 'slow' }]);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    const abort = new AbortController();
    const request = client.callTool({ name: 'cancel', arguments: {} }, undefined, { signal: abort.signal });
    const rejection = expect(request).rejects.toBeDefined();
    await cancelling;
    abort.abort();
    await rejection;
    await cancelled;
    expect((await client.callTool({ name: 'after-cancel', arguments: {} })).content).toEqual([{ type: 'text', text: 'after-cancel' }]);
  });
});
