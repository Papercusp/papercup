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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Extensions we index. */
const SOURCE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next']);

/** `import x from 's'` / `export … from 's'` / `import('s')` / `import 's'` / `require('s')`. */
const SPECIFIER_RE =
  /(?:\bimport\b|\bexport\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function isTestFile(file) {
  return TEST_RE.test(file);
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
  if (spec.startsWith('.')) return 'relative';
  if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#')) return 'alias';
  return 'bare';
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
        return readFileSync(p, 'utf8');
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
  for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']) {
    out.push(base + ext);
  }
  for (const idx of ['index.ts', 'index.tsx', 'index.mts', 'index.mjs', 'index.js']) {
    out.push(path.join(base, idx));
  }
  // A `./x.js` specifier in TS-land usually means `./x.ts` on disk.
  const swapped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  if (swapped !== base) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(swapped + ext);
  }
  return out;
}

/**
 * Build the forward dependency graph for `rootDir`.
 *
 * Returns `{ files, deps, unresolved }` where `unresolved` is the set of files
 * carrying at least one INTRA-REPO specifier we could not resolve. Those files are
 * treated as depending on everything (see `selectRelatedTests`) — an unresolved
 * edge is a hole in the graph, and the safe reading of a hole is "this might depend
 * on the thing you changed".
 */
export function buildIndex({ rootDir, aliases = {}, fs = defaultFs() } = {}) {
  const files = fs.list(rootDir);
  const fileSet = new Set(files);
  const deps = new Map();
  const unresolved = new Set();

  const resolve = (fromFile, spec) => {
    const kind = classifySpecifier(spec);
    if (kind === 'bare') return { kind, target: null };
    let base;
    if (kind === 'relative') {
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

/** Transitive forward closure with memoization and a cycle guard. */
export function transitiveDeps(index) {
  const memo = new Map();
  const { deps } = index;
  const visit = (f, stack) => {
    const cached = memo.get(f);
    if (cached) return cached;
    if (stack.has(f)) return new Set();
    stack.add(f);
    const out = new Set();
    for (const d of deps.get(f) ?? []) {
      out.add(d);
      for (const x of visit(d, stack)) out.add(x);
    }
    stack.delete(f);
    memo.set(f, out);
    return out;
  };
  return (f) => visit(f, new Set());
}

/**
 * Select the test files that a change to `changedPaths` could affect.
 *
 * `mode` is `'related'` only when we are confident the subset is sound; every other
 * outcome is `'full'`, meaning the caller should run the whole suite. `reason`
 * always says which rail fired, so a collapse to "0 tests" can never be silent.
 *
 * @param {object}   o
 * @param {string}   o.rootDir      absolute dir to index (a workspace's source root)
 * @param {string[]} o.changedPaths absolute paths that changed
 * @param {number}   o.threshold    fraction of the suite above which selecting is pointless
 */
export function selectRelatedTests({
  rootDir,
  changedPaths,
  aliases = {},
  threshold = 0.5,
  fs = defaultFs(),
  index = null,
} = {}) {
  const idx = index ?? buildIndex({ rootDir, aliases, fs });
  const testFiles = idx.files.filter(isTestFile);
  const total = testFiles.length;

  if (total === 0) {
    return { mode: 'full', selected: [], total: 0, reason: 'no-test-files' };
  }

  // Only changed paths INSIDE this root can be resolved against this index. A
  // change elsewhere (another package) that made this workspace affected cannot be
  // narrowed here — run everything.
  const inScope = changedPaths.filter((p) => p.startsWith(rootDir + path.sep) || p === rootDir);
  if (inScope.length === 0) {
    return { mode: 'full', selected: [], total, reason: 'no-changed-paths-in-scope' };
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
    return { mode: 'full', selected: [], total, reason: 'empty-selection' };
  }
  if (selected.size >= total * threshold) {
    return {
      mode: 'full',
      selected: [],
      total,
      reason: `over-threshold(${selected.size}/${total})`,
    };
  }

  return {
    mode: 'related',
    selected: [...selected].sort(),
    total,
    reason: 'ok',
  };
}
