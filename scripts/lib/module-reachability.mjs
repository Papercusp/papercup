/**
 * module-reachability.mjs — the MODULE-level companion to the npm-script census in
 * `check-lint-guard-reachability.mjs` (WI-41775, plan decisions D-013 → D-014 → D-015).
 *
 * WHY A SECOND POPULATION. The script census answers "is this declared `lint:*` guard
 * reachable from a blocking path?" It has no opinion about a detector that was never
 * given an npm script at all — a MODULE that exports a detector, ships with its own
 * passing unit test, is cited by a SHIPPED plan's code-truth audit, and is called by
 * nothing. Three of those were measured on 2026-08-26:
 *
 *   packages/operator-core/lib/release/external-prerequisite-ports.ts
 *   apps/operator/lib/release/prompt-divergence.ts
 *   apps/operator/lib/release/gitignored-asset-coverage.ts
 *
 * Each had zero production importers. Each passed `plans:audit`, because a code-truth
 * citation verifies that code EXISTS at a path, never that anything CALLS it.
 *
 * ── WHY NOT KNIP (measured, D-015 §4) ────────────────────────────────────────
 * knip asks "is this file imported by anything?" A module's OWN `*.test.ts` satisfies
 * that, because test files are knip entry points. Removing `lib/**` from the operator
 * entry glob surfaced 31 unused files and NEITHER target module among them. knip
 * cannot see this class at all — not as a configuration mistake, but definitionally:
 * "imported by nothing" and "called on no production path" are different questions,
 * and only the second one is the defect. A clean answer to the wrong question is
 * indistinguishable from a clean answer to the right one.
 *
 * ── THE PROBE, AND WHY IT NEEDS NO ROOT SET ──────────────────────────────────
 * A reachability walk normally needs entry roots, and a wrong root set silently
 * reclassifies the whole population — the expensive failure mode. This probe avoids
 * one entirely by running a FIXPOINT over the population instead:
 *
 *   a module is DEAD when every non-test file that imports it (or executes it by
 *   path) is itself already known dead — iterate until nothing changes.
 *
 * That is monotone, terminates in at most |population| rounds, and needs no notion of
 * "the real entry point". It catches transitive death INSIDE the population (module A
 * kept alive only by dead module B) at no extra cost. Its stated limit: a dead module
 * OUTSIDE the population still shields whatever it imports.
 *
 * ── FAIL OPEN, AND PROVE IT CAN SEE ──────────────────────────────────────────
 * `assessGraphHealth` is the instrument's own positive control. If the import graph
 * resolves nothing, or classifies EVERY population module as dead, the honest reading
 * is "the probe is broken", not "the repo is 100% dead code" — so the caller skips the
 * axis with a warning instead of red-pinning the fleet gate. This mirrors the coverage
 * axis's fail-open stance in the host script, and exists because a green whose scope
 * nobody checked is the failure this whole family of guards keeps rediscovering.
 */

/* ── THE SELF-OBSERVATION DEFECT (measured 2026-08-26, during this file's own bring-up)
 *
 * `parseReleasePathMentions` treats a literal `lib/release/**` path in a file as
 * evidence that the file EXECUTES that module. The guard's own acknowledged-unreachable
 * allowlist is a list of exactly those paths — so the first wired run reported ALL 21
 * known-dead modules as reachable, each with one "production importer":
 * `scripts/check-lint-guard-reachability.mjs`. The detector had observed itself and
 * concluded the patient was healthy.
 *
 * Note the DIRECTION, which is what makes it dangerous: it fails GREEN. An empty
 * finding set and a passing watermark are indistinguishable from a clean tree, so the
 * guard would have sat there measuring nothing, indefinitely, looking like diligence —
 * which is the precise failure mode this whole file exists to detect. It was caught
 * only because an earlier standalone probe had measured 21 and the numbers disagreed.
 *
 * The remedy is the repo's existing one for this class: `scripts/proc-guard.mjs` walks
 * the CALLER's own ancestor chain and excludes it before matching, so it cannot
 * self-match. `selfExclusionPaths()` is that idea for a file scan — and it is derived
 * from `import.meta.url`, never a hardcoded string, so renaming this file cannot
 * silently re-open the hole.
 */

import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_RE = /\.test\.tsx?$/;
const DECLARATION_RE = /\.d\.[cm]?ts$/;
const SOURCE_RE = /\.(?:tsx?|[cm]?js|[cm]ts)$/;

/** Repo-relative paths under a `lib/release/` directory — the gate's own detector domain. */
const DETECTOR_DIR_RE = /(?:^|\/)lib\/release\//;

/** A repo-relative path spelled inside a file (a spawn/exec target, not an import). */
const RELEASE_PATH_MENTION_RE =
  /(?:apps|packages|libs)\/[\w./-]*lib\/release\/[\w./-]+\.(?:tsx?|[cm]ts)/g;

/**
 * The instrument's own source files, repo-relative — the reacher set that must be
 * excluded so the census cannot resurrect a module merely by NAMING it in an allowlist
 * or a report. See the SELF-OBSERVATION note above.
 *
 * Derived from `import.meta.url`, so a rename moves the exclusion with the file instead
 * of silently re-opening the hole. The host script adds its own path the same way.
 *
 * @param {string} root absolute repo root
 * @returns {Set<string>} repo-relative paths
 */
export function selfExclusionPaths(root) {
  const here = fileURLToPath(import.meta.url);
  const rel = relative(root, here).split(sep).join('/');
  return new Set([rel]);
}

/** True for a test file — a test importer is NOT production usage (that is the whole point). */
export function isTestFile(file) {
  return TEST_RE.test(String(file));
}

/**
 * The population: non-test, non-declaration TypeScript modules under a `lib/release/`
 * directory. Derived by scanning the tracked file list, never hand-listed, so a module
 * added or deleted re-classifies itself with no edit here.
 *
 * @param {string[]} files repo-relative tracked paths
 * @returns {string[]} sorted repo-relative module paths
 */
export function selectDetectorModules(files) {
  return files
    .filter((f) => /^(?:apps|packages|libs)\//.test(f))
    .filter((f) => DETECTOR_DIR_RE.test(f))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !isTestFile(f) && !DECLARATION_RE.test(f))
    .sort();
}

/**
 * Every module specifier in `text`: `from '...'`, bare `import '...'`, dynamic
 * `import('...')`, and `require('...')`.
 *
 * ⚠ Pass COMMENT-STRIPPED text. A commented-out import would otherwise read as usage,
 * which is a false NEGATIVE — the module looks alive while it is dead.
 *
 * @param {string} text comment-stripped file contents
 * @returns {string[]} raw specifiers, in source order, deduplicated
 */
export function parseImportSpecifiers(text) {
  const src = String(text);
  const out = new Set();
  for (const m of src.matchAll(/(?:\bfrom|^[ \t]*(?:import|export))[ \t]*['"]([^'"\n]+)['"]/gm)) {
    out.add(m[1]);
  }
  for (const m of src.matchAll(/\bimport[ \t]*\([ \t]*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\brequire[ \t]*\([ \t]*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  return [...out];
}

/**
 * Repo-relative `lib/release/**` paths spelled literally in `text` — how an executed
 * entry point (spawned with `tsx`, named in an npm script, referenced by a workflow) is
 * reached without ever being imported. Without this, every gate ENTRY module would be
 * reported dead, which is the obvious false positive this population invites.
 *
 * @param {string} text comment-stripped file contents
 * @returns {string[]} deduplicated repo-relative paths
 */
export function parseReleasePathMentions(text) {
  return [...new Set(String(text).match(RELEASE_PATH_MENTION_RE) ?? [])];
}

/** Normalize a POSIX-ish path, resolving `.` and `..` segments. */
function normalizePath(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirOf(file) {
  const i = String(file).lastIndexOf('/');
  return i === -1 ? '' : String(file).slice(0, i);
}

const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.js',
  '/index.mjs',
];

/**
 * Resolve one specifier to a repo-relative file, or null when it points outside the
 * repo (a node_modules package, a node: builtin).
 *
 * Handles the two shapes that matter here: a relative specifier, and a workspace
 * package subpath (`@papercusp/operator-core/lib/release/x`). NodeNext's `./x.js`
 * spelling of a TypeScript `./x.ts` is resolved too — missing that would under-count
 * importers, i.e. report a live module as dead.
 *
 * @param {{specifier:string, fromFile:string, fileSet:Set<string>, workspaceDirByName?:Map<string,string>}} args
 * @returns {string|null}
 */
export function resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName = new Map() }) {
  const spec = String(specifier);
  let base = null;

  if (spec.startsWith('.')) {
    base = normalizePath(`${dirOf(fromFile)}/${spec}`);
  } else {
    // Longest package name wins, so `@papercusp/x-core` is not matched by `@papercusp/x`.
    let bestName = null;
    for (const name of workspaceDirByName.keys()) {
      if (spec === name || spec.startsWith(`${name}/`)) {
        if (!bestName || name.length > bestName.length) bestName = name;
      }
    }
    if (bestName === null) return null;
    const dir = workspaceDirByName.get(bestName);
    const rest = spec === bestName ? 'index' : spec.slice(bestName.length + 1);
    base = normalizePath(`${dir}/${rest}`);
  }

  const bases = [base];
  const rewritten = base.replace(/\.(?:js|mjs|cjs)$/, '');
  if (rewritten !== base) bases.push(rewritten);

  for (const b of bases) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = b + suffix;
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Build the reverse edge map: target module -> the files that reach it, either by
 * importing it or by naming its path (an executed entry).
 *
 * Unresolved RELATIVE specifiers are reported rather than swallowed: a relative import
 * that fails to resolve means the resolver is wrong, and a resolver that quietly drops
 * edges under-counts importers in the exact direction that invents dead modules.
 *
 * @param {{files:string[], readFile:(f:string)=>string, workspaceDirByName?:Map<string,string>}} args
 */
export function buildImportGraph({ files, readFile, workspaceDirByName = new Map() }) {
  const fileSet = new Set(files);
  const importers = new Map();
  const pathMentions = new Map();
  const unresolvedRelative = [];
  let resolvedEdges = 0;

  const add = (map, target, from) => {
    if (target === from) return;
    if (!map.has(target)) map.set(target, new Set());
    map.get(target).add(from);
  };

  for (const file of files) {
    if (!SOURCE_RE.test(file) && !/\.(?:json|ya?ml)$/.test(file)) continue;
    const text = readFile(file);
    if (!text) continue;

    if (SOURCE_RE.test(file)) {
      for (const spec of parseImportSpecifiers(text)) {
        const target = resolveSpecifier({ specifier: spec, fromFile: file, fileSet, workspaceDirByName });
        if (target === null) {
          if (spec.startsWith('.')) unresolvedRelative.push({ from: file, specifier: spec });
          continue;
        }
        resolvedEdges += 1;
        add(importers, target, file);
      }
    }

    for (const mentioned of parseReleasePathMentions(text)) {
      if (fileSet.has(mentioned)) add(pathMentions, mentioned, file);
    }
  }

  return { importers, pathMentions, unresolvedRelative, resolvedEdges };
}

/**
 * The fixpoint. A population module is DEAD when no live, non-test file imports it and
 * no live, non-test file executes it by path — iterated until stable, so a module kept
 * alive only by another dead population module dies with it.
 *
 * @param {{population:string[], importers:Map<string,Set<string>>, pathMentions?:Map<string,Set<string>>, excludeReachers?:Set<string>}} args
 */
export function findUnreachableModules({
  population,
  importers,
  pathMentions = new Map(),
  excludeReachers = new Set(),
}) {
  const dead = new Set();
  const reachersOf = (m) =>
    [...new Set([...(importers.get(m) ?? []), ...(pathMentions.get(m) ?? [])])].filter(
      (f) => f !== m && !excludeReachers.has(f),
    );

  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds += 1;
    for (const m of population) {
      if (dead.has(m)) continue;
      const live = reachersOf(m).filter((f) => !isTestFile(f) && !dead.has(f));
      if (live.length === 0) {
        dead.add(m);
        changed = true;
      }
    }
  }

  const rows = population.map((m) => {
    const reachers = reachersOf(m);
    const testOnly = reachers.filter(isTestFile).sort();
    const production = reachers.filter((f) => !isTestFile(f)).sort();
    return {
      module: m,
      dead: dead.has(m),
      // Retained even for a dead module: "imported only by a module that is itself
      // dead" and "imported by nothing" are different findings, and the reader needs
      // to be able to tell them apart without re-deriving the graph.
      productionImporters: production,
      testImporters: testOnly,
      testedButUnwired: dead.has(m) && testOnly.length > 0,
    };
  });

  return { rows, dead: [...dead].sort(), rounds };
}

/**
 * The instrument's positive control. Answers "did this probe actually SEE the tree?"
 * before any verdict derived from it is believed.
 *
 * A probe that classifies the entire population dead has almost certainly failed to
 * resolve imports at all — the graph is broken, not the repo. Reporting that as a wall
 * of violations would red-pin the fleet gate on an instrument fault, so the caller is
 * told to skip the axis instead.
 *
 * @param {{resolvedEdges:number, population:string[], dead:string[], unresolvedRelative:{from:string,specifier:string}[]}} args
 * @returns {{measurable:boolean, reason:string|null, unresolvedRelativeCount:number}}
 */
export function assessGraphHealth({ resolvedEdges, population, dead, unresolvedRelative }) {
  const unresolvedRelativeCount = unresolvedRelative.length;
  if (resolvedEdges === 0) {
    return {
      measurable: false,
      reason: 'the import graph resolved ZERO edges — the resolver, not the tree, is broken',
      unresolvedRelativeCount,
    };
  }
  if (population.length > 0 && dead.length === population.length) {
    return {
      measurable: false,
      reason:
        `every one of ${population.length} modules classified unreachable — a probe that finds ` +
        'nothing alive has failed to see the tree, not proven the tree is dead',
      unresolvedRelativeCount,
    };
  }
  return { measurable: true, reason: null, unresolvedRelativeCount };
}
