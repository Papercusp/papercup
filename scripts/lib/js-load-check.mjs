/**
 * js-load-check.mjs — the pure LOAD-time detector for a tracked `.mjs` module
 * (EI-21891413651090807 / EI-21891737374606422).
 *
 * WHY THIS EXISTS, AND WHY `check-js-syntax.mjs` (node --check) DOES NOT COVER IT.
 *
 * 2026-08-30: `scripts/lib/preempt-markers.mjs` shipped with
 * `constEMPTY_MARKER_DEBRIS_MS = 5_000;` — a dropped space between `const` and
 * the identifier (the signature of a careless `replace_all`). That line is
 * SYNTACTICALLY VALID: in strict-mode ESM (every `.mjs` is strict by spec) it
 * parses as a plain assignment expression to an undeclared identifier, and only
 * fails at IMPORT/LINK time with `ReferenceError: constEMPTY_MARKER_DEBRIS_MS is
 * not defined`. Measured directly: `node --check` exits 0 on this exact line.
 * So `check-js-syntax.mjs` — this repo's existing `.mjs` guard, which is real and
 * correct for what it checks — is structurally blind to the entire class of "the
 * file parses but cannot be imported" defects: a strict-mode implicit-global
 * assignment, a genuinely missing/unresolvable import, a top-level throw, and so
 * on. A parse check is not a load check.
 *
 * Both importers of the broken module (`scripts/test-files.mjs` — every agent's
 * `npm run test:file` / `testing:run` — and `scripts/affected-tests.mjs`, the
 * runner the green-checkpoint gate itself invokes) died at import the instant the
 * file reached disk, with `node --check` reporting clean throughout.
 *
 * THE DETECTOR: actually `import()` the module, in a fresh subprocess, and read
 * the exit code. Not fully pure (shells out to a real `node`, mirroring
 * `findShellSyntaxError`'s `bash -n` shell-out in
 * packages/operator-core/lib/content-lint/shell-syntax.ts) but deterministic and
 * read-only — nothing on disk is touched, and the child process is thrown away.
 *
 * SCOPE, DELIBERATELY NARROW: `scripts/lib/**\/*.mjs` only (see
 * check-js-load.mjs). Actually importing a file EXECUTES its top-level code, so
 * this is only safe over a population whose modules are meant to be pure import
 * surfaces with no top-level side effects. `scripts/lib/` is exactly that
 * population by convention (small, focused helpers imported by the CLI scripts in
 * `scripts/`), and it was measured directly before this shipped: all 41 tracked
 * `scripts/lib/*.mjs` files import cleanly with no observable side effect or hang
 * under a 5s timeout. The top-level `scripts/*.mjs` CLI entry points are
 * deliberately OUT of scope — several of them (e.g. `scripts/test-files.mjs`) run
 * real top-level side effects (`ensurePapercuspTmpdir()`, `applyWorkerCapEnv()`)
 * that must not fire just because a lint pass imported the file.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ line: number | null, reason: string }} JsLoadErrorLike
 */

/** Bound the check so a pathological/hanging top-level side effect can never wedge a lint run. */
export const JS_LOAD_CHECK_TIMEOUT_MS = 5_000;

/**
 * Import `absPath` in a fresh `node` subprocess. Returns `null` when it loads
 * cleanly, or `{ line, reason }` parsed from node's own uncaught-exception report
 * on a load-time failure (ReferenceError, unresolved import, a top-level throw,
 * …). `absPath` must be an absolute filesystem path — relative imports inside the
 * module resolve against ITS real on-disk location, exactly as a real caller
 * would resolve them.
 */
export function findJsLoadError(absPath) {
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(absPath).href)})`],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: JS_LOAD_CHECK_TIMEOUT_MS },
    );
    return null;
  } catch (err) {
    const stderrText = err && err.stderr != null ? String(err.stderr) : '';
    const raw = stderrText.trim() || (err && err.message) || String(err);
    const lines = raw.split('\n');
    // node's uncaught-exception report for an import failure looks like:
    //   file:///abs/path.mjs:38
    //   constEMPTY_MARKER_DEBRIS_MS = 5_000;
    //                               ^
    //   ReferenceError: constEMPTY_MARKER_DEBRIS_MS is not defined
    //       at ModuleJob.run (node:internal/modules/esm/module_job:...)
    const posLine = lines.find((l) => /^file:\/\/.*:(\d+)$/.test(l.trim()));
    const line = posLine ? Number(posLine.trim().match(/:(\d+)$/)[1]) : null;
    const reasonLine = lines.find((l) => /^[A-Za-z][A-Za-z0-9]*Error:/.test(l.trim()));
    const reason = (reasonLine ? reasonLine.trim() : lines[0] || raw).slice(0, 500);
    return { line, reason };
  }
}
