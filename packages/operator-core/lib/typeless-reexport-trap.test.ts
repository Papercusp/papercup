/**
 * Guard for EI-19306560664954248 — a TYPELESS workspace package that gains an
 * `export … from` re-export chain links an EMPTY namespace under tsx, because Node resolves
 * named imports of a CJS module via cjs-module-lexer, which cannot follow re-export chains.
 * Every named import of that package then throws at runtime — including imports of symbols
 * that are NOT re-exported and worked yesterday.
 *
 * This file is also the GATING mechanism for `npm run lint:typeless-reexport`: the checker is
 * a root script, and root scripts route to @papercusp/operator-core for affected-test
 * selection (EI-19346163916263067), so running it here is what puts it in front of the green
 * checkpoint.
 *
 * Two layers on purpose:
 *   1. the pure analyzer against SYNTHETIC fixtures — proves the guard has TEETH. A guard
 *      whose only evidence is "0 violations on a tree that has 0 violations" proves nothing;
 *      it would pass just as happily with its condition inverted.
 *   2. the live tree — the actual invariant we are protecting.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeTypelessReexportTrap,
  countReexportChains,
  namedImportedPackages,
  scanWorkspace,
  LINKED_EXT,
  SOURCE_SKIP_DIR,
  ALLOW,
} from '../../../scripts/check-typeless-reexport-trap.mjs';

type Imp = { pkg: string; file: string; linked: boolean };
const trap = { name: '@x/trap', dir: 'p/trap', isEsm: false, reexportChains: 3, namedImports: [] };
const consumer = (namedImports: Imp[], isEsm = true) => ({
  name: '@x/consumer',
  dir: 'p/consumer',
  isEsm,
  reexportChains: 0,
  namedImports,
});

describe('typeless re-export trap: the analyzer has teeth (EI-19306560664954248)', () => {
  it('FIRES on the exact shape that broke @papercusp/rerank live', () => {
    // typeless target + re-export chain + ESM consumer named-importing it from a .ts.
    const v = analyzeTypelessReexportTrap([
      trap,
      consumer([{ pkg: '@x/trap', file: 'src/a.ts', linked: true }]),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].pkg).toBe('@x/trap');
    expect(v[0].consumers[0].file).toBe('src/a.ts');
  });

  it('is SILENT when the consumer is .tsx — bundled by Vite, so the lexer never runs', () => {
    // This is not a nicety: it is why git-graph / ui-primitives / papergrid are correctly
    // quiet. A guard that shouted about those three would be ignored, and would then miss
    // the real one.
    expect(
      analyzeTypelessReexportTrap([
        trap,
        consumer([{ pkg: '@x/trap', file: 'src/a.tsx', linked: false }]),
      ]),
    ).toHaveLength(0);
  });

  it.each([
    ['the target has no re-export chain', { ...trap, reexportChains: 0 }, true],
    ['the target is already ESM', { ...trap, isEsm: true }, true],
  ])('is SILENT when %s', (_label, target, esmConsumer) => {
    expect(
      analyzeTypelessReexportTrap([
        target,
        consumer([{ pkg: '@x/trap', file: 'src/a.ts', linked: true }], esmConsumer),
      ]),
    ).toHaveLength(0);
  });

  it('is SILENT when the consumer is itself typeless (CJS throughout, no ESM link step)', () => {
    expect(
      analyzeTypelessReexportTrap([
        trap,
        consumer([{ pkg: '@x/trap', file: 'src/a.ts', linked: true }], false),
      ]),
    ).toHaveLength(0);
  });

  it('reports every distinct consumer of one trapped package', () => {
    const v = analyzeTypelessReexportTrap([
      trap,
      consumer([
        { pkg: '@x/trap', file: 'src/a.ts', linked: true },
        { pkg: '@x/trap', file: 'src/b.mts', linked: true },
      ]),
    ]);
    expect(v[0].consumers.map((c: { file: string }) => c.file)).toEqual(['src/a.ts', 'src/b.mts']);
  });
});

describe('typeless re-export trap: source-level helpers', () => {
  it('counts both re-export shapes and ignores ordinary exports', () => {
    expect(
      countReexportChains(
        [
          "export { a } from './x';",
          "export * from './y';",
          "export * as ns from './z';",
          'export const local = 1;',
          'export function f() {}',
        ].join('\n'),
      ),
    ).toBe(3);
  });

  it('matches NAMED imports only — a default/namespace import is not affected the same way', () => {
    const names = ['@x/trap'];
    expect(namedImportedPackages("import { a } from '@x/trap';", names).has('@x/trap')).toBe(true);
    expect(namedImportedPackages("import { a } from '@x/trap/sub';", names).has('@x/trap')).toBe(true);
    expect(namedImportedPackages("import t from '@x/trap';", names).has('@x/trap')).toBe(false);
    expect(namedImportedPackages("import * as t from '@x/trap';", names).has('@x/trap')).toBe(false);
  });

  it('treats .ts/.mts as linked and .tsx as bundled — the precision knob', () => {
    expect(LINKED_EXT.has('.ts')).toBe(true);
    expect(LINKED_EXT.has('.mts')).toBe(true);
    // If someone "fixes" a false negative by adding .tsx here, the three latent libs start
    // failing the gate and the allowlist grows. That is the wrong fix; this asserts it.
    expect(LINKED_EXT.has('.tsx')).toBe(false);
  });

  it('does not scan generated or static trees as workspace module source', () => {
    // These trees can hold GBs of minified/generated JS and fluctuate independently of HEAD.
    // Reading them made the live-tree guard take 40-60s and flip at the test timeout.
    expect([...SOURCE_SKIP_DIR]).toEqual(
      expect.arrayContaining(['node_modules', '.next', '.papercusp', 'public', 'target']),
    );
  });
});

describe('typeless re-export trap: the live tree', () => {
  it('has no typeless package with re-export chains named-imported by an ESM .ts/.mts module', () => {
    const violations = analyzeTypelessReexportTrap(scanWorkspace());
    expect(
      violations.map(
        (v: { pkg: string; dir: string; consumers: Array<{ pkg: string; file: string }> }) =>
          `${v.pkg} (${v.dir}) <- ${v.consumers.map((c) => c.file).join(', ')}`,
      ),
    ).toEqual([]);
  });

  it('keeps the allowlist empty — the fix is one line, so there is no standing exception', () => {
    expect([...ALLOW]).toEqual([]);
  });
});
