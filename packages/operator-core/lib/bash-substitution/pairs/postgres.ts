/**
 * Equivalence pairs — the POSTGRES family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-007).
 *
 * Population: 798 `psql` atoms across 30 sessions.
 * Proposed replacement: `dev:pg_query`.
 *
 * This is the audit's best-adopted pair (~85%) and the ONLY tool with a routing
 * row in CLAUDE.md — which is the plan's central evidence that routing, not
 * capability, is the lever. So the residue here is pure shape gap, and worth
 * reading precisely.
 *
 * ── What the corpus says, bucketed ───────────────────────────────────────────
 *   277  SELECT via -c            → substitutable, but ONLY against the operator DB
 *   289  connection via shell var → `psql "$ODDS_DB"`, `psql "$(node -e …)"`
 *   101  -c other (SHOW, …)       → not a SELECT
 *    88  `\d` introspection       → no tool form (P-011)
 *    19  heredoc SQL              → multi-statement, no tool form
 *    18  DDL/DML                  → correctly no tool form (read-only tool)
 *     6  -f file.sql              → that is db:migrate, not this
 *
 * ── The finding the plan did not anticipate ──────────────────────────────────
 * `dev:pg_query` has NO database selector — it runs against the operator
 * Postgres, full stop. But a large share of real psql traffic targets a
 * DIFFERENT database entirely: `$ODDS_DB`, `$PGURL/oddsmith_028_rehearsal`,
 * `wi5635_scratch`. Those calls are not badly-routed operator reads; they are
 * reads of another database that this tool structurally cannot serve.
 *
 * So per D-008 the pattern is narrowed to what is genuinely substitutable: a
 * SELECT, issued with `-c`, against a LITERAL operator-Postgres connection.
 * Everything else falls outside rather than dragging the verdict down — and,
 * importantly, is never nudged toward a tool that would silently query the
 * WRONG DATABASE. That failure mode would be worse than the raw psql it
 * replaced, because it returns plausible rows instead of an error.
 */

import type { CoverageResult, SubstitutionPair } from '../types';

/**
 * A literal operator-Postgres connection. Either the URL form
 * (`postgresql://…/papercusp`) or the flag form (`-d papercusp`). A `$`-bearing
 * connection is excluded by the pattern: we cannot know which database it
 * resolves to, and guessing is the wrong-database failure above.
 */
const OPERATOR_DB = /(?:\/papercusp\b|-d\s+papercusp\b)/;

/** Statements `dev:pg_query` accepts: a single read-only SELECT / WITH…SELECT. */
const READ_ONLY_STATEMENT = /^\s*(?:select|with)\b/i;

/** Anything that mutates — rejected by the tool's read-only transaction. */
const MUTATING = /\b(?:insert|update|delete|create|alter|drop|truncate|grant|revoke|begin|commit|vacuum|analyze)\b/i;

/** Extract the argument of `-c`, tolerating single or double quoting. */
function extractCommandArg(atom: string): string | null {
  const match = /-c\s+("([^"]*)"?|'([^']*)'?|(\S+))/.exec(atom);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * P-007a — `psql <operator-db> -c "SELECT …"`. The genuinely substitutable
 * subset, and the one the CLAUDE.md routing row already advertises.
 *
 * NOTE ON ATOM TRUNCATION: the atomiser splits on `;` and `|`, so a SQL body
 * containing either is cut short (`… ORDER BY id DESC LIMIT`). That is harmless
 * for matching — the verb, the connection and the leading SELECT all sit before
 * any separator — and the alternative (a quote-aware shell parser) costs far
 * more than it buys. Coverage therefore judges the statement's HEAD, which is
 * exactly what decides whether `dev:pg_query` accepts it.
 */
export const psqlSelectRead: SubstitutionPair = {
  id: 'postgres.psql-select',
  intentLabel: 'operator-db-select',
  bashPattern: new RegExp(
    // No shell expansion in the connection, and no heredoc.
    String.raw`^psql\s+(?![^\n]*[$\`])(?![^\n]*<<)` +
      // A literal operator-Postgres connection, then a -c SELECT/WITH.
      String.raw`[^\n]*(?:\/papercusp\b|-d\s+papercusp\b)[^\n]*-c\s+["']?\s*(?:select|with)\b`,
    'i',
  ),
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { sql } runs read-only SELECT/WITH against the operator Postgres directly — no connection string, no psql, and it applies the row cap and statement_timeout for you.',
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (!OPERATOR_DB.test(atom)) {
      return { covered: false, reason: 'targets a non-operator database; dev:pg_query has no database selector' };
    }
    const sql = extractCommandArg(atom);
    if (!sql) return { covered: false, reason: 'no -c statement to run' };
    if (!READ_ONLY_STATEMENT.test(sql)) {
      return { covered: false, reason: `statement is not a SELECT/WITH ("${sql.slice(0, 40)}")` };
    }
    // A leading SELECT followed by a mutation keyword would be a compound
    // statement; dev:pg_query takes exactly one read-only statement.
    const body = sql.replace(READ_ONLY_STATEMENT, '');
    if (MUTATING.test(body)) {
      return { covered: false, reason: 'compound or mutating statement; dev:pg_query accepts one read-only statement' };
    }
    return { covered: true, expression: `dev:pg_query { sql: "${sql.slice(0, 60)}…" }` };
  },
};

/**
 * P-007b — `psql <operator-db> -c "\d table"`: schema introspection.
 *
 * 88 atoms, and the single largest psql residue with no tool form. `\d` is a
 * psql CLIENT meta-command, not SQL, so it cannot be passed through
 * `dev:pg_query` at all — an agent inspecting a table's columns, indexes or
 * constraints has no choice but to shell out.
 *
 * Closed by P-011, which adds a `describe` mode to `dev:pg_query` rather than
 * inventing a second tool: it is the same capability (read the operator DB),
 * the same read-only envelope, and the same routing row.
 */
export const psqlDescribe: SubstitutionPair = {
  id: 'postgres.psql-describe',
  intentLabel: 'operator-db-describe',
  bashPattern: new RegExp(
    String.raw`^psql\s+(?![^\n]*[$\`])[^\n]*(?:\/papercusp\b|-d\s+papercusp\b)[^\n]*-c\s+["']?\s*\\d`,
    'i',
  ),
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { describe: "schema.table" } returns columns, indexes and constraints — the `\\d` equivalent, without a psql round-trip.',
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const sql = extractCommandArg(atom);
    if (!sql) return { covered: false, reason: 'no -c meta-command' };
    const match = /^\s*\\d\+?\s+(\S+)/.exec(sql);
    if (!match) {
      // Bare `\d` (list every relation) and `\dt`/`\di` family variants.
      if (/^\s*\\d[a-z+]*\s*$/.test(sql)) {
        return { covered: true, expression: 'dev:pg_query { describe: "*" } // relation listing' };
      }
      return { covered: false, reason: `unsupported psql meta-command "${sql.slice(0, 30)}"` };
    }
    return { covered: true, expression: `dev:pg_query { describe: "${match[1]}" }` };
  },
};

/** Every pair in the postgres family, in registry order. */
export const POSTGRES_PAIRS: SubstitutionPair[] = [psqlSelectRead, psqlDescribe];
