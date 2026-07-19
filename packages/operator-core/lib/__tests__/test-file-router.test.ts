import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
// The production entrypoint deliberately stays executable by plain Node.
// @ts-expect-error — the .mjs CLI has no declaration file.
import { discoverVitestRoute, evaluateMatch, groupRoutes, listedFiles, REPO_ROOT } from '../../../../scripts/test-files.mjs';

describe('test-files router', () => {
  it('discovers the package cwd/config and rewrites the file relative to that cwd', () => {
    const route = discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/tooldef'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('src/strict-args.test.ts');
  });

  it('groups only files sharing one cwd and config', () => {
    const routes = [
      discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts'),
      discoverVitestRoute('packages/operator-core/lib/search/self-session.test.ts'),
    ];
    expect(groupRoutes(routes)).toHaveLength(2);
  });

  it('extracts the distinct files Vitest says it will execute and ignores process warnings', () => {
    const cwd = resolve(REPO_ROOT, 'libs/generic/tooldef');
    expect(listedFiles('(node:1) Warning: irrelevant\nsrc/a.test.ts > suite > one\nsrc/a.test.ts > suite > two\nsrc/b.test.ts > suite', cwd)).toEqual([
      resolve(cwd, 'src/a.test.ts'),
      resolve(cwd, 'src/b.test.ts'),
    ]);
  });

  it('rejects a missing request before running Vitest', () => {
    expect(() => discoverVitestRoute('libs/generic/tooldef/src/no-such.test.ts')).toThrow(/does not exist/);
  });

  // EI-14278: a config-less `libs/generic/*` submodule (its own package.json `"test": "vitest run"`,
  // zero explicit vitest config — the borrowable-libs shape) must route to the package cwd config-less
  // (config: null) instead of throwing `no Vitest config owns …`. Without this, ~25 real generic libs
  // (plan-parser, memory, result-encoding, …) are unroutable via `npm run test:file` and each agent
  // rediscovers the `cd libs/generic/<name> && npm test` escape hatch.
  it('routes a config-less libs/generic/* package to its own cwd with config: null', () => {
    const route = discoverVitestRoute('libs/generic/plan-parser/src/index.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/plan-parser'));
    expect(route.config).toBeNull();
    expect(route.requested).toBe('src/index.test.ts');
  });

  it('still prefers an explicit vitest.config.* over the config-less package fallback', () => {
    // tooldef HAS its own config — the fallback must not shadow it.
    const route = discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts');
    expect(route.config).toBe('vitest.config.ts');
  });
});

// P-009 / WI-4534: the false-green refusal. A raw `vitest run <paths>` reports success while
// silently skipping what you asked for — exit 0 on a PARTIAL match (asked 3, ran 2), and exit 0
// on a ZERO match under --passWithNoTests. evaluateMatch is the guard that turns both into a hard
// error by comparing REQUESTED against what `vitest list` actually resolved. These pin that guard,
// which shipped with no regression test (WI-4534 was resolved verifiedHow:'already-passing').
describe('evaluateMatch — the false-green refusal (P-009)', () => {
  const A = '/repo/pkg/a.test.ts';
  const B = '/repo/pkg/b.test.ts';
  const routes = [
    { absolute: A, requested: 'a.test.ts' },
    { absolute: B, requested: 'b.test.ts' },
  ];

  it('accepts a run only when EVERY requested file resolved to a listed test', () => {
    const v = evaluateMatch({ routes, matched: [A, B], listStatus: 0 });
    expect(v.ok).toBe(true);
    expect(v.unmatched).toEqual([]);
    expect(v).toMatchObject({ requested: 2, matched: 2 });
  });

  it('REFUSES a partial match (asked 2, one resolved) — the silent-narrowing vitest exits 0 on', () => {
    const v = evaluateMatch({ routes, matched: [A], listStatus: 0 });
    expect(v.ok).toBe(false);
    expect(v.unmatched).toEqual([{ absolute: B, requested: 'b.test.ts' }]);
  });

  it('REFUSES a zero match (nothing resolved) — the empty run --passWithNoTests would exit 0 on', () => {
    const v = evaluateMatch({ routes, matched: [], listStatus: 0 });
    expect(v.ok).toBe(false);
    expect(v.unmatched).toHaveLength(2);
    expect(v.matched).toBe(0);
  });

  it('REFUSES when `vitest list` itself errored, even if the resolved set looks complete', () => {
    expect(evaluateMatch({ routes, matched: [A, B], listStatus: 1 }).ok).toBe(false);
  });

  it('accepts a single-file request that resolved', () => {
    const one = [{ absolute: A, requested: 'a.test.ts' }];
    expect(evaluateMatch({ routes: one, matched: [A], listStatus: 0 }).ok).toBe(true);
  });
});
