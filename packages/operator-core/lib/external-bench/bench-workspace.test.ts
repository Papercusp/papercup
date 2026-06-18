/**
 * bench-workspace — benchmarks resolve to a dedicated workspace + NEVER the production one
 * (plan benchmark-workspace-isolation-2026-06-18).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BENCH_WORKSPACE, PRODUCTION_WORKSPACE, assertBenchWorkspace, resolveBenchWorkspace } from './bench-workspace';

test('resolveBenchWorkspace — default is the benchmark workspace, never production', () => {
  assert.equal(resolveBenchWorkspace(undefined), BENCH_WORKSPACE);
  assert.equal(resolveBenchWorkspace(''), BENCH_WORKSPACE);
  assert.equal(resolveBenchWorkspace('   '), BENCH_WORKSPACE);
  assert.notEqual(BENCH_WORKSPACE, PRODUCTION_WORKSPACE);
});

test('resolveBenchWorkspace — an explicit override (per-suite sub-workspace) wins', () => {
  assert.equal(resolveBenchWorkspace('bench-swepro'), 'bench-swepro');
  assert.equal(resolveBenchWorkspace('benchmarks-tau2'), 'benchmarks-tau2');
});

test('the guard refuses the production workspace (the anti-pollution backstop)', () => {
  assert.throws(() => assertBenchWorkspace(PRODUCTION_WORKSPACE), /refusing to run a benchmark in the PRODUCTION workspace/);
  assert.throws(() => resolveBenchWorkspace(PRODUCTION_WORKSPACE), /refusing to run a benchmark in the PRODUCTION workspace/);
  // a benchmark workspace passes the guard
  assertBenchWorkspace(BENCH_WORKSPACE);
  assertBenchWorkspace('bench-swepro');
});
