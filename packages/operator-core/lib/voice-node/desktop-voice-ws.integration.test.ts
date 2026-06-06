/**
 * Integration test for the desktop voice WS bridge (`desktop-voice-ws.ts`).
 * Proves the byte-pipe relays the local-audio-socket protocol verbatim in both
 * directions — without a browser or real audio — by standing up a mock unix
 * socket (the "operator voice socket") and driving the bridge with a fake WS.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FRAME_CTRL, FrameDecoder, encodeCtrl, encodeFrame } from '@papercusp/p2p-voice';
import { bridgeConnection, type BridgeWs } from './desktop-voice-ws';

const MIX = 0x03;

class FakeWs extends EventEmitter implements BridgeWs {
  sent: Buffer[] = [];
  closed = false;
  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('desktop voice WS bridge (P-015)', () => {
  let dir = '';
  let server: net.Server | null = null;

  afterEach(() => {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('pipes CTRL up and status + MIX down, verbatim', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pui-dvws-'));
    const path = join(dir, 'voice.sock');
    const received: { type: number; payload: Buffer }[] = [];
    server = net.createServer((c) => {
      const dec = new FrameDecoder();
      c.on('data', (d) => {
        for (const f of dec.push(d)) {
          received.push({ type: f.type, payload: Buffer.from(f.payload) });
          if (f.type === FRAME_CTRL) {
            const ctrl = JSON.parse(Buffer.from(f.payload).toString()) as {
              op?: string;
              channel?: string;
            };
            if (ctrl.op === 'join') {
              c.write(
                encodeCtrl({
                  ev: 'status',
                  status: {
                    channel: { id: 'vc-1', name: ctrl.channel },
                    muted: false,
                    peers: [],
                  },
                }),
              );
              c.write(encodeFrame(MIX, new Uint8Array([1, 2, 3, 4])));
            }
          }
        }
      });
    });
    await new Promise<void>((res) => server!.listen(path, res));

    const ws = new FakeWs();
    bridgeConnection(ws, path);

    // client → bridge → unix socket: a join CTRL frame arrives verbatim.
    ws.emit('message', Buffer.from(encodeCtrl({ op: 'join', channel: 'standup' })));
    await waitFor(() => received.length > 0);
    expect(received[0].type).toBe(FRAME_CTRL);
    expect(JSON.parse(received[0].payload.toString())).toEqual({
      op: 'join',
      channel: 'standup',
    });

    // unix socket → bridge → client: the status + MIX frames flow back.
    await waitFor(() => ws.sent.length > 0);
    const dec = new FrameDecoder();
    const frames = ws.sent.flatMap((b) => dec.push(b));
    const types = frames.map((f) => f.type);
    expect(types).toContain(FRAME_CTRL);
    expect(types).toContain(MIX);
    const status = frames.find((f) => f.type === FRAME_CTRL)!;
    expect((JSON.parse(Buffer.from(status.payload).toString()) as { ev?: string }).ev).toBe(
      'status',
    );
  });

  it('tears down the unix socket when the WS closes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pui-dvws2-'));
    const path = join(dir, 'voice.sock');
    let connected = false;
    let socketClosed = false;
    server = net.createServer((c) => {
      connected = true;
      c.on('close', () => {
        socketClosed = true;
      });
    });
    await new Promise<void>((res) => server!.listen(path, res));

    const ws = new FakeWs();
    bridgeConnection(ws, path);
    await waitFor(() => connected);
    ws.close();
    await waitFor(() => socketClosed);
    expect(socketClosed).toBe(true);
  });
});
