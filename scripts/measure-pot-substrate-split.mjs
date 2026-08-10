#!/usr/bin/env node
/**
 * P-056 (retire-mug-kettle-su-only-2026-08-09) — measure the `lib/pot` substrate split.
 *
 * WHY THIS IS A SCRIPT AND NOT A GREP: P-056 says "produce the exact keep-vs-move list
 * as a committed artifact, not a recollection — this list is what P-057 executes and
 * what P-059 depends on." A recollection cannot be re-run when a peer lands new imports
 * mid-flight; this can, and it prints a self-check against the previously measured
 * external-importer count so a drifted tree announces itself instead of silently
 * changing the answer under P-057.
 *
 * THE QUESTION: every symbol exported from packages/operator-core/lib/pot is either
 *   KEEP  — imported from OUTSIDE lib/pot ⇒ live substrate the su system runs on.
 *           The cutover flag deliberately does NOT gate these (gating them would break
 *           the replacement system with the flag that retires the old one), so moving
 *           one to _retired/ breaks a live import.
 *   MOVE  — referenced only within lib/pot (or nowhere) ⇒ safe to retire with the tier.
 *
 * Resolution is done by RESOLVING each import specifier to an absolute path, not by
 * string-matching "/pot/" — a path-substring test both over-matches (…/teapot/…,
 * …/spot/…) and under-matches (a bare `from '../pot'` index import).
 *
 * Usage:  node scripts/measure-pot-substrate-split.mjs [--json <out>] [--quiet]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const POT_DIR = join(REPO, 'packages/operator-core/lib/pot');
const SEARCH_ROOTS = ['packages', 'apps', 'libs', 'scripts'];
const CODE_EXT = ['.ts', '.tsx', '.mts', '.mjs'];

/** Previously measured, recorded in P-056's item text. A mismatch is signal, not noise. */
const EXPECTED_EXTERNAL_IMPORTERS = 60;

const args = process.argv.slice(2);
const outPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const quiet = args.includes('--quiet');

// ── walk ────────────────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (CODE_EXT.some((x) => e.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

const isTest = (f) => /\.(test|spec)\.[cm]?tsx?$/.test(f) || f.includes('/__tests__/');

// ── resolve an import specifier to an absolute file, extensionless-aware ────
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare/package specifier — not a relative lib/pot import
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...CODE_EXT.map((x) => base + x),
    ...['.js', '.mjs'].map((x) => base.replace(/\.[cm]?js$/, '') + x),
    ...CODE_EXT.map((x) => join(base, 'index' + x)),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  // Unresolvable on disk (e.g. a .js specifier for a .ts file that moved) — fall back to
  // the literal base so a pot-directory import is still counted rather than dropped.
  return base;
}

const inPot = (abs) => abs === POT_DIR || abs.startsWith(POT_DIR + '/');

// ── exported symbols of lib/pot ─────────────────────────────────────────────
const EXPORT_PATTERNS = [
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+class\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+enum\s+([A-Za-z0-9_$]+)/gm,
];

const potFiles = walk(POT_DIR).filter((f) => !isTest(f));
/** symbol -> Set(defining file) */
const exportsBySymbol = new Map();
for (const f of potFiles) {
  const src = readFileSync(f, 'utf8');
  for (const re of EXPORT_PATTERNS) {
    for (const m of src.matchAll(re)) {
      if (!exportsBySymbol.has(m[1])) exportsBySymbol.set(m[1], new Set());
      exportsBySymbol.get(m[1]).add(relative(REPO, f));
    }
  }
  // export { a, b as c } [from '...']
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (!name || !/^[A-Za-z0-9_$]+$/.test(name)) continue;
      if (!exportsBySymbol.has(name)) exportsBySymbol.set(name, new Set());
      exportsBySymbol.get(name).add(relative(REPO, f));
    }
  }
}

// ── external importers ──────────────────────────────────────────────────────
const allFiles = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));
/** symbol -> Set(importing file) */
const importersBySymbol = new Map();
const externalImporterFiles = new Set();
const externalTestImporterFiles = new Set();

const IMPORT_RE = /(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;

for (const f of allFiles) {
  if (inPot(f)) continue; // internal to lib/pot — not an external consumer
  const src = readFileSync(f, 'utf8');
  if (!src.includes('pot')) continue; // cheap prefilter
  for (const m of src.matchAll(IMPORT_RE)) {
    const clause = m[2];
    const spec = m[3];
    const target = resolveSpecifier(f, spec);
    if (!target || !inPot(target)) continue;

    const rel = relative(REPO, f);
    if (isTest(f)) externalTestImporterFiles.add(rel);
    else externalImporterFiles.add(rel);

    const braced = clause.match(/\{([^}]*)\}/);
    const names = braced
      ? braced[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim())
      : [clause.trim().split(/\s+as\s+/)[0].trim()];
    for (const n of names) {
      if (!n || !/^[A-Za-z0-9_$]+$/.test(n)) continue;
      if (!importersBySymbol.has(n)) importersBySymbol.set(n, new Set());
      importersBySymbol.get(n).add(rel);
    }
  }
}

// ── classify ────────────────────────────────────────────────────────────────
const keep = [];
const move = [];
for (const [symbol, files] of [...exportsBySymbol].sort((a, b) => a[0].localeCompare(b[0]))) {
  const importers = [...(importersBySymbol.get(symbol) ?? [])].sort();
  const nonTest = importers.filter((i) => !isTest(i));
  const row = { symbol, definedIn: [...files].sort(), importers, externalNonTestImporters: nonTest.length };
  if (nonTest.length > 0) keep.push(row);
  else move.push(row);
}

const artifact = {
  generatedBy: 'scripts/measure-pot-substrate-split.mjs',
  planItem: 'P-056',
  plan: 'retire-mug-kettle-su-only-2026-08-09',
  generatedAt: new Date().toISOString(),
  method:
    'Import specifiers are RESOLVED to absolute paths (extensionless + /index aware) and tested for containment in packages/operator-core/lib/pot — not string-matched on "/pot/", which both over- and under-matches. KEEP = at least one NON-TEST importer outside lib/pot.',
  counts: {
    potSourceFiles: potFiles.length,
    exportedSymbols: exportsBySymbol.size,
    keep: keep.length,
    move: move.length,
    externalNonTestImporterFiles: externalImporterFiles.size,
    externalTestImporterFiles: externalTestImporterFiles.size,
  },
  selfCheck: {
    expectedExternalNonTestImporters: EXPECTED_EXTERNAL_IMPORTERS,
    actual: externalImporterFiles.size,
    matches: externalImporterFiles.size === EXPECTED_EXTERNAL_IMPORTERS,
    note: 'P-056 recorded 60 non-test files outside lib/pot importing from it (2026-08-10). A mismatch means the tree moved — reconcile BEFORE P-057 executes this list.',
  },
  keep,
  move,
  externalNonTestImporterFiles: [...externalImporterFiles].sort(),
};

if (outPath) writeFileSync(resolve(REPO, outPath), JSON.stringify(artifact, null, 2) + '\n');

if (!quiet) {
  const c = artifact.counts;
  console.log(`pot source files (non-test): ${c.potSourceFiles}`);
  console.log(`exported symbols:            ${c.exportedSymbols}`);
  console.log(`  KEEP (live substrate):     ${c.keep}`);
  console.log(`  MOVE (retire with tier):   ${c.move}`);
  console.log(`external non-test importers: ${c.externalNonTestImporterFiles}  (test files: ${c.externalTestImporterFiles})`);
  console.log(
    `SELF-CHECK vs P-056's recorded 60: ${artifact.selfCheck.matches ? 'MATCH' : `MISMATCH (got ${artifact.selfCheck.actual})`}`,
  );
  console.log('\nKEEP symbols with the most external importers:');
  for (const r of [...keep].sort((a, b) => b.externalNonTestImporters - a.externalNonTestImporters).slice(0, 15)) {
    console.log(`  ${String(r.externalNonTestImporters).padStart(3)}  ${r.symbol}  (${r.definedIn.join(', ')})`);
  }
  if (outPath) console.log(`\nartifact → ${outPath}`);
}
