/**
 * EI-24434635346407728 — a live llm-test scenario must land in harness_shared.test_runs
 * as an `llm`-layer row that the SAME reader the acceptance-bar layer check uses accepts.
 * Without it, a BAR clause whose requiredTestLayers includes `llm` is unsatisfiable.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseTestRunExecutionDetails, recordedTestLayer } from '@papercusp/test-config/execution-details';

import { SCENARIOS } from './scenarios';
import { llmScenarioLedgerRow, resolveScenarioSourceFile, scenarioLedgerPath } from './test-run-ledger';

const SCENARIOS_ROOT = join(__dirname, 'scenarios');

describe('resolveScenarioSourceFile', () => {
  // Recurrence guard: an id that fails to resolve silently drops the live run's
  // llm-layer ledger row, which strands any BAR clause requiring `llm`
  // (su-S33-agenda-* did exactly this — ten cases, one file).
  it('resolves every registered scenario to its defining source file', () => {
    const unresolved = SCENARIOS.filter(
      (s) => !resolveScenarioSourceFile(s.id, s.target, SCENARIOS_ROOT),
    ).map((s) => `${s.target}:${s.id}`);
    expect(unresolved).toEqual([]);
  });

  it('maps a multi-scenario file by its id token and refuses ambiguity', () => {
    expect(resolveScenarioSourceFile('su-S33-agenda-delegate', 'su', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S33-goal-agenda.ts'),
    );
    expect(resolveScenarioSourceFile('su-S02-tauri-only', 'su', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S02-tauri-only.ts'),
    );
    // One factory, two registering files: each set resolves to the file spelling its ids.
    expect(resolveScenarioSourceFile('su-S37a-absence-claim', 'su-code', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S37-code-search-discipline.ts'),
    );
    expect(resolveScenarioSourceFile('worker-W01c-definition-lookup', 'worker', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'worker', 'W01-code-search-discipline.ts'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'scen-resolve-'));
    try {
      mkdirSync(join(dir, 'su'));
      writeFileSync(join(dir, 'su', 'S40-a.ts'), '');
      writeFileSync(join(dir, 'su', 'S40-b.ts'), '');
      writeFileSync(join(dir, 'su', 'S41-x.test.ts'), '');
      expect(resolveScenarioSourceFile('su-S40-case', 'su', dir)).toBeUndefined();
      expect(resolveScenarioSourceFile('su-S41-case', 'su', dir)).toBeUndefined();
      expect(resolveScenarioSourceFile('su-S99-none', 'nope', dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bare role prefix claims ids only inside the target dir, never across the tree', () => {
    // A fixture builder like `su-${n}` in a helper file once captured su-S37a (target
    // su-code, no su-code dir) and misattributed its llm ledger rows.
    const dir = mkdtempSync(join(tmpdir(), 'scen-resolve-'));
    try {
      mkdirSync(join(dir, 'su'));
      mkdirSync(join(dir, 'papercup'));
      writeFileSync(join(dir, 'su', '_helpers.ts'), 'export const owner = (n: number) => `su-${n}`;\n');
      writeFileSync(join(dir, 'papercup', '_mirror.ts'), 'export const id = (b: string) => `sn-${b}`;\n');
      expect(resolveScenarioSourceFile('su-S50-new-case', 'su-code', dir)).toBeUndefined();
      // Inside its own target dir the role prefix still resolves (mirror-generated ids).
      expect(resolveScenarioSourceFile('sn-S01-mirrored', 'papercup', dir)).toBe(
        join(dir, 'papercup', '_mirror.ts'),
      );
      // A family prefix (role + token) still resolves across the tree.
      writeFileSync(join(dir, 'su', 'S50-family.ts'), 'export const id = (c: string) => `su-S50-${c}`;\n');
      expect(resolveScenarioSourceFile('su-S50-new-case', 'su-code', dir)).toBe(
        join(dir, 'su', 'S50-family.ts'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function run(status: 'passed' | 'failed' | 'errored', startIso: string, endIso: string) {
  return { status, summary: { startedAt: new Date(startIso), finishedAt: new Date(endIso) } };
}

function report(runs: ReturnType<typeof run>[]) {
  return { scenarioId: 'su-S01-harness-scope', verdict: 'preview', runs, varianceByAxis: {}, varianceFindings: [] } as never;
}

const ctx = {
  root: '/repo',
  filePath: 'packages/operator-core/lib/llm-testing/scenarios/su/S01-harness-scope.ts',
  runGroupId: null,
  workspaceId: 'w1',
  harnessSlug: 'papercusp',
  commitSha: 'abc123',
  worktreeDirty: false,
};

describe('llmScenarioLedgerRow', () => {
  it('stamps the llm layer and is accepted by the shared execution-details parser', () => {
    const row = llmScenarioLedgerRow(
      report([run('passed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:10Z'), run('passed', '2026-09-27T00:00:05Z', '2026-09-27T00:00:20Z')]),
      ctx,
    );
    expect(row.status).toBe('pass');
    expect(row.durationMs).toBe(20_000);
    expect(row.outputTail).toBeNull();
    expect(recordedTestLayer(row.executionDetails)).toBe('llm');
    const parsed = parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row.executionDetails)));
    expect(parsed).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      runGroupId: null,
      filePath: ctx.filePath,
      scenarioId: 'su-S01-harness-scope',
      commitSha: 'abc123',
      worktreeDirty: false,
    });
  });

  it('a failed run fails the row; errored runs count as failures, not passes', () => {
    const row = llmScenarioLedgerRow(
      report([run('passed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z'), run('failed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z'), run('errored', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z')]),
      ctx,
    );
    expect(row.status).toBe('fail');
    expect(row.executionDetails).toMatchObject({ passed: 1, failed: 2 });
    expect(row.outputTail).toContain('failed=1 errored=1');
  });

  it('errored-only is an error row, and an empty report measured nothing (skip, never pass)', () => {
    expect(llmScenarioLedgerRow(report([run('errored', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z')]), ctx).status).toBe('error');
    const empty = llmScenarioLedgerRow(report([]), { ...ctx, now: new Date('2026-09-27T01:00:00Z') });
    expect(empty.status).toBe('skip');
    expect(empty.executionDetails.passed).toBe(0);
  });
});

describe('scenarioLedgerPath', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('returns a workspace-relative POSIX path only for a scenario file that exists under the root', () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-ledger-'));
    mkdirSync(join(dir, 'scen'), { recursive: true });
    const file = join(dir, 'scen', 'S01.ts');
    writeFileSync(file, 'export {}');
    expect(scenarioLedgerPath(file, dir)).toBe('scen/S01.ts');
    expect(scenarioLedgerPath(join(dir, 'scen', 'missing.ts'), dir)).toBeNull();
    expect(scenarioLedgerPath(undefined, dir)).toBeNull();
    expect(scenarioLedgerPath(file, join(dir, 'scen', 'nested'))).toBeNull();
  });
});
