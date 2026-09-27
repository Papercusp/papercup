/**
 * WI-10003481 — a remote log whose shared core is HOSTED by a sibling store must
 * still replicate over the CALLER store's connections.
 *
 * remote-core-host.ts (WI-5673) opens each admitted remote log in exactly ONE
 * corestore per machine: the first harness to admit a key hosts it, and every
 * later sibling gets a SESSION on that core. corestore 7.9.2 attaches a core
 * only to streams its OWN root store replicated (`streamTracker.attachAll` on
 * the downloading transition, and `replicate()` iterating `this.cores`). So when
 * the host store never replicated the socket a peer arrived on, the caller's
 * session sits at peersCount 0 on a live connection.
 *
 * Measured on the tower 2026-09-27: 38 sibling harnesses admitted the VM log
 * f8987962 from 06:40Z; the root `papercusp` harness admitted it at 09:54Z and
 * then sat `no_replicator` on a live connection until a fresh VM connection.
 */
import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import NoiseSecretStream from '@hyperswarm/secret-stream';
import { openOwnLog, openRemoteLog } from './peer-log';
import { __resetRemoteCoreHostsForTest, registerStoreMachine } from './remote-core-host';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
  __resetRemoteCoreHostsForTest();
});

function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

async function rawSocketPair(): Promise<[net.Socket, net.Socket]> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        reject(new Error('no port'));
        return;
      }
      let a: net.Socket | null = null;
      let b: net.Socket | null = null;
      const done = (): void => {
        if (!a || !b) return;
        server.close();
        cleanups.push(() => {
          try {
            a!.destroy();
            b!.destroy();
          } catch {}
        });
        resolve([a, b]);
      };
      server.on('connection', (s) => {
        b = s;
        done();
      });
      const c = net.connect(addr.port, '127.0.0.1', () => {
        a = c;
        done();
      });
      c.on('error', reject);
    });
  });
}

/** The stream type a Hyperswarm connection hands to `store.replicate(socket)`. */
async function noiseStreamPair(): Promise<[NoiseSecretStream, NoiseSecretStream]> {
  const [rawA, rawB] = await rawSocketPair();
  const a = new NoiseSecretStream(true, rawA);
  const b = new NoiseSecretStream(false, rawB);
  cleanups.push(() => {
    try {
      a.destroy();
      b.destroy();
    } catch {}
  });
  await Promise.all([
    new Promise<void>((r) => a.on('connect', () => r())),
    new Promise<void>((r) => b.on('connect', () => r())),
  ]);
  return [a, b];
}

async function waitFor(fn: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

async function seedLog(store: Corestore, hbKey: string): Promise<string> {
  const own = await openOwnLog(store);
  await own.append({
    type: 'put',
    table: 'features_consolidated',
    hbKey,
    value: {},
    ts: 10,
    schema_version: 1,
    author_pubkey: 'A',
  });
  return own.keyHex;
}

describe('remote-core-host: caller-store attach (WI-10003481)', () => {
  it('a caller whose sibling HOSTS the core, but never replicated the socket, still replicates over its own connection', async () => {
    const serveStore = makeStore('rch-ca-serve-');
    await serveStore.ready();
    const keyHex = await seedLog(serveStore, 'CALLER-ATTACH-1');

    const hostSibling = makeStore('rch-ca-host-');
    const caller = makeStore('rch-ca-caller-');
    await Promise.all([hostSibling.ready(), caller.ready()]);
    registerStoreMachine(hostSibling, '/machine-one');
    registerStoreMachine(caller, '/machine-one');

    // The sibling admits the key first, so it hosts the core. It is never on
    // the connection below (no socket existed for it, as for a handle that
    // registered after the socket formed).
    const viaHost = await openRemoteLog(hostSibling, keyHex);
    expect(viaHost.peersCount?.() ?? 0).toBe(0);

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    caller.replicate(sockFetch);

    // The caller admits the same key AFTER its connection is open.
    const viaCaller = await openRemoteLog(caller, keyHex);
    const attached = await waitFor(() => (viaCaller.peersCount?.() ?? 0) > 0);
    expect(attached).toBe(true);

    await viaCaller.update();
    expect(viaCaller.length).toBeGreaterThan(0);
    expect(await viaCaller.get(0)).toMatchObject({ hbKey: 'CALLER-ATTACH-1' });
  }, 60_000);

  it('a connection the caller opens AFTER borrowing the shared core also carries it', async () => {
    const serveStore = makeStore('rch-cb-serve-');
    await serveStore.ready();
    const keyHex = await seedLog(serveStore, 'CALLER-ATTACH-2');

    const hostSibling = makeStore('rch-cb-host-');
    const caller = makeStore('rch-cb-caller-');
    await Promise.all([hostSibling.ready(), caller.ready()]);
    registerStoreMachine(hostSibling, '/machine-two');
    registerStoreMachine(caller, '/machine-two');

    await openRemoteLog(hostSibling, keyHex);
    const viaCaller = await openRemoteLog(caller, keyHex);

    // Only now does the peer connect, and only the caller replicates it.
    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    caller.replicate(sockFetch);

    const attached = await waitFor(() => (viaCaller.peersCount?.() ?? 0) > 0);
    expect(attached).toBe(true);
  }, 60_000);

  it('CONTROL: an unregistered caller (no dedup) replicates over its own connection', async () => {
    const serveStore = makeStore('rch-cc-serve-');
    await serveStore.ready();
    const keyHex = await seedLog(serveStore, 'CALLER-ATTACH-3');
    const caller = makeStore('rch-cc-caller-');
    await caller.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    caller.replicate(sockFetch);

    const viaCaller = await openRemoteLog(caller, keyHex);
    expect(await waitFor(() => (viaCaller.peersCount?.() ?? 0) > 0)).toBe(true);
  }, 60_000);
});
