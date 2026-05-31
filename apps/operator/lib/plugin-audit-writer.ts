/**
 * PG-backed audit writer for plugin action invocations. Replaces the
 * in-memory writer in operator hosts so audit rows survive restarts and
 * can be queried from the audit panel UI.
 *
 * Rust-port-feedback items 6 + 9 + 11. Pairs with the host's "fail
 * closed" behavior: if the audit write fails, the action invocation is
 * rejected — a plugin that ran but isn't audited is worse than one that
 * didn't run.
 */

import type { AuditRow, AuditWriter } from '@papercusp/plugin-loader';
import { getOrgPg } from '@papercusp/db-org';

let _ensured = false;
async function ensureTable(): Promise<void> {
  if (_ensured) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.plugin_audit_log (
      id                  BIGSERIAL PRIMARY KEY,
      ts                  TIMESTAMPTZ NOT NULL,
      plugin_name         TEXT NOT NULL,
      install_slug        TEXT NOT NULL,
      action_name         TEXT NOT NULL,
      trigger_source      TEXT NOT NULL,
      trigger_id          TEXT,
      params_json         JSONB,
      outcome             TEXT NOT NULL,
      duration_ms         INTEGER NOT NULL,
      error_message       TEXT,
      capabilities_used   TEXT[],
      killed_by_timeout   BOOLEAN,
      stdout_bytes        INTEGER,
      stderr_bytes        INTEGER,
      truncated           BOOLEAN
    );
    CREATE INDEX IF NOT EXISTS plugin_audit_by_plugin
      ON harness_shared.plugin_audit_log (plugin_name, ts DESC);
    CREATE INDEX IF NOT EXISTS plugin_audit_by_harness
      ON harness_shared.plugin_audit_log (install_slug, ts DESC);
    CREATE INDEX IF NOT EXISTS plugin_audit_outcome
      ON harness_shared.plugin_audit_log (outcome) WHERE outcome != 'ok';
  `);
  _ensured = true;
}

export class PgAuditWriter implements AuditWriter {
  /** Resolves true on success; throws on failure so the host can fail-closed. */
  async write(row: AuditRow): Promise<void> {
    await ensureTable();
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.plugin_audit_log
        (ts, plugin_name, install_slug, action_name, trigger_source, trigger_id,
         params_json, outcome, duration_ms, error_message, capabilities_used,
         killed_by_timeout, stdout_bytes, stderr_bytes, truncated)
      VALUES
        (to_timestamp(${row.ts / 1000}), ${row.pluginName}, ${row.installSlug},
         ${row.actionName}, ${row.triggerSource}, ${row.triggerId},
         ${JSON.stringify(row.params ?? null)}::jsonb, ${row.outcome}, ${row.durationMs},
         ${row.errorMessage ?? null}, ${row.capabilitiesUsed ?? null},
         ${row.killedByTimeout ?? null}, ${row.stdoutBytes ?? null},
         ${row.stderrBytes ?? null}, ${row.truncated ?? null})
    `;
  }
}
