#!/usr/bin/env node
/**
 * check-smart-quotes.mjs — fail-loud guard for "smart"/curly quotes used as
 * CODE in .ts/.tsx (EI-418, found via EI-412).
 *
 * A curly quote (U+2018 ' / U+2019 ' / U+201C " / U+201D ") used where a
 * straight code delimiter belongs — e.g. `describe('x', …)` written with
 * curly quotes after a copy-paste through a smart-quoting surface — is a HARD
 * esbuild/tsc parse failure (`Transform failed: Unexpected "'"`), and the
 * symptom reads as mysterious until you `cat -A` the bytes. This caught
 * loopback-fetch.test.ts only after the red-test watchdog fired 3×/6h (EI-412).
 *
 *   node scripts/check-smart-quotes.mjs
 *
 * Detection is PRECISE, not a blanket non-ASCII ban: a curly quote is flagged
 * ONLY when the TypeScript parser emits a syntax diagnostic at that exact
 * offset — i.e. it is genuinely in code position. Curly quotes inside string
 * literals, template literals, comments, and JSX text (em-dashes, prose, a
 * user-facing `Don't`) parse cleanly and are LEFT ALONE — zero false positives
 * on code that compiles.
 *
 * Fix a hit by replacing the curly quote with a straight ' or ". Gotcha: if
 * the curly quote is an apostrophe inside a string (`'…the caller's to handle'`),
 * a blanket swap breaks the string — escape it (`caller\'s`) or re-delimit.
 *
 * Scope: tracked .ts/.tsx. Excludes _retired/, node_modules, dist, and this
 * script. Fast path: a file with no curly-quote byte is never parsed.
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CURLY = /[‘’“”]/;
const CURLY_G = /[‘’“”]/g;
const label = (ch) =>
  ({ '‘': 'U+2018 ‘', '’': 'U+2019 ’', '“': 'U+201C “', '”': 'U+201D ”' })[ch] ?? 'curly quote';

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f === 'scripts/check-smart-quotes.mjs';

/**
 * Pure detector: curly-quote offsets that sit in CODE position (the TS parser
 * emits a syntactic diagnostic at the offset). Exported for unit reuse.
 */
export function findCodePositionCurlyQuotes(fileName, text) {
  if (!CURLY.test(text)) return [];
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);
  const diags = sf.parseDiagnostics ?? [];
  // Offsets where a syntactic diagnostic begins (curly-as-code → TS1127 etc.).
  const diagStarts = new Set();
  for (const d of diags) {
    if (typeof d.start === 'number') diagStarts.add(d.start);
  }
  const hits = [];
  for (const m of text.matchAll(CURLY_G)) {
    const offset = m.index;
    // Flag the curly quote only if a parse error starts at it (code position)
    // or immediately after it (the char it tried to open a token with).
    if (diagStarts.has(offset) || diagStarts.has(offset + 1)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(offset);
      hits.push({ line: line + 1, col: character + 1, ch: m[0] });
    }
  }
  return hits;
}

function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!/\.(ts|tsx)$/.test(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    if (!CURLY.test(text)) continue; // fast path — never parse a clean file
    for (const h of findCodePositionCurlyQuotes(f, text)) {
      offenders.push(`${f}:${h.line}:${h.col}  [${label(h.ch)} used as code]`);
    }
  }

  if (offenders.length === 0) {
    console.log('✓ no curly/smart quotes used as code in .ts/.tsx.');
    process.exit(0);
  }

  console.error('✗ curly/smart quotes are being used as CODE (not inside a string/comment) —');
  console.error('  this is a hard esbuild/tsc parse failure ("Transform failed: Unexpected …").');
  console.error("  Replace with a straight ' or \". If the curly quote is an apostrophe inside a");
  console.error("  string (caller’s), escape it (caller\\'s) or re-delimit — don't blanket-swap.\n");
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See EI-418 / EI-412.`);
  process.exit(1);
}

// Run only as the entry point — importing for reuse (the detector) has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
