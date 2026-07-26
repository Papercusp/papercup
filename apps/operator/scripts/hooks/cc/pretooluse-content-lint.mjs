#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs
//
// PreToolUse (Edit|Write|MultiEdit) ADVISORY content-lint — git-sync-dx-hardening-2026-06-17 P-013.
//
// WI-5543: previously lived at repo-root scripts/cc-hooks/ and was never wired into
// CC_HOOK_FILES / mergeClaudeHookSettings / install-standalone-mcp.sh (same orphaned-dir
// shape as EI-16981's guard-operator-desktop.mjs) — its curly-quote advisory never fired.
// Moved here + wired below.
//
// TWO RULES, SAME REASON: a cheap check at EDIT time beats the same check hours later.
//
// RULE 1 — curly/"smart" quotes in CODE position (.ts/.tsx)
//   The git-sync content-guard quarantines a .ts/.tsx file containing a curly quote in CODE
//   position (a HARD tsc/esbuild parse failure) only AFTER commit — feedback the author sees
//   ~10-50 min later, buried in coord.
//
// RULE 2 — named owner-provenance tags (EI-18670296139788697), any text file
//   `[owner:<name> …]` and `OWNER MANDATE (<Name>, <date>): "…"` in shipped source leak a real
//   person into the release bundle. The three identity lints run as a green-checkpoint leg, so
//   a one-line tag REDS THE GATE and freezes `main` for everyone: 4h10m with 41 commits
//   buffered on 2026-07-26, from 20 findings across 10 files, every one authored that same day.
//   EI-18147177863084708 already moved those lints from release-CUT time to checkpoint time for
//   exactly this reason; this is the next hop — the author's own turn, seconds after they type
//   it, when the fix is one word.
//
//   The matcher is IMPORTED from the repo's scripts/lib/identity-leak-patterns.mjs — the same
//   module scripts/check-no-owner-name-tags.mjs uses — resolved by walking up from the edited
//   file. That indirection is deliberate: this hook runs from an INSTALLED copy in
//   ~/.papercusp/hooks/cc/, so an inlined copy of the patterns would drift from the gate and
//   the advisory would start green-lighting what the gate later rejects. Importing from the
//   tree being edited makes divergence impossible.
//
// CONTRACT (advisory — NEVER blocks, FAIL-OPEN)
//   - On a hit: prints additionalContext (model-facing) + exit 0 (the edit PROCEEDS).
//   - FAIL-OPEN: any error / timeout / missing module -> exit 0, silent. A bug here must NEVER
//     block an edit; the green-checkpoint lints + post-commit content-guard remain the real
//     backstops. Blocking would also be the wrong trade fleet-wide: a false positive would
//     wedge every agent's edits, and this class is trivially fixable once SEEN.
//   - FAST: a file with no curly-quote byte never loads `typescript`; the identity matcher
//     applies its own cheap whole-text pre-filter before scanning.
//
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CURLY = /[‘’“”]/;
const CURLY_G = /[‘’“”]/g;
const SMART_LABEL = { '‘': 'U+2018 ‘', '’': 'U+2019 ’', '“': 'U+201C “', '”': 'U+201D ”' };

/** How far up from the edited file to look for the repo that owns the detector. */
const MAX_REPO_WALK = 12;

main();

async function main() {
  const notes = [];
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';
    if (!filePath) return done();

    const content = extractContent(tool, input);
    if (!content) return done();

    // RULE 2 — identity leaks. Any text file: a named tag leaks the same from .md as from .ts.
    try {
      const note = await checkIdentityLeaks(filePath, content);
      if (note) notes.push(note);
    } catch {
      /* fail-open: never let the identity check block an edit */
    }

    // RULE 1 — curly quotes in code position. .ts/.tsx only, and only when one is present.
    try {
      if (/\.tsx?$/.test(filePath) && CURLY.test(content)) {
        const mod = await import('typescript');
        const ts = mod.default ?? mod;
        const hits = findCodePositionCurlyQuotes(ts, filePath, content);
        if (hits.length) notes.push(curlyNote(filePath, hits));
      }
    } catch {
      /* fail-open */
    }

    if (notes.length) emit(notes.join('\n\n'));
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

/**
 * Resolve the identity-leak detector from the repo that CONTAINS the edited file, so this
 * installed hook always runs the same matcher as the gate lint. Returns null (silent) outside
 * a repo that has it — e.g. editing a file in an unrelated project.
 */
async function loadIdentityDetector(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < MAX_REPO_WALK; i++) {
    const candidate = path.join(dir, 'scripts', 'lib', 'identity-leak-patterns.mjs');
    if (existsSync(candidate)) {
      return { mod: await import(pathToFileURL(candidate).href), repoRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function checkIdentityLeaks(filePath, content) {
  const detector = await loadIdentityDetector(filePath);
  if (!detector) return null;
  const { mod, repoRoot } = detector;
  if (typeof mod.findOwnerNameLeaks !== 'function') return null;

  // Skip the same paths the gate skips: on a CARRY surface (work items, plans, .papercusp/)
  // the named form is CORRECT, and nagging there teaches agents to ignore this advisory.
  const rel = path.relative(repoRoot, path.resolve(filePath)).split(path.sep).join('/');
  if (typeof mod.isSkippedPath === 'function' && mod.isSkippedPath(rel)) return null;

  const leaks = mod.findOwnerNameLeaks(content);
  if (!leaks.length) return null;

  // Report the offending TEXT, not a line number: for an Edit we only see the incoming
  // fragment, so any line number we computed would be wrong relative to the real file.
  const render = typeof mod.renderLeak === 'function' ? mod.renderLeak : (f) => `(${f.name})`;
  const shown = leaks.slice(0, 4).map((f) => `    ${render(f)}  in: ${f.text}`).join('\n');
  const more = leaks.length > 4 ? `\n    … and ${leaks.length - 4} more` : '';
  const fix = typeof mod.FIX_HINT === 'string' ? mod.FIX_HINT : 'Strip the name; keep the date.';

  return (
    `⚠️ identity-leak (EI-18670296139788697): ${leaks.length} named owner-provenance tag(s) in ` +
    `this edit to ${path.basename(filePath)} (tracked as ${rel}).\n${shown}${more}\n\n` +
    `This is SHIPPED SOURCE. Left in, it reds the green-checkpoint's lint:identity-leak leg the ` +
    `tick it lands and FREEZES \`main\` for the whole fleet until someone hunts it down — the ` +
    `2026-07-26 instance cost 4h10m and 41 buffered commits. Fix it now, while it is one word.\n\n` +
    `${fix}\n(Advisory — the edit proceeds.)`
  );
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

function curlyNote(filePath, hits) {
  const base = filePath.split(/[/\\]/).pop();
  const where = hits
    .slice(0, 5)
    .map((h) => `line ${h.line}:${h.col} ${SMART_LABEL[h.ch] ?? h.ch}`)
    .join(', ');
  return (
    `⚠️ content-lint (P-013): ${hits.length} curly/"smart" quote(s) in CODE position in ${base} ` +
    `(${where}${hits.length > 5 ? ', …' : ''}). These are a HARD tsc/esbuild parse failure — the ` +
    `git-sync content-guard WILL quarantine this file after commit. Replace each curly quote with a ` +
    `straight ' or " before committing. (Advisory — the edit proceeds.)`
  );
}

function emit(msg) {
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
