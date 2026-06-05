/**
 * Git-export hydrate (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * The REVERSE of the drainer: git is the sync authority for `sync:'git'` tables,
 * so on boot (and after a `git pull`) the operator rebuilds the PG rows from the
 * committed `.papercusp/state/<dir>/*` files. This is what makes "clone-and-go"
 * work — a fresh checkout has the files but an empty PG.
 *
 * Disables the git-export capture trigger around the load so re-importing a file
 * doesn't bounce straight back into the export outbox (an echo loop). Generic
 * upsert: object/array values → jsonb, everything else → a normal bind param;
 * identifiers (table + columns) come from the trusted registry / PK map.
 */
import type postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirFor, parseFile } from './serialize';

const CAPTURE_TRG = 'capture_git_export_outbox_trg';

export interface HydrateGitTableOpts {
  sql: postgres.Sql;
  /** Absolute harness root (where `.papercusp/state/` lives). */
  harnessRoot: string;
  /** Bare harness_shared table name. */
  table: string;
  /** The table's FULL primary key (ON CONFLICT target). */
  conflictCols: string[];
  /** This install's workspace id — re-injected (stripped from the git file). */
  workspaceId: string;
  /** This harness's slug — re-injected (stripped from the git file). */
  harnessSlug: string;
}

/** Hydrate one git table from its `.papercusp/state` files into PG. Returns rows upserted. */
export async function hydrateGitTable(opts: HydrateGitTableOpts): Promise<number> {
  const { sql, harnessRoot, table, conflictCols, workspaceId, harnessSlug } = opts;
  const dir = join(harnessRoot, stateDirFor(table));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0; // no dir → nothing committed for this table
  }
  if (files.length === 0) return 0;

  // ── Identifier safety (security) ─────────────────────────────────────
  // `table` is from the trusted registry but is interpolated into raw SQL
  // below; `cols` (Object.keys of a parsed `.papercusp/state` file) are
  // UNTRUSTED file content — in the clone-and-go / shared-harness model a
  // crafted key would inject SQL into the column list. Validate the table
  // name shape, then check every column (and the conflict cols) against the
  // table's REAL schema. Values are already parameterized ($N); only the
  // identifiers needed guarding.
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`hydrate: refusing unsafe table identifier ${JSON.stringify(table)}`);
  }
  const schemaCols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = ${table}
  `;
  const allowed = new Set(schemaCols.map((r) => r.column_name));
  if (allowed.size === 0) return 0; // unknown table → nothing to hydrate
  for (const c of conflictCols) {
    if (!allowed.has(c)) {
      throw new Error(`hydrate: ${table} conflict column ${JSON.stringify(c)} is not a real column`);
    }
  }

  let n = 0;
  // Disable the capture trigger so the hydrate upserts don't re-enqueue exports.
  await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE TRIGGER ${CAPTURE_TRG}`);
  try {
    for (const f of files) {
      const row = parseFile(table, await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
      // Re-inject the context/provenance columns stripped on serialize, from the
      // harness context (origin='remote' — it came from git, not a local edit).
      // Only for columns the table actually has, so it works for tables lacking
      // one of them (e.g. no workspace_id) without a bad-column INSERT.
      if (allowed.has('workspace_id') && row.workspace_id === undefined) row.workspace_id = workspaceId;
      if (allowed.has('harness_slug') && row.harness_slug === undefined) row.harness_slug = harnessSlug;
      if (allowed.has('origin') && row.origin === undefined) row.origin = 'remote';
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      // Reject any column the committed file claims that isn't in the real
      // schema — a crafted key here is the SQL-injection vector.
      for (const c of cols) {
        if (!allowed.has(c)) {
          throw new Error(
            `hydrate: ${table} file ${f} declares unknown column ${JSON.stringify(c)} ` +
              `(possible injection or schema drift) — aborting`,
          );
        }
      }
      const placeholders = cols.map((c, i) =>
        row[c] !== null && typeof row[c] === 'object' ? `$${i + 1}::text::jsonb` : `$${i + 1}`,
      );
      const params = cols.map((c) =>
        row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c],
      );
      const setCols = cols.filter((c) => !conflictCols.includes(c));
      const onConflict = setCols.length
        ? `DO UPDATE SET ${setCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
        : 'DO NOTHING';
      await sql.unsafe(
        `INSERT INTO harness_shared.${table} (${cols.join(', ')}) ` +
          `VALUES (${placeholders.join(', ')}) ` +
          `ON CONFLICT (${conflictCols.join(', ')}) ${onConflict}`,
        params as never[],
      );
      n += 1;
    }
  } finally {
    await sql.unsafe(`ALTER TABLE harness_shared.${table} ENABLE TRIGGER ${CAPTURE_TRG}`);
  }
  return n;
}
