import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Custom reporter writes one row per test FILE to harness_shared.test_runs — this
// is what powers the /admin/testing (+ /adv Tests) status chips. Fail-soft per
// D-007 (1s connect timeout, swallows every error, never throws, never affects the
// exit code). Without it, operator-core's hundreds of tests record NOTHING and show
// as perpetually NEUTRAL in the tab even though they pass (apps/operator was the
// only workspace wiring it). Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
const reportersExtra: Array<string | [string, Record<string, unknown>]> =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
    ? []
    : [resolve(__dirname, 'test/reporters/admin-test-runs-reporter.ts')];

// operator-core unit tests. Resolution of internal imports is relative
// (no @/ alias in this package); @papercusp/* workspace deps resolve via the
// hoisted node_modules symlinks. The defineVitestConfig tsconfigPaths plugin
// reads this package's tsconfig (no paths) — harmless.
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  // mergeConfig array-merge appends, so the base reporter list is preserved and
  // the admin reporter runs alongside it.
  test: { reporters: reportersExtra },
});
