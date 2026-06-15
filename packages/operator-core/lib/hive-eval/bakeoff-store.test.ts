import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { persistBakeoffDelta, readBakeoffTrendRows } from './bakeoff-store';
import type { BakeoffResult, BakeoffVerdict } from './framework-bake-off';

function captureSql(rows: unknown[] = []): { tag: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const tag = ((_s: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(rows);
  }) as unknown as postgres.Sql;
  return { tag, calls };
}

function mkResult(flagKey: string, verdict: BakeoffVerdict, dMean: number, dGate: number): BakeoffResult {
  return {
    flagKey,
    baseline: { arm: 'baseline', flagOn: false, scores: [], meanComposite: 0, gatePassRate: 0 },
    treatment: { arm: 'treatment', flagOn: true, scores: [], meanComposite: 0, gatePassRate: 0 },
    delta: { deltaMeanComposite: dMean, deltaGatePassRate: dGate, verdict },
  };
}

describe('persistBakeoffDelta', () => {
  it('inserts the delta fields + epoch-ms run_at, binding no raw Date', async () => {
    const { tag, calls } = captureSql();
    await persistBakeoffDelta(tag, {
      workspaceId: 'ws',
      result: mkResult('papercusp-x', 'improved', 1.5, 0.25),
      atMs: 1_700_000_000_000,
    });
    const v = calls[0];
    expect(v.every((x) => !(x instanceof Date))).toBe(true);
    expect(v).toContain('ws');
    expect(v).toContain('papercusp-x');
    expect(v).toContain('improved');
    expect(v).toContain(1.5);
    expect(v).toContain(1_700_000_000_000);
  });
});

describe('readBakeoffTrendRows', () => {
  it('maps rows to BakeoffTrendRow with Number-coercion (BIGINT/NUMERIC arrive as strings)', async () => {
    const { tag } = captureSql([
      { flag_key: 'f', verdict: 'improved', delta_mean_composite: '1.5', delta_gate_pass_rate: '0.25', run_at_ms: '1700' },
    ]);
    const rows = await readBakeoffTrendRows(tag, { workspaceId: 'ws' });
    expect(rows[0]).toEqual({ flagKey: 'f', verdict: 'improved', deltaMeanComposite: 1.5, deltaGatePassRate: 0.25, at: 1700 });
  });

  it('clamps the limit to [1, 500]', async () => {
    const { tag, calls } = captureSql();
    await readBakeoffTrendRows(tag, { workspaceId: 'ws', limit: 99_999 });
    expect(calls[0]).toContain(500);
  });
});
