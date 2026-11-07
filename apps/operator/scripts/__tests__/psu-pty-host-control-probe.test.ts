import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeControlServerForRebind, controlSocketProbeOutcome, controlSocketSelfHealAction, decodeControl } from '../psu-pty-host.mjs';

describe('psu-pty-host control socket probe', () => {
  it('decodes an owner-bound no-op probe and rejects a different owner', () => {
    const message = decodeControl(JSON.stringify({
      v: 1,
      mode: 'probe',
      data: '',
      ownerId: 'su-probe-owner',
    }));

    expect(message).toMatchObject({
      mode: 'probe',
      gated: false,
      ownerId: 'su-probe-owner',
    });
    expect(controlSocketProbeOutcome(message, 'su-probe-owner')).toEqual({
      ok: true,
      reason: 'control-socket-live',
    });
    expect(controlSocketProbeOutcome(message, 'su-other-owner')).toEqual({
      ok: false,
      reason: 'ownerId-mismatch',
    });
    expect(controlSocketProbeOutcome({ ...message, mode: 'turn' }, 'su-probe-owner')).toBeNull();
  });

  it('rebinds when the socket path exists but its server is not listening', () => {
    expect(controlSocketSelfHealAction({ metaMine: true, sockOnDisk: true, serverListening: false })).toBe('rebind');
    expect(controlSocketSelfHealAction({ metaMine: true, sockOnDisk: true, serverListening: true })).toBe('healthy');

    let closeCalls = 0;
    let rebindCalls = 0;
    closeControlServerForRebind({
      listening: false,
      close: () => { closeCalls += 1; },
    }, () => { rebindCalls += 1; });
    expect(closeCalls).toBe(0);
    expect(rebindCalls).toBe(1);
  });

  it('restores an owner-bound probe ACK from a stale socket path without restarting the host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'psu-control-probe-'));
    const socketPath = join(directory, 'control.sock');
    const ownerId = 'su-isolated-probe-owner';
    const server = createServer((connection) => {
      connection.once('data', (data) => {
        const outcome = controlSocketProbeOutcome(decodeControl(data), ownerId);
        connection.end(`${JSON.stringify({ v: 1, ...outcome })}\n`);
      });
    });
    const probe = (requestedOwner: string) => new Promise<unknown>((resolve, reject) => {
      const connection = createConnection(socketPath);
      connection.setTimeout(2_000, () => connection.destroy(new Error('probe response timed out')));
      connection.once('error', reject);
      connection.once('connect', () => {
        connection.write(JSON.stringify({ v: 1, mode: 'probe', data: '', ownerId: requestedOwner }));
      });
      let response = '';
      connection.on('data', (data) => {
        response += data.toString();
        if (!response.includes('\n')) return;
        connection.end();
        try { resolve(JSON.parse(response.trim())); } catch (error) { reject(error); }
      });
    });

    try {
      // Discovery can retain a filesystem node after the listener is lost. A
      // regular stale node reproduces that exact exists-but-unconnectable input
      // without contacting or replacing any managed agent's control socket.
      await writeFile(socketPath, 'stale discovery node');
      await expect(probe(ownerId)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

      const action = controlSocketSelfHealAction({ metaMine: true, sockOnDisk: true, serverListening: server.listening });
      expect(action).toBe('rebind');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        closeControlServerForRebind(server, () => {
          void unlink(socketPath).then(() => server.listen(socketPath, resolve), reject);
        });
      });

      expect(await probe(ownerId)).toEqual({ v: 1, ok: true, reason: 'control-socket-live' });
      expect(await probe('su-other-owner')).toEqual({ v: 1, ok: false, reason: 'ownerId-mismatch' });
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
