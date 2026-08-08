/**
 * import-graph — the transitive RUNTIME import graph of a TypeScript module.
 *
 * Two guards need the same question answered — "what does importing this
 * module actually load?" — and they need it answered the same way:
 *
 *  - `configure-search-defaults-import-purity.test.ts` (D-026): the P-017 seam
 *    self-installs on import, so whatever it reaches, every `runHybridSearch`
 *    caller reaches. It must not reach a module that opens PG at import.
 *  - `search-surface-conformance.test.ts` (P-021): a surface's feature set is
 *    DERIVED from what its implementation reaches, not from what its own file
 *    happens to spell. `rubrics:search` and `cupboard:search` contain no search
 *    mechanism at all in their own file — both delegate — so a per-file grep
 *    reports "keyword-only" for surfaces it simply did not follow.
 *
 * ─── WHY STATIC, AND WHAT THAT BUYS ────────────────────────────────────────
 * The alternative (import the module and observe) is what found D-026's bug in
 * the first place, and it is strictly more truthful. It is also unusable as a
 * guard here: importing a search surface executes its module-scope code, which
 * is exactly the thing under test. A static walk is inert.
 *
 * ─── THE BOUND, STATED PLAINLY ─────────────────────────────────────────────
 * This follows RELATIVE specifiers only. Bare package specifiers
 * (`@papercusp/*`, node builtins) are RECORDED in `externals` and not
 * traversed. So a heavy module reached only through a package entrypoint is
 * invisible to the walk. That is a real hole, not a rounding error — treat a
 * negative result as "not reached through relative imports", never as "not
 * reached". Every caller that asserts an ABSENCE therefore owes a CONTROL: run
 * the same walk from a module that DOES reach the thing, and assert it is
 * found. Without that, a walker broken by a rename passes every absence
 * assertion while checking nothing.
 *
 * ⚠ GENERIC-FIRST DEFERRAL (stated, per repo convention). This algorithm is
 * domain-free and belongs in `libs/generic/`. It is here instead because
 * standing up a new workspace requires an `npm install` against the SHARED
 * tree — a fleet-visible mutation that can rewrite `node_modules/.bin` under
 * every other agent's in-flight test run — and both consumers today live in
 * this package. Promote it the moment a third consumer appears outside
 * operator-core; tracked on EI-19899318545334860.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ImportGraph {
  /** Every .ts/.tsx file reachable from the entry, EXCLUDING the entry itself. */
  modules: Set<string>;
  /** Bare specifiers seen anywhere in the graph, e.g. `@papercusp/search`. */
  externals: Set<string>;
  /** Relative specifiers that resolved to nothing — a rename, or a bug here. */
  unresolved: Array<{ from: string; specifier: string }>;
}

/**
 * The relative + bare RUNTIME import specifiers of one TS module.
 *
 * `import type` / `export type` statements are erased by the compiler and pull
 * NOTHING at runtime, so counting them would report a coupling that does not
 * exist — the difference between "this module loads PG at import" and "this
 * module mentions a PG type". An inline `{ type X, y }` still emits (it has a
 * value import), so only the statement-leading `type` keyword disqualifies a
 * statement.
 */
export function runtimeSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const withFrom = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(withFrom)) {
    if (m[1]) continue; // `import type … from` / `export type … from`
    out.push(m[3]);
  }
  // Side-effect imports (`import './x';`) have no `from` clause and are always
  // runtime. This is the form that installs a policy — never skip it.
  const sideEffect = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(sideEffect)) out.push(m[1]);
  return out;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a RELATIVE specifier to a concrete .ts/.tsx file, or null. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  // `.js` in a specifier is the ESM-correct spelling of a `.ts` source here.
  const stripped = base.replace(/\.js$/, '');
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (/\.(ts|tsx)$/.test(cand) && isFile(cand)) return cand;
  }
  return null;
}

/**
 * Walk the transitive runtime import graph from `entry`.
 *
 * `stopAt` prunes traversal INTO a module while still recording it — use it to
 * keep a walk bounded without pretending the module is absent.
 */
export function importGraph(
  entry: string,
  opts: { stopAt?: (file: string) => boolean } = {},
): ImportGraph {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const unresolved: Array<{ from: string; specifier: string }> = [];
  const visited = new Set<string>([entry]);
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    for (const spec of runtimeSpecifiers(file)) {
      if (!spec.startsWith('.')) {
        externals.add(spec);
        continue;
      }
      const next = resolveRelative(file, spec);
      if (!next) {
        unresolved.push({ from: file, specifier: spec });
        continue;
      }
      modules.add(next);
      if (visited.has(next)) continue;
      visited.add(next);
      if (opts.stopAt?.(next)) continue;
      queue.push(next);
    }
  }

  modules.delete(entry);
  return { modules, externals, unresolved };
}

/** Convenience: does the runtime graph from `entry` reach `target`? */
export function reaches(entry: string, target: string): boolean {
  return importGraph(entry).modules.has(target);
}
