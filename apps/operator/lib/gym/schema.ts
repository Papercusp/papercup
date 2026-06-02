/**
 * The `harness_gym` experiment store (P-012) — the gym controller's record of
 * tasks, variants, runs, scores, cycles, and the frozen per-run params that make
 * variants comparable (D-016).
 *
 * Gym-PG-resident (D-018): this is applied by {@link ensureGymSchema} against the
 * DEDICATED gym Postgres database, NOT added to the auto-applied `sql/<NNN>`
 * sequence (which targets the live operator DB and would pollute it). Idempotent,
 * mirroring the repo's ensure-pattern (cf. ensureHarnessPromptOverridesTable), and
 * parametrized by schema name so test suites isolate on the shared testcontainer.
 *
 * Data model: see the plan's "Data model (new harness_gym PG schema)" table.
 */
import type { Sql } from 'postgres';

/** Postgres identifiers we will splice into DDL must be plain, lowercase-safe. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdent(name: string): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`unsafe gym schema name: ${JSON.stringify(name)} (must match ${SAFE_IDENT})`);
  }
}

/** The ordered DDL statements that build the gym schema `g`. Exported for unit tests. */
export function gymSchemaStatements(schema = 'harness_gym'): string[] {
  assertSafeIdent(schema);
  const g = schema;
  return [
    `CREATE SCHEMA IF NOT EXISTS ${g}`,

    // Synthetic feature tasks, by pool (D-013/D-014).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_tasks (
       task_id      TEXT PRIMARY KEY,
       pool         TEXT NOT NULL CHECK (pool IN ('train','dev-anchor','monitor','probe','real-anchor')),
       repo_url     TEXT NOT NULL,
       repo_commit  TEXT NOT NULL,
       spec         TEXT NOT NULL,
       intent       TEXT NOT NULL,
       planted_bug  JSONB,
       generated_by TEXT,
       metadata     JSONB,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,

    // Prompt-overlay variants + lineage (D-010/D-015). models is reserved (D-015).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_variants (
       variant_id         TEXT PRIMARY KEY,
       parent_id          TEXT REFERENCES ${g}.gym_variants(variant_id) ON DELETE SET NULL,
       label              TEXT NOT NULL,
       prompt_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
       models             JSONB,
       diff_from_parent   TEXT,
       proposer_rationale TEXT,
       status             TEXT NOT NULL DEFAULT 'candidate',
       created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,

    // One (variant × task × cycle) hermetic run. terminal_state is observability (D-011).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_runs (
       run_id                TEXT PRIMARY KEY,
       variant_id            TEXT NOT NULL REFERENCES ${g}.gym_variants(variant_id) ON DELETE CASCADE,
       task_id               TEXT NOT NULL REFERENCES ${g}.gym_tasks(task_id) ON DELETE CASCADE,
       cycle                 INT NOT NULL DEFAULT 0,
       harness_slug          TEXT,
       workflow_id           TEXT,
       terminal_state        TEXT,
       deterministic_signals JSONB,
       trace_ref             TEXT,
       distilled_ref         TEXT,
       started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
       finished_at           TIMESTAMPTZ,
       elapsed_ms            BIGINT,
       UNIQUE (variant_id, task_id, cycle)
     )`,

    // Frozen Opus judge output; re-judge-from-cache keyed on rubric_hash (P-010/D-016).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_scores (
       run_id      TEXT NOT NULL REFERENCES ${g}.gym_runs(run_id) ON DELETE CASCADE,
       judge_model TEXT NOT NULL,
       rubric_hash TEXT NOT NULL,
       judge_temp  REAL,
       weights     JSONB NOT NULL,
       d1          REAL NOT NULL,
       d2          REAL NOT NULL,
       d3          REAL NOT NULL,
       composite   REAL NOT NULL,
       rationale   TEXT,
       scored_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (run_id, rubric_hash)
     )`,

    // Loop audit trail (Phase 5).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_cycles (
       cycle_id         TEXT PRIMARY KEY,
       cycle            INT NOT NULL,
       parent_id        TEXT REFERENCES ${g}.gym_variants(variant_id) ON DELETE SET NULL,
       candidate_id     TEXT REFERENCES ${g}.gym_variants(variant_id) ON DELETE SET NULL,
       decision         TEXT,
       gate_results     JSONB,
       budget_spent_usd NUMERIC,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,

    // The frozen run-params that make variants comparable (D-016).
    `CREATE TABLE IF NOT EXISTS ${g}.gym_runs_params (
       run_id           TEXT PRIMARY KEY REFERENCES ${g}.gym_runs(run_id) ON DELETE CASCADE,
       harness_commit   TEXT NOT NULL,
       substrate_commit TEXT NOT NULL,
       mutable_roles    JSONB,
       judge_model      TEXT,
       judge_temp       REAL,
       weights          JSONB,
       rubric_hash      TEXT,
       recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,

    `CREATE INDEX IF NOT EXISTS gym_runs_variant_idx ON ${g}.gym_runs (variant_id)`,
    `CREATE INDEX IF NOT EXISTS gym_runs_task_idx ON ${g}.gym_runs (task_id)`,
    `CREATE INDEX IF NOT EXISTS gym_runs_cycle_idx ON ${g}.gym_runs (cycle)`,
    `CREATE INDEX IF NOT EXISTS gym_scores_run_idx ON ${g}.gym_scores (run_id)`,
    `CREATE INDEX IF NOT EXISTS gym_tasks_pool_idx ON ${g}.gym_tasks (pool)`,
  ];
}

/** Create the gym schema + all six tables in `schema` (idempotent), atomically. */
export async function ensureGymSchema(sql: Sql, schema = 'harness_gym'): Promise<void> {
  const statements = gymSchemaStatements(schema);
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt);
  });
}
