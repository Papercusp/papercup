import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same admin reporter as the unit config — integration runs record to
// harness_shared.test_runs too, so *.integration.test.ts files stop showing as
// perpetually NEUTRAL in the /admin/testing tab. Fail-soft (D-007); opt-out via
// PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
const reportersExtra: Array<string | [string, Record<string, unknown>]> =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
    ? []
    : [resolve(__dirname, 'test/reporters/admin-test-runs-reporter.ts')];

// The SP1 C4 carve moved the plans/cross_harness integration tests here; they
// inject('baselineSchemaDsn') via _pg-tool-fixture, so this package needs the
// shared baseline-schema globalSetup (was only wired in apps/operator before).
export default mergeConfig(
  defineVitestConfig({
    layer: 'integration',
    globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH],
  }),
  { test: { reporters: reportersExtra } },
);
