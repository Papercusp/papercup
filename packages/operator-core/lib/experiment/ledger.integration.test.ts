/**
 * ledger.integration.test.ts — PgExperimentLedger against real Postgres
 * (experiment-registry-invocation-api P-050). A mock-pg test cannot catch a column
 * mismatch between the raw-SQL upsert and migration 287; a real insert→read can.
 * The table DDL is inlined verbatim from 287 (the migration's own apply is validated
 * by fresh-migrate). Gated on Docker like the other *-pg integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { PgExperimentLedger, coerceJsonArray } from './ledger';

const EXPERIMENT_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.experiment_runs (
    workspace_id     text NOT NULL,
    battery_id       text NOT NULL,
    test_id          text NOT NULL,
    tier             text NOT NULL CHECK (tier IN ('offline', 'shadow', 'live')),
    arms             jsonb NOT NULL DEFAULT '[]'::jsonb,
    baseline_id      text NOT NULL,
    winner           text,
    comparison       jsonb,
    total_cost_usd   numeric NOT NULL DEFAULT 0,
    budget_exhausted boolean NOT NULL DEFAULT false,
    decision         text NOT NULL DEFAULT 'proposed' CHECK (decision IN ('proposed', 'applied', 'rejected')),
    signal_origin    text NOT NULL DEFAULT 'replay' CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, battery_id)
  )
`;

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('exp-ledger');
  sql = db.sql;
  await sql.unsafe(EXPERIMENT_RUNS_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.experiment_runs`;
});

describe('PgExperimentLedger', () => {
  it('records a run row and reads it back with arms + verdict intact + defaults applied', async () => {
    await new PgExperimentLedger(sql).record({
      workspaceId: 'ws',
      batteryId: 'b1',
      testId: 'replay',
      tier: 'offline',
      arms: [
        { id: 'baseline', label: 'historical baseline', meanScore: 6, cells: 1, scored: 1, costUsd: 0 },
        { id: 'cand', label: 'terser', meanScore: 8, cells: 1, scored: 1, costUsd: 0.01 },
      ],
      baselineId: 'baseline',
      winner: 'cand',
      comparison: { selected: 'cand', selectionReason: '+2.0' },
      totalCostUsd: 0.01,
      budgetExhausted: false,
    });

    const rows = await sql`SELECT * FROM harness_shared.experiment_runs WHERE workspace_id = 'ws' AND battery_id = 'b1'`;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.test_id).toBe('replay');
    expect(r.tier).toBe('offline');
    expect(r.winner).toBe('cand');
    expect(r.decision).toBe('proposed'); // DB default — a winner is a proposal (D-006)
    expect(r.signal_origin).toBe('replay'); // DB default (provenance D-002)
    expect(coerceJsonArray<{ id: string }>(r.arms).map((a) => a.id)).toEqual(['baseline', 'cand']);
    const comparison = typeof r.comparison === 'string' ? JSON.parse(r.comparison) : r.comparison;
    expect((comparison as { selected: string }).selected).toBe('cand');
    expect(Number(r.total_cost_usd)).toBeCloseTo(0.01, 5);
  });

  it('upserts on (workspace_id, battery_id) — a re-run updates in place, not a duplicate', async () => {
    const ledger = new PgExperimentLedger(sql);
    const base = {
      workspaceId: 'ws',
      batteryId: 'b2',
      testId: 'replay',
      tier: 'offline',
      arms: [] as never[],
      baselineId: 'baseline',
      comparison: null,
      budgetExhausted: false,
    };
    await ledger.record({ ...base, winner: null, totalCostUsd: 0.01 });
    await ledger.record({ ...base, winner: 'cand', totalCostUsd: 0.02 });

    const rows = await sql`SELECT winner, total_cost_usd FROM harness_shared.experiment_runs WHERE battery_id = 'b2'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.winner).toBe('cand');
    expect(Number(rows[0]!.total_cost_usd)).toBeCloseTo(0.02, 5);
  });

  it('listRecent returns the workspace’s runs, filterable by testId', async () => {
    const ledger = new PgExperimentLedger(sql);
    const base = {
      workspaceId: 'ws',
      tier: 'offline' as const,
      arms: [],
      baselineId: 'baseline',
      comparison: null,
      totalCostUsd: 0,
      budgetExhausted: false,
    };
    await ledger.record({ ...base, batteryId: 'r1', testId: 'replay', winner: 'a' });
    await ledger.record({ ...base, batteryId: 'r2', testId: 'gym', winner: 'b' });

    const all = await ledger.listRecent('ws', { limit: 10 });
    expect(all.map((r) => r.batteryId).sort()).toEqual(['r1', 'r2']);
    expect(all.every((r) => r.decision === 'proposed')).toBe(true);

    const onlyReplay = await ledger.listRecent('ws', { testId: 'replay' });
    expect(onlyReplay.map((r) => r.batteryId)).toEqual(['r1']);
    expect(onlyReplay[0]!.winner).toBe('a');
  });
});
