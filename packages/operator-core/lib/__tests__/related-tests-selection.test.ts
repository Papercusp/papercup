import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';


import {
  RELATED_WIDEN_THRESHOLD_DEFAULT,
  RELATED_WIDEN_THRESHOLD_ENV,
  buildIndex,
  classifySpecifier,
  isTestFile,
  playwrightOwnedTest,
  pruneWithExecutedMap,
  resolveRelatedWidenThreshold,
  selectRelatedTests,
  staticImportClosure,
  transitiveDeps,
  writeRelatedFilterList,
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
      aliases: [{ prefix: '@/', target: `${ROOT}/`, wildcard: true }],
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
    expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
  });

  // P-001 (gate-latency-selection-and-retry-policy-2026-09-06): widening is a COST rule, not a
  // soundness rail. Gate run e70cd139 selected 3,849 of 6,493 operator-core files (59%) and the
  // old 0.5 default widened it to the whole lane — 2,634 unrelated files for nothing.
  it('keeps a majority-share selection RELATED under the default — 6/10 is not "everything"', () => {
    const files: Record<string, string> = {
      [`${ROOT}/hub.ts`]: 'export const hub = 1;',
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
    };
    for (let i = 0; i < 6; i++) files[`${ROOT}/hub${i}.test.ts`] = `import './hub';`;
    for (let i = 0; i < 4; i++) files[`${ROOT}/leaf${i}.test.ts`] = `import './leaf';`;

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/hub.ts`], fs: vfs(files) });

    expect(RELATED_WIDEN_THRESHOLD_DEFAULT).toBeGreaterThan(0.6);
    expect(r.mode).toBe('related');
    expect(r.selected).toHaveLength(6);
    expect(r.selected.every((f) => /hub\d\.test\.ts$/.test(f))).toBe(true);
    expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
  });

  it('honours an explicit threshold — the same 6/10 widens at 0.5', () => {
    const files: Record<string, string> = {
      [`${ROOT}/hub.ts`]: 'export const hub = 1;',
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
    };
    for (let i = 0; i < 6; i++) files[`${ROOT}/hub${i}.test.ts`] = `import './hub';`;
    for (let i = 0; i < 4; i++) files[`${ROOT}/leaf${i}.test.ts`] = `import './leaf';`;

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/hub.ts`],
      fs: vfs(files),
      threshold: 0.5,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('over-threshold(6/10)');
    expect(r.threshold).toBe(0.5);
  });
});

describe('resolveRelatedWidenThreshold (P-001)', () => {
  it('defaults when the env var is unset or blank', () => {
    expect(resolveRelatedWidenThreshold({})).toEqual({
      threshold: RELATED_WIDEN_THRESHOLD_DEFAULT,
      source: 'default',
    });
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '  ' }).source).toBe('default');
  });

  it('accepts a fraction in (0, 1] from the env', () => {
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '0.5' })).toEqual({
      threshold: 0.5,
      source: 'env',
    });
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '1' }).threshold).toBe(1);
  });

  it('REPORTS an unparseable or out-of-range value instead of silently re-widening', () => {
    for (const bad of ['abc', '0', '-0.2', '1.5', 'NaN']) {
      const r = resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: bad });
      expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
      expect(r.source).toBe('default');
      expect(r.invalid).toBe(bad);
    }
  });
});

describe('writeRelatedFilterList (P-001)', () => {
  it('writes a sorted, de-duplicated, content-addressed JSON list and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'related-filter-'));
    try {
      const a = writeRelatedFilterList(dir, ['lib/b.test.ts', 'lib\\a.test.ts', 'lib/b.test.ts']);
      expect(a.count).toBe(2);
      expect(a.path).toBe(join(dir, `related-filter-${a.digest}.json`));
      expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);

      // Same content ⇒ same file, no EEXIST escape; different content ⇒ a different digest.
      const again = writeRelatedFilterList(dir, ['lib/a.test.ts', 'lib/b.test.ts']);
      expect(again.path).toBe(a.path);
      const other = writeRelatedFilterList(dir, ['lib/c.test.ts']);
      expect(other.digest).not.toBe(a.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * WI-10007002: tsconfig `paths` resolve the way TypeScript resolves them — an EXACT key by
 * equality only, otherwise the LONGEST wildcard prefix — independent of declaration order. The
 * retired resolver flattened every key into a prefix map and took the FIRST prefix that matched,
 * so an exact key could capture a longer specifier and a short wildcard could shadow a longer
 * one, depending purely on the order the tsconfig happened to declare them.
 */
describe('tsconfig paths resolution — exact key first, then the longest wildcard (WI-10007002)', () => {
  const FILES = {
    [`${ROOT}/cfg/index.ts`]: 'export const cfg = 1;', // exact `#cfg`
    [`${ROOT}/cfg/util.ts`]: 'export const util = 1;', // wildcard `#cfg/*`
    [`${ROOT}/env.real.ts`]: 'export const env = 1;', // exact `@/env`
    [`${ROOT}/env.ts`]: 'export const decoy = 1;', // what `@/*` alone would give `@/env`
    [`${ROOT}/other/deep/a.ts`]: 'export const a = 1;', // longest wildcard `@/deep/*`
    [`${ROOT}/deep/a.ts`]: 'export const decoy = 1;', // what `@/*` alone would give `@/deep/a`
    [`${ROOT}/importer.ts`]: `import '#cfg/util'; import '#cfg'; import '@/env'; import '@/deep/a';`,
  };
  const ENTRIES = [
    { prefix: '#cfg', target: `${ROOT}/cfg/index.ts`, wildcard: false },
    { prefix: '#cfg/', target: `${ROOT}/cfg/`, wildcard: true },
    { prefix: '@/', target: `${ROOT}/`, wildcard: true },
    { prefix: '@/env', target: `${ROOT}/env.real.ts`, wildcard: false },
    { prefix: '@/deep/', target: `${ROOT}/other/deep/`, wildcard: true },
  ];
  const ORDERS = [
    ['declared order', ENTRIES],
    ['reversed order', [...ENTRIES].reverse()],
  ] as const;
  const EXPECTED = [`${ROOT}/cfg/index.ts`, `${ROOT}/cfg/util.ts`, `${ROOT}/env.real.ts`, `${ROOT}/other/deep/a.ts`];

  for (const [label, aliases] of ORDERS) {
    it(`buildIndex resolves every key to its TypeScript target (${label})`, () => {
      const index = buildIndex({ rootDir: ROOT, aliases: [...aliases], fs: vfs(FILES) });
      expect([...(index.deps.get(`${ROOT}/importer.ts`) ?? [])].sort()).toEqual(EXPECTED);
      expect(index.unresolved.has(`${ROOT}/importer.ts`)).toBe(false);
    });

    it(`staticImportClosure reaches exactly the TypeScript targets (${label})`, () => {
      const r = staticImportClosure({
        rootDir: ROOT,
        entryFiles: [`${ROOT}/importer.ts`],
        aliases: [...aliases],
        fs: vfs(FILES),
      });
      expect(r.unresolved).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.files).toEqual([...EXPECTED, `${ROOT}/importer.ts`].sort());
    });

    it(`selectRelatedTests selects the test importing an exact key's target (${label})`, () => {
      const fs = vfs({
        ...FILES,
        [`${ROOT}/env.test.ts`]: `import '@/env';`,
        [`${ROOT}/decoy.test.ts`]: `import './env';`,
      });
      const r = selectRelatedTests({
        rootDir: ROOT,
        changedPaths: [`${ROOT}/env.real.ts`],
        aliases: [...aliases],
        fs,
      });
      expect(r.mode).toBe('related');
      expect(r.selected).toEqual([`${ROOT}/env.test.ts`]);
    });
  }

  it('CONTROL: the retired flattened first-match resolver misresolves this fixture, so the cases above can fail', () => {
    // A faithful copy of the pre-fix resolver: every key flattened to `prefix → dir/`, first match wins.
    const flattened = Object.fromEntries(
      ENTRIES.map(({ prefix, target }) => [prefix, target.endsWith('/') ? target : `${target}/`]),
    );
    const firstMatch = (spec: string) => {
      const p = Object.keys(flattened).find((k) => spec === k || spec.startsWith(k));
      return p === undefined ? null : join(flattened[p], spec.slice(p.length));
    };
    expect(firstMatch('#cfg/util')).toBe(`${ROOT}/cfg/index.ts/util`); // exact key captured by prefix
    expect(firstMatch('@/env')).toBe(`${ROOT}/env`); // short wildcard shadows the exact key → env.ts decoy
    expect(firstMatch('@/deep/a')).toBe(`${ROOT}/deep/a`); // short wildcard shadows the longer one → decoy
  });

  it('refuses the retired prefix-map shape loudly instead of resolving nothing', () => {
    const legacy = { '@/': `${ROOT}/` } as unknown as never;
    expect(() => buildIndex({ rootDir: ROOT, aliases: legacy, fs: vfs(FILES) })).toThrow(TypeError);
    expect(() =>
      staticImportClosure({ rootDir: ROOT, entryFiles: [`${ROOT}/importer.ts`], aliases: legacy, fs: vfs(FILES) }),
    ).toThrow(/tsconfigPathEntriesFor/);
  });
});

describe('transitiveDeps', () => {
  it('returns the same complete closure for every entry point through an import cycle', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import './b'; import './left';`,
      [`${ROOT}/b.ts`]: `import './a'; import './right';`,
      [`${ROOT}/left.ts`]: 'export const left = 1;',
      [`${ROOT}/right.ts`]: 'export const right = 1;',
    });
    const index = buildIndex({ rootDir: ROOT, fs });

    // Prime through A first. The former stack-guarded memoization cached B's
    // partial closure at this point and permanently omitted left.ts from B.
    const aFirst = transitiveDeps(index);
    expect([...aFirst(`${ROOT}/a.ts`)].sort()).toEqual(
      [`${ROOT}/b.ts`, `${ROOT}/left.ts`, `${ROOT}/right.ts`].sort(),
    );
    expect([...aFirst(`${ROOT}/b.ts`)].sort()).toEqual(
      [`${ROOT}/a.ts`, `${ROOT}/left.ts`, `${ROOT}/right.ts`].sort(),
    );

    // A fresh resolver primed through B must produce the identical B closure.
    const bFirst = transitiveDeps(index);
    expect([...bFirst(`${ROOT}/b.ts`)].sort()).toEqual([...aFirst(`${ROOT}/b.ts`)].sort());
  });

  it('does not let removing an import edge enlarge a later closure', () => {
    const indexWithEdge = buildIndex({
      rootDir: ROOT,
      fs: vfs({
        [`${ROOT}/a.ts`]: `import './b'; import './c';`,
        [`${ROOT}/b.ts`]: `import './a';`,
        [`${ROOT}/c.ts`]: 'export const c = 1;',
      }),
    });
    const indexWithoutEdge = buildIndex({
      rootDir: ROOT,
      fs: vfs({
        [`${ROOT}/a.ts`]: `import './c';`,
        [`${ROOT}/b.ts`]: `import './a';`,
        [`${ROOT}/c.ts`]: 'export const c = 1;',
      }),
    });

    const closureForB = (index: ReturnType<typeof buildIndex>) => {
      const reach = transitiveDeps(index);
      // Prime both resolvers through A first, matching the batch measurement that
      // exposed the old traversal-order-dependent cache. With the former DFS,
      // the A↔B cycle cached B as only {A}; removing A→B then made B incorrectly
      // GROW to {A,C}. Exact SCC reachability returns {A,C} in both graphs.
      reach(`${ROOT}/a.ts`);
      return [...reach(`${ROOT}/b.ts`)].sort();
    };

    const withEdge = closureForB(indexWithEdge);
    const withoutEdge = closureForB(indexWithoutEdge);
    expect(withEdge).toEqual([`${ROOT}/a.ts`, `${ROOT}/c.ts`].sort());
    expect(withoutEdge).toEqual(withEdge);
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

/**
 * EI-21440128879545486. A selection is narrowed only into VITEST lanes, so a test some other
 * RUNNER owns can never execute there — it reaches vitest as a positional filter matching
 * nothing, and the router refuses the whole partial-match run rather than false-greening it.
 * The task then reds with ZERO attributable test files: no `test_runs` fail rows to triage and
 * nothing for the gate's isolation re-run to isolate. Two Playwright specs entering the
 * `@papercusp/web :: test` selection that way red-pinned green-checkpoint and froze `main`.
 *
 * The discriminator under test is RUNNER OWNERSHIP, never the file extension — `.spec.ts` is a
 * legitimate VITEST include in search-core and the three papergrid packages, and excluding
 * those would silently shrink real runs, which is the failure this whole file guards against.
 */
describe('playwrightOwnedTest — ownership by runner, not by extension', () => {
  const PW_CONFIG = `
    import { defineConfig } from '@playwright/test';
    export default defineConfig({
      testDir: './e2e',
      testMatch: /.*\\.spec\\.ts$/,
    });
  `;

  /** A reader over a virtual workspace; anything unlisted throws, as the real fs does. */
  const reader = (files: Record<string, string>) => (p: string) => {
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  };

  const owned = (files: Record<string, string>) =>
    playwrightOwnedTest('/ws', { readFile: reader(files) });

  it('claims a Playwright spec inside the declared testDir', () => {
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/e2e/docs-routes.spec.ts')).toBe(
      true,
    );
  });

  it('leaves a vitest .test.ts in the same workspace alone', () => {
    const isOwned = owned({ '/ws/playwright.config.ts': PW_CONFIG });
    expect(isOwned('/ws/lib/thing.test.ts')).toBe(false);
    expect(isOwned('/ws/e2e/helper.test.ts')).toBe(false);
  });

  it('leaves a .spec.ts OUTSIDE testDir alone — it is a real vitest include elsewhere', () => {
    // search-core / papergrid ship `src/**/*.spec.ts` as their VITEST include. Claiming these
    // would drop real tests from the run and certify code nothing exercised.
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/src/query.spec.ts')).toBe(false);
  });

  it('never claims a testDir PREFIX match (e2e-utils/ is not e2e/)', () => {
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/e2e-utils/a.spec.ts')).toBe(false);
  });

  it('owns nothing when the workspace has no Playwright config', () => {
    expect(owned({})('/ws/src/query.spec.ts')).toBe(false);
    expect(owned({})('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('owns nothing when the config parses to no declaration — the failure stays LOUD', () => {
    // Fail-safe direction: withholding nothing means a genuine mismatch still reds the gate
    // naming the file, instead of a test silently disappearing from the run.
    const noDecl = owned({ '/ws/playwright.config.ts': 'export default defineConfig({});' });
    expect(noDecl('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('follows testDir when it moves — derived from the config, not a hardcoded e2e/ glob', () => {
    const moved = owned({
      '/ws/playwright.config.ts': PW_CONFIG.replace("'./e2e'", "'./browser-tests'"),
    });
    expect(moved('/ws/browser-tests/docs-routes.spec.ts')).toBe(true);
    expect(moved('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('is stateless across calls even if the config regex carries /g', () => {
    // A surviving `lastIndex` would make identical calls alternate true/false.
    const g = owned({ '/ws/playwright.config.ts': PW_CONFIG.replace('$/,', '$/g,') });
    const file = '/ws/e2e/docs-routes.spec.ts';
    expect([g(file), g(file), g(file)]).toEqual([true, true, true]);
  });
});

describe('playwrightOwnedTest — against the real repository tree', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const OPERATOR = join(REPO_ROOT, 'apps/operator');

  it('claims every Playwright spec in apps/operator and no vitest test', () => {
    const isOwned = playwrightOwnedTest(OPERATOR);
    const e2eDir = join(OPERATOR, 'e2e');
    const specs = readdirSync(e2eDir).filter((n) => n.endsWith('.spec.ts'));

    // Positive control: an empty list would make the "claims all" assertion vacuously true.
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((n) => !isOwned(join(e2eDir, n)))).toEqual([]);

    // The two specs that actually red-pinned the gate.
    expect(isOwned(join(e2eDir, 'design-dashboard-flow.spec.ts'))).toBe(true);
    expect(isOwned(join(e2eDir, 'docs-routes.spec.ts'))).toBe(true);

    // Negative control: vitest files in the same workspace must survive selection.
    expect(isOwned(join(OPERATOR, 'lib/sync-sse.test.ts'))).toBe(false);
    expect(isOwned(join(OPERATOR, 'vitest.config.ts'))).toBe(false);
  });
});

/**
 * Executed-source pruning (gate-latency-selection-and-retry-policy-2026-09-06, P-002).
 *
 * The static closure is the SUPERSET; a recorded map of what a test actually executed may
 * only REMOVE tests from it, and only when the map is provably current. Every rail below
 * is asserted in the fail-safe direction: a question the rule cannot answer keeps the test.
 */
describe('selectRelatedTests — executed-source pruning (P-002)', () => {
  const JUDGED = 'judged00000000000000000000000000000000000';
  const OLDER = 'older000000000000000000000000000000000000';
  const leaf = `${ROOT}/leaf.ts`;
  const hub = `${ROOT}/hub.ts`;
  const other = `${ROOT}/other.ts`;
  const tests = ['a', 'b', 'c', 'd', 'e'].map((n) => `${ROOT}/${n}.test.ts`);
  const [a, b, c, d, e] = tests;

  /** leaf changed; hub re-exports it; five tests import hub; three unrelated tests pad the suite. */
  function hubFs() {
    return vfs({
      [leaf]: 'export const leaf = 1;',
      [other]: 'export const other = 2;',
      [hub]: `export * from './leaf'; export * from './other';`,
      ...Object.fromEntries(tests.map((t) => [t, `import './hub';`])),
      [`${ROOT}/u1.test.ts`]: `import './other';`,
      [`${ROOT}/u2.test.ts`]: `import './other';`,
      [`${ROOT}/u3.test.ts`]: `import './other';`,
    });
  }
  const entry = (self: string, executed: string[], recordedSha = JUDGED) => ({
    recordedSha,
    executed: new Set([self, ...executed]),
  });
  const fresh = () => () => [] as string[];

  it('prunes a test whose current map never executed the change and keeps one whose map did', () => {
    const executedMap = new Map([
      [a, entry(a, [hub, other])], // reached leaf statically through the hub, never executed it
      [b, entry(b, [hub, other, leaf])], // executed the change
    ]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([b, c, d, e]);
    expect(r.executedMap.applied).toBe(true);
    expect(r.executedMap.pruned).toBe(1);
    expect(r.executedMap.kept.intersects).toBe(1);
    // c, d, e have no entry: the static rail keeps them and the summary says so.
    expect(r.executedMap.kept.noEntry).toBe(3);
  });

  it('keeps a test whose closure drifted since its map was recorded (stale map), prunes one whose closure did not', () => {
    const executedMap = new Map([
      [a, entry(a, [hub, other], OLDER)],
      [b, entry(b, [hub, other], OLDER)],
    ]);
    // Between OLDER and JUDGED, hub.ts changed — inside a's and b's closure — so both maps are
    // stale and both tests stay, even though neither recorded set touches leaf.
    const r1 = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: (from, to) => (from === OLDER && to === JUDGED ? [hub] : null),
    });
    expect(r1.selected).toContain(a);
    expect(r1.selected).toContain(b);
    expect(r1.executedMap.kept.stale).toBe(2);
    expect(r1.executedMap.pruned).toBe(0);

    // Drift OUTSIDE the closure (an unrelated file) does not stale the map: both prune.
    const r2 = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: () => [`${ROOT}/u1.test.ts`],
    });
    expect(r2.selected).toEqual([c, d, e]);
    expect(r2.executedMap.pruned).toBe(2);
  });

  it('keeps a test when the drift between recorded and judged sha cannot be determined', () => {
    const executedMap = new Map([[a, entry(a, [hub, other], OLDER)]]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: () => null,
    });
    expect(r.selected).toContain(a);
    expect(r.executedMap.kept.unknownDrift).toBe(1);
    expect(r.executedMap.pruned).toBe(0);
  });

  it('does not trust an entry that omits the test file itself, or an empty one', () => {
    const executedMap = new Map([
      [a, { recordedSha: JUDGED, executed: new Set([hub, other]) }], // no self
      [b, { recordedSha: JUDGED, executed: new Set<string>() }],
    ]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.selected).toContain(a);
    expect(r.selected).toContain(b);
    expect(r.executedMap.kept.untrusted).toBe(2);
  });

  it('always runs a changed test file, whatever its map says', () => {
    const executedMap = new Map([[a, entry(a, [hub, other])]]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [a],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.selected).toEqual([a]);
    expect(r.executedMap.kept.changedTest).toBe(1);
  });

  it('refuses to narrow the selection to nothing: the static selection stands', () => {
    const executedMap = new Map(tests.map((t) => [t, entry(t, [hub, other])]));
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual(tests);
    expect(r.executedMap.wouldEmpty).toBe(true);
    expect(r.executedMap.pruned).toBe(0);
    expect(r.executedMap.prunable).toBe(5);
  });

  it('is inert — and says why — without a map, a judged sha, or a drift seam', () => {
    const executedMap = new Map([[a, entry(a, [hub, other])]]);
    const base = { rootDir: ROOT, changedPaths: [leaf], fs: hubFs() };
    const noMap = selectRelatedTests({ ...base, judgedSha: JUDGED, changedBetween: fresh() });
    const noSha = selectRelatedTests({ ...base, executedMap, changedBetween: fresh() });
    const noSeam = selectRelatedTests({ ...base, executedMap, judgedSha: JUDGED });
    for (const r of [noMap, noSha, noSeam]) {
      expect(r.selected).toEqual(tests);
      expect(r.executedMap.applied).toBe(false);
    }
    expect(noMap.executedMap.reason).toBe('no-map');
    expect(noSha.executedMap.reason).toBe('no-judged-sha');
    expect(noSeam.executedMap.reason).toBe('no-drift-seam');
    // The default call shape is unchanged in outcome AND still reports the summary.
    const plain = selectRelatedTests(base);
    expect(plain.selected).toEqual(tests);
    expect(plain.executedMap).toMatchObject({ applied: false, reason: 'no-map' });
  });

  it('reports the summary on every full-mode return path too', () => {
    const noTests = selectRelatedTests({ rootDir: ROOT, changedPaths: [leaf], fs: vfs({ [leaf]: '' }) });
    expect(noTests.reason).toBe('no-test-files');
    expect(noTests.executedMap.applied).toBe(false);
    const outOfScope = selectRelatedTests({ rootDir: ROOT, changedPaths: ['/elsewhere/x.ts'], fs: hubFs() });
    expect(outOfScope.reason).toBe('no-changed-paths-in-scope');
    expect(outOfScope.executedMap.applied).toBe(false);
  });

  it('applies the widening threshold to the PRUNED selection', () => {
    // Statically 5/8 selected — over a 0.6 threshold, so unpruned this widens to full.
    const executedMap = new Map([[a, entry(a, [hub, other])], [b, entry(b, [hub, other])]]);
    const wide = selectRelatedTests({ rootDir: ROOT, changedPaths: [leaf], fs: hubFs(), threshold: 0.6 });
    expect(wide.mode).toBe('full');
    const narrowed = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      threshold: 0.6,
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(narrowed.mode).toBe('related');
    expect(narrowed.selected).toEqual([c, d, e]);
  });

  it('pruneWithExecutedMap keeps a graph hole (unresolved import) whatever the map says', () => {
    const selected = new Set([a, b]);
    const { selected: kept, summary } = pruneWithExecutedMap({
      selected,
      changedSet: new Set([leaf]),
      reach: () => new Set([hub, leaf, other]),
      unresolved: new Set([a]),
      executedMap: new Map([[a, entry(a, [hub])], [b, entry(b, [hub])]]),
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect([...kept]).toEqual([a]);
    expect(summary.kept.unresolved).toBe(1);
    expect(summary.pruned).toBe(1);
  });

  it('pruneWithExecutedMap caches the drift lookup per recorded sha and survives a throwing seam', () => {
    let calls = 0;
    const { summary } = pruneWithExecutedMap({
      selected: new Set([a, b, c]),
      changedSet: new Set([leaf]),
      reach: () => new Set([hub, leaf, other]),
      unresolved: new Set(),
      executedMap: new Map([
        [a, entry(a, [hub], OLDER)],
        [b, entry(b, [hub], OLDER)],
        [c, entry(c, [hub], 'third0000000000000000000000000000000000000')],
      ]),
      judgedSha: JUDGED,
      changedBetween: (from) => {
        calls += 1;
        if (from === OLDER) return [];
        throw new Error('unknown sha');
      },
    });
    expect(calls).toBe(2); // OLDER once (cached for b), the throwing sha once
    expect(summary.pruned).toBe(2);
    expect(summary.kept.unknownDrift).toBe(1);
  });
});
