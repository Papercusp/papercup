import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({
  layer: 'integration',
  include: [
    'test/**/*.integration.test.ts',
    'app/**/*.integration.test.ts',
    'lib/**/*.integration.test.ts',
  ],
  // P-015 (self-contained-migration-baseline-2026-06-02): stand up the COMPLETE
  // harness_shared schema once per run by applying the real migration set, and expose
  // its DSN via inject('baselineSchemaDsn'). Unblocked by the baseline rebuild (D-005).
  globalSetup: ['test/setup/baseline-schema.globalSetup.ts'],
});
