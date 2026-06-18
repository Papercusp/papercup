#!/usr/bin/env node
// scripts/cc-hooks/pretooluse-content-lint.mjs
//
// PreToolUse (Edit|Write|MultiEdit) ADVISORY content-lint — git-sync-dx-hardening-2026-06-17 P-013.
//
// WHY
//   The git-sync content-guard quarantines a .ts/.tsx file containing a curly/"smart" quote in
//   CODE position (a HARD tsc/esbuild parse failure) only AFTER commit — feedback the author
//   sees ~10-50 min later, buried in coord. This fires at EDIT time so the author sees
//   "curly quote at line N — fix it" BEFORE the broken file is ever committed.
//
// CONTRACT (advisory — NEVER blocks, FAIL-OPEN)
//   - Only .ts/.tsx writes. FAST PATH: a file with NO curly-quote byte exits 0 immediately —
//     no `typescript` load. Only when a curly quote IS present (rare) do we dynamically import
//     typescript and run the PRECISE code-position detector (zero false positives: a curly quote
//     inside a string / comment / JSX text parses cleanly and is left alone).
//   - On a CODE-position hit: prints additionalContext (model-facing) + exit 0 (edit PROCEEDS).
//   - FAIL-OPEN: any error / timeout / non-.ts path -> exit 0, silent. A bug here must NEVER
//     block an edit; the post-commit content-guard remains the real backstop.
//
import process from 'node:process';

const CURLY = /[‘’“”]/;
const CURLY_G = /[‘’“”]/g;
const SMART_LABEL = { '‘': 'U+2018 ‘', '’': 'U+2019 ’', '“': 'U+201C “', '”': 'U+201D ”' };

main();

async function main() {
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';

    if (!/\.tsx?$/.test(filePath)) return done(); // only .ts / .tsx
    const content = extractContent(tool, input);
    if (!content || !CURLY.test(content)) return done(); // FAST: no curly quote → no typescript load

    const mod = await import('typescript');
    const ts = mod.default ?? mod;
    const hits = findCodePositionCurlyQuotes(ts, filePath, content);
    if (hits.length) warn(filePath, hits);
  } catch {
    // fall through to silent allow (fail-open)
  }
  done();
}

function extractContent(tool, input) {
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => e && e.new_string).filter(Boolean).join('\n');
  }
  return '';
}

// Ported from packages/operator-core/lib/content-lint/smart-quotes.ts (kept in sync in spirit):
// flag a curly quote ONLY when the TS parser emits a syntactic diagnostic at (or just after)
// its offset — i.e. it is genuinely in code position. Curly quotes in strings/comments/JSX
// text parse cleanly and are NOT flagged (zero false positives).
function findCodePositionCurlyQuotes(ts, fileName, text) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind);
  const diags = sf.parseDiagnostics ?? [];
  const diagStarts = new Set();
  for (const d of diags) {
    if (typeof d.start === 'number') diagStarts.add(d.start);
  }
  const hits = [];
  for (const m of text.matchAll(CURLY_G)) {
    const offset = m.index;
    if (diagStarts.has(offset) || diagStarts.has(offset + 1)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(offset);
      hits.push({ line: line + 1, col: character + 1, ch: m[0] });
    }
  }
  return hits;
}

function warn(filePath, hits) {
  const base = filePath.split(/[/\\]/).pop();
  const where = hits
    .slice(0, 5)
    .map((h) => `line ${h.line}:${h.col} ${SMART_LABEL[h.ch] ?? h.ch}`)
    .join(', ');
  const msg =
    `⚠️ content-lint (P-013): ${hits.length} curly/"smart" quote(s) in CODE position in ${base} ` +
    `(${where}${hits.length > 5 ? ', …' : ''}). These are a HARD tsc/esbuild parse failure — the ` +
    `git-sync content-guard WILL quarantine this file after commit. Replace each curly quote with a ` +
    `straight ' or " before committing. (Advisory — the edit proceeds.)`;
  try {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }) + '\n',
    );
  } catch {
    /* ignore */
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}
