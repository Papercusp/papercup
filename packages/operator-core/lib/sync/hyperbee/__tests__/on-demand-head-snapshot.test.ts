/**
 * P-019 (plan memory-corpus-hygiene-and-release-distribution-2026-08-03, D-012) —
 * `handle.produceHeadSnapshotNow()`: the ON-DEMAND head snapshot that restores the
 * NO-OUTAGE sparse release cut.
 *
 * Boots a REAL substrate over a tmp Corestore with the merge poll timer DISABLED
 * (mirrors boot.test.ts's single-peer setup), because the whole point of the
 * mechanism is that the request is serviced INSIDE the serialized merge pass — a
 * fake handle could not distinguish that from an append done anywhere else.
 *
 * The load-bearing claims, each with its own case below:
 *  1. it actually appends a snapshot AT THE TAIL (that is the precondition
 *     `computeSparseFrom` scans for; without it a "sparse" cut ships the FULL core);
 *  2. it is NOT gated by the `SUBSTRATE_LOG_SNAPSHOT` producer flag — forced OFF in
 *     that case (the flag defaults ON since p2p-join-catchup-speed P-005);
 *  3. concurrent callers COALESCE onto one snapshot (a naive flag would orphan the
 *     first waiter and hang it forever);
 *  4. a stopped engine REJECTS rather than hanging (mergeNow short-circuits when
 *     stopped, so an armed request would never be serviced).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate } from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { findLatestSnapshotIndex } from '../read-merge';
import { isSnapshotOp } from '../log-snapshot';
import { listBootHistory } from '../boot-history';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p019-head-snap-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return dir;
}

async function bootWithOps(slug: string, opCount: number) {
  const handle = await bootHarnessSubstrate({
    workspaceRoot: tmpWorkspaceRoot(),
    workspaceId: 'ws-p019',
    harnessSlug: slug,
    mergePollMs: 0, // drive mergeNow by hand
    loadRevokedOverride: async () => new Set(), // avoid real PG
    applyOverride: async () => true,
    rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
  });
  expect(
    listBootHistory({
      workspaceId: 'ws-p019',
      harnessSlug: slug,
      kinds: ['epoch_gate_skipped'],
    }),
  ).toHaveLength(0);
  cleanups.push(() => handle.close());
  for (let i = 0; i < opCount; i++) {
    await handle.append({
      type: 'put',
      table: 'p019_test_table',
      hbKey: `K-${i}`,
      value: { id: `K-${i}` },
      ts: 1000 + i,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  }
  return handle;
}

describe('produceHeadSnapshotNow (P-019 / D-012)', () => {
  it('appends a head snapshot AT THE TAIL, covering every op written so far', async () => {
    const handle = await bootWithOps('p019-a', 3);
    const lengthBefore = handle.ownLog.length;
    expect(lengthBefore).toBe(3);

    const snap = await handle.produceHeadSnapshotNow();

    expect(snap.appended).toBe(true);
    // `coversUpTo` MUST equal the pre-append length: that is the value
    // computeSparseFrom resolves to, and the only reason a sparse cut can trim.
    expect(snap.coversUpTo).toBe(lengthBefore);
    expect(snap.chunkCount).toBeGreaterThanOrEqual(1);
    expect(handle.ownLog.length).toBe(lengthBefore + snap.chunkCount);

    // The snapshot is really ON the log at the tail, not merely reported.
    expect(await findLatestSnapshotIndex(handle.ownLog)).toBe(lengthBefore);
    const tailOp = await handle.ownLog.get(lengthBefore);
    expect(isSnapshotOp(tailOp)).toBe(true);
  });

  it('runs with the SUBSTRATE_LOG_SNAPSHOT producer flag forced OFF — the request is not rationed by it', async () => {
    // The producer flag defaults ON since p2p-join-catchup-speed P-005, so force it OFF
    // here (env override precedes the default; the flag is read once at boot). If this
    // request were gated on it, a box running with the producer switched off would lose
    // the no-outage cut — strictly weaker than the outage-taking one it replaces, for no
    // new exposure, since the QUIESCED cut path already calls produceLogSnapshot
    // unconditionally (cut-seed-cli refreshCorestoreStateForSeed).
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
    const prior = process.env[FLAG_ENV];
    process.env[FLAG_ENV] = '0';
    cleanups.push(() => {
      if (prior === undefined) delete process.env[FLAG_ENV];
      else process.env[FLAG_ENV] = prior;
    });
    const handle = await bootWithOps('p019-b', 2);
    const snap = await handle.produceHeadSnapshotNow();
    expect(snap.appended).toBe(true);
    expect(snap.coversUpTo).toBe(2);
  });

  it('an empty own log reports appended:false rather than writing a degenerate snapshot', async () => {
    const handle = await bootWithOps('p019-c', 0);
    const snap = await handle.produceHeadSnapshotNow();
    expect(snap.appended).toBe(false);
    expect(handle.ownLog.length).toBe(0);
  });

  it('CONCURRENT callers coalesce onto ONE snapshot — neither waiter is orphaned', async () => {
    // The failure this pins: a request channel that just assigns `pending = {...}`
    // lets a second caller overwrite the first waiter, whose promise then never
    // settles. Under a release cut that is an indefinite hang, not an error.
    const handle = await bootWithOps('p019-d', 4);
    const lengthBefore = handle.ownLog.length;

    const [a, b] = await Promise.all([
      handle.produceHeadSnapshotNow(),
      handle.produceHeadSnapshotNow(),
    ]);

    expect(a).toEqual(b);
    expect(a.coversUpTo).toBe(lengthBefore);
    // ONE snapshot set landed, not two — the O(history) read was paid once.
    expect(handle.ownLog.length).toBe(lengthBefore + a.chunkCount);
  });

  it('a SECOND request after the first completes produces a NEW snapshot (coalescing is per-flight, not once-ever)', async () => {
    const handle = await bootWithOps('p019-e', 2);
    const first = await handle.produceHeadSnapshotNow();
    await handle.append({
      type: 'put',
      table: 'p019_test_table',
      hbKey: 'K-later',
      value: { id: 'K-later' },
      ts: 9999,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    const second = await handle.produceHeadSnapshotNow();
    expect(second.coversUpTo).toBeGreaterThan(first.coversUpTo);
    expect(await findLatestSnapshotIndex(handle.ownLog)).toBe(second.coversUpTo);
  });

  it('REJECTS on a stopped engine instead of hanging forever', async () => {
    // mergeNow() short-circuits to 0 once stopped, so an armed request would never be
    // serviced. A cut awaiting it would wait out its whole budget for no reason.
    const handle = await bootWithOps('p019-f', 1);
    await handle.close();
    await expect(handle.produceHeadSnapshotNow()).rejects.toThrow(/stopped|closing/i);
  });
});
