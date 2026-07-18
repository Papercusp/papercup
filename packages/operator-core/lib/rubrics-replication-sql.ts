/**
 * rubrics-replication-sql — EI-10514: schema-validate the SQL embedded in a rubric
 * criterion's REPLICATION DRILL text at propose/amend/ratify time.
 *
 * WHY: rubric replication drills are authored FROM MEMORY of the live schema (they're
 * prose, not code — nothing type-checks or runs them at write time). The first real
 * execution of the pot-coordination-health drills (wake-13, EI-10478) found 10 of 14
 * embedded SQL statements referenced renamed/nonexistent tables/columns
 * (routed_ideas → harness_shared.scout_routed_ideas, scout_ticks.ideas_count →
 * ideas_generated, blender_idea_grades → doesn't exist, …) — a drill that LOOKS like a
 * testing procedure but nobody can actually run, exactly the silent failure the owner's
 * testing-procedure mandate exists to eliminate. This runs a cheap, non-blocking
 * `EXPLAIN (COSTS OFF)` pass over every isolable SQL statement in a criterion's
 * replication text and surfaces (never rejects — see below) anything that wouldn't
 * parse/plan against the live schema, the same idea as plans:lint's validation pass.
 *
 * NON-BLOCKING BY DESIGN: unlike the WI-4287 loss-guards (which throw — they protect
 * against silently losing STORED content, a fully in-our-control invariant), a bad SQL
 * reference is checked against EXTERNAL, moving-target state (the live schema can
 * legitimately be unreachable, mid-migration, or simply slow) — rejecting a propose on a
 * transient DB hiccup would be worse than the bug this fixes. Findings are surfaced in
 * the tool response next to `completeness`, for the caller/reviewer to act on.
 *
 * Extraction is deliberately CONSERVATIVE. A criterion's replication field is free-text
 * prose that may embed zero, one, or several SQL statements anywhere, often followed by
 * more prose with no semicolon in between (e.g. "... ORDER BY invoked_at. Count calls
 * with tool_name LIKE 'plur%' ..." — the query truly ends at the bare period, not the
 * first `;` several sentences later). Mis-slicing a statement produces a FALSE POSITIVE
 * syntax error that erodes trust in the check; failing to isolate an ambiguous one is
 * merely a quiet miss. The asymmetry favors under-detection: a statement is only
 * extracted when its extent is unambiguous — terminated by a `;`, by a `.` immediately
 * followed by whitespace (a sentence boundary — SQL never has a bare `.<space>` outside
 * a string literal: schema-qualified names and numeric literals never have a space after
 * the dot), or by the end of the field text — all tracked OUTSIDE single-quoted string
 * literals so an embedded `'e.g. ...'`/`'a; b'` never triggers a false cut.
 */

import {
  explainReadQuery,
  extractPgErrorInfo,
  type PgErrorInfo,
} from './pg-read-query';

/** Matches the start of a top-level SQL read statement embedded in prose. */
const SQL_START_RE = /\b(SELECT|WITH)\b/gi;

/**
 * PURE: scan from `start` for the end of one SQL statement, tracking single-quoted
 * string state (with '' escaping) so a `;` or sentence-boundary `.` INSIDE a string
 * literal is never mistaken for the statement's end. Returns the index of the first
 * unquoted `;`, the first unquoted `.` followed by whitespace, or `text.length` if
 * neither occurs (the statement runs to the end of the field).
 */
function findUnquotedStatementEnd(text: string, start: number): number {
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++; // escaped '' — still inside the literal
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === ';') return i;
    if (ch === '.' && /\s/.test(text[i + 1] ?? '')) return i;
  }
  return text.length;
}

/**
 * PURE: extract every unambiguously-delimited SQL statement embedded in free-text drill
 * prose (a criterion's `replication` field). Nested/subquery SELECTs inside an already-
 * captured statement are not independently re-extracted. See module doc for the
 * conservative-extraction rationale.
 */
export function extractReplicationSqlStatements(text: string | undefined | null): string[] {
  const out: string[] = [];
  if (!text) return out;
  SQL_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumedUntil = -1;
  while ((match = SQL_START_RE.exec(text))) {
    const start = match.index;
    if (start < consumedUntil) continue; // nested inside a previously captured statement
    const end = findUnquotedStatementEnd(text, start);
    consumedUntil = end;
    // strip a lone trailing sentence-period this scan intentionally leaves attached
    // when the statement runs to end-of-text (findUnquotedStatementEnd never itself
    // strips it — only the `.`+whitespace mid-text case is excluded from the slice).
    const stmt = text.slice(start, end).trim().replace(/\.$/, '').trim();
    if (stmt) out.push(stmt);
  }
  return out;
}

/** One embedded SQL statement that failed to parse/plan against the live schema. */
export interface ReplicationSqlFinding {
  criterionKey: string;
  sql: string;
  error: PgErrorInfo;
}

export interface ReplicationSqlValidationResult {
  /** Total embedded statements isolated + checked across all criteria. */
  checked: number;
  /** Statements that failed EXPLAIN (undefined table/column/function, syntax, …). */
  findings: ReplicationSqlFinding[];
  /** true when every checked statement parsed/planned cleanly (or nothing to check). */
  ok: boolean;
}

/** Bound worst-case latency on a rubric with an unusually large number of embedded
 *  statements — EXPLAIN is cheap (single-digit ms) but this stays a hard ceiling. */
const MAX_STATEMENTS_CHECKED = 60;

/**
 * Run the EI-10514 schema-validation pass over every criterion's replication text.
 * Best-effort / fail-open: any unexpected error from the check itself (not a specific
 * statement's EXPLAIN failure — that's a legitimate finding) is swallowed so a lint-style
 * check never breaks the write path it's advising on.
 */
export async function validateRubricReplicationSql(
  criteria: ReadonlyArray<{ key: string; replication?: string }>,
): Promise<ReplicationSqlValidationResult> {
  const findings: ReplicationSqlFinding[] = [];
  let checked = 0;
  try {
    outer: for (const c of criteria) {
      for (const sql of extractReplicationSqlStatements(c.replication)) {
        if (checked >= MAX_STATEMENTS_CHECKED) break outer;
        checked++;
        const result = await explainReadQuery(sql).catch(
          (err): { ok: false; error: PgErrorInfo } => ({ ok: false, error: extractPgErrorInfo(err) }),
        );
        if (!result.ok) {
          findings.push({ criterionKey: c.key, sql, error: result.error });
        }
      }
    }
  } catch {
    // fail-open — see module doc: never let this advisory check break a rubric write.
  }
  return { checked, findings, ok: findings.length === 0 };
}
