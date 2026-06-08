import { defineConfig } from 'vitest/config';
import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Hand-rolled config (not defineVitestConfig) → opt into the /admin/testing
    // status-chip reporter explicitly. Fail-soft; opt-out via env.
    reporters:
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? ['default']
        : ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
  },
});
