/**
 * pg-read-query — run an agent-supplied READ-ONLY SQL query against the
 * operator Postgres.
 *
 * WHY: plans, work-items, issues, observations, tool_invocations, scorecards,
 * recipes, … are PG-CANONICAL. The `*:list` tools and the `docs/plans/*.md`
 * files are just PROJECTIONS. Agents already know SQL well; constraining them
 * to per-tool `*:list` arg shapes means they hit "the filter I need isn't
 * exposed" and fall back to dumping a full list + jq-ing a projection. This
 * lets them query the datastore directly — without the footguns:
 *
 *   - READ ONLY transaction  → a write (INSERT/UPDATE/DDL) is rejected by PG,
 *     even though the admin client is write-capable. Documented write verbs
 *     remain the only mutation path (they emit audit + sync invalidation).
 *   - statement_timeout      → a runaway query can't wedge the pool.
 *   - LIMIT-wrap + row cap    → a fat result can't flood the agent's context.
 *   - pooled connection (getOrgPg) → no per-call connection open.
 *
 * The single-statement / SELECT|WITH guard is defense-in-depth + a friendlier
 * early error; the READ ONLY transaction is the real enforcement.
 */

import { getOrgPg } from '@papercusp/db-org';

/** The postgres-js client type the org handle exposes. */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface PgReadQueryResult {
  /** Rows, capped at `maxRows`. */
  rows: Record<string, unknown>[];
  /** Rows actually returned by the DB (after the internal LIMIT cap). */
  rowCount: number;
  /** True when the DB had more rows than `maxRows` (result was capped). */
  truncated: boolean;
  /** Column names (from the first row). */
  fields: string[];
  elapsedMs: number;
}

export class PgReadQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgReadQueryError';
  }
}

export const PG_READ_QUERY_DEFAULT_MAX_ROWS = 200;
export const PG_READ_QUERY_HARD_MAX_ROWS = 2000;
export const PG_READ_QUERY_DEFAULT_TIMEOUT_MS = 5000;
export const PG_READ_QUERY_HARD_TIMEOUT_MS = 30000;

/**
 * Strip SQL noise a naive `;`-scan would misread as a statement separator:
 * single-quoted string literals ('...' with '' escaping), double-quoted
 * identifiers ("..." with "" escaping), dollar-quoted strings ($$...$$ /
 * $tag$...$tag$), `--` line comments, and `/* … *\/` block comments. Quoted
 * content is replaced with an equal-length placeholder (never containing a
 * `;` or quote char) so position/structure is preserved for the caller's
 * `;`-count check — only the literal's TEXT is discarded, never executed.
 */
function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    // -- line comment: to end of line
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = len;
      i = j;
      continue;
    }
    // /* block comment */ (non-nested)
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? len : j + 2;
      i = j;
      continue;
    }
    // 'single-quoted string' — '' is an escaped quote
    if (ch === "'") {
      out += "''";
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // "double-quoted identifier" — "" is an escaped quote
    if (ch === '"') {
      out += '""';
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // $$...$$ / $tag$...$tag$ dollar-quoted string
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        out += 'x';
        i = end === -1 ? len : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Validate the query is a single read statement and return it trimmed (a
 * single trailing `;` is stripped). Throws PgReadQueryError otherwise. The
 * READ ONLY transaction is the real guard — this just rejects obvious misuse
 * early with a clear message. Quote-aware: a `;` inside a string literal /
 * quoted identifier / comment does NOT count as a statement separator (only
 * the LITERAL, unexecuted text is stripped for this check — the real query
 * below is unmodified).
 */
export function assertSingleReadStatement(raw: string): string {
  const q = raw.trim().replace(/;\s*$/, '').trim();
  if (!q) throw new PgReadQueryError('empty query');
  const noiseStripped = stripSqlLiteralsAndComments(q).trim();
  if (noiseStripped.includes(';')) {
    throw new PgReadQueryError(
      'only a single statement is allowed — remove the `;`-separated statements',
    );
  }
  if (!/^(select|with)\b/i.test(noiseStripped)) {
    throw new PgReadQueryError(
      'only SELECT / WITH…SELECT queries are allowed (this is a read-only surface; use the documented write verbs to change state)',
    );
  }
  return q;
}

/**
 * Execute a read-only query. The query is wrapped in `SELECT * FROM (…) LIMIT n+1`
 * so the row cap is enforced in the DB (not after pulling every row into memory).
 * A query whose output has duplicate column names must alias them (PG rejects a
 * subquery with duplicate output columns — a clear error the caller can fix).
 */
export async function pgReadQuery(
  rawQuery: string,
  opts: { maxRows?: number; timeoutMs?: number; client?: OrgSql } = {},
): Promise<PgReadQueryResult> {
  const query = assertSingleReadStatement(rawQuery);
  const maxRows = Math.max(
    1,
    Math.min(PG_READ_QUERY_HARD_MAX_ROWS, Math.trunc(opts.maxRows ?? PG_READ_QUERY_DEFAULT_MAX_ROWS)),
  );
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_QUERY_DEFAULT_TIMEOUT_MS)),
  );

  const sql = opts.client ?? getOrgPg().sql;
  const startedAt = Date.now();
  let rows: Record<string, unknown>[] = [];
  await sql.begin(async (tx) => {
    // READ ONLY must be set before the first data statement in the txn.
    await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    rows = (await tx.unsafe(
      `SELECT * FROM (${query}) AS _pgq LIMIT ${maxRows + 1}`,
    )) as unknown as Record<string, unknown>[];
  });
  const elapsedMs = Date.now() - startedAt;

  const truncated = rows.length > maxRows;
  const capped = truncated ? rows.slice(0, maxRows) : rows;
  const fields = capped.length ? Object.keys(capped[0]) : [];
  return { rows: capped, rowCount: capped.length, truncated, fields, elapsedMs };
}
