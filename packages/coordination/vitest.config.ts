import { defineConfig } from 'vitest/config';
import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config';

// Reporter-only config (was vitest defaults) for the /admin/testing status chips.
// Fail-soft; opt-out via env.
export default defineConfig({
  test: {
    reporters:
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? ['default']
        : ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
  },
});
