import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureRecordedReuseMetric } from './reuse-measurement';

const { loadHarnessRegistry } = vi.hoisted(() => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry }));

const scope = {
  workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
  windowStart: '2026-10-10T00:00:00.000Z', windowEnd: '2026-11-06T00:00:00.000Z',
};

function emptySql(unsafe = vi.fn()) {
  return Object.assign(vi.fn(async () => []), { unsafe }) as unknown as Sql;
}

describe('reuse measurement failure diagnostics', () => {
  beforeEach(() => {
    loadHarnessRegistry.mockReset().mockResolvedValue({ projects: [] });
  });

  it('does not repeat a failed raw population parse for sibling metrics on the exact same window', async () => {
    const sql = emptySql();
    const redundancy = await measureRecordedReuseMetric(sql, scope, 'redundancy');
    const crossFileCalls = await measureRecordedReuseMetric(sql, scope, 'crossFileCalls');

    expect(redundancy).toMatchObject({ verdict: 'unknown' });
    expect(crossFileCalls).toMatchObject({ verdict: 'unknown' });
    expect(crossFileCalls.detail).toContain('skipped duplicate source parsing');
    expect(loadHarnessRegistry).toHaveBeenCalledTimes(1);
  });

  it('identifies the provider report call stage and its SQL deadline when the query is canceled', async () => {
    const unsafe = vi.fn(async () => { throw new Error('canceling statement due to user request'); });
    const result = await measureRecordedReuseMetric(emptySql(unsafe), scope, 'providerOutcomes');
    const detail = JSON.parse(result.detail);

    expect(result.verdict).toBe('unknown');
    expect(detail).toMatchObject({
      failedStage: 'recipe-outcome-report-call',
      recipeOutcomeSqlStatementTimeoutMs: 30_000,
      error: 'canceling statement due to user request',
    });
    expect(detail.stageElapsedMs).toEqual(expect.any(Number));
    expect(unsafe).toHaveBeenCalledTimes(1);
  });
});
