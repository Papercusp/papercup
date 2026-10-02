#!/usr/bin/env node
/**
 * lint:refusal-contracts — a fail-closed refusal must say what would LIFT it.
 *
 * ## What it detects
 *
 * An object literal, in non-test operator code, that carries a `code` naming a
 * refusal (`…_refused`, `…_denied`, `capability_unsatisfied`, `…_violation`,
 * `…_blocked`, `forbidden`, `…_not_allowed`) and NO contract key (`refusal` or
 * `liftsWhen`). The contract is the `RefusalContract` shape from
 * capability-envelope/identity-refusal-contract.ts: what would lift the refusal,
 * who can make that true, and the values it compared.
 *
 * WHY: a refusal with no lift condition turns a recoverable state into tribal
 * knowledge (a fact + sudo + psql + knowing the item number). EI-23766133296678780
 * gave the identity gate its contract; this is the ratchet that stops the NEXT
 * refusal being written without one (WI-10005192).
 *
 * ## How it measures — AST, not grep (and why that matters)
 *
 * A grep over `code: '…'` reported ~190 hits; the AST census of the same tree finds
 * 51 construction sites. The difference is type-literal fields (`code:
 * 'capability_unsatisfied';` inside an interface), comparisons, and test files — none
 * of which construct a refusal. Counting them would bake a wrong number into the
 * baseline of the guard whose job is to make the count trustworthy. A TypeLiteral is
 * a different node kind from an ObjectLiteralExpression, so the parse separates them
 * for free, and comments/doc prose can never self-match.
 *
 * ## What it deliberately does NOT see — read this before trusting a clean run
 *
 * Refusals built by a SHARED BUILDER (one `fleetScopeViolation(...)` helper with many
 * callers) appear here once, at the builder's literal, not once per caller. That is
 * correct for the ratchet (fix the builder, fix every caller) but it means this is a
 * count of CONSTRUCTION SITES, never of refusals a user can hit. A refusal whose code
 * does not match REFUSAL_CODE is invisible to it too: the code-name regex is the
 * detector's one heuristic, and the baseline absorbs its false positives (e.g.
 * `unknown_blocked_by` is validation, not authority) rather than hiding them.
 *
 * ## The baseline
 *
 * scripts/refusal-contracts.baseline.json is the measured population that predates
 * this guard: `{ "<file>::<code>": <uncontracted sites> }`. It is SHRINK-ONLY — giving a
 * site its contract (or deleting it) lowers a count; a count may never rise and a new
 * key may never appear. Seed and re-measure it from `--list`, never from a hand grep.
 * `--write-baseline` rewrites it from the live scan and REFUSES to grow it.
 *
 * Exit 0 clean / 1 on a new uncontracted refusal site or a stale (now-smaller) baseline.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];
const BASELINE_PATH = join(ROOT, 'scripts/refusal-contracts.baseline.json');

const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-sidecar', 'build', '.next', 'target', '_retired', 'coverage', '.git', 'out']);
const REFUSAL_CODE = /(refus|denied|unsatisfied|violation|blocked|forbidden|not_allowed)/;
/** A literal carrying either key states its lift condition (the RefusalContract). */
const CONTRACT_KEYS = new Set(['refusal', 'liftsWhen']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec|d)\.[cm]?tsx?$/.test(name)) yield full;
  }
}

/**
 * Refusal construction sites in one file's source: every ObjectLiteralExpression
 * whose `code` property is a string literal matching REFUSAL_CODE.
 * @returns {{ line: number, code: string, hasContract: boolean }[]}
 */
export function findRefusalSites(src, fileName = 'site.ts') {
  // Cheap prefilter: a file with no `code:` or no refusal-ish word cannot hold a site.
  // `['"]?` — a quoted key (`'code': …`, JSON-shaped literals) must pass it too; the
  // prefilter is only allowed to be LOOSER than the AST rule, never narrower.
  if (!/\bcode['"]?\s*:/.test(src) || !REFUSAL_CODE.test(src)) return [];
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const sites = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let code = null;
      const keys = new Set();
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p) && !ts.isMethodDeclaration(p)) continue;
        const name = p.name.getText(sf).replace(/['"]/g, '');
        keys.add(name);
        if (name === 'code' && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) code = p.initializer.text;
      }
      if (code !== null && REFUSAL_CODE.test(code)) {
        sites.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          code,
          hasContract: [...keys].some((k) => CONTRACT_KEYS.has(k)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).sites ?? {};
}

/**
 * Scan the tree. Exported so the guard's unit test can run it over the REAL tree
 * (that run is what makes this guard reachable from a blocking path).
 */
export function scanTree({ baseline = readBaseline() } = {}) {
  const sites = [];
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      let src;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      for (const s of findRefusalSites(src, rel)) sites.push({ rel, ...s });
    }
  }
  const uncontracted = new Map();
  for (const s of sites) {
    if (s.hasContract) continue;
    const key = `${s.rel}::${s.code}`;
    uncontracted.set(key, (uncontracted.get(key) ?? 0) + 1);
  }
  const base = baseline ?? {};
  const violations = [];
  for (const [key, n] of uncontracted) {
    const allowed = base[key] ?? 0;
    if (n > allowed) violations.push({ key, actual: n, baseline: allowed });
  }
  const stale = Object.entries(base)
    .filter(([key, n]) => (uncontracted.get(key) ?? 0) < n)
    .map(([key, n]) => ({ key, baseline: n, actual: uncontracted.get(key) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { sites, uncontracted, violations, stale, baselineLoaded: baseline !== null };
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const scan = scanTree();
  const contracted = scan.sites.filter((s) => s.hasContract).length;
  if (argv.includes('--list')) {
    console.log(`SITES total=${scan.sites.length} withContract=${contracted} uncontracted=${scan.sites.length - contracted} keys=${scan.uncontracted.size}`);
    for (const s of scan.sites) console.log(`${s.hasContract ? 'CONTRACT ' : 'NO-CONTRACT'} ${s.rel}:${s.line} ${s.code}`);
    process.exit(0);
  }
  if (argv.includes('--write-baseline')) {
    const grew = scan.violations.length > 0 && scan.baselineLoaded;
    if (grew) {
      console.error('refusal-contracts: refusing to GROW the baseline. New/raised uncontracted refusal sites:');
      for (const v of scan.violations) console.error(`  ${v.key}  ${v.baseline} -> ${v.actual}`);
      process.exit(1);
    }
    const sites = Object.fromEntries([...scan.uncontracted].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ version: 1, sites }, null, 2)}\n`);
    console.log(`refusal-contracts: wrote baseline (${Object.keys(sites).length} keys, ${scan.sites.length - contracted} uncontracted sites)`);
    process.exit(0);
  }
  if (!scan.baselineLoaded) {
    console.error('refusal-contracts: no baseline at scripts/refusal-contracts.baseline.json — seed it with --write-baseline after reading --list');
    process.exit(1);
  }
  let failed = false;
  if (scan.violations.length) {
    failed = true;
    console.error('refusal-contracts: refusal site(s) with no lift condition (code names a refusal, literal carries neither `refusal` nor `liftsWhen`):');
    for (const v of scan.violations) console.error(`  ${v.key}  baseline ${v.baseline}, now ${v.actual}`);
    console.error('Fix: attach a RefusalContract ({ observed, liftsWhen, whoCanMakeItTrue }, see capability-envelope/identity-refusal-contract.ts) as `refusal`. Do NOT raise the baseline.');
  }
  if (scan.stale.length) {
    failed = true;
    console.error('refusal-contracts: baseline is STALE (a site gained a contract or was removed) — shrink it: npm run lint:refusal-contracts -- --write-baseline');
    for (const s of scan.stale) console.error(`  ${s.key}  baseline ${s.baseline}, now ${s.actual}`);
  }
  if (!failed) console.log(`✔ refusal-contracts: ${scan.sites.length} sites, ${contracted} with a contract, ${scan.sites.length - contracted} baselined`);
  process.exit(failed ? 1 : 0);
}
