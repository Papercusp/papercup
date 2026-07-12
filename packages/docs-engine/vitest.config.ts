import { defineConfig } from 'vitest/config';
import { ADMIN_TEST_RUNS_REPORTER_PATH, sharedHostWorkerCap } from '@papercusp/test-config';

// This workspace previously had no vitest config (pure vitest defaults). The only
// thing added here is the /admin/testing status-chip reporter — everything else
// stays vitest-default so test behavior is unchanged. Fail-soft; opt-out via env.
export default defineConfig({
  test: {
    // WI-4300: the shared-host worker cap — without it a direct `npx vitest run` in
    // this workspace forks ~one worker per host core (128 on the shared dev box).
    ...sharedHostWorkerCap(),
    reporters:
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? ['default']
        : ['default', ADMIN_TEST_RUNS_REPORTER_PATH],
  },
});
