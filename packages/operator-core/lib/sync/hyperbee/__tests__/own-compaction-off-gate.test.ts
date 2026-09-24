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
import { SNAPSHOT_COMPACT_EVERY_OPS } from '../log-snapshot';
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

async function boot(slug: string) {
  const handle = await bootHarnessSubstrate({
    workspaceRoot: tmpWorkspaceRoot(),
    workspaceId: WS,
    harnessSlug: slug,
    mergePollMs: 0, // drive mergeNow by hand
    loadRevokedOverride: async () => new Set(),
    applyOverride: async () => true,
    rekeyDepsOverride: null,
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
function gateHistoryReads(log: { get(i: number): Promise<PeerLogOp | null> }, below: number) {
  const original = log.get.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let blockedReads = 0;
  log.get = async (i: number) => {
    if (i < below) {
      blockedReads++;
      await gate;
    }
    return original(i);
  };
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
  });
});
