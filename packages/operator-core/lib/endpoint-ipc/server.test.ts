/**
 * Unit tests for the endpoint-ipc reaper (WI-5999). `startEndpointIpcServer`'s
 * wire-protocol behavior is already covered by dev_ipc_echo_e2e.test.ts; this
 * file targets the orphan-socket GC added alongside it.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { gcDeadEndpointSockets, startEndpointIpcServer, type EndpointIpcServer } from './server';
import { FrameDecoder, FrameType, encodeJsonFrame, type Frame } from './framing';

it('routes desktop HTTP through the Hono origin even before startup replaces an inherited PORT', async () => {
  const requests = { own: 0, ambient: 0 };
  const own = createServer((req, res) => {
    requests.own++;
    expect(req.headers['x-papercusp-workspace']).toBe('isolated-workspace');
    res.writeHead(200).end('own workspace');
  });
  const ambient = createServer((_req, res) => {
    requests.ambient++;
    res.writeHead(400).end('unknown_workspace');
  });
  const dir = mkdtempSync(join(tmpdir(), 'endpoint-ipc-origin-'));
  let ipc: EndpointIpcServer | undefined;
  let socket: Socket | undefined;
  try {
    own.listen(0, '127.0.0.1');
    ambient.listen(0, '127.0.0.1');
    await Promise.all([once(own, 'listening'), once(ambient, 'listening')]);
    vi.stubEnv('PAPERCUSP_HONO_PORT', String((own.address() as AddressInfo).port));
    vi.stubEnv('PORT', String((ambient.address() as AddressInfo).port));
    vi.stubEnv('PAPERCUSP_OPERATOR_BASE', undefined);
    const socketPath = join(dir, 'origin.sock');
    ipc = await startEndpointIpcServer({ socketPath, allowedTools: ['sys:http'],
      sysHttpInjectHeaders: () => undefined, logger: { info: () => {}, warn: () => {} } });
    socket = connect(socketPath);
    await once(socket, 'connect');
    const frames = new Promise<Frame[]>((resolve, reject) => {
      const decoder = new FrameDecoder();
      const collected: Frame[] = [];
      const timer = setTimeout(() => reject(new Error('IPC origin response timed out')), 5000);
      socket!.on('error', (error) => { clearTimeout(timer); reject(error); });
      socket!.on('data', (chunk: Buffer) => {
        decoder.push(chunk);
        collected.push(...decoder.drain());
        if (collected.some((frame) => frame.type === FrameType.DONE || frame.type === FrameType.ERROR)) {
          clearTimeout(timer);
          resolve(collected);
        }
      });
    });
    socket.write(encodeJsonFrame(FrameType.REQUEST, { id: 1, toolName: 'sys:http',
      input: { method: 'GET', path: '/api/health', headers: { 'x-papercusp-workspace': 'isolated-workspace' } } }));
    const received = await frames;
    expect(received.filter((frame) => frame.type === FrameType.ERROR)).toEqual([]);
    const head = received.filter((frame) => frame.type === FrameType.EVENT_JSON)
      .map((frame) => JSON.parse(frame.payload.toString())).find((event) => event.name === 'head');
    expect(head?.data.status).toBe(200);
    expect(requests).toEqual({ own: 1, ambient: 0 });
  } finally {
    socket?.destroy();
    await ipc?.close();
    own.closeAllConnections(); ambient.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => own.close(() => resolve())), new Promise<void>((resolve) => ambient.close(() => resolve()))]);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('gcDeadEndpointSockets (WI-5999)', () => {
  it('reaps only dead-pid bare "<pid>.sock" files; keeps live, own, non-numeric, and voice-prefixed names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'endpoint-ipc-gc-'));
    try {
      writeFileSync(join(dir, '100.sock'), ''); // dead pid → reap
      writeFileSync(join(dir, '200.sock'), ''); // live pid → keep
      writeFileSync(join(dir, `${process.pid}.sock`), ''); // our own → keep
      writeFileSync(join(dir, 'abc.sock'), ''); // non-numeric → ignore
      writeFileSync(join(dir, 'voice-100.sock'), ''); // the OTHER reaper's naming → never touch
      writeFileSync(join(dir, 'other.txt'), ''); // unrelated → ignore

      const reaped = gcDeadEndpointSockets(dir, (pid) => pid === 200);

      expect(reaped).toBe(1);
      expect(existsSync(join(dir, '100.sock'))).toBe(false);
      expect(existsSync(join(dir, '200.sock'))).toBe(true);
      expect(existsSync(join(dir, `${process.pid}.sock`))).toBe(true);
      expect(existsSync(join(dir, 'abc.sock'))).toBe(true);
      expect(existsSync(join(dir, 'voice-100.sock'))).toBe(true);
      expect(existsSync(join(dir, 'other.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 when the sockets dir is absent', () => {
    const missing = join(
      tmpdir(),
      `endpoint-ipc-gc-missing-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    expect(gcDeadEndpointSockets(missing, () => false)).toBe(0);
  });

  it('never reaps its own pid even when the injected isAlive would say dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'endpoint-ipc-gc-self-'));
    try {
      writeFileSync(join(dir, `${process.pid}.sock`), '');
      const reaped = gcDeadEndpointSockets(dir, () => false);
      expect(reaped).toBe(0);
      expect(existsSync(join(dir, `${process.pid}.sock`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
