import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

const SERVER_HEAVY_OPERATOR_CORE_IMPORTS = [
  /@papercusp\/operator-core\/lib\/agent-tools(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/cross-hive-asks-pg(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/dbos(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/endpoint-route(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness-readers(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness-issues(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness\/routines(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/memory\/knowledge-read$/,
  /@papercusp\/operator-core\/lib\/operator-audit(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/operator-notes(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/plugin-loader(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/storage(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/sync\/hyperbee(?:\/|$)/,
  // sync-resolver/* is server-heavy by default. Exempt ONLY submodules proven to
  // pull nothing into the browser bundle — verify with `grep -cE '^import' <file>`
  // before adding one:
  //   list-meta             — pure pagination-label helpers, zero imports
  //   learning-retain-types — pure types + `as const` tables, zero imports. It exists
  //                           precisely so LearningTab can avoid learning-retain-read,
  //                           whose node:fs would enter the bundle.
  /@papercusp\/operator-core\/lib\/sync-resolver(?:$|\/(?!list-meta$|learning-retain-types$))/,
  /@papercusp\/operator-core\/lib\/text-artifacts(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/work-items(?:\/|$)/,
];

const DIRECT_SERVER_IMPORTS = [
  /^drizzle-orm(?:\/|$)/,
  /^postgres(?:\/|$)/,
  /^@papercusp\/papercusp-db(?:\/|$)/,
  /^@papercusp\/db(?:\/|$)/,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(abs);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) yield abs;
  }
}

/**
 * Remove comments before scanning, so prose that merely says "import" is not
 * read as an import statement. Keeps string literals intact — import specifiers
 * live in them.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/**
 * Import specifiers reached as VALUES (i.e. code that ends up in the bundle).
 * `import type` is excluded — it is erased at compile time.
 *
 * The clause between `import` and `from` may span lines (multi-line named
 * imports), but must NOT cross a statement boundary. `[^;]` is what enforces
 * that, and it is load-bearing: with `[\s\S]` a bare side-effect import
 * (`import "./x.css";`) swallows the following statement and reports the NEXT
 * line's `import type` as a value import. That false positive red-pinned the
 * release gate on 2026-08-16 (WI-39472) — LearningTab.tsx:106-107 is the exact
 * shape. Both failure modes are pinned by tests below; do not "simplify" this
 * back to `[\s\S]*?`.
 */
export function valueImports(source: string): string[] {
  const scanned = stripComments(source);
  const imports: string[] = [];
  for (const match of scanned.matchAll(/\bimport\s+(?!type\b)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
    imports.push(match[1]);
  }
  for (const match of scanned.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push(match[1]);
  }
  return imports;
}

function isForbiddenClientImport(specifier: string): boolean {
  return (
    SERVER_HEAVY_OPERATOR_CORE_IMPORTS.some((pattern) => pattern.test(specifier)) ||
    DIRECT_SERVER_IMPORTS.some((pattern) => pattern.test(specifier))
  );
}

describe('operator-core client boundary', () => {
  it('keeps server-heavy operator-core and DB modules out of Vite client value imports', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const rel = relative(SRC_ROOT, file);
      const imports = valueImports(readFileSync(file, 'utf8'));
      for (const specifier of imports) {
        if (isForbiddenClientImport(specifier)) {
          violations.push(`${rel}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// WI-39472: the scanner above silently over-reported for months and red-pinned the
// release gate. These pin BOTH failure modes with the real shapes from
// LearningTab.tsx, plus a calibration case — without the calibration, a scanner
// that reported NOTHING would also pass the two negative controls.
describe('valueImports scanner', () => {
  it('CALIBRATION: still reports a genuine multi-line value import', () => {
    const src = [
      'import {',
      '  RETAIN_FEED_TABS,',
      '  type RetainFeedRow,',
      '} from "@papercusp/operator-core/lib/sync-resolver/learning-retain-types";',
    ].join('\n');
    expect(valueImports(src)).toEqual([
      '@papercusp/operator-core/lib/sync-resolver/learning-retain-types',
    ]);
  });

  it('does not let a side-effect import swallow the NEXT statement', () => {
    // The exact LearningTab.tsx:106-107 shape. With `[\s\S]*?` the bare css
    // import matched across the newline and captured the `import type`
    // specifier, reporting a compile-time-erased import as a bundled value.
    const src = [
      'import "@/app/adv/harnesses/adv-panel-chrome.css";',
      'import type { HiveThroughputSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-throughput-read";',
    ].join('\n');
    expect(valueImports(src)).toEqual([]);
  });

  it('does not read the word "import" inside a comment as an import statement', () => {
    const src = [
      '// import — deliberately from the pure types module, never from',
      '// learning-retain-read (node:fs would enter the browser bundle).',
      'import type { Foo } from "@papercusp/operator-core/lib/sync-resolver/whatever";',
      '/* a block comment that mentions import ... from "nope" */',
    ].join('\n');
    expect(valueImports(src)).toEqual([]);
  });

  it('keeps `import type` erased but still catches a dynamic import()', () => {
    const src = [
      'import type { A } from "drizzle-orm";',
      'const m = await import("postgres");',
    ].join('\n');
    expect(valueImports(src)).toEqual(['postgres']);
  });

  it('does not mistake a protocol-relative URL in a string for a comment', () => {
    const src = 'import { x } from "https://example.com/a.js";';
    expect(stripComments(src)).toContain('https://example.com/a.js');
  });
});
