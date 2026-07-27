import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
// The production entrypoint deliberately stays executable by plain Node.
import {
  aggregateGroupResults,
  discoverVitestRoute,
  evaluateMatch,
  groupRoutes,
  listedFiles,
  looksLikeMidInstallCorruption,
  looksLikeSilentCollectionFailure,
  REPO_ROOT,
  // The .mjs CLI has no declaration file; the diagnostic lands on the `from`
  // line of this multi-line import, so the suppression directive itself must
  // be the LAST comment line immediately above that line (a directive on an
  // earlier comment line, with another comment line between it and the code,
  // is not recognized by tsc).
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

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

// EI-13535: a multi-workspace request (files owned by >1 cwd/config) used to `return` the moment
// the FIRST group either mismatched or failed, silently never even attempting the remaining
// groups — so `executed` could read far below `requested` with no indication the other files were
// never run at all (or, worse, a fixed-and-re-run first group could report a clean `status=passed`
// while the other groups' files were never executed). aggregateGroupResults is the pure decision
// `main` now uses to combine every group's outcome (all groups always run) into one honest verdict.
describe('aggregateGroupResults — no group may be silently abandoned (EI-13535)', () => {
  const okGroup = (requested: number, matched: number, executed: number) => ({
    requested,
    matched,
    executed,
    unmatchedCount: 0,
    failed: false,
    launchError: false,
  });

  it('combines multiple clean groups into one passing verdict summing across all of them', () => {
    const summary = aggregateGroupResults([okGroup(1, 1, 1), okGroup(2, 2, 2)]);
    expect(summary).toMatchObject({
      ok: true,
      requested: 3,
      matched: 3,
      executed: 3,
      anyUnmatched: false,
      anyFailed: false,
      launchError: false,
    });
  });

  it('THE BUG: a failure in group 1 must not hide group 2 — executed reflects BOTH groups ran', () => {
    // group 1 (1 file) failed its vitest run; group 2 (2 files) still ran to completion.
    const failedGroup1 = { ...okGroup(1, 1, 1), failed: true };
    const summary = aggregateGroupResults([failedGroup1, okGroup(2, 2, 2)]);
    // Before the fix, main() returned right after group 1 — group 2 never even attempted, so
    // `executed` would have frozen at 1 instead of reflecting all 3 requested files running.
    expect(summary.executed).toBe(3);
    expect(summary.requested).toBe(3);
    expect(summary.anyFailed).toBe(true);
    expect(summary.ok).toBe(true); // both groups matched fully — only their TEST results differed
  });

  it('a mismatch in one group is still refused (ok:false) even when every other group matched', () => {
    const mismatchedGroup = { requested: 2, matched: 1, executed: 0, unmatchedCount: 1, failed: false, launchError: false };
    const summary = aggregateGroupResults([mismatchedGroup, okGroup(1, 1, 1)]);
    expect(summary.ok).toBe(false);
    expect(summary.anyUnmatched).toBe(true);
    // The matched/requested counts still aggregate so the refusal message is honest about the
    // WHOLE request, not just the mismatched group.
    expect(summary).toMatchObject({ requested: 3, matched: 2 });
  });

  it('a launch error in any group refuses the whole run regardless of other groups', () => {
    const launchErrorGroup = { requested: 1, matched: 0, executed: 0, unmatchedCount: 1, failed: false, launchError: true };
    const summary = aggregateGroupResults([launchErrorGroup, okGroup(1, 1, 1)]);
    expect(summary.launchError).toBe(true);
  });

  it('a single clean group (the common case) still reports ok/passed correctly', () => {
    const summary = aggregateGroupResults([okGroup(2, 2, 2)]);
    expect(summary).toMatchObject({ ok: true, requested: 2, matched: 2, executed: 2, anyFailed: false });
  });
});

// EI-18099113673609528: Vitest 4's default/verbose reporter drops ALL per-suite error detail
// when >=2 requested files fail to COLLECT (a transform/parse error) in the same run — the
// caller is left with only the bare "Test Files N failed (N) / Tests no tests" summary lines
// and nothing else. Fixtures below are the literal shapes observed against real vitest 4.1.8
// output (single collection failure DOES print a "Failed Suites" block; two simultaneous ones
// print neither that block nor any "FAIL " line).
describe('looksLikeSilentCollectionFailure (EI-18099113673609528)', () => {
  const SINGLE_FAILURE_WITH_DETAIL = `
 RUN  v4.1.8 /repo

 ❯ lib/bad.test.tsx (0 test)

⏰⏰⏰⏰⏰⏰ Failed Suites 1 ⏰⏰⏰⏰⏰⏰⏰

 FAIL  lib/bad.test.tsx [ lib/bad.test.tsx ]
Error: Transform failed with 1 error:
lib/bad.test.tsx:3:0: ERROR: Unterminated string literal

 Test Files  1 failed (1)
      Tests  no tests
`;

  const TWO_SIMULTANEOUS_FAILURES_NO_DETAIL = `
 RUN  v4.1.8 /repo

 ❯ lib/bad1.test.tsx (0 test)
 ❯ lib/bad2.test.tsx (0 test)

 Test Files  2 failed (2)
      Tests  no tests
`;

  it('flags the silent-failure signature: N>=2 failed, zero per-suite detail', () => {
    expect(looksLikeSilentCollectionFailure(TWO_SIMULTANEOUS_FAILURES_NO_DETAIL)).toBe(true);
  });

  it('does NOT flag a single collection failure — Vitest prints the Failed Suites block for it', () => {
    expect(looksLikeSilentCollectionFailure(SINGLE_FAILURE_WITH_DETAIL)).toBe(false);
  });

  it('does NOT flag a normal green run', () => {
    expect(looksLikeSilentCollectionFailure(' Test Files  2 passed (2)\n      Tests  5 passed (5)\n')).toBe(false);
  });

  // EI-18819483316574031: vitest COLOURISES this output in practice. Every matcher here is
  // shape-anchored, so before the ANSI strip this detector silently returned false on real
  // runs while all of its tests (clean text) stayed green — the same blindness that let the
  // green-checkpoint exit-code cross-check pass a genuinely red suite the same day.
  it('flags the silent-failure signature through ANSI colour codes', () => {
    // Built from an explicit ESC constant so the escapes are VISIBLE in source. A fixture
    // written with raw control bytes is invisible to a reader and trivially lost to a
    // formatter/copy-paste — and a fixture that quietly loses its ESC bytes stops testing
    // the very thing it names (hit exactly that while writing this guard).
    const E = String.fromCharCode(27); // ESC — pure ASCII in source
    const coloured =
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m2 failed${E}[39m${E}[22m${E}[90m (2)${E}[39m\n` +
      ` ${E}[31m❯${E}[39m src/a.test.ts ${E}[2m(0 test)${E}[22m\n` +
      ` ${E}[31m❯${E}[39m src/b.test.ts ${E}[2m(0 test)${E}[22m\n`;
    expect(coloured).toContain(String.fromCharCode(27) + '['); // the fixture really is coloured
    expect(looksLikeSilentCollectionFailure(coloured)).toBe(true);
  });

  it('does NOT flag a COLOURISED green run (no false positives from the strip)', () => {
    const E = String.fromCharCode(27); // ESC — pure ASCII in source
    const colouredGreen =
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m2 passed${E}[39m${E}[22m${E}[90m (2)${E}[39m\n` +
      `${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m5 passed${E}[39m${E}[22m${E}[90m (5)${E}[39m\n`;
    expect(looksLikeSilentCollectionFailure(colouredGreen)).toBe(false);
  });

  it('does NOT flag a run with per-test assertion detail (a real, diagnosable failure) — captured verbatim from a real vitest 4.1.8 run', () => {
    const withAssertionDetail = `
 RUN  v4.1.8 /repo

 ❯ lib/a.test.ts (1 test | 1 failed) 14ms
     × fails on purpose 12ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;
    expect(looksLikeSilentCollectionFailure(withAssertionDetail)).toBe(false);
  });

  it('does NOT flag a single collection failure mixed with passing files (only one zero-test file)', () => {
    const oneCollectionFailureAmongPasses = `
 ❯ lib/bad.test.tsx (0 test)
 ✓ lib/good.test.tsx (3 tests) 9ms

⏰⏰⏰⏰⏰⏰ Failed Suites 1 ⏰⏰⏰⏰⏰⏰⏰

 FAIL  lib/bad.test.tsx [ lib/bad.test.tsx ]
Error: Transform failed with 1 error:

 Test Files  1 failed | 1 passed (2)
      Tests  3 passed (3)
`;
    expect(looksLikeSilentCollectionFailure(oneCollectionFailureAmongPasses)).toBe(false);
  });
});

// EI-18662389554660036: a concurrent `npm install` on the shared tree rewrites node_modules
// out from under every other agent's test run — vitest's own bin can vanish mid-install
// (a bare shell "command not found"), or Node throws ERR_MODULE_NOT_FOUND into node_modules
// for a package left half-written by an overlapping install. Neither error names its real
// cause; this detector recognizes both real-world signatures reported in the EI.
describe('looksLikeMidInstallCorruption (EI-18662389554660036)', () => {
  it('flags the shell "vitest: not found" signature (node_modules/.bin/vitest missing mid-install)', () => {
    expect(looksLikeMidInstallCorruption('sh: 1: vitest: not found\n')).toBe(true);
  });

  it('flags an ERR_MODULE_NOT_FOUND stack that points into node_modules (a half-written package)', () => {
    const stack = `node:internal/modules/esm/resolve:something
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/node_modules/vitest/node_modules/@vitest/mocker/dist/node.js'
    at new NodeError (node:internal/errors:405:5)`;
    expect(looksLikeMidInstallCorruption(stack)).toBe(true);
  });

  it('does NOT flag an unrelated MODULE_NOT_FOUND with no node_modules path (a real missing-file bug)', () => {
    expect(looksLikeMidInstallCorruption('Error [ERR_MODULE_NOT_FOUND]: Cannot find module ./foo.ts')).toBe(false);
  });

  it('does NOT flag a normal passing run', () => {
    expect(looksLikeMidInstallCorruption(' Test Files  2 passed (2)\n      Tests  5 passed (5)\n')).toBe(false);
  });

  it('does NOT flag a normal per-test assertion failure', () => {
    const withAssertionDetail = `
 ❯ lib/a.test.ts (1 test | 1 failed) 14ms
     × fails on purpose 12ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;
    expect(looksLikeMidInstallCorruption(withAssertionDetail)).toBe(false);
  });
});
