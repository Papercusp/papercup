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

/** The diagnostic fields worth surfacing from a failed query. */
export interface PgErrorInfo {
  /** `err.message` (always present). */
  message: string;
  /**
   * Postgres' `HINT:` — e.g. `Perhaps you meant to reference the column
   * "w.feature_id".` on a "column does not exist" error. The single most
   * useful field for an agent guessing a wrong column/table name.
   */
  hint?: string;
  /** Postgres' `DETAIL:` — extra context on the error. */
  detail?: string;
  /** The SQLSTATE code (e.g. `42703` = undefined_column, `42P01` = undefined_table). */
  code?: string;
  /** 1-based character position in the query text the error points at. */
  position?: string;
}

/**
 * Extract the useful diagnostic fields Postgres attaches to a query error —
 * hint / detail / code / position — which are otherwise dropped when only
 * `err.message` is surfaced. The postgres-js driver exposes these as lowercase
 * properties on the thrown error (`err.hint`, `err.detail`, `err.code`,
 * `err.position`); Postgres already emits, e.g.,
 * `HINT: Perhaps you meant to reference the column "w.feature_id"` on a
 * "column does not exist" error, so passing it through saves agents from
 * repeatedly guessing non-obvious column names (EI-8301). Safe on any thrown
 * value (Error, PgReadQueryError, or a non-Error).
 */
export function extractPgErrorInfo(err: unknown): PgErrorInfo {
  const message =
    err instanceof PgReadQueryError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const info: PgErrorInfo = { message };
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const str = (v: unknown): string | undefined => {
      if (typeof v === 'string') return v.length ? v : undefined;
      if (typeof v === 'number') return String(v);
      return undefined;
    };
    const hint = str(e.hint);
    const detail = str(e.detail);
    const code = str(e.code);
    const position = str(e.position);
    if (hint) info.hint = hint;
    if (detail) info.detail = detail;
    if (code) info.code = code;
    if (position) info.position = position;
  }
  return info;
}

// ── Point-of-use guard helpers (compaction-continuity-hardening-2026-07-07 P-005) ──
//
// Two recurring post-compaction footguns measured on live sessions: (a) 35×
// "column … does not exist" round-trips re-guessing column names a fresh
// context has no memory of, and (b) tenant-scoped tables filtered by a bare
// slug/id silently matching ANOTHER tenant's rows (the "~560 bugs" class —
// agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope). Both guards
// key off the tables a query REFERENCES, resolved against information_schema
// (canonical, never drifts) rather than a hardcoded table list.

/** Max table references considered by the guards (a fatter join list adds noise). */
const GUARD_MAX_TABLES = 4;
/** information_schema lookups are cached this long (schema changes are rare). */
const SCHEMA_HINT_CACHE_TTL_MS = 5 * 60_000;

/**
 * The table names a query references via FROM / JOIN, as written (optionally
 * schema-qualified), deduped case-insensitively, bounded. Regex over the
 * literal/comment-stripped text — best-effort: a quoted identifier or exotic
 * clause simply doesn't match (the guards then stay silent), never throws.
 */
export function extractReferencedTables(rawSql: string): string[] {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/gi;
  for (let m = re.exec(stripped); m && out.length < GUARD_MAX_TABLES; m = re.exec(stripped)) {
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

interface SchemaHintRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

/** Prefer the schema an agent almost certainly meant when a BARE table name
 *  matches several (per-harness schema clones make this common). */
function preferSchema(a: string, b: string): number {
  const rank = (s: string): number => (s === 'harness_shared' ? 0 : s === 'public' ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** One information_schema read for the referenced tables' columns, in ordinal
 *  order. Bare names are resolved to a single preferred schema. */
async function readReferencedColumns(
  tables: string[],
  client?: OrgSql,
): Promise<Map<string, { schema: string; columns: string[] }>> {
  const qualified = tables.filter((t) => t.includes('.'));
  const bare = tables.filter((t) => !t.includes('.'));
  const sql = client ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND (lower(table_schema || '.' || table_name) = ANY(${qualified})
            OR lower(table_name) = ANY(${bare}))
     ORDER BY table_schema, table_name, ordinal_position
  `) as unknown as SchemaHintRow[];

  // Group by schema.table, then pick ONE schema per referenced name.
  const bySchemaTable = new Map<string, { schema: string; table: string; columns: string[] }>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`.toLowerCase();
    let g = bySchemaTable.get(key);
    if (!g) {
      g = { schema: r.table_schema, table: r.table_name, columns: [] };
      bySchemaTable.set(key, g);
    }
    g.columns.push(r.column_name);
  }
  const byRef = new Map<string, { schema: string; columns: string[] }>();
  for (const g of bySchemaTable.values()) {
    const bareName = g.table.toLowerCase();
    const ref = qualified.includes(`${g.schema}.${g.table}`.toLowerCase())
      ? `${g.schema}.${g.table}`.toLowerCase()
      : bare.includes(bareName)
        ? bareName
        : null;
    if (!ref) continue;
    const existing = byRef.get(ref);
    if (!existing || preferSchema(g.schema, existing.schema) < 0) {
      byRef.set(ref, { schema: g.schema, columns: g.columns });
    }
  }
  return byRef;
}

/**
 * P-005(a): the canonical column lists of the tables a failed query references —
 * appended to a 42703 (undefined_column) error so the fix takes ONE round trip
 * instead of a guessing loop. Best-effort: returns [] on any miss.
 */
export async function describeReferencedTableColumns(
  rawSql: string,
  opts: { client?: OrgSql } = {},
): Promise<Array<{ table: string; columns: string[] }>> {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return [];
  const byRef = await readReferencedColumns(tables, opts.client);
  const out: Array<{ table: string; columns: string[] }> = [];
  for (const ref of tables) {
    const hit = byRef.get(ref);
    if (!hit) continue;
    const table = ref.includes('.') ? ref : `${hit.schema}.${ref}`;
    out.push({ table, columns: hit.columns });
  }
  return out;
}

interface TenantScopeInfo {
  hasWorkspaceId: boolean;
  hasHarnessSlug: boolean;
  at: number;
}

const tenantScopeCache = new Map<string, TenantScopeInfo>();

/** Test seam — drop the tenant-scope schema cache. */
export function clearTenantScopeSchemaCache(): void {
  tenantScopeCache.clear();
}

async function readTenantScopeInfo(
  tables: string[],
  client?: OrgSql,
): Promise<Map<string, TenantScopeInfo>> {
  const now = Date.now();
  const result = new Map<string, TenantScopeInfo>();
  const misses: string[] = [];
  for (const t of tables) {
    const cached = tenantScopeCache.get(t);
    if (cached && now - cached.at < SCHEMA_HINT_CACHE_TTL_MS) result.set(t, cached);
    else misses.push(t);
  }
  if (misses.length) {
    const byRef = await readReferencedColumns(misses, client);
    for (const t of misses) {
      const cols = byRef.get(t)?.columns ?? [];
      const info: TenantScopeInfo = {
        hasWorkspaceId: cols.includes('workspace_id'),
        hasHarnessSlug: cols.includes('harness_slug'),
        at: now,
      };
      tenantScopeCache.set(t, info);
      result.set(t, info);
    }
  }
  return result;
}

/**
 * P-005(b): a one-line advisory when a FILTERED query references a multi-tenant
 * table (live-schema-verified: it has a `workspace_id` / `harness_slug` column)
 * without any tenant predicate — the query still runs; the advisory rides the
 * result. Silent for unfiltered aggregates (no WHERE — usually a deliberate
 * cross-tenant count) and whenever the query already mentions a scope column.
 * Best-effort: any schema-read failure returns null.
 */
export async function buildTenantScopeAdvisory(
  rawSql: string,
  opts: { client?: OrgSql } = {},
): Promise<string | null> {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\bwhere\b/i.test(stripped)) return null;
  if (/\b(workspace_id|harness_slug)\b/i.test(stripped)) return null;
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;
  const info = await readTenantScopeInfo(tables, opts.client);
  const offenders: string[] = [];
  for (const t of tables) {
    const i = info.get(t);
    if (!i || (!i.hasWorkspaceId && !i.hasHarnessSlug)) continue;
    const cols = [i.hasWorkspaceId ? 'workspace_id' : null, i.hasHarnessSlug ? 'harness_slug' : null]
      .filter(Boolean)
      .join(' + ');
    offenders.push(`${t} (keyed by ${cols})`);
    if (offenders.length >= 3) break;
  }
  if (!offenders.length) return null;
  return (
    `⚠ tenant scope: ${offenders.join(', ')} — multi-tenant, but this filtered query has no ` +
    'workspace_id/harness_slug predicate — a bare slug/id filter can silently match ANOTHER ' +
    "tenant's rows and read as stale/diverged state. Add the scope predicate(s) " +
    '(agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).'
  );
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
