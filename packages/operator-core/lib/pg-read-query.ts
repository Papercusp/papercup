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

import { getOrgPg, getOrgPgLosslessBigint } from '@papercusp/db-org';

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
  data_type: string;
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
): Promise<Map<string, { schema: string; columns: string[]; typedColumns: string[] }>> {
  const qualified = tables.filter((t) => t.includes('.'));
  const bare = tables.filter((t) => !t.includes('.'));
  const sql = client ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND (lower(table_schema || '.' || table_name) = ANY(${qualified})
            OR lower(table_name) = ANY(${bare}))
     ORDER BY table_schema, table_name, ordinal_position
  `) as unknown as SchemaHintRow[];

  // Group by schema.table, then pick ONE schema per referenced name.
  const bySchemaTable = new Map<string, { schema: string; table: string; columns: string[]; typedColumns: string[] }>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`.toLowerCase();
    let g = bySchemaTable.get(key);
    if (!g) {
      g = { schema: r.table_schema, table: r.table_name, columns: [], typedColumns: [] };
      bySchemaTable.set(key, g);
    }
    g.columns.push(r.column_name);
    g.typedColumns.push(`${r.column_name}: ${r.data_type || 'unknown'}`);
  }
  const byRef = new Map<string, { schema: string; columns: string[]; typedColumns: string[] }>();
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
      byRef.set(ref, { schema: g.schema, columns: g.columns, typedColumns: g.typedColumns });
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
    out.push({ table, columns: hit.typedColumns });
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

interface TenantScopeOverride {
  /**
   * The columns that ACTUALLY scope this table — replaces the generic
   * workspace_id/harness_slug "already scoped" check for this table only.
   */
  requiredColumns: string[];
  /** One-line description of the real key, inserted after the table name. */
  keyDescription: string;
  /** The suggested predicate for this table, given resolved ids (falls back to a placeholder when unresolved). */
  suggest: (opts: { workspaceId?: string | null; harnessSlug?: string | null }) => string;
  /** A tool that already scopes this table correctly, if one exists. */
  preferredTool?: string;
}

/**
 * Tables whose REAL tenancy predicate differs from the generic "has a
 * workspace_id/harness_slug column" heuristic below — a column's PRESENCE in
 * information_schema is not evidence it is POPULATED (EI-18669912007336072).
 *
 * harness_shared.agent_facts is tenanted by `scope` + `scope_ref`;
 * `harness_slug` exists as a column but is NULL for ~99.6% of rows (facts are
 * scoped 'harness'/'workspace'/'owner'/'work_item'/'role' via scope_ref, not
 * harness_slug). The generic advisory's own suggested predicate
 * (`workspace_id = … AND harness_slug = …`) then matches ~0.4% of rows and
 * returns a clean-looking, confidence-inspiring EMPTY result instead of an
 * error — worse than no guardrail, because a trusted zero is never re-checked
 * (see the EI for the concrete audit this produced a false negative on).
 *
 * This is a deliberately HARDCODED semantic override (not schema-derived) —
 * update it if a table's real tenancy key changes.
 */
const TENANT_SCOPE_OVERRIDES: Record<string, TenantScopeOverride> = {
  agent_facts: {
    requiredColumns: ['scope', 'scope_ref'],
    keyDescription: 'scope + scope_ref — harness_slug is NULL for nearly all rows, do not filter on it',
    suggest: (opts) =>
      opts.harnessSlug
        ? `scope = 'harness' AND scope_ref = '${opts.harnessSlug.replaceAll("'", "''")}'`
        : "scope = '<harness|workspace|owner|work_item|role>' AND scope_ref = '<the matching id>'",
    preferredTool: 'facts:list (already scopes by scope + scope_ref)',
  },
};

/**
 * Tables whose `workspace_id` is a CORPUS NAMESPACE (always the literal
 * `'default'`, per `bash-substitution/report.ts`'s `ROLLUP_CORPUS_WORKSPACE`),
 * NOT a tenant discriminator — the generic workspace_id/harness_slug heuristic
 * below is actively wrong for them in two ways at once (EI-18749676091756794):
 *
 *   1. `harness_slug` does not exist as a column on these tables at all, so
 *      the generic "actionable" suggestion named a column PG then rejects
 *      with "column does not exist".
 *   2. Even after dropping that column, the real tenant workspace id (e.g.
 *      'papercusp-workspace') matches ZERO rows — every row is written under
 *      the literal 'default' — so "correcting" an unscoped query per the
 *      advisory turns a right answer into a silent, confidence-inspiring
 *      empty result.
 *
 * So for these tables an UNSCOPED read is the correct one; suppress the
 * generic advisory entirely rather than try to "fix" it into a still-wrong
 * predicate.
 */
const CORPUS_NAMESPACED_TABLES = new Set(['tool_usage_rollup', 'session_turns']);

/** The bare (unqualified) table name — `schema.table` → `table`. */
function bareTableName(ref: string): string {
  const i = ref.lastIndexOf('.');
  return i === -1 ? ref : ref.slice(i + 1);
}

interface DerivedColumnRedirect {
  /** Bare table the column is reached for on. */
  table: string;
  /** Why the column does not exist — and, where it applies, why no view can add it. */
  why: string;
  /** The surfaces that DO return the value, all projecting one derivation. */
  useInstead: string;
  /**
   * The plausible-but-WRONG columns an agent reaches for next when it is handed
   * only `knownColumns`. Naming them is the whole point: this registry exists
   * because the helpful error was steering people onto a documented-wrong signal.
   */
  notThese?: string;
}

/**
 * Columns an agent will reach for BY NAME — because every tool surface, doc and
 * playbook teaches them as the canonical vocabulary — but which are DERIVED at
 * read time and have no column to select (EI-18801042715296007).
 *
 * ⚠ THE FAILURE MODE IS NOT THE ERROR, IT IS THE RECOVERY. A 42703 here is loud
 * and its `knownColumns` list is genuinely accurate. But on `coord_presence` the
 * columns that DO exist are `heartbeat_at` / `last_active_at` — precisely the raw
 * process-keepalive signals the platform documents as NOT the liveness verdict.
 * So the most helpful thing the error could say ("here are the real columns")
 * hands the agent the wrong signal, and the natural next query returns a
 * confident wrong answer instead of an error. A warm-dead session reads
 * `heartbeatFresh: true` with `sessionState: 'ended'`; from SQL alone those are
 * indistinguishable, and nothing tells you they are.
 *
 * ⚠ AND WHY A VIEW IS NOT THE CHEAP FIX. The obvious repair — expose the verdict
 * as a `coord_presence_live` view or generated column so the SQL vocabulary
 * matches the tool vocabulary — CANNOT be done faithfully. `sessionState` is
 * assembled from six legs (see `agent-tools/coordination/liveness-oracle.ts`)
 * and two of them are not data in Postgres at all: a `kill(pid, 0)` syscall
 * against the subject's own host, and the box-local in-process psu-pty host
 * registry. A SQL re-derivation could only cover the other legs, so it would
 * disagree with every tool — reintroducing the "same agent, different verdict
 * per surface" defect that `presence-derivation-unification-2026-07-17` was
 * built to eliminate, and doing it behind something that LOOKS authoritative
 * because it sits in SQL next to the real columns. A wrong answer nobody
 * re-checks is worse than a loud error, which is why this is a redirect and not
 * a view.
 *
 * Keyed `<bare table>.<column>`. Deliberately HARDCODED semantics, like
 * TENANT_SCOPE_OVERRIDES above — update it when a derivation moves.
 */
const DERIVED_COLUMN_REDIRECTS: Record<string, DerivedColumnRedirect> = {
  'coord_presence.session_state': {
    table: 'harness_shared.coord_presence',
    why:
      'it is DERIVED at read time by one shared oracle, not stored, and no view can add it — ' +
      'two of the six legs are not in Postgres at all (a kill(pid,0) probe against the ' +
      "subject's own host, and the box-local psu-pty host registry), so a SQL re-derivation " +
      'would silently disagree with every tool',
    useInstead:
      "coord:presence · fleet:assignments · coord:roster { view:'live' } · fleet:status · " +
      'fleet:leader-brief (all project the SAME derivation)',
    notThese:
      'heartbeat_at / last_active_at — raw process-keepalive freshness, explicitly NOT the ' +
      "liveness verdict: a warm-dead session reads heartbeatFresh:true with sessionState:'ended', " +
      'and from SQL alone you cannot tell it from a live one',
  },
  'coord_presence.wakeable': {
    table: 'harness_shared.coord_presence',
    why: 'it is derived per read from event_awaits + agent_activity, not stored on the presence row',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.live_turn': {
    table: 'harness_shared.coord_presence',
    why: 'it is derived per read from event_awaits + agent_activity, not stored on the presence row',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.confirm_liveness': {
    table: 'harness_shared.coord_presence',
    why: 'it is a function of the derived sessionState (draining/suspect need a fresh required wake), not a stored flag',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.heartbeat_fresh': {
    table: 'harness_shared.coord_presence',
    // Unlike the others this one IS computable in SQL — the redirect exists to
    // stop you computing it and then reading it as liveness, which is the same
    // wrong-signal trap one step further along.
    why:
      'it is computed from heartbeat_at (freshness within the stale window), not stored — but ' +
      'note it is a process-keepalive signal, NOT the liveness verdict',
    useInstead:
      'sessionState via coord:presence / fleet:assignments if you want the VERDICT; compute ' +
      'freshness from heartbeat_at only if you genuinely want raw keepalive',
  },
};

/**
 * P-005(c): turn a 42703 that names a DERIVED column into a redirect rather than
 * a dead end. Returns null unless the failing column is a registered derivation
 * on a table this query actually references. Best-effort and purely textual — it
 * never suppresses the underlying error, it rides alongside it.
 */
export function buildDerivedColumnRedirect(rawSql: string, errorMessage: string): string | null {
  // PG spells this two ways: `column "session_state" does not exist` (bare) and
  // `column p.session_state does not exist` (qualified by alias — unquoted).
  const m = /column\s+"?(?:([a-z_][a-z0-9_$]*)\.)?([a-z_][a-z0-9_$]*)"?\s+does not exist/i.exec(
    errorMessage,
  );
  const column = m?.[2]?.toLowerCase();
  if (!column) return null;

  const referenced = extractReferencedTables(rawSql).map(bareTableName);
  for (const table of referenced) {
    const hit = DERIVED_COLUMN_REDIRECTS[`${table}.${column}`];
    if (!hit) continue;
    return (
      `⚠ \`${column}\` is DERIVED, not stored: ${hit.table} has no such column because ${hit.why}. ` +
      (hit.notThese ? `⛔ Do NOT fall back to ${hit.notThese}. ` : '') +
      `→ Use ${hit.useInstead}. ` +
      '(agent-tools/coordination/liveness-oracle.ts · EI-18801042715296007)'
    );
  }
  return null;
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
  opts: { client?: OrgSql; workspaceId?: string | null; harnessSlug?: string | null } = {},
): Promise<string | null> {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\bwhere\b/i.test(stripped)) return null;
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  const mentions = (col: string): boolean => new RegExp(`\\b${col}\\b`, 'i').test(stripped);
  const genericMentioned = mentions('workspace_id') || mentions('harness_slug');

  // Tables with a hardcoded per-table override (a real tenancy key that
  // differs from the generic workspace_id/harness_slug heuristic) get their
  // OWN "already scoped" check — a query filtering agent_facts by scope_ref
  // but not harness_slug must still be recognized as correctly scoped, and a
  // query filtering agent_facts by harness_slug alone must still be flagged
  // (that's the exact wrong-predicate footgun this override exists to catch).
  const overrideTables = tables.filter((t) => TENANT_SCOPE_OVERRIDES[bareTableName(t)]);
  const genericTables = tables.filter((t) => !TENANT_SCOPE_OVERRIDES[bareTableName(t)]);

  const overrideOffenders: Array<{ table: string; override: TenantScopeOverride }> = [];
  for (const t of overrideTables) {
    const override = TENANT_SCOPE_OVERRIDES[bareTableName(t)]!;
    if (override.requiredColumns.some(mentions)) continue; // already correctly scoped
    overrideOffenders.push({ table: t, override });
  }

  const genericOffenders: Array<{ table: string; hasWorkspaceId: boolean; hasHarnessSlug: boolean }> = [];
  if (genericTables.length && !genericMentioned) {
    const info = await readTenantScopeInfo(genericTables, opts.client);
    for (const t of genericTables) {
      if (CORPUS_NAMESPACED_TABLES.has(bareTableName(t))) continue; // see CORPUS_NAMESPACED_TABLES doc
      const i = info.get(t);
      if (!i || (!i.hasWorkspaceId && !i.hasHarnessSlug)) continue;
      genericOffenders.push({ table: t, hasWorkspaceId: i.hasWorkspaceId, hasHarnessSlug: i.hasHarnessSlug });
      if (genericOffenders.length >= 3) break;
    }
  }

  if (!overrideOffenders.length && !genericOffenders.length) return null;

  const parts: string[] = [];

  for (const { table, override } of overrideOffenders.slice(0, 3)) {
    parts.push(
      `⚠ tenant scope: ${table} (keyed by ${override.keyDescription}) — multi-tenant, but this ` +
        `filtered query has no ${override.requiredColumns.join('/')} predicate — a bare slug/id ` +
        "filter can silently match ANOTHER tenant's rows and read as a clean-looking " +
        `empty/stale result rather than an error. Add: ${override.suggest(opts)}.` +
        (override.preferredTool ? ` Or use ${override.preferredTool}.` : '') +
        ' (agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope, EI-18669912007336072).',
    );
  }

  if (genericOffenders.length) {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    // Per-table: only name/suggest a column this SPECIFIC table actually has —
    // never blindly append harness_slug (or workspace_id) from opts, since a
    // sibling table in the same joined query can lack one of them (the exact
    // "names a nonexistent column" shape of EI-18749676091756794).
    for (const off of genericOffenders) {
      const cols = [off.hasWorkspaceId ? 'workspace_id' : null, off.hasHarnessSlug ? 'harness_slug' : null]
        .filter(Boolean)
        .join(' + ');
      const suggested: string[] = [];
      if (off.hasWorkspaceId && opts.workspaceId) suggested.push(`workspace_id = ${quote(opts.workspaceId)}`);
      if (off.hasHarnessSlug && opts.harnessSlug) suggested.push(`harness_slug = ${quote(opts.harnessSlug)}`);
      const actionable = suggested.length
        ? ` Add: ${suggested.join(' AND ')}.`
        : ` Add the resolved ${cols.replaceAll(' + ', '/')} scope predicate(s).`;
      parts.push(
        `⚠ tenant scope: ${off.table} (keyed by ${cols}) — multi-tenant, but this filtered query has no ` +
          `${cols.replaceAll(' + ', '/')} predicate — a bare slug/id filter can silently match ANOTHER ` +
          `tenant's rows and read as stale/diverged state.${actionable} ` +
          '(agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).',
      );
    }
  }

  return parts.join(' ');
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
 *
 * Defaults to `getOrgPgLosslessBigint()`, NOT `getOrgPg()` — this is arbitrary
 * agent-authored SQL, so a bigint/int8 column (a `pg_stat_statements.queryid`, a
 * snowflake id, …) must come back at EXACT precision rather than silently rounded
 * to the nearest representable `number` past 2^53 (EI-18789855771421275: the
 * rounded value is a syntactically valid bigint that matches zero rows — a
 * confidence-inspiring empty result, not an error). Pass `opts.client` to use a
 * different connection (e.g. a test fixture) — it is NOT defaulted to
 * getOrgPg() and callers overriding it should apply the same lossless-bigint
 * consideration if they pass a client that has the bigint→number override installed.
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

  const sql = opts.client ?? getOrgPgLosslessBigint().sql;
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

/**
 * Schema-validate a read-only statement against live PG WITHOUT executing it or
 * materializing any rows: parses + plans it via `EXPLAIN (COSTS OFF)` inside the same
 * READ ONLY / statement_timeout-bounded transaction `pgReadQuery` uses. A malformed
 * table/column/function reference surfaces the identical PG error info
 * (extractPgErrorInfo — hint/detail/code/position) a real run would, at zero cost and
 * with zero side effects.
 *
 * Built for EI-10514: schema-checking embedded SQL "replication drills" in rubric
 * criteria at propose time — 10/14 pot-coordination-health drills referenced
 * renamed/nonexistent tables and were unrunnable as written, and nothing caught it
 * until someone tried to actually run one.
 */
export async function explainReadQuery(
  rawQuery: string,
  opts: { timeoutMs?: number; client?: OrgSql } = {},
): Promise<{ ok: true } | { ok: false; error: PgErrorInfo }> {
  let query: string;
  try {
    query = assertSingleReadStatement(rawQuery);
  } catch (err) {
    return { ok: false, error: extractPgErrorInfo(err) };
  }
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_QUERY_DEFAULT_TIMEOUT_MS)),
  );
  const sql = opts.client ?? getOrgPg().sql;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await tx.unsafe(`EXPLAIN (COSTS OFF) ${query}`);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: extractPgErrorInfo(err) };
  }
}

/**
 * A relation's shape — the `\d` answer, as data.
 *
 * WHY THIS EXISTS (plan bash-to-tool-substitution-2026-07-26, P-011): `\d` is a
 * psql CLIENT meta-command, not SQL, so it cannot be passed through
 * `dev:pg_query`'s statement path at all. The 2026-07-26 bash audit measured 88
 * `psql -c "\d …"` atoms with NO tool form — the single largest psql residue —
 * so an agent inspecting a table's columns, indexes or constraints had to shell
 * out no matter how well-routed it was.
 */
export interface RelationDescription {
  /** Resolved `schema.name`. */
  relation: string;
  /** table | view | materialized view | index | sequence … */
  kind: string;
  columns: Array<{ name: string; type: string; nullable: boolean; default: string | null }>;
  indexes: Array<{ name: string; definition: string }>;
  constraints: Array<{ name: string; type: string; definition: string }>;
}

const RELATION_KIND: Record<string, string> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  i: 'index',
  S: 'sequence',
  p: 'partitioned table',
  f: 'foreign table',
  c: 'composite type',
  t: 'TOAST table',
};

const CONSTRAINT_TYPE: Record<string, string> = {
  p: 'PRIMARY KEY',
  f: 'FOREIGN KEY',
  u: 'UNIQUE',
  c: 'CHECK',
  x: 'EXCLUDE',
  t: 'TRIGGER',
  // PG 17+ materialises NOT NULL as a real pg_constraint row (contype 'n').
  // Without this the describe output showed a bare "n" for over half the
  // constraints on a typical table.
  n: 'NOT NULL',
};

interface RelationRow {
  schema: string;
  name: string;
  relkind: string;
}

/**
 * Resolve a possibly-bare relation reference to exactly one relation, using the
 * SAME schema preference as the query column-hint path — so `describe:
 * "work_items"` and a query mentioning `work_items` can never disagree about
 * which table they mean.
 */
async function resolveRelation(ref: string, client?: OrgSql): Promise<RelationRow | null> {
  const sql = client ?? getOrgPg().sql;
  const lower = ref.toLowerCase();
  const dot = lower.indexOf('.');
  const schemaPart = dot === -1 ? null : lower.slice(0, dot);
  const namePart = dot === -1 ? lower : lower.slice(dot + 1);

  const rows = (await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND lower(c.relname) = ${namePart}
       AND (${schemaPart}::text IS NULL OR lower(n.nspname) = ${schemaPart}::text)
     ORDER BY n.nspname
  `) as unknown as RelationRow[];

  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => preferSchema(a.schema, b.schema))[0];
}

/**
 * Describe one relation: columns, indexes and constraints in one shape.
 * Returns null when the relation does not exist, so the caller can say so
 * plainly instead of returning a confusingly empty description.
 */
export async function describeRelation(
  ref: string,
  opts: { client?: OrgSql } = {},
): Promise<RelationDescription | null> {
  const sql = opts.client ?? getOrgPg().sql;
  const relation = await resolveRelation(ref, opts.client);
  if (!relation) return null;

  const columnRows = (await sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = ${relation.schema} AND table_name = ${relation.name}
     ORDER BY ordinal_position
  `) as unknown as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;

  const indexRows = (await sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = ${relation.schema} AND tablename = ${relation.name}
     ORDER BY indexname
  `) as unknown as Array<{ indexname: string; indexdef: string }>;

  const constraintRows = (await sql`
    SELECT con.conname AS name, con.contype::text AS contype, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${relation.schema} AND c.relname = ${relation.name}
     ORDER BY con.conname
  `) as unknown as Array<{ name: string; contype: string; definition: string }>;

  return {
    relation: `${relation.schema}.${relation.name}`,
    kind: RELATION_KIND[relation.relkind] ?? relation.relkind,
    columns: columnRows.map((r) => ({
      name: r.column_name,
      type: r.data_type || 'unknown',
      nullable: r.is_nullable === 'YES',
      default: r.column_default,
    })),
    indexes: indexRows.map((r) => ({ name: r.indexname, definition: r.indexdef })),
    constraints: constraintRows.map((r) => ({
      name: r.name,
      type: CONSTRAINT_TYPE[r.contype] ?? r.contype,
      definition: r.definition,
    })),
  };
}

/**
 * List relations matching a pattern — the bare `\d` / `\dt` answer.
 * `*` (or an empty pattern) lists everything outside the system schemas.
 */
export async function listRelations(
  pattern: string,
  opts: { client?: OrgSql; limit?: number } = {},
): Promise<Array<{ relation: string; kind: string }>> {
  const sql = opts.client ?? getOrgPg().sql;
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  // Translate the psql glob (`*`, `?`) into a SQL LIKE pattern.
  const like = pattern === '' || pattern === '*' ? '%' : pattern.toLowerCase().replace(/\*/g, '%').replace(/\?/g, '_');

  const rows = (await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND (lower(n.nspname || '.' || c.relname) LIKE ${like} OR lower(c.relname) LIKE ${like})
     ORDER BY n.nspname, c.relname
     LIMIT ${limit}
  `) as unknown as RelationRow[];

  return rows.map((r) => ({
    relation: `${r.schema}.${r.name}`,
    kind: RELATION_KIND[r.relkind] ?? r.relkind,
  }));
}
