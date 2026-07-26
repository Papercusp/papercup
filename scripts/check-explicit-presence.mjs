#!/usr/bin/env node
/**
 * check-explicit-presence.mjs — the going-forward guard for the explicit-presence
 * convention (WI-5977, "Adopt explicit-presence as an enforced convention at every
 * boundary where absence is possible").
 *
 * THE INCIDENT CLASS this guards against (10 distinct incidents in one night, all one
 * shape): a layer that CANNOT tell "absent" from "measured zero" silently picks the
 * type's zero value instead of erroring or carrying its own ABSENT representation —
 * udxRelayed absent read as `relayed:false`, bytesReceived absent read as `0`,
 * lastProgressAt:null read as "abandoned", a job-runner wrapper reporting exit 0 while
 * the wrapped tsc actually exited 2. The convention (WI-5977 body):
 *   1. At any boundary where a field may be absent, absence gets its OWN
 *      representation — never the type's zero value. Absent != false, != 0.
 *   2. A reader that cannot distinguish absent from measured must ERROR, not choose.
 *
 * This lint is the MECHANICAL half WI-5977 asked for and explicitly deferred (only the
 * canary — gate-canary-sweep-action.ts — landed in that item; this is the remainder,
 * tracked as WI-6004).
 *
 * SCOPE (a heuristic, like check-generic-first.mjs — advisory, not a type checker):
 * flag a `??`/`||` defaulted-to-a-zero-value read (`?? false`, `?? 0`, `?? ''`, `?? []`,
 * `?? {}` and the `||` spellings) that appears in a file which ALSO shows a recognizable
 * PARSE/DESERIALIZE-BOUNDARY marker — JSON.parse(...), a Postgres/pg row read, or an
 * IPC/event-payload handler. Both signals are required (mirrors check-generic-first's
 * "structural decoupling alone is too noisy" lesson): a bare `x ?? false` is extremely
 * common and mostly fine — it's only suspicious paired with a boundary where the RHS
 * could be genuinely absent rather than deliberately falsy/zero.
 *
 * KNOWN LIMITATION (v1): only the `??`/`||` operator form is checked. A destructuring
 * default (`const { foo = false } = JSON.parse(x)`) is the same anti-pattern but isn't
 * matched yet — same class as check-generic-first's documented false-negative tradeoff:
 * acceptable for an advisory lint, worth widening if it proves to matter.
 *
 *   node scripts/check-explicit-presence.mjs             # report candidates in this change (informational)
 *   node scripts/check-explicit-presence.mjs --all        # scan the whole tree
 *   node scripts/check-explicit-presence.mjs --strict     # exit 1 if any unallow-listed candidate
 *   node scripts/check-explicit-presence.mjs --self-test  # verify the analyzer on inline fixtures
 *
 * Informational by default (like lint:generic-first) — a heuristic, so it advises
 * rather than blocks. A field that is genuinely always-present, or whose zero value IS
 * the correct default, is a false positive: add its `path:line` to ALLOW below.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_ROOTS = ['packages/operator-core/lib/', 'apps/operator/lib/', 'libs/papercusp/'];

/**
 * `path:line` pairs that are false positives — the zero value IS the correct default
 * here (a genuine config default, not a parse/deserialize boundary reading absence as
 * zero), or the field is structurally guaranteed present. Curate as real ones surface.
 */
const ALLOW = new Set([]);

/** File-level boundary signals — a file must show at least one to be scanned for the
 *  risky line pattern at all (the precision filter; see header). */
const BOUNDARY_FILE_RE = new RegExp(
  [
    'JSON\\.parse\\(',                                    // parsed wire/log/payload text
    "from\\s+['\"](?:postgres|pg|@electric-sql/pglite)['\"]", // a DB row read
    "ipcRenderer\\.on\\(|ipcMain\\.on\\(",                // Electron/Tauri IPC payload
    "\\.on\\(\\s*['\"]message['\"]",                      // generic event/message payload
    'JSON\\.parse',                                       // (redundant with above; kept for readability of match groups)
  ].join('|'),
);

/**
 * The risky LINE pattern: a member/property access immediately defaulted via `??`/`||`
 * to a zero value. Captures the zero-value literal for the reported reason.
 * Deliberately requires a `.identifier` (or `['key']`) on the LHS — a bare local
 * variable defaulted (`x ?? false`) is far too common/generic to be a boundary read.
 */
const RISKY_DEFAULT_RE = /(?:\.\w+|\[['"][^'"]+['"]\])\s*(\?\?|\|\|)\s*(false|0|''|""|\[\]|\{\})(?!\s*[)\]}]?\s*=)/;

/** Skip an obvious non-boundary use even inside a boundary file: a `??`/`||` default
 *  whose LHS clearly isn't reading a possibly-absent field (a function call result
 *  guard, a boolean flag negation, etc.) is out of scope for a line-regex lint — kept
 *  narrow deliberately (false negatives here are fine; false positives are the cost
 *  that erodes trust in an advisory lint). */
function lineIsExcluded(line) {
  return /^\s*\/\//.test(line) || /^\s*\*/.test(line); // comments
}

/**
 * Analyze one file's text. Returns an array of { line, snippet, reason } candidates.
 * PURE — no IO, unit-tested inline via selfTest().
 */
export function analyzeForExplicitPresence({ path, text }) {
  if (/\.(test|integration\.test|spec)\.ts$/.test(path)) return [];
  if (path.endsWith('.d.ts')) return [];
  if (!BOUNDARY_FILE_RE.test(text)) return [];

  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineIsExcluded(line)) continue;
    const m = RISKY_DEFAULT_RE.exec(line);
    if (!m) continue;
    hits.push({
      line: i + 1,
      snippet: line.trim().slice(0, 160),
      reason: `defaults a field read to the zero value '${m[2]}' via '${m[1]}' in a file that also shows a parse/deserialize-boundary marker (JSON.parse / DB row / IPC payload) — absence and a genuine zero/false/empty measurement read identically here`,
    });
  }
  return hits;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────

function selfTest() {
  const cases = [
    {
      name: 'JSON.parse boundary + ?? false → flagged (the udxRelayed incident shape)',
      expect: 1,
      path: 'packages/operator-core/lib/x/a.ts',
      text: "const relayed = JSON.parse(raw).udxRelayed ?? false;\n",
    },
    {
      name: 'JSON.parse boundary + ?? 0 → flagged (the bytesReceived incident shape)',
      expect: 1,
      path: 'packages/operator-core/lib/x/b.ts',
      text: "const bytesReceived = JSON.parse(logLine).bytesReceived ?? 0;\n",
    },
    {
      name: 'DB row read (postgres import) + ?? false → flagged',
      expect: 1,
      path: 'packages/operator-core/lib/x/c.ts',
      text: "import postgres from 'postgres';\nconst active = row.active ?? false;\n",
    },
    {
      name: 'IPC payload handler + || 0 → flagged',
      expect: 1,
      path: 'packages/operator-core/lib/x/d.ts',
      text: "ipcRenderer.on('reply', (event, payload) => {\n  const count = payload.count || 0;\n});\n",
    },
    {
      name: 'NO boundary marker in file → not flagged even with the same risky shape',
      expect: 0,
      path: 'packages/operator-core/lib/x/e.ts',
      text: "const debugEnabled = config.debug ?? false;\n",
    },
    {
      name: 'boundary present but default is a non-zero sentinel string → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/f.ts',
      text: "const name = JSON.parse(raw).name ?? 'unknown';\n",
    },
    {
      name: 'boundary present but bare local var defaulted (no field access) → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/g.ts',
      text: "const parsed = JSON.parse(raw);\nconst x = maybeUndefined ?? false;\n",
    },
    {
      name: 'explicit-presence done correctly (an `in` check, no risky default) → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/h.ts',
      text: "const p = JSON.parse(raw);\nconst relayed = 'udxRelayed' in p ? p.udxRelayed : ABSENT;\n",
    },
    {
      name: 'test file → never flagged regardless of content',
      expect: 0,
      path: 'packages/operator-core/lib/x/i.test.ts',
      text: "const relayed = JSON.parse(raw).udxRelayed ?? false;\n",
    },
    {
      name: 'a comment line matching the shape → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/j.ts',
      text: "import postgres from 'postgres';\n// const active = row.active ?? false; (old approach, kept for reference)\n",
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = analyzeForExplicitPresence({ path: c.path, text: c.text }).length;
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}${ok ? '' : ` (expected ${c.expect} hit(s), got ${got})`}`);
  }
  if (failed) { console.error(`\n✗ self-test: ${failed} case(s) failed.`); process.exit(1); }
  console.log('\n✓ self-test: analyzer correct on all fixtures.');
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────────────────

function git(args) {
  const r = execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.split('\n').filter(Boolean);
}

/** Mirrors check-generic-first.mjs's changedFiles: committed-since-base + uncommitted. */
function changedFiles(base) {
  let committed = [];
  try {
    git(`rev-parse --verify --quiet ${base}`);
    committed = git(`diff --no-renames --diff-filter=AM --name-only ${base}...HEAD`);
  } catch {
    committed = null;
  }
  let uncommitted = [];
  try { uncommitted = git('diff --no-renames --diff-filter=AM --name-only HEAD'); } catch { /* no HEAD */ }
  if (committed === null && uncommitted.length === 0) return null;
  return [...new Set([...(committed ?? []), ...uncommitted])];
}

function main() {
  const strict = process.argv.includes('--strict');
  const all = process.argv.includes('--all');
  if (process.argv.includes('--self-test')) return selfTest();

  let files;
  if (all) {
    files = git('ls-files');
  } else {
    const baseArg = process.argv.indexOf('--base');
    const base = baseArg >= 0 ? process.argv[baseArg + 1] : (process.env.AFFECTED_BASE || 'origin/main');
    const changed = changedFiles(base);
    if (changed === null) {
      console.log('✓ explicit-presence: no diff base (origin/main) and no working-tree changes — nothing new to check.');
      process.exit(0);
    }
    files = changed;
  }
  files = files.filter((f) => SCAN_ROOTS.some((r) => f.startsWith(r)) && f.endsWith('.ts'));

  const candidates = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    for (const hit of analyzeForExplicitPresence({ path: f, text })) {
      if (ALLOW.has(`${f}:${hit.line}`)) continue;
      candidates.push({ f, ...hit });
    }
  }

  const scope = all ? 'the app tree' : 'this change';
  if (candidates.length === 0) {
    console.log(`✓ explicit-presence: no zero-value-defaulted parse/deserialize-boundary reads in ${scope} — convention intact.`);
    process.exit(0);
  }

  const header = strict ? '✗ explicit-presence' : '⚠ explicit-presence (advisory)';
  console.error(`${header}: ${candidates.length} boundary read(s) in ${scope} default absence to a zero value.`);
  console.error('  WI-5977: at a boundary where a field may be absent, absence needs its OWN representation —');
  console.error('  never the type\'s zero value (absent != false, != 0). A reader that cannot tell the two apart');
  console.error('  must error, not silently choose. These are *candidates*, not certainties: for a field that is');
  console.error('  genuinely always-present, or whose zero value is a deliberate default (not "unknown"), add its');
  console.error('  `path:line` to ALLOW in scripts/check-explicit-presence.mjs.\n');
  for (const c of candidates) console.error(`    ${c.f}:${c.line}\n        ${c.snippet}\n        ${c.reason}`);
  process.exit(strict ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
