import { describe, it, expect } from 'vitest';
import { buildFairnessAudit, formatFairnessAuditMarkdown } from './fairness-audit';
import type { TaskRunResult, ArmId, BenchSuite, GraderStatus } from './schema';

let seq = 0;
function mk(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 't1',
    arm: 'vanilla',
    seed: 0,
    resolved: false,
    graderStatus: 'failed',
    graderFamily: 'swe-bench-pro',
    graderVersion: 'swe-bench-pro@v1',
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    costUsd: 1,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 5,
    budgetTokens: 2_000_000,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: `ro${seq++}`,
    createdAt: '2026-06-15T00:00:00Z',
    ...over,
  };
}

function task(taskId: string, arm: ArmId, resolved: boolean, seed: number, over: Partial<TaskRunResult> = {}): TaskRunResult {
  return mk({ taskId, arm, resolved, seed, graderStatus: (resolved ? 'passed' : 'failed') as GraderStatus, ...over });
}

/** A clean, fair 2-arm × 3-task × 2-seed run (the all-PASS template). */
function fairRun(): TaskRunResult[] {
  const rows: TaskRunResult[] = [];
  for (const arm of ['vanilla', 'hive'] as ArmId[]) {
    for (const t of ['t1', 't2', 't3']) {
      for (const seed of [0, 1]) rows.push(task(t, arm, arm === 'hive', seed));
    }
  }
  return rows;
}

describe('buildFairnessAudit', () => {
  it('passes C1/C3/C6/C8 for a clean same-set, iso-budget, ≥2-seed, full-coverage run', () => {
    const audit = buildFairnessAudit(fairRun());
    const by = Object.fromEntries(audit.criteria.map((c) => [c.id, c.status]));
    expect(by.C1).toBe('PASS'); // same 3 tasks both arms
    expect(by.C3).toBe('PASS'); // shared 2M budget
    expect(by.C6).toBe('PASS'); // no non-completions
    expect(by.C8).toBe('PASS'); // 2 seeds
    // manual criteria are flagged, not silently passed → not all-clear
    expect(by.C2).toBe('NEEDS-EVIDENCE'); // config model consistent, telemetry manual
    expect(by.C5).toBe('NEEDS-EVIDENCE');
    expect(by.C4).toBe('NEEDS-EVIDENCE');
    expect(by.C7).toBe('NEEDS-EVIDENCE');
    expect(by.C9).toBe('N/A'); // no reference arm
    expect(by.C10).toBe('PASS');
    expect(audit.allClear).toBe(false); // manual criteria still owe evidence
    expect(audit.unionTasks).toBe(3);
  });

  it('FAILS C2 on mixed models and C5 on mixed graders', () => {
    const rows = [
      task('t1', 'vanilla', false, 0),
      task('t1', 'hive', true, 0, { modelId: 'claude-opus-4-6', graderVersion: 'swe-bench-pro@v2' }),
    ];
    const by = Object.fromEntries(buildFairnessAudit(rows).criteria.map((c) => [c.id, c.status]));
    expect(by.C2).toBe('FAIL'); // opus-4-8 vs opus-4-6
    expect(by.C5).toBe('FAIL'); // v1 vs v2
  });

  it('WARNs C3 when budgets differ (not iso-budget) and discloses $/task + calls/task', () => {
    const rows = [
      task('t1', 'vanilla', false, 0, { budgetTokens: 1_000_000, costUsd: 1, turns: 5 }),
      task('t1', 'hive', true, 0, { budgetTokens: 4_000_000, costUsd: 5, turns: 20 }),
    ];
    const audit = buildFairnessAudit(rows);
    const c3 = audit.criteria.find((c) => c.id === 'C3')!;
    expect(c3.status).toBe('WARN');
    expect(c3.evidence).toMatch(/\$5\.00\/task/);
    expect(c3.evidence).toMatch(/20\.0 calls\/task/);
  });

  it('WARNs C6 + flags ASYMMETRY when one arm has infra non-completions (counted false)', () => {
    const rows = [
      task('t1', 'vanilla', true, 0),
      task('t2', 'vanilla', true, 0),
      task('t1', 'hive', true, 0),
      // hive INFRA-FAILS t2 (no scored row) → a non-completed task, asymmetric vs vanilla
      mk({ taskId: 't2', arm: 'hive', generationStatus: 'error', resolved: null }),
    ];
    const audit = buildFairnessAudit(rows);
    const c6 = audit.criteria.find((c) => c.id === 'C6')!;
    expect(c6.status).toBe('WARN');
    expect(c6.evidence).toMatch(/ASYMMETRIC/);
    const hive = audit.perArm.find((a) => a.arm === 'hive')!;
    expect(hive.nonCompletedTasks).toBe(1);
    expect(hive.infraRows).toBe(1);
  });

  it('WARNs C8 on a single-seed run', () => {
    const rows = [task('t1', 'vanilla', false, 0), task('t1', 'hive', true, 0)];
    const by = Object.fromEntries(buildFairnessAudit(rows).criteria.map((c) => [c.id, c.status]));
    expect(by.C8).toBe('WARN'); // 1 seed
  });

  it('C9 NEEDS-EVIDENCE when a reference arm is named, N/A otherwise', () => {
    const rows = [task('t1', 'vanilla', false, 0), task('t1', 'baseline-b-native', false, 0)];
    expect(buildFairnessAudit(rows).criteria.find((c) => c.id === 'C9')!.status).toBe('N/A');
    expect(buildFairnessAudit(rows, { referenceArm: 'baseline-b-native' }).criteria.find((c) => c.id === 'C9')!.status).toBe('NEEDS-EVIDENCE');
  });

  it('throws on empty rows', () => {
    expect(() => buildFairnessAudit([])).toThrow(/no rows/);
  });
});

describe('formatFairnessAuditMarkdown', () => {
  it('renders the C1-C10 table, verdict, and per-arm coverage', () => {
    const md = formatFairnessAuditMarkdown(buildFairnessAudit(fairRun()));
    expect(md).toContain('## Fairness audit — swe-bench-pro run `run1`');
    expect(md).toContain('| C1 |');
    expect(md).toContain('| C10 |');
    expect(md).toContain('NOT all clear'); // manual criteria owe evidence
    expect(md).toContain('### Per-arm coverage + compute');
    expect(md).toContain('| `hive` |');
  });
});
