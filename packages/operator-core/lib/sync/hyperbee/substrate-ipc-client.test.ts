/**
 * WI-895 fix (b) regression tests — the IPC client must survive sidecar death.
 *
 * The bug class this pins (live repro 2026-07-03, WI-895 posts 49989/49995):
 * the client never reset `socket`/`connectPromise` on error/close, so
 *   (i)  a failed dial (ENOENT) was swallowed by a dead reject branch and
 *        surfaced 5s later as a generic 'Connection timeout' (masking the truth
 *        from dev:service_health's probeSubstrateSidecar), and
 *   (ii) after a sidecar died, ensureConnected() returned the stale settled
 *        promise forever — every call() wrote to a destroyed socket and timed
 *        out against a LIVE replacement sidecar until the operator restarted.
 *
 * These tests use REAL unix sockets in a tmpdir (no PG, no docker) so the
 * reconnect semantics are exercised end-to-end.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SubstrateIpcClient } from './substrate-ipc-client';

interface FakeSidecar {
  server: net.Server;
  /** Simulate process death: destroy every live connection AND stop listening. */
  kill(): Promise<void>;
}

/** A minimal line-delimited JSON-RPC 2.0 echo server (the sidecar wire shape).
 *  Tracks connections so kill() behaves like a killed process — a bare
 *  server.close() only stops the LISTENER and would leave established
 *  connections (and thus the test) hanging. */
function startEchoServer(socketPath: string, respond = true): Promise<FakeSidecar> {
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    if (!respond) return;
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line) as { id: number; method: string };
        conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { echo: req.method } })}\n`);
      }
    });
  });
  const kill = (): Promise<void> => {
    for (const c of conns) c.destroy();
    conns.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({ server, kill }));
  });
}

function tmpSocketPath(tag: string): string {
  // Keep it short — unix socket paths cap at ~104 bytes.
  return path.join(os.tmpdir(), `pc-ipc-${tag}-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`);
}

describe('SubstrateIpcClient — WI-895 (b): reconnect + truthful dial errors', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('a dial to a nonexistent socket rejects FAST with the real error (not a masked 5s "Connection timeout")', async () => {
    const sockPath = tmpSocketPath('enoent');
    const client = new SubstrateIpcClient(sockPath);
    cleanups.push(() => client.close());

    const started = Date.now();
    await expect(client.call('sidecar:healthz')).rejects.toThrow(/ENOENT/);
    // The old dead-branch bug made this take the full 5s connect timer.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reconnects after sidecar death: call OK → server dies → call fails truthfully → server returns → call OK again', async () => {
    const sockPath = tmpSocketPath('respawn');
    const client = new SubstrateIpcClient(sockPath);
    cleanups.push(() => client.close());

    // 1. First sidecar generation: RPC round-trips.
    const gen1 = await startEchoServer(sockPath);
    await expect(client.call('sidecar:healthz')).resolves.toEqual({ echo: 'sidecar:healthz' });

    // 2. Sidecar dies (connections destroyed + listener closed + socket file gone).
    await gen1.kill();
    fs.rmSync(sockPath, { force: true });
    // Give the client's 'close' event a beat to fire.
    await new Promise((r) => setTimeout(r, 50));

    // 3. The next call re-DIALS (fresh state) and reports the real dial failure —
    //    the pre-fix client would instead reuse the stale resolved connectPromise
    //    and hang a write into the destroyed socket until the 30s RPC timeout.
    await expect(client.call('sidecar:healthz')).rejects.toThrow(/ENOENT|ECONNREFUSED/);

    // 4. Replacement sidecar binds the SAME path (spawn-side respawn does exactly
    //    this) — the very next call must reconnect and succeed. This is the
    //    "next healthz reconnects" recurrence guard from the WI-895 live specimen.
    const gen2 = await startEchoServer(sockPath);
    cleanups.push(() => gen2.kill());
    await expect(client.call('sidecar:ping')).resolves.toEqual({ echo: 'sidecar:ping' });
  });

  it('an in-flight RPC rejects promptly when the connection drops (no 30s hang)', async () => {
    const sockPath = tmpSocketPath('drop');
    // Accepts, never answers; we kill it while the RPC is in flight.
    const sidecar = await startEchoServer(sockPath, false);
    cleanups.push(() => sidecar.kill());

    const client = new SubstrateIpcClient(sockPath);
    cleanups.push(() => client.close());

    const started = Date.now();
    const inflight = client.call('sidecar:healthz');
    inflight.catch(() => {}); // observed again below — avoid an unhandled-rejection blip
    await new Promise((r) => setTimeout(r, 100)); // let the dial + write land
    await sidecar.kill(); // sidecar dies mid-RPC
    await expect(inflight).rejects.toThrow(/Socket error|closed/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('close() rejects pending RPCs instead of leaving them to time out', async () => {
    const sockPath = tmpSocketPath('close');
    const sidecar = await startEchoServer(sockPath, false); // accept, never respond
    cleanups.push(() => sidecar.kill());

    const client = new SubstrateIpcClient(sockPath);
    const inflight = client.call('sidecar:healthz');
    inflight.catch(() => {}); // observed again below
    // Let the dial establish so the RPC is actually pending on the wire.
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await expect(inflight).rejects.toThrow(/closed/i);
  });
});
