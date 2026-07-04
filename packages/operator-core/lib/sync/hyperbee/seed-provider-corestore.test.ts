/**
 * seed-provider-corestore.test.ts — the corestore SeedProvider (P-003).
 *
 * Proves the load-bearing properties with a REAL corestore (no network, no PG):
 *  - cut → restore PRE-POSITIONS an admitted log's blocks so a fresh peer reads
 *    them OFFLINE, and subsequent replication transfers ONLY the delta;
 *  - restore does NOT collide the joiner's own log key (no primary-key leak);
 *  - restore is idempotent;
 *  - verify fails closed on a hash mismatch.
 *
 * Mirrors peer-log.test.ts resource hygiene: every tmp dir + store torn down in
 * afterEach so a thrown assertion can't leak a dir or an open store.
 */

import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type PeerLogOp } from './peer-log';
import { createCorestoreSeedProvider, CORESTORE_SEED_KIND } from './seed-provider-corestore';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* ignore teardown errors */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeStore(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => store.close());
  return store;
}

function op(i: number): PeerLogOp {
  return { type: 'put', table: 'harness_plans', hbKey: `P-${i}`, value: { id: `P-${i}` }, ts: 100 + i, schema_version: 1, author_pubkey: 'ownerdev' };
}

/** `store.get()` is typed loosely upstream (`unknown`); narrow at the boundary. */
interface TestCore {
  readonly length: number;
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<void>;
  get(i: number, opts?: { wait?: boolean }): Promise<unknown>;
}

describe('corestore seed provider', () => {
  it('cut → restore pre-positions blocks offline; replication carries only the delta; no own-log collision', async () => {
    // --- Peer A (owner): an admitted author log with 3 ops ---
    const dirA = tmpDir('seed-A-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    for (let i = 0; i < 3; i++) await logA.append(op(i));
    expect(logA.length).toBe(3);
    const keyHex = logA.keyHex;

    // --- CUT into a read-only replica (the seed payload) ---
    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir });
    expect(entry.kind).toBe(CORESTORE_SEED_KIND);
    expect((entry.meta as { coreLengths: Record<string, number> }).coreLengths[keyHex]).toBe(3);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);

    // --- VERIFY passes on the untouched payload ---
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // --- RESTORE into a fresh peer B's store dir ---
    const dirBroot = tmpDir('seed-B-');
    const targetStoreDir = join(dirBroot, 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });

    // --- B opens A's core by key OFFLINE: blocks are already present (seed) ---
    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(3); // length carried by the seed, no peer connected
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
    expect(await coreB.get(2, { wait: false })).toMatchObject({ hbKey: 'P-2' });

    // --- B's OWN log is unique (no primary-key collision with the seed/owner) ---
    const logB = await openOwnLog(storeB);
    expect(logB.length).toBe(0);
    expect(logB.keyHex).not.toBe(keyHex);

    // --- A appends the DELTA (2 more ops) → length 5 ---
    for (let i = 3; i < 5; i++) await logA.append(op(i));
    expect(logA.length).toBe(5);

    // --- Connect replication A <-> B; B fetches ONLY blocks 3..4 ---
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };
    const a = storeA.replicate(true) as unknown as Pipeable;
    const b = storeB.replicate(false) as unknown as Pipeable;
    (a as unknown as { on(e: string, cb: () => void): void }).on('error', () => {});
    (b as unknown as { on(e: string, cb: () => void): void }).on('error', () => {});
    a.pipe(b).pipe(a);
    cleanups.push(() => {
      a.destroy();
      b.destroy();
    });
    await coreB.update({ wait: true });
    expect(coreB.length).toBe(5);
    expect(await coreB.get(4, { wait: true })).toMatchObject({ hbKey: 'P-4' });
  });

  it('restore is idempotent (re-running leaves the seeded core readable)', async () => {
    const dirA = tmpDir('seed-A2-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    await logA.append(op(0));
    const keyHex = logA.keyHex;

    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage2-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir });

    const targetStoreDir = join(tmpDir('seed-B2-'), 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });
    await provider.restore(entry, payload, { targetStoreDir }); // second run must not throw

    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(1);
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
  });

  it('verify fails closed on a hash mismatch', async () => {
    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage3-');
    writeFileSync(join(stagingDir, 'x'), 'some bytes');
    const bogus = {
      kind: CORESTORE_SEED_KIND,
      hash: 'deadbeef'.repeat(8),
      sizeBytes: 0,
      source: { type: 'resource' as const, path: stagingDir },
    };
    const res = await provider.verify(bogus, { path: stagingDir });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });

  it('verify fails when the payload path is missing', async () => {
    const provider = createCorestoreSeedProvider();
    const res = await provider.verify(
      { kind: CORESTORE_SEED_KIND, hash: 'x', sizeBytes: 0, source: { type: 'resource', path: '/no/such' } },
      { path: '/no/such/path/at/all' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/payload path missing/);
  });
});
