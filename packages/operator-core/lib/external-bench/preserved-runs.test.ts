/**
 * Unit tests for the preserved external-bench run reader (Evaluation
 * "Preserved runs" surface). Covers the heart of the surface — the grade-map →
 * perTask `resolved` merge + the summary rollup — against an on-disk fixture
 * that mirrors the real `m3-realqueen-2026-06-16` shape (11 tasks, 6 resolved).
 * No DB, no network; just the disk read + the pure merge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSafeRunId,
  listPreservedRuns,
  mergeResolved,
  readGradeMap,
  readPreservedRun,
  resolveArmFile,
  summarizePreservedRun,
  type PreservedArmRun,
} from './preserved-runs';

const RUN_ID = 'm3-realqueen-2026-06-16';
const ARM = 'hive-realqueen';

// 11 instances; the 6 resolved=true matching the README's 6/11.
const RESOLVED_TRUE = [
  'instance_NodeBB__NodeBB-x',
  'instance_ansible__ansible-x',
  'instance_navidrome__navidrome-x',
  'instance_gravitational__teleport-x',
  'instance_qutebrowser__qutebrowser-x',
  'instance_protonmail__webclients-x',
];
const RESOLVED_FALSE = [
  'instance_element-hq__element-web-x',
  'instance_internetarchive__openlibrary-x',
  'instance_future-architect__vuls-x',
  'instance_flipt-io__flipt-x',
  'instance_tutao__tutanota-x',
];
const ALL = [...RESOLVED_TRUE, ...RESOLVED_FALSE];

function fixtureRun(): PreservedArmRun {
  return {
    arm: ARM,
    runId: 'xbench-recover-hive-realqueen-1',
    startedAt: '2026-06-16T04:47:56.836Z',
    wallMs: 0,
    peakConcurrentBees: 0,
    taskCount: 11,
    nonEmptyDiffs: 8,
    totals: { costUsd: 33.97, tokensIn: 19727, tokensOut: 250219 },
    perTask: ALL.map((instanceId, i) => ({
      instanceId,
      beeId: `s-${i}`,
      disposition: 'spawn',
      // flipt + vuls produced empty diffs (no-diff → cost 0).
      stopReason: instanceId.includes('flipt') || instanceId.includes('vuls') ? 'no-diff' : 'done',
      tokensIn: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 3000 + i,
      tokensOut: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 30000 + i,
      costUsd: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 4 + i * 0.1,
      turns: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 1,
      wallClockMs: 0,
      diffBytes: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 3000 + i,
    })),
    coordEvents: [
      { ts: 1, kind: 'placement', agent: 's-0', taskId: ALL[0], detail: 'placed' },
      { ts: 2, kind: 'rework', agent: 's-1', taskId: ALL[1] },
      { ts: 3, kind: 'rework', agent: 's-2', taskId: ALL[2] },
      { ts: 4, kind: 'stranded_item', agent: 's-3', taskId: ALL[3] },
      { ts: 5, kind: 'complete', agent: 's-0', taskId: ALL[0] },
    ],
    recovered: true,
  };
}

function gradeMap(): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const id of RESOLVED_TRUE) m[id] = true;
  for (const id of RESOLVED_FALSE) m[id] = false;
  return m;
}

// ── Pure merge + summary (no disk) ──────────────────────────────────────────

describe('mergeResolved', () => {
  it('joins the grade verdict onto each perTask row by instanceId', () => {
    const merged = mergeResolved(fixtureRun().perTask!, gradeMap());
    expect(merged).toHaveLength(11);
    const byId = new Map(merged.map((r) => [r.instanceId, r.resolved]));
    expect(byId.get(RESOLVED_TRUE[0])).toBe(true);
    expect(byId.get(RESOLVED_FALSE[0])).toBe(false);
  });

  it('marks resolved=null (not false) when the grade map has no entry for the row', () => {
    const partial = { [RESOLVED_TRUE[0]]: true };
    const merged = mergeResolved(fixtureRun().perTask!, partial);
    expect(merged.find((r) => r.instanceId === RESOLVED_TRUE[0])!.resolved).toBe(true);
    // Every other row is ungraded → null, NOT a silent false.
    expect(merged.filter((r) => r.resolved === null)).toHaveLength(10);
    expect(merged.filter((r) => r.resolved === false)).toHaveLength(0);
  });

  it('marks every row null when there is no grade map', () => {
    const merged = mergeResolved(fixtureRun().perTask!, null);
    expect(merged.every((r) => r.resolved === null)).toBe(true);
  });
});

describe('summarizePreservedRun', () => {
  it('counts 6 resolved of 11 graded = 54.5%', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.gradedCount).toBe(11);
    expect(s.resolvedCount).toBe(6);
    expect(s.taskCount).toBe(11);
    expect(s.resolvedPct).toBeCloseTo(6 / 11, 5);
  });

  it('prefers the snapshot totals over summing perTask', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.costUsd).toBe(33.97);
    expect(s.tokensIn).toBe(19727);
    expect(s.tokensOut).toBe(250219);
  });

  it('sums perTask cost when the snapshot has no totals', () => {
    const run = { ...fixtureRun(), totals: undefined };
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    const expected = merged.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    expect(s.costUsd).toBeCloseTo(expected, 5);
  });

  it('carries coordEvent count, recovered flag and nonEmptyDiffs through', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.coordEventCount).toBe(5);
    expect(s.recovered).toBe(true);
    expect(s.nonEmptyDiffs).toBe(8);
  });

  it('resolvedPct is null when nothing is graded', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, null);
    expect(summarizePreservedRun(run, merged).resolvedPct).toBeNull();
  });
});

describe('isSafeRunId', () => {
  it('accepts plain run ids', () => {
    expect(isSafeRunId('m3-realqueen-2026-06-16')).toBe(true);
    expect(isSafeRunId('run_1.2')).toBe(true);
  });
  it('rejects traversal / separators', () => {
    for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '/abs', 'a b']) {
      expect(isSafeRunId(bad)).toBe(false);
    }
  });
});

// ── Disk read against a fixture dir ─────────────────────────────────────────

describe('disk read', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'preserved-runs-'));
    const dir = join(base, RUN_ID);
    mkdirSync(join(dir, `grade-${ARM}`, 'out'), { recursive: true });
    writeFileSync(join(dir, `${ARM}.json`), JSON.stringify(fixtureRun()));
    writeFileSync(join(dir, `grade-${ARM}`, 'out', 'eval_results.json'), JSON.stringify(gradeMap()));
    // Sibling artifacts the resolver must ignore.
    writeFileSync(join(dir, 'README.md'), '# run');
    writeFileSync(join(dir, 'tasks-sample.jsonl'), '{}');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('resolveArmFile picks the single arm json, ignoring siblings', () => {
    expect(resolveArmFile(join(base, RUN_ID))).toBe(ARM);
  });

  it('listPreservedRuns finds the run with its arm', () => {
    const runs = listPreservedRuns(base);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: RUN_ID, arm: ARM });
  });

  it('readGradeMap reads the verdict map', () => {
    const g = readGradeMap(join(base, RUN_ID), ARM);
    expect(g?.[RESOLVED_TRUE[0]]).toBe(true);
    expect(Object.values(g ?? {}).filter(Boolean)).toHaveLength(6);
  });

  it('readPreservedRun merges + summarizes the whole run', () => {
    const detail = readPreservedRun(RUN_ID, base);
    expect(detail).not.toBeNull();
    expect(detail!.summary.resolvedCount).toBe(6);
    expect(detail!.summary.taskCount).toBe(11);
    expect(detail!.perTask.filter((t) => t.resolved === true)).toHaveLength(6);
    // coordRates derived from the trace (1 rework on s-1, 1 on s-2, 1 stranded).
    expect(detail!.coordRates.counts.redundant).toBe(2);
    expect(detail!.coordRates.counts.breakdown).toBe(1);
  });

  it('returns null for a missing / unsafe run id', () => {
    expect(readPreservedRun('nope', base)).toBeNull();
    expect(readPreservedRun('../etc', base)).toBeNull();
  });

  it('returns [] when the base dir does not exist', () => {
    expect(listPreservedRuns(join(base, 'does-not-exist'))).toEqual([]);
  });
});
