/**
 * module-reachability.test.ts — the MODULE axis of check-lint-guard-reachability
 * (WI-41775, plan decisions D-013 → D-014 → D-015).
 *
 * ⚠ READ THIS BEFORE TRUSTING A GREEN HERE. By the host guard's OWN doctrine, these are
 * `logic-test` tier: they feed pure helpers fixtures and prove the DETECTOR works. They
 * run the detector over nothing, so they enforce nothing. The enforcement is that
 * `check-lint-guard-reachability.mjs` calls the same helpers over the real tree on a
 * blocking green-checkpoint leg. A green file here and a rotting guard are perfectly
 * compatible states — that sentence is in the host script's header and it applies to
 * this file too.
 *
 * What these tests ARE for: pinning the two failure directions that a real-tree run
 * cannot show you, because both of them look like success.
 */
import { describe, expect, it } from 'vitest';

import {
  assessGraphHealth,
  buildImportGraph,
  findUnreachableModules,
  isTestFile,
  NEW_MODULE_GRACE_DAYS,
  parseImportSpecifiers,
  parseReleasePathMentions,
  partitionByGracePeriod,
  resolveSpecifier,
  selectDetectorModules,
  selfExclusionPaths,
} from '../../../../scripts/lib/module-reachability.mjs';

const GUARD = 'scripts/check-lint-guard-reachability.mjs';
const DETECTOR = 'apps/operator/lib/release/prompt-divergence.ts';
const DETECTOR_TEST = 'apps/operator/lib/release/prompt-divergence.test.ts';

describe('selectDetectorModules', () => {
  it('takes lib/release sources and excludes tests, declarations and other trees', () => {
    const files = [
      DETECTOR,
      DETECTOR_TEST,
      'packages/operator-core/lib/release/external-prerequisites.ts',
      'packages/operator-core/lib/release/thing.d.ts',
      'packages/operator-core/lib/harness/unrelated.ts',
      'scripts/lib/module-reachability.mjs',
    ];
    expect(selectDetectorModules(files)).toEqual([
      DETECTOR,
      'packages/operator-core/lib/release/external-prerequisites.ts',
    ]);
  });
});

describe('parseImportSpecifiers', () => {
  it('finds static, side-effect, re-export, dynamic and require forms', () => {
    const text = [
      "import { a } from './static';",
      "import './side-effect';",
      "export { b } from './re-export';",
      "const c = await import('./dynamic');",
      "const d = require('./required');",
    ].join('\n');
    expect(parseImportSpecifiers(text).sort()).toEqual([
      './dynamic',
      './re-export',
      './required',
      './side-effect',
      './static',
    ]);
  });
});

describe('resolveSpecifier', () => {
  const fileSet = new Set([
    'apps/operator/lib/release/target.ts',
    'packages/operator-core/lib/release/pkg-target.ts',
    'apps/operator/lib/release/dir/index.ts',
  ]);
  const workspaceDirByName = new Map([['@papercusp/operator-core', 'packages/operator-core']]);

  it('resolves a relative specifier', () => {
    expect(
      resolveSpecifier({ specifier: './target', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/target.ts');
  });

  it("resolves NodeNext's ./x.js spelling of a TypeScript ./x.ts", () => {
    // Missing this under-counts importers, i.e. reports a LIVE module as dead — the
    // false-positive direction that would red-pin the gate on a healthy tree.
    expect(
      resolveSpecifier({ specifier: './target.js', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/target.ts');
  });

  it('resolves a workspace package subpath and a directory index', () => {
    expect(
      resolveSpecifier({
        specifier: '@papercusp/operator-core/lib/release/pkg-target',
        fromFile: DETECTOR,
        fileSet,
        workspaceDirByName,
      }),
    ).toBe('packages/operator-core/lib/release/pkg-target.ts');
    expect(
      resolveSpecifier({ specifier: './dir', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/dir/index.ts');
  });

  it('returns null for anything outside the repo', () => {
    for (const specifier of ['node:fs', 'vitest', '@some/external']) {
      expect(resolveSpecifier({ specifier, fromFile: DETECTOR, fileSet, workspaceDirByName })).toBeNull();
    }
  });
});

describe('findUnreachableModules', () => {
  it('CALIBRATION: a module with a real production importer is alive', () => {
    // Without this control, every other expectation below is also satisfied by a probe
    // that simply calls everything dead.
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set(['apps/operator/lib/release/green-checkpoint.ts'])]]),
    });
    expect(rows[0].dead).toBe(false);
  });

  it('THE CLASS: a module imported ONLY by its own test is dead, and flagged tested-but-unwired', () => {
    // This is the case knip cannot see: test files are entry points to knip, so the
    // test import reads as usage and the module is reported fully used (D-015 §4).
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
    });
    expect(rows[0].dead).toBe(true);
    expect(rows[0].testedButUnwired).toBe(true);
    expect(rows[0].testImporters).toEqual([DETECTOR_TEST]);
  });

  it('kills a module kept alive only by another DEAD module (transitive, no root set)', () => {
    const a = 'apps/operator/lib/release/a.ts';
    const b = 'apps/operator/lib/release/b.ts';
    const { rows, rounds } = findUnreachableModules({
      population: [a, b],
      // b imports a; nothing imports b. One pass kills b, the next kills a.
      importers: new Map([[a, new Set([b])]]),
    });
    expect(rows.every((r) => r.dead)).toBe(true);
    expect(rounds).toBeGreaterThan(1);
    // The distinction survives into the row: "imported only by something dead" and
    // "imported by nothing" are different findings for whoever triages them.
    expect(rows.find((r) => r.module === a)!.productionImporters).toEqual([b]);
  });

  it('treats a literal path mention as execution, so an entry point is not reported dead', () => {
    // A gate entry is spawned by path, never imported. Without this, every entry module
    // in the population would be a false positive.
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map(),
      pathMentions: new Map([[DETECTOR, new Set(['apps/operator/lib/release/routine.ts'])]]),
    });
    expect(rows[0].dead).toBe(false);
  });

  it('REGRESSION: the instrument must not resurrect a module by NAMING it in its allowlist', () => {
    // Measured 2026-08-26 during bring-up. The guard's acknowledged-unreachable
    // allowlist is a list of lib/release paths, and the mention scan reads a literal
    // path as execution evidence — so the first wired run reported ALL 21 known-dead
    // modules alive, each with exactly one "production importer": the guard itself.
    //
    // It failed GREEN. An empty finding set and a passing watermark are indistinguishable
    // from a clean tree, so the guard would have measured nothing forever while looking
    // like diligence. Same remedy as scripts/proc-guard.mjs excluding its own ancestors.
    const mentions = new Map([[DETECTOR, new Set([GUARD])]]);

    const unguarded = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
      pathMentions: mentions,
    });
    // The defect, reproduced: without the exclusion the module reads as alive.
    expect(unguarded.rows[0].dead).toBe(false);

    const guarded = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
      pathMentions: mentions,
      excludeReachers: new Set([GUARD]),
    });
    expect(guarded.rows[0].dead).toBe(true);
    expect(guarded.rows[0].testedButUnwired).toBe(true);
  });
});

describe('selfExclusionPaths', () => {
  it('derives the probe path from import.meta.url, not a hardcoded string', () => {
    // Hardcoding it would let a rename silently re-open the self-observation hole.
    const paths = [...selfExclusionPaths('/repo/root')];
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith('scripts/lib/module-reachability.mjs')).toBe(true);
    expect(paths[0].startsWith('/')).toBe(false);
  });
});

describe('assessGraphHealth — the instrument checks that it can SEE', () => {
  it('refuses to report when the resolver produced no edges at all', () => {
    const health = assessGraphHealth({
      resolvedEdges: 0,
      population: [DETECTOR],
      dead: [],
      unresolvedRelative: [],
    });
    expect(health.measurable).toBe(false);
    expect(health.reason).toMatch(/ZERO edges/);
  });

  it('refuses to report when EVERY module reads as dead', () => {
    // A probe that finds nothing alive has failed to see the tree. Reporting that as a
    // wall of violations would red-pin the fleet gate on an instrument fault — the
    // failure this guard's own header warns is worse than the defect it looks for.
    const health = assessGraphHealth({
      resolvedEdges: 5000,
      population: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      dead: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      unresolvedRelative: [],
    });
    expect(health.measurable).toBe(false);
    expect(health.reason).toMatch(/failed to see the tree/);
  });

  it('reports normally when some are alive and some are dead', () => {
    const health = assessGraphHealth({
      resolvedEdges: 5000,
      population: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      dead: [DETECTOR],
      unresolvedRelative: [{ from: 'a.ts', specifier: './b' }],
    });
    expect(health.measurable).toBe(true);
    expect(health.unresolvedRelativeCount).toBe(1);
  });
});

describe('buildImportGraph', () => {
  it('links importers and path-mentioners, and reports unresolved relative specifiers', () => {
    const files = [DETECTOR, 'apps/operator/lib/release/caller.ts', 'apps/operator/lib/routine.ts'];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      'apps/operator/lib/release/caller.ts': "import { x } from './prompt-divergence';\nimport './missing';",
      'apps/operator/lib/routine.ts': `spawn('tsx', ['${DETECTOR}']);`,
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.importers.get(DETECTOR) ?? [])]).toEqual(['apps/operator/lib/release/caller.ts']);
    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual(['apps/operator/lib/routine.ts']);
    // An unresolved RELATIVE specifier is reported rather than swallowed: silently
    // dropping edges under-counts importers, which invents dead modules.
    expect(graph.unresolvedRelative).toEqual([
      { from: 'apps/operator/lib/release/caller.ts', specifier: './missing' },
    ]);
  });
});

describe('helpers', () => {
  it('classifies test files, and finds only fully-qualified release paths', () => {
    expect(isTestFile(DETECTOR_TEST)).toBe(true);
    expect(isTestFile(DETECTOR)).toBe(false);
    // A bare stem is NOT a path mention — a baseline file listing `lib/release/x.ts`
    // relative to its own workspace must not read as an execution site.
    expect(parseReleasePathMentions(`run('${DETECTOR}')`)).toEqual([DETECTOR]);
    expect(parseReleasePathMentions("run('lib/release/prompt-divergence.ts')")).toEqual([]);
  });
});
