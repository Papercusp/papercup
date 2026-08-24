import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPg } from '@papercusp/orchestrator';
import {
  decideWorkerParityGate,
  readWorkerParityRuns,
  type WorkerParityEngine,
  type WorkerParityRun,
} from './worker-parity-gate';

function run(
  engine: WorkerParityEngine,
  i: number,
  overrides: Partial<WorkerParityRun> = {},
): WorkerParityRun {
  return {
    runId: `${engine}-${i}`,
    harnessSlug: 'canary',
    promptHash: `prompt-${i}`,
    featureId: `task-${i}`,
    model: 'claude-sonnet-4-6',
    engine,
    exitCode: 0,
    endedAt: 1_000 + i,
    streamOk: true,
    costUsd: 1,
    costSampleCount: 1,
    pricedSampleCount: 1,
    mcpCalls: 1,
    mcpFailures: 0,
    mcpToolNames: ['capability:read'],
    ...overrides,
  };
}

function paired(n = 20): WorkerParityRun[] {
  return Array.from({ length: n }, (_, i) => [run('omp', i), run('loop', i)]).flat();
}

describe('decideWorkerParityGate', () => {
  it('fails closed on an empty or undersized paired corpus', () => {
    const empty = decideWorkerParityGate([]);
    expect(empty.verdict).toBe('hold');
    expect(empty.workerFlipAllowed).toBe(false);
    expect(empty.reasons).toContain('insufficient same-prompt/same-model pairs: 0/20');

    const small = decideWorkerParityGate(paired(19));
    expect(small.verdict).toBe('hold');
    expect(small.pairedTasks).toBe(19);
  });

  it('turns green only when all four v1 dimensions meet their thresholds', () => {
    const gate = decideWorkerParityGate(paired());
    expect(gate.verdict).toBe('green');
    expect(gate.workerFlipAllowed).toBe(true);
    expect(gate.pairedTasks).toBe(20);
    expect(gate.byEngine.loop.taskSuccessRate).toBe(1);
    expect(gate.byEngine.loop.costPerTaskUsd).toBe(1);
    expect(gate.byEngine.loop.streamFidelityRate).toBe(1);
    expect(gate.byEngine.loop.mcpFailureRate).toBe(0);
    expect(gate.deltas.missingBaselineTools).toEqual([]);
  });

  it('turns red on measured task, cost, stream, and MCP regressions', () => {
    const rows = paired();
    for (const row of rows) {
      if (row.engine !== 'loop') continue;
      row.costUsd = 1.25;
      row.mcpFailures = 1;
      row.mcpToolNames = ['capability:write'];
      if (Number(row.runId.split('-')[1]) < 4) row.exitCode = 1;
    }
    rows.find((row) => row.runId === 'loop-4')!.streamOk = false;

    const gate = decideWorkerParityGate(rows);
    expect(gate.verdict).toBe('red');
    expect(gate.workerFlipAllowed).toBe(false);
    expect(gate.reasons.join('\n')).toMatch(/task-success/);
    expect(gate.reasons.join('\n')).toMatch(/cost\/task ratio/);
    expect(gate.reasons.join('\n')).toMatch(/stream-fidelity/);
    expect(gate.reasons.join('\n')).toMatch(/MCP failure-rate/);
    expect(gate.deltas.missingBaselineTools).toEqual(['capability:read']);
  });

  it('holds rather than inventing a price or MCP compatibility verdict', () => {
    const rows = paired().map((row) => ({
      ...row,
      costUsd: row.engine === 'loop' ? null : row.costUsd,
      pricedSampleCount: row.engine === 'loop' ? 0 : row.pricedSampleCount,
      mcpCalls: 0,
      mcpToolNames: [],
    }));
    const gate = decideWorkerParityGate(rows);
    expect(gate.verdict).toBe('hold');
    expect(gate.reasons.join('\n')).toMatch(/cost attribution incomplete/);
    expect(gate.reasons.join('\n')).toMatch(/MCP corpus too small/);
  });

  it('pairs repeated prompts deterministically and excludes model mismatches', () => {
    const rows = [
      run('omp', 1, { promptHash: 'same', endedAt: 400 }),
      run('omp', 2, { promptHash: 'same', endedAt: 300 }),
      run('loop', 1, { promptHash: 'same', endedAt: 390 }),
      run('loop', 2, { promptHash: 'same', endedAt: 290, model: 'different-model' }),
      run('omp', 3, { promptHash: 'omp-only' }),
    ];
    const gate = decideWorkerParityGate(rows);
    expect(gate.pairedTasks).toBe(1);
    expect(gate.modelMismatchPairs).toBe(1);
    expect(gate.unpairedRuns).toEqual({ omp: 1, loop: 0 });
    expect(gate.workerFlipAllowed).toBe(false);
  });
});

describe('readWorkerParityRuns', () => {
  it('maps the bounded ledger projection without reading raw bodies into the result', async () => {
    const query = vi.fn(async (..._args: unknown[]) => [{
      run_id: 'r1',
      harness_slug: 'canary',
      prompt_hash: 'abc',
      feature_id: 'F-1',
      requested_model: 'alias',
      usage_model: 'actual-model',
      engine: 'loop',
      exit_code: 0,
      ended_at: 1234n,
      stream_ok: true,
      cost_usd: '0.25',
      cost_sample_count: 1n,
      priced_sample_count: 1n,
      mcp_calls: 2n,
      mcp_failures: 0n,
      mcp_tool_names: ['capability:read'],
    }]);
    const pg = (query as unknown) as OrchestratorPg;

    const rows = await readWorkerParityRuns(pg, {
      workspaceId: 'ws',
      harnessSlug: 'canary',
      sinceMs: 100,
      limit: 50,
    });
    expect(rows).toEqual([{
      runId: 'r1',
      harnessSlug: 'canary',
      promptHash: 'abc',
      featureId: 'F-1',
      model: 'alias',
      engine: 'loop',
      exitCode: 0,
      endedAt: 1234,
      streamOk: true,
      costUsd: 0.25,
      costSampleCount: 1,
      pricedSampleCount: 1,
      mcpCalls: 2,
      mcpFailures: 0,
      mcpToolNames: ['capability:read'],
    }]);
    expect(query).toHaveBeenCalledOnce();
    const sql = (query.mock.calls[0]![0] as readonly string[]).join('?');
    expect(sql).toContain(
      "rtrim(jsonl_body, chr(10) || chr(13) || chr(9) || ' ')",
    );
    expect(sql).not.toContain('reverse(rtrim(jsonl_body))');
  });
});
