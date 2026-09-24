/**
 * p2p-join-catchup-speed-2026-09-23 P-003, bar R-7 — producing a snapshot never
 * stalls merging.
 *
 * The periodic own-log compaction used to be AWAITED inside the serialized merge
 * pass, so its full-history read (7.75M ops on the tower's papercusp pot) held the
 * merge gate for its whole duration. These tests stall that read on purpose and
 * prove the merge loop keeps completing passes, that only one compaction runs at a
 * time, that the stalled compaction still lands a findable set once released, and
 * that closing the engine mid-compaction neither hangs nor appends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate } from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { findLatestCompleteSnapshot } from '../read-merge';
import {
  _resetBootHistoryForTests,
  _setMirrorForTests,
  _setPgWriteForTests,
  listBootHistory,
} from '../boot-history';
import {
  formatSnapshotFoldProgress,
  SNAPSHOT_COMPACT_EVERY_OPS,
  SNAPSHOT_READ_CONCURRENCY,
  throttleSnapshotFoldProgress,
} from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';

const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
const WS = 'ws-p003-offgate';

const cleanups: Array<() => void | Promise<void>> = [];
let priorFlag: string | undefined;
beforeEach(() => {
  priorFlag = process.env[FLAG_ENV];
  process.env[FLAG_ENV] = '1'; // the periodic producer is read once at boot
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (priorFlag === undefined) delete process.env[FLAG_ENV];
  else process.env[FLAG_ENV] = priorFlag;
});

function tmpWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p003-offgate-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return dir;
}

async function boot(slug: string, extra: { ownCompactionProgressIntervalMs?: number } = {}) {
  const handle = await bootHarnessSubstrate({
    workspaceRoot: tmpWorkspaceRoot(),
    workspaceId: WS,
    harnessSlug: slug,
    mergePollMs: 0, // drive mergeNow by hand
    loadRevokedOverride: async () => new Set(),
    applyOverride: async () => true,
    rekeyDepsOverride: null,
    ...extra,
  });
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await handle.close();
  });
  return {
    handle,
    markClosed: () => {
      closed = true;
    },
  };
}

async function appendOps(handle: Awaited<ReturnType<typeof boot>>['handle'], from: number, count: number) {
  for (let i = from; i < from + count; i++) {
    await handle.append({
      type: 'put',
      table: 'p003_test_table',
      hbKey: `K-${i % 50}`,
      value: { id: i },
      ts: 1_000 + i,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  }
}

/**
 * Hold every read of an own-log index BELOW `below` until released. The merge cursor
 * is already past those indices, so only the compaction's history fold waits on it.
 */
function gateHistoryReads(
  log: { get(i: number): Promise<PeerLogOp | null>; getRaw?(i: number): Promise<Uint8Array | null> },
  below: number,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let blockedReads = 0;
  const hold = async <T>(i: number, read: (i: number) => Promise<T>): Promise<T> => {
    if (i < below) {
      blockedReads++;
      await gate;
    }
    return read(i);
  };
  const originalGet = log.get.bind(log);
  log.get = (i: number) => hold(i, originalGet);
  // WI-10002855: the compaction now reads RAW blocks (`getRaw`) and folds them in a
  // worker thread, so its history reads go through getRaw — gate that path too.
  if (log.getRaw) {
    const originalGetRaw = log.getRaw.bind(log);
    log.getRaw = (i: number) => hold(i, originalGetRaw);
  }
  return { release, blockedReads: () => blockedReads };
}

/** Compaction OUTCOMES only (appended / failed) — not the boot anchor or the start rows. */
function compactionEvents(slug: string) {
  return listBootHistory({ workspaceId: WS, harnessSlug: slug, kinds: ['own_log_compaction'] }).filter((e) =>
    /^own log compaction: |^log compaction failed/.test(e.message ?? ''),
  );
}

async function waitFor<T>(probe: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('own-log compaction runs off the merge gate (P-003 / R-7)', () => {
  it('merge passes keep completing while the compaction read is stalled; one compaction at a time', async () => {
    const slug = 'p003-offgate-a';
    const { handle } = await boot(slug);
    const warm = SNAPSHOT_COMPACT_EVERY_OPS - 1;
    await appendOps(handle, 0, warm);
    await handle.mergeNow(); // below the threshold: merges, no compaction
    expect(compactionEvents(slug)).toHaveLength(0);

    const gate = gateHistoryReads(handle.ownLog, warm);
    await appendOps(handle, warm, 1); // reaches the threshold
    await handle.mergeNow(); // kicks the compaction off and RETURNS
    await waitFor(() => gate.blockedReads() > 0); // the compaction is inside its fold

    // The gate is still closed, so the compaction cannot have finished — yet merging goes on.
    await appendOps(handle, warm + 1, 5);
    await handle.mergeNow();
    await appendOps(handle, warm + 6, 5);
    await handle.mergeNow();
    expect(await findLatestCompleteSnapshot(handle.ownLog)).toBeNull();
    expect(compactionEvents(slug)).toHaveLength(0);

    gate.release();
    const seed = await waitFor(() => findLatestCompleteSnapshot(handle.ownLog));
    // It re-anchored to the ops merged while it was reading (WI-37526 convergence).
    expect(seed.coversUpTo).toBe(warm + 11);
    const events = await waitFor(() => (compactionEvents(slug).length > 0 ? compactionEvents(slug) : null));
    expect(events).toHaveLength(1); // the in-flight guard: the extra passes started no second compaction
    expect(events[0]!.message).toMatch(/own log compaction: .*mergeGateHeld=false/);
  });

  it('close() mid-compaction resolves, appends nothing and records no failure', async () => {
    const slug = 'p003-offgate-b';
    const { handle, markClosed } = await boot(slug);
    const warm = SNAPSHOT_COMPACT_EVERY_OPS - 1;
    await appendOps(handle, 0, warm);
    await handle.mergeNow();
    const gate = gateHistoryReads(handle.ownLog, warm);
    await appendOps(handle, warm, 1);
    await handle.mergeNow();
    await waitFor(() => gate.blockedReads() > 0);

    const closing = handle.close();
    markClosed();
    gate.release();
    await closing;
    expect(compactionEvents(slug)).toHaveLength(0);
  });
});

describe('own-log compaction is observable after the fact (P-005)', () => {
  afterEach(() => {
    _resetBootHistoryForTests();
  });

  it('records the boot anchor, the start and the outcome under own_log_compaction, all durably mirrored', async () => {
    // The failure this pins: the lifecycle used to be recorded as 'peer_capped', which
    // is neither stdout- nor PG-mirrored, so on the tower nobody could tell whether a
    // compaction ever ran or how long its full-history read took.
    const pgRows: Array<{ kind: string; message?: string; harnessSlug: string }> = [];
    const stdout: string[] = [];
    _setPgWriteForTests((entry) => pgRows.push(entry));
    _setMirrorForTests((line) => stdout.push(line));

    const slug = 'p005-observable';
    const { handle } = await boot(slug);
    await appendOps(handle, 0, SNAPSHOT_COMPACT_EVERY_OPS);
    await handle.mergeNow();
    await waitFor(() => findLatestCompleteSnapshot(handle.ownLog));
    await waitFor(() => (compactionEvents(slug).length > 0 ? true : null));

    const mine = pgRows.filter((r) => r.harnessSlug === slug && r.kind === 'own_log_compaction');
    const messages = mine.map((r) => r.message ?? '');
    expect(messages[0]).toMatch(
      /^own log compaction anchor: producer=on ownLogLength=0 lastCoversUpTo=0 lastRows=0 threshold=1000 due=false$/,
    );
    expect(messages.some((m) => /^own log compaction started: ownLogLength=1000 lastCoversUpTo=0 threshold=1000 /.test(m))).toBe(true);
    expect(messages.some((m) => /^own log compaction: coversUpTo=1000 .*elapsedMs=\d+ mergeGateHeld=false$/.test(m))).toBe(true);
    // stdout mirror carries the same rows (the journal is the other durable surface).
    expect(stdout.filter((l) => l.includes(slug) && l.includes('own_log_compaction')).length).toBe(mine.length);
    // Default cadence: a fold this short finishes inside one interval and adds no progress rows.
    expect(messages.some((m) => m.startsWith('own log compaction progress:'))).toBe(false);
  });

  it('reports the fold position while a compaction is running, not only when it ends (WI-10002836)', async () => {
    // The failure this pins: the tower's first papercusp compaction folded 7.76M ops for
    // 30+ minutes, and nothing between its start row and its outcome row showed whether
    // it was moving or hung. The progress row must land WHILE the fold is still open.
    const pgRows: Array<{ kind: string; message?: string; harnessSlug: string }> = [];
    _setPgWriteForTests((entry) => pgRows.push(entry));

    const slug = 'p005-progress';
    const { handle } = await boot(slug, { ownCompactionProgressIntervalMs: 0 });
    // More than one read window, so the fold reports more than once before it ends.
    const ops = SNAPSHOT_COMPACT_EVERY_OPS + SNAPSHOT_READ_CONCURRENCY;
    await appendOps(handle, 0, ops);
    await handle.mergeNow();
    await waitFor(() => (compactionEvents(slug).length > 0 ? true : null));

    const mine = pgRows.filter((r) => r.harnessSlug === slug && r.kind === 'own_log_compaction');
    const outcomeAt = mine.findIndex((r) => /^own log compaction: coversUpTo=/.test(r.message ?? ''));
    const startedAt = mine.findIndex((r) => /^own log compaction started: /.test(r.message ?? ''));
    const progressAt = mine
      .map((r, i) => (/^own log compaction progress: /.test(r.message ?? '') ? i : -1))
      .filter((i) => i >= 0);
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(outcomeAt).toBeGreaterThan(startedAt);
    expect(progressAt.length).toBeGreaterThanOrEqual(2);
    // Every progress row is written between the start row and the outcome row, i.e. WHILE folding.
    for (const i of progressAt) {
      expect(i).toBeGreaterThan(startedAt);
      expect(i).toBeLessThan(outcomeAt);
    }
    const progress = progressAt.map((i) => mine[i]!.message ?? '');
    expect(progress[0]).toMatch(
      /^own log compaction progress: cursor=\d+\/\d+ \(\d+%\) sourceStart=0 decodedOps=\d+ decodedBytes=\d+ heapUsedMb=\d+ elapsedMs=\d+$/,
    );
    const cursors = progress.map((m) => Number(/cursor=(\d+)\//.exec(m)![1]));
    // Monotonic: the anchor-convergence re-fold never reports a position behind an earlier one.
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors[cursors.length - 1]).toBe(ops);
  });
});

describe('throttleSnapshotFoldProgress (WI-10002836)', () => {
  const at = (processed: number, total = 100) => ({
    phase: 'own-compaction',
    sourceStart: 0,
    sourceEnd: total,
    processed,
    total,
    decodedOps: processed,
    decodedBytes: processed * 10,
  });

  it('emits at most once per interval, measured from creation, and never on a short fold', () => {
    let clock = 1_000;
    const seen: number[] = [];
    const report = throttleSnapshotFoldProgress((p) => seen.push(p.processed), {
      minIntervalMs: 60_000,
      now: () => clock,
    });
    report(at(10));
    clock += 59_999;
    report(at(20));
    expect(seen).toEqual([]); // a fold that ends inside one interval emits nothing
    clock += 1;
    report(at(30));
    clock += 30_000;
    report(at(40));
    clock += 30_000;
    report(at(50));
    expect(seen).toEqual([30, 50]);
  });

  it('drops repeated and backwards positions so the reported cursor stays monotonic', () => {
    let clock = 0;
    const seen: number[] = [];
    const report = throttleSnapshotFoldProgress((p) => seen.push(p.processed), { minIntervalMs: 0, now: () => clock });
    for (const n of [5, 5, 3, 8, 7, 9]) {
      clock += 1;
      report(at(n));
    }
    expect(seen).toEqual([5, 8, 9]);
  });

  it('formats a bounded one-line position', () => {
    expect(formatSnapshotFoldProgress(at(25, 200))).toBe(
      'cursor=25/200 (12%) sourceStart=0 decodedOps=25 decodedBytes=250',
    );
    expect(formatSnapshotFoldProgress(at(0, 0))).toContain('(100%)');
  });
});
