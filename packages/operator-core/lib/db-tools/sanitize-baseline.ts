/**
 * sanitize-baseline.ts — transform a raw `pg_dump --schema-only` into an
 * IDEMPOTENT `000-baseline.sql`.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 0 (P-003).
 *
 * The reference build (build-reference-schema.ts) emits a plain pg_dump. The
 * migration runner applies a file exactly once (tracked in schema_migrations),
 * BUT two requirements force strict statement-level idempotency anyway:
 *   1. P-003 acceptance — applying the output twice against an empty DB is a
 *      clean no-op on the second run.
 *   2. Deployed-DB safety (P-007) — the baseline must no-op on an ALREADY
 *      populated live/embedded DB (every table/constraint/policy already there)
 *      and simply get marked applied.
 *
 * Transform rules (by leading statement keyword):
 *   • SET … / SELECT pg_catalog.set_config(…)      → DROP (psql/session noise)
 *   • CREATE SCHEMA                                 → CREATE SCHEMA IF NOT EXISTS
 *   • CREATE TABLE                                  → CREATE TABLE IF NOT EXISTS
 *   • CREATE SEQUENCE                               → CREATE SEQUENCE IF NOT EXISTS
 *   • CREATE [UNIQUE] INDEX                         → … IF NOT EXISTS
 *   • CREATE FUNCTION                               → CREATE OR REPLACE FUNCTION
 *   • CREATE TRIGGER                                → CREATE OR REPLACE TRIGGER  (PG14+)
 *   • CREATE POLICY p ON t …                        → DROP POLICY IF EXISTS p ON t; CREATE POLICY …
 *   • ALTER TABLE [ONLY] … ADD CONSTRAINT …         → DO-block guard (catch duplicate_object/_table)
 *   • ALTER TABLE … ENABLE ROW LEVEL SECURITY       → keep (idempotent)
 *   • ALTER TABLE ONLY … ALTER COLUMN … SET DEFAULT → keep (idempotent)
 *   • ALTER SEQUENCE … OWNED BY                      → keep (idempotent)
 *   • COMMENT ON …                                  → keep (always replaces)
 *   • anything else                                 → keep + warn (so new shapes surface)
 *
 * NOTE: framework roles + the 3 extensions (pgcrypto/pg_trgm/vector) are NOT in
 * this file — they're created in the embedded-pg BOOT pre-migration step (Phase 1
 * P-004), cluster-level, before any schema-only baseline runs.
 *
 *   Run:  cd apps/operator && npx tsx lib/db-tools/sanitize-baseline.ts [rawIn] [out]
 *   In:   default /tmp/papercusp-reference-schema.raw.sql
 *   Out:  default /tmp/000-baseline.sql  (landing it in libs/papercusp/libs/db/sql/
 *         is the Phase-1 squash — deliberately NOT done here while sql/ churns)
 */

/** A DO-block dollar tag chosen to never collide with dumped content. */
const GUARD_TAG = '$baseline_guard$';

/**
 * Split SQL into top-level statements (trailing `;` stripped), respecting
 * dollar-quoted strings ($tag$…$tag$), single-quoted strings ('' escape), and
 * `--` line comments. Block comments are not emitted by pg_dump schema-only.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  let dollarTag: string | null = null; // current open $tag$, or null
  let inSingle = false;

  while (i < n) {
    const ch = sql[i];

    // Inside a dollar-quoted body: look only for the closing tag.
    if (dollarTag !== null) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }

    // Inside a single-quoted string.
    if (inSingle) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += "'"; // escaped quote ''
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    // Line comment → consume to end-of-line (kept verbatim).
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Open a dollar-quote: $tag$ where tag is [A-Za-z0-9_]* .
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** Strip leading `--` comment lines + blanks; return the code-bearing remainder. */
function stripLeadingComments(stmt: string): string {
  const lines = stmt.split('\n');
  let k = 0;
  while (k < lines.length && /^\s*(--.*)?$/.test(lines[k])) k += 1;
  return lines.slice(k).join('\n');
}

/**
 * Transform one statement (no trailing `;`) into its idempotent form.
 * Returns the rewritten statement, or `null` to drop it.
 * `onUnknown` is called with the leading token for statements left untouched
 * that aren't on the known-idempotent keep-list (surfaces new pg_dump shapes).
 */
export function transformStatement(stmt: string, onUnknown?: (token: string) => void): string | null {
  const code = stripLeadingComments(stmt);
  if (!code.trim()) return null; // comment-only chunk

  // --- DROP: psql backslash metacommands (PG18 \restrict/\unrestrict, \connect, …) ---
  if (/^\s*\\[a-z]/i.test(code)) return null;

  // --- DROP: session/psql noise ---
  if (/^\s*SET\s/i.test(code)) return null;
  if (/^\s*SELECT\s+pg_catalog\.set_config/i.test(code)) return null;
  if (/^\s*SELECT\s+pg_catalog\.setval/i.test(code)) return null; // data, not schema

  // --- CREATE … IF NOT EXISTS family ---
  if (/^\s*CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+SCHEMA\s+)/i, '$1IF NOT EXISTS ');
  }
  if (/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+TABLE\s+)/i, '$1IF NOT EXISTS ');
  }
  if (/^\s*CREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+SEQUENCE\s+)/i, '$1IF NOT EXISTS ');
  }
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)/i, '$1IF NOT EXISTS ');
  }

  // --- CREATE OR REPLACE family ---
  if (/^\s*CREATE\s+FUNCTION\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)FUNCTION\s/i, '$1OR REPLACE FUNCTION ');
  }
  if (/^\s*CREATE\s+TRIGGER\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)TRIGGER\s/i, '$1OR REPLACE TRIGGER ');
  }
  if (/^\s*CREATE\s+VIEW\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)VIEW\s/i, '$1OR REPLACE VIEW ');
  }

  // --- CREATE POLICY → DROP-then-CREATE ---
  const pol = /^\s*CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+([\w.]+(?:\."?[\w]+"?)?)/i.exec(code);
  if (pol) {
    return `DROP POLICY IF EXISTS ${pol[1]} ON ${pol[2]};\n${code}`;
  }

  // --- ALTER TABLE … ADD CONSTRAINT → DO-block guard ---
  // Tolerate every "already exists" code an idempotent re-apply can raise:
  //   duplicate_object (42710)         — duplicate constraint name (FK/UNIQUE/CHECK)
  //   duplicate_table (42P07)          — duplicate relation
  //   invalid_table_definition (42P16) — "multiple primary keys not allowed" (PK re-add;
  //                                       PG checks for an existing PK before the name clash)
  //   wrong_object_type (42809)        — later migrations converted the relation to a view
  //                                       (baseline table DDL re-applies as a no-op)
  // Safe in this context: statements come from a pg_dump of a VALID schema, so the only
  // re-run failure mode is "already present", never a genuinely invalid definition.
  if (/^\s*ALTER\s+TABLE\s/i.test(code) && /\bADD\s+CONSTRAINT\b/i.test(code)) {
    return (
      `DO ${GUARD_TAG} BEGIN\n` +
      `  ${code.trim()};\n` +
      `EXCEPTION\n` +
      `  WHEN duplicate_object THEN NULL;\n` +
      `  WHEN duplicate_table THEN NULL;\n` +
      `  WHEN invalid_table_definition THEN NULL;\n` +
      `  WHEN wrong_object_type THEN NULL;\n` +
      `END ${GUARD_TAG}`
    );
  }

  // --- Known-idempotent keepers ---
  if (/^\s*ALTER\s+TABLE\s+.*ENABLE\s+ROW\s+LEVEL\s+SECURITY/is.test(code)) return code;
  if (/^\s*ALTER\s+TABLE\s+.*ALTER\s+COLUMN\s+.*SET\s+DEFAULT/is.test(code)) return code;
  if (/^\s*ALTER\s+TABLE\s+.*REPLICA\s+IDENTITY/is.test(code)) return code; // CDC; re-set = no-op
  if (/^\s*ALTER\s+SEQUENCE\s/i.test(code)) return code; // OWNED BY — idempotent
  if (/^\s*COMMENT\s+ON\s/i.test(code)) return code; // always replaces

  // Unknown shape: keep it (don't silently lose schema) but flag it.
  const token = (code.trim().split(/\s+/).slice(0, 2).join(' ') || code.trim()).slice(0, 40);
  onUnknown?.(token);
  return code;
}

export interface SanitizeResult {
  sql: string;
  /** Leading tokens of statements that hit the unknown-shape fallback. */
  unknown: string[];
}

export function sanitizeBaselineVerbose(raw: string): SanitizeResult {
  const unknown: string[] = [];
  const header = [
    '-- 000-baseline.sql — GENERATED by sanitize-baseline.ts from a reference build.',
    '-- Idempotent: safe to re-apply against an empty OR an already-populated DB.',
    '-- Do not hand-edit; regenerate via build-reference-schema.ts → sanitize-baseline.ts.',
    '-- Schema changes are NEW migrations (104+), never edits here. (Plan: self-contained-migration-baseline-2026-06-02)',
  ].join('\n');

  // Strip psql backslash metacommands line-first (PG18 emits \restrict/\unrestrict
  // with NO trailing ';', so they'd otherwise merge into the next statement).
  const deMeta = raw
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');

  const body: string[] = [];
  for (const stmt of splitStatements(deMeta)) {
    const t = transformStatement(stmt, (tok) => unknown.push(tok));
    if (t !== null) body.push(t + ';');
  }
  return { sql: `${header}\n\n${body.join('\n\n')}\n`, unknown };
}

export function sanitizeBaseline(raw: string): string {
  return sanitizeBaselineVerbose(raw).sql;
}

// --- CLI (only when run directly, not when imported by the test) ---
if (process.argv[1]?.endsWith('sanitize-baseline.ts')) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const inPath = process.argv[2] ?? '/tmp/papercusp-reference-schema.raw.sql';
  const outPath = process.argv[3] ?? '/tmp/000-baseline.sql';
  const { sql, unknown } = sanitizeBaselineVerbose(readFileSync(inPath, 'utf8'));
  writeFileSync(outPath, sql);
  const tables = (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  console.log(`[sanitize] ${inPath} → ${outPath}`);
  console.log(`[sanitize] ${tables} tables; ${sql.split('\n').length} lines`);
  if (unknown.length) {
    console.warn(`[sanitize] ${unknown.length} statement(s) hit the unknown-shape fallback (kept verbatim):`);
    for (const u of [...new Set(unknown)]) console.warn(`  • ${u}`);
  } else {
    console.log('[sanitize] no unknown statement shapes — every statement matched a transform/keep rule');
  }
}
