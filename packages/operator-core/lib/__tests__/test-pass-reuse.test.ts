import { describe, expect, it } from 'vitest';

import {
  formatTestReuseLine,
  isGlobalRunnerInput,
  selectReusablePasses,
  testReuseEnabled,
  testReuseMaxAgeMs,
  TEST_REUSE_MAX_AGE_MS_DEFAULT,
} from '../../../../scripts/lib/test-pass-reuse.mjs';

/**
 * gate-file-level-test-reuse-2026-09-27 P-008 / D-004: a selected test file is SKIPPED only
 * when its recorded pass proof is still valid at the judged sha. Every other case must RUN it.
 */

const NOW = Date.parse('2026-09-27T16:00:00Z');
const CTX = 'green-checkpoint';
const RUNNER = 'v25.9.0 linux x64';

type Proof = Parameters<typeof selectReusablePasses>[0]['proofs'] extends Map<string, infer P> ? P : never;

function proof(file: string, over: Partial<Proof> = {}): Proof {
  return {
    recordedSha: 'old',
    recordedAtMs: NOW - 3600_000,
    executedModules: [file, 'pkg/src/a.ts', 'libs/sub/src/b.ts'],
    readPaths: ['pkg/fixtures/data.json', 'sql/'],
    inputsCaptured: true,
    opaqueReasons: [],
    runContext: CTX,
    runnerIdentity: RUNNER,
    ...over,
  };
}

function run(files: string[], proofs: Map<string, Proof>, drift: Set<string> | null) {
  return selectReusablePasses({
    candidates: files,
    proofs,
    judgedSha: 'new',
    changedBetween: () => drift,
    runContext: CTX,
    runnerIdentity: RUNNER,
    nowMs: NOW,
    maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
  });
}

const T = 'pkg/src/a.test.ts';

describe('selectReusablePasses', () => {
  it('reuses a valid proof when nothing it depends on drifted', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other/unrelated.ts']));
    expect(r.skip).toEqual([T]);
    expect(r.summary.reused).toBe(1);
  });

  it('runs the file when the test file, an executed module or a submodule module changed', () => {
    for (const changed of [T, 'pkg/src/a.ts', 'libs/sub/src/b.ts']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.inputChanged, changed).toBe(1);
    }
  });

  it('runs the file when a runtime-read file or anything under a read directory changed', () => {
    for (const changed of ['pkg/fixtures/data.json', 'sql/1236-new.sql', 'sql']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
  });

  it('runs the file when a package.json or tsconfig above an executed module changed', () => {
    for (const changed of ['pkg/package.json', 'pkg/tsconfig.json', 'libs/sub/package.json', 'libs/tsconfig.base.json']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
    // ...but a sibling package's manifest does not touch this proof.
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other-pkg/package.json']));
    expect(r.skip).toEqual([T]);
  });

  it('invalidates every proof on a global runner input change', () => {
    for (const changed of ['package-lock.json', 'package.json', 'libs/test-config/src/vitest-config.ts', 'patches/x.patch']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.globalInput, changed).toBe(1);
    }
  });

  it('runs on unknown drift, missing, foreign, expired, uncaptured or opaque proofs', () => {
    expect(run([T], new Map([[T, proof(T)]]), null).summary.unknownDrift).toBe(1);
    expect(run([T], new Map(), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { executedModules: ['pkg/src/a.ts'] })]]), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runContext: 'clean-local' })]]), new Set()).summary.otherContext).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runnerIdentity: 'v22.0.0 linux x64' })]]), new Set()).summary.otherRunner).toBe(1);
    expect(run([T], new Map([[T, proof(T, { recordedAtMs: NOW - 25 * 3600_000 })]]), new Set()).summary.expired).toBe(1);
    expect(run([T], new Map([[T, proof(T, { inputsCaptured: false })]]), new Set()).summary.notCaptured).toBe(1);
    expect(run([T], new Map([[T, proof(T, { opaqueReasons: ['child-process'] })]]), new Set()).summary.opaque).toBe(1);
  });

  it('treats a proof recorded at the judged sha as zero drift without calling git', () => {
    let calls = 0;
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T, { recordedSha: 'new' })]]),
      judgedSha: 'new',
      changedBetween: () => {
        calls += 1;
        return null;
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([T]);
    expect(calls).toBe(0);
  });

  it('reads a throwing drift seam as unknown (runs the file)', () => {
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T)]]),
      judgedSha: 'new',
      changedBetween: () => {
        throw new Error('boom');
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.unknownDrift).toBe(1);
  });
});

describe('isGlobalRunnerInput', () => {
  it('treats libs/test-config TEST files as ordinary tests, not runner inputs', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.test.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.ts')).toBe(true);
    expect(isGlobalRunnerInput('packages/operator-core/package.json')).toBe(false);
    expect(isGlobalRunnerInput('packages/operator-core/vitest.config.ts')).toBe(true);
  });
});

describe('env toggles and the report line', () => {
  it('is ON by default and OFF for the documented values', () => {
    expect(testReuseEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) expect(testReuseEnabled({ AFFECTED_TEST_REUSE: v })).toBe(false);
    expect(testReuseMaxAgeMs({})).toBe(TEST_REUSE_MAX_AGE_MS_DEFAULT);
    expect(testReuseMaxAgeMs({ AFFECTED_TEST_REUSE_MAX_AGE_HOURS: '6' })).toBe(6 * 3600_000);
  });

  it('prints every counter on one greppable line', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set());
    expect(formatTestReuseLine('@papercusp/x', r.summary)).toMatch(/^TEST_PASS_REUSE ws=@papercusp\/x candidates=1 reused=1 /);
  });
});
