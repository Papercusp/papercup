import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Admin reporter (mirrors vitest.config.ts) so apps/operator's *.integration.test.ts
// files record to harness_shared.test_runs and show their real status in the
// /admin/testing tab instead of NEUTRAL. Fail-soft (D-007); opt-out via
// PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
const reportersExtra: Array<string | [string, Record<string, unknown>]> =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
    ? []
    : [resolve(__dirname, 'test/reporters/admin-test-runs-reporter.ts')];

export default mergeConfig(
  defineVitestConfig({
    layer: 'integration',
    include: [
      'test/**/*.integration.test.ts',
      'app/**/*.integration.test.ts',
      'lib/**/*.integration.test.ts',
    ],
    // P-015 (self-contained-migration-baseline-2026-06-02): stand up the COMPLETE
    // harness_shared schema once per run by applying the real migration set, and expose
    // its DSN via inject('baselineSchemaDsn'). Now lifted into @papercusp/test-config so
    // packages/operator-core (which got the carved plans integration tests) shares it.
    globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH],
  }),
  { test: { reporters: reportersExtra } },
);
