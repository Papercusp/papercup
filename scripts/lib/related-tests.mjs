// Import-graph test selection: given the files a change touched, work out which
// TEST files could possibly be affected, so an inner-loop run does not execute a
// whole workspace suite to verify a one-file edit.
//
// WHY A STATIC INDEX AND NOT `vitest related` (measured 2026-08-17, WI-39472):
// vitest builds its module graph through vite. At operator-core's size (~9,600
// files) that collection step alone costs more than the narrowing saves — plain
// `vitest list` TIMED OUT at 200s, and `vitest related` on one hub file was still
// running at 300s having selected most of the package. This pass is a regex over
// import specifiers and completes in about a second.
//
// WHAT THE NARROWING IS ACTUALLY WORTH (same measurement, operator-core):
// changing one source file selects a median of 915 of 4,978 test files (18.4%) —
// roughly 5.4x, with 31% of source files selecting <=10%. It is NOT a 100x win,
// because a barrel-connected core means most files reach most hub tests. Do not
// oversell it.
//
// ⚠ EVERY FAILURE MODE HERE MUST FAIL TOWARD RUNNING MORE TESTS. A selection bug
// that runs too many tests wastes minutes; one that runs too few reports a green
// run that verified nothing. Each rail below is written in that direction, and
// `related-tests.test.ts` pins them.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripCommentsOnly } from "./strip-comments-and-strings.mjs";

// ── WIDENING THRESHOLD (plan gate-latency-selection-and-retry-policy-2026-09-06, P-001) ──
// A related selection is CORRECT BY CONSTRUCTION at any share of the suite — every test that
// can reach the change is in it, so widening past it buys no safety, only cost. The old 0.5
// default widened operator-core to all 6,493 files on a 3,849-file selection (gate run
// e70cd139, 2026-09-05): 2,634 unrelated files ran for nothing, ~40% of that lane's wall
// clock. Widening only pays when the subset is so close to the whole that the explicit file
// list is pure overhead, hence a default just under 1.0. `AFFECTED_RELATED_THRESHOLD` overrides
// it (a fraction in (0, 1]); anything unparseable falls back to the default and is REPORTED via
// `source`/`invalid` so a typo cannot silently re-widen or re-narrow the gate.
export const RELATED_WIDEN_THRESHOLD_DEFAULT = 0.95;
export const RELATED_WIDEN_THRESHOLD_ENV = "AFFECTED_RELATED_THRESHOLD";

/**
 * Resolve the widening threshold from the environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ threshold: number, source: 'default' | 'env', invalid?: string }}
 */
export function resolveRelatedWidenThreshold(env = process.env) {
  const raw = env[RELATED_WIDEN_THRESHOLD_ENV];
  if (raw == null || String(raw).trim() === "") {
    return { threshold: RELATED_WIDEN_THRESHOLD_DEFAULT, source: "default" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    return {
      threshold: RELATED_WIDEN_THRESHOLD_DEFAULT,
      source: "default",
      invalid: String(raw),
    };
  }
  return { threshold: n, source: "env" };
}

// ── FILTER-LIST CHANNEL (same plan, P-001) ─────────────────────────────────────────────
// A large related selection cannot ride on argv: `npm run <script> -- <files>` folds every
// argument into ONE `sh -c` string, and Linux caps a single argv entry at MAX_ARG_STRLEN
// (128 KiB) — 3,849 operator-core paths are ~180 KB, so the widened lane was hiding an E2BIG
// that the old 0.5 threshold never let anyone reach. The selection is therefore written to a
// content-addressed JSON file and handed to the workspace's vitest config through
// `PC_TEST_FILTER_LIST` (libs/test-config/src/vitest-config.ts applies it to `include`).
// Content-addressing keeps the passing-task-verdict identity stable for an identical
// selection across runs, while a different selection can never alias a full-suite pass.
export const RELATED_FILTER_LIST_ENV = "PC_TEST_FILTER_LIST";

/**
 * Persist a workspace-relative selection as a filter-list file.
 *
 * @param {string}   dir    directory to write into (created if missing)
 * @param {string[]} files  workspace-relative test paths
 * @returns {{ path: string, digest: string, count: number }}
 */
export function writeRelatedFilterList(dir, files) {
  const normalized = [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort();
  const body = JSON.stringify(normalized);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `related-filter-${digest}.json`);
  try {
    writeFileSync(filePath, body, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Same content ⇒ same name: a concurrent writer already landed it.
    if (err?.code !== "EEXIST") throw err;
  }
  return { path: filePath, digest, count: normalized.length };
}

/** Extensions we index. */
const SOURCE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
]);

/** `import x from 's'` / `export … from 's'` / `import('s')` / `import 's'` / `require('s')`. */
const SPECIFIER_RE =
  /(?:\bimport\b|\bexport\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Runtime-loaded files named relative to the current module rather than imported. */
const MODULE_RUNTIME_PATH_RE =
  /\b(?:resolve|join)\s*\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)|\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

export function isTestFile(file) {
  return TEST_RE.test(file);
}

/** Config basenames Playwright is allowed to declare its ownership in. */
const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.js",
  "playwright.config.mjs",
];

/**
 * Which files in this workspace belong to PLAYWRIGHT rather than Vitest.
 *
 * `TEST_RE` above deliberately spans `.test.*` AND `.spec.*`, because both name real tests
 * somewhere in this repo. But they are not interchangeable RUNNERS: the Vitest unit layer
 * includes only `**\/*.test.ts(x)` (libs/test-config/src/vitest-config.ts), while
 * apps/operator/playwright.config.ts claims `testDir: './e2e'` + `testMatch: /.*\.spec\.ts$/`.
 * A Playwright spec handed to a Vitest lane therefore matches NOTHING, and the test router
 * refuses the whole partial-match run rather than false-greening it
 * (`TEST_FILE_ROUTE_ERROR requested=342 matched=340`, scripts/test-files.mjs). The task then
 * exits 1 with ZERO attributable test files — invisible to the `test_runs` ledger (no fail
 * rows) and to the gate's isolation re-run (no failing file to isolate), which is what made
 * EI-21440128879545486 red-pin green-checkpoint and freeze `main` for the whole fleet.
 *
 * The boundary is DERIVED from Playwright's own config, not a hardcoded `e2e/` glob, so
 * moving `testDir` moves this with it. The extension alone is NOT a safe discriminator:
 * search-core and the three papergrid packages legitimately use `src/**\/*.spec.ts` as their
 * VITEST include, and excluding those would silently shrink their runs — the exact false-green
 * this refusal exists to prevent.
 *
 * A config that is absent or unparseable owns NOTHING. That direction is deliberate: the
 * failure then stays LOUD (a red gate naming the unmatched file) instead of silently
 * withholding a test that should have run.
 *
 * @param {string} rootDir workspace root to look for a Playwright config in
 * @param {{ readFile?: (p: string) => string }} [seam] injected in tests
 * @returns {(absFile: string) => boolean} true when Playwright — not Vitest — owns the file
 */
export function playwrightOwnedTest(rootDir, { readFile } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  let source = null;
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    try {
      source = read(path.join(rootDir, name));
      break;
    } catch {
      // Not this basename; try the next.
    }
  }
  if (source == null) return () => false;

  const dirMatch = /\btestDir\s*:\s*['"]([^'"]+)['"]/.exec(source);
  const matchMatch = /\btestMatch\s*:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/.exec(
    source,
  );
  if (!dirMatch || !matchMatch) return () => false;

  const testDir = path.resolve(rootDir, dirMatch[1]);
  let testMatch;
  try {
    // Strip `g`/`y`: a stateful `lastIndex` would make `.test()` alternate per call.
    testMatch = new RegExp(matchMatch[1], matchMatch[2].replace(/[gy]/g, ""));
  } catch {
    return () => false;
  }

  return (absFile) =>
    (absFile === testDir || absFile.startsWith(testDir + path.sep)) &&
    testMatch.test(absFile);
}

/**
 * Whether Vitest's default UNIT config universally excludes this test path.
 *
 * Keep this contract byte-for-byte aligned with `LAYERED_TEST_FILE` and the unit-layer
 * exclusion globs in `libs/test-config/src/vitest-config.ts`. A related selection is handed
 * to the unit `test`/lane scripts as positional filters; allowing an integration or browser
 * test through makes the unit config reject the entire invocation before any test runs.
 *
 * This deliberately does NOT classify every `.spec.*` file. Some workspaces own Vitest specs
 * through a custom config, while the integration/browser suffixes are excluded by the shared
 * unit config everywhere.
 *
 * @param {string} file test path, absolute or relative
 * @returns {boolean} true when the unit Vitest layer excludes the file
 */
export function unitExcludedVitestTest(file) {
  return /\.(?:integration|browser)\.test\.[cm]?[jt]sx?$/.test(file);
}

/**
 * A specifier is INTRA-REPO if it points at a path we ought to be able to resolve
 * ourselves — relative, or one of the repo's path aliases. A BARE specifier
 * (`node:fs`, `vitest`, `@papercusp/operator-core`) is deliberately out of graph:
 * cross-package effects are already covered by workspace-level selection, and the
 * caller's empty-selection rail turns "changed file is in another package" into a
 * full-suite run.
 */
export function classifySpecifier(spec) {
  if (spec.startsWith(".")) return "relative";
  if (spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#"))
    return "alias";
  return "bare";
}

function defaultFs() {
  return {
    list(dir) {
      const out = [];
      (function walk(d) {
        let entries;
        try {
          entries = readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(p);
          } else if (SOURCE_RE.test(e.name)) out.push(p);
        }
      })(dir);
      return out;
    },
    read(p) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exists(p) {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Candidate on-disk paths for a resolved-but-extensionless specifier target. */
function candidatesFor(base) {
  const out = [base];
  for (const ext of [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".js",
    ".jsx",
  ]) {
    out.push(base + ext);
  }
  for (const idx of [
    "index.ts",
    "index.tsx",
    "index.mts",
    "index.mjs",
    "index.js",
  ]) {
    out.push(path.join(base, idx));
  }
  // A `./x.js` specifier in TS-land usually means `./x.ts` on disk.
  const swapped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  if (swapped !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) out.push(swapped + ext);
  }
  return out;
}

/**
 * Walk the transitive static module graph from a small set of entry files.
 *
 * This is the entry-oriented sibling of `buildIndex`: it reuses the same specifier parser and
 * resolver, but reads only modules the entries can actually reach. Passing-task provenance uses
 * it for the affected-test runner itself; indexing every file under `scripts/` would make an
 * unrelated maintenance script an input to every workspace test, while indexing the whole repo
 * would cost more than the cache can save.
 *
 * Runtime file paths named as `resolve(__dirname, './x')` / `new URL('./x', import.meta.url)` are
 * edges too. Vitest config loads setup/reporting modules by path rather than import; ignoring that
 * shape would produce a complete-looking but false-small proof. Every uncertainty fails closed.
 * An unreadable entry, unresolved relative/alias import or runtime path, edge escaping `rootDir`,
 * or empty graph returns `ok:false`; callers must run the task instead of reusing a proof. Bare
 * package imports are represented by the package-manager lockfiles in the caller's manifest and
 * therefore do not create an on-disk edge here.
 *
 * @param {object} [o]
 * @param {string} o.rootDir absolute repository root
 * @param {string[]} o.entryFiles absolute entry files to walk
 * @param {RelatedFs} [o.fs] filesystem seam (injected in tests)
 * @returns {{ ok: boolean, files: string[], unresolved: string[] }}
 */
export function staticImportClosure({
  rootDir,
  entryFiles,
  fs = defaultFs(),
} = {}) {
  const root = path.resolve(rootDir ?? ".");
  const pending = [...(entryFiles ?? [])].map((file) => path.resolve(file));
  const visited = new Set();
  const unresolved = new Set();

  const insideRoot = (file) => {
    const rel = path.relative(root, file);
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
  };

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (!insideRoot(file)) {
      unresolved.add(`${file}:outside-root`);
      continue;
    }
    const source = fs.read(file);
    if (source === null) {
      unresolved.add(`${file}:unreadable`);
      continue;
    }
    visited.add(file);
    let graphSource;
    try {
      graphSource = stripCommentsOnly(source, file);
    } catch {
      unresolved.add(`${file}:comment-strip-failed`);
      continue;
    }

    for (const match of graphSource.matchAll(SPECIFIER_RE)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      const kind = classifySpecifier(spec);
      if (kind === "bare") continue;
      if (kind === "alias") {
        unresolved.add(`${file}:${spec}`);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const target = candidatesFor(base).find((candidate) => fs.exists(candidate));
      if (!target || !insideRoot(target)) {
        unresolved.add(`${file}:${spec}`);
        continue;
      }
      pending.push(path.resolve(target));
    }
    for (const match of graphSource.matchAll(MODULE_RUNTIME_PATH_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      // Directory anchors such as `resolve(__dirname, '../..')` configure search roots; they are
      // not loaded modules. Only source-shaped runtime paths join the module proof here.
      if (!SOURCE_RE.test(spec)) continue;
      const target = candidatesFor(path.resolve(path.dirname(file), spec)).find((candidate) =>
        fs.exists(candidate),
      );
      if (!target || !insideRoot(target)) {
        unresolved.add(`${file}:runtime:${spec}`);
        continue;
      }
      pending.push(path.resolve(target));
    }
  }

  return {
    ok: visited.size > 0 && unresolved.size === 0,
    files: [...visited].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/**
 * The injectable filesystem seam. Declared as a typedef because `gen:declarations`
 * emits from JSDoc: an UNDOCUMENTED destructured option is inferred as a CLOSED
 * literal type (or, with no default to infer from, dropped from the emitted type
 * altogether), and every caller passing it then fails TS2353 "does not exist in
 * type". That is not hypothetical — it is exactly how this block came to be
 * written: the first emit declared `selectRelatedTests` as accepting only the
 * three params its JSDoc happened to list, and lint:tsc reported 10 errors in
 * related-tests-selection.test.ts for the ones it omitted. Keep every option
 * documented here, or the declaration silently narrows again.
 *
 * @typedef {object} RelatedFs
 * @property {(dir: string) => string[]}      list   recursively enumerate source files under `dir`
 * @property {(p: string) => string | null}   read   file contents, or null when unreadable
 * @property {(p: string) => boolean}         exists does this path resolve on disk
 */

/**
 * @typedef {object} RelatedIndex
 * @property {string[]}                files      every source file found under the root
 * @property {Map<string, Set<string>>} deps      file -> the intra-repo files it imports directly
 * @property {Set<string>}             unresolved files carrying an import we could NOT resolve
 */

/**
 * Build the forward dependency graph for `rootDir`.
 *
 * Returns `{ files, deps, unresolved }` where `unresolved` is the set of files
 * carrying at least one INTRA-REPO specifier we could not resolve. Those files are
 * treated as depending on everything (see `selectRelatedTests`) — an unresolved
 * edge is a hole in the graph, and the safe reading of a hole is "this might depend
 * on the thing you changed".
 *
 * @param {object}                  [o]
 * @param {string}                  o.rootDir   absolute dir to index (a workspace's source root)
 * @param {Record<string, string>}  [o.aliases] tsconfig `paths` prefix -> absolute dir
 * @param {RelatedFs}               [o.fs]      filesystem seam (injected in tests)
 * @returns {RelatedIndex}
 */
export function buildIndex({ rootDir, aliases = {}, fs = defaultFs() } = {}) {
  const files = fs.list(rootDir);
  const fileSet = new Set(files);
  const deps = new Map();
  const unresolved = new Set();

  const resolve = (fromFile, spec) => {
    const kind = classifySpecifier(spec);
    if (kind === "bare") return { kind, target: null };
    let base;
    if (kind === "relative") {
      base = path.resolve(path.dirname(fromFile), spec);
    } else {
      // Alias: try each configured prefix mapping.
      base = null;
      for (const [prefix, dir] of Object.entries(aliases)) {
        if (spec === prefix || spec.startsWith(prefix)) {
          base = path.resolve(dir, spec.slice(prefix.length));
          break;
        }
      }
      if (base === null) return { kind, target: null, unresolvable: true };
    }
    for (const cand of candidatesFor(base)) {
      if (fileSet.has(cand) || fs.exists(cand)) return { kind, target: cand };
    }
    return { kind, target: null, unresolvable: true };
  };

  for (const f of files) {
    const src = fs.read(f);
    if (src === null) {
      // Unreadable file: we cannot know what it imports. Fail loud-ish by marking
      // it unresolved rather than silently giving it zero dependencies.
      unresolved.add(f);
      deps.set(f, new Set());
      continue;
    }
    const set = new Set();
    for (const m of src.matchAll(SPECIFIER_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec) continue;
      const r = resolve(f, spec);
      if (r.target) set.add(r.target);
      else if (r.unresolvable) unresolved.add(f);
    }
    deps.set(f, set);
  }

  return { files, deps, unresolved };
}

/**
 * Exact transitive forward closure, including cyclic import graphs.
 *
 * A plain DFS cannot safely memoize while it is breaking a cycle: the first root
 * through a strongly-connected component sees a stack-truncated closure and
 * poisons every later lookup with that partial set. Test selection then depends
 * on file enumeration order and can silently miss a test. Collapse SCCs first;
 * their condensation graph is acyclic, so memoization is exact.
 */
export function transitiveDeps(index) {
  const { deps } = index;

  // Tarjan's algorithm: assign every file to one strongly-connected component.
  const nodes = new Set(deps.keys());
  for (const targets of deps.values()) {
    for (const target of targets) nodes.add(target);
  }
  const discovered = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const componentOf = new Map();
  const components = [];
  let nextIndex = 0;

  const connect = (file) => {
    const fileIndex = nextIndex++;
    discovered.set(file, fileIndex);
    lowlink.set(file, fileIndex);
    stack.push(file);
    onStack.add(file);

    for (const target of deps.get(file) ?? []) {
      if (!discovered.has(target)) {
        connect(target);
        lowlink.set(file, Math.min(lowlink.get(file), lowlink.get(target)));
      } else if (onStack.has(target)) {
        lowlink.set(file, Math.min(lowlink.get(file), discovered.get(target)));
      }
    }

    if (lowlink.get(file) !== discovered.get(file)) return;
    const componentId = components.length;
    const members = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      componentOf.set(member, componentId);
      members.push(member);
      if (member === file) break;
    }
    components.push(members);
  };

  for (const file of nodes) {
    if (!discovered.has(file)) connect(file);
  }

  // The component graph is a DAG. Memoizing its closure is therefore complete,
  // unlike memoizing a DFS that is still inside an import cycle.
  const componentDeps = components.map(() => new Set());
  for (const [file, targets] of deps) {
    const from = componentOf.get(file);
    for (const target of targets) {
      const to = componentOf.get(target);
      if (from !== undefined && to !== undefined && from !== to)
        componentDeps[from].add(to);
    }
  }
  const componentMemo = new Map();
  const visitComponent = (componentId) => {
    const cached = componentMemo.get(componentId);
    if (cached) return cached;
    const out = new Set();
    for (const target of componentDeps[componentId]) {
      out.add(target);
      for (const reachable of visitComponent(target)) out.add(reachable);
    }
    componentMemo.set(componentId, out);
    return out;
  };

  return (file) => {
    const componentId = componentOf.get(file);
    if (componentId === undefined) return new Set();
    const out = new Set(components[componentId]);
    out.delete(file);
    for (const reachable of visitComponent(componentId)) {
      for (const member of components[reachable]) out.add(member);
    }
    return out;
  };
}

/**
 * Select the test files that a change to `changedPaths` could affect.
 *
 * `mode` is `'related'` only when we are confident the subset is sound; every other
 * outcome is `'full'`, meaning the caller should run the whole suite. `reason`
 * always says which rail fired, so a collapse to "0 tests" can never be silent.
 *
 * @param {object}                 [o]
 * @param {string}                 o.rootDir        absolute dir to index (a workspace's source root)
 * @param {string[]}               o.changedPaths   absolute paths that changed
 * @param {Record<string, string>} [o.aliases]      tsconfig `paths` prefix -> absolute dir
 * @param {number}                 [o.threshold]    share of the suite at/above which the selection is
 *                                                  widened to the whole suite (default: the
 *                                                  `AFFECTED_RELATED_THRESHOLD` env, else
 *                                                  RELATED_WIDEN_THRESHOLD_DEFAULT)
 * @param {RelatedFs}              [o.fs]           filesystem seam (injected in tests)
 * @param {RelatedIndex | null}    [o.index]        prebuilt index, to avoid re-walking the tree
 * @returns {{ mode: 'related' | 'full', selected: string[], total: number, reason: string, threshold: number }}
 */
export function selectRelatedTests({
  rootDir,
  changedPaths,
  aliases = {},
  threshold = resolveRelatedWidenThreshold().threshold,
  fs = defaultFs(),
  index = null,
} = {}) {
  const idx = index ?? buildIndex({ rootDir, aliases, fs });
  const testFiles = idx.files.filter(isTestFile);
  const total = testFiles.length;

  if (total === 0) {
    return { mode: "full", selected: [], total: 0, reason: "no-test-files", threshold };
  }

  // Only changed paths INSIDE this root can be resolved against this index. A
  // change elsewhere (another package) that made this workspace affected cannot be
  // narrowed here — run everything.
  const inScope = changedPaths.filter(
    (p) => p.startsWith(rootDir + path.sep) || p === rootDir,
  );
  if (inScope.length === 0) {
    return {
      mode: "full",
      selected: [],
      total,
      reason: "no-changed-paths-in-scope",
      threshold,
    };
  }

  const changedSet = new Set(inScope);
  const reach = transitiveDeps(idx);
  const selected = new Set();

  for (const t of testFiles) {
    // A changed test file always selects itself, even if nothing imports it.
    if (changedSet.has(t)) {
      selected.add(t);
      continue;
    }
    // A file with an unresolved intra-repo import is a hole in the graph: assume it
    // could reach the change.
    if (idx.unresolved.has(t)) {
      selected.add(t);
      continue;
    }
    const deps = reach(t);
    for (const c of changedSet) {
      if (deps.has(c)) {
        selected.add(t);
        break;
      }
    }
  }

  if (selected.size === 0) {
    // An in-scope change that reaches NO test is far more likely to be a graph gap
    // than genuine proof that nothing covers it. Run everything.
    return { mode: "full", selected: [], total, reason: "empty-selection", threshold };
  }
  // P-001: this is a COST rule, not a soundness rail — the selection above is complete at any
  // share. It fires only when the subset is so close to the whole suite that the explicit file
  // list is pure overhead (see RELATED_WIDEN_THRESHOLD_DEFAULT).
  if (selected.size >= total * threshold) {
    return {
      mode: "full",
      selected: [],
      total,
      reason: `over-threshold(${selected.size}/${total})`,
      threshold,
    };
  }

  return {
    mode: "related",
    selected: [...selected].sort(),
    total,
    reason: "ok",
    threshold,
  };
}
