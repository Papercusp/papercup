import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config';

export default defineVitestConfig({
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
});
