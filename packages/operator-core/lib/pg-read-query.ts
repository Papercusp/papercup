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
 *   - TimeZone = UTC          → date_trunc/::date bucket on UTC boundaries, so a
 *     rendered `…T00:00:00.000Z` label is TRUE (EI-19397658288924647, below).
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

/**
 * Distinct from {@link PgReadQueryError}: thrown when the WHOLE call (connect +
 * acquire + execute) failed to settle within its deadline, as opposed to a real
 * PG-side error. See {@link withCallDeadline} for why this must be its own
 * class rather than reusing a generic timeout message — a caller (dev:pg_query)
 * needs to tell "the query ran and PG said no" apart from "we never found out"
 * (EI-19415142351884573).
 */
export class PgReadQueryTimeoutError extends PgReadQueryError {
  constructor(message: string) {
    super(message);
    this.name = 'PgReadQueryTimeoutError';
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
  tenantPopulationCache.clear();
}

/**
 * VERIFY-BEFORE-PRESCRIBE — does the predicate we are about to recommend
 * actually match any rows? (plan false-premise-in-prescriptive-artifacts-2026-08-02
 * P-003; canonical instance EI-19324633485547042.)
 *
 * ## Why this exists
 *
 * The generic advisory below infers a predicate from `information_schema`: the
 * table HAS a `workspace_id` column, therefore scope by `workspace_id = <the
 * session's workspace>`. That is a PREMISE, not an observation, and it has now
 * been measured false on at least three unrelated tables:
 *
 *   - `agent_facts`  — `harness_slug` is NULL for ~99.6% of rows (EI-18669912007336072)
 *   - `event_awaits` / `event_wake_deliveries` / `event_key_fires` — every row is
 *     the literal `'default'` (WI-6847: 0 rows returned against 32,152 and 37,756
 *     real rows; EI-19324633485547042 for the third)
 *   - `test_runs` — CI rows are env-stamped and NULL on both keys (EI-19324633485547042:
 *     25,214 pass + 246 fail rows, all NULL)
 *
 * Each was handled by ADDING THE TABLE TO A HARDCODED LIST, which costs one
 * agent-incident per table discovered and leaves every not-yet-discovered table
 * armed. The failure is also the dangerous direction: the advisory exists to stop
 * you reading ANOTHER tenant's rows (wrong but visible), and applying it here
 * produces an EMPTY result — and a zero is never re-checked, because it reads as
 * "no rows exist" rather than "your predicate is wrong".
 *
 * The code comment above `TENANT_SCOPE_OVERRIDES` already names the exact defect
 * — "a column's PRESENCE in information_schema is not evidence it is POPULATED" —
 * so the knowledge was never missing; only the check was. This probe supplies it:
 * one bounded `EXISTS` per table, asking the question the advisory was assuming
 * the answer to.
 *
 * FAILS OPEN in every direction. A probe error, a timeout, an unparseable
 * relation name, or an unresolved session workspace all yield `null`, which
 * restores exactly the pre-existing behaviour. A guard against false-empty
 * results must never itself become a reason the advisory stops firing.
 */
interface TenantPopulation {
  /** Does the table have ANY rows? An empty table makes the hit-test meaningless. */
  hasRows: boolean;
  /** Does the PRESCRIBED workspace_id predicate match ≥1 row? null = not probed. */
  workspaceIdHit: boolean | null;
  /** Does the PRESCRIBED harness_slug predicate match ≥1 row? null = not probed. */
  harnessSlugHit: boolean | null;
  /** What the rows are ACTUALLY keyed by — so a miss can name the right value. */
  actualWorkspaceIds: string[];
  actualHarnessSlugs: string[];
  at: number;
}

const tenantPopulationCache = new Map<string, TenantPopulation>();

/** Population changes far faster than schema, so it caches for less time. */
const TENANT_POPULATION_CACHE_TTL_MS = 60_000;

/**
 * Relation names are interpolated (PG cannot parameterize an identifier), so they
 * are hard-validated first. Anything that is not a plain `schema.table` of word
 * characters is refused outright rather than escaped — this probe is an optional
 * enrichment, so declining is free, while a clever escape is not.
 */
const SAFE_RELATION_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

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
 * Tables whose `workspace_id` is a CORPUS NAMESPACE — always the literal
 * `'default'` (for `tool_usage_rollup`/`session_turns`, per
 * `bash-substitution/report.ts`'s `ROLLUP_CORPUS_WORKSPACE`; for
 * `event_awaits`/`event_wake_deliveries` the column simply defaults to
 * `'default'` at the DDL level — libs/papercusp/libs/db/sql/163-await-event-
 * subscriptions.sql — and, per WI-6847, is measurably 100% `'default'` in
 * practice too; `event_key_fires` is the same DDL-default pattern —
 * libs/papercusp/libs/db/sql/632-event-key-fire-latch.sql — confirmed
 * 100% `'default'` across 16,935 rows and no `harness_slug` column at all,
 * per the second confirmed instance in EI-19324633485547042) — NOT a tenant
 * discriminator. The generic workspace_id/harness_slug heuristic below is
 * actively wrong for these tables in two ways at once
 * (EI-18749676091756794, WI-6847, EI-19324633485547042):
 *
 *   1. `harness_slug` does not exist as a column on these tables at all, so
 *      the generic "actionable" suggestion named a column PG then rejects
 *      with "column does not exist".
 *   2. Even after dropping that column, the real tenant workspace id (e.g.
 *      'papercusp-workspace') matches ZERO rows — every row is written under
 *      the literal 'default' — so "correcting" an unscoped query per the
 *      advisory turns a right answer into a silent, confidence-inspiring
 *      empty result. Measured 2026-08-02 (WI-6847): a workspace_id-scoped
 *      read of event_awaits returned 0 rows against 32,152 real rows, and
 *      event_wake_deliveries the same against 37,756 real rows.
 *
 * So for these tables an UNSCOPED read is the correct one; suppress the
 * generic advisory entirely rather than try to "fix" it into a still-wrong
 * predicate.
 *
 * ⚠ Deliberately a hardcoded per-table registry, like TENANT_SCOPE_OVERRIDES
 * above, NOT a runtime-derived check (e.g. "does this column have exactly one
 * distinct value") — that would require a live cardinality probe on every
 * advisory call for every referenced table, on the hot query path. Extend
 * this set when another table is found to have the same defect; verify with
 * a real `count(*) GROUP BY workspace_id` first (per-table, as WI-6847 did),
 * since `work_items`/`harness_plans` and friends ARE genuinely multi-tenant
 * and must keep the advisory.
 */
const CORPUS_NAMESPACED_TABLES = new Set([
  'tool_usage_rollup',
  'session_turns',
  // EI-20103748074297088. Added after the per-table verification this doc prescribes:
  // measured 2026-08-10, 603,723 rows, ALL under 'default', 21 distinct owners, current to
  // the minute. The writer hardcodes it (search/session-ingest.ts insertParts) and says why
  // — 'default' is the transcript CORPUS namespace, not a tenant.
  //
  // Its absence here was expensive in a way the sibling entries were not: session_turn_parts
  // is the ONLY place native client tools (Edit/Write/Bash) are recorded, so it is exactly
  // where someone lands after tool_invocations gives them a false zero for the same question.
  // The generic advisory fired and suggested the tenant predicate, which returns 0 of 603,723
  // rows — a SECOND false zero that reads as confirmation of the first.
  //
  // Checked at the same time and deliberately NOT added: session_turn_journal is genuinely
  // mixed (10,453 'default' vs 4,706 'papercusp-workspace'), so the advisory is right about
  // it. session_turns is 362,038 vs 15 strays — already here, correctly.
  'session_turn_parts',
  'event_awaits',
  'event_wake_deliveries',
  'event_key_fires',
]);

/**
 * `harness_shared.test_runs` (EI-19324633485547042) does NOT fit either registry above. Unlike
 * {@link CORPUS_NAMESPACED_TABLES}, its `workspace_id`/`harness_slug` columns are NOT always-wrong
 * — rows ingested through the per-hive Tests-tab route (migration 413) genuinely carry real,
 * multi-tenant values. But every row from the CI / dogfood-admin-ui vitest reporter — the
 * population that matters for GATE triage — has BOTH columns NULL by construction: they are
 * env-derived (`libs/test-config/src/admin-test-runs-reporter.ts`) and that writer never stamps
 * them. So the generic heuristic's own signal of "correctly scoped" (the query MENTIONS
 * workspace_id/harness_slug) is backwards here: adding that predicate — exactly what the generic
 * advisory used to suggest — silently excludes every CI/gate row and returns a clean-looking empty
 * result, indistinguishable from "no failures". `source`/`commit_sha` are the columns that actually
 * discriminate a gate row, so `test_runs` is excluded from the generic/override checks below and
 * gets its own advisory ({@link buildTestRunsAdvisory}) that clears ONLY on those two columns —
 * firing even when workspace_id/harness_slug ARE present, since their presence is the trap, not the
 * fix.
 */
const TEST_RUNS_TABLE = 'test_runs';

/**
 * Independent advisory for {@link TEST_RUNS_TABLE} — see its doc comment for why this can't be
 * expressed as a {@link TENANT_SCOPE_OVERRIDES} entry (those suppress on "any required column
 * mentioned"; here workspace_id/harness_slug mentioned is exactly the failure this warns about).
 * Fires whenever `test_runs` is referenced with a WHERE clause and neither `source` nor
 * `commit_sha` is mentioned; returns null once either is present (the caveat's own fix).
 */
function buildTestRunsAdvisory(stripped: string, tables: string[]): string | null {
  if (!tables.some((t) => bareTableName(t) === TEST_RUNS_TABLE)) return null;
  const mentions = (col: string): boolean => new RegExp(`\\b${col}\\b`, 'i').test(stripped);
  if (mentions('source') || mentions('commit_sha')) return null;
  return (
    '⚠ harness_shared.test_runs: workspace_id/harness_slug are NULL-by-design for CI/dogfood-reporter ' +
    'rows (env-derived — libs/test-config/src/admin-test-runs-reporter.ts — and stamped ONLY by the ' +
    'per-hive Tests-tab ingestion route, migration 413). A workspace_id/harness_slug predicate therefore ' +
    "silently EXCLUDES every CI/gate row and reads as a clean 'no failures' — for CI/gate triage scope by " +
    "source/commit_sha instead. Also: status values are 'pass'/'fail'/'skip', NOT 'passed'/'failed' — " +
    "status <> 'passed' matches every row (EI-19324633485547042)."
  );
}

/** The bare (unqualified) table name — `schema.table` → `table`. */
export function bareTableName(ref: string): string {
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
  'coord_presence.intent_stale': {
    table: 'harness_shared.coord_presence',
    // Especially trap-shaped: the row DOES carry `intent` and `last_active_at`,
    // so a fallback here looks like it works. It just applies a threshold of
    // your own choosing instead of INTENT_STALE_SEC, and diverges quietly.
    why:
      'it is computed per read by computeIntentStale (presence-tier1.ts) from last_active_at ' +
      'against INTENT_STALE_SEC, not stored — the row carries the intent TEXT, never its staleness',
    useInstead: "coord:presence (Tier-1 LIVENESS lane) · coord:roster { view:'live' }",
    notThese:
      'a hand-rolled `now() - last_active_at > <your own interval>` — it will not match ' +
      "INTENT_STALE_SEC, so your idea of a stalled claim silently differs from every tool's",
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
  const column = parseMissingColumnName(errorMessage);
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

/**
 * A small registry for physical-column names that are routinely confused with
 * the platform vocabulary. Unlike a derived-column redirect, these values are
 * real columns on the relation; the failure is that the caller used the name
 * from a different projection/table family. Keep this separate from
 * `DERIVED_COLUMN_REDIRECTS` so the error does not claim a stored value is
 * computed at read time.
 */
const SCHEMA_COLUMN_REDIRECTS: ReadonlyArray<{
  relation: string;
  missing: string;
  actual: string;
  scope: string;
}> = [
  {
    relation: 'routines',
    missing: 'harness_slug',
    actual: 'install_slug',
    scope: 'workspace_id',
  },
];

/**
 * Turn a 42703 caused by a known cross-table vocabulary mismatch into an
 * actionable retry hint. This deliberately handles only a single referenced
 * relation: with joins, the same missing name can be valid on another table and
 * a false redirect is worse than the generic `knownColumns` payload.
 */
export function buildSchemaColumnRedirect(rawSql: string, errorMessage: string): string | null {
  const column = parseMissingColumnName(errorMessage);
  if (!column) return null;

  const referenced = extractReferencedTables(rawSql);
  if (referenced.length !== 1) return null;

  const relation = bareTableName(referenced[0]);
  const hit = SCHEMA_COLUMN_REDIRECTS.find(
    (entry) => entry.relation === relation && entry.missing === column,
  );
  if (!hit) return null;

  return (
    `⚠ \`${hit.missing}\` is not a column on ${referenced[0]} — this relation uses ` +
    `\`${hit.actual}\` as its installation key. Retry with \`${hit.actual}\` and scope ` +
    `by \`${hit.scope}\` as well. ` +
    '(live schema contract; see harness_shared.routines)'
  );
}

/**
 * The failing column name out of a 42703. PG spells it two ways: `column
 * "session_state" does not exist` (bare) and `column p.session_state does not
 * exist` (qualified by alias — unquoted).
 *
 * Shared by every 42703 advisory on purpose. Two advisories with two copies of
 * this regex can disagree about WHICH name failed and then contradict each
 * other in the same error payload, which costs more than either one saves.
 */
export function parseMissingColumnName(errorMessage: string): string | null {
  const m = /column\s+"?(?:([a-z_][a-z0-9_$]*)\.)?([a-z_][a-z0-9_$]*)"?\s+does not exist/i.exec(
    errorMessage,
  );
  return m?.[2]?.toLowerCase() ?? null;
}

/** Rows sampled per jsonb column when probing for a nested key. Bounded because
 *  this runs on an ERROR path — a hint is never worth a table scan. */
const JSONB_PROBE_SAMPLE_ROWS = 200;
/** Most (table, jsonb column) pairs probed for one failed query. */
const JSONB_PROBE_MAX_COLUMNS = 3;

/** Quote an identifier that came from `information_schema` (so it is real, and
 *  the escape is belt-and-braces rather than the only defence). */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * P-015: turn a 42703 whose name actually lives INSIDE a jsonb column into the
 * accessor that reaches it, instead of a column list that cannot contain it.
 *
 * ## Why `knownColumns` alone is not enough here
 *
 * `knownColumns` answers "what columns exist", which is the right answer to a
 * misspelling and the WRONG answer to a nesting mistake — and nesting is the
 * common case on this schema, where the interesting fields are folded into a
 * `payload` jsonb. `harness_shared.work_items` is the canonical instance: it has
 * NO `severity` column (it lives at `payload->'_ei'->>'severity'`, migration
 * 374's fold) and no `_completionEvidence` column either. An agent handed the
 * column list sees `payload` among thirty names with nothing marking it as the
 * place its field went, and the documented outcome is a rewritten query that
 * returns NULL for every row WITHOUT erroring — a well-formed, plausible, wrong
 * answer, which is strictly worse than the loud 42703 it replaced.
 *
 * ## Why this probes DATA and does not carry a registry
 *
 * The sibling advisory above (`DERIVED_COLUMN_REDIRECTS`) is hardcoded because
 * its subject is a derivation that exists only in TypeScript — no query could
 * find it. This one is the opposite: the answer is sitting in the rows. A
 * registry of known nested keys would go stale the moment anyone folds a new
 * field into a payload, and would be silent for exactly the fields nobody has
 * documented yet. Anchoring to the PROPERTY (a jsonb value that has this key)
 * rather than to a curated list of names is what makes it cover the fields we
 * have not thought of — the same widening rule the module-pin lint had to learn.
 *
 * Best-effort throughout: any miss returns null and the underlying 42703 is
 * reported unchanged. It never suppresses the real error, it rides alongside it.
 */
export async function buildJsonbPathRedirect(
  rawSql: string,
  errorMessage: string,
  opts: { client?: OrgSql } = {},
): Promise<string | null> {
  const column = parseMissingColumnName(errorMessage);
  if (!column) return null;

  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;
  const byRef = await readReferencedColumns(tables, opts.client);

  // If the name IS a real column on some referenced table, the query's problem
  // is scope/aliasing, not nesting — say nothing rather than send the reader
  // hunting through a payload for a column they already have.
  for (const hit of byRef.values()) {
    if (hit.columns.some((c) => c.toLowerCase() === column)) return null;
  }

  const candidates: Array<{ schema: string; table: string; column: string }> = [];
  for (const ref of tables) {
    const hit = byRef.get(ref);
    if (!hit) continue;
    const bare = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
    for (const typed of hit.typedColumns) {
      const at = typed.lastIndexOf(':');
      if (at === -1) continue;
      if (!/^\s*(jsonb|json)\s*$/i.test(typed.slice(at + 1))) continue;
      candidates.push({ schema: hit.schema, table: bare, column: typed.slice(0, at).trim() });
    }
  }
  if (!candidates.length) return null;

  const sql = opts.client ?? getOrgPg().sql;
  for (const c of candidates.slice(0, JSONB_PROBE_MAX_COLUMNS)) {
    // Depth 1 (`payload -> key`) and depth 2 (`payload -> parent -> key`) in one
    // statement. Two levels is where the real folds live (`payload._ei.severity`)
    // and each extra level multiplies the sample cost for a sharply thinner
    // return. `jsonb_exists(v, $1)` rather than the `?` operator: `?` is a
    // placeholder character in several drivers, and this string is handed to
    // `unsafe`, so the function form removes the question entirely.
    const rel = `${quoteIdent(c.schema)}.${quoteIdent(c.table)}`;
    const col = quoteIdent(c.column);
    const probe =
      `WITH s AS (SELECT ${col}::jsonb AS v FROM ${rel} ` +
      `WHERE ${col} IS NOT NULL LIMIT ${JSONB_PROBE_SAMPLE_ROWS}) ` +
      `(SELECT 1 AS depth, NULL::text AS parent FROM s ` +
      `WHERE jsonb_typeof(s.v) = 'object' AND jsonb_exists(s.v, $1) LIMIT 1) ` +
      `UNION ALL ` +
      `(SELECT 2 AS depth, e.key AS parent FROM s, LATERAL jsonb_each(s.v) e ` +
      `WHERE jsonb_typeof(s.v) = 'object' AND jsonb_typeof(e.value) = 'object' ` +
      `AND jsonb_exists(e.value, $1) LIMIT 1) ` +
      `ORDER BY depth LIMIT 1`;
    const rows = (await sql.unsafe(probe, [column]).catch(() => [])) as unknown as Array<{
      depth: number;
      parent: string | null;
    }>;
    const found = Array.isArray(rows) ? rows[0] : undefined;
    if (!found) continue;

    const path =
      found.depth === 2 && found.parent
        ? `${c.column}->'${found.parent}'->>'${column}'`
        : `${c.column}->>'${column}'`;
    const existsPred =
      found.depth === 2 && found.parent
        ? `${c.column}->'${found.parent}' ? '${column}'`
        : `${c.column} ? '${column}'`;
    return (
      `⚠ \`${column}\` is NOT a column on ${c.schema}.${c.table} — it is a key INSIDE the ` +
      `\`${c.column}\` jsonb column (found by sampling ${JSONB_PROBE_SAMPLE_ROWS} rows). ` +
      `→ Read it as \`${path}\`; test presence with \`${existsPred}\`. ` +
      `⛔ Do NOT conclude from \`knownColumns\` that the field does not exist — that list is ` +
      `columns only, so a nested key is invisible to it. ⚠ The accessor is bound to THIS ` +
      `relation: the same field on a sibling VIEW may be exploded into a real column, and the ` +
      `wrong accessor for a relation returns NULL for EVERY row without erroring.`
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
 * Probe whether the prescription would actually match rows — see
 * {@link TenantPopulation}. One bounded query per table; `null` = fail open.
 *
 * The DISTINCT sample is taken from a bounded window rather than the whole
 * relation: it only has to be good enough to NAME the real key in a hint, and an
 * unbounded `SELECT DISTINCT` on a hot multi-million-row table would cost far
 * more than the advisory is worth.
 */
async function probeTenantPopulation(
  table: string,
  info: TenantScopeInfo,
  resolved: { workspaceId?: string | null; harnessSlug?: string | null },
  client?: OrgSql,
): Promise<TenantPopulation | null> {
  if (!SAFE_RELATION_RE.test(table)) return null;
  const checkWs = info.hasWorkspaceId && !!resolved.workspaceId;
  const checkHs = info.hasHarnessSlug && !!resolved.harnessSlug;
  if (!checkWs && !checkHs) return null;

  const cached = tenantPopulationCache.get(table);
  if (cached && Date.now() - cached.at < TENANT_POPULATION_CACHE_TTL_MS) return cached;

  const params: string[] = [];
  const selects: string[] = [`EXISTS (SELECT 1 FROM ${table}) AS has_rows`];
  if (checkWs) {
    params.push(resolved.workspaceId!);
    selects.push(`EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = $${params.length}) AS ws_hit`);
    selects.push(
      `(SELECT array_agg(DISTINCT v) FROM (SELECT workspace_id::text AS v FROM ${table} ` +
        `WHERE workspace_id IS NOT NULL LIMIT 500) s) AS ws_vals`,
    );
  }
  if (checkHs) {
    params.push(resolved.harnessSlug!);
    selects.push(`EXISTS (SELECT 1 FROM ${table} WHERE harness_slug = $${params.length}) AS hs_hit`);
    selects.push(
      `(SELECT array_agg(DISTINCT v) FROM (SELECT harness_slug::text AS v FROM ${table} ` +
        `WHERE harness_slug IS NOT NULL LIMIT 500) s) AS hs_vals`,
    );
  }

  try {
    const sql = client ?? getOrgPg().sql;
    const rows = (await sql.unsafe(`SELECT ${selects.join(', ')}`, params)) as unknown as Array<{
      has_rows: boolean;
      ws_hit?: boolean;
      hs_hit?: boolean;
      ws_vals?: string[] | null;
      hs_vals?: string[] | null;
    }>;
    const r = rows[0];
    if (!r) return null;
    const pop: TenantPopulation = {
      hasRows: !!r.has_rows,
      workspaceIdHit: checkWs ? !!r.ws_hit : null,
      harnessSlugHit: checkHs ? !!r.hs_hit : null,
      actualWorkspaceIds: (r.ws_vals ?? []).slice(0, 3),
      actualHarnessSlugs: (r.hs_vals ?? []).slice(0, 3),
      at: Date.now(),
    };
    tenantPopulationCache.set(table, pop);
    return pop;
  } catch {
    // Fail OPEN — an unprobed table keeps the pre-existing advisory verbatim.
    return null;
  }
}

/**
 * PURE: turn a probe result into the advisory this table actually warrants.
 *
 * Three outcomes, and the middle one is the whole point:
 *   - `prescribe` — the predicate matches rows; emit the advisory unchanged.
 *   - `refute`    — the table HAS rows and the predicate matches NONE of them.
 *                   Emitting the prescription here manufactures a false empty,
 *                   so it is replaced by a warning naming the real key.
 *   - `silent`    — nothing useful to say (empty table, or unprobed).
 *
 * Exported for unit tests: this decision is the load-bearing one, and it is worth
 * pinning without a database.
 */
export function classifyTenantPrescription(
  pop: TenantPopulation | null,
  opts: { checkedWorkspaceId: boolean; checkedHarnessSlug: boolean },
): { kind: 'prescribe' | 'silent' } | { kind: 'refute'; column: string; actual: string[] } {
  if (!pop || !pop.hasRows) return { kind: 'prescribe' };
  if (opts.checkedWorkspaceId && pop.workspaceIdHit === false) {
    return { kind: 'refute', column: 'workspace_id', actual: pop.actualWorkspaceIds };
  }
  if (opts.checkedHarnessSlug && pop.harnessSlugHit === false) {
    return { kind: 'refute', column: 'harness_slug', actual: pop.actualHarnessSlugs };
  }
  return { kind: 'prescribe' };
}

/** The advisory emitted when the prescription is REFUTED by the table's own rows. */
export function refutedTenantAdvisory(
  table: string,
  column: string,
  prescribed: string,
  actual: string[],
): string {
  const actualNote = actual.length
    ? `its rows are keyed ${actual.map((v) => `'${v}'`).join(' / ')}${actual.length >= 3 ? ' (sampled)' : ''}`
    : `every row has ${column} NULL`;
  return (
    `⚠ tenant scope: ${table} has rows, but NONE match ${column} = '${prescribed}' — ` +
    `${actualNote}. Do NOT add that predicate: it would return an empty result that reads ` +
    'like "no rows exist" rather than "wrong predicate". Scope by the real key above, or ' +
    'query unscoped. (verify-before-prescribe, EI-19324633485547042.)'
  );
}

/**
 * P-005(b): a one-line advisory when a FILTERED query references a multi-tenant
 * table (live-schema-verified: it has a `workspace_id` / `harness_slug` column)
 * without any tenant predicate — the query still runs; the advisory rides the
 * result. Silent for unfiltered aggregates (no WHERE — usually a deliberate
 * cross-tenant count) and whenever the query already mentions a scope column.
 * Best-effort: any schema-read failure returns null.
 */
/**
 * Half-open [from, to) ranges of every string literal and comment in `sql`.
 *
 * The sibling of stripSqlLiteralsAndComments for callers that must match on the
 * literal's CONTENT (a jsonb key) rather than ignore it: same scanning rules,
 * but it reports WHERE the literals are instead of erasing them.
 */
function sqlLiteralAndCommentRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const len = sql.length;
  let i = 0;
  while (i < len) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = len;
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? len : j + 2;
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // '' — an escaped quote, still inside the literal
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      ranges.push([start, i]);
      continue;
    }
    i++;
  }
  return ranges;
}

interface SilentNullPathTrap {
  /** Bare relation the trap applies to. */
  relation: string;
  /** JSON path prefix that is ALWAYS null on this relation, as it appears in SQL. */
  pathRe: RegExp;
  /** Human form of the path, for the message. */
  path: string;
  /** Why it is always null here. */
  why: string;
  /** What to select instead. */
  useInstead: string;
}

/**
 * Accessors that are VALID SQL, run without error, and evaluate to NULL for
 * EVERY row of a specific relation — so the query returns a well-formed,
 * plausible, WRONG answer with no signal that it is wrong (WI-6674).
 *
 * ⚠ THIS IS THE OPPOSITE FAILURE MODE TO DERIVED_COLUMN_REDIRECTS ABOVE. That
 * registry improves the RECOVERY from a loud 42703. This one exists because
 * there is no error at all: `payload->'_ei'->>'severity'` is a legal jsonb
 * traversal, and a missing key yields NULL rather than raising. A
 * `WHERE payload->'_ei'->>'severity' = 'critical'` audit over engineer_issues
 * therefore returns zero rows, which reads exactly like "there are no
 * criticals" — measured 2026-08-01 as 0 of 13,711 open rows carrying a
 * severity, against 13,711 via the real column and 30 genuine criticals.
 *
 * ⚠ AND WHY THE VIEW IS NOT CHANGED TO MAKE BOTH PATHS WORK. The obvious
 * repair — stop subtracting `_ei` so `payload->'_ei'` resolves on the view too
 * — is declined for the same reason the redirect above is not a view. The view
 * deliberately EXPLODES `_ei` into real columns (severity, source,
 * found_during, linked_feature_id, created_by, assigned_by, signal_origin) and
 * then removes the raw nested copy (`payload - '_ei'`), so each value has
 * exactly ONE representation on the relation. Re-adding the blob would put all
 * seven fields on the view twice, change the payload shape every existing
 * reader of the view already sees, and make the wrong accessor silently
 * CORRECT — which teaches the wrong vocabulary rather than retiring it. The
 * accessor is not made to work; it is made to announce itself.
 *
 * Deliberately HARDCODED semantics, like the two registries above — update it
 * when a projection moves.
 */
const SILENT_NULL_PATH_TRAPS: SilentNullPathTrap[] = [
  {
    relation: 'engineer_issues',
    // payload -> '_ei'  (any spacing, single or double quoted key)
    pathRe: /payload\s*->\s*['"]_ei['"]/i,
    path: "payload->'_ei'",
    why:
      "this VIEW subtracts the blob (`payload - '_ei'`) after exploding every _ei sub-field " +
      'into a real COLUMN, so the path resolves to NULL for EVERY row — the query succeeds and ' +
      'returns a plausible wrong answer instead of an error',
    useInstead:
      'the columns on this view directly — severity · source · found_during · ' +
      'linked_feature_id · created_by · assigned_by · signal_origin ' +
      "(the payload->'_ei'->>'…' form is correct ONLY against the underlying " +
      'harness_shared.work_items TABLE, which has no severity column). Or prefer ' +
      'work_items:list { severity } / work_items:claimable',
  },
  {
    // `kind` vs `item_kind` on the TABLE. Both columns exist, so there is no
    // error — but `kind` is effectively dead: measured 2026-08-02 on
    // harness_shared.work_items, it is non-null on 3 of 28,255 rows (0.01%)
    // while `item_kind` is non-null on all 28,255. So `WHERE kind='bug'`
    // returns ~nothing and reads exactly like "there are no bugs".
    //
    // Scoped to PREDICATE position on purpose (`kind =`, `kind IN`, `kind IS`)
    // rather than any mention. A projection or alias — `coalesce(item_kind,'?')
    // AS kind`, `GROUP BY kind` — is a legitimate and common shape, and this
    // file's own tenant-scope note is explicit that a false advisory is worse
    // than none because it teaches the reader to stop trusting advisories. The
    // predicate is also the shape that actually bit: it silently returns zero.
    relation: 'work_items',
    pathRe: /\bkind\s*(?:=|<>|!=|~|\bin\b|\bis\b)/i,
    path: 'kind',
    why:
      'the `kind` column on this TABLE is effectively unused — non-null on 3 of 28,255 rows ' +
      '(measured 2026-08-02), while `item_kind` is populated on every row. The classifier you ' +
      'want is item_kind (bug / change / task / feature / chunk)',
    useInstead:
      '`item_kind` for the bug/change/task/feature split. Also note that item_kind alone is not ' +
      "the real-work filter: ~84% of open rows are payload->>'lane' = 'observation' (turn-end " +
      'notes that by design never enter the queue), so a backlog count needs BOTH ' +
      "item_kind AND coalesce(payload->>'lane','') <> 'observation'. Or prefer work_items:list / " +
      'work_items:claimable, whose claimableCount already applies every floor',
  },
  {
    // The lane discriminator lives at the TOP level of payload, never under
    // `_ei`. Measured 2026-08-02 on harness_shared.work_items: `payload ? 'lane'`
    // is true for 12,694 rows, `payload->'_ei' ? 'lane'` for ZERO. A backlog
    // query that reads the _ei form silently classifies every observation as
    // real work — the exact inversion that makes an 11,970-row observation lane
    // look like a bug backlog.
    relation: 'work_items',
    pathRe: /payload\s*->\s*['"]_ei['"]\s*->>?\s*['"]lane['"]/i,
    path: "payload->'_ei'->>'lane'",
    why:
      "`lane` is stored at the TOP level of payload, not inside the _ei blob — payload ? 'lane' " +
      "is true for 12,694 rows and payload->'_ei' ? 'lane' for 0 (measured 2026-08-02), so this " +
      'accessor is NULL for every row and every observation silently counts as real work',
    useInstead:
      "`payload->>'lane'` (the `_ei` blob carries severity/source/found_during, not lane)",
  },
];

/**
 * Flag a read whose accessor is always-NULL on the relation it targets.
 *
 * Unlike the tenant-scope advisory this does NOT require a WHERE clause: a bare
 * `SELECT payload->'_ei'->>'severity' … ` projection is just as wrong, and an
 * aggregate (`count(*) FILTER (WHERE …)`) is the shape that actually bit — it
 * reports 0 rather than returning none.
 */
export function buildSilentNullPathAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  // ⚠ Deliberately NOT stripSqlLiteralsAndComments here. The jsonb key IS a
  // string literal (`payload->'_ei'`), so the stripper — correct for the
  // tenant-scope advisory, which only looks for bare column names — erases the
  // very token this trap matches on. Instead match the RAW sql and discard any
  // hit that STARTS inside a literal or comment, which keeps the one
  // false-positive that matters (the path quoted inside a WHERE title = '…')
  // out without blinding the check.
  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideLiteral = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to);

  const parts: string[] = [];
  for (const trap of SILENT_NULL_PATH_TRAPS) {
    const hit = tables.find((t) => bareTableName(t) === trap.relation);
    if (!hit) continue;
    const scan = new RegExp(trap.pathRe.source, 'gi');
    let real = false;
    for (let m = scan.exec(rawSql); m; m = scan.exec(rawSql)) {
      if (!startsInsideLiteral(m.index)) {
        real = true;
        break;
      }
    }
    if (!real) continue;
    parts.push(
      `⚠ always-NULL accessor: ${hit} — this query reads \`${trap.path}\`, but ${trap.why}. ` +
        `Use ${trap.useInstead}. A predicate on this path matches ZERO rows, which reads exactly ` +
        'like "there are none" (WI-6674).',
    );
  }

  return parts.length ? parts.join(' ') : null;
}

/**
 * Flag a read that treats `status = 'open'` (or the candidate VIEW) as the
 * answer to "what can be claimed".
 *
 * WHY THIS IS A DIFFERENT TRAP FROM THE TWO ABOVE. The tenant-scope and
 * always-NULL advisories catch a query that is WRONG. This one catches a query
 * that is RIGHT about a different question — which is worse, because the result
 * is well-formed, plausible, and off by an order of magnitude.
 *
 * The distinction is structural, not a naming accident, and it is why no column
 * or view can ever settle it:
 *
 *   - `status = 'open'` is LIFECYCLE. It is item-intrinsic and durable — a fact
 *     about the row, storable as a column. Legitimately needed.
 *   - `harness_shared.work_items_claimable` (migration 654) is the QUERYABLE
 *     SSOT for the CALLER-INDEPENDENT floors — "claimable by someone". It is the
 *     right target for raw SQL, and an anti-drift integration test binds it to
 *     the real claim path so the two cannot silently diverge.
 *   - `work_items:claimable` answers "claimable by ME, NOW" — the triple
 *     (item, CALLER, MOMENT).
 *
 * Migration 654 omits the per-claim floors from the view DELIBERATELY, and says
 * why: cross-machine-rig, swarm-affinity, redundancy and release-cooldown
 * "depend on the CLAIMING caller's capability/spec, not the row, so a generic
 * 'claimable by someone' predicate cannot bake them in". The view is therefore
 * neither a clean upper nor lower bound on what YOU can claim: it OVER-admits by
 * omitting those per-claim floors, and UNDER-admits on the federated-origin leg,
 * which uses the fail-safe form that "only ever UNDER-admits". Say exactly that
 * rather than implying a direction — a confidently-wrong bound is the failure
 * mode this file exists to prevent.
 *
 * Deliberately NOT quoting a fixed overcount multiplier: the ratio moves with
 * the backlog (and differs per harness), and a stale number in an advisory is
 * the same class of confidently-wrong artifact. Point at the queryable SSOT and
 * the tool instead, both of which compute the live figure.
 *
 * Matched against RAW sql for the same reason as the always-NULL advisory: the
 * interesting token is a string literal (`'open'`), which the stripper erases.
 */
export function buildClaimabilityAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');

  // The SSOT VIEW. Reading it is CORRECT for raw SQL — this is a scope note, not
  // a reprimand: it answers "claimable by someone", not "claimable by me now".
  const viewHit = tables.find((t) => bareTableName(t) === 'work_items_claimable');
  if (viewHit) {
    return (
      `ⓘ caller-independent scope: ${viewHit} is the queryable SSOT for the floors that depend only on ` +
      'the ROW — the right target for raw SQL. It deliberately omits the PER-CLAIM floors ' +
      '(cross-machine-rig, swarm-affinity, redundancy, release-cooldown) because those depend on the ' +
      'claiming caller, so it answers "claimable by someone", not "claimable by ME now". It is neither a ' +
      'clean upper nor lower bound on your own claimable set: it over-admits by omitting those floors, and ' +
      'under-admits on the federated-origin leg (fail-safe form). For "what can I claim right now" plus a ' +
      'per-floor `excludedBreakdown`, use work_items:claimable { harness }.'
    );
  }

  // The TABLE + a status='open' predicate: the shape that reads as "the backlog".
  const tableHit = tables.find((t) => bareTableName(t) === 'work_items');
  if (!tableHit) return null;

  // `status = 'open'`, `status IN ('open', …)`, `status = ANY(ARRAY['open', …])`.
  const openPredicate = /\bstatus\b\s*(?:=|\bin\b|=\s*any)\s*\(?\s*(?:array\s*\[\s*)?'open'/gi;
  let hasOpenPredicate = false;
  for (let m = openPredicate.exec(rawSql); m; m = openPredicate.exec(rawSql)) {
    if (!startsInsideComment(m.index)) {
      hasOpenPredicate = true;
      break;
    }
  }
  if (!hasOpenPredicate) return null;

  // Already going through the real floor function (or the claimable tool's own
  // SQL)? Then the caller knows the difference — say nothing.
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (/\bwork_item_claim_floors\b/i.test(stripped)) return null;

  return (
    `⚠ status='open' is LIFECYCLE, not claimability: ${tableHit} — 'open' means "not terminal", and the ` +
    'real claim path ANDs ~12 further floors on top. Counting open rows therefore OVERCOUNTS claimable ' +
    'work, silently and by a wide margin. Two correct targets, depending on the question: for RAW SQL use ' +
    'harness_shared.work_items_claimable (migration 654 — the queryable SSOT, bound to the real claim path ' +
    'by an anti-drift test); for "what can I claim RIGHT NOW" use work_items:claimable { harness }, which ' +
    'adds the floors that depend on the CALLER and the MOMENT (cross-machine-rig, swarm-affinity, ' +
    'redundancy, release-cooldown, your claim SPEC) and returns a per-floor `excludedBreakdown`. Those ' +
    'caller-relative floors are why claimability cannot be a column at all.'
  );
}

/**
 * The relation → covering-tool map behind {@link buildToolRoutingAdvisory}
 * (plan `sql-escape-tool-routing-2026-08-12`, P-001).
 *
 * ⚠ WHY THIS EXISTS WHEN `seeAlso` ALREADY DOES. `dev:pg_query` declares a
 * static `seeAlso` list (shipped budget-free by
 * `claimable-read-tool-and-sql-encapsulation-audit-2026-07-21` P-004). That was
 * the right call for prompt weight, but it is emitted IDENTICALLY on every call
 * regardless of the query — so an agent reading `harness_shared.routines` is
 * told about `work_items:claimable`. Measured 2026-08-12 over 14 days
 * (`harness_shared.tool_invocations`, workspace `papercusp-workspace`): 15,854
 * calls from 381 distinct agents, 98.6% SUCCEEDING. This is not a failure
 * signal — agents route around the catalog successfully, which is exactly why
 * it went unnoticed. ~286 of those agents were hand-querying relations that
 * already had a good covering tool.
 *
 * So the nudge channel already fires ~15.9k times; it was simply never aimed.
 * This registry aims it.
 *
 * ⚠ EVERY VERB HERE WAS VERIFIED AGAINST THE LIVE TOOL REGISTRY, not recalled.
 * Routing an agent to a phantom verb is strictly worse than the raw SQL it
 * replaces: the SQL works, and the phantom costs a round trip and teaches a
 * name that does not exist. When adding a row, confirm the verb resolves
 * (`agent_tools:list` / the `defineTool` name — note some are declared with
 * DOUBLE quotes, so a single-quote grep under-reports and reads as absence).
 *
 * ⚠ `gives` states what the TOOL adds over the raw read — the reason to switch.
 * A row that cannot say that does not belong here: "there is also a tool" is
 * noise on a hot path, and an advisory nobody acts on trains agents to skim
 * past the ones that matter.
 */
interface ToolRoute {
  /** The verb(s) that answer this relation's hot read. */
  tool: string;
  /** What the tool adds over reading the table directly. */
  gives: string;
}

export const TOOL_ROUTING_BY_TABLE: Record<string, ToolRoute> = {
  work_items: {
    tool: 'work_items:list / work_items:get',
    gives: 'server-side filters, batch id fetch, and the payload/threads projection',
  },
  harness_plans: {
    tool: 'plans:list / plans:get / plans:items',
    gives: 'recency filters, groupBy/aggregateOnly counts, and section-scoped reads',
  },
  routines: {
    tool: 'routines:list',
    gives: 'cadence + active state + the deliberate-pause record { reason, by, at }, and rollup:true for the per-group view',
  },
  coord_presence: {
    tool: 'coord:presence / fleet:assignments',
    gives: "the derived sessionState verdict — the raw heartbeat columns here are NOT liveness (a warm-dead session reads heartbeatFresh:true, sessionState:'ended')",
  },
  agent_presence: {
    tool: 'coord:presence',
    gives: 'the one shared liveness oracle every surface derives from',
  },
  coord_event_log: {
    tool: 'coord:feed / coord:catch-up',
    gives: 'audience-scoped history with membership gating, instead of raw envelope rows',
  },
  coord_messages: {
    tool: 'coord:feed / coord:catch-up',
    gives: 'audience-scoped history with membership gating',
  },
  coord_thread_posts: {
    tool: 'coord:catch-up',
    gives: 'the bounded per-audience catch-up rather than a raw post scan',
  },
  tool_invocations: {
    tool: 'activity:tool-log / dev:telemetry / dev:tool_cooccurrence',
    gives: 'per-tool rollups (count, error rate, p50/p95) and the compact per-session call log',
  },
  adv_sessions: {
    tool: 'sessions:search / sessions:timeline',
    gives: 'hybrid semantic search over transcripts, tolerant of a paraphrase',
  },
  session_turns: {
    tool: 'sessions:search / sessions:timeline',
    gives: 'hybrid semantic search with surrounding context',
  },
  session_briefs: {
    tool: 'sessions:search',
    gives: 'meaning-based retrieval instead of a substring scan',
  },
  agent_facts: {
    tool: 'facts:list',
    gives: 'scope resolution + TTL/retraction handling, so a stale fact is not read as standing',
  },
  engineer_issues: {
    tool: 'improvements:digest',
    gives: 'scored + deduped triage with the auto-eligible / needs-human split',
  },
  task_ledger: {
    tool: 'processes:list',
    gives: 'provenance — who launched it, for which work-item, and what it costs',
  },
  memory_canonical: {
    tool: 'memory:search',
    gives: 'embedding recall rather than a literal match over stored text',
  },
  goals: {
    tool: 'goals:list / goals:get',
    gives: 'the goal record with its rationale, kill-criteria and attached pots',
  },
  harness_registry: {
    tool: 'harness:status',
    gives: 'live status for one or many harnesses in one call',
  },
  pipeline_events: {
    tool: 'dev:pipeline_position / release:trace',
    gives: "blockedOn + nextAction + per-stage health — a boolean per stage cannot say whether that stage is MOVING",
  },
};

/** A query that reads exactly one relation and does nothing analytic with it. */
export interface PlainSingleRelationRead {
  /** The bare relation name — `harness_shared.work_items` → `work_items`. */
  relation: string;
  /** The relation exactly as the query wrote it, schema qualifier and all. */
  asWritten: string;
}

/**
 * THE answer to "what single relation does this query plainly read" — and
 * deliberately the ONLY one in the tree.
 *
 * Two consumers need this judgement and they must not disagree: the in-tool
 * routing advisory below (P-001), and the SQL corpus atomizer that decides which
 * substitution pair claims a sampled query
 * (`bash-substitution/sql-corpus.ts`, P-007). A second implementation would be a
 * second answer to "what does this query read", so the advisory an agent sees at
 * the point of the query and the audit that decides whether that advisory is
 * EARNED could drift — which is the D-001 failure ("a routing advisory must never
 * out-run the tool's actual coverage") re-created one layer down.
 *
 * ⚠ DELIBERATELY CONSERVATIVE, and the conservatism is the point. `dev:pg_query`
 * exists for genuinely ad-hoc analysis, and that traffic is CORRECT — a
 * cross-table join or a group-by is the tool working as intended. The shape this
 * recognises is the one the audit actually found: a plain
 * `SELECT … FROM <one table> WHERE …`, which is what an agent writes when it does
 * not know the verb exists.
 *
 * Returns null for anything else, including a query whose relations the regex
 * extractor could not resolve. Silence on an unparseable query is the correct
 * failure direction for both consumers: the advisory says nothing, and the
 * corpus atom goes unclaimed rather than being attributed to a pair that never
 * covered it.
 */
export function plainSingleRelationRead(rawSql: string): PlainSingleRelationRead | null {
  const tables = extractReferencedTables(rawSql);
  if (tables.length !== 1) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);

  // Analytic shapes are `dev:pg_query`'s legitimate job — no verb covers them.
  if (/\bgroup\s+by\b/i.test(stripped)) return null;
  if (/\bover\s*\(/i.test(stripped)) return null;
  if (/\b(?:count|sum|avg|min|max|percentile_cont|array_agg|jsonb_agg|string_agg)\s*\(/i.test(stripped)) return null;
  if (/\bexplain\b/i.test(stripped)) return null;
  // A join against a second relation the extractor folded away (a lateral, a
  // set-returning function) is still analysis, not a plain read.
  if (/\bjoin\b|\blateral\b|\bunion\b|\bintersect\b|\bexcept\b/i.test(stripped)) return null;

  return { relation: bareTableName(tables[0]), asWritten: tables[0] };
}

/**
 * "A tool already answers this read" — the aimed replacement for the static
 * `seeAlso` footer (P-001).
 *
 * ⚠ DELIBERATELY CONSERVATIVE: fires ONLY on a single-relation, non-analytic
 * read — see {@link plainSingleRelationRead}, which is where that judgement
 * lives and which the P-007 SQL corpus atomizer shares, so the advisory and the
 * audit that earns it cannot drift apart.
 *
 * Returns null (stays silent) when the caller is already going through a
 * dedicated advisory for that relation, so the specific warning is never
 * crowded by the generic one.
 */
export function buildToolRoutingAdvisory(rawSql: string): string | null {
  const read = plainSingleRelationRead(rawSql);
  if (!read) return null;

  const bare = read.relation;
  const route = TOOL_ROUTING_BY_TABLE[bare];
  if (!route) return null;

  // Let the dedicated claimability advisory own the work_items claim shape —
  // it says something strictly more specific than "there is a list tool".
  if (bare === 'work_items' && buildClaimabilityAdvisory(rawSql)) return null;

  return `ⓘ a tool covers this read: ${route.tool} — ${route.gives}. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.`;
}

/** Native client tools — the ones an agent here actually edits code with. None is ever an MCP
 *  tool, so none can appear in `tool_invocations` (EI-20103748074297088). */
const NATIVE_CLIENT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash', 'Glob', 'Grep'];

/**
 * Every `workspace_id = '<literal>'` style predicate in a query, as its literal values.
 *
 * Matched against RAW sql for the same reason as the claimability advisory: the interesting
 * token IS the string literal, which the stripper erases. Only equality-shaped operators are
 * collected — a `workspace_id <> 'default'` is a deliberate exclusion, not the habit this
 * catches.
 */
function workspaceIdPredicateValues(rawSql: string): string[] {
  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');
  const re = /\bworkspace_id\b\s*(?:=|\bin\b|=\s*any)\s*\(?\s*(?:array\s*\[\s*)?'([^']*)'/gi;
  const out: string[] = [];
  for (let m = re.exec(rawSql); m; m = re.exec(rawSql)) {
    if (!startsInsideComment(m.index)) out.push(m[1]);
  }
  return out;
}

/**
 * A TENANT predicate written against a CORPUS-namespaced table — the false zero that reads as
 * a real answer (EI-20103748074297088).
 *
 * {@link CORPUS_NAMESPACED_TABLES} already SUPPRESSES the generic "add workspace_id" suggestion
 * for these tables. That is only half the problem, and it is the half that was already solved:
 * suppressing a wrong SUGGESTION does nothing for a caller who writes the predicate from HABIT,
 * which is what actually happened here. Every other papercusp table an agent touches is
 * tenant-scoped and this very tool advises adding the predicate — correctly — all session long.
 * Applying that habit to session_turn_parts returned 0 rows out of 603,723.
 *
 * So this fires on the PRESENCE of the predicate, not its absence. That inversion is the same
 * one {@link buildTestRunsAdvisory} makes and for the same reason: for these tables the column's
 * presence is the trap, not the fix, so an advisory that clears when it appears would go quiet
 * at precisely the moment it is needed.
 *
 * ⚠ Silent when the value IS 'default' (the caller knows the namespace) and when there is no
 * predicate at all (the correct unscoped read — the suppression path already covers it). The
 * point is to be loud about the wrong answer, never about the right one.
 */
export function buildCorpusNamespaceAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  const corpusHits = tables.filter((t) => CORPUS_NAMESPACED_TABLES.has(bareTableName(t)));
  if (!corpusHits.length) return null;

  const values = workspaceIdPredicateValues(rawSql);
  if (!values.length) return null; // unscoped: correct for these tables
  if (values.includes('default')) return null; // caller already knows the namespace

  const named = [...new Set(corpusHits)].slice(0, 3).join(', ');
  const wrong = [...new Set(values)].slice(0, 2).map((v) => "'" + v + "'").join(', ');
  return (
    '⚠ corpus namespace, not a tenant: ' + named + ' stores every row under the literal ' +
    "workspace_id = 'default' (the session-transcript CORPUS namespace — see " +
    'search/session-ingest.ts, which hardcodes it deliberately). This query filters it by ' +
    wrong + ', which matches ZERO rows out of a fully-populated table and returns a clean, ' +
    'confidence-inspiring empty result. This is the habit-driven form of the trap, so the ' +
    'warning fires BECAUSE the predicate is present: drop it, or write ' +
    "workspace_id = 'default'. To scope to a tenant here, filter on `owner` (the coord " +
    'ownerId) instead — that is the column that actually identifies an agent.'
  );
}

/**
 * Completion evidence read from ONE of its surfaces — a confident false "no evidence"
 * (EI-20203674337042683, WI-38056, plan luna-audit-fixes-2026-08-12 D-001).
 *
 * A terminal work-item's evidence is written to a DIFFERENT column depending on how it
 * was closed, and no route writes both. Measured 2026-08-12 over one fleet's 165 closes:
 *
 *   closed `done`    → payload->'_completionEvidence'   160/160, terminal_completion_ref 1/160
 *   closed `dropped` → terminal_completion_ref            2/5,   payload evidence         3/5
 *   rows with NEITHER surface populated ......................................... 0
 *
 * So coverage is total, but any query that selects ONE surface reports the other route's
 * closes as evidence-free — a well-formed empty that reads as a finding. This is not
 * hypothetical: it is how the WI-38045 fleet audit came to report "2 closes with no
 * evidence", grade an agent's work down for it, and file a defect that did not exist.
 * EI-13845 and WI-37360 are the same trap found twice before.
 *
 * `terminal_reason` is called out separately because it is the column an auditor reaches
 * for FIRST and it does not hold a reason: it preserves the legacy terminal VOCABULARY
 * token ('resolved' / 'closed' — see work-items.ts, the resolved→done / closed→dropped
 * nuance). Reading it as prose yields NULL for exactly the rows whose story is richest.
 */
export function buildSplitCompletionEvidenceAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => ['work_items', 'engineer_issues'].includes(bareTableName(t)))) return null;

  // The two surfaces are probed differently ON PURPOSE. `terminal_completion_ref`
  // and `terminal_reason` are IDENTIFIERS, so they are matched against the
  // literal-and-comment-stripped body. `_completionEvidence` is a jsonb KEY and is
  // therefore only ever written inside a quoted literal — stripping literals
  // deletes exactly the thing being looked for, which silently inverted this
  // advisory (it stayed quiet on the single-surface read it exists for, and fired
  // on the two-surface read it must not).
  const body = stripSqlLiteralsAndComments(rawSql);
  const readsPayloadEvidence = /_completionEvidence/i.test(rawSql);
  const readsTerminalRef = /\bterminal_completion_ref\b/i.test(body);
  const readsTerminalReason = /\bterminal_reason\b/i.test(body);
  if (!readsPayloadEvidence && !readsTerminalRef && !readsTerminalReason) return null;
  // Both evidence surfaces already read: the query cannot under-report, and a
  // terminal_reason mention alongside them is a deliberate vocabulary read.
  if (readsPayloadEvidence && readsTerminalRef) return null;

  const missing = readsPayloadEvidence ? 'terminal_completion_ref' : "payload->'_completionEvidence'";
  const present = readsPayloadEvidence ? "payload->'_completionEvidence'" : 'terminal_completion_ref';
  const reasonNote = readsTerminalReason
    ? ' Also: `terminal_reason` is NOT a free-text reason — it stores the legacy terminal ' +
      "vocabulary token ('resolved'/'closed'), so it is NULL for precisely the closes you are " +
      'probably hunting.'
    : '';
  return (
    '⚠ split completion-evidence surface: this reads ' + present + ' but not ' + missing +
    '. Completion evidence lands on a DIFFERENT column depending on the close route — `done` ' +
    "closes write payload->'_completionEvidence' (measured 160/160) while `dropped` closes " +
    'write terminal_completion_ref — and no route writes both. A single-surface read therefore ' +
    'reports the other route\'s closes as evidence-free, which looks like a finding rather than ' +
    'a gap in the query (rows with neither surface populated: 0 of 165). Read BOTH, or use ' +
    'work_items:get, which already returns them together.' + reasonNote
  );
}

/**
 * `tool_invocations` asked about a NATIVE client tool — a guaranteed zero (EI-20103748074297088).
 *
 * `harness_shared.tool_invocations` is an MCP-tool ledger; native Edit / Write / Bash never pass
 * through MCP, so they never produce a row. Measured 2026-08-10 over 24h: capability:bash 1997,
 * capability:read 73, capability:edit 17 — and ZERO rows for any native name. A query counting
 * code edits there therefore under-reports by exactly the amount of work done with native tools,
 * which for coding agents here is most of it, and returns a well-formed zero while doing it.
 *
 * Paired with {@link buildCorpusNamespaceAdvisory} on purpose. These two traps COMPOSE: an agent
 * that hits this one, correctly reasons "I need the transcript store instead", and lands on
 * session_turn_parts gets a SECOND zero from the tenant-predicate habit — and two sources
 * agreeing feels like corroboration when it is the same mistake twice. So this advisory does not
 * just warn; it hands over the query that works, tenant predicate already correct.
 */
export function buildNativeToolAttributionAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');
  if (!/\btool_name\b/i.test(stripSqlLiteralsAndComments(rawSql))) return null;

  const hits = new Set<string>();
  for (const name of NATIVE_CLIENT_TOOLS) {
    const re = new RegExp("'" + name + "'", 'g');
    for (let m = re.exec(rawSql); m; m = re.exec(rawSql)) {
      if (!startsInsideComment(m.index)) hits.add(name);
    }
  }
  if (!hits.size) return null;

  return (
    '⚠ harness_shared.tool_invocations records MCP tools ONLY — ' + [...hits].slice(0, 4).join('/') +
    ' are NATIVE client tools and never appear in it, so this returns a well-formed zero rather ' +
    'than a real count (measured 24h: capability:bash 1997, capability:edit 17, native Edit 0). ' +
    'The store that DOES see native tools is harness_shared.session_turn_parts — and it is ' +
    "corpus-namespaced, so it needs workspace_id = 'default', NOT your tenant id: " +
    "SELECT owner, count(*) FILTER (WHERE tool_name IN ('Edit','Write','MultiEdit')) " +
    "FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' " +
    "AND ts > now() - interval '24 hours' GROUP BY 1. `owner` is the coord ownerId, so it joins " +
    'straight to an agent.'
  );
}

/**
 * Flag the seconds-as-milliseconds epoch trap on tool-invocation recency reads
 * (EI-20261119579595975).
 *
 * PostgreSQL's `to_timestamp()` accepts epoch SECONDS. A caller that has an
 * epoch-seconds value such as `1786547705.088` and divides it by 1000 because
 * it was thinking in epoch milliseconds silently moves the cutoff to January
 * 1970. A query over `invoked_at` then returns historical rows and can make a
 * wake-attribution claim look proven when it is not.
 *
 * This is deliberately narrow: it only fires for the tool_invocations table,
 * an invoked_at read, and a numeric literal in the epoch-seconds range divided
 * by 1000. A genuine epoch-milliseconds literal is ~1000x larger and remains
 * valid. Dynamic expressions and parameter values are left to the caller,
 * because this builder cannot establish their units without inventing a fact.
 */
export function buildEpochUnitAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\binvoked_at\b/i.test(stripped)) return null;

  // Current and near-future epoch seconds are 10–11 digits; epoch
  // milliseconds are 12–13 digits. Keep the bounds broad enough for old and
  // far-future timestamps without warning on ordinary numeric expressions.
  const epochSecondsLiteral =
    /\bto_timestamp\s*\(\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*\/\s*1000(?:\.0+)?\s*\)/gi;
  for (let match = epochSecondsLiteral.exec(stripped); match; match = epochSecondsLiteral.exec(stripped)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 100_000_000 || value >= 100_000_000_000) continue;
    return (
      '⚠ epoch-unit ambiguity: this tool_invocations query divides an epoch-seconds-sized value by 1000 ' +
      'before passing it to to_timestamp(), moving the cutoff to 1970 and allowing historical rows to ' +
      'masquerade as post-event calls. PostgreSQL to_timestamp() expects epoch seconds; divide by 1000 ' +
      'only when the source is epoch milliseconds. Prefer an ISO timestamptz literal, or assert ' +
      'min(invoked_at) is after the intended event before reporting wake attribution. ' +
      '(EI-20261119579595975).'
    );
  }

  return null;
}

/**
 * Resolve a caller-supplied scope value to a REAL id, or `undefined` if it is absent OR the
 * `'*'` wildcard sentinel (`_harness-scope.ts`: every su/operator-scope call sets
 * `ctx.harnessSlug = '*'`, and the same convention applies to `ctx.workspaceId`). Suggesting a
 * literal `= '*'` predicate is a distinct bug from "no predicate at all" (EI-19324633485547042
 * point 3): `'*'` is not a SQL wildcard for `=`, so the "fix" is a query that matches nothing and
 * reads as a clean, confidence-inspiring empty result — worse than the missing-predicate warning
 * it was supposed to resolve. Every other call site that threads `ctx.harnessSlug` into a real
 * predicate already guards this (`agent-tools/_harness-scope.ts` and ~15 sibling sites); this
 * advisory builder was the one that hadn't.
 */
function realScopeValue(v?: string | null): string | undefined {
  return v && v !== '*' ? v : undefined;
}

export async function buildTenantScopeAdvisory(
  rawSql: string,
  opts: { client?: OrgSql; workspaceId?: string | null; harnessSlug?: string | null } = {},
): Promise<string | null> {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\bwhere\b/i.test(stripped)) return null;
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  // Never suggest a literal '*' predicate — resolve the sentinel to "unresolved" up front so
  // every downstream `suggest`/predicate builder only ever sees a real id or undefined.
  const resolvedOpts = { ...opts, workspaceId: realScopeValue(opts.workspaceId), harnessSlug: realScopeValue(opts.harnessSlug) };

  const testRunsAdvisory = buildTestRunsAdvisory(stripped, tables);

  const mentions = (col: string): boolean => new RegExp(`\\b${col}\\b`, 'i').test(stripped);
  const genericMentioned = mentions('workspace_id') || mentions('harness_slug');

  // Tables with a hardcoded per-table override (a real tenancy key that
  // differs from the generic workspace_id/harness_slug heuristic) get their
  // OWN "already scoped" check — a query filtering agent_facts by scope_ref
  // but not harness_slug must still be recognized as correctly scoped, and a
  // query filtering agent_facts by harness_slug alone must still be flagged
  // (that's the exact wrong-predicate footgun this override exists to catch).
  // test_runs is excluded here too — see buildTestRunsAdvisory's doc comment for why its
  // "workspace_id/harness_slug mentioned ⇒ scoped" signal is backwards for that table.
  const overrideTables = tables.filter((t) => TENANT_SCOPE_OVERRIDES[bareTableName(t)]);
  const genericTables = tables.filter(
    (t) => !TENANT_SCOPE_OVERRIDES[bareTableName(t)] && bareTableName(t) !== TEST_RUNS_TABLE,
  );

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

  if (!overrideOffenders.length && !genericOffenders.length && !testRunsAdvisory) return null;

  const parts: string[] = [];

  if (testRunsAdvisory) parts.push(testRunsAdvisory);

  for (const { table, override } of overrideOffenders.slice(0, 3)) {
    parts.push(
      `⚠ tenant scope: ${table} (keyed by ${override.keyDescription}) — multi-tenant, but this ` +
        `filtered query has no ${override.requiredColumns.join('/')} predicate — a bare slug/id ` +
        "filter can silently match ANOTHER tenant's rows and read as a clean-looking " +
        `empty/stale result rather than an error. Add: ${override.suggest(resolvedOpts)}.` +
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

      // VERIFY BEFORE PRESCRIBING (P-003). Ask the table whether the predicate we
      // are about to recommend matches anything, instead of inferring it from the
      // column's existence. A refutation REPLACES the advisory rather than
      // annotating it: telling an agent to add a predicate AND that the predicate
      // is wrong invites them to add it anyway.
      const checkedWorkspaceId = off.hasWorkspaceId && !!resolvedOpts.workspaceId;
      const checkedHarnessSlug = off.hasHarnessSlug && !!resolvedOpts.harnessSlug;
      const pop = await probeTenantPopulation(
        off.table,
        { hasWorkspaceId: off.hasWorkspaceId, hasHarnessSlug: off.hasHarnessSlug, at: 0 },
        resolvedOpts,
        opts.client,
      );
      const verdict = classifyTenantPrescription(pop, { checkedWorkspaceId, checkedHarnessSlug });
      if (verdict.kind === 'refute') {
        const prescribed =
          verdict.column === 'workspace_id' ? resolvedOpts.workspaceId! : resolvedOpts.harnessSlug!;
        parts.push(refutedTenantAdvisory(off.table, verdict.column, prescribed, verdict.actual));
        continue;
      }

      const suggested: string[] = [];
      if (off.hasWorkspaceId && resolvedOpts.workspaceId) suggested.push(`workspace_id = ${quote(resolvedOpts.workspaceId)}`);
      if (off.hasHarnessSlug && resolvedOpts.harnessSlug) suggested.push(`harness_slug = ${quote(resolvedOpts.harnessSlug)}`);
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
 * Headroom added on top of `timeoutMs` for the WHOLE-call deadline
 * ({@link withCallDeadline}) — connect/acquire + the 3 `SET` statements +
 * commit round-trip, none of which are bounded by `statement_timeout` (that
 * only governs the query once a connection is already open and the
 * transaction has started). Deliberately generous rather than tight: this
 * exists to catch a HUNG acquire (pool exhaustion, or the DB/operator going
 * down mid-call — EI-19415142351884573), not to shave a few ms off a healthy
 * call, so a false-positive timeout on a merely-busy pool is worse than a few
 * extra seconds of real slack.
 */
export const PG_READ_QUERY_CALL_OVERHEAD_MS = 3000;

/**
 * Bound the WHOLE call — not just server-side statement execution — with a
 * timer THIS function owns, rather than trusting the driver/pool/transport to
 * cooperate with a signal or a server-side setting.
 *
 * WHY NOT JUST `statement_timeout` (what pgReadQuery relied on before this):
 * `SET LOCAL statement_timeout` is set INSIDE the transaction, so it does
 * nothing for the phase before the transaction starts — acquiring a
 * connection from the pool. A caller-supplied `timeoutMs: 25000` therefore
 * did not bound the failure mode agents actually hit: three consecutive
 * hangs (one with that explicit 25s timeout) each ran the full 300s client
 * idle-abort while Postgres itself sat completely idle, because the
 * operator was restarting and the connection/acquire phase never returned at
 * all (EI-19415142351884573).
 *
 * WHY NOT AN ABORT SIGNAL: an abort is a request the transport MAY ignore —
 * it only works if whoever holds the promise honours it, which is circular
 * when the whole point is that the transport has stopped behaving normally
 * (EI-18861599591681504). A `Promise.race`-style deadline against a timer
 * this function owns is guaranteed to settle regardless of what `work` (the
 * connect, acquire, or execute) is actually doing.
 *
 * `work`'s eventual settlement is still awaited via `.then(...)` even after
 * the timer wins, so a late resolution/rejection is a no-op (resolve/reject
 * only takes effect once) rather than an unhandled rejection.
 */
function withCallDeadline<T>(work: Promise<T>, deadlineMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PgReadQueryTimeoutError(timeoutMessage)), deadlineMs);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The message `withCallDeadline` raises for `pgReadQuery`/`explainReadQuery` — one string so the two call sites can't drift. */
function callTimeoutMessage(timeoutMs: number, callDeadlineMs: number): string {
  return (
    `Query call did not complete within ${callDeadlineMs}ms of the WHOLE call (connect + acquire + ` +
    `execute) — statement_timeout=${timeoutMs}ms only bounds server-side execution once a connection ` +
    'is already open, so on its own it could not catch a hung connection acquire (pool exhaustion, or ' +
    'the database/operator going down mid-call). If this keeps recurring, check dev:service_health — ' +
    'the operator may be restarting (EI-19415142351884573).'
  );
}

/**
 * Pin the transaction's TimeZone to UTC (EI-19397658288924647).
 *
 * `date_trunc('day', <timestamptz>)` buckets on SESSION-timezone boundaries. On
 * this box the session TZ is America/New_York, so the obvious daily rollup
 * bucketed in EDT — while the result was serialised with a literal `Z`:
 *
 *     date_trunc('day', timestamptz '2026-08-03 01:34:00Z')::date
 *       →  "2026-08-02T00:00:00.000Z"        ← asserts UTC, is not UTC
 *
 * That label is not merely ambiguous, it is affirmatively WRONG about its own
 * timezone, and nothing in the row hints at the shift — an agent selecting only
 * `day, count(*)` gets a clean, plausible, 4h-shifted series. Every measurement
 * here is compared against a UTC anchor (a deploy time, a gate verdict,
 * `host.now`, an incident window), and the shift moves pre-epoch events into the
 * post-epoch bucket — the direction that manufactures a false positive for
 * whatever change is being measured.
 *
 * Fixing the SESSION rather than the rendering makes the bucket boundary and the
 * `Z` agree, which also fixes `now()`-relative filters and every other
 * session-TZ-dependent function in one place. `SET LOCAL` scopes it to this
 * transaction, so it can never leak onto a pooled connection shared with app
 * code that legitimately wants server-local time.
 */
const SET_LOCAL_UTC = "SET LOCAL TIME ZONE 'UTC'";

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

/** Skip whitespace and SQL comments while locating the EXPLAIN body. */
function skipSqlTrivia(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    if (/\s/.test(sql[i] ?? '')) {
      i++;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readSqlWord(sql: string, start: number): { word: string; end: number } | null {
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(start));
  return match ? { word: match[0], end: start + match[0].length } : null;
}

/** Find the closing parenthesis for EXPLAIN's option list, quote-aware. */
function findSqlClosingParen(sql: string, start: number): number {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      for (i++; i < sql.length; i++) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '"') {
      for (i++; i < sql.length; i++) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return -1;
        i = end + tag.length - 1;
        continue;
      }
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Consume the legacy, non-parenthesized EXPLAIN option spelling. */
function consumeLegacyExplainOptions(sql: string, start: number): number {
  let i = skipSqlTrivia(sql, start);
  const booleanOptions = new Set(['analyze', 'verbose', 'costs', 'settings', 'buffers', 'wal', 'timing', 'summary']);
  const booleanValues = new Set(['true', 'false', 'on', 'off']);
  while (true) {
    const token = readSqlWord(sql, i);
    if (!token) return i;
    const word = token.word.toLowerCase();
    if (word === 'format') {
      const value = readSqlWord(sql, skipSqlTrivia(sql, token.end));
      if (!value || !/^(text|xml|json|yaml)$/i.test(value.word)) return i;
      i = skipSqlTrivia(sql, value.end);
      continue;
    }
    if (!booleanOptions.has(word)) return i;
    i = skipSqlTrivia(sql, token.end);
    const value = readSqlWord(sql, i);
    if (value && booleanValues.has(value.word.toLowerCase())) i = skipSqlTrivia(sql, value.end);
  }
}

function startsWithExplain(raw: string): boolean {
  const q = raw.trim();
  const start = skipSqlTrivia(q, 0);
  const token = readSqlWord(q, start);
  return token?.word.toLowerCase() === 'explain';
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
 * Validate an EXPLAIN whose explained statement is read-only. EXPLAIN itself
 * is not a SELECT/WITH statement, so it has its own narrow entry point rather
 * than weakening assertSingleReadStatement. The option list is skipped, then
 * the body goes through the exact same single SELECT/WITH validation.
 */
export function assertReadOnlyExplainStatement(raw: string): string {
  const q = raw.trim().replace(/;\s*$/, '').trim();
  if (!q) throw new PgReadQueryError('empty query');
  const start = skipSqlTrivia(q, 0);
  const explain = readSqlWord(q, start);
  if (!explain || explain.word.toLowerCase() !== 'explain') {
    throw new PgReadQueryError('only EXPLAIN SELECT / WITH…SELECT queries are allowed');
  }

  let bodyStart = skipSqlTrivia(q, explain.end);
  if (q[bodyStart] === '(') {
    const close = findSqlClosingParen(q, bodyStart);
    if (close === -1) throw new PgReadQueryError('EXPLAIN option list is not closed');
    bodyStart = skipSqlTrivia(q, close + 1);
  } else {
    bodyStart = consumeLegacyExplainOptions(q, bodyStart);
  }
  const body = q.slice(bodyStart).trim();
  if (!body) throw new PgReadQueryError('EXPLAIN must include a SELECT / WITH…SELECT statement');
  assertSingleReadStatement(body);
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
  const isExplain = startsWithExplain(rawQuery);
  const query = isExplain ? assertReadOnlyExplainStatement(rawQuery) : assertSingleReadStatement(rawQuery);
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
  const callDeadlineMs = timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;
  const work = sql.begin(async (tx) => {
    // READ ONLY must be set before the first data statement in the txn.
    await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await tx.unsafe(SET_LOCAL_UTC);
    const resultRows = (await tx.unsafe(
      isExplain ? query : `SELECT * FROM (${query}) AS _pgq LIMIT ${maxRows + 1}`,
    )) as unknown as Record<string, unknown>[];
    // EXPLAIN returns its plan as rows and cannot itself be wrapped in the
    // SELECT * / LIMIT shape above. Keep the same response cap at this seam;
    // the transaction timeout still bounds plan generation.
    rows = isExplain && resultRows.length > maxRows + 1 ? resultRows.slice(0, maxRows + 1) : resultRows;
  });
  // Bound the WHOLE call (not just server-side execution) — see withCallDeadline's doc.
  await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs));
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
  const callDeadlineMs = timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;
  try {
    const work = sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      // Same TZ pin as pgReadQuery so a query VALIDATES under the session it will RUN under.
      await tx.unsafe(SET_LOCAL_UTC);
      await tx.unsafe(`EXPLAIN (COSTS OFF) ${query}`);
    });
    // Bound the WHOLE call the same way pgReadQuery does — see withCallDeadline's doc.
    await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs));
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
  columns: Array<{ name: string; type: string; nullable: boolean; default: string | null; comment: string | null }>;
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

  // WI-37360: a column's own COMMENT is the one piece of schema metadata that can name
  // "this column is dead" / "read THAT one instead" directly on the thing an agent is
  // looking at — col_description() joined by ordinal_position (works for tables AND
  // views; COMMENT ON COLUMN is valid on both). Left NULL for a column nobody commented,
  // same as every other optional field here.
  const columnRows = (await sql`
    SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
           col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS comment
      FROM information_schema.columns c
     WHERE c.table_schema = ${relation.schema} AND c.table_name = ${relation.name}
     ORDER BY c.ordinal_position
  `) as unknown as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    comment: string | null;
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
      comment: r.comment,
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
