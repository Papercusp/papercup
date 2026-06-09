/**
 * §15.6 step 7 — restore per-harness schema via ALTER SCHEMA flow.
 *
 *   7a. Detect target-slug collision; refuse if `harness_<new>` already exists.
 *   7b. Take Postgres advisory lock on `snapshot-restore:<original-slug>`
 *       so two concurrent restores can't trash each other.
 *   7c. Drop any leftover `harness_<original-slug>_restoring` from a half-failed prior.
 *   7d. Stream pg_dump SQL through a narrow sed (only 3 directive types —
 *       known, structured, fixed format) into a `_restoring` schema. NO
 *       content-substring replacement, so substring collisions (e.g.
 *       `sheets` inside `sheets-clone`) are impossible.
 *   7e. (handled in shared-row-restore.ts) Restore harness_shared subset
 *       with slug-prefixed IDs.
 *   7g. ALTER SCHEMA RENAME to final slug.
 *   7h. Release advisory lock.
 *
 * The lock is hashed via `hashtext()` so we can use `pg_advisory_lock(int)`.
 * Orphaned locks (process killed mid-restore) are cleaned by
 * `papercusp doctor --release-restore-locks`, not surfaced here.
 */

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import postgres from 'postgres';
import { assertValidSlug } from './shared-table-filters';

export class TargetSchemaExists extends Error {
  constructor(slug: string) {
    super(`schema harness_${slug} already exists locally; choose a different fork slug`);
    this.name = 'TargetSchemaExists';
  }
}

/**
 * Open a short-lived postgres-js connection. We deliberately don't share a
 * pool here — restore is a one-shot batch operation and the cost of a fresh
 * connection is negligible next to the multi-MB SQL apply that follows.
 */
function openSql(url: string) {
  return postgres(url, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
}

async function execStatement(url: string, sql: string): Promise<unknown[]> {
  const client = openSql(url);
  try {
    return (await client.unsafe(sql)) as unknown as unknown[];
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Apply a multi-statement SQL batch (typically rewritten pg_dump output) inside
 * a single transaction. Mirrors the behavior of `psql --single-transaction
 * --set=ON_ERROR_STOP=1 -f file.sql`: the whole batch commits atomically or
 * rolls back on any error.
 */
async function execBatchTransactional(url: string, sqlText: string): Promise<void> {
  const client = openSql(url);
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(sqlText);
    });
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function schemaExists(url: string, schema: string): Promise<boolean> {
  const r = (await execStatement(
    url,
    `SELECT 1 AS one FROM information_schema.schemata WHERE schema_name = '${schema}'`,
  )) as Array<{ one: number }>;
  return r.length > 0;
}

export async function takeRestoreLock(args: {
  url: string;
  originalSlug: string;
}): Promise<void> {
  // hashtext() returns int4; pg_advisory_lock(int4) uses the 32-bit form.
  await execStatement(
    args.url,
    `SELECT pg_advisory_lock(hashtext('snapshot-restore:${args.originalSlug}'))`,
  );
}

export async function releaseRestoreLock(args: {
  url: string;
  originalSlug: string;
}): Promise<void> {
  await execStatement(
    args.url,
    `SELECT pg_advisory_unlock(hashtext('snapshot-restore:${args.originalSlug}'))`,
  );
}

/**
 * §15.6 step 7d — boundary-anchored rewrite of pg_dump SQL.
 *
 * Two transformations:
 *
 * 1. Directive-line rewrites (full-line patterns):
 *    - `CREATE SCHEMA harness_<orig>;`          → comment out
 *    - `ALTER SCHEMA harness_<orig> OWNER TO `  → comment out
 *    - `SET search_path = harness_<orig>...;`   → swap target schema
 *
 * 2. Schema-qualified-identifier rewrite (anywhere in the file):
 *    - `harness_<orig>.<X>`                     → `<restoringSchema>.<X>`
 *
 *    This is *safe* even though it's a content-level rewrite, because
 *    the leading `harness_` prefix + trailing `.` are structural
 *    boundaries: an identifier `<orig>` can never appear inside another
 *    identifier `<other>` such that `harness_<orig>.` is a substring of
 *    `harness_<other>.` (PG's unquoted-identifier grammar wouldn't allow
 *    a dash or other unquoted-illegal char to separate them, and pg_dump
 *    quotes any identifier that needs it).
 *
 *    Without this rewrite, body lines like
 *      `CREATE TABLE harness_<orig>.foo (...)`
 *    fail with "permission denied for schema" because the original
 *    schema is owned by postgres_app, not the restoring user.
 *
 * Function bodies, COPY data, and quoted strings still pass through
 * unmodified — none of the substrate's harness_<slug> schemas use
 * stored procedures (§15.22 enforces that), so functions referencing
 * schema names by hardcoded string don't exist.
 */
export async function rewritePgDump(args: {
  inputPath: string; // .sql.gz
  outputPath: string; // .sql
  originalSlug: string;
  restoringSchema: string;
}): Promise<void> {
  assertValidSlug(args.originalSlug);
  const orig = args.originalSlug;
  const dst = args.restoringSchema;

  const reCreate = new RegExp(`^CREATE SCHEMA harness_${escapeRe(orig)};`);
  const reAlter = new RegExp(`^ALTER SCHEMA harness_${escapeRe(orig)} OWNER TO `);
  const reSetPath = new RegExp(`^SET search_path = harness_${escapeRe(orig)}([,;])`);
  // Schema-qualified identifier — boundary-anchored, see header comment.
  const reSchemaQual = new RegExp(`harness_${escapeRe(orig)}\\.`, 'g');

  const inputStream = createReadStream(args.inputPath).pipe(createGunzip());
  const outputStream = createWriteStream(args.outputPath);

  let buf = '';
  await pipeline(
    inputStream,
    async function* (source) {
      for await (const chunk of source) {
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          yield rewriteLine(line) + '\n';
          nl = buf.indexOf('\n');
        }
      }
      if (buf.length > 0) yield rewriteLine(buf);
    },
    outputStream,
  );

  function rewriteLine(line: string): string {
    if (reCreate.test(line)) return `-- (rewritten) ${line}`;
    if (reAlter.test(line)) return `-- (rewritten) ${line}`;
    // PG 17+ pg_dump emits `\restrict <token>` / `\unrestrict <token>` psql
    // meta-commands at the start/end of dumps. They're not valid SQL and
    // crash postgres-js with `syntax error at or near "\"`. Strip them.
    if (/^\\(?:restrict|unrestrict)\b/.test(line)) return `-- (stripped psql meta) ${line}`;
    const m = reSetPath.exec(line);
    if (m) {
      // SET search_path AND swap any further harness_<orig>. references on the line.
      return (
        `SET search_path = ${dst}${m[1]}` +
        line.slice(m[0].length).replace(reSchemaQual, `${dst}.`)
      );
    }
    return line.replace(reSchemaQual, `${dst}.`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * §15.6 7c+7d+7e+7g — full ALTER SCHEMA flow for the per-harness dump.
 *
 * Caller is expected to have already taken the advisory lock and verified
 * `harness_<newSlug>` doesn't yet exist.
 */
export async function applyPerHarnessDump(args: {
  url: string;
  originalSlug: string;
  newSlug: string;
  pgDumpPath: string; // path to state/db.sql.gz inside extracted staging
  workDir: string;
}): Promise<void> {
  assertValidSlug(args.originalSlug);
  assertValidSlug(args.newSlug);

  const restoring = `harness_${args.originalSlug}_restoring`;

  // 7c — drop any leftover restoring schema from a half-failed prior attempt.
  await execStatement(args.url, `DROP SCHEMA IF EXISTS ${restoring} CASCADE`);
  await execStatement(args.url, `CREATE SCHEMA ${restoring}`);

  // 7d — stream-rewrite the dump.
  const rewrittenPath = join(args.workDir, 'db-rewritten.sql');
  await rewritePgDump({
    inputPath: args.pgDumpPath,
    outputPath: rewrittenPath,
    originalSlug: args.originalSlug,
    restoringSchema: restoring,
  });

  // Apply atomically (postgres-js multi-statement, wrapped in a single tx).
  const rewritten = await fs.readFile(rewrittenPath, 'utf8');
  await execBatchTransactional(args.url, rewritten);
  await fs.unlink(rewrittenPath).catch(() => {});

  // 7g — atomic rename to final slug.
  const finalSchema = `harness_${args.newSlug}`;
  await execStatement(
    args.url,
    `ALTER SCHEMA ${restoring} RENAME TO ${finalSchema}`,
  );
}
