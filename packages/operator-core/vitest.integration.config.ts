import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config';

// The SP1 C4 carve moved the plans/cross_harness integration tests here; they
// inject('baselineSchemaDsn') via _pg-tool-fixture, so this package needs the
// shared baseline-schema globalSetup (was only wired in apps/operator before).
export default defineVitestConfig({
  layer: 'integration',
  globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH],
});
