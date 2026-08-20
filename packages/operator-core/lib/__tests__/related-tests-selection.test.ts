import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildIndex,
  classifySpecifier,
  isTestFile,
  selectRelatedTests,
} from '../../../../scripts/lib/related-tests.mjs';

/**
 * Import-graph test selection (file-level-test-selection-2026-08-17).
 *
 * The engine decides which tests a change can affect. Its dangerous failure is not
 * "ran too many tests" — that only costs minutes — it is "ran too few and reported
 * green", which certifies code nothing exercised. So every rail below asserts the
 * FAIL-SAFE direction: anything the graph cannot answer confidently must widen to
 * the full suite rather than narrow.
 *
 * A virtual filesystem keeps these deterministic and sub-millisecond; the real
 * indexer is exercised against the actual tree by `--related`'s own dry-run.
 */

const ROOT = '/repo/lib';
const BLUEPRINT_STEPS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'blueprint-steps');

/** Build a fake fs from a { path: contents } map. */
function vfs(files: Record<string, string>) {
  const names = Object.keys(files);
  return {
    list: (dir: string) => names.filter((n) => n.startsWith(dir + '/')),
    read: (p: string) => (p in files ? files[p] : null),
    exists: (p: string) => p in files,
  };
}

describe('classifySpecifier', () => {
  it('separates relative, alias and bare specifiers', () => {
    expect(classifySpecifier('./sibling')).toBe('relative');
    expect(classifySpecifier('../up')).toBe('relative');
    expect(classifySpecifier('@/app/thing')).toBe('alias');
    expect(classifySpecifier('#internal')).toBe('alias');
    // Bare is deliberately OUT of graph: cross-package effects are covered by
    // workspace-level selection, not this index.
    expect(classifySpecifier('node:fs')).toBe('bare');
    expect(classifySpecifier('vitest')).toBe('bare');
    expect(classifySpecifier('@papercusp/operator-core')).toBe('bare');
  });
});

describe('isTestFile', () => {
  it('recognises the suffixes vitest collects, and nothing else', () => {
    expect(isTestFile('/a/b.test.ts')).toBe(true);
    expect(isTestFile('/a/b.test.tsx')).toBe(true);
    expect(isTestFile('/a/b.spec.ts')).toBe(true);
    expect(isTestFile('/a/b.ts')).toBe(false);
    // The positive control for the negative case: a file merely CONTAINING "test".
    expect(isTestFile('/a/tested-thing.ts')).toBe(false);
  });
});

describe('selectRelatedTests — narrowing', () => {
  it('selects only the test that transitively imports the changed file', () => {
    const fs = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/mid.ts`]: `import { leaf } from './leaf';`,
      [`${ROOT}/uses-leaf.test.ts`]: `import './mid';`,
      [`${ROOT}/unrelated.ts`]: 'export const other = 2;',
      [`${ROOT}/unrelated.test.ts`]: `import './unrelated';`,
      [`${ROOT}/also-unrelated.test.ts`]: `import './unrelated';`,
      [`${ROOT}/third.test.ts`]: `import './unrelated';`,
      [`${ROOT}/fourth.test.ts`]: `import './unrelated';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/leaf.ts`],
      fs,
    });

    expect(r.mode).toBe('related');
    // Transitive: leaf <- mid <- uses-leaf.test.ts
    expect(r.selected).toEqual([`${ROOT}/uses-leaf.test.ts`]);
    expect(r.total).toBe(5);
  });

  it('always selects a changed TEST file itself, even when nothing imports it', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: 'export const a = 1;',
      [`${ROOT}/orphan.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/b.test.ts`]: `import './a';`,
      [`${ROOT}/c.test.ts`]: `import './a';`,
      [`${ROOT}/d.test.ts`]: `import './a';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/orphan.test.ts`],
      fs,
    });

    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/orphan.test.ts`]);
  });

  it('follows alias specifiers when a mapping is supplied', () => {
    const fs = vfs({
      [`${ROOT}/app/target.ts`]: 'export const t = 1;',
      [`${ROOT}/aliased.test.ts`]: `import '@/app/target';`,
      [`${ROOT}/x.ts`]: 'export const x = 1;',
      [`${ROOT}/p.test.ts`]: `import './x';`,
      [`${ROOT}/q.test.ts`]: `import './x';`,
      [`${ROOT}/r.test.ts`]: `import './x';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/app/target.ts`],
      aliases: { '@/': `${ROOT}/` },
      fs,
    });

    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/aliased.test.ts`]);
  });
});

describe('selectRelatedTests — every rail fails toward running MORE tests', () => {
  it('falls back to the full suite when an intra-repo import cannot be resolved', () => {
    // `@/missing` has no alias mapping, so the graph has a HOLE. The safe reading of
    // a hole is "this test might reach the change", not "it does not".
    const fs = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/hole.test.ts`]: `import '@/missing/thing';`,
      [`${ROOT}/other.test.ts`]: `import './leaf';`,
    });

    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.has(`${ROOT}/hole.test.ts`)).toBe(true);

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/leaf.ts`],
      fs,
    });

    // Both tests selected => 2/2 is over threshold => full suite. The hole widened
    // the selection rather than narrowing it, which is the whole point.
    expect(r.mode).toBe('full');
  });

  it('runs everything when the change is outside the indexed root', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: 'export const a = 1;',
      [`${ROOT}/a.test.ts`]: `import './a';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: ['/repo/other-package/lib/z.ts'],
      fs,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('no-changed-paths-in-scope');
  });

  it('runs everything when an in-scope change reaches NO test (a graph gap, not proof of no coverage)', () => {
    const fs = vfs({
      [`${ROOT}/lonely.ts`]: 'export const l = 1;',
      [`${ROOT}/a.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/b.test.ts`]: 'expect(1).toBe(1);',
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/lonely.ts`],
      fs,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('empty-selection');
  });

  it('runs everything when selection exceeds the threshold — a barrel change buys nothing', () => {
    // The measured reality in operator-core: a barrel is imported by most tests, so
    // "related" degenerates to "everything" and the subset is pure overhead.
    const files: Record<string, string> = {
      [`${ROOT}/core.ts`]: 'export const core = 1;',
      [`${ROOT}/barrel.ts`]: `export * from './core';`,
    };
    for (let i = 0; i < 10; i++) files[`${ROOT}/t${i}.test.ts`] = `import './barrel';`;

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/core.ts`], fs: vfs(files) });

    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/^over-threshold\(10\/10\)$/);
  });

  it('treats an unreadable file as unknown-dependency rather than dependency-free', () => {
    const base = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/unreadable.test.ts`]: 'x',
      [`${ROOT}/plain.test.ts`]: `import './leaf';`,
    });
    const fs = {
      ...base,
      read: (p: string) => (p.endsWith('unreadable.test.ts') ? null : base.read(p)),
    };

    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.has(`${ROOT}/unreadable.test.ts`)).toBe(true);
  });

  it('reports full (never a vacuous empty pass) when the root holds no tests at all', () => {
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/a.ts`],
      fs: vfs({ [`${ROOT}/a.ts`]: 'export const a = 1;' }),
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('no-test-files');
    expect(r.selected).toEqual([]);
  });
});

describe('buildIndex', () => {
  it('does not follow bare specifiers into the graph', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import 'node:fs'; import 'vitest'; import '@papercusp/operator-core';`,
    });
    const index = buildIndex({ rootDir: ROOT, fs });

    expect(index.deps.get(`${ROOT}/a.ts`)?.size).toBe(0);
    // …and a bare specifier is NOT an unresolved hole — it is deliberately out of scope.
    expect(index.unresolved.has(`${ROOT}/a.ts`)).toBe(false);
  });

  it('survives an import cycle instead of hanging', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import './b';`,
      [`${ROOT}/b.ts`]: `import './a';`,
      [`${ROOT}/a.test.ts`]: `import './a';`,
      [`${ROOT}/x.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/y.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/z.test.ts`]: 'expect(1).toBe(1);',
    });

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/b.ts`], fs });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/a.test.ts`]);
  });
});

describe('repository test import surfaces', () => {
  it('keeps single-blueprint tests on their leaf registration op instead of the all-ops barrel', () => {
    const singleBlueprintTests = readdirSync(BLUEPRINT_STEPS_DIR)
      .filter(
        (name) =>
          name.endsWith('-blueprint.test.ts') || name === 'negative-space-marketplace-roundtrip.test.ts',
      )
      .sort();

    const barrelImporters = singleBlueprintTests.filter((name) => {
      const source = readFileSync(join(BLUEPRINT_STEPS_DIR, name), 'utf8');
      return /(?:import|from)\s+['"]\.\/index(?:\.js)?['"]/.test(source);
    });

    // These tests each import their one ./ops/* module already, which registers
    // the op under test. Pulling ./index.js as well eagerly registers every other
    // deterministic op and turns a leaf test into a 1,000+ source graph hub.
    // Whole-registry invariant tests have different names and intentionally keep
    // the barrel; this guard targets only the single-blueprint contract tests.
    expect(singleBlueprintTests.length).toBeGreaterThan(0);
    expect(barrelImporters).toEqual([]);
  });
});
