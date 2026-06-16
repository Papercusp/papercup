/**
 * Unit tests for the per-task-idempotent fleet-arm snapshot writer (benchmark-fairness-fix, Priority 2).
 *
 * The bug: an isolated `XBENCH_ONLY_IID` rerun (re-run EXACTLY one task) overwrote the whole `<arm>.json`
 * snapshot with just that one task, CLOBBERING every sibling's already-collected result. The fix
 * read-modify-writes by `instanceId` (mirroring run_minisweagent.py:update_preds + the PG
 * upsertBenchRunTask idempotency). Covers the pure merge + the on-disk read-modify-write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeArmSnapshot,
  readArmSnapshot,
  writeArmSnapshotMerged,
  type ArmSnapshot,
  type ArmSnapshotPerTask,
} from './arm-snapshot';

function task(instanceId: string, over: Partial<ArmSnapshotPerTask> = {}): ArmSnapshotPerTask {
  return {
    instanceId,
    beeId: `bee-${instanceId}`,
    disposition: 'spawn',
    stopReason: 'done',
    generationError: null,
    tokensIn: 1000,
    tokensOut: 5000,
    costUsd: 4,
    turns: 3,
    wallClockMs: 60_000,
    diffBytes: 200,
    armMeta: null,
    ...over,
  };
}

function snapshot(arm: string, perTask: ArmSnapshotPerTask[], over: Partial<ArmSnapshot> = {}): ArmSnapshot {
  return {
    arm,
    runId: `run-${arm}`,
    runError: null,
    startedAt: '2026-06-16T00:00:00Z',
    wallMs: 1000,
    peakConcurrentBees: 2,
    taskCount: perTask.length,
    nonEmptyDiffs: perTask.filter((t) => (t.diffBytes ?? 0) > 0).length,
    totals: { costUsd: 0, tokensIn: 0, tokensOut: 0 },
    perTask,
    coordEvents: [],
    ...over,
  };
}

describe('mergeArmSnapshot — per-task idempotent merge', () => {
  it('a per-task RERUN merges into the existing snapshot — siblings are NOT clobbered', () => {
    // The original 3-task run.
    const existing = snapshot('su-independent', [task('iid-a'), task('iid-b'), task('iid-c')]);
    // A XBENCH_ONLY_IID rerun of ONLY iid-b, with a better result (was done, now still done w/ more cost).
    const rerun = snapshot('su-independent', [task('iid-b', { costUsd: 9, tokensIn: 2000, diffBytes: 999 })]);

    const merged = mergeArmSnapshot(existing, rerun);

    // All three tasks survive — the rerun did NOT drop iid-a / iid-c.
    expect(merged.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-b', 'iid-c']);
    // iid-b is the rerun's result (incoming wins for re-run instances).
    const b = merged.perTask.find((t) => t.instanceId === 'iid-b')!;
    expect(b.costUsd).toBe(9);
    expect(b.diffBytes).toBe(999);
    // iid-a / iid-c are preserved verbatim from the existing snapshot.
    expect(merged.perTask.find((t) => t.instanceId === 'iid-a')!.costUsd).toBe(4);
  });

  it('recomputes taskCount / totals / nonEmptyDiffs from the MERGED set (not the rerun-of-one)', () => {
    const existing = snapshot('su-independent', [
      task('iid-a', { costUsd: 4, tokensIn: 1000, tokensOut: 5000, diffBytes: 200 }),
      task('iid-b', { costUsd: 0, tokensIn: 0, tokensOut: 0, diffBytes: 0 }), // empty diff
    ]);
    const rerun = snapshot('su-independent', [task('iid-b', { costUsd: 6, tokensIn: 1000, tokensOut: 2000, diffBytes: 50 })]);

    const merged = mergeArmSnapshot(existing, rerun);
    expect(merged.taskCount).toBe(2); // both tasks, NOT 1 from the rerun
    expect(merged.totals).toEqual({ costUsd: 10, tokensIn: 2000, tokensOut: 7000 });
    expect(merged.nonEmptyDiffs).toBe(2); // iid-b now has a non-empty diff after the rerun
  });

  it('adds a NEW instance not present in the existing snapshot', () => {
    const existing = snapshot('su-independent', [task('iid-a')]);
    const incoming = snapshot('su-independent', [task('iid-z')]);
    const merged = mergeArmSnapshot(existing, incoming);
    expect(merged.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-z']);
  });

  it('with no existing snapshot, returns the incoming set as-is (recomputed totals)', () => {
    const incoming = snapshot('su-independent', [task('iid-a', { costUsd: 3 }), task('iid-b', { costUsd: 7 })]);
    const merged = mergeArmSnapshot(null, incoming);
    expect(merged.perTask).toHaveLength(2);
    expect(merged.totals!.costUsd).toBe(10);
  });

  it('takes run-level fields from incoming (latest run is authoritative for the window/trace)', () => {
    const existing = snapshot('hive-realqueen', [task('iid-a')], { runId: 'old', wallMs: 100, peakConcurrentBees: 1 });
    const incoming = snapshot('hive-realqueen', [task('iid-a')], { runId: 'new', wallMs: 999, peakConcurrentBees: 5 });
    const merged = mergeArmSnapshot(existing, incoming);
    expect(merged.runId).toBe('new');
    expect(merged.wallMs).toBe(999);
    expect(merged.peakConcurrentBees).toBe(5);
  });
});

describe('writeArmSnapshotMerged — on-disk read-modify-write', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a first write then a single-task rerun keeps every sibling on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-snap-'));
    const path = join(dir, 'su-independent.json');

    // First full run of 3 tasks.
    writeArmSnapshotMerged(path, snapshot('su-independent', [task('iid-a'), task('iid-b'), task('iid-c')]));
    let onDisk = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;
    expect(onDisk.perTask).toHaveLength(3);

    // XBENCH_ONLY_IID rerun of iid-b only (simulating the launcher re-running one instance).
    writeArmSnapshotMerged(path, snapshot('su-independent', [task('iid-b', { costUsd: 12 })]));
    onDisk = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;

    // The rerun did NOT clobber the file down to one task.
    expect(onDisk.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-b', 'iid-c']);
    expect(onDisk.perTask.find((t) => t.instanceId === 'iid-b')!.costUsd).toBe(12);
  });

  it('readArmSnapshot returns null for a missing or malformed file', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-snap-'));
    expect(readArmSnapshot(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json', 'utf8');
    expect(readArmSnapshot(bad)).toBeNull();
    const noPerTask = join(dir, 'nopertask.json');
    writeFileSync(noPerTask, JSON.stringify({ arm: 'x' }), 'utf8');
    expect(readArmSnapshot(noPerTask)).toBeNull();
  });
});
