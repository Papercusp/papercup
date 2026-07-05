#!/usr/bin/env node
/**
 * check-sql-comment-backtick.mjs — flag a backtick inside a `--` SQL comment
 * anywhere a postgres-js `sql`...`` tagged template is in play (EI-7661).
 *
 * A code comment inside SQL like `-- the bare `>=` applied …` has two failure
 * modes: (1) in a plain TS template string it's a LOUD esbuild parse error;
 * (2) inside a postgres-js `sql`…`` TAGGED template it can be SILENT — the
 * backtick ENDS the JS template literal early, and the trailing text can
 * happen to parse as a valid (if nonsensical-looking) TS expression, so the
 * file compiles and RUNS with the SQL query truncated mid-comment.
 *
 * Concrete damage (2026-07-05, su-8dc11): a `-- the bare `>=` applied …`
 * comment inside the mig-504 LWW guard amputated the entire WHERE clause from
 * the engineer-issues + harness-features upserts — the apply-guard vanished
 * and stale writes applied unconditionally. Only caught because the LWW unit
 * test regressed; the wire-level query dump was the actual diagnostic.
 *
 * This is a LINT, not a parser: it does not track true template-literal
 * boundaries (that's exactly what silently goes wrong at runtime). Instead it
 * uses the cheap, effective heuristic the incident itself suggests: a `--`
 * SQL line-comment essentially never legitimately appears outside a SQL
 * string in this codebase, so any line matching a `--` comment that also
 * contains a raw backtick is almost certainly SQL-comment text sitting inside
 * a `sql`…`` tagged template — flag it. Scoped to files that use a `sql`...``
 * tagged template at all, to keep noise near zero.
 *
 *   node scripts/check-sql-comment-backtick.mjs
 *
 * Fix: never put a backtick in a SQL comment. Rephrase with quotes, e.g.
 * `-- the bare '>=' applied …` instead of `` -- the bare `>=` applied … ``.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);

const inScope = (f) =>
  /\.(ts|tsx|mjs)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs)$/.test(f) &&
  !/\.integration\.test\.(ts|tsx)$/.test(f) &&
  !f.endsWith('.d.ts');

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
  if (!USES_SQL_TAG.test(text)) continue;
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
  console.log('✓ no backtick inside a `--` SQL comment near a sql`...` tagged template (EI-7661).');
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
