/**
 * WI-5673 — SHARED-SOCKET / MULTI-CORESTORE SERVE CLOBBER.
 *
 * THE PRODUCTION TOPOLOGY THIS MODELS (all three facts are in-tree today):
 *   1. There is ONE process-wide Hyperswarm (`_sharedSwarm`, swarm.ts:3163), so
 *      ONE peer socket is muxed across EVERY harness sharing that peer —
 *      "the live-fed rig runs hello-world-pot + hello-world + papercusp over a
 *      single connection" (swarm.ts:2702-2704, EI-13317/WI-5481).
 *   2. Each harness has its OWN Corestore (corestore.ts, cached per
 *      `${workspaceRoot}::${harnessSlug}`).
 *   3. Each harness's connection handler calls `opts.store.replicate(socket)`
 *      on that SHARED socket (swarm.ts:2519).
 *
 * So N distinct corestores call `.replicate()` on ONE stream. scope-cores.ts
 * (lines 13-15) documents — "verified against corestore 7.9.2 / hypercore 11 /
 * protomux source" — exactly why that is unsafe:
 *
 *     "protomux `pair()` is a Map SET keyed (protocol,id): a second corestore's
 *      `replicate()` on the same stream CLOBBERS the first's hypercore/alpha
 *      pairing — so the scoped store must never `replicate()` a shared socket."
 *
 * That invariant is honoured for the SCOPED store and violated by the MAIN
 * path. `pair()` registers the lazy `ondiscoverykey → _attachMaybe` SERVE
 * callback; a Map.set means only the LAST corestore to replicate the socket can
 * ever answer a discovery-key request. Every core belonging to a losing store is
 * then structurally UNSERVABLE on that connection — while the socket itself
 * stays fully handshaken and live.
 *
 * That is precisely the `connected_never_replicated [never_attached]` signature,
 * and it explains what a purely local theory could not:
 *   - the connection is alive (swarmConnections > 0) yet peersCount stays 0;
 *   - it is ORDER-dependent, hence non-deterministic run to run;
 *   - it is DIRECTION-selective (each side has its own pair() winner);
 *   - a peer handle to a core nobody serves sits at peersCount 0 FOREVER
 *     (verified separately: peer-log-post-connection-attach.test.ts + fact
 *     wi-5673-lead-peerscount-requires-remote-to-serve).
 *
 * The control case in this file is the same wiring with ONE corestore per side,
 * which must keep working — so a red here is specifically the multi-store
 * clobber, never a broken harness.
 */
import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- no types shipped; this is the exact stream a Hyperswarm
// connection hands to `store.replicate(socket)`, so the probe must use it.
import NoiseSecretStream from '@hyperswarm/secret-stream';
import { openOwnLog, openRemoteLog } from './peer-log';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

function makeStoreDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

function storeAt(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

function makeStore(prefix: string): Corestore {
  return storeAt(makeStoreDir(prefix));
}

/**
 * A real loopback NOISE-SECRET-STREAM pair — byte-for-byte the stream type a
 * Hyperswarm connection hands to `store.replicate(socket)` (that is what makes
 * `noiseStream.userData` a single SHARED Protomux, which is the whole point).
 * A raw TCP socket is NOT a substitute: hypercore's createProtocolStream reads
 * `outerStream.noiseStream` and throws `Invalid stream` without one.
 */
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
        if (a && b) {
          server.close();
          cleanups.push(() => {
            try {
              a!.destroy();
              b!.destroy();
            } catch {}
          });
          resolve([a, b]);
        }
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

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<boolean> {
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

describe('shared-socket multi-corestore serve clobber (WI-5673)', () => {
  it('CONTROL: one corestore per side over a real socket serves its log fine', async () => {
    const serveStore = makeStore('ssc-ctl-serve-');
    await serveStore.ready();
    const fetchStore = makeStore('ssc-ctl-fetch-');
    await fetchStore.ready();

    const keyHex = await seedLog(serveStore, 'CTL-1');

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remote = await openRemoteLog(fetchStore, keyHex);
    const attached = await waitFor(() => (remote.peersCount?.() ?? 0) > 0);

    expect(attached).toBe(true);
    await remote.update();
    expect(remote.length).toBe(1);
  }, 30_000);

  it('THE DEFECT: a SECOND corestore replicating the same socket makes the FIRST store’s log unservable (peersCount stays 0 on a live connection)', async () => {
    // Serve side: two "harnesses" sharing one socket, exactly like the rig.
    const serveFirst = makeStore('ssc-serve-1-');
    await serveFirst.ready();
    const serveSecond = makeStore('ssc-serve-2-');
    await serveSecond.ready();

    // Fetch side: mirror topology, so each store can hold its peer's handle.
    const fetchFirst = makeStore('ssc-fetch-1-');
    await fetchFirst.ready();
    const fetchSecond = makeStore('ssc-fetch-2-');
    await fetchSecond.ready();

    const keyFirst = await seedLog(serveFirst, 'H1-1');
    const keySecond = await seedLog(serveSecond, 'H2-1');

    const [sockFetch, sockServe] = await noiseStreamPair();

    // Both harnesses replicate the SHARED socket, in join order.
    serveFirst.replicate(sockServe);
    serveSecond.replicate(sockServe);
    fetchFirst.replicate(sockFetch);
    fetchSecond.replicate(sockFetch);

    await waitFor(() => false, 250);

    // Production ordering: the peer log is admitted (opened) long after the
    // connection is established.
    const remoteFirst = await openRemoteLog(fetchFirst, keyFirst);
    const remoteSecond = await openRemoteLog(fetchSecond, keySecond);

    const firstAttached = await waitFor(() => (remoteFirst.peersCount?.() ?? 0) > 0, 4_000);
    const secondAttached = await waitFor(() => (remoteSecond.peersCount?.() ?? 0) > 0, 4_000);

    // Report both so a failure names WHICH store lost the pair() race.
    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 probe] firstAttached=${firstAttached} (peers=${remoteFirst.peersCount?.() ?? 0}) ` +
        `secondAttached=${secondAttached} (peers=${remoteSecond.peersCount?.() ?? 0})`,
    );

    // THE ASSERTION UNDER TEST: with the clobber, exactly one side can be
    // served — so this expectation FAILS while the defect is live, and is the
    // regression guard once the shared socket is muxed safely.
    expect({ firstAttached, secondAttached }).toEqual({
      firstAttached: true,
      secondAttached: true,
    });
  }, 30_000);

  /**
   * The one surviving leg of the clobber theory. The case above passes because
   * the serve-side core was ALREADY OPEN when `replicate()` ran, and corestore
   * eagerly attaches every open core at that moment — so the lazy
   * `ondiscoverykey` callback (the thing `pair()` clobbers) is never consulted.
   *
   * A core that is on disk but NOT open can only be served through that lazy
   * callback. If the second corestore's `pair()` really does strand the first,
   * THIS is where it shows: same live connection, same handshake, but the
   * requested core is answered by the wrong store's `_attachMaybe`.
   */
  it('COLD CORE CONTROL: with ONE corestore on the socket, a cold on-disk core IS served lazily', async () => {
    const serveDir = makeStoreDir('ssc-coldctl-');
    const warm = storeAt(serveDir);
    await warm.ready();
    const keyHex = await seedLog(warm, 'COLDCTL-1');
    await warm.close();

    const serveStore = storeAt(serveDir);
    await serveStore.ready();
    const fetchStore = makeStore('ssc-coldctl-fetch-');
    await fetchStore.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe); // the ONLY store on this socket
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remote = await openRemoteLog(fetchStore, keyHex);
    const attached = await waitFor(() => (remote.peersCount?.() ?? 0) > 0, 4_000);
    // eslint-disable-next-line no-console
    console.log(`[WI-5673 cold CONTROL] attached=${attached} (peers=${remote.peersCount?.() ?? 0})`);

    // This MUST pass — it is what isolates the failure below to the second
    // corestore's pair() clobber rather than to cold cores being unservable.
    expect(attached).toBe(true);
    await remote.update();
    expect(remote.length).toBe(1);
  }, 30_000);

  it('COLD CORE + a second corestore on the socket: PROVEN BROKEN — the log is unservable forever on a live connection (characterization; INVERT when fixed)', async () => {
    const serveFirstDir = makeStoreDir('ssc-cold-1-');
    const serveSecondDir = makeStoreDir('ssc-cold-2-');

    // Write the log, then CLOSE the whole store so the core is cold on disk.
    const warm = storeAt(serveFirstDir);
    await warm.ready();
    const keyFirst = await seedLog(warm, 'COLD-1');
    await warm.close();

    const serveFirst = storeAt(serveFirstDir);
    await serveFirst.ready();
    const serveSecond = storeAt(serveSecondDir);
    await serveSecond.ready();
    // serveSecond is the LAST to replicate, so it owns the hypercore/alpha
    // notify slot — the core being requested belongs to serveFirst.
    const keySecond = await seedLog(serveSecond, 'COLD-2');

    const fetchStore = makeStore('ssc-cold-fetch-');
    await fetchStore.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveFirst.replicate(sockServe);
    serveSecond.replicate(sockServe);
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remoteCold = await openRemoteLog(fetchStore, keyFirst);
    const coldAttached = await waitFor(() => (remoteCold.peersCount?.() ?? 0) > 0, 4_000);
    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 cold probe] coldAttached=${coldAttached} (peers=${remoteCold.peersCount?.() ?? 0}) ` +
        `warmKeyOnSecondStore=${keySecond.slice(0, 8)}`,
    );

    // ⚠ CHARACTERIZATION OF A LIVE DEFECT — this asserts the BROKEN behaviour
    // on purpose, so the shared green gate is not red-pinned by a known bug
    // while the fix is designed. The three assertions above it are the controls
    // that make this one mean "the second corestore's pair() clobber", and
    // nothing else: same cold core + same wiring with ONE store attaches fine.
    //
    // WHEN THE FIX LANDS, INVERT THIS: `expect(coldAttached).toBe(true)` plus
    // the update()/length/get() checks the COLD CORE CONTROL case already runs.
    // A green here after a fix means the fix did NOT work.
    expect(coldAttached).toBe(false);
    expect(remoteCold.peersCount?.() ?? 0).toBe(0);
  }, 30_000);
});
