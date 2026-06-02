/**
 * Git-export hydrate (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * The REVERSE of the drainer: git is the sync authority for `sync:'git'` tables,
 * so on boot (and after a `git pull`) the operator rebuilds the PG rows from the
 * committed `.harness/state/<dir>/*` files. This is what makes "clone-and-go"
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
  /** Absolute harness root (where `.harness/state/` lives). */
  harnessRoot: string;
  /** Bare harness_shared table name. */
  table: string;
  /** The table's FULL primary key (ON CONFLICT target). */
  conflictCols: string[];
}

/** Hydrate one git table from its `.harness/state` files into PG. Returns rows upserted. */
export async function hydrateGitTable(opts: HydrateGitTableOpts): Promise<number> {
  const { sql, harnessRoot, table, conflictCols } = opts;
  const dir = join(harnessRoot, stateDirFor(table));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0; // no dir → nothing committed for this table
  }
  if (files.length === 0) return 0;

  let n = 0;
  // Disable the capture trigger so the hydrate upserts don't re-enqueue exports.
  await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE TRIGGER ${CAPTURE_TRG}`);
  try {
    for (const f of files) {
      const row = parseFile(table, await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const placeholders = cols.map((c, i) =>
        row[c] !== null && typeof row[c] === 'object' ? `$${i + 1}::jsonb` : `$${i + 1}`,
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
