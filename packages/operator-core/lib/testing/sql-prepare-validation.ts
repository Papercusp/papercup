/**
 * sql-prepare-validation.ts — validate the SQL a MOCKED test suite issues by
 * PREPAREing it against a schema-loaded Postgres.
 *
 * WI-2141982 · the surviving half of P-018/WI-7132 · authority: plan
 * silent-wrong-answers-2026-08-01, decisions D-106 and D-115. Read those before
 * changing anything here; they carry the measurement, the refutation of the
 * statement-counting alternative, and the two probes that made this shippable.
 *
 * ── THE CLASS ───────────────────────────────────────────────────────────────
 * A mocked suite never sends its SQL to a database, so the SQL is never parsed.
 * The incident (EI-11796 lineage): a derived table projected narrowly while
 * `compileRank`'s ORDER BY reached a base column, producing
 * `column "t.payload" does not exist`. Every mocked suite over that code path
 * stayed green, because the fake received the text and stubbed a row set. The
 * query was WRONG and WELL-FORMED-LOOKING — this plan's subject exactly.
 *
 * D-106 measured and REFUTED the obvious remedy (count executed statements):
 * the incident's suite and a healthy mocked suite are IDENTICAL on that
 * instrument (0 real statements, >= 1 mock statement), so no threshold
 * discriminates. Do not re-propose it.
 *
 * What DOES discriminate is SQL VALIDITY. `PREPARE` parses and PLANS a
 * statement without executing it: no rows read, no rows written, no fixture, no
 * isolation requirement. It raises the incident's exact error at parse time.
 *
 * ── WHY REASSEMBLY IS LOAD-BEARING (the permanent control's subject) ─────────
 * `sql-mock.ts`'s `queryTextOf` is `strings.join(' ')`. For a tagged template
 * that joins the LITERAL SEGMENTS AND DROPS EVERY INTERPOLATION, so
 *
 *   sql`SELECT * FROM t WHERE harness_slug = ${h} AND status = ${s}`
 *
 * becomes `SELECT * FROM t WHERE harness_slug =   AND status = ` — which is not
 * valid SQL, and which would therefore report INVALID for every parameterised
 * query in the codebase. That is a false-red generator, and a guard that emits
 * false reds gets ignored and then deleted (the failure mode WI-2141982 names
 * explicitly). {@link reassembleSql} rebuilds the `$1..$n` form instead.
 *
 * The joined-vs-reassembled pair is kept as a PERMANENT CONTROL in
 * `sql-prepare-validation.integration.test.ts`: the joined form must PREPARE
 * INVALID while the reassembled form PREPAREs VALID. Per the repo's
 * mutation-probe policy that is the cheapest tier that fits — a
 * deliberately-wrong implementation kept permanently beside the real one, so no
 * tree mutation, no sweep race, no restore step.
 *
 * ── FALSE REDS ARE THE FAILURE MODE, NOT MISSED BUGS ────────────────────────
 * Every narrowing below exists because a probe produced a red that was not a
 * bug. Read {@link PrepareVerdict}: only `invalid` is a finding. `untypeable`
 * and `unpreparable` are TOLERATED outcomes, deliberately distinct from `valid`
 * so a caller can report coverage honestly rather than silently counting a
 * statement it never actually checked as checked.
 */
import type postgres from 'postgres';

/**
 * The outcome of PREPAREing one statement.
 *
 * - `valid` — parsed and planned. Every referenced relation, column and
 *   function resolves against the live schema.
 * - `invalid` — THE ONLY FINDING. Postgres rejected it for a reason that is a
 *   real defect in the query: a missing column/relation/function, a syntax
 *   error, an ambiguous reference. This is the incident's class.
 * - `untypeable` — rejected ONLY because a parameter has no type context
 *   anywhere in the statement (`WHERE $1 IS NULL`). Measured in D-115: 1 of 9
 *   realistic shapes. The query may be perfectly correct in production, where
 *   the driver supplies the type; the checker simply cannot judge it. Never a
 *   red. Fixable at the call site with an explicit cast (`$1::text IS NULL`).
 * - `unpreparable` — PREPARE only accepts SELECT / INSERT / UPDATE / DELETE /
 *   MERGE / VALUES. A `TRUNCATE`, `CREATE`, `SET` or `DEALLOCATE` is not a
 *   defect, but Postgres reports it as a syntax error, which would otherwise be
 *   classified `invalid`. This verdict is what stops a fixture's `TRUNCATE`
 *   from red-pinning a suite.
 * - `empty` — nothing to check (a mock call with no template text).
 */
export type PrepareVerdict = 'valid' | 'invalid' | 'untypeable' | 'unpreparable' | 'empty';

export interface PrepareResult {
  verdict: PrepareVerdict;
  /** The exact text handed to PREPARE (post-reassembly). */
  sql: string;
  /** Caller-supplied label, echoed so a batch failure names its source. */
  label?: string;
  /** Postgres' own message, present for every non-`valid` verdict except `empty`. */
  error?: string;
  /** Postgres SQLSTATE, when the driver supplied one. */
  code?: string;
}

/**
 * Rebuild a tagged template's `strings` array into `$1..$n` parameterised SQL.
 *
 * This is the formula probed in D-115. For n literal segments there are n-1
 * interpolations, so a placeholder is emitted after every segment except the
 * last.
 *
 * ⚠ Do NOT "simplify" this to `strings.join(' ')` (or to `join('')`). That is
 * precisely `queryTextOf`'s behaviour in `sql-mock.ts`, it deletes every
 * placeholder, and the resulting text fails to parse for any parameterised
 * query. The permanent control in the integration suite exists to fail if
 * anyone does.
 */
export function reassembleSql(strings: readonly string[]): string {
  return strings.reduce(
    (acc, segment, i) => acc + segment + (i < strings.length - 1 ? `$${i + 1}` : ''),
    '',
  );
}

/**
 * Strip leading whitespace and `--` / block comments so the leading-keyword
 * test below sees the real first token.
 *
 * Deliberately NOT quote-aware: it only ever runs against the FRONT of a
 * statement, before any string literal can appear, so the repo's canonical
 * comment mask would be a heavier dependency for no additional correctness.
 */
function leadingKeywordOf(sql: string): string {
  let rest = sql;
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, '');
    rest = rest.replace(/^--[^\n]*\n?/, '');
    rest = rest.replace(/^\/\*[\s\S]*?\*\//, '');
    if (rest === before) break;
  }
  return (rest.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
}

/**
 * PREPARE accepts only these statement heads (PostgreSQL docs: "PREPARE ... AS
 * statement", where statement is SELECT, INSERT, UPDATE, DELETE, MERGE or
 * VALUES). `WITH` is included because a CTE resolves to one of those.
 */
const PREPARABLE_HEADS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'WITH']);

/** True when PREPARE can judge this statement at all. See {@link PREPARABLE_HEADS}. */
export function isPreparable(sql: string): boolean {
  return PREPARABLE_HEADS.has(leadingKeywordOf(sql));
}

/**
 * Classify a Postgres error raised by PREPARE into a {@link PrepareVerdict}.
 *
 * Only `invalid` is a finding. The `untypeable` arm is matched on SQLSTATE
 * 42P18 (`indeterminate_datatype`) FIRST and on the message only as a fallback,
 * because the message is localisable and the SQLSTATE is not.
 */
export function classifyPrepareError(message: string, code?: string): 'invalid' | 'untypeable' {
  if (code === '42P18') return 'untypeable';
  if (/could not determine data type|inconsistent types deduced/i.test(message)) return 'untypeable';
  return 'invalid';
}

interface PgError {
  message?: unknown;
  code?: unknown;
}

let counter = 0;

/**
 * PREPARE one statement against `sql` and classify the outcome. Parse + plan
 * only — nothing is executed, so this is safe against a schema-loaded database
 * with no fixture and no isolation.
 *
 * The prepared statement is DEALLOCATEd on the success path; a failed PREPARE
 * leaves nothing to deallocate. Statement names are uniquified per call so a
 * batch cannot collide with itself.
 */
export async function validateSqlByPrepare(
  sql: postgres.Sql,
  queryText: string,
  opts: { label?: string } = {},
): Promise<PrepareResult> {
  const text = queryText.trim().replace(/;\s*$/, '');
  const base: Pick<PrepareResult, 'sql' | 'label'> = { sql: text, label: opts.label };

  if (text === '') return { ...base, verdict: 'empty' };
  if (!isPreparable(text)) return { ...base, verdict: 'unpreparable' };

  const name = `sql_prepare_validation_${process.pid}_${++counter}`;
  try {
    await sql.unsafe(`PREPARE ${name} AS ${text}`);
  } catch (err) {
    const e = (err ?? {}) as PgError;
    const message = typeof e.message === 'string' ? e.message : String(err);
    const code = typeof e.code === 'string' ? e.code : undefined;
    return { ...base, verdict: classifyPrepareError(message, code), error: message, code };
  }
  // Best-effort cleanup: a failure to deallocate must never turn a VALID
  // verdict into a red, and the throwaway database is dropped regardless.
  await sql.unsafe(`DEALLOCATE ${name}`).catch(() => undefined);
  return { ...base, verdict: 'valid' };
}

export interface ValidateManyReport {
  results: PrepareResult[];
  /** The findings — and the ONLY thing a caller should assert is empty. */
  invalid: PrepareResult[];
  counts: Record<PrepareVerdict, number>;
  /**
   * Statements this run could not actually judge (`untypeable` + `unpreparable`
   * + `empty`).
   *
   * Exposed so a caller reports coverage honestly instead of counting an
   * unchecked statement as checked — a zero `invalid` over a corpus that was
   * mostly unjudgeable is exactly the well-formed-looking wrong answer this
   * plan is about.
   */
  unjudged: number;
}

/** Validate a batch, preserving order. See {@link ValidateManyReport.unjudged}. */
export async function validateManyByPrepare(
  sql: postgres.Sql,
  queries: readonly { sql: string; label?: string }[],
): Promise<ValidateManyReport> {
  const results: PrepareResult[] = [];
  for (const q of queries) {
    results.push(await validateSqlByPrepare(sql, q.sql, { label: q.label }));
  }
  const counts: Record<PrepareVerdict, number> = {
    valid: 0,
    invalid: 0,
    untypeable: 0,
    unpreparable: 0,
    empty: 0,
  };
  for (const r of results) counts[r.verdict] += 1;
  return {
    results,
    invalid: results.filter((r) => r.verdict === 'invalid'),
    counts,
    unjudged: counts.untypeable + counts.unpreparable + counts.empty,
  };
}

/** Render findings as a message a failing assertion can print verbatim. */
export function formatInvalid(report: ValidateManyReport): string {
  return report.invalid
    .map((r) => `  - ${r.label ?? '(unlabelled)'}: ${r.error}\n    SQL: ${r.sql}`)
    .join('\n');
}
