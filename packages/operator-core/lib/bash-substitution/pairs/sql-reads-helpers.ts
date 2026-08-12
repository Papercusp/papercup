/**
 * Translate a hand-written `information_schema` query into the `describe` call
 * that answers it (plan `sql-escape-tool-routing-2026-08-12`, P-009).
 *
 * Split out of `sql-reads.ts` for the same reason `model-drift-helpers.ts` exists
 * beside the service pairs: these are the functions a drift test needs to call
 * directly, and importing them from the pair module would drag the whole pair
 * registry into a test that is only asking "does this query translate".
 *
 * Everything here is a best-effort READ of a query's text. Returning null is
 * always a legitimate answer and is the honest one whenever the shape is not
 * unambiguous — a wrong translation would route an agent to a describe call that
 * answers a different question, which is worse than leaving the query alone.
 */

/** A SQL string literal's contents, for a `col = 'value'` predicate. */
function literalAfter(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s*=\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/** The contents of a `col LIKE '…'` / `col ILIKE '…'` predicate. */
function likePatternFor(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s+i?like\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/**
 * `… WHERE table_schema='harness_shared' AND table_name='work_items'` →
 * `harness_shared.work_items`.
 *
 * The schema is REQUIRED even though `describe` would accept a bare name,
 * because a bare relation name can resolve in several schemas here (per-harness
 * clones make that ordinary) and silently describing the wrong one is the single
 * most expensive way this translation can be wrong.
 */
export function describeRelationFromColumnsQuery(atom: string): string | null {
  const table = literalAfter(atom, 'table_name');
  if (!table) return null;
  const schema = literalAfter(atom, 'table_schema');
  if (!schema) return null;
  return `${schema}.${table}`;
}

/** `LIMIT 25` → 25. */
function limitOf(atom: string): number | null {
  const n = /\blimit\s+(\d{1,4})\b/i.exec(atom)?.[1];
  return n ? Number(n) : null;
}

/** Render a tool call the way the routing rows and advisories write one. */
function renderCall(verb: string, args: Array<[string, string]>): string {
  if (args.length === 0) return `${verb} {}`;
  return `${verb} { ${args.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
}

/**
 * `… WHERE table_name ILIKE '%coord%'` → `*coord*`
 * `… WHERE table_schema='harness_shared'` → `harness_shared.*`
 *
 * The glob is `listRelations`' own dialect: `*` becomes `%` and the match runs
 * against `lower(schema.name)` OR `lower(name)`, so a bare fragment reaches the
 * same rows the hand-written ILIKE does. A query carrying BOTH a schema and a
 * name fragment translates to the schema-qualified glob, which is the narrower
 * (and therefore safer) of the two readings.
 */
export function describePatternFromTablesQuery(atom: string): string | null {
  const schema = literalAfter(atom, 'table_schema');
  const fragment = likePatternFor(atom, 'table_name');

  if (fragment) {
    const glob = fragment.replace(/%/g, '*');
    return schema ? `${schema}.${glob}` : glob;
  }
  // An EXACT name (`table_name = 'spawned_agents'`) is a glob with no wildcards
  // in it: listRelations lowercases both sides and runs LIKE, so a pattern with
  // no `%` is an equality test. Worth handling rather than declining, because
  // "does this relation exist, and in which schema" is one of the questions the
  // corpus asks most and it is the cheapest of all to answer.
  const exact = literalAfter(atom, 'table_name');
  if (exact) return schema ? `${schema}.${exact}` : exact;
  if (schema) return `${schema}.*`;
  return null;
}

/* ─── TRANCHE 2 ───────────────────────────────────────────────────────────────
 * The three verbs this plan itself shipped. Each translator reads the PREDICATES
 * of a real query and renders the typed call that asks the same question.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * The column an agent used for the migration IDENTIFIER.
 *
 * `schema_migrations` has exactly three columns — filename, applied_at, sha256
 * (verified against the live catalog, not the tool's prose) — yet the corpus
 * queries `name` and `version` repeatedly. Those calls ERRORED: the corpus is
 * filtered to `status='ok'`, but that is the INVOCATION's status, so a query
 * whose SQL failed still appears here. We translate them anyway and deliberately:
 * the agent's QUESTION ("did migration 762 apply?") is one `db:migrations`
 * answers exactly, and a typed `like` arg cannot misname a column. A query that
 * could never return a row is the strongest possible evidence for routing, not a
 * reason to exclude it.
 */
const MIGRATION_ID_COL = String.raw`(?:filename|name|version)`;

/**
 * `WHERE filename LIKE '727%' ORDER BY filename DESC LIMIT 8`
 *   → `db:migrations { like: "727%", limit: 8 }`
 *
 * Null whenever nothing bounds the read: a bare unlimited `SELECT … FROM
 * schema_migrations` is a full-ledger dump (~800 rows) and `db:migrations` caps
 * at 200, so claiming it would be claiming a different answer.
 */
export function migrationsCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const likePattern =
    new RegExp(String.raw`\b${MIGRATION_ID_COL}\s+i?like\s*'([^']+)'`, 'i').exec(atom)?.[1] ??
    new RegExp(String.raw`\b${MIGRATION_ID_COL}\s*=\s*'([^']+)'`, 'i').exec(atom)?.[1] ??
    null;
  // `like` is passed through verbatim: the tool honours a pattern that already
  // carries %/_ and PREFIXES a bare one, which is exactly what the corpus's
  // '727%' / '795-%' / '%797%' / '803-….sql' forms need.
  if (likePattern) args.push(['like', JSON.stringify(likePattern)]);

  const since = /\bapplied_at\s*>=?\s*(?:timestamptz\s*)?'([^']+)'/i.exec(atom)?.[1] ?? null;
  const until = /\bapplied_at\s*<=?\s*(?:timestamptz\s*)?'([^']+)'/i.exec(atom)?.[1] ?? null;
  if (since) args.push(['since', JSON.stringify(since)]);
  if (until) args.push(['until', JSON.stringify(until)]);

  // `order` is always DESC in the tool. A query ordering by applied_at needs the
  // non-default key; ordering by filename IS the default and adds nothing.
  if (/\border\s+by\s+applied_at\b/i.test(atom)) args.push(['order', '"applied_at"']);

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;
  return renderCall('db:migrations', args);
}

/** The real `test_runs.status` domain — a CHECK constraint, not a convention. */
const TEST_RUN_STATUSES = ['pass', 'fail', 'skip', 'cancelled', 'error', 'running'] as const;

/**
 * Map a status literal an agent WROTE onto one that can actually match.
 *
 * `status='failed'` and `status='passed'` are the corpus's two most common
 * status predicates and NEITHER can ever match a row: the column is
 * CHECK-constrained to pass|fail|skip|cancelled|error|running. This is the
 * failure mode that makes this pair worth more than convenience — see the pair
 * header for what each of the two wrong forms actually returns.
 */
function normaliseTestStatus(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if ((TEST_RUN_STATUSES as readonly string[]).includes(v)) return v;
  if (v === 'passed') return 'pass';
  if (v === 'failed') return 'fail';
  if (v === 'skipped') return 'skip';
  return null;
}

/** Every status literal named in an `= 'x'` / `IN ('a','b')` predicate. */
function statusLiteralsIn(atom: string): string[] | null {
  const inList = /\bstatus\s+(?:not\s+)?in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  if (inList) {
    const raw = [...inList.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    const mapped = raw.map(normaliseTestStatus);
    return mapped.some((m) => m === null) ? null : [...new Set(mapped as string[])];
  }
  const one = /\bstatus\s*(?:=|<>|!=)\s*'([^']*)'/i.exec(atom)?.[1];
  if (one === undefined) return null;
  const mapped = normaliseTestStatus(one);
  return mapped ? [mapped] : null;
}

/**
 * `WHERE file_path LIKE '%adv-agent-detail%' AND status='fail' AND started_at >
 * now() - interval '3 hours' ORDER BY started_at DESC LIMIT 15`
 *   → `testing:runs { filePath: "%adv-agent-detail%", status: ["fail"], sinceHours: 3, limit: 15 }`
 *
 * A NEGATED status predicate translates to its COMPLEMENT over the real enum
 * rather than to a guess at intent: `status <> 'passed'` becomes every status but
 * `pass`, which is what the agent asked for and — critically — not what their SQL
 * returned.
 */
export function testRunsCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const filePath =
    /\bfile(?:_path)?\s+i?like\s*'([^']+)'/i.exec(atom)?.[1] ??
    /\bfile(?:_path)?\s*=\s*'([^']+)'/i.exec(atom)?.[1] ??
    null;
  if (filePath) args.push(['filePath', JSON.stringify(filePath)]);

  const literals = statusLiteralsIn(atom);
  if (literals) {
    const negated = /\bstatus\s+not\s+in\s*\(/i.test(atom) || /\bstatus\s*(?:<>|!=)\s*'/i.test(atom);
    const selected = negated ? TEST_RUN_STATUSES.filter((s) => !literals.includes(s)) : literals;
    if (selected.length > 0) args.push(['status', `[${selected.map((s) => JSON.stringify(s)).join(', ')}]`]);
  }

  const source = /\bsource\s*=\s*'(ci|local|admin-ui)'/i.exec(atom)?.[1];
  if (source) args.push(['source', JSON.stringify(source.toLowerCase())]);

  const commitSha = /\bcommit_sha\s*=\s*'([0-9a-f]{6,40})'/i.exec(atom)?.[1];
  if (commitSha) args.push(['commitSha', JSON.stringify(commitSha)]);

  const runGroup = /\brun_group_id\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (runGroup) args.push(['runGroup', JSON.stringify(runGroup)]);

  // `started_at > now() - interval '90 minutes'`. `since`/`sinceHours` filter on
  // started_at; a window written against finished_at is close but not identical,
  // and the pair's cover() declines those rather than papering over the shift.
  const interval = /\bnow\(\)\s*-\s*interval\s*'(\d+(?:\.\d+)?)\s*(hour|minute|day)s?'/i.exec(atom);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2]!.toLowerCase();
    const hours = unit === 'hour' ? n : unit === 'minute' ? n / 60 : n * 24;
    args.push(['sinceHours', String(Number(hours.toFixed(2)))]);
  }

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;

  // `latestPerFile` defaults TRUE, or FALSE when filePath is given — and raw SQL
  // never collapses unless it says DISTINCT. Left implicit, the default would
  // answer a different question than the query being replaced: a file that
  // failed an hour ago and has passed since drops out of a collapsed read but is
  // present in the SQL's. So it is made EXPLICIT wherever the default would
  // disagree, rather than trusted to line up.
  const collapses = /\bdistinct\b/i.test(atom);
  const hasFilePath = args.some(([k]) => k === 'filePath');
  if (!hasFilePath && !collapses) args.push(['latestPerFile', 'false']);

  return renderCall('testing:runs', args);
}

/**
 * `WHERE title ILIKE '%tmp_pack%' AND state='open' ORDER BY created_at DESC
 * LIMIT 10` → `issues:list { q: "tmp_pack", state: "open", limit: 10 }`
 *
 * `q` matches title + body, so a title-only ILIKE routes to a SUPERSET. That is
 * stated in the covered expression rather than hidden — the reader has to be able
 * to see that the two are not identical.
 */
export function issuesListCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const q = /\b(?:title|body)\s+i?like\s*'%?([^'%]+)%?'/i.exec(atom)?.[1] ?? null;
  if (q) args.push(['q', JSON.stringify(q)]);

  // `status` is read as `state`. There IS no `status` column on
  // engineer_issues — those queries errored — but the intent is unambiguous, and
  // dropping the predicate instead would render a call returning MORE rows than
  // the query asked for, which is the one thing a translation must never do.
  const state = (/\bstate\s*=\s*'([a-z_]+)'/i.exec(atom)?.[1] ?? /\bstatus\s*=\s*'([a-z_]+)'/i.exec(atom)?.[1]) as
    | string
    | undefined;
  if (state) args.push(['state', JSON.stringify(state.toLowerCase())]);

  // Only bug+change come back by default, so a `kind = 'bug'` predicate that is
  // not translated silently widens the result to include `change`.
  const kindList = /\bkind\s+in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  const kinds = kindList
    ? [...kindList.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
    : ((k) => (k ? [k] : []))(/\bkind\s*=\s*'([a-z]+)'/i.exec(atom)?.[1]);
  if (kinds.length > 0) args.push(['kinds', `[${kinds.map((k) => JSON.stringify(k.toLowerCase())).join(', ')}]`]);

  const assignee = /\bassignee\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (assignee) args.push(['assignee', JSON.stringify(assignee)]);

  const scope = /\bscope\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (scope) args.push(['scope', JSON.stringify(scope)]);

  const severity = /\bseverity\s*=\s*'(critical|major|minor|nit)'/i.exec(atom)?.[1];
  if (severity) args.push(['severity', JSON.stringify(severity.toLowerCase())]);

  // `body` is 76% of this read's bytes and omitted by default, so a query that
  // PROJECTS it has to ask for it back explicitly.
  if (/\bleft\s*\(\s*body\b|\bselect[^;]*\bbody\b/i.test(atom)) args.push(['includeBody', 'true']);

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;
  return renderCall('issues:list', args);
}

/**
 * The gate-health read: `SELECT metadata->'gate_health'->>'consecutiveReds',
 * metadata->'gate_health'->'inFlightRetriage' … FROM harness_shared.routines`.
 *
 * 708 calls / 110 distinct agents over the 14d retention — the largest single
 * cluster the SQL audit measured, and the last one still routing around the
 * catalog. (The census reports this relation at 478/105 because it runs a 7-day
 * window; same cluster, half the window. Do not "reconcile" the two.)
 *
 * `routines:list` has served this since P-002 put `gate_health` at the HEAD of
 * `healthOf()`'s allowlist — the whole object, not a field subset — beside the
 * `nextFireAt`/`lastFiredAt` the same queries read. The capability was never the
 * gap and the tool's own guidance already names this cluster; what never existed
 * was the ROUTING ROW, which is the surface an agent consults on the way to
 * writing the SQL. That is Class C, not Class A, and it is why this pair exists.
 */
export function gateHealthCallFromQuery(atom: string): string | null {
  if (!/\bgate_health\b/i.test(atom)) return null;
  const args: Array<[string, string]> = [];

  // `gate_health` is written only onto the green-checkpoint routine, so a query
  // that reads it WITHOUT a name predicate is still asking about that one row.
  // Naming it in the translation is faithful, not a narrowing: it returns the
  // same row the SQL would have found, without scanning an unbounded table.
  const name =
    /\bname\s*=\s*'([^']+)'/i.exec(atom)?.[1] ?? /\bname\s+i?like\s*'%?([^'%]+)%?'/i.exec(atom)?.[1] ?? null;
  args.push(['name', JSON.stringify(name ?? 'green-checkpoint')]);

  const installSlug = /\binstall_slug\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (installSlug) args.push(['installSlug', JSON.stringify(installSlug)]);

  return renderCall('routines:list', args);
}
