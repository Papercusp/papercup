#!/usr/bin/env node
/**
 * trace-vite-externalized.mjs — ATTRIBUTION companion to check-vite-externalized-warnings.mjs
 * (WI-4518).
 *
 * The count gate (check-vite-externalized-warnings.mjs) tells you the SPA bundle references N
 * externalized node/server modules, but not WHICH client code is responsible, nor — crucially —
 * whether a given reach is an eval-time WHITE-PAGE RISK or benign lazy-chunk erosion. Those are
 * very different: an externalized stub THROWS on property access at module-eval, so a server
 * module reached EAGERLY (via static `import` edges from the SPA entry, no lazy/`await import`
 * boundary in between) blanks the WHOLE app the moment any route evaluates it — that is exactly
 * what shipped on 2026-07-04 (tooldef run-script's top-level `import {Worker} from
 * 'node:worker_threads'`) and 2026-07-12. The same server module reached only through a
 * `await import()` route-split boundary sits in its own lazy chunk and is harmless-but-noisy.
 *
 * This tool runs the REAL operator-vite build (write:false — no dist emit) with a tracer plugin
 * and classifies every externalized builtin by HOW the SPA reaches it:
 *   - EAGER   — a client `src/` module statically reaches a module that STATICALLY imports the
 *               builtin (importedIds, i.e. non-`import type`, non-`await import`). White-page risk.
 *               This set should stay ~empty (only intentional polyfills, e.g. buffer).
 *   - LAZY    — reachable only across an `await import()` / route-split boundary. Erosion, not a
 *               crash. This is the bulk of the count.
 * For each EAGER reach it prints the shortest static import chain from a client entry — the P-010
 * "name the file" philosophy (same as lint:tsc's per-file attribution).
 *
 * The graph logic is pure + unit-tested (check-vite-externalized-warnings has no build to mock);
 * see trace-vite-externalized.test.ts.
 *
 * Usage:  npm run trace:vite-externalized            # full report
 *         npm run trace:vite-externalized -- --json  # machine-readable
 */
import { isBuiltin, createRequire } from 'node:module';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'apps/operator-vite');
const SRC = resolve(APP_DIR, 'src');

/**
 * Modules reachable from `eagerRoots` following STATIC edges only (never crossing a dynamic
 * `await import()` boundary). Pure — takes a plain adjacency map.
 * @param {Iterable<string>} eagerRoots
 * @param {Map<string,string[]>} staticEdges  parent id -> static child ids
 * @returns {Set<string>}
 */
export function reachableStatic(eagerRoots, staticEdges) {
  const seen = new Set();
  const q = [...eagerRoots];
  for (const r of q) seen.add(r);
  while (q.length) {
    const cur = q.shift();
    for (const child of staticEdges.get(cur) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        q.push(child);
      }
    }
  }
  return seen;
}

/**
 * Classify each externalized builtin as EAGER (statically reachable from an eager root and
 * statically importing the builtin) vs not. Pure.
 * @param {object} p
 * @param {Iterable<string>} p.eagerRoots
 * @param {Map<string,string[]>} p.staticEdges
 * @param {Map<string,Set<string>>} p.builtinStaticImporters  builtin -> modules with a STATIC import of it
 * @returns {{ reachCount:number, eager:Array<{builtin:string, eagerImporters:string[]}> }}
 */
export function computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters }) {
  const reach = reachableStatic(eagerRoots, staticEdges);
  const eager = [];
  for (const [builtin, importers] of builtinStaticImporters) {
    const eagerImporters = [...importers].filter((id) => reach.has(id));
    if (eagerImporters.length) eager.push({ builtin, eagerImporters });
  }
  eager.sort((a, b) => b.eagerImporters.length - a.eagerImporters.length);
  return { reachCount: reach.size, eager };
}

/** Shortest static chain from any eager root down to `target`. Pure. */
export function shortestStaticChain(eagerRoots, staticEdges, target) {
  const seen = new Set(eagerRoots);
  const q = [...eagerRoots].map((r) => [r]);
  let guard = 0;
  while (q.length && guard++ < 1_000_000) {
    const path = q.shift();
    const cur = path[path.length - 1];
    if (cur === target) return path;
    for (const child of staticEdges.get(cur) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        q.push([...path, child]);
      }
    }
  }
  return null;
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const appRequire = createRequire(APP_DIR + '/package.json');
  const { build } = await import(appRequire.resolve('vite'));

  /** @type {Map<string,string[]>} */ const staticEdges = new Map(); // parent -> static children (non-builtin)
  /** @type {Map<string,Set<string>>} */ const builtinStaticImporters = new Map(); // builtin -> importers (static)
  const entryIds = new Set();

  const tracer = {
    name: 'externalized-attribution-tracer',
    enforce: 'pre',
    moduleParsed(info) {
      const kids = [];
      for (const child of info.importedIds) {
        if (isBuiltin(child)) {
          const key = child.replace(/^node:/, '');
          if (!builtinStaticImporters.has(key)) builtinStaticImporters.set(key, new Set());
          builtinStaticImporters.get(key).add(info.id);
        } else {
          kids.push(child);
        }
      }
      staticEdges.set(info.id, kids);
      if (info.isEntry) entryIds.add(info.id);
    },
  };

  await build({
    root: APP_DIR,
    configFile: resolve(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
    plugins: [tracer],
    build: { write: false },
  });

  const eagerRoots = [...entryIds];
  const { reachCount, eager } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters });
  const rel = (id) => (id.startsWith('/') ? relative(ROOT, id) : id);
  const isSrc = (id) => id.startsWith(SRC + '/');

  const report = {
    entries: eagerRoots.map(rel),
    eagerReachableModules: reachCount,
    distinctExternalizedBuiltins: builtinStaticImporters.size,
    eagerExternalized: eager.map(({ builtin, eagerImporters }) => {
      // Attribute: shortest static chain from an entry to the first eager static importer.
      const chain = shortestStaticChain(eagerRoots, staticEdges, eagerImporters[0]) || [];
      const clientEntry = [...chain].reverse().find(isSrc) || chain.find(isSrc) || null;
      return {
        builtin,
        eagerImporterCount: eagerImporters.length,
        exampleImporter: rel(eagerImporters[0]),
        clientEntry: clientEntry ? rel(clientEntry) : null,
        chain: chain.map(rel),
      };
    }),
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`\nEAGER externalized-module reach — the WHITE-PAGE-RISK subset (WI-4518)\n`);
    console.log(`  build entries: ${report.entries.join(', ')}`);
    console.log(`  eager-reachable modules: ${reachCount}   distinct externalized builtins (any): ${builtinStaticImporters.size}`);
    if (report.eagerExternalized.length === 0) {
      console.log(`\n  ✓ No server/node builtin is reached EAGERLY (static-only) from the SPA entry.`);
      console.log(`    (The count gate's remaining warnings are all behind lazy import boundaries.)`);
    } else {
      console.log(`\n  ⚠ ${report.eagerExternalized.length} builtin(s) reached EAGERLY — each blanks the app if its module evaluates:\n`);
      for (const e of report.eagerExternalized) {
        console.log(`  • node:${e.builtin}  (${e.eagerImporterCount} eager importer(s))  client entry: ${e.clientEntry ?? '?'}`);
        for (const step of e.chain) console.log(`        → ${step}`);
      }
      console.log(`\n  Fix each: import type, lazy \`await import()\`, or a browser-safe subpath/shim.`);
    }
    console.log('');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
