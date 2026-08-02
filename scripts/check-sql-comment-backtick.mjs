#!/usr/bin/env node
/**
 * check-sql-comment-backtick.mjs — flag a backtick inside a `--` SQL comment
 * anywhere a postgres-js `sql`...`` tagged template OR a plain template-literal
 * SQL/DDL fixture is in play (EI-7661, widened EI-19317789732905891).
 *
 * A code comment inside SQL like `-- the bare `>=` applied …` has two failure
 * modes: (1) in a plain (non-tagged) TS template string it's a LOUD esbuild/tsc
 * parse error (TS1005) — annoying, but it reds the gate loudly and gets fixed
 * fast; (2) inside a postgres-js `sql`…`` TAGGED template it can be SILENT — the
 * backtick ENDS the JS template literal early, and the trailing text can
 * happen to parse as a valid (if nonsensical-looking) TS expression, so the
 * file compiles and RUNS with the SQL query truncated mid-comment.
 *
 * Concrete damage, silent case (2026-07-05, su-8dc11): a `-- the bare `>=`
 * applied …` comment inside the mig-504 LWW guard amputated the entire WHERE
 * clause from the engineer-issues + harness-features upserts — the
 * apply-guard vanished and stale writes applied unconditionally. Only caught
 * because the LWW unit test regressed; the wire-level query dump was the
 * actual diagnostic.
 *
 * Concrete damage, loud case (2026-08-02, EI-19317789732905891):
 * `packages/operator-core/test/_work-items-schema.ts` — 657 lines of raw SQL
 * DDL fixtures across 8 plain (non-`sql`-tagged) template-literal constants —
 * hit the SAME authoring mistake in a `-- ... `closed_ts` column comment ...`
 * line. No `sql`...`` tag anywhere in the file, so the original scope missed
 * it entirely; only a `tsc` run (unrelated to the fixture) surfaced the
 * TS1005s. Same house-style mistake (backtick-quoting a comment, exactly as
 * Markdown prose does everywhere else in this repo), same fix.
 *
 * This is a LINT, not a parser: it does not track true template-literal
 * boundaries (that's exactly what silently goes wrong at runtime). Instead it
 * uses the cheap, effective heuristic the incidents themselves suggest: a `--`
 * SQL line-comment essentially never legitimately appears outside a SQL
 * string in this codebase, so any line matching a `--` comment that also
 * contains a raw backtick is almost certainly SQL-comment text sitting inside
 * a template literal carrying SQL — flag it. Scoped to files that either use a
 * `sql`...`` tagged template OR contain raw DDL keywords (CREATE TABLE/VIEW/
 * INDEX) at all, to keep noise near zero; `inScope()` below additionally
 * excludes *.test.ts / *.integration.test.ts so ordinary test fixtures with
 * inline SQL stay out of scope (this guard targets non-test DDL-fixture
 * MODULES, the sites a mistake there is expensive and shared).
 *
 *   node scripts/check-sql-comment-backtick.mjs
 *
 * Fix: never put a backtick in a SQL comment. Rephrase with quotes, e.g.
 * `-- the bare '>=' applied …` instead of `` -- the bare `>=` applied … ``.
 */
import { readFileSync } from 'node:fs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

// WI-6730: enumerate via the shared helper, which recurses into submodules. A
// bare `git ls-files` does not — it emits one gitlink entry per submodule — so
// this guard never scanned a single file inside any of the 39 and printed ✓
// regardless. `unscanned` is reported on success rather than silently dropped.
const { files: tracked, unscanned } = listTrackedFiles(ROOT);

const inScope = (f) =>
  /\.(ts|tsx|mjs)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs)$/.test(f) &&
  !/\.integration\.test\.(ts|tsx)$/.test(f) &&
  !f.endsWith('.d.ts') &&
  // WI-6730: bundled sidecar BUILD OUTPUT (esbuild-minified serve.mjs — a single
  // 42MB line-wrapped bundle), not source. Recursing into submodules made it
  // visible for the first time and it produced 3 false positives: in minified
  // output a backtick lands next to a `--` by coincidence, and there is no
  // authored comment to rephrase. Same exclusion, same reason, as
  // check-no-raw-setinterval.mjs — keep the two in step.
  !f.includes('/env-sidecars/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/') &&
  !f.includes('/_retired/');

// A genuine SQL `--` comment marker: dash-dash preceded by start-of-line or
// whitespace, followed by whitespace (distinguishes it from a `--flag` /
// `--flag=value` CLI-argument token — those never have a space right after
// the dashes, and are the dominant false-positive source in this codebase's
// shell/CLI-wrapper files).
const SQL_COMMENT_MARKER = /(?:^|\s)--\s/;

// Only scan files that use a postgres-js sql-tagged template at all, to keep
// the heuristic scoped (a `--` in, say, a shell-script string elsewhere is
// out of scope for this specific failure mode).
const USES_SQL_TAG = /\bsql`/;

// EI-19317789732905891 (2026-08-02): the ORIGINAL failure mode (a `sql`...``
// tagged template silently truncated by an embedded backtick) has a sibling
// that is even more dangerous, because it is LOUD instead of silent — a plain
// (non-tagged) TS template literal holding raw SQL DDL fixture text, where the
// same backtick-in-comment mistake is a hard TS1005 PARSE ERROR that reds the
// fleet gate for everyone. `_work-items-schema.ts` (657 lines of DDL across 8
// exported template-literal constants) is the highest-risk site in the tree
// and carried zero coverage from USES_SQL_TAG alone, since it never uses the
// `sql`...`` tag — it just assigns `` `CREATE TABLE ...` `` to a const. Widen
// scope to any file containing raw DDL keywords, whether or not it also uses
// the postgres-js tag. `inScope()` above already excludes *.test.ts /
// *.integration.test.ts, which is what keeps this from lighting up every
// integration-test fixture in the repo (those deliberately stay out of scope
// — this guard is about non-test DDL-fixture MODULES, not every ad-hoc SQL
// string a test happens to inline).
const HAS_RAW_DDL = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|(?:UNIQUE\s+)?INDEX)\b/;

/** An UNESCAPED backtick at or after `fromIndex` — a `\`` escape inside a JS
 *  template literal does not end it, so it's not the failure signature. */
function hasUnescapedBacktick(line, fromIndex) {
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') return true;
  }
  return false;
}

const offenders = [];
for (const f of tracked) {
  if (!inScope(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!USES_SQL_TAG.test(text) && !HAS_RAW_DDL.test(text)) continue;
  text.split('\n').forEach((line, i) => {
    const m = SQL_COMMENT_MARKER.exec(line);
    if (!m) return;
    // Skip a `//`-style JS comment line entirely (its `--`/backtick content is
    // just prose, not SQL) — only flag when the `--` isn't itself preceded by
    // a `//` earlier on the line.
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const slash = line.indexOf('//');
    const dashIdx = m.index + m[0].indexOf('--');
    if (slash !== -1 && slash < dashIdx) return;
    if (!hasUnescapedBacktick(line, dashIdx)) return;
    offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 140)}`);
  });
}

if (offenders.length === 0) {
  console.log(
    `✓ no backtick inside a \`--\` SQL comment near a sql\`...\` tagged template (EI-7661).${describeUnscanned(unscanned)}`,
  );
  process.exit(0);
}

console.error('✗ backtick inside a `--` SQL comment — silently truncates a postgres-js sql`...` tagged template (EI-7661):');
console.error('  The backtick ends the JS template literal early; the trailing text can still parse as valid TS,');
console.error('  so the file compiles and RUNS with the SQL query truncated mid-comment (a WHERE clause vanishing');
console.error('  is exactly how the mig-504 LWW guard regressed on 2026-07-05).');
console.error("  Fix: rephrase the comment without a backtick, e.g. use quotes — \"-- the bare '>=' applied …\".\n");
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} offender(s).`);
process.exit(1);
