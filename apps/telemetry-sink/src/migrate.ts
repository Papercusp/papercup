/**
 * One-shot migration runner for the telemetry sink. Applies every
 * sql/*.sql file in lexicographic order, idempotently (each file is
 * CREATE ... IF NOT EXISTS / CREATE OR REPLACE so re-runs are safe).
 *
 * Track applied files in papercusp_telemetry.schema_migrations so a
 * future migration that's destructive (DROP, ALTER without IF EXISTS)
 * can be guarded against double-application.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from './storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

async function main() {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS papercusp_telemetry;
    CREATE TABLE IF NOT EXISTS papercusp_telemetry.schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sha256     TEXT NOT NULL
    );
  `);

  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const body = await readFile(join(sqlDir, file), 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    const existing = await sql<{ filename: string }[]>`
      SELECT filename FROM papercusp_telemetry.schema_migrations WHERE filename = ${file}
    `;
    if (existing.length > 0) {
      console.log(`  skip ${file} (already applied)`);
      continue;
    }
    console.log(`  apply ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO papercusp_telemetry.schema_migrations (filename, sha256) VALUES (${file}, ${sha})`;
    });
  }
  console.log('done.');
  await sql.end();
}

main().catch((e) => {
  console.error('migration failed:', e);
  process.exit(1);
});
