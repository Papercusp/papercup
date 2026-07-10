import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { HiveEvalStorePg } from './store-pg';
import type { HiveEvalRunRow, HiveEvalRunFinish } from './store';

/**
 * Regression guard (first-live-run finding, 2026-06-15): the org PG client (`getOrgPg`) REJECTS a
 * raw JS Date param for a timestamptz column ("The string argument must be of type string ...
 * Received an instance of Date") — a timestamptz must be bound as an ISO string. The sibling
 * `store-pg.integration.test.ts` uses a VANILLA postgres.js client (which DOES coerce Dates), so it
 * cannot catch this; this unit test captures the tagged-template values and asserts no raw Date is
 * ever bound. See the `org-pg-client-rejects-raw-date` memory.
 */
function captureSql(): { tag: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const tag = ((_s: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve([] as unknown[]);
  }) as unknown as postgres.Sql;
  return { tag, calls };
}

const runRow: HiveEvalRunRow = {
  runId: 'r1',
  instanceId: 'i1',
  scenarioId: 'serial-pipeline',
  shape: 'serial' as HiveEvalRunRow['shape'],
  repeat: 0,
  seed: 1,
  budgetUsdCap: 1,
  beeCap: 1,
  startedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('HiveEvalStorePg timestamptz binding (the org client rejects a raw Date)', () => {
  it('startRun binds started_at as an ISO string, never a raw Date', async () => {
    const { tag, calls } = captureSql();
    await new HiveEvalStorePg(tag).startRun(runRow);
    const values = calls[0];
    expect(values.every((v) => !(v instanceof Date))).toBe(true);
    expect(values).toContain('2026-06-15T00:00:00.000Z');
  });

  it('finishRun binds finished_at as an ISO string, never a raw Date', async () => {
    const { tag, calls } = captureSql();
    const fields = {
      finishedAt: new Date('2026-06-15T01:00:00.000Z'),
      observations: {
        terminalState: 'drained',
        wallClockMs: 1,
        frontierDrained: true,
        workItemsTotal: 0,
        workItemsCompleted: 0,
        costUsd: 0,
      },
    } as unknown as HiveEvalRunFinish;
    await new HiveEvalStorePg(tag).finishRun('r1', fields);
    const values = calls[0];
    expect(values.every((v) => !(v instanceof Date))).toBe(true);
    expect(values).toContain('2026-06-15T01:00:00.000Z');
  });
});
