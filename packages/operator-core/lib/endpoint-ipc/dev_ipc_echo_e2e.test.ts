/**
 * Real-tool E2E test for the IPC server.
 *
 * server.test.ts uses a synthetic in-test tool to validate the wire
 * protocol. This file picks the actual `dev:ipc_echo` from the
 * registry (the one the /dev → IPC tab calls in production) and
 * dispatches it through the IPC server over a temp UDS. Catches the
 * class of bug that "wire protocol works but the registered tool's
 * import / registration chain has a runtime issue" — exactly what an
 * end-to-end live verification would surface without needing to
 * rebuild the desktop.
 *
 * Doesn't substitute for the user-driven runbook (verify-desktop-ipc.sh)
 * which spins up a real Tauri build over a real socket. But it does
 * catch most regressions that runbook would.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FrameType,
  FrameDecoder,
  decodeEventBinPayload,
  encodeJsonFrame,
  type Frame,
} from './framing';
import { startEndpointIpcServer, type EndpointIpcServer } from './server';

// Trigger the operator-side agent-tool registry so dev:ipc_echo lands
// in the projection registry.
import '../agent-tools/index';

function tmpSocketPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `papercusp-ipc-e2e-${label}-${process.pid}-${Date.now()}.sock`,
  );
}

function readFramesUntil(
  socket: net.Socket,
  predicate: (frames: Frame[]) => boolean,
  timeoutMs = 5000,
): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const dec = new FrameDecoder();
    const collected: Frame[] = [];
    const onData = (chunk: Buffer): void => {
      try {
        dec.push(chunk);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }
      for (const f of dec.drain()) collected.push(f);
      if (predicate(collected)) {
        cleanup();
        resolve(collected);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readFramesUntil timeout; got ${collected.length} frames`));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

let server: EndpointIpcServer;
let socketPath: string;

beforeAll(async () => {
  socketPath = tmpSocketPath('e2e');
  server = await startEndpointIpcServer({
    socketPath,
    // The actual allowlist that prod uses (instrumentation-node.ts).
    // Verifies dev:ipc_echo + operator:scan are gateable through the
    // same path the desktop hits.
    allowedTools: ['dev:ipc_echo', 'operator:scan'],
    logger: { info: () => {}, warn: () => {} },
  });
});

afterAll(async () => {
  await server?.close();
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  }
});

describe('IPC E2E with real dev:ipc_echo', () => {
  it('default mode emits delta + progress + done', async () => {
    const sock = await connect(socketPath);
    sock.write(
      encodeJsonFrame(FrameType.REQUEST, {
        id: 1,
        toolName: 'dev:ipc_echo',
        input: { message: 'hi there', emitBinary: false, delayMs: 0 },
      }),
    );
    const frames = await readFramesUntil(
      sock,
      (f) => f.some((x) => x.type === FrameType.DONE),
    );
    const events = frames.filter((f) => f.type === FrameType.EVENT_JSON);
    const deltas = events
      .map((f) => JSON.parse(f.payload.toString()))
      .filter((e) => e.name === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    // 'hi there' splits into 3 tokens: 'hi', ' ', 'there'.
    expect(deltas.map((d) => d.data.text)).toEqual(['hi', ' ', 'there']);

    const progressEvents = events
      .map((f) => JSON.parse(f.payload.toString()))
      .filter((e) => e.name === 'progress');
    expect(progressEvents.length).toBe(3);

    const done = frames.find((f) => f.type === FrameType.DONE)!;
    const donePayload = JSON.parse(done.payload.toString());
    expect(donePayload.id).toBe(1);
    sock.end();
  });

  it('binary mode emits EVENT_BIN with [de ad be ef]', async () => {
    const sock = await connect(socketPath);
    sock.write(
      encodeJsonFrame(FrameType.REQUEST, {
        id: 2,
        toolName: 'dev:ipc_echo',
        input: { message: 'x', emitBinary: true, delayMs: 0 },
      }),
    );
    const frames = await readFramesUntil(
      sock,
      (f) => f.some((x) => x.type === FrameType.DONE),
    );
    const bin = frames.find((f) => f.type === FrameType.EVENT_BIN);
    expect(bin).toBeTruthy();
    const decoded = decodeEventBinPayload(bin!.payload);
    expect(decoded.id).toBe(2n);
    expect(decoded.name).toBe('binary');
    expect(Array.from(decoded.binary)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    sock.end();
  });

  it('non-allowlisted tool returns tool_not_allowed', async () => {
    const sock = await connect(socketPath);
    sock.write(
      encodeJsonFrame(FrameType.REQUEST, {
        id: 3,
        // Real registered tool but NOT on this server's allowlist.
        toolName: 'architect:chat',
        input: {},
      }),
    );
    const frames = await readFramesUntil(
      sock,
      (f) => f.some((x) => x.type === FrameType.ERROR),
    );
    const err = frames.find((f) => f.type === FrameType.ERROR)!;
    const parsed = JSON.parse(err.payload.toString());
    expect(parsed.error.code).toBe('tool_not_allowed');
    sock.end();
  });
});
