// Guard: no source file may import from a `.test.*` / `.spec.*` module.
//
// Why this exists (gate red 761d0a85ac, 2026-09-03 — WI-212675, EI-22270313271658561):
// `boot-e2e-pg-lock-guard.test.ts` imported helpers that `boot-check-timeout-coherence.test.ts`
// exported. Vitest then evaluates the imported test file TWICE — once as a collected suite and
// once as a dependency of its importer. Under an isolated run that is merely wasteful; under a
// shared-fork lane (`isolate:false`, the operator-core pure lane) the module registry is shared,
// so the second evaluation finds the module already cached and the importee's own collection
// registers ZERO tests → `No test suite found` → red with `--no-passWithNoTests`. The failure
// is attributed to whichever file happens to collect first, so it looks like a flake and passes
// again in a fresh process. The durable fix is structural: helpers live in a plain module and
// BOTH tests import it. This guard fails the moment anyone re-introduces the shape.
//
// Scope: every tracked TypeScript file of the superproject (`git ls-files`, so submodules —
// which have their own suites — and untracked scratch are excluded). Dynamic `import('x.test')`
// and `vi.mock('x.test')` are not the failure class (they do not re-collect a suite) and are
// deliberately not matched.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Static `import … from 'x'`, `export … from 'x'`, and side-effect `import 'x'` specifiers. */
const STATIC_IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;

/** A specifier that resolves to a test file: `./foo.test`, `../bar.spec.ts`, `./x.test.js`. */
const TEST_MODULE_SPECIFIER = /\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/;

/**
 * The test-module specifiers statically imported by `source`. Exported so the calibration
 * controls below exercise the SAME scanner the tree walk uses.
 */
export function findTestModuleImports(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(STATIC_IMPORT_SPECIFIER)) {
    const specifier = m[1]!;
    if (TEST_MODULE_SPECIFIER.test(specifier)) hits.push(specifier);
  }
  return hits;
}

/** Tracked TypeScript files of the superproject, repo-relative. */
function trackedTypeScriptFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.cts'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter((p) => p && !p.includes('/node_modules/') && !p.includes('/_retired/'));
}

describe('no source file imports from a .test/.spec module (gate red 761d0a85ac, WI-212675)', () => {
  it('calibration: the scanner catches every static-import shape that re-collects a test file', () => {
    expect(
      findTestModuleImports(
        [
          `import { a } from './foo.test';`,
          `import b from "../bar.spec";`,
          `import * as ns from './baz.test.ts';`,
          `export { c } from './qux.spec.tsx';`,
          `export * from './quux.test.js';`,
          `import './side-effect.test';`,
          `import type { T } from './typed.test';`,
        ].join('\n'),
      ),
    ).toEqual([
      './foo.test',
      '../bar.spec',
      './baz.test.ts',
      './qux.spec.tsx',
      './quux.test.js',
      './side-effect.test',
      './typed.test',
    ]);
  });

  it('calibration: ordinary specifiers, dynamic imports and mocks are NOT flagged', () => {
    expect(
      findTestModuleImports(
        [
          `import { a } from './foo';`,
          `import { b } from './latest-tests';`,
          `import { c } from '@papercusp/test-config';`,
          `import { d } from './spec-parser';`,
          `import { e } from './contest';`,
          `const lazy = await import('./foo.test');`,
          `vi.mock('./bar.spec', () => ({}));`,
          `// see ./foo.test for the guard`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('calibration: a CONTROL scanner that only checks the file extension would miss the real shape', () => {
    // The wrong implementation someone might "simplify" this into: match `.test.ts` literally.
    const control = (source: string) => [...source.matchAll(/from\s+['"]([^'"]+\.test\.ts)['"]/g)].map((m) => m[1]!);
    const shape = `import { listBootChecks } from './boot-check-timeout-coherence.test';`;
    expect(control(shape)).toEqual([]); // the control passes the offending line — so it is not the guard
    expect(findTestModuleImports(shape)).toEqual(['./boot-check-timeout-coherence.test']);
  });

  it('scans the files that carried the original defect (haystack positive control)', () => {
    const files = new Set(trackedTypeScriptFiles());
    expect(files.has('packages/operator-core/lib/cupboard/boot-e2e-pg-lock-guard.test.ts')).toBe(true);
    expect(files.has('apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts')).toBe(true);
    expect(files.size).toBeGreaterThan(1000);
  });

  it('no tracked TypeScript file statically imports a .test/.spec module', () => {
    const offenders: string[] = [];
    for (const rel of trackedTypeScriptFiles()) {
      let source: string;
      try {
        source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // tracked but absent in this checkout (sparse / mid-sweep) — nothing to scan
      }
      if (!source.includes('.test') && !source.includes('.spec')) continue; // cheap pre-filter
      for (const specifier of findTestModuleImports(source)) offenders.push(`${rel} → ${specifier}`);
    }
    expect(
      offenders,
      [
        'A source file imports from a .test/.spec module. Move the shared helpers into a plain module',
        '(e.g. `<name>.ts` beside the tests) and import it from BOTH files — a test file imported by',
        'another test file collects twice and registers 0 tests under a shared-fork lane',
        '(gate red 761d0a85ac, WI-212675). Offenders:',
        ...offenders.map((o) => `  ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
