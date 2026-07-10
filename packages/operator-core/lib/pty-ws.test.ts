/**
 * pty-ws integration tests — boots the actual WebSocket server on an
 * ephemeral port, spawns a real pty via pty-bridge, and exercises the
 * full duplex protocol from a `ws`-package client.
 *
 * Covers:
 *   - connection accepted with allow-localhost origin
 *   - origin rejection on disallowed Origin
 *   - 4410 close on unknown pty id
 *   - binary input → pty echo → binary output
 *   - text resize control frame applies
 *   - exit text frame on process exit
 *   - replay (P4 screen-state) on second connect
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { WebSocket } from 'ws';
import { spawnPty, killPty } from './pty-bridge';
import { startPtyWsServer } from './pty-ws';
import type { AddressInfo } from 'node:net';

let port: number;
let url: (id: string) => string;

beforeAll(async () => {
  // Use port 0 — OS picks a free port. We pin it back via the server
  // address after listen().
  const wss = startPtyWsServer({ port: 0, allowLocalhost: true });
  if (!wss) throw new Error('startPtyWsServer returned null (port collision?)');
  await new Promise<void>((resolve) => {
    if (wss.address()) return resolve();
    wss.once('listening', () => resolve());
  });
  const addr = wss.address() as AddressInfo;
  port = addr.port;
  url = (id: string) => `ws://127.0.0.1:${port}/pty/${id}`;
});

const liveIds: string[] = [];
/**
 * Reap each test's pty as it ends. Reaping only in afterAll kept every spawned pty
 * alive at once, which trips `pty cap reached` on a small host: the F-E2 backstop
 * (maxConcurrentPtys) scales to the resource-profile agent budget, so a 4-core box
 * allows 2 — green on the 128-core dev box, red on a laptop / CI runner / packaged
 * install. Every test here spawns its own pty; none reads a previous test's.
 */
function reap(): void {
  for (const id of liveIds.splice(0)) {
    try {
      killPty(id);
    } catch {
      /* already exited */
    }
  }
}
afterEach(reap);
afterAll(reap);

function spawnTestPty(args: readonly string[]) {
  const h = spawnPty({
    command: 'bash',
    args: ['-c', args.join(' ')],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  liveIds.push(h.id);
  return h;
}

function openWs(path: string, origin = 'http://localhost:3055'): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  return ws;
}

async function awaitOpenOrClose(ws: WebSocket): Promise<{ opened: boolean; closeCode?: number; closeReason?: string }> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ opened: true }));
    ws.once('close', (code, reason) => resolve({ opened: false, closeCode: code, closeReason: reason.toString() }));
    ws.once('error', () => { /* swallow; close will follow */ });
  });
}

// Resolves early as soon as `predicate` matches, so this timeout only bites
// when the real PTY's output is genuinely slow. 1500ms raced the shell
// spawn+exec round-trip on the contended dev box (flaky); 8s is ample and
// still well under the 20s vitest testTimeout.
async function collectBytes(ws: WebSocket, predicate: (s: string) => boolean, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let acc = '';
    const timer = setTimeout(() => resolve(acc), timeoutMs);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      acc += Buffer.from(data as ArrayBuffer).toString('utf8');
      if (predicate(acc)) { clearTimeout(timer); resolve(acc); }
    });
  });
}

describe('pty-ws', () => {
  it('rejects unknown pty id with 4410', async () => {
    const ws = openWs('/pty/00000000-0000-0000-0000-000000000000');
    const r = await awaitOpenOrClose(ws);
    // ws may report `open` then immediately get a close event. We
    // accept either close-without-open OR an open followed by 4410.
    if (r.opened) {
      const closed = await new Promise<{ code: number; reason: string }>((res) => {
        ws.once('close', (code, reason) => res({ code, reason: reason.toString() }));
      });
      expect(closed.code).toBe(4410);
    } else {
      expect(r.closeCode).toBe(4410);
    }
  });

  it('rejects malformed URL with 4404', async () => {
    const ws = openWs('/wrong/path');
    const r = await new Promise<{ opened: boolean; closeCode?: number }>((resolve) => {
      ws.once('open', () => {
        ws.once('close', (code) => resolve({ opened: true, closeCode: code }));
      });
      ws.once('close', (code) => resolve({ opened: false, closeCode: code }));
      ws.once('error', () => { /* close follows */ });
    });
    expect(r.closeCode).toBe(4404);
  });

  it('rejects disallowed Origin with 4403', async () => {
    const handle = spawnTestPty(['echo', 'origin_test']);
    const ws = openWs(`/pty/${handle.id}`, 'http://evil.example.com');
    const r = await awaitOpenOrClose(ws);
    if (r.opened) {
      const closed = await new Promise<{ code: number }>((res) => {
        ws.once('close', (code) => res({ code }));
      });
      expect(closed.code).toBe(4403);
    } else {
      expect(r.closeCode).toBe(4403);
    }
  });

  it('round-trips binary input and replays on second connect', async () => {
    // Keep the pty alive across both connects by waiting on stdin —
    // exiting bash would dispose the underlying handle and the second
    // connect would race the close.
    const handle = spawnTestPty(['echo PTYWS_TEST_MARKER; sleep 30']);
    const ws = openWs(`/pty/${handle.id}`);
    // Start collecting BEFORE awaiting open: `echo` fires immediately on spawn,
    // so the live frame (or the on-connect screen replay) can arrive in the
    // microtask gap between open and a listener attached afterwards, and ws
    // drops messages with no listener → flaky `expected '' to contain ...`.
    const firstRead = collectBytes(ws, (s) => s.includes('PTYWS_TEST_MARKER'));
    const opened = await awaitOpenOrClose(ws);
    expect(opened.opened).toBe(true);
    const out = await firstRead;
    expect(out).toContain('PTYWS_TEST_MARKER');
    ws.close();
    // Tiny gap for the close handler to detach subscribers cleanly.
    await new Promise((r) => setTimeout(r, 50));

    // Second connect — replay should carry the marker via P4 screen state.
    // Same early-attach: the server sends the replay right after connect.
    const ws2 = openWs(`/pty/${handle.id}`);
    const replayRead = collectBytes(ws2, (s) => s.includes('PTYWS_TEST_MARKER'));
    const opened2 = await awaitOpenOrClose(ws2);
    expect(opened2.opened).toBe(true);
    const replay = await replayRead;
    expect(replay).toContain('PTYWS_TEST_MARKER');
    // Replay should be SMALLER than full byte history would have been.
    expect(replay.length).toBeLessThan(8 * 1024);
    ws2.close();
  });

  it('applies resize via control frame', async () => {
    // Generous sleeps so the resize control frame lands before the second
    // tput print, and the pty stays open through the round-trip, under load.
    const handle = spawnTestPty(['printf "tput_cols=$(tput cols)\\n"; sleep 3; printf "tput_cols2=$(tput cols)\\n"; sleep 3']);
    const ws = openWs(`/pty/${handle.id}`);
    // First print fires immediately — collect before awaiting open (see the
    // round-trip test) so the frame can't slip the open→listener gap.
    const firstRead = collectBytes(ws, (s) => /tput_cols=\d+/.test(s));
    const opened = await awaitOpenOrClose(ws);
    expect(opened.opened).toBe(true);
    // Wait for the first reading.
    const before = await firstRead;
    expect(before).toMatch(/tput_cols=80/);
    // Send resize and let the second printf run.
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    const after = await collectBytes(ws, (s) => /tput_cols2=\d+/.test(s));
    expect(after).toMatch(/tput_cols2=132/);
    ws.close();
  });

  it('emits exit text frame on process exit', async () => {
    const handle = spawnTestPty(['exit 7']);
    const ws = openWs(`/pty/${handle.id}`);
    // Register the exit-frame listener SYNCHRONOUSLY, before awaiting open.
    // `exit 7` exits instantly, and the server replays the exit frame to a
    // late subscriber right after connect (pty-ws.ts ~L286). The only race
    // left was client-side: attaching `ws.on('message')` a microtask AFTER
    // `await awaitOpenOrClose` let a fast exit frame slip through the gap (ws
    // drops messages with no listener) → flaky `expected undefined to be
    // 'exit'`. The other tests dodge this by keeping the pty alive with
    // `sleep`; an exit test can't, so it must subscribe before any frame can
    // arrive. Assertions are unchanged.
    const exitFrame = new Promise<{ type?: string; code?: number }>((resolve) => {
      const timer = setTimeout(() => resolve({}), 8000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const m = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8'));
          if (m?.type === 'exit') { clearTimeout(timer); resolve(m); }
        } catch { /* */ }
      });
    });
    const opened = await awaitOpenOrClose(ws);
    expect(opened.opened).toBe(true);
    const exitMsg = await exitFrame;
    expect(exitMsg.type).toBe('exit');
    expect(exitMsg.code).toBe(7);
  });

  it('processes ack control frames without erroring', async () => {
    // Keep the pty alive long enough for the ack + keystroke round-trip to
    // complete under load — POST_ACK is the terminal's echo of the input, so
    // the pty must still be open when we send it. `sleep 0.2` raced the
    // round-trip on the contended dev box (the bash exited first → no echo →
    // ''). collectBytes still early-resolves on match, so this doesn't slow
    // the test; afterAll kills the pty.
    // sleep 30 (not 5): under a fully-parallel full-suite run on the contended
    // box the ack_payload read + ack + keystroke round-trip can take many
    // seconds, and the pty must stay open until the echo arrives.
    const handle = spawnTestPty(['printf "ack_payload\\n"; sleep 30']);
    const ws = openWs(`/pty/${handle.id}`);
    // ack_payload prints immediately — collect before awaiting open (see the
    // round-trip test) so the frame can't slip the open→listener gap.
    const ackRead = collectBytes(ws, (s) => s.includes('ack_payload'));
    const opened = await awaitOpenOrClose(ws);
    expect(opened.opened).toBe(true);
    await ackRead;
    // Ack 1MB worth of fake bytes — should not throw or close socket.
    ws.send(JSON.stringify({ type: 'ack', bytes: 1_000_000 }));
    // Send another keystroke, verify socket still alive.
    ws.send(Buffer.from('echo POST_ACK\n'));
    const after = await collectBytes(ws, (s) => s.includes('POST_ACK'), 15_000);
    expect(after).toContain('POST_ACK');
    ws.close();
  });
});
