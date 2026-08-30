#!/usr/bin/env node
/**
 * check-js-syntax.mjs — fail-loud guard for a syntactically BROKEN tracked
 * `.mjs` module (EI-20035436440627349).
 *
 * The sibling of `check-shell-syntax.mjs` (EI-13192), for the language that had
 * no such guard: `lint:shell-syntax` parses every tracked `.sh`, and nothing
 * parsed any of the 277 tracked `.mjs`.
 *
 *   node scripts/check-js-syntax.mjs
 *   node scripts/check-js-syntax.mjs --files=a.mjs,/tmp/b.mjs   # scoped / out-of-tree
 *
 * WHY THIS CLASS IS EXPENSIVE HERE, specifically. One unparseable module reds
 * every test file that transitively imports it. All of those produce real FAIL
 * rows, all attribute cleanly to a file, and the runner therefore stamps its
 * most confident label — `coverage=complete` — over a list of entirely INNOCENT
 * files, with the real culprit absent from it. CLAUDE.md documents that
 * consequence and `AFFECTED_TESTS_FAILING_FILES` now carries
 * `transformCulpritCount` to name the culprit, but both are downstream: they
 * describe the blast radius after a peer has already paid for it. This is the
 * upstream detector.
 *
 * Measured 2026-08-10 (the incident that prompted it): a regex pasted verbatim
 * into a JSDoc block — `.replace(/\/\/[^\n]*&#47;g, '')` — contains the comment
 * terminator, which ended the comment early and made
 * scripts/lib/strip-comments-and-strings.mjs unparseable tree-wide. A peer
 * found and fixed it before git-sync swept it, so no broken commit landed, but
 * that module is imported by guard scripts and their tests.
 *
 * DETECTOR: a real `node --check`, never a regex — the same
 * detector-not-a-heuristic rule D-003 set for the shell guard. `--check` uses
 * node's own parser and honours the module goal implied by the `.mjs`
 * extension, so `import`/`export` parse as ESM rather than as script-mode
 * syntax errors. (`new vm.Script(src)` would flag every ESM file, which is why
 * it is not used here.)
 *
 * Scope: tracked `.mjs`. Excludes _retired/, node_modules, dist. `.js`/`.cjs`
 * are deliberately OUT of scope — that surface includes large vendored bundles
 * (e.g. the desktop sidecar's monaco) whose baseline is unmeasured; this guard
 * ships ENFORCING because the `.mjs` baseline was measured clean first.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const isJsSyntaxScanned = (f) =>
  f.endsWith('.mjs') &&
  !f.startsWith('_retired/') &&
  !f.includes('/_retired/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/');

/**
 * The pure detector: resolves to `null` when the file parses, else a
 * `{ line, reason }` describing node's own parse error.
 *
 * Reads the exit CODE, never the output text. `node --check f 2>&1 | head -3`
 * reports HEAD's status (0) and reads exactly like a pass — the mistake made
 * while first measuring this class.
 */
export function findJsSyntaxError(absPath) {
  return new Promise((done) => {
    execFile(process.execPath, ['--check', absPath], { encoding: 'utf8' }, (err, _out, stderr) => {
      if (!err) return done(null);
      const text = String(stderr || '');
      // node prints `<path>:<line>` then the offending source, then `SyntaxError: <reason>`.
      const line = text.match(/^.*?:(\d+)$/m)?.[1];
      const reason = text.match(/^\s*(SyntaxError:.*)$/m)?.[1] ?? 'failed `node --check` (no SyntaxError line)';
      done({ line: line ? Number(line) : null, reason });
    });
  });
}

/**
 * The SECOND failure class (EI-21892432987434951): a module that PARSES but
 * cannot LOAD.
 *
 * `node --check` only parses. Assignment to an UNDECLARED binding is not a parse
 * error — it is a ReferenceError raised when the module is evaluated, and every
 * `.mjs` is strict-mode, so it is unconditional rather than environment-dependent.
 * This guard therefore printed `✓ all N tracked .mjs parse cleanly` over a module
 * that nothing could import — a confident false clean, which is worse than no
 * guard because it is the shape that ENDS an investigation.
 *
 * Measured 2026-08-30, the incident that prompted it: a `replace_all` of
 * `'export const '` -> `'const'` dropped the trailing space and produced
 * `constEMPTY_MARKER_DEBRIS_MS = 5000;` in scripts/test-files.mjs. That file IS
 * `npm run test:file`, so every peer's test runs broke for ~17 minutes while
 * `node --check` — and therefore this guard — reported the tree clean.
 *
 * PREDICATE: an unresolved reference that is a WRITE. Writes ONLY, deliberately:
 *   - an undeclared WRITE is a ReferenceError in every host, so it is always fatal;
 *   - an undeclared READ is not. `document` inside a playwright
 *     `page.evaluate(() => ...)` callback is correct code that resolves in the
 *     browser, and apps/operator/probe-adv-tmp.mjs is exactly that. A
 *     read-flagging predicate reported it as an offender; the write-only one does
 *     not. That is why this needs NO globals list and NO allowlist — measured
 *     ZERO offenders across all 358 tracked `.mjs`.
 *
 * A real `import()` load probe would also catch it and is REJECTED: it EVALUATES
 * module top-level, and the two files this guard most protects
 * (scripts/test-files.mjs, scripts/affected-tests.mjs) are test runners with
 * top-level side effects. A guard that runs the test runner to check the test
 * runner is not acceptable.
 */
const LOAD_CHECK_CONFIG = { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules: {} };

let linterPromise;
function loadLinter() {
  // eslint is a declared root dependency (^10.4.1). Imported lazily so this module
  // stays importable by tests, and so a missing install surfaces as a NAMED failure
  // rather than an import-time crash of the whole guard.
  linterPromise ??= import('eslint').then(({ Linter }) => new Linter());
  return linterPromise;
}

/**
 * Resolves to `null` when the module has no undeclared-write, else
 * `{ line, name }` naming the binding that will throw on load.
 *
 * Returns `null` for a file that does not PARSE: that is the `--check` leg's
 * class, and double-reporting one break as two would misstate the offender count.
 */
export async function findJsLoadError(absPath, source) {
  const linter = await loadLinter();
  const text = source ?? readFileSync(absPath, 'utf8');
  const messages = linter.verify(text, LOAD_CHECK_CONFIG, absPath);
  if (messages.some((m) => m.fatal)) return null; // unparseable — findJsSyntaxError owns it
  const globalScope = linter.getSourceCode()?.scopeManager?.globalScope;
  if (!globalScope) {
    // A checker that cannot run must not turn a broken file into a clean one.
    throw new Error(`check-js-syntax: eslint scope graph unavailable for ${absPath} — the load check cannot run`);
  }
  const hit = globalScope.through.find((ref) => ref.isWrite?.());
  if (!hit) return null;
  return { line: hit.identifier?.loc?.start?.line ?? null, name: hit.identifier?.name ?? '<unknown>' };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

async function main() {
  const filesArg = process.argv.find((a) => a.startsWith('--files='))?.slice('--files='.length);

  let targets;
  let unscanned = [];
  let scopeNote = '';
  if (filesArg) {
    // Scoped mode: takes paths verbatim (absolute ones too), so falsifiability
    // can be proved against a BROKEN COPY outside the tree — never by mutating
    // a tracked file, which git-sync would sweep mid-probe.
    targets = filesArg
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    scopeNote = ' (--files)';
  } else {
    // WI-6730: the shared helper recurses into submodules. A bare `git ls-files`
    // emits one gitlink per submodule, so a guard built on it silently parses
    // ZERO files inside all of them and prints ✓ regardless.
    const tracked = listTrackedFiles(ROOT);
    unscanned = tracked.unscanned ?? [];
    targets = tracked.files.filter(isJsSyntaxScanned);
  }

  // A zero denominator is a guard that measured NOTHING, which is not a pass.
  if (targets.length === 0) {
    console.error(`✗ check-js-syntax scanned 0 files${scopeNote} — that is a broken guard, not a clean tree.`);
    process.exit(1);
  }

  const results = await mapPool(targets, Math.max(4, availableParallelism()), async (f) => {
    const abs = isAbsolute(f) ? f : resolve(ROOT, f);
    return { f, hit: await findJsSyntaxError(abs) };
  });

  const offenders = results.filter((r) => r.hit).map((r) => `${r.f}:${r.hit.line ?? '?'}  ${r.hit.reason}`);

  if (offenders.length === 0) {
    console.log(`✓ all ${targets.length} tracked .mjs parse cleanly (node --check)${scopeNote}.${describeUnscanned(unscanned)}`);
    process.exit(0);
  }

  console.error(`✗ syntactically BROKEN .mjs module(s) — a hard \`node --check\` parse failure:\n`);
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s) of ${targets.length} scanned. Until fixed, every test file that` +
      `\n  transitively imports one reds with a "coverage=complete" break set naming INNOCENT files.` +
      `\n  See EI-20035436440627349.`,
  );
  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
