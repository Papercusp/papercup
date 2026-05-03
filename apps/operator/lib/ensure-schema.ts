/**
 * Idempotent schema ensures, applied at runtime via postgres-js.
 *
 * Scope: only `harness_shared` tables can be ensured at runtime, because
 * runtime roles (harness_app / harness_admin) have CREATE on harness_shared
 * but NOT on per-harness schemas. Per-harness DDL (columns on
 * harness_<slug>.harness_features etc.) must happen at scaffold time
 * via libs/papercusp/libs/db/sql/002-per-harness-template.sql, applied
 * by `bin/scaffold-harness-schema.sh` (psql).
 *
 * For per-harness schema additions to existing harnesses, run:
 *   bin/migrate-installed-harnesses-add-<thing>.sh
 * or apply the ALTER manually as postgres_app.
 *
 * The canonical runtime-DDL pattern (see lib/autoloop.ts,
 * lib/provision/operator-claims.ts) only works for harness_shared.
 */
import { getOrgPg } from '@restart/db-org';

let _ensuredSnapshotFeatures = false;
let _ensuredUserActions = false;

/**
 * Creates harness_shared.user_actions (cross-harness log of long-running
 * user-initiated actions: replan, cleanup, snapshot create/fork/publish,
 * plugin install). Used by recordUserAction() in lib/user-actions.ts and
 * subscribed from OperatorActionLog.tsx via Zero.
 */
export async function ensureUserActionsTable(): Promise<void> {
  if (_ensuredUserActions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.user_actions (
      id            BIGSERIAL PRIMARY KEY,
      harness_slug  TEXT NOT NULL,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL,
      summary       TEXT,
      detail_url    TEXT,
      error_text    TEXT,
      invocation_id TEXT,
      started_at    BIGINT NOT NULL,
      finished_at   BIGINT,
      actor         TEXT
    );
    CREATE INDEX IF NOT EXISTS user_actions_slug_started_idx
      ON harness_shared.user_actions (harness_slug, started_at DESC);
    CREATE INDEX IF NOT EXISTS user_actions_running_idx
      ON harness_shared.user_actions (harness_slug)
      WHERE status = 'running';
  `);
  _ensuredUserActions = true;
}

/** Creates harness_shared.snapshot_features (cross-harness). */
export async function ensureSnapshotFeaturesTable(): Promise<void> {
  if (_ensuredSnapshotFeatures) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.snapshot_features (
      harness_slug         TEXT NOT NULL,
      snapshot_id          TEXT NOT NULL,
      feature_id           TEXT NOT NULL,
      title                TEXT NOT NULL,
      summary              TEXT,
      status               TEXT NOT NULL,
      attempts             BIGINT NOT NULL,
      claims               TEXT,
      notes                TEXT,
      metadata             JSONB,
      kind                 TEXT,
      project_id           TEXT,
      expected_cost_cents  BIGINT,
      tags                 JSONB,
      needs_human_review   BOOLEAN NOT NULL DEFAULT FALSE,
      deprecation_reason   TEXT,
      parent_id            TEXT,
      goal_id              TEXT,
      ts                   BIGINT,
      created_ts           BIGINT NOT NULL,
      PRIMARY KEY (harness_slug, snapshot_id, feature_id)
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS sf_snapshot_idx ON harness_shared.snapshot_features(harness_slug, snapshot_id)`);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.snapshot_features TO harness_app, harness_admin`);
  } catch { /* not all roles can grant; fine */ }
  _ensuredSnapshotFeatures = true;
}

/** Test-only: clear the per-process cache so DDL re-runs. */
export function _resetSchemaEnsureCaches(): void {
  _ensuredSnapshotFeatures = false;
}
