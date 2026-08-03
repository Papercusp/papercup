#!/usr/bin/env node
/**
 * check-partial-index-alignment.mjs — WI-8806
 *
 * A query may use a PARTIAL index only if the planner can prove the index covers every
 * row the query needs, which means the query must STATE the index's WHERE predicate.
 * Filtering on the indexed EXPRESSION alone is not enough.
 *
 * This lint covers one tight, mechanically-decidable slice of that rule — the slice that
 * has actually bitten this repo three times:
 *
 *     CREATE INDEX ... ON t ((col ->> 'k'))  WHERE (col ? 'k')
 *
 * The indexed expression is the VALUE of a jsonb key, and the predicate is that key's
 * PRESENCE test. PostgreSQL's predicate-implication prover cannot derive `col ? 'k'`
 * from `col ->> 'k' = $1` (different operators over different expressions), so a query
 * that omits the presence test silently falls back to a full table scan.
 *
 * WHY A LINT AND NOT VIGILANCE. The failure is invisible from every direction a human
 * looks: the query is correct, returns the right rows, the index exists and looks used,
 * and nothing errors. The only symptom is cost. All three known instances were found by
 * hand, one at a time, months apart. Measured on the live DB with EXPLAIN (ANALYZE, BUFFERS):
 *
 *   reply-deadline-sweep      40,684 ->   721 buffers    (56x)     156.9ms ->  8.96ms
 *   allhive-broadcast-sweep 4,731,095 -> 3,341 buffers (1,416x)  13,312ms -> 25.9ms  (514x)
 *   task_ledger bash-job lookup   197 ->     1 buffer   (197x)      4.93ms ->  0.042ms
 *
 * The first two returned ZERO rows while reading all 86,722 rows of the table. The third
 * had an idx_scan of exactly 0 — the index had never been used once since it was created.
 *
 * ADDING THE CLAUSE IS SEMANTICALLY FREE, in the comparison positions this lint flags:
 * `col ->> 'k'` is NULL when the key is absent, and NULL satisfies no comparison, so the
 * rows `col ? 'k'` excludes could never have matched anyway. That is exactly why the clause
 * reads as redundant noise and keeps getting "simplified" away. It is load-bearing for the
 * PLAN, not for the RESULT.
 *
 * DESIGN NOTES (each earned from a real false positive while building this):
 *
 *  - STATEMENT SCOPE, NOT LINE SCOPE. The guard routinely sits on a neighbouring line of the
 *    same statement (sync-resolver's reply-chain CTE states it one line ABOVE the join it
 *    protects). A line-scoped check reported three false positives there. Scope is the
 *    tagged template literal.
 *  - COMMENTS ARE STRIPPED FIRST. Several of these queries carry long comments that quote
 *    the very expression they discuss; unanswered-directed.ts names `body->>'related_msg_id'`
 *    inside a comment paragraph about jsonb statistics.
 *  - COALESCE IS EXCLUDED. `COALESCE(body->>'k', msg_id) IN (...)` deliberately wants the
 *    rows WITHOUT the key; adding the presence test would change the result.
 *  - IS NULL IS EXCLUDED. `col ->> 'k' IS NULL` and `NOT (col ? 'k')` genuinely disagree when
 *    the key is present with a JSON null value, so the clause is NOT free there.
 *  - ALIAS-INSENSITIVE MATCHING is deliberate: the guard is required to name the same column
 *    and key, not the same alias. Matching aliases exactly would flag correct multi-CTE
 *    queries. This under-approximates (it can miss a guard stated for the wrong alias) —
 *    chosen on purpose, because a false positive on a hot shared file costs far more here
 *    than a missed one, and the measured instances are all single-alias.
 *
 * The index set is DERIVED, never hardcoded: it is read from the generated drizzle schema,
 * which `pull-schema.mjs` regenerates from the live database. A new index of this shape is
 * therefore covered the moment it lands, with no edit to this file — which is the whole
 * point, since every instance so far was one nobody knew to look for.
 *
 * Sibling: packages/operator-core/lib/agent-tools/coordination/partial-jsonb-index-alignment.test.ts
 * pins migration 691's predicate text and the two sweeps' clause ordering (the specific,
 * measurement-carrying guard). This lint is the general class detector. They are
 * complementary: the test asserts the index STAYS partial, the lint asserts queries stay
 * aligned with whatever partial indexes exist.
 *
 * Usage:  node scripts/check-partial-index-alignment.mjs [--json]
 * Exit 0 = aligned, 1 = at least one misaligned query site.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const SCHEMA_FILE = join(REPO_ROOT, 'libs/papercusp/libs/db/src/schema/generated.ts');

/** Roots scanned for SQL. Kept explicit so a new tree is an opt-in decision, not a surprise. */
const SOURCE_ROOTS = [
  'packages/operator-core/lib',
  'packages/agent-mcp/src',
  'apps/operator/lib',
  'libs/papercusp/packages',
];

const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-host', 'build', '.next', 'coverage', '_retired', '__snapshots__']);

/**
 * Deliberate exceptions: 'repo/relative/path.ts' -> why it is allowed to omit the guard.
 * Empty by design — an entry here is a claim that the seq scan is CORRECT for that site,
 * and it must say why. Prefer fixing the query.
 */
const ALLOWLIST = new Map();

/* ------------------------------------------------------------------ index catalog */

/**
 * Extract the alignment-required index set from the generated drizzle schema.
 * Shape matched (one per line, as generated):
 *   index("name").using("btree", sql`((col ->> 'k'::text))`).where(sql`(... col ? 'k'::text ...)`)
 */
export function parseGuardedIndexes(schemaSrc) {
  const out = [];
  for (const line of schemaSrc.split('\n')) {
    if (!line.includes('.where(')) continue;
    const nameM = /(?:unique)?[Ii]ndex\("([^"]+)"\)/.exec(line);
    if (!nameM) continue;

    // The indexed expression(s) and the partial predicate are each inside sql`...`.
    const sqlSpans = [...line.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
    if (sqlSpans.length < 2) continue;
    const predicate = sqlSpans[sqlSpans.length - 1];
    const expression = sqlSpans.slice(0, -1).join(' ');

    // Presence tests in the predicate: `col ? 'key'`
    const guards = [...predicate.matchAll(/(\w+)\s*\?\s*'([^']+)'/g)].map((m) => ({ col: m[1], key: m[2] }));
    if (guards.length === 0) continue;

    for (const g of guards) {
      // Only the aligned shape: the indexed EXPRESSION must read the guarded key's value.
      const readsValue = new RegExp(`\\b${g.col}\\s*->>\\s*'${escapeRe(g.key)}'`).test(expression);
      if (!readsValue) continue;
      out.push({ index: nameM[1], col: g.col, key: g.key });
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ SQL extraction */

/**
 * Find tagged-template SQL literals: sql`...`, sql<T[]>`...`, coordSql()`...` is NOT matched
 * (the call form assigns to `sql` first in this codebase, which the bare `sql` tag covers).
 *
 * Returns [{ text, srcIndex }] where `text` is the statement with each `${...}` interpolation
 * collapsed to a bound-parameter token, and `srcIndex[i]` is the offset IN THE ORIGINAL FILE
 * of `text[i]`. The map exists because collapsing interpolations changes lengths, so a naive
 * offset arithmetic reports the wrong line — which is worse than no line at all, since it
 * sends the reader to an innocent neighbouring statement.
 */
export function extractSqlTemplates(src) {
  const out = [];
  const tag = /\bsql\s*(?:<[^`>]*>)?\s*`/g;
  let m;
  while ((m = tag.exec(src))) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    let text = '';
    const srcIndex = [];
    const push = (ch, at) => {
      text += ch;
      srcIndex.push(at);
    };
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        push(src[i], i);
        if (src[i + 1] !== undefined) push(src[i + 1], i + 1);
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        depth++;
        i++;
        // interpolation reads as a bound parameter; every token char maps to the '$'
        for (const ch of ' ? ') push(ch, m.index);
        continue;
      }
      if (depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        continue;
      }
      if (c === '`') break;
      push(c, i);
    }
    if (i < src.length) {
      out.push({ text, srcIndex });
      tag.lastIndex = i + 1;
    }
  }
  return out;
}

/**
 * Blank out SQL line comments so a comment ABOUT the expression is never mistaken for a use.
 * Replaced with spaces rather than removed so every offset stays valid against `srcIndex`.
 */
const stripSqlComments = (s) => s.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));

/* ------------------------------------------------------------------ the check */

/**
 * A `col ->> 'key'` occurrence is a COMPARISON use (and so requires the guard) when it is
 * an operand of a comparison. Projections (`... AS x`), ORDER BY and COALESCE wrappers are not.
 */
export function findMisalignedUses(sqlText, { col, key }) {
  const text = stripSqlComments(sqlText);
  const accessor = `(?:\\w+\\.)?${escapeRe(col)}\\s*->>\\s*'${escapeRe(key)}'`;

  // Guard present anywhere in the same statement (alias-insensitive, see header note).
  const guarded = new RegExp(`(?:\\w+\\.)?${escapeRe(col)}\\s*\\?\\s*'${escapeRe(key)}'`).test(text);
  if (guarded) return [];

  const hits = [];
  const occ = new RegExp(accessor, 'g');
  let m;
  while ((m = occ.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);

    // COALESCE(...) deliberately admits key-absent rows — adding the guard changes results.
    if (/coalesce\s*\([^()]*$/i.test(before)) continue;
    // IS NULL / IS NOT NULL are NOT equivalent to the presence test (JSON null case).
    if (/^\s*(?:::\s*\w+\s*)?is\s+(?:not\s+)?null/i.test(after)) continue;

    const followsComparison = /(?:=|<>|!=|<=|>=|<|>|\bin|\blike|\bilike|~\*?)\s*$/i.test(before);
    const precedesComparison = /^\s*(?:::\s*\w+\s*)?(?:=|<>|!=|<=|>=|<|>|\bin\b|\bany\b|\blike\b|\bilike\b|~)/i.test(after);
    if (!followsComparison && !precedesComparison) continue;

    hits.push(m.index);
  }
  return hits;
}

/* ------------------------------------------------------------------ driver */

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e) && !/^(generated|schema)\.ts$/.test(e)) yield p;
  }
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;

function main() {
  const asJson = process.argv.includes('--json');

  let schemaSrc;
  try {
    schemaSrc = readFileSync(SCHEMA_FILE, 'utf8');
  } catch (err) {
    console.error(`[partial-index-alignment] cannot read generated schema at ${SCHEMA_FILE}: ${err.message}`);
    console.error('This lint derives its index set from that file. Run: node libs/papercusp/libs/db/scripts/pull-schema.mjs');
    process.exit(1);
  }

  const indexes = parseGuardedIndexes(schemaSrc);
  if (indexes.length === 0) {
    console.log('[partial-index-alignment] no partial jsonb value-and-presence indexes in the schema — nothing to align.');
    process.exit(0);
  }

  const violations = [];
  let filesScanned = 0;
  let statementsScanned = 0;

  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      filesScanned++;
      // Cheap pre-filter: no '->>' at all means nothing to check.
      if (!src.includes('->>')) continue;

      for (const tpl of extractSqlTemplates(src)) {
        statementsScanned++;
        for (const idx of indexes) {
          for (const off of findMisalignedUses(tpl.text, idx)) {
            violations.push({
              file: rel,
              line: lineOf(src, tpl.srcIndex[off] ?? 0),
              index: idx.index,
              col: idx.col,
              key: idx.key,
            });
          }
        }
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ indexes, violations, filesScanned, statementsScanned }, null, 2));
    process.exit(violations.length === 0 ? 0 : 1);
  }

  const idxList = indexes.map((i) => `${i.index} (${i.col} ->> '${i.key}')`).join('\n    ');
  if (violations.length === 0) {
    console.log(
      `[partial-index-alignment] OK — ${statementsScanned} SQL statements in ${filesScanned} files are aligned with ${indexes.length} partial index(es):\n    ${idxList}`,
    );
    process.exit(0);
  }

  console.error(`\n[partial-index-alignment] ${violations.length} misaligned query site(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`      compares ${v.col} ->> '${v.key}' without stating  ${v.col} ? '${v.key}'`);
    console.error(`      -> cannot use PARTIAL index ${v.index}; this statement falls back to a full table scan.\n`);
  }
  console.error(
    'WHY THIS MATTERS: the missing clause is semantically redundant in a comparison — ' +
      "`col ->> 'k'` is NULL when the key is absent and NULL matches no comparison — so adding it\n" +
      'cannot change your results. It is required for the PLANNER to use the partial index.\n' +
      'Measured instances of this exact omission: 56x, 1,416x and 197x fewer buffers once fixed.\n\n' +
      "FIX: add `AND <alias>.col ? 'key'` beside the existing comparison, in the same statement.\n" +
      'If the seq scan is genuinely correct here (e.g. you WANT key-absent rows), add the file to\n' +
      `ALLOWLIST in ${relative(REPO_ROOT, fileURLToPath(import.meta.url))} with the reason.\n`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
