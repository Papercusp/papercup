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
 * The CSV parser here is intentionally simple: shared CSVs are produced
 * by `\COPY (...) TO STDOUT WITH (FORMAT csv, HEADER)` so they follow PG's
 * canonical CSV grammar. We re-emit through `\COPY ... FROM STDIN` to
 * inherit the same parser on insert.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { assertValidSlug, includedSharedTables } from './shared-table-filters';

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
 * Restore harness_shared CSVs into the live schema, with column-aware
 * INSERTs (information_schema roundtrip) so we can rewrite the `id`
 * column when the registry asks for it.
 *
 * All inside a single `psql --single-transaction` so a failure rolls back
 * everything.
 */
export async function applyHarnessSharedRestore(args: {
  url: string;
  forkSuffix: string;
  stateDir: string;
  workDir: string;
  perHarnessSchema: string;
}): Promise<{ tables: { table: string; rowCount: number }[] }> {
  const csvs = await discoverCsvs(args.stateDir);
  if (csvs.length === 0) return { tables: [] };

  const cols = await loadColumnLists(args.url);
  const sqlPath = join(args.workDir, 'shared-restore.sql');
  const lines: string[] = [`\\set ON_ERROR_STOP 1`, `BEGIN;`];
  const tableStats: { table: string; rowCount: number }[] = [];

  for (const csv of csvs) {
    const reg = includedSharedTables().find((t) => t.table === csv.table)!;
    const temp = `_shared_${csv.table}_in`;
    const colList = cols.get(csv.table);
    if (!colList || colList.length === 0) {
      throw new Error(`could not introspect columns for harness_shared.${csv.table}`);
    }

    lines.push(
      `CREATE TEMP TABLE ${temp} (LIKE harness_shared.${csv.table} INCLUDING DEFAULTS);`,
    );
    lines.push(`\\COPY ${temp} FROM '${csv.path}' WITH (FORMAT csv, HEADER);`);

    const allCols = colList.map((c) => `"${c}"`).join(', ');
    if (reg.forkPrefixIds) {
      const rewritten = colList
        .map((c) =>
          c === 'id'
            ? `("id" || '_fork_${args.forkSuffix}') AS "id"`
            : `"${c}"`,
        )
        .join(', ');
      lines.push(
        `INSERT INTO harness_shared.${csv.table} (${allCols}) ` +
          `SELECT ${rewritten} FROM ${temp};`,
      );
      for (const fk of reg.fkRefsInPerHarness ?? []) {
        lines.push(
          `UPDATE ${args.perHarnessSchema}.${fk.table} ` +
            `SET ${fk.column} = ${fk.column} || '_fork_${args.forkSuffix}' ` +
            `WHERE ${fk.column} IS NOT NULL;`,
        );
      }
    } else {
      lines.push(
        `INSERT INTO harness_shared.${csv.table} (${allCols}) ` +
          `SELECT ${allCols} FROM ${temp};`,
      );
    }
    tableStats.push({ table: csv.table, rowCount: -1 });
  }

  if (csvs.some((c) => c.table === 'projects')) {
    lines.push(
      `UPDATE harness_shared.project_spec_revisions ` +
        `SET project_id = project_id || '_fork_${args.forkSuffix}' ` +
        `WHERE project_id IN (` +
        `  SELECT id FROM harness_shared.projects ` +
        `  WHERE id LIKE '%_fork_${args.forkSuffix}'` +
        `);`,
    );
  }

  lines.push(`COMMIT;`);
  await fs.writeFile(sqlPath, lines.join('\n') + '\n');
  await psqlFile({ url: args.url, sqlPath });
  await fs.unlink(sqlPath).catch(() => {});
  return { tables: tableStats };
}

async function loadColumnLists(url: string): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  const out = await psqlQuery({
    url,
    sql:
      `SELECT table_name, column_name ` +
      `FROM information_schema.columns ` +
      `WHERE table_schema = 'harness_shared' ` +
      `ORDER BY table_name, ordinal_position`,
  });
  for (const row of out.split('\n')) {
    const [t, c] = row.split('|');
    if (!t || !c) continue;
    if (!m.has(t)) m.set(t, []);
    m.get(t)!.push(c);
  }
  return m;
}

function psqlQuery(args: { url: string; sql: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-A', '-q', '-tA', '-F', '|', '-c', args.sql, args.url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`psql failed (${code}): ${err.trim() || args.sql}`)),
    );
  });
}

function psqlFile(args: { url: string; sqlPath: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      ['-X', '--single-transaction', '--set=ON_ERROR_STOP=1', '-f', args.sqlPath, args.url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`psql -f failed (${code}): ${err.trim()}`)),
    );
  });
}
