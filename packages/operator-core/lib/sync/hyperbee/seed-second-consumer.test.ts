/**
 * seed-second-consumer.test.ts — P-009: a GENERIC second consumer boots from a
 * cut seed via the TOP-LEVEL façade (cutHiveSeed → restoreHiveSeed) and then
 * delta-replicates BOTH halves forward (two-peer / LIVE-1-style).
 *
 * This is the GENERICITY proof for the seed-bundle layer: the same cut/restore
 * capability the installer uses is driven end-to-end by an ARBITRARY consumer —
 * an arbitrary hiveId + arbitrary dirs, with no papercusp-installer bootstrap in
 * sight — showing the layer is a reusable capability (D-006: dogfood is the first
 * consumer, not the only one), not a one-off wired to the installer. Distinct from
 * its siblings:
 *   - P-003 (raw corestore provider) / P-004 (raw git provider) test each provider
 *     in ISOLATION; this drives the COMPOSED cutHiveSeed / restoreHiveSeed façade.
 *   - P-007 (restoreHiveSeed orchestration) proves restore + the admission-timing
 *     split, but NOT forward delta-replication after restore. P-009 adds the
 *     "restore the snapshot, then catch up ONLY the delta live" leg for BOTH the
 *     federated hive state (corestore replication) AND the code (git fetch) — the
 *     seed=BYTES / join=DELTA property that is the whole point of the feature.
 *
 * Hermetic: real git (no network) + real corestore replication, no PG — so it runs
 * in the fast affected suite alongside the other seed tests. Mirrors their resource
 * hygiene (every tmp dir + store torn down in afterEach so a thrown assertion can't
 * leak a dir or an open store).
 */

import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type PeerLogOp } from './peer-log';
import { cutHiveSeed } from './seed-cutter';
import { restoreHiveSeed } from './restore-hive-seed';

const exec = promisify(execFile);
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

/** A federated hive-state op (a plan row, in the shape the real substrate writes). */
function op(i: number): PeerLogOp {
  return { type: 'put', table: 'harness_plans', hbKey: `P-${i}`, value: { id: `P-${i}` }, ts: 100 + i, schema_version: 1, author_pubkey: 'ownerdev' };
}

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'seed@test']);
  await g(dir, ['config', 'user.name', 'Seed Test']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
}

/** `store.get()` is typed loosely upstream (`unknown`); narrow at the boundary. */
interface TestCore {
  readonly length: number;
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<void>;
  get(i: number, opts?: { wait?: boolean }): Promise<unknown>;
}

/** A replication stream between two corestores (loosely typed upstream). */
type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void; on(e: string, cb: () => void): void };
function replicate(store: Corestore, initiator: boolean): Pipeable {
  const s = store.replicate(initiator) as unknown as Pipeable;
  s.on('error', () => {}); // torn-down streams emit ECONNRESET-ish churn; ignore
  return s;
}

describe('seed-bundle second (generic) consumer', () => {
  it('restores a cutHiveSeed seed OFFLINE, then delta-replicates BOTH halves forward', async () => {
    // ---- SOURCE hive (peer A): a code repo + a corestore with 3 hive-state ops ----
    const srcRepo = tmpDir('p9-src-repo-');
    await initRepo(srcRepo);
    writeFileSync(join(srcRepo, 'app.txt'), 'v1');
    await g(srcRepo, ['add', '.']);
    await g(srcRepo, ['commit', '-qm', 'v1']);

    const srcStore = makeStore(tmpDir('p9-src-store-'));
    await srcStore.ready();
    const logA = await openOwnLog(srcStore);
    for (let i = 0; i < 3; i++) await logA.append(op(i));
    const keyHex = logA.keyHex;

    // ---- CUT a combined seed via the TOP-LEVEL façade (the release CLI's API),
    //      as an ARBITRARY consumer: arbitrary hiveId, no installer in sight. ----
    const seedDir = tmpDir('p9-seed-');
    const cut = await cutHiveSeed({
      hiveId: 'rig-hive',
      cutAtEpoch: 0,
      cutHlc: '0',
      cutTs: 1,
      outDir: seedDir,
      git: { sourceRepoDir: srcRepo, originUrl: 'https://github.com/Papercusp/papercup', rev: '--all' },
      corestore: { sourceStore: srcStore, coreKeys: [keyHex] },
    });
    expect(cut.manifest.hiveId).toBe('rig-hive');
    expect(cut.manifest.stores.map((s) => s.kind).sort()).toEqual(['corestore', 'git']);

    // ---- SOURCE ADVANCES beyond the cut (the live delta the join would carry) ----
    for (let i = 3; i < 5; i++) await logA.append(op(i)); // federated-state delta: 2 ops
    writeFileSync(join(srcRepo, 'app.txt'), 'v2');
    await g(srcRepo, ['commit', '-aqm', 'v2']); // code delta: 1 commit

    // ---- SECOND CONSUMER (peer B): restore the seed into ITS OWN dirs ----
    const targetRepoDir = join(tmpDir('p9-b-repo-'), 'checkout');
    const targetStoreDir = join(tmpDir('p9-b-store-'), 'hyperbee');
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]); // unencrypted seed → nothing deferred
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(res.outcomes.map((o) => o.kind).sort()).toEqual(['corestore', 'git']);

    // ---- OFFLINE pre-positioning: both halves present at the SNAPSHOT, no peer ----
    expect(readFileSync(join(targetRepoDir, 'app.txt'), 'utf8')).toBe('v1'); // seed snapshot, NOT v2
    expect(Number(await g(targetRepoDir, ['rev-list', '--count', 'HEAD']))).toBe(1);

    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(3); // hive-state snapshot readable offline
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
    expect(await coreB.get(2, { wait: false })).toMatchObject({ hbKey: 'P-2' });

    // B's OWN author log is fresh + unique — no primary-key collision with the
    // seeded owner log (the joiner writes under its own identity, safe by design).
    const logB = await openOwnLog(storeB);
    expect(logB.length).toBe(0);
    expect(logB.keyHex).not.toBe(keyHex);

    // ---- DELTA-REPLICATE the federated hive state forward (corestore, LIVE-1) ----
    // Blocks 0..2 are already local from the seed; only 3..4 transfer over the wire.
    const a = replicate(srcStore, true);
    const b = replicate(storeB, false);
    a.pipe(b).pipe(a);
    cleanups.push(() => {
      a.destroy();
      b.destroy();
    });
    await coreB.update({ wait: true });
    expect(coreB.length).toBe(5); // 3 seeded + 2 delta blocks
    expect(await coreB.get(4, { wait: true })).toMatchObject({ hbKey: 'P-4' });

    // ---- DELTA-FETCH the code forward (git): only the new commit transfers ----
    // (The real join fetches from origin=GitHub; the source dir stands in offline.)
    await g(targetRepoDir, ['fetch', '-q', srcRepo, 'main']);
    await g(targetRepoDir, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    expect(readFileSync(join(targetRepoDir, 'app.txt'), 'utf8')).toBe('v2');
    expect(Number(await g(targetRepoDir, ['rev-list', '--count', 'HEAD']))).toBe(2);
  });

  it('round-trips the full dogfood SHAPE (superproject + submodule + hive-state) through the façade', async () => {
    // A submodule repo (stands in for one of the 27 dogfood submodules).
    const subSrc = tmpDir('p9-sub-');
    await initRepo(subSrc);
    writeFileSync(join(subSrc, 'lib.txt'), 'sublib');
    await g(subSrc, ['add', '.']);
    await g(subSrc, ['commit', '-qm', 'sub v1']);

    // A superproject that vendors it — the real dogfood shape: superproject + submodule.
    const superSrc = tmpDir('p9-super-');
    await initRepo(superSrc);
    writeFileSync(join(superSrc, 'top.txt'), 'top');
    await g(superSrc, ['add', '.']);
    await g(superSrc, ['commit', '-qm', 'top v1']);
    await g(superSrc, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'vendor/sub']);
    await g(superSrc, ['commit', '-qm', 'add submodule']);

    const store = makeStore(tmpDir('p9-shape-store-'));
    await store.ready();
    const log = await openOwnLog(store);
    await log.append(op(0));
    const keyHex = log.keyHex;

    // Cut + restore the whole shape through ONE top-level façade round-trip.
    const seedDir = tmpDir('p9-shape-seed-');
    await cutHiveSeed({
      hiveId: 'rig-hive',
      cutAtEpoch: 0,
      cutHlc: '0',
      cutTs: 1,
      outDir: seedDir,
      git: { sourceRepoDir: superSrc, originUrl: 'https://example/super', rev: '--all' },
      corestore: { sourceStore: store, coreKeys: [keyHex] },
    });

    const targetRepoDir = join(tmpDir('p9-shape-repo-'), 'checkout');
    const targetStoreDir = join(tmpDir('p9-shape-tgt-store-'), 'hyperbee');
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir });
    expect(res.ran).toBe(true);
    expect(res.outcomes.every((o) => o.ok)).toBe(true);

    // Superproject + submodule + federated hive-state all pre-positioned offline.
    expect(readFileSync(join(targetRepoDir, 'top.txt'), 'utf8')).toBe('top');
    expect(readFileSync(join(targetRepoDir, 'vendor/sub/lib.txt'), 'utf8')).toBe('sublib');
    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(1);
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
  });
});
