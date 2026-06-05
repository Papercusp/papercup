/**
 * testing-run-source.ts — resolve the `source` column for a test_runs row.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014.
 *
 * `source` is one of the CHECK-constrained values 'ci' | 'local' | 'admin-ui'.
 *
 * Precedence:
 *   1. PAPERCUSP_TEST_RUN_SOURCE env var, when set to a valid value, wins.
 *      Set by testing-run-store on every admin-ui-triggered spawn so the
 *      in-process reporter inside the child can stamp the right source.
 *   2. Otherwise CI=truthy → 'ci'.
 *   3. Otherwise → 'local'.
 *
 * No I/O, no exceptions — safe to call from any reporter / writer hot path.
 */

export type TestRunSource = 'ci' | 'local' | 'admin-ui';

const VALID: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui']);

export function resolveTestRunSource(
  env: { PAPERCUSP_TEST_RUN_SOURCE?: string; CI?: string } = process.env,
): TestRunSource {
  const override = env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID.has(override as TestRunSource)) {
    return override as TestRunSource;
  }
  return env.CI ? 'ci' : 'local';
}
