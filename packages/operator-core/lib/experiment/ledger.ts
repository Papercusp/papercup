/**
 * The experiment ledger (`experiment-registry-invocation-api` P-050) —
 * `harness_shared.experiment_runs` (migration 287). One row per `experiment:run`
 * invocation: the run-level summary (arms+scores, winner, the compareArms verdict,
 * cost, decision) the self-learning system reads back to see how variations
 * performed. Per-cell detail stays in replay_runs (247); spend stays on the
 * governor's learning_spend_events — this is the experiment-level record.
 *
 * A winner is a PROPOSAL: rows are born `decision='proposed'`; only the apply path
 * (commit→reproject + graduation, D-006) advances the decision — never experiment:run.
 */
import type { Sql } from 'postgres';
import type { ExperimentArmResult } from './types';

export interface ExperimentLedgerRow {
  workspaceId: string;
  batteryId: string;
  testId: string;
  tier: string;
  arms: ExperimentArmResult[];
  baselineId: string;
  winner: string | null;
  comparison: unknown;
  totalCostUsd: number;
  budgetExhausted: boolean;
}

/** The write seam — PG impl below; run-core/tests inject a fake or omit it. */
export interface ExperimentLedger {
  record(row: ExperimentLedgerRow): Promise<void>;
}

export class PgExperimentLedger implements ExperimentLedger {
  constructor(private readonly sql: Sql) {}

  async record(row: ExperimentLedgerRow): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.experiment_runs
        (workspace_id, battery_id, test_id, tier, arms, baseline_id, winner, comparison,
         total_cost_usd, budget_exhausted)
      VALUES (
        ${row.workspaceId}, ${row.batteryId}, ${row.testId}, ${row.tier},
        ${this.sql.json(row.arms as unknown as object)}, ${row.baselineId}, ${row.winner},
        ${row.comparison === null || row.comparison === undefined ? null : this.sql.json(row.comparison as object)},
        ${row.totalCostUsd}, ${row.budgetExhausted}
      )
      ON CONFLICT (workspace_id, battery_id) DO UPDATE SET
        test_id          = EXCLUDED.test_id,
        tier             = EXCLUDED.tier,
        arms             = EXCLUDED.arms,
        baseline_id      = EXCLUDED.baseline_id,
        winner           = EXCLUDED.winner,
        comparison       = EXCLUDED.comparison,
        total_cost_usd   = EXCLUDED.total_cost_usd,
        budget_exhausted = EXCLUDED.budget_exhausted,
        updated_at       = now()
    `;
  }
}
