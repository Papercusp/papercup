// Guard: no SERVER-ONLY module may leak into the SPA's browser-eager import graph.
//
// A client React component that value-imports even ONE symbol from a server
// operator-core module drags that whole module — and everything it top-level
// imports — into the browser bundle. On the :3055 Vite dev graph there is NO
// tree-shaking and `node:` builtins are externalized to stubs that THROW on
// property access, so such a module evaluates and throws at module-init,
// white-screening the route ("This view hit an error":
// `get@__vite-browser-external:node:path` → `module code@…embedded-pg-discovery`).
// This exact class recurs (WI-5454: adv/KnowledgePackCandidates → knowledge-packs/
// candidates.ts pulled node:fs/node:path + sync-sse→embedded-pg-discovery into the
// browser). The typecheck can't catch it (aliases/graph aren't typed) and the unit
// suite never links the SPA — so this test IS the detector.
//
// FIX PATTERN when this fails: the client only needs a type or a pure constant —
// extract those into a client-safe `*-shared.ts` (types + pure values, ZERO
// node/server imports; `import type` from server modules is fine, it's erased),
// re-export them from the server module for existing callers, and point the
// client import at the shared file. See knowledge-packs/candidates-shared.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OPERATOR_VITE = resolve(__dirname, '../..'); // apps/operator-vite
const REPO_ROOT = resolve(OPERATOR_VITE, '../..');
const OPERATOR_ROOT = resolve(OPERATOR_VITE, '../operator'); // apps/operator ('@' alias)
const OPERATOR_CORE_LIB = resolve(REPO_ROOT, 'packages/operator-core/lib');
const ENTRY = resolve(OPERATOR_VITE, 'src/main.tsx');
const VITE_CONFIG = resolve(OPERATOR_VITE, 'vite.config.ts');

/** node: builtins that vite.config aliases to a browser SHIM are safe in the SPA. */
function shimmedNodeBuiltins(): Set<string> {
  const cfg = readFileSync(VITE_CONFIG, 'utf8');
  const out = new Set<string>();
  const re = /find:\s*\/\^(node:[a-z_/]+)\$\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cfg))) out.add(m[1]);
  return out;
}

/** A module in the client source trees can eagerly load its dynamic import()s. */
const isClient = (f: string): boolean =>
  f.includes('/apps/operator-vite/src/') || f.includes('/apps/operator/app/');

/** Only operator-core/operator modules are server-leak candidates worth flagging. */
const isOwnCode = (f: string): boolean =>
  f.startsWith(OPERATOR_CORE_LIB) || f.startsWith(join(OPERATOR_ROOT, 'lib')) || f.startsWith(join(OPERATOR_ROOT, 'app'));

function fileFor(base: string): string | null {
  for (const c of [base, base + '.ts', base + '.tsx', base + '.js', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  const s = spec.replace(/\?.*$/, '');
  if (s.startsWith('@papercusp/operator-core/lib/')) return fileFor(join(OPERATOR_CORE_LIB, s.slice('@papercusp/operator-core/lib/'.length)));
  if (s === '@papercusp/operator-core') return fileFor(join(REPO_ROOT, 'packages/operator-core/index'));
  if (s.startsWith('@/')) return fileFor(join(OPERATOR_ROOT, s.slice(2)));
  if (s.startsWith('.')) return fileFor(resolve(dirname(fromFile), s));
  return null; // other externals: browser-safe or explicitly shimmed elsewhere
}

// The clause between `import`/`export` and `from` may contain identifiers, braces,
// commas, `*`, `as` and `type` — but NEVER a `;` or a quote. Bounding the capture to
// `[^;'"]` is what keeps it from running past the end of its own statement.
//
// ⚠ It was `[\s\S]*?` until 2026-08-02, which made a SIDE-EFFECT import (`import
// './x.css';` — no `from` clause) swallow every line after it until the next `from`,
// then report THAT statement's specifier. Two ways it lied, both silent:
//   - the `^\s*type\b` guard below tested the runaway's text (which starts at the CSS
//     specifier), never the real statement, so a type-only `export type {…} from
//     '<server module>'` — fully erased by the bundler — was recorded as a RUNTIME edge
//     and reported as a leak. That false positive red-pinned the fleet gate.
//   - every statement the runaway jumped OVER lost its edge entirely, so the graph was
//     also under-walked — real leaks could hide behind a side-effect import.
const STMT = /(?:^|\n)\s*(?:import|export)\b([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
const SIDE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYN = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Runtime edges declared in ONE module's source (type-only erased). Pure, so the
 * scanner itself is unit-testable — see the 'import-graph scanner' suite below.
 */
function specsIn(src: string, allowDynamic: boolean): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Module-level /g regexes: reset so a call can never inherit a previous one's lastIndex.
  STMT.lastIndex = 0;
  SIDE.lastIndex = 0;
  DYN.lastIndex = 0;
  while ((m = STMT.exec(src))) {
    if (/^\s*type\b/.test(m[1])) continue;
    out.push(m[2]);
  }
  while ((m = SIDE.exec(src))) out.push(m[1]);
  if (allowDynamic) while ((m = DYN.exec(src))) out.push(m[1]);
  return [...new Set(out)];
}

/** Runtime edges (type-only erased). Dynamic import()s count only from client files. */
function edges(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return specsIn(src, isClient(file));
}

/** Unshimmed node: builtins a module top-level (non-type) imports. */
function unsafeNodeBuiltins(file: string, shimmed: Set<string>): string[] {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = new Set<string>();
  const re = /(?:^|\n)\s*import\b([\s\S]*?)from\s*['"](node:[^'"]+)['"]/g;
  const side = /(?:^|\n)\s*import\s*['"](node:[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/^\s*type\b/.test(m[1])) continue;
    if (!shimmed.has(m[2])) found.add(m[2]);
  }
  while ((m = side.exec(src))) if (!shimmed.has(m[1])) found.add(m[1]);
  return [...found];
}

describe('no server-only module leaks into the SPA browser-eager graph', () => {
  it('every client-reachable operator-core/operator module is browser-safe (no unshimmed node: builtins)', () => {
    const shimmed = shimmedNodeBuiltins();
    const seen = new Map<string, string[]>([[ENTRY, ['src/main.tsx']]]);
    const queue: Array<[string, string[]]> = [[ENTRY, ['src/main.tsx']]];
    while (queue.length) {
      const [file, path] = queue.shift()!;
      for (const spec of edges(file)) {
        const r = resolveSpec(spec, file);
        if (r && !seen.has(r)) {
          const np = [...path, `${spec} -> ${r.replace(REPO_ROOT + '/', '')}`];
          seen.set(r, np);
          queue.push([r, np]);
        }
      }
    }

    const leaks: string[] = [];
    for (const [file, chain] of seen) {
      if (!isOwnCode(file)) continue;
      const bi = unsafeNodeBuiltins(file, shimmed);
      if (bi.length) {
        leaks.push(
          `\n  ${file.replace(REPO_ROOT + '/', '')}  [${bi.join(', ')}]\n` +
            chain.map((p, i) => `      ${i}. ${p}`).join('\n'),
        );
      }
    }

    expect(
      leaks.length,
      `A server-only module reached the SPA's browser-eager import graph and imports an unshimmed node: builtin — it will throw at module-init on :3055 and white-screen the route.\n` +
        `Fix: extract the client-needed type/constant into a client-safe *-shared.ts (see knowledge-packs/candidates-shared.ts) and import from there.\n` +
        `Leaks:${leaks.join('\n')}\n`,
    ).toBe(0);
  });
});

// Guards the SCANNER above. The graph walk is only as honest as its statement
// parser, and a parser bug here is invisible in the worst way: it reports a leak
// that does not exist (red-pinning the gate on a type-only import the bundler
// erases) while simultaneously hiding the edges it ran past. Both directions are
// pinned below, so neither can regress silently.
describe('import-graph scanner', () => {
  const specs = (src: string) => [...specsIn(src, true)].sort();

  it('a side-effect import does not swallow the statements after it', () => {
    // The 2026-08-02 regression: `[\s\S]*?` let `import './x.css';` run past its own
    // statement to the next `from`, mis-reporting a type-only re-export as a runtime
    // edge — a false leak that red-pinned the fleet gate.
    expect(specs("import './x.css';\n\n/** doc */\nexport type {\n  A,\n} from '@srv/mod';\n")).toEqual(['./x.css']);
    // ...and every statement it jumped over kept its edge (the under-walk half).
    expect(specs("import './x.css';\nimport { a } from 'p';\nimport { b } from 'q';\n")).toEqual([
      './x.css',
      'p',
      'q',
    ]);
  });

  it('still records real value edges — including behind a side-effect import', () => {
    expect(specs("import './x.css';\nimport { realThing } from '@srv/mod';\n")).toEqual(['./x.css', '@srv/mod']);
    expect(specs("import { a } from '@srv/mod';\n")).toEqual(['@srv/mod']);
    expect(specs("export * from './b';\n")).toEqual(['./b']);
    expect(specs("import('./lazy')\n")).toEqual(['./lazy']);
  });

  it('erases type-only statements, which the bundler drops', () => {
    expect(specs("import type { a } from '@srv/mod';\n")).toEqual([]);
    expect(specs("export type {\n  A,\n  B,\n} from '@srv/mod';\n")).toEqual([]);
  });
});
