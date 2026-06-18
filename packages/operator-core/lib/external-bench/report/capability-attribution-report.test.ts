import { describe, it, expect } from 'vitest';
import type { TaskRunResult, ArmId, BenchSuite, GraderStatus } from '@papercusp/bench-metrics';
import { buildRunCapabilityAttribution, formatRunAttributionMarkdown, type RunResultReader } from './capability-attribution-report';

let seq = 0;
function row(suite: BenchSuite, taskId: string, arm: ArmId, resolved: boolean): TaskRunResult {
  return {
    runId: 'run-X',
    suite,
    modality: 'interactive',
    taskId,
    arm,
    seed: seq++,
    resolved,
    graderStatus: (resolved ? 'passed' : 'failed') as GraderStatus,
    graderFamily: 'fam',
    graderVersion: 'v1',
    tokensIn: 1_000_000,
    tokensOut: 0,
    tokensTotal: 1_000_000,
    costUsd: 5,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 1,
    budgetTokens: null,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: `ro-${seq}`,
    createdAt: '2026-06-17T00:00:00Z',
  };
}

function fakeReader(rows: TaskRunResult[]): RunResultReader {
  return async () => rows;
}

describe('buildRunCapabilityAttribution', () => {
  it('attributes every suite that has the control arm and rolls them up', async () => {
    const rows = [
      // tau2-bench: vanilla 0/2, +memory 2/2
      row('tau2-bench', 't1', 'vanilla', false),
      row('tau2-bench', 't2', 'vanilla', false),
      row('tau2-bench', 't1', '+memory', true),
      row('tau2-bench', 't2', '+memory', true),
      // swarmbench: vanilla 0/2, +coord 2/2
      row('swarmbench', 's1', 'vanilla', false),
      row('swarmbench', 's2', 'vanilla', false),
      row('swarmbench', 's1', '+coord', true),
      row('swarmbench', 's2', '+coord', true),
    ];
    const res = await buildRunCapabilityAttribution('run-X', { reader: fakeReader(rows) });
    expect(res).not.toBeNull();
    expect(res!.runId).toBe('run-X');
    expect(res!.control).toBe('vanilla');
    expect(res!.perSuite.map((s) => s.suite)).toEqual(['tau2-bench', 'swarmbench']);
    expect(res!.skippedSuites).toEqual([]);

    // a fairness audit per suite (binding pre-claim table)
    expect(res!.audits.map((a) => a.suite)).toEqual(['tau2-bench', 'swarmbench']);
    expect(res!.audits[0].criteria.find((c) => c.id === 'C1')).toBeDefined();

    // cross-suite roll-up has one cell per (suite, capability)
    expect(res!.crossSuite.cells).toHaveLength(2);
    const mem = res!.crossSuite.rollup.find((r) => r.capability === '+memory')!;
    expect(mem.suites).toBe(1);
    expect(mem.meanValueDelta).toBeCloseTo(1, 6);
    const coord = res!.crossSuite.rollup.find((r) => r.capability === '+coord')!;
    expect(coord.suites).toBe(1);
    expect(coord.totalUnlocked).toBe(2);
  });

  it('skips a suite with no control arm (reason recorded), still attributes the rest', async () => {
    const rows = [
      // a coding suite with NO vanilla control — must be skipped, not throw
      row('swe-bench-pro', 'c1', 'papercusp', true),
      row('swe-bench-pro', 'c1', 'baseline-b-native', false),
      // tau2 has the control → attributed
      row('tau2-bench', 't1', 'vanilla', false),
      row('tau2-bench', 't1', '+memory', true),
    ];
    const res = await buildRunCapabilityAttribution('run-X', { reader: fakeReader(rows) });
    expect(res!.perSuite.map((s) => s.suite)).toEqual(['tau2-bench']);
    expect(res!.skippedSuites).toHaveLength(1);
    expect(res!.skippedSuites[0].suite).toBe('swe-bench-pro');
    expect(res!.skippedSuites[0].reason).toMatch(/control arm "vanilla" has no rows/);
  });

  it('returns null for a run with no rows', async () => {
    const res = await buildRunCapabilityAttribution('nope', { reader: fakeReader([]) });
    expect(res).toBeNull();
  });

  it('honors a non-default control arm via attribution opts', async () => {
    const rows = [
      row('swe-bench-pro', 'c1', 'baseline-b-native', false),
      row('swe-bench-pro', 'c1', 'papercusp', true),
    ];
    const res = await buildRunCapabilityAttribution('run-X', {
      reader: fakeReader(rows),
      attribution: { control: 'baseline-b-native' },
    });
    expect(res!.control).toBe('baseline-b-native');
    expect(res!.perSuite[0].capabilities.map((c) => c.capability)).toEqual(['papercusp']);
    expect(res!.perSuite[0].capabilities[0].valueDelta).toBeCloseTo(1, 6);
  });
});

describe('formatRunAttributionMarkdown', () => {
  it('renders the headline matrix, per-suite lines, skipped suites, and caveats', async () => {
    const rows = [
      row('tau2-bench', 't1', 'vanilla', false),
      row('tau2-bench', 't1', '+memory', true),
      // a suite with no control → skipped, surfaced in the markdown
      row('swe-bench-pro', 'c1', 'papercusp', true),
      row('swe-bench-pro', 'c1', 'baseline-b-native', false),
    ];
    const run = await buildRunCapabilityAttribution('run-X', { reader: fakeReader(rows) });
    const md = formatRunAttributionMarkdown(run!);
    expect(md).toContain('# Capability attribution — run `run-X`');
    expect(md).toContain('Control arm: `vanilla`');
    expect(md).toContain('## Cross-suite headline');
    expect(md).toContain('| `+memory` |'); // rollup row
    expect(md).toContain('### tau2-bench (passAt1)');
    expect(md).toContain('+memory vs vanilla on tau2-bench'); // per-suite line
    expect(md).toContain('## Fairness audits (pre-claim — binding)');
    expect(md).toContain('## Skipped suites');
    expect(md).toContain('`swe-bench-pro`:'); // skipped reason listed
    expect(md).toContain('## Caveats');
    expect(md).toMatch(/PRIMARY = single-capability arms/);
  });

  it('degrades gracefully when no suite has the control arm', async () => {
    const rows = [row('swe-bench-pro', 'c1', 'papercusp', true)];
    const run = await buildRunCapabilityAttribution('run-X', { reader: fakeReader(rows) });
    const md = formatRunAttributionMarkdown(run!);
    expect(md).toContain('_No capability arms attributed');
    expect(md).toContain('## Skipped suites');
  });
});
