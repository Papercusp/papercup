/**
 * pty-stack integration test — exercises the entire pty stack end-to-
 * end (HTTP control plane + WS data plane + P4 screen-state replay)
 * against a live operator dev server. Skips with a clear message if
 * the operator isn't running, so CI can be tagged appropriately.
 *
 * Covers what the unit tests can't: the actual HTTP routes resolved
 * through Hono, instrumentation.ts boot path, and the cross-process
 * resume semantics.
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';

const OPERATOR = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://127.0.0.1:3055';
const WS_BASE = process.env.PAPERCUSP_PTY_WS_BASE ?? 'ws://127.0.0.1:3056';
const SLUG = process.env.PAPERCUSP_TEST_SLUG ?? 'sheets';

async function operatorAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${OPERATOR}/api/harness/projects`);
    return r.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!process.env.RUN_PTY_INTEGRATION)('pty stack end-to-end', () => {
  it('operator is reachable', async () => {
    const alive = await operatorAlive();
    expect(alive).toBe(true);
  });

  it('full lifecycle: spawn → WS attach → input round-trip → reconnect → P4 replay → kill', async () => {
    // 1. Spawn via HTTP control plane.
    const spawn = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json());
    expect(spawn.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(spawn.pid).toBeGreaterThan(0);

    // 2. WS attach with allow-localhost origin; write keystrokes; expect echo.
    const ws1 = new WebSocket(`${WS_BASE}/pty/${spawn.id}`, {
      headers: { Origin: 'http://localhost:3055' },
    });
    ws1.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', reject);
    });

    let echoBuf = '';
    ws1.on('message', (data, isBinary) => {
      if (isBinary) echoBuf += Buffer.from(data as ArrayBuffer).toString('utf8');
    });
    // Resize + keystroke.
    ws1.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    ws1.send(Buffer.from('echo INTEGRATION_MARKER\r'));
    await new Promise((r) => setTimeout(r, 800));
    expect(echoBuf).toContain('INTEGRATION_MARKER');
    ws1.close();
    // Tiny gap for WS server to detach subscriber cleanly.
    await new Promise((r) => setTimeout(r, 100));

    // 3. Reconnect — server should replay screen state via P4.
    const ws2 = new WebSocket(`${WS_BASE}/pty/${spawn.id}`, {
      headers: { Origin: 'http://localhost:3055' },
    });
    ws2.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', reject);
    });
    let replay = '';
    ws2.on('message', (data, isBinary) => {
      if (isBinary) replay += Buffer.from(data as ArrayBuffer).toString('utf8');
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(replay).toContain('INTEGRATION_MARKER');
    // Bounded: P4 emits ANSI screen state, NOT full session bytes.
    expect(replay.length).toBeLessThan(64 * 1024);
    ws2.close();

    // 4. Resume via /spawn { resumePtyId } — same pty, same pid.
    const resume = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24, resumePtyId: spawn.id }),
    }).then((r) => r.json());
    expect(resume.id).toBe(spawn.id);
    expect(resume.resumed).toBe(true);
    expect(resume.pid).toBe(spawn.pid);

    // 5. /resolve returns harness-aware config (E control plane).
    const resolved = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json());
    // The command is the HARNESS'S configured terminal CLI (omp, bash,
    // claude, …) — asserting a specific binary couples the contract test to
    // box config. Structural contract only: non-empty command + cwd + args/env.
    expect(typeof resolved.command).toBe('string');
    expect(resolved.command.length).toBeGreaterThan(0);
    expect(resolved.cwd).toMatch(/\//);
    expect(Array.isArray(resolved.args)).toBe(true);
    expect(typeof resolved.env).toBe('object');

    // 6. Kill.
    const kill = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/kill`, {
      method: 'POST',
    });
    expect(kill.status).toBe(204);
  }, 15000);

  it('rejects WS with disallowed Origin header', async () => {
    const spawn = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json());
    const ws = new WebSocket(`${WS_BASE}/pty/${spawn.id}`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    ws.binaryType = 'arraybuffer';
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => { /* close follows */ });
      ws.once('open', () => {
        ws.once('close', (code) => resolve(code));
      });
    });
    expect(closeCode).toBe(4403);
    await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/kill`, { method: 'POST' });
  });

  it('flow-control ack does not error', async () => {
    const spawn = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json());
    const ws = new WebSocket(`${WS_BASE}/pty/${spawn.id}`, {
      headers: { Origin: 'http://localhost:3055' },
    });
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Burst of fake acks shouldn't close the socket.
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'ack', bytes: 50_000 }));
    }
    // Send a keystroke and verify socket still responsive.
    let saw = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary && Buffer.from(data as ArrayBuffer).toString('utf8').includes('AFTER_ACK')) saw = true;
    });
    ws.send(Buffer.from('echo AFTER_ACK\r'));
    // Poll instead of one fixed sleep: the spawned CLI's startup (clear-screen,
    // banner) can delay the echo past a 600ms window on a busy box.
    for (let i = 0; i < 30 && !saw; i++) await new Promise((r) => setTimeout(r, 200));
    expect(saw).toBe(true);
    ws.close();
    await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/kill`, { method: 'POST' });
  });
});
