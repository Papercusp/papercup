/**
 * §15.6 step 7e+7f — restore harness_shared subset with slug-prefixed IDs.
 *
 * The collision case the spec calls out: `harness_shared.projects.id =
 * 'PROJ-XYZ'` exists on both publisher's and consumer's machines with
 * divergent local PM curation. A naive `INSERT ... ON CONFLICT DO NOTHING`
 * silently merges publisher's features under consumer's project — which
 * is a silent-corruption case.
 *
 * Fix: at restore, every row in a `forkPrefixIds: true` shared table gets
 * its `id` column rewritten by appending the fork-slug suffix. All FK
 * columns in the (already-restored) per-harness schema get UPDATE'd in
 * the same transaction.
 *
 * The on-disk row format is the canonical PG CSV (HEADER) emitted by the
 * capture-side `copyFilteredSharedTables`. We parse it in JS and re-emit
 * via postgres-js parameterized INSERTs — no `psql` involved.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { assertValidSlug, includedSharedTables } from './shared-table-filters';
import type { SharedTableFilter } from './shared-table-filters';

interface CsvFile {
  table: string;
  path: string;
}

async function discoverCsvs(stateDir: string): Promise<CsvFile[]> {
  const out: CsvFile[] = [];
  for (const entry of includedSharedTables()) {
    const p = join(stateDir, `shared-${entry.table}.csv`);
    try {
      await fs.access(p);
      out.push({ table: entry.table, path: p });
    } catch {
      /* file missing — table had zero rows, fine */
    }
  }
  return out;
}

/**
 * Pure restore-side row shaping for one shared table (§15.6 step 7e):
 *   1. `slugColumn` rewrite — rows captured under the snapshot's original
 *      slug are re-keyed to the fork slug, so they land in the FORK rather
 *      than orphaned (cross-machine) or bled into the source harness (local).
 *   2. `restoreRowTransform` — table-specific shaping (work_items'
 *      issue-family id suffixing).
 *   3. `forkPrefixIds` — `id` column gets the `_fork_<suffix>` suffix to
 *      dodge same-machine PK collisions.
 *
 * Exported for unit tests; `applyHarnessSharedRestore` is the only
 * production caller.
 */
export function transformSharedRows(
  reg: SharedTableFilter,
  rows: Array<Record<string, unknown>>,
  ctx: { originalSlug: string; newSlug: string; forkSuffix: string },
): Array<Record<string, unknown>> {
  let out = rows;
  if (reg.slugColumn) {
    const col = reg.slugColumn;
    out = out.map((r) => (r[col] === ctx.originalSlug ? { ...r, [col]: ctx.newSlug } : r));
  }
  if (reg.restoreRowTransform) {
    out = out.map((r) => reg.restoreRowTransform!(r, ctx));
  }
  if (reg.forkPrefixIds) {
    out = out.map((r) => ({ ...r, id: `${String(r.id)}_fork_${ctx.forkSuffix}` }));
  }
  return out;
}

/**
 * Restore harness_shared CSVs into the live schema, with column-aware
 * INSERTs (information_schema roundtrip) so we can rewrite the `id`
 * column when the registry asks for it.
 *
 * Atomic: all inserts + per-harness FK updates happen in a single
 * postgres-js transaction; any failure rolls back the whole batch.
 */
export async function applyHarnessSharedRestore(args: {
  url: string;
  /** The snapshot's source harness slug (manifest.harnessSlug). */
  originalSlug: string;
  /** The fork harness slug rows are re-keyed to. */
  newSlug: string;
  forkSuffix: string;
  stateDir: string;
  workDir: string;
  perHarnessSchema: string;
}): Promise<{ tables: { table: string; rowCount: number }[] }> {
  // Bind workDir for any future temp scratch — currently unused since we
  // stream rows in memory rather than via an intermediate file.
  void args.workDir;
  const csvs = await discoverCsvs(args.stateDir);
  if (csvs.length === 0) return { tables: [] };

  assertValidSlug(args.forkSuffix.replace(/_/g, ''));
  assertValidSlug(args.originalSlug);
  assertValidSlug(args.newSlug);

  const sql = postgres(args.url, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const cols = await loadColumnLists(sql);
    const tableStats: { table: string; rowCount: number }[] = [];

    await sql.begin(async (tx) => {
      for (const csv of csvs) {
        const reg = includedSharedTables().find((t) => t.table === csv.table)!;
        const colList = cols.get(csv.table);
        if (!colList || colList.length === 0) {
          throw new Error(`could not introspect columns for harness_shared.${csv.table}`);
        }

        const csvText = await fs.readFile(csv.path, 'utf8');
        const rows = parseCsv(csvText, colList);
        if (rows.length === 0) {
          tableStats.push({ table: csv.table, rowCount: 0 });
          continue;
        }

        // Apply slug re-keying + table transforms + id-fork-prefixing in JS
        // rather than via SQL expression so the INSERT can be a single bulk
        // statement. postgres-js's `tx(rows)` helper expands an object array
        // into a multi-row VALUES clause.
        const transformed = transformSharedRows(reg, rows, {
          originalSlug: args.originalSlug,
          newSlug: args.newSlug,
          forkSuffix: args.forkSuffix,
        });

        await tx`
          INSERT INTO ${tx(`harness_shared.${csv.table}`)}
          ${tx(transformed, ...colList)}
        `;

        if (reg.forkPrefixIds) {
          for (const fk of reg.fkRefsInPerHarness ?? []) {
            await tx.unsafe(
              `UPDATE ${args.perHarnessSchema}.${fk.table}
                SET ${fk.column} = ${fk.column} || '_fork_${args.forkSuffix}'
                WHERE ${fk.column} IS NOT NULL`,
            );
          }
        }
        tableStats.push({ table: csv.table, rowCount: transformed.length });
      }

      // §15.6 7f — projects.id forking propagates to project_spec_revisions.
      if (csvs.some((c) => c.table === 'projects')) {
        await tx.unsafe(
          `UPDATE harness_shared.project_spec_revisions
            SET project_id = project_id || '_fork_${args.forkSuffix}'
            WHERE project_id IN (
              SELECT id FROM harness_shared.projects
              WHERE id LIKE '%_fork_${args.forkSuffix}'
            )`,
        );
      }
    });
    return { tables: tableStats };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function loadColumnLists(
  sql: ReturnType<typeof postgres>,
): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  const rows = (await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
    ORDER BY table_name, ordinal_position
  `) as Array<{ table_name: string; column_name: string }>;
  for (const row of rows) {
    if (!m.has(row.table_name)) m.set(row.table_name, []);
    m.get(row.table_name)!.push(row.column_name);
  }
  return m;
}

/**
 * Parse a PG `\COPY (...) TO STDOUT WITH (FORMAT csv, HEADER)` output.
 *
 * PG's CSV grammar: comma-separated fields; fields containing
 * comma/quote/CR/LF are double-quoted; embedded `"` is doubled.
 * NULL renders as the empty string by default; we keep them as `null`
 * in the parsed objects so postgres-js inserts them as SQL NULL.
 *
 * The first line is the header; subsequent lines are records. A record
 * may span multiple physical lines if a quoted field contains a newline.
 */
function parseCsv(text: string, expectedCols: string[]): Array<Record<string, unknown>> {
  const fields = tokenizeCsv(text);
  if (fields.length === 0) return [];
  // Header cells are always real column names from PG COPY HEADER; the
  // tokenizer's `null` (unquoted-empty) can't legitimately occur here.
  const header = fields[0].map((h) => String(h ?? ''));
  // Sanity: header should match the column order from information_schema.
  // If a column is missing, downstream INSERT will fail with a clearer
  // message than we'd produce here, so just trust the header.
  void expectedCols;

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length === 1 && rec[0] === '') continue; // trailing newline
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      const raw = rec[c] ?? null;
      // PG CSV default: empty string == NULL only when the field was
      // unquoted. Our tokenizer preserves the quoted-vs-unquoted distinction
      // by returning `null` for unquoted-empty and `""` for quoted-empty.
      obj[header[c]] = raw;
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Stateful CSV tokenizer matching PG's COPY CSV grammar. Returns an
 * array of records, each a flat array of field values. A field is `null`
 * when it appears unquoted-empty (PG NULL), or a string otherwise (which
 * may be the empty string when explicitly quoted as `""`).
 */
function tokenizeCsv(text: string): Array<Array<string | null>> {
  const out: Array<Array<string | null>> = [];
  let row: Array<string | null> = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      fieldQuoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(fieldQuoted ? field : (field === '' ? null : field));
      field = '';
      fieldQuoted = false;
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue; // \r\n → drop \r, handle \n
    }
    if (ch === '\n') {
      row.push(fieldQuoted ? field : (field === '' ? null : field));
      out.push(row);
      row = [];
      field = '';
      fieldQuoted = false;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || fieldQuoted || row.length > 0) {
    row.push(fieldQuoted ? field : (field === '' ? null : field));
    out.push(row);
  }
  return out;
}
