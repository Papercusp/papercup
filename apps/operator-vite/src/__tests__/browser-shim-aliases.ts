// Shim-alias helpers shared by `browser-shims.test.ts` and
// `no-server-leak-in-client-graph.test.ts`.
//
// They live in a PLAIN module — not exported from a `.test.ts` — on purpose. A test
// file that is imported by ANOTHER test file is collected twice, and under a shared-
// fork lane (`isolate:false`, the operator-core pure lane) the second collection can
// register zero tests for the importer → `No test suite found` with
// `--no-passWithNoTests` (gate red 761d0a85ac, WI-212675 / EI-22270313271658561).
// `packages/operator-core/lib/no-test-file-imports.test.ts` guards the whole tree
// against that shape; never export helpers from a `.test.ts` again.

/** An `alias` entry in vite.config that redirects a specifier at a browser shim. */
export interface ShimAlias {
  /** Source text of the `find:` — a quoted string or a regex literal. */
  find: string;
  /** Shim filename, e.g. `coordination-event-log-browser.ts`. */
  shim: string;
}

/**
 * The shim aliases, parsed from vite.config's SOURCE rather than by importing it —
 * importing would instantiate every plugin (router codegen, react) for no benefit,
 * and the source is the thing a reviewer reads anyway.
 */
export function parseShimAliases(configSource: string): ShimAlias[] {
  const out: ShimAlias[] = [];
  // { find: <string|regex>, replacement: resolve(import.meta.dirname, 'src/shims/<file>') }
  const entry = /find:\s*([^,]+),[\s\S]{0,240}?shims\/([\w.-]+\.ts)/g;
  for (const m of configSource.matchAll(entry)) {
    out.push({ find: m[1]!.trim(), shim: m[2]! });
  }
  return out;
}

/** Does an import specifier resolve through this alias? Mirrors vite's alias matching. */
export function aliasMatches(find: string, specifier: string): boolean {
  if (find.startsWith('/')) {
    const lastSlash = find.lastIndexOf('/');
    const body = find.slice(1, lastSlash);
    const flags = find.slice(lastSlash + 1).replace(/[gy]/g, '');
    return new RegExp(body, flags).test(specifier);
  }
  const literal = find.slice(1, -1); // strip quotes
  // vite's string alias is a PREFIX match ('@papercusp/x' also catches '@papercusp/x/y').
  return specifier === literal || specifier.startsWith(literal + '/');
}

/**
 * Every VALUE binding imported from `specifier`-matching modules in `source`.
 * `import type { … }` and inline `{ type X }` are erased before the bundler links
 * them, so they are not a shim's problem — only values are.
 */
export function valueImports(source: string, matches: (specifier: string) => boolean): string[] {
  const names: string[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    if (m[1]) continue; // `import type { … }`
    if (!matches(m[3]!)) continue;
    for (const raw of m[2]!.split(',')) {
      const spec = raw.trim();
      if (!spec || /^type\s/.test(spec)) continue; // inline `{ type Foo }`
      names.push((spec.split(/\s+as\s+/)[0] ?? '').trim());
    }
  }
  return names.filter(Boolean);
}
