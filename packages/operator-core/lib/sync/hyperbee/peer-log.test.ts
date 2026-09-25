/**
 * peer-log.test.ts — unit tests for the per-peer single-writer log module
 * (Model B substrate, Stage 1).
 *
 * Pure over an injected Corestore so it runs without the network:
 *  - own writable log: append + ordered read + 64-hex key shape;
 *  - own log out-of-range get → null (never blocks/throws on the writable core);
 *  - a second store reads the first log read-only by key after update()
 *    (Stage-0 finding: store.replicate(bool) piped both ways replicates).
 *
 * Real replication wiring is Stage 4; here we exercise the handle + update().
 *
 * Resource hygiene: every temp dir + store is tracked in `cleanups` at creation
 * and torn down in `afterEach`, so a thrown assertion can't leak a dir or a
 * still-open store (mirrors __tests__/convergence.test.ts).
 */

import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, openRemoteLog, type PeerLogOp } from './peer-log';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch {}
  }
});

/** A Corestore over a fresh tmp dir; both are registered for afterEach teardown. */
function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const store = new Corestore(dir);
  cleanups.push(() => { void store.close(); });
  return store;
}

describe('peer-log', () => {
  it('own log appends + reads ops in order, exposes a 64-hex key', async () => {
    const store = makeStore('mb-own-');
    await store.ready();
    const log = await openOwnLog(store);
    const op: PeerLogOp = { type: 'put', table: 'features_consolidated', hbKey: 'F-1', value: { id: 'F-1' }, ts: 100, schema_version: 1, author_pubkey: 'devkeyA' };
    await log.append(op);
    expect(log.length).toBe(1);
    expect(await log.get(0)).toMatchObject({ hbKey: 'F-1', ts: 100, author_pubkey: 'devkeyA' });
    expect(log.keyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('own log get(i) out of range returns null (does not block or throw)', async () => {
    const store = makeStore('mb-oor-');
    await store.ready();
    const log = await openOwnLog(store);

    // Fresh (empty) log: index 0 is already past the end → null, must not hang.
    expect(log.length).toBe(0);
    expect(await log.get(0)).toBeNull();

    // After one append: index 1 is out of range → null (no peers to wait on).
    await log.append({ type: 'put', table: 'features_consolidated', hbKey: 'F-1', value: { id: 'F-1' }, ts: 1, schema_version: 1, author_pubkey: 'A' });
    expect(log.length).toBe(1);
    expect(await log.get(0)).toMatchObject({ hbKey: 'F-1' });
    expect(await log.get(1)).toBeNull();

    // Negative index → null (must not throw).
    expect(await log.get(-1)).toBeNull();
  });

  it('a second store reads the first log by key after update()', async () => {
    const s1 = makeStore('mb-w-'); await s1.ready();
    const s2 = makeStore('mb-r-'); await s2.ready();
    const own = await openOwnLog(s1);
    await own.append({ type: 'put', table: 'features_consolidated', hbKey: 'R-1', value: {}, ts: 10, schema_version: 1, author_pubkey: 'A' });
    // replicate the two stores (mirror Stage-0 finding: store.replicate(bool) → pipe both ways)
    // .replicate() is typed loosely upstream; it returns a duplex stream.
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);
    const remote = await openRemoteLog(s2, own.keyHex);
    await remote.update();
    expect(remote.length).toBe(1);
    expect(await remote.get(0)).toMatchObject({ hbKey: 'R-1' });
  });

  // WI-1856 (G9): openRemoteLog's session must be genuinely releasable — the
  // caller (boot.ts's revoke()) drops the RemoteLog reference on revocation,
  // but the underlying Hypercore session was never closed, leaking its
  // replicator/file-handle state for the process lifetime. Each `store.get()`
  // call opens a DISTINCT session on the shared core (Corestore sessions are
  // per-open, not per-key/refcounted-by-key) — `core.sessions` is Corestore's
  // own live-session bookkeeping, so asserting it decrements by exactly one
  // per `close()` proves this releases THIS session specifically, without
  // tearing down the underlying core (a second, still-open session on the
  // same key keeps working).
  it('close() releases the underlying Hypercore session without affecting a sibling session (WI-1856)', async () => {
    const s1 = makeStore('mb-close-w-'); await s1.ready();
    const s2 = makeStore('mb-close-r-'); await s2.ready();
    const own = await openOwnLog(s1);
    await own.append({ type: 'put', table: 'features_consolidated', hbKey: 'R-1', value: {}, ts: 10, schema_version: 1, author_pubkey: 'A' });
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);

    const remote = await openRemoteLog(s2, own.keyHex);
    await remote.update();
    // A sibling session on the SAME key (simulates e.g. a stall-detector reader
    // outliving one particular RemoteLog handle) — closing `remote` must not
    // disturb it.
    const sibling = await openRemoteLog(s2, own.keyHex);
    await sibling.update();

    type CoreWithSessions = { sessions?: { length: number } };
    const core = (s2 as unknown as { get(o: Record<string, unknown>): CoreWithSessions }).get({
      key: Buffer.from(own.keyHex, 'hex'),
    });
    const sessionsBefore = core.sessions?.length ?? -1;
    expect(sessionsBefore).toBeGreaterThan(0);

    expect(typeof remote.close).toBe('function');
    await remote.close!();

    expect(core.sessions?.length).toBe(sessionsBefore - 1); // exactly ONE session released
    // The sibling session is untouched — still readable.
    expect(sibling.length).toBe(1);
    expect(await sibling.get(0)).toMatchObject({ hbKey: 'R-1' });
  });
});

// p2p-join-catchup-speed-2026-09-23 P-533: the merge's look-ahead cancels its reads of a
// snapshot set it will skip. These pin `getCancellable` against a REAL Hypercore: the
// cancel reaches the replicator (the read rejects instead of waiting on a peer), a
// cancel that lands before the request is filed still refuses it, and a second reader
// of the same block keeps its own request.
describe('peer-log getCancellable (P-533)', () => {
  type Stream = { pipe<T extends Stream>(dest: T): T; destroy(): void };
  async function replicaOf3(): Promise<{
    remote: Awaited<ReturnType<typeof openRemoteLog>>;
    connect(): void;
  }> {
    const s1 = makeStore('mb-cw-'); await s1.ready();
    const s2 = makeStore('mb-cr-'); await s2.ready();
    const own = await openOwnLog(s1);
    for (const hbKey of ['R-1', 'R-2', 'R-3']) {
      await own.append({ type: 'put', table: 'features_consolidated', hbKey, value: {}, ts: 10, schema_version: 1, author_pubkey: 'A' });
    }
    let streams: Stream[] = [];
    const connect = (): void => {
      const a = s1.replicate(true) as unknown as Stream;
      const b = s2.replicate(false) as unknown as Stream;
      a.pipe(b).pipe(a);
      streams = [a, b];
    };
    connect();
    const remote = await openRemoteLog(s2, own.keyHex);
    await remote.update();
    expect(remote.length).toBe(3);
    expect(await remote.get(0)).toMatchObject({ hbKey: 'R-1' }); // block 0 local, 1-2 are not
    for (const s of streams) s.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { remote, connect };
  }

  it('cancel() rejects a read that is waiting on the network', async () => {
    const { remote } = await replicaOf3();
    const read = remote.getCancellable!(2);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the request is filed and waiting
    read.cancel();
    await expect(read.op).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('a cancel that lands before the request is filed still refuses it', async () => {
    const { remote } = await replicaOf3();
    const read = remote.getCancellable!(2);
    read.cancel();
    await expect(read.op).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('another reader of the same block keeps its request, and gets the block once a peer returns', async () => {
    const { remote, connect } = await replicaOf3();
    const plain = remote.get(1);
    const read = remote.getCancellable!(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    read.cancel();
    await expect(read.op).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    connect();
    await expect(plain).resolves.toMatchObject({ hbKey: 'R-2' });
  });

  it('an in-range read that is not cancelled resolves the op', async () => {
    const { remote, connect } = await replicaOf3();
    connect();
    await expect(remote.getCancellable!(2).op).resolves.toMatchObject({ hbKey: 'R-3' });
  });

  // P-533: the fold withdraws the pass's ranged prefetch when it jumps a skipped set. On the
  // rig that range fetched about 2 GB for a two-chunk crossing (2026-09-25 08:07Z).
  it('a prefetch range withdrawn while the peer is away fetches nothing once it returns', async () => {
    const { remote, connect } = await replicaOf3();
    const range = remote.prefetch(1, 3);
    expect(range).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20)); // the range is filed and waiting
    range!.cancel();
    connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(remote.contiguousLength).toBe(1);
    expect(await remote.has(2)).toBe(false);
  });

  // WI-10003092: Hypercore 11's `has` is async. The old sync wrapper returned `!!Promise`,
  // true for every block, so the seed-admission guard (seed-log-admission.ts) could not see
  // a replica whose blocks were never restored.
  it('has() is true only for blocks that are local', async () => {
    const { remote, connect } = await replicaOf3();
    expect([await remote.has(0), await remote.has(1), await remote.has(2)]).toEqual([true, false, false]);
    connect();
    await remote.get(2);
    expect(await remote.has(2)).toBe(true);
    expect(await remote.has(1)).toBe(false);
  });

  it('CONTROL: a prefetch range left alone fetches its blocks in the same window', async () => {
    const { remote, connect } = await replicaOf3();
    expect(remote.contiguousLength).toBe(1);
    remote.prefetch(1, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(remote.contiguousLength).toBe(3);
  });
});
