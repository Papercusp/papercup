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
 * `?? {}` and the `||` spellings) whose LHS is LOCALLY traceable to a parse/deserialize
 * boundary: a direct `JSON.parse(...).field` chain; a member access on a variable this
 * same file visibly assigned from `JSON.parse(...)` or a `sql`-tagged query within the
 * last ~40 lines; or a `payload.field` / `event.data.field` read in a file with an IPC/
 * `.on('message')` handler. LOCALITY is the precision filter (mirrors check-generic-
 * first's "structural decoupling alone is too noisy" lesson) — a whole-FILE gate
 * ("this file mentions JSON.parse somewhere") was tried first and measured 1264 hits on
 * this tree, mostly unrelated `opts.foo ?? 0` reads hundreds of lines from the nearest
 * JSON.parse call. A bare `x.foo ?? false` for an untracked `x` is extremely common and
 * mostly fine — it's only suspicious when the read is actually reachable to a boundary
 * where the RHS could be genuinely absent rather than deliberately falsy/zero.
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
import { listTrackedFiles, describeUnscanned } from './lib/tracked-files.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_ROOTS = ['packages/operator-core/lib/', 'apps/operator/lib/', 'libs/papercusp/'];

/**
 * `path:line` pairs that are false positives — the zero value IS the correct default
 * here (a genuine config default, not a parse/deserialize boundary reading absence as
 * zero), or the field is structurally guaranteed present. Curate as real ones surface.
 */
const ALLOW = new Set([]);

// v1 (whole-file "does this file mention JSON.parse anywhere" gate) was tried first and
// measured 1264 hits on this tree — cry-wolf, the exact failure check-generic-first.mjs's
// own header warns about ("structural decoupling alone is far too noisy... require BOTH").
// A 1000-line file that happens to JSON.parse a config once does not make every unrelated
// `opts.foo ?? 0` on line 900 a boundary read. Precision comes from LOCALITY instead of
// file-wide presence: the risky access must be either a DIRECT chain off JSON.parse(...),
// or a member access on a variable this same file visibly assigned FROM JSON.parse(...) /
// a `sql` tagged-template result within a nearby lookback window (still in the same
// function-ish vicinity, not merely "somewhere earlier in a 1000-line file).

const ZERO = "(false|0|''|\"\"|\\[\\]|\\{\\})";
const OP = '(\\?\\?|\\|\\|)';
/** How many preceding lines a tracked-variable assignment stays "in scope" for — generous
 *  enough to span a function body, narrow enough not to bleed across unrelated code. */
const LOOKBACK_LINES = 40;

/** `const/let/var x = JSON.parse(...)` — tracks x as a parsed-boundary variable. */
const ASSIGN_FROM_JSON_PARSE_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?JSON\.parse\(/;
/** `const/let/var x = [await] sql<...>\`...\`` / `sql\`...\`` — this codebase's postgres.js
 *  tagged-template convention (see agent-facts/store.ts) — tracks x as a DB-row variable. */
const ASSIGN_FROM_SQL_ROW_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?sql\s*[<`]/;

/** Direct chain: `JSON.parse(<balanced-ish args>).field ?? zero` on one line — the exact
 *  udxRelayed/bytesReceived incident shape. Handles one level of nested parens in the args
 *  (covers the common `JSON.parse(x.toString())` shape) without a full parser. */
const DIRECT_JSON_PARSE_CHAIN_RE = new RegExp(
  `JSON\\.parse\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`,
);

/** A member access on a bare identifier (optionally `name[0]`/`name['k']`), defaulted via
 *  `??`/`||` to a zero value — checked against the tracked-variable maps below, never used
 *  standalone (a bare `x.foo ?? false` for an UNtracked `x` is far too generic to flag). */
const TRACKED_MEMBER_RISKY_RE = new RegExp(
  `\\b(\\w+)(?:\\[(?:\\d+|['"][^'"]+['"])\\])?\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`,
);

/** IPC/event-payload marker — kept file-level (rarer + lower-noise than JSON.parse/sql, so
 *  the whole-file gate the other two boundaries dropped is still an acceptable signal here). */
const IPC_MARKER_RE = /ipcRenderer\.on\(|ipcMain\.on\(|\.on\(\s*['"]message['"]/;
/** `payload.field ?? zero` / `event.data.field ?? zero` — the two conventional payload names. */
const IPC_PAYLOAD_RISKY_RE = new RegExp(`\\b(?:payload|event\\.data)\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`);

function lineIsExcluded(line) {
  return /^\s*\/\//.test(line) || /^\s*\*/.test(line); // comments
}

/**
 * Analyze one file's text. Returns an array of { line, snippet, reason } candidates.
 * Single forward pass, tracking parsed/row variables as it goes (a variable's tracked
 * scope is the LOOKBACK_LINES window following its assignment — reassignment to something
 * else simply overwrites the tracked line, which is what we want). PURE — no IO,
 * unit-tested inline via selfTest().
 */
export function analyzeForExplicitPresence({ path, text }) {
  if (/\.(test|integration\.test|spec)\.ts$/.test(path)) return [];
  if (path.endsWith('.d.ts')) return [];

  // COMMENTS ARE MASKED; STRINGS ARE DELIBERATELY NOT. Both halves are measured, and the
  // asymmetry is the whole point (2026-08-10, WI-37717):
  //
  //   * Comments must go. `lineIsExcluded` below only skips a line whose FIRST character is
  //     `//` or `*`, and the two tracked-variable assignment regexes run BEFORE that check —
  //     so `// const payload = JSON.parse(x)` registered `payload` as a parsed-boundary
  //     variable and then flagged an unrelated REAL line further down. That phantom is the
  //     worst shape there is: the reported line is genuine code, so triage looks legitimate
  //     and the bogus tracking that caused it is invisible at the reported location.
  //
  //   * Strings must STAY. This guard's corpus deliberately includes source that lives inside
  //     template literals — `admin-test-suites.ts` builds a runner script that really does
  //     `JSON.parse(...)` then reads `payload.n || 0`, and that generated code carries the
  //     exact incident risk this guard exists to catch. Measured over 3,934 tracked .ts/.tsx
  //     files: stripCommentsOnly changes the corpus verdict by NOTHING (62 -> 62, zero drops,
  //     zero adds) while stripCommentsAndStrings drops 8 rows, ALL of them real embedded
  //     code in that one file and NOT ONE of them a phantom. So the full stripper — the
  //     reflexive "migrate it to the shared masker" fix — is a net REGRESSION here.
  //
  // Consequence, stated so nobody "fixes" it later: this guard cannot pass
  // probeStringLiteralBlindness, whose string-literal and template-literal cases are exactly
  // the behaviour above. Its SCANS_UNMASKED_SOURCE entry is ACCURATE and intentional.
  //
  // stripCommentsOnly blanks with spaces rather than deleting, so it is length-preserving and
  // every line index below still addresses the raw text — which is why `rawLines` can supply
  // the snippet while detection runs on the masked copy.
  const rawLines = text.split('\n');
  const maskedText = stripCommentsOnly(text, path);
  const lines = maskedText.split('\n');
  const hasIpcMarker = IPC_MARKER_RE.test(maskedText);
  const parsedVars = new Map(); // name -> assignment line index
  const sqlRowVars = new Map();
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = ASSIGN_FROM_JSON_PARSE_RE.exec(line);
    if (m) parsedVars.set(m[1], i);
    m = ASSIGN_FROM_SQL_ROW_RE.exec(line);
    if (m) sqlRowVars.set(m[1], i);

    if (lineIsExcluded(line)) continue;

    if (DIRECT_JSON_PARSE_CHAIN_RE.test(line)) {
      hits.push({
        line: i + 1,
        snippet: (rawLines[i] ?? line).trim().slice(0, 160),
        reason: 'defaults a field read directly off JSON.parse(...) to a zero value — the udxRelayed/bytesReceived incident shape (WI-5977): absence and a genuine zero/false/empty measurement read identically here.',
      });
      continue;
    }

    m = TRACKED_MEMBER_RISKY_RE.exec(line);
    if (m) {
      const varName = m[1];
      const parsedAt = parsedVars.get(varName);
      const sqlAt = sqlRowVars.get(varName);
      if (parsedAt !== undefined && i - parsedAt <= LOOKBACK_LINES) {
        hits.push({
          line: i + 1,
          snippet: (rawLines[i] ?? line).trim().slice(0, 160),
          reason: `defaults a field read on \`${varName}\` (assigned from JSON.parse at line ${parsedAt + 1}) to a zero value — absence and a genuine zero/false/empty measurement read identically here.`,
        });
        continue;
      }
      if (sqlAt !== undefined && i - sqlAt <= LOOKBACK_LINES) {
        hits.push({
          line: i + 1,
          snippet: (rawLines[i] ?? line).trim().slice(0, 160),
          reason: `defaults a field read on \`${varName}\` (a DB row, assigned from a sql-tagged query at line ${sqlAt + 1}) to a zero value — a NULL column and a genuine zero/false/empty value read identically here.`,
        });
        continue;
      }
    }

    if (hasIpcMarker && IPC_PAYLOAD_RISKY_RE.test(line)) {
      hits.push({
        line: i + 1,
        snippet: (rawLines[i] ?? line).trim().slice(0, 160),
        reason: 'defaults an IPC/event payload field read to a zero value — a field the sender never set and a genuine zero/false/empty value read identically here.',
      });
    }
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
      name: 'DB row (sql-tagged query result) + ?? false → flagged',
      expect: 1,
      path: 'packages/operator-core/lib/x/c.ts',
      text: "const rows = await sql`select active from t`;\nconst active = rows[0].active ?? false;\n",
    },
    {
      name: 'DB row var reused many lines later, still within the lookback window → flagged',
      expect: 1,
      path: 'packages/operator-core/lib/x/c2.ts',
      text: "const row = await sql`select status from t`;\n" + '// pad\n'.repeat(10) + 'const status = row.status ?? false;\n',
    },
    {
      name: 'DB row var reused far outside the lookback window → not flagged (unrelated to a boundary read that far away)',
      expect: 0,
      path: 'packages/operator-core/lib/x/c3.ts',
      text: "const row = await sql`select status from t`;\n" + '// pad\n'.repeat(60) + 'const status = row.status ?? false;\n',
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

    // ── COMMENT-PHANTOM REGRESSIONS (WI-37717). Every one of these FIRED before comments
    // were masked. They are cheap to re-break: deleting the stripCommentsOnly call restores
    // all four, and nothing else in this suite would notice.
    {
      name: 'PHANTOM: the whole risky chain sits in a line comment → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/p1.ts',
      text: '// const n = JSON.parse(raw).count ?? 0;\n',
    },
    {
      name: 'PHANTOM: risky chain in a block comment whose line starts with neither // nor *',
      expect: 0,
      path: 'packages/operator-core/lib/x/p2.ts',
      text: '/* JSON.parse(raw).count ?? 0 */\n',
    },
    {
      name: 'PHANTOM: risky chain in a TRAILING comment after real code → not flagged',
      expect: 0,
      path: 'packages/operator-core/lib/x/p3.ts',
      text: 'const ok = true; // JSON.parse(raw).count ?? 0\n',
    },
    {
      // The nastiest shape: the assignment regexes run BEFORE lineIsExcluded, so a
      // commented-out assignment poisoned the tracked-variable map and then flagged a REAL
      // line below it. The reported line is genuine code, so the phantom is invisible there.
      name: 'PHANTOM: tracked var assigned ONLY inside a comment must not poison tracking',
      expect: 0,
      path: 'packages/operator-core/lib/x/p4.ts',
      text: '// const parsed = JSON.parse(raw);\nconst n = parsed.count ?? 0;\n',
    },
    {
      // The deliberate NON-fix: strings stay live. admin-test-suites.ts embeds a generated
      // runner script in a template literal that carries the real incident shape; masking
      // strings would drop 8 such rows and zero phantoms. If someone "fixes" this guard with
      // stripCommentsAndStrings, THIS case is what fails.
      name: 'INTENTIONAL: risky shape inside a template literal IS still flagged (generated code)',
      expect: 1,
      path: 'packages/operator-core/lib/x/p5.ts',
      text: 'const script = `\n  const payload = JSON.parse(line);\n  send(payload.n || 0);\n`;\n',
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
  let unscanned = [];
  if (all) {
    // WI-6666: SCAN_ROOTS explicitly names `libs/papercusp/`, but plain `git ls-files`
    // (this branch, historically) STOPS AT THE SUPERPROJECT BOUNDARY — libs/papercusp
    // is a submodule, so that root matched ZERO files no matter what it contained.
    // `listTrackedFiles` recurses into submodules so `--all` can finally see it.
    ({ files, unscanned } = listTrackedFiles(ROOT));
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
    console.log(
      `✓ explicit-presence: no zero-value-defaulted parse/deserialize-boundary reads in ${scope} — convention intact.` +
        (all ? describeUnscanned(unscanned) : ''),
    );
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
