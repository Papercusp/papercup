/**
 * lint-tests.ts — CI guard for the four-framework rule + tab visibility.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-038; extended by the
 * test-framework coverage audit (2026-06-02).
 *
 * D-006 says new tests go in Vitest / Playwright / Cargo / LLM
 * scenarios — never `.mjs` integration scripts or tsx `-smoke.ts`
 * files. This lint enforces FOUR things:
 *
 *   1. No NEW `.mjs` under `apps/operator/__tests__/integration/`
 *      (debt counter `lint-tests-debt.json` accepts pre-existing).
 *   2. No NEW `-smoke.ts` under `apps/operator/scripts/`.
 *   3. COVERAGE: every canonical `*.test.ts(x)` / `*.spec.ts` matches at
 *      least one registry glob (`.papercusp/testing-domains.json`), so it
 *      shows up in the /adv Tests tab. An orphaned test is invisible —
 *      this is the failure the audit fixed (614 of 1168 were orphaned).
 *      Fix by widening a domain in testing-domains-registry.ts, then
 *      `npx tsx scripts/gen-testing-domains-contract.ts`.
 *   4. No bash `*.test.sh` / `*.spec.sh` ANYWHERE (EI-1736). No CI runner
 *      globs them (test:affected only globs Vitest `*.test.ts`), so they
 *      masquerade as coverage while silently never running — and the
 *      `set -e` + `((x++))` trap aborts them after Test 1. Use a Vitest
 *      `*.test.ts` that shells out to bash (e.g.
 *      `apps/operator/lib/release/verify-release-paths.test.ts`).
 *
 * The debt JSON only shrinks (removing a migrated entry succeeds; adding
 * one is rejected at review).
 *
 * Exit code:
 *   0 — clean
 *   1 — at least one offender (new ad-hoc file OR an orphaned test)
 *
 * Usage:
 *   tsx apps/operator/scripts/lint-tests.ts
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(__dirname);

interface Debt {
  integrationMjs: string[];
  scriptsSmoke: string[];
}

function resolveRepoRoot(from: string): string {
  let dir = resolve(from);
  while (true) {
    // .git is the universal marker — works for any workspace shape.
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

async function loadDebt(): Promise<Debt> {
  const debtPath = join(REPO_ROOT, 'apps/operator/scripts/lint-tests-debt.json');
  const raw = await readFile(debtPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Debt>;
  return {
    integrationMjs: parsed.integrationMjs ?? [],
    scriptsSmoke: parsed.scriptsSmoke ?? [],
  };
}

async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const e of entries) {
    if (e.isFile() && predicate(e.name)) {
      hits.push(e.name);
    }
  }
  return hits;
}

/* ----------------------------------------------------------------- *
 * Coverage check — every canonical test must match a registry glob, so
 * it shows up in the /adv Tests tab. Mirrors the glob walker in
 * @papercusp/testing-shell/glob (kept dependency-free here on purpose).
 * Without this, agents add correctly-named Vitest/Playwright tests in
 * new files that no domain globs and they become invisible in the tab
 * (the failure this audit fixed: 614 of 1168 tests were orphaned).
 * ----------------------------------------------------------------- */

const COVERAGE_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', 'dist', 'build', 'out',
  '.svelte-kit', '.cache', 'target', 'coverage', '_retired',
  // Generated/state artifacts, never canonical test homes. gen:lib-api
  // (TypeDoc) mirrors source test files into .papercusp/lib-api/**/_media/,
  // which otherwise surface here as orphans whenever someone regenerates.
  '.papercusp',
  // Test FIXTURES are seeded sandboxes / test data (e.g. the hive-eval seed-app's
  // own `node --test` suite the throwaway Hive runs against), not operator tests —
  // they belong to the fixture's runtime, never the /adv Tests tab.
  'fixtures',
  // Transient vitest scratch: the test-data-generator seeds temp `.vitest-tmp/tdg-*`
  // test trees that leak into the walk mid-run and surface as phantom orphans. And
  // `scratch/` is the throwaway demo space (dummy-plan-demo/*), never canonical app tests.
  '.vitest-tmp', 'vitest-tmp', 'scratch',
]);

// Repo-root-relative dirs to skip WHOLESALE — matched by FULL POSIX path (not
// basename like COVERAGE_IGNORE_DIRS, which matches at any depth), so ONLY the
// intended dir is skipped. `templates/` is the vendored first-party template
// store (local-first-party-template-bundling-2026-07-07): PORTABLE content copied
// verbatim into a composed downstream app, whose `checks/*.test.ts` are the
// DOWNSTREAM app's tests (they run inside that generated app, never in operator
// CI), so they belong in no operator domain and must not surface in the /adv Tests
// tab. A basename skip would ALSO hide the real operator test at
// packages/operator-core/lib/agent-tools/templates/new-app.test.ts — hence this is
// path-anchored to the top-level store alone.
const COVERAGE_IGNORE_REL = new Set([
  'templates',
]);

const CANONICAL_TEST_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|js|jsx)$/;

/** Split a glob into [literalPrefix, remainder] — see testing-shell/glob.ts. */
function splitPrefix(pattern: string): [string, string] {
  const meta = pattern.search(/[*?[]/);
  if (meta < 0) return [pattern, ''];
  const cut = pattern.lastIndexOf('/', meta);
  if (cut < 0) return ['', pattern];
  return [pattern.slice(0, cut), pattern.slice(cut + 1)];
}

/** Compile a glob remainder to an anchored RegExp (bracket-safe). */
function remainderToRegex(rem: string): RegExp {
  let out = '^';
  for (let i = 0; i < rem.length; i++) {
    const c = rem[i];
    if (c === '*') {
      if (rem[i + 1] === '*') { out += '.*'; i++; if (rem[i + 1] === '/') i++; }
      else { out += '[^/]*'; }
    } else if (c === '?') { out += '[^/]'; }
    else if (/[.+^$()|\\[\]]/.test(c)) { out += `\\${c}`; }
    else { out += c; }
  }
  return new RegExp(out + '$');
}

interface CompiledGlob { prefix: string; re: RegExp | null; literal: string | null; }
function compileGlob(pattern: string): CompiledGlob {
  const [prefix, remainder] = splitPrefix(pattern);
  if (!remainder) return { prefix, re: null, literal: prefix };
  return { prefix, re: remainderToRegex(remainder), literal: null };
}
function globMatches(g: CompiledGlob, relPath: string): boolean {
  if (g.re === null) return relPath === g.literal;
  if (g.prefix !== '' && !relPath.startsWith(g.prefix + '/')) return false;
  const rel = g.prefix === '' ? relPath : relPath.slice(g.prefix.length + 1);
  return g.re.test(rel);
}

// Transient build temp dirs carry a pid suffix (e.g. `sidecar.tmp.4001496`, created
// while the Tauri sidecar bundles); they leak into the FS walk as phantom orphans.
// Match by pattern since the suffix is dynamic.
const COVERAGE_IGNORE_RE = /\.tmp\.\d+$/;

/** Recursively list every file under `dir` whose basename matches `match`,
 * POSIX-relative, skipping ignore dirs. Defaults to canonical TS/JS tests. */
async function walkAll(dir: string, match: RegExp = CANONICAL_TEST_RE, base = ''): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? posix.join(base, e.name) : e.name;
    if (e.isDirectory()) {
      if (COVERAGE_IGNORE_DIRS.has(e.name) || COVERAGE_IGNORE_RE.test(e.name) || COVERAGE_IGNORE_REL.has(rel)) continue;
      out.push(...await walkAll(join(dir, e.name), match, rel));
    } else if (e.isFile() && match.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- *
 * Forbidden #4 — bash `*.test.sh` / `*.spec.sh` (EI-1736). These are
 * invisible to every CI runner (test:affected only globs Vitest
 * `*.test.ts`), so they masquerade as coverage while never running, and
 * the classic `set -e` + `((x++))` shell-arithmetic trap aborts them
 * after the first test. There is NO debt list: zero exist today, and the
 * canonical pattern is a Vitest `*.test.ts` that shells out to bash
 * (e.g. apps/operator/lib/release/verify-release-paths.test.ts).
 * ----------------------------------------------------------------- */
const SHELL_TEST_RE = /\.(test|spec)\.sh$/;
async function findShellTests(): Promise<string[]> {
  return (await walkAll(REPO_ROOT, SHELL_TEST_RE)).sort();
}

/** Load every glob declared in the harness testing contract. */
async function loadContractGlobs(): Promise<string[]> {
  const raw = await readFile(join(REPO_ROOT, '.papercusp/testing-domains.json'), 'utf8');
  const parsed = JSON.parse(raw) as { domains?: { sections?: { globs?: string[] }[] }[] };
  const globs: string[] = [];
  for (const d of parsed.domains ?? []) {
    for (const s of d.sections ?? []) {
      for (const g of s.globs ?? []) globs.push(g);
    }
  }
  return globs;
}

/** Return canonical test files matching NO registry glob (invisible in the tab). */
async function findOrphanTests(): Promise<string[]> {
  const compiled = (await loadContractGlobs()).map(compileGlob);
  const tests = await walkAll(REPO_ROOT);
  return tests.filter((t) => !compiled.some((g) => globMatches(g, t))).sort();
}

async function main(): Promise<void> {
  const debt = await loadDebt();
  const debtMjs = new Set(debt.integrationMjs);
  const debtSmoke = new Set(debt.scriptsSmoke);

  const offenders: string[] = [];

  // Forbidden #1: new .mjs under apps/operator/__tests__/integration/
  const intDir = join(REPO_ROOT, 'apps/operator/__tests__/integration');
  const intFiles = await listFiles(intDir, (n) => n.endsWith('.mjs'));
  for (const name of intFiles) {
    const rel = posix.join('apps/operator/__tests__/integration', name);
    if (!debtMjs.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → .mjs integration scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Forbidden #2: new *-smoke.ts under apps/operator/scripts/
  const scriptsDir = join(REPO_ROOT, 'apps/operator/scripts');
  const smokeFiles = await listFiles(scriptsDir, (n) => n.endsWith('-smoke.ts'));
  for (const name of smokeFiles) {
    const rel = posix.join('apps/operator/scripts', name);
    if (!debtSmoke.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → tsx -smoke.ts scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Forbidden #3: a canonical test that matches no registry glob — it would
  // be invisible in the /adv Tests tab. Fix by widening a domain's globs in
  // testing-domains-registry.ts (then regenerate the contract:
  // `npx tsx scripts/gen-testing-domains-contract.ts`).
  const orphans = await findOrphanTests();
  for (const o of orphans) {
    offenders.push(`[ORPHAN] ${o}\n        → matches no registry glob → invisible in the /adv Tests tab. ` +
      `Widen a domain in apps/operator/lib/testing-domains-registry.ts, then ` +
      `regenerate: npx tsx scripts/gen-testing-domains-contract.ts`);
  }

  // Forbidden #4: bash *.test.sh / *.spec.sh — invisible to every CI runner
  // (test:affected only globs Vitest *.test.ts) AND a known foot-gun (`set -e`
  // + `((x++))` aborts after Test 1, so later assertions silently never run).
  // EI-1736. Use a Vitest *.test.ts that shells out to bash instead.
  const shellTests = await findShellTests();
  for (const s of shellTests) {
    offenders.push(`[NEW] ${s}\n        → bash *.test.sh/*.spec.sh are invisible to CI (no runner globs them) ` +
      `and abort after Test 1 under \`set -e\` + \`((x++))\` (D-006 / EI-1736). Use a Vitest *.test.ts ` +
      `that shells out to bash, e.g. apps/operator/lib/release/verify-release-paths.test.ts.`);
  }

  // Stale debt entries — files in the JSON that no longer exist.
  // Not an error; just a heads-up the JSON should be pruned.
  const stale: string[] = [];
  for (const path of [...debtMjs, ...debtSmoke]) {
    const abs = join(REPO_ROOT, path);
    try {
      await stat(abs);
    } catch {
      stale.push(path);
    }
  }

  if (stale.length > 0) {
    process.stdout.write('Stale debt entries (file deleted; remove from lint-tests-debt.json):\n');
    for (const p of stale) process.stdout.write(`  - ${p}\n`);
  }

  if (offenders.length > 0) {
    process.stderr.write('\n✗ lint-tests: new test-framework offenders found\n\n');
    for (const o of offenders) process.stderr.write(`  ${o}\n\n`);
    process.stderr.write(
      'See apps/operator-docs/src/content/docs/testing/index.mdx §1.0a ' +
      'for the four canonical frameworks.\n',
    );
    process.exit(1);
  }

  process.stdout.write('✓ lint-tests: no new offenders\n');
  process.stdout.write(`  ${debtMjs.size} .mjs + ${debtSmoke.size} -smoke.ts debt entries\n`);
  process.stdout.write('  every canonical test matches a registry glob (visible in the /adv Tests tab)\n');
}

void main();
