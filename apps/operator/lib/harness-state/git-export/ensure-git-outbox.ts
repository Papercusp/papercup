/**
 * Git-export capture (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * A DEDICATED outbox + capture trigger for `sync:'git'` tables, intentionally
 * separate from the Model-B `substrate_outbox` + its drainer (D-004): adding
 * git tables to that shared outbox would feed them to the peer-log drainer
 * (which appends everything to the Hyperbee log). A separate `git_export_outbox`
 * keeps the new path fully additive — it touches none of the Model-B substrate.
 *
 * Mirrors `capture_substrate_outbox` (ensure-schema-dogfood.ts): AFTER row
 * trigger, echo-loop guard on `origin`, key extracted via the trigger arg.
 */
import type postgres from 'postgres';
import { GIT_TABLES } from '../table-registry';

/**
 * Key column per git table (the file leaf = this column's value). Best-effort;
 * defaults to 'id'. The real PKs must be verified before the production attach
 * (P-003b tail) — a wrong key column collides file names.
 */
export const GIT_KEY_COL: Record<string, string> = {
  harness_text_artifacts: 'rel_path',
  harness_feature_notes: 'note_id',
  feature_audit_consolidated: 'feature_id',
  harness_chunk_plans: 'chunk_id',
};

export function gitKeyCol(table: string): string {
  return GIT_KEY_COL[table] ?? 'id';
}

/** Ensure the dedicated git-export outbox table + capture function (idempotent). */
export async function ensureGitExportOutbox(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.git_export_outbox (
      id           BIGSERIAL PRIMARY KEY,
      workspace_id TEXT   NOT NULL,
      harness_slug TEXT   NOT NULL,
      table_name   TEXT   NOT NULL,
      op           TEXT   NOT NULL CHECK (op IN ('put','del')),
      key          TEXT   NOT NULL,
      row          JSONB,
      ts           BIGINT NOT NULL,
      exported_at  BIGINT
    );
    CREATE INDEX IF NOT EXISTS git_export_outbox_drain_idx
      ON harness_shared.git_export_outbox (workspace_id, harness_slug, exported_at, id);
  `);
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_git_export_outbox()
    RETURNS TRIGGER AS $body$
    DECLARE
      v_op TEXT; v_rec RECORD; v_row JSONB; v_key TEXT; v_ws TEXT; v_slug TEXT;
      v_keycol TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD;
      ELSE v_op := 'put'; v_rec := NEW; END IF;
      v_row := to_jsonb(v_rec);
      -- echo-loop guard: skip remote-origin writes (hydrate/projection writes).
      IF COALESCE(v_row ->> 'origin', 'local') <> 'local' THEN RETURN v_rec; END IF;
      v_key  := v_row ->> v_keycol;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'harness_slug';
      INSERT INTO harness_shared.git_export_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
              (extract(epoch from now())*1000)::bigint);
      PERFORM pg_notify('git_export_outbox', v_ws || '::' || v_slug);
      RETURN v_rec;
    END;
    $body$ LANGUAGE plpgsql;
  `);
}

/** Attach the git-export capture trigger to one table (idempotent). */
export async function attachGitCaptureTrigger(
  sql: postgres.Sql,
  table: string,
  keyCol: string = gitKeyCol(table),
): Promise<void> {
  await sql.unsafe(
    `CREATE OR REPLACE TRIGGER capture_git_export_outbox_trg ` +
      `AFTER INSERT OR UPDATE OR DELETE ON harness_shared.${table} ` +
      `FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_git_export_outbox('${keyCol}')`,
  );
}

/**
 * Attach the capture trigger to every harness_shared `sync:'git'` table.
 * Tables that don't exist on this install (or aren't in harness_shared, e.g.
 * the papercup_shared document tables) are skipped, not fatal.
 */
export async function attachAllGitCaptureTriggers(
  sql: postgres.Sql,
): Promise<{ attached: string[]; skipped: string[] }> {
  const attached: string[] = [];
  const skipped: string[] = [];
  for (const t of GIT_TABLES) {
    try {
      await attachGitCaptureTrigger(sql, t);
      attached.push(t);
    } catch {
      skipped.push(t); // not present / not in harness_shared on this install
    }
  }
  return { attached, skipped };
}
