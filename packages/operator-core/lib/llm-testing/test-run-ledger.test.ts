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

import { llmScenarioLedgerRow, scenarioLedgerPath } from './test-run-ledger';

function run(status: 'passed' | 'failed' | 'errored', startIso: string, endIso: string) {
  return { status, summary: { startedAt: new Date(startIso), finishedAt: new Date(endIso) } };
}

function report(runs: ReturnType<typeof run>[]) {
  return { scenarioId: 'su-S01-harness-scope', verdict: 'preview', runs, varianceByAxis: {}, varianceFindings: [] } as never;
}

const ctx = {
  root: '/repo',
  filePath: 'packages/operator-core/lib/llm-testing/scenarios/su/S01-harness-scope.ts',
  runGroupId: 'g1',
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
    expect(parsed).toMatchObject({ passed: 2, failed: 0, skipped: 0, filePath: ctx.filePath, commitSha: 'abc123', worktreeDirty: false });
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
