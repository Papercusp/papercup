/**
 * PG store adapter for the Hive-evaluation battery (harness_shared, migration 264).
 *
 * Mirrors the beekeeper PG store, but keyed `(instance_id, scenario_id, repeat)` so every
 * repeat is kept (P-022 distribution) — unlike the beekeeper's `(instance_id, case_id)`.
 * All writes are idempotent (the run_id is deterministic per key) so a re-run / replay
 * RESETS the row to a fresh attempt rather than colliding. Scoring is HE-06's table.
 */
import postgres from 'postgres';
import type { HiveEvalStore, HiveEvalRunFinish, HiveEvalRunRow, HiveEvalScenarioRow, InstanceManifest } from './store';

export class HiveEvalStorePg implements HiveEvalStore {
  constructor(private sql: postgres.Sql) {}

  async upsertInstance(m: InstanceManifest): Promise<void> {
    // Deterministic instanceId → a re-run at the same code is a no-op, not a crash.
    await this.sql`
      INSERT INTO harness_shared.hive_eval_instances
        (instance_id, workspace_id, code_sha, genome_id, battery_slice_id)
      VALUES
        (${m.instanceId}, ${m.workspaceId}, ${m.codeSha}, ${m.genomeId || null}, ${m.batterySliceId || null})
      ON CONFLICT (instance_id) DO NOTHING
    `;
  }

  async upsertScenario(s: HiveEvalScenarioRow): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.hive_eval_scenarios
        (scenario_id, title, shape, ideal_wall_clock_units, ideal_bee_count, total_units,
         critical_path, work_item_count, planted_bug_location)
      VALUES
        (${s.scenarioId}, ${s.title}, ${s.shape}, ${s.idealWallClockUnits}, ${s.idealBeeCount},
         ${s.totalUnits}, ${this.sql.json(s.criticalPath)}, ${s.workItemCount}, ${s.plantedBugLocation})
      ON CONFLICT (scenario_id) DO UPDATE SET
        title = EXCLUDED.title,
        shape = EXCLUDED.shape,
        ideal_wall_clock_units = EXCLUDED.ideal_wall_clock_units,
        ideal_bee_count = EXCLUDED.ideal_bee_count,
        total_units = EXCLUDED.total_units,
        critical_path = EXCLUDED.critical_path,
        work_item_count = EXCLUDED.work_item_count,
        planted_bug_location = EXCLUDED.planted_bug_location
    `;
  }

  async startRun(r: HiveEvalRunRow): Promise<void> {
    // run_id is deterministic per (instance, scenario, repeat). A re-run RESETS the row to a
    // fresh attempt (clear the terminal fields finishRun repopulates) rather than colliding.
    await this.sql`
      INSERT INTO harness_shared.hive_eval_runs
        (run_id, instance_id, scenario_id, shape, repeat, seed, budget_usd_cap, bee_cap, started_at)
      VALUES
        (${r.runId}, ${r.instanceId}, ${r.scenarioId}, ${r.shape}, ${r.repeat}, ${r.seed},
         ${r.budgetUsdCap}, ${r.beeCap}, ${r.startedAt})
      ON CONFLICT (run_id) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        scenario_id = EXCLUDED.scenario_id,
        shape = EXCLUDED.shape,
        repeat = EXCLUDED.repeat,
        seed = EXCLUDED.seed,
        budget_usd_cap = EXCLUDED.budget_usd_cap,
        bee_cap = EXCLUDED.bee_cap,
        started_at = EXCLUDED.started_at,
        finished_at = NULL,
        terminal_state = NULL,
        wall_clock_ms = NULL,
        frontier_drained = NULL,
        work_items_total = NULL,
        work_items_completed = NULL,
        cost_usd = NULL,
        observations = NULL,
        trace_ref = NULL
    `;
  }

  async finishRun(runId: string, fields: HiveEvalRunFinish): Promise<void> {
    const o = fields.observations;
    await this.sql`
      UPDATE harness_shared.hive_eval_runs
      SET
        finished_at = ${fields.finishedAt},
        terminal_state = ${o.terminalState},
        wall_clock_ms = ${o.wallClockMs},
        frontier_drained = ${o.frontierDrained},
        work_items_total = ${o.workItemsTotal},
        work_items_completed = ${o.workItemsCompleted},
        cost_usd = ${o.costUsd},
        observations = ${this.sql.json(o as unknown as postgres.JSONValue)},
        trace_ref = ${fields.traceRef || null}
      WHERE run_id = ${runId}
    `;
  }
}

export function createPgHiveEvalStore(sql: postgres.Sql): HiveEvalStore {
  return new HiveEvalStorePg(sql);
}
